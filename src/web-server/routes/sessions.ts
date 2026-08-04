/**
 * Session routes — full CRUD over the per-project session index.
 *
 * Sessions are runtime records for agent sessions (opencode, claude-code)
 * attached to a project. All mutations go through the locked session-store,
 * so the opencode discovery bridge and the web UI cannot clobber each other.
 *
 * `POST /sessions/:id/message` is the one route that reaches outside the store:
 * it proxies a prompt into the live runtime (opencode) or queues it for the
 * session to collect itself (claude-code). Every route here is browser-facing
 * and therefore already behind the global loopback-only `secureLocalRequest`
 * middleware — no per-route auth.
 */

import { randomUUID } from "node:crypto";
import { stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import {
  appendReferenceTurn,
  appendSessionTurn,
  mirrorSessionTranscript,
  readSessionTurns,
  sessionTranscriptPath,
} from "../../utils/claude-transcript.js";
import { DagError } from "../../utils/errors.js";
import { readJsonSafe } from "../../utils/json.js";
import {
  createSession,
  deleteSession,
  enqueueSessionMessage,
  getSession,
  listSessions,
  SESSION_LINKED_NODE_TYPES,
  SESSION_RUNTIME_TYPES,
  SESSION_STATUSES,
  type SessionFilters,
  type SessionMeta,
  updateSession,
  upsertSession,
} from "../../utils/session-store.js";
import { type ClaudeRunRecord, isRunLive, runClaudeJob } from "../claude-runner.js";
import {
  createOpencodeSession,
  readOpencodeConfig,
  sendOpencodeMessage,
} from "../opencode-client.js";
import { parseBody, requireProjectDir, respond } from "../respond.js";

export const sessionsRoute = new Hono();

const createSessionSchema = z.object({
  runtimeType: z.enum(SESSION_RUNTIME_TYPES),
  runtimeSessionId: z.string().min(1),
  status: z.enum(SESSION_STATUSES).optional(),
  startedAt: z.string().optional(),
  lastMessageAt: z.string().optional(),
  userEmail: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSessionSchema = z.object({
  status: z.enum(SESSION_STATUSES).optional(),
  lastMessageAt: z.string().nullable().optional(),
  userEmail: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  /** `null` on either linkage field unlinks the session entirely. */
  linkedNodeType: z.enum(SESSION_LINKED_NODE_TYPES).nullable().optional(),
  linkedNodeId: z.string().nullable().optional(),
});

/** A document section the caller is pointing the session at. When present, the
 *  delivery call is followed by an ARCS-authored reference turn in the session's
 *  transcript sidecar (see appendReferenceTurn). Shared by POST /message and
 *  POST /run so both routes accept byte-identical reference payloads. */
const sessionReferenceSchema = z.object({
  section: z.object({
    depth: z.number(),
    text: z.string(),
    id: z.string(),
    startOffset: z.number(),
    endOffset: z.number(),
  }),
  text: z.string(),
  source: z.object({
    kind: z.enum(["overview", "knowledge", "plan"]),
    label: z.string(),
    doc: z.string().optional(),
    id: z.string().optional(),
  }),
});

const sendMessageSchema = z.object({
  message: z.string().min(1),
  reference: sessionReferenceSchema.optional(),
});

/** Payload for POST /sessions/:id/run — a headless `claude -p` targeting mode.
 *  `threadId` is the stable-mode thread to reuse; when absent (and the
 *  referenced session is not itself an ARCS-owned thread) one is minted. */
const runClaudeMessageSchema = z.object({
  mode: z.enum(["resume", "oneshot", "stable"]),
  message: z.string().min(1),
  threadId: z.string().optional(),
  reference: sessionReferenceSchema.optional(),
});

const createOpencodeSessionSchema = z.object({
  title: z.string().min(1).optional(),
});

function sessionDirectory(session: SessionMeta): string | undefined {
  const directory = session.metadata?.directory;
  return typeof directory === "string" && directory ? directory : undefined;
}

function requireOpencodeConfig() {
  const config = readOpencodeConfig();
  if (!config) {
    throw new DagError(
      "OPENCODE_NOT_CONFIGURED",
      "No opencode endpoint configured — set OPENCODE_PORT (or ARCS_OPENCODE_URL) " +
        "so ARCS can reach a running `opencode serve`.",
    );
  }
  return config;
}

/**
 * The worktree a newly created session should run in.
 *
 * Guessing is not an option: opencode happily creates a session in its own
 * working directory when no directory is supplied, which would silently point
 * the agent at the wrong repository. An unregistered project is an error.
 */
async function primaryWorkspacePath(projectDir: string, slug: string): Promise<string> {
  const meta = await readJsonSafe<{ workspacePaths?: string[] }>(resolve(projectDir, "meta.json"));
  const directory = meta?.workspacePaths?.[0];
  if (!directory) {
    throw new DagError(
      "PROJECT_WORKSPACE_UNSET",
      `Project "${slug}" has no registered workspace path, so there is no directory to ` +
        `create a session in — run \`arcs project update-paths ${slug} --add <path>\` first.`,
    );
  }
  return directory;
}

function parseFilters(status: string | undefined, runtimeType: string | undefined): SessionFilters {
  const filters: SessionFilters = {};
  if (status && (SESSION_STATUSES as readonly string[]).includes(status)) {
    filters.status = status as SessionFilters["status"];
  }
  if (runtimeType && (SESSION_RUNTIME_TYPES as readonly string[]).includes(runtimeType)) {
    filters.runtimeType = runtimeType as SessionFilters["runtimeType"];
  }
  return filters;
}

interface RunWriteBackContext {
  mode: "resume" | "oneshot" | "stable";
  writeTarget: SessionMeta;
  firstStableSpawn: boolean;
}

/**
 * Mode-1 write-back (T005): the callback the route registers on runClaudeJob,
 * invoked by the runner after the headless child fully exits — on every outcome
 * (success/error/timeout/killed).
 *
 * - resume: mirrors the resumed session's runtime transcript into its sidecar
 *   via the persisted metadata.transcriptPath (hook-events T004 persists it at
 *   its checkpoints). The path is re-read fresh from the store — it may have
 *   been updated between the 202 and the run's exit. An absent path is a no-op;
 *   mirrorSessionTranscript is offset-idempotent and never throws, so repeated
 *   write-backs never duplicate and failures are inert.
 * - oneshot/stable: never mirror — their sidecars are appendSessionTurn-owned.
 *   On a success outcome the captured reply is appended as an assistant turn
 *   (every reply lands in the sidecar); error/timeout outcomes append nothing.
 *
 * Every path finalizes metadata.run with the settled record (pid/startedAt/
 * mode plus endedAt/outcome/error/replyChars) so the panel shows the true
 * result. Best-effort by contract: the runner swallows any error thrown here,
 * so a failed write-back never surfaces on the accepted 202.
 */
async function writeBackRun(
  projectDir: string,
  ctx: RunWriteBackContext,
  record: ClaudeRunRecord,
): Promise<void> {
  if (ctx.mode === "resume") {
    let target = ctx.writeTarget;
    try {
      target = await getSession(projectDir, ctx.writeTarget.normalizedId);
    } catch {
      // Session deleted mid-run — fall back to the write-target captured at 202.
    }
    const transcriptPath = target.metadata?.transcriptPath;
    if (typeof transcriptPath === "string" && transcriptPath !== "") {
      await mirrorSessionTranscript(projectDir, ctx.writeTarget.normalizedId, transcriptPath);
    }
  } else if (record.outcome === "success" && record.replyText !== undefined) {
    // Modes 2/3 on success: the captured reply lands in the sidecar as an
    // assistant turn (minted in the shared negative id space after the user
    // turn and any reference). Error/timeout outcomes append nothing.
    await appendSessionTurn(projectDir, ctx.writeTarget.normalizedId, {
      type: "assistant",
      text: record.replyText,
    });
  }

  const run: Record<string, unknown> = {
    pid: record.pid,
    startedAt: record.startedAt,
    mode: ctx.mode,
    ...(record.endedAt !== undefined && { endedAt: record.endedAt }),
    outcome: record.outcome,
    ...(record.error !== undefined && { error: record.error }),
    ...(record.replyChars !== undefined && { replyChars: record.replyChars }),
  };
  const runMetadata: Record<string, unknown> = { run };
  if (ctx.mode === "stable" && ctx.firstStableSpawn && record.outcome === "success") {
    runMetadata.threadInitialized = true;
  }
  await updateSession(projectDir, {
    id: ctx.writeTarget.normalizedId,
    metadata: runMetadata,
  });
}

sessionsRoute.get("/api/p/:slug/sessions", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const sessions = await listSessions(
      projectDir,
      parseFilters(c.req.query("status"), c.req.query("runtimeType")),
    );
    return { sessions };
  }),
);

sessionsRoute.post("/api/p/:slug/sessions", async (c) =>
  respond(
    c,
    async () => {
      const projectDir = requireProjectDir(c.req.param("slug"));
      const input = await parseBody(c, createSessionSchema);
      return createSession(projectDir, input);
    },
    201,
  ),
);

/**
 * Creates a live opencode session in the project's primary workspace.
 *
 * The new session is mirrored into the index straight away rather than waiting
 * for the discovery stream to notice it, so the caller can select and message
 * it immediately. The stream's own `session.created` event lands moments later
 * and merges into the same record.
 *
 * There is deliberately no claude-code counterpart: a Claude Code session only
 * exists once a user runs `claude` in a linked directory, so there is nothing
 * for ARCS to create remotely.
 */
sessionsRoute.post("/api/p/:slug/sessions/opencode/new", async (c) =>
  respond(
    c,
    async () => {
      const slug = c.req.param("slug");
      const projectDir = requireProjectDir(slug);
      const { title } = await parseBody(c, createOpencodeSessionSchema);
      const directory = await primaryWorkspacePath(projectDir, slug);
      const config = requireOpencodeConfig();

      const created = await createOpencodeSession(config, {
        directory,
        ...(title && { title }),
      });

      return upsertSession(projectDir, {
        runtimeType: "opencode",
        runtimeSessionId: created.runtimeSessionId,
        status: "active",
        metadata: { directory, ...(created.title && { title: created.title }) },
      });
    },
    201,
  ),
);

sessionsRoute.get("/api/p/:slug/sessions/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    return getSession(projectDir, c.req.param("id"));
  }),
);

sessionsRoute.patch("/api/p/:slug/sessions/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const input = await parseBody(c, updateSessionSchema);
    return updateSession(projectDir, { id: c.req.param("id"), ...input });
  }),
);

/**
 * Sends a message to the runtime behind a session.
 *
 * Delivery is asymmetric by runtime, and deliberately so: opencode sessions get
 * live injection (the running agent picks the prompt up mid-turn), while Claude
 * Code sessions get queued delivery (the session itself drains the queue at its
 * next hook checkpoint — Claude Code exposes no live channel to inject into).
 * Both answer with the updated session, so the caller can tell them apart by
 * `messageQueue` rather than by branching on `runtimeType` itself.
 *
 * A `reference` body field appends an ARCS-authored reference turn to the
 * session's transcript sidecar, but only after delivery has succeeded — a
 * failed send must never leave a dangling reference behind. The append is a
 * swallowed no-op on failure (the message itself was already delivered).
 */
sessionsRoute.post("/api/p/:slug/sessions/:id/message", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const { message, reference } = await parseBody(c, sendMessageSchema);
    const session = await getSession(projectDir, c.req.param("id"));

    let updated: SessionMeta;
    if (session.runtimeType === "claude-code") {
      // Queued, not sent: `lastMessageAt` stays untouched until the session
      // actually drains this at a checkpoint.
      updated = await enqueueSessionMessage(projectDir, session.normalizedId, message);
    } else {
      await sendOpencodeMessage(
        requireOpencodeConfig(),
        {
          runtimeSessionId: session.runtimeSessionId,
          ...(sessionDirectory(session) && { directory: sessionDirectory(session) }),
        },
        message,
      );

      updated = await updateSession(projectDir, {
        id: session.normalizedId,
        lastMessageAt: new Date().toISOString(),
      });
    }

    // Delivery succeeded (or was accepted into the queue) — record the
    // reference turn against the session's transcript sidecar, carrying the
    // section/source payload verbatim so the web UI can render click-through.
    if (reference !== undefined) {
      await appendReferenceTurn(projectDir, session.normalizedId, {
        text: reference.text,
        ts: new Date().toISOString(),
        section: reference.section,
        source: reference.source,
      });
    }

    return updated;
  }),
);

/**
 * Starts a headless `claude -p` job in one of three targeting modes and answers
 * 202 with the write-target session — the record the run's transcript and reply
 * land on. The 202 is the acceptance: the run proceeds out-of-band in the
 * runner, whose exit-time write-back (T005) then settles the run — finalizing
 * `metadata.run` with the outcome on every path and, for resume mode, mirroring
 * the resumed session's transcript into its sidecar.
 *
 * - resume: the referenced session must be a claude-code session that is not
 *   currently active; the run resumes its runtime thread in the session's own
 *   directory.
 * - oneshot: the run targets a deterministic ARCS-owned session
 *   (`arcs-oneshot-<slug>`) recreated idempotently on every call, in the
 *   project's primary workspace.
 * - stable: the run targets a persistent ARCS-owned thread (`arcs-thread-<slug>-
 *   <uuid4>` minted once then reused) so a conversation accumulates in one
 *   sidecar; the first successful spawn seeds the thread (`--session-id`),
 *   later spawns resume it (`--resume` + `--session-id`).
 *
 * Modes 2/3 append the user turn (and optional reference) to the write-target
 * sidecar immediately — the panel shows the prompt before the run ends, with
 * delivery-first ordering (user turn before reference). Mode 1 never appends:
 * its transcript write-back happens at exit (T005).
 *
 * Concurrency: one live run per write-target. The runner's beginRun is the
 * atomic claim; the read-only isRunLive probe here answers the common
 * overlapping case with a proper 409 before anything is appended or spawned
 * (a rare race between probe and claim is still refused by the runner itself).
 */
sessionsRoute.post("/api/p/:slug/sessions/:id/run", async (c) =>
  respond(
    c,
    async () => {
      const slug = c.req.param("slug");
      const projectDir = requireProjectDir(slug);
      const { mode, message, threadId, reference } = await parseBody(c, runClaudeMessageSchema);
      const session = await getSession(projectDir, c.req.param("id"));

      let writeTarget: SessionMeta;
      let dir: string;
      let runThreadId: string | undefined;
      let firstStableSpawn = false;

      if (mode === "resume") {
        if (session.runtimeType !== "claude-code") {
          throw new DagError(
            "CLAUDE_RUN_TARGET_INVALID",
            `cannot resume session "${session.normalizedId}": only claude-code sessions can be run headlessly`,
          );
        }
        if (session.status === "active") {
          throw new DagError(
            "CLAUDE_SESSION_ACTIVE",
            `cannot resume session "${session.normalizedId}": the session is still active`,
          );
        }
        writeTarget = session;
        dir = sessionDirectory(session) ?? (await primaryWorkspacePath(projectDir, slug));
      } else {
        dir = await primaryWorkspacePath(projectDir, slug);
        if (mode === "oneshot") {
          writeTarget = await upsertSession(projectDir, {
            runtimeType: "claude-code",
            runtimeSessionId: `arcs-oneshot-${slug}`,
            metadata: { control: "arcs-owned", directory: dir },
          });
        } else {
          // stable — reuse the referenced session's own thread when ARCS owns
          // it, otherwise take the payload threadId or mint a fresh one.
          const thread =
            (session.metadata?.control === "arcs-owned" && session.runtimeSessionId) ||
            threadId ||
            `arcs-thread-${slug}-${randomUUID()}`;
          runThreadId = thread;
          writeTarget = await upsertSession(projectDir, {
            runtimeType: "claude-code",
            runtimeSessionId: thread,
            metadata: { control: "arcs-owned", directory: dir },
          });
          firstStableSpawn = writeTarget.metadata?.threadInitialized !== true;
        }
      }

      // One live run per write-target — refuse before appending anything.
      if (isRunLive(writeTarget.normalizedId)) {
        throw new DagError(
          "CLAUDE_RUN_IN_PROGRESS",
          `a claude run for "${writeTarget.normalizedId}" is already in progress`,
        );
      }

      if (mode !== "resume") {
        await appendSessionTurn(projectDir, writeTarget.normalizedId, {
          type: "user",
          text: message,
        });
        if (reference !== undefined) {
          await appendReferenceTurn(projectDir, writeTarget.normalizedId, {
            text: reference.text,
            ts: new Date().toISOString(),
            section: reference.section,
            source: reference.source,
          });
        }
      }

      // NOTE: no "--cwd" flag — claude >= 2.x rejects it ("error: unknown
      // option '--cwd'"), settling every headless run as outcome:error. The
      // spawn applies the working directory via options.cwd below instead.
      let argv: string[];
      if (mode === "resume") {
        argv = ["-p", message, "--resume", session.runtimeSessionId, "--output-format", "json"];
      } else if (mode === "oneshot") {
        argv = ["-p", message, "--output-format", "json"];
      } else {
        const thread = runThreadId as string;
        argv = firstStableSpawn
          ? ["-p", message, "--session-id", thread, "--output-format", "json"]
          : ["-p", message, "--resume", thread, "--session-id", thread, "--output-format", "json"];
      }

      // Fire-and-forget: the run proceeds out-of-band. The runner invokes the
      // registered write-back after the child fully exits (it resolves on
      // `close`) on every outcome path; write-back failures are swallowed by
      // the runner, so a failed mirror/finalize never surfaces on the accepted
      // 202. The trailing catch is defensive — the runner never rejects.
      runClaudeJob({
        argv,
        cwd: dir,
        writeTargetKey: writeTarget.normalizedId,
        onSettled: (record) =>
          writeBackRun(projectDir, { mode, writeTarget, firstStableSpawn }, record),
      }).catch(() => {
        // Best-effort — the write-back lives inside the runner's onSettled.
      });

      return {
        session: writeTarget,
        run: {
          accepted: true,
          mode,
          ...(mode === "stable" && { threadId: runThreadId }),
        },
      };
    },
    202,
  ),
);

sessionsRoute.delete("/api/p/:slug/sessions/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    // Resolve through the index first: the sidecar filename keys on the
    // session's canonical normalizedId, so a non-slugified route id must not
    // re-derive the filename (deleteSession alone would orphan the sidecar).
    const session = await getSession(projectDir, c.req.param("id"));
    await deleteSession(projectDir, session.normalizedId);
    try {
      await unlink(sessionTranscriptPath(projectDir, session.normalizedId));
    } catch {
      // Sidecar may not exist — a failed unlink is a swallowed no-op.
    }
    return { deleted: true };
  }),
);

/**
 * Reads the session's transcript sidecar (mirrored Claude Code lines plus
 * ARCS-authored reference turns) into the read-model the web UI renders.
 * An absent sidecar answers an empty transcript with `mirroredAt: null`; once
 * the sidecar exists, `mirroredAt` is the file mtime so the UI can show how
 * fresh the mirror is.
 */
sessionsRoute.get("/api/p/:slug/sessions/:id/transcript", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const session = await getSession(projectDir, c.req.param("id"));

    let mirroredAt: string | null = null;
    try {
      const info = await stat(sessionTranscriptPath(projectDir, session.normalizedId));
      if (info.isFile()) mirroredAt = info.mtime.toISOString();
    } catch {
      // No sidecar yet — empty transcript, nothing mirrored.
    }
    if (mirroredAt === null) return { turns: [], mirroredAt: null };
    return { turns: await readSessionTurns(projectDir, session.normalizedId), mirroredAt };
  }),
);
