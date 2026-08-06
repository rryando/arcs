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
  beginSessionRun,
  canQueue,
  createSession,
  deleteSession,
  deriveSessionPhase,
  enqueueSessionMessage,
  getSession,
  listSessions,
  SESSION_LINKED_NODE_TYPES,
  SESSION_RUNTIME_TYPES,
  SESSION_STATUSES,
  type SessionFilters,
  type SessionMeta,
  type SessionPhase,
  sessionRunClaim,
  settleSessionRun,
  updateSession,
  upsertSession,
} from "../../utils/session-store.js";
import {
  type ClaudeRunRecord,
  isRunLive,
  liveRunPid,
  resolveTimeoutMs,
  runClaudeJob,
} from "../claude-runner.js";
import {
  createOpencodeSession,
  readOpencodeConfig,
  sendOpencodeMessage,
} from "../opencode-client.js";
import { parseBody, requireProjectDir, respond } from "../respond.js";
import { foldRunEventLog, pruneRunEventLogs } from "../run-event-log.js";
import { isProcessAlive, reconcileSessionPhases } from "../session-reconciler.js";

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

/**
 * The claude-facing session uuid for an ARCS stable thread.
 *
 * The ARCS thread id (`arcs-thread-<slug>-<uuid4>`) is deliberately
 * human-readable — it labels the session picker and names the transcript
 * sidecar — so it can never be handed to claude: `--session-id`/`--resume` on
 * claude >= 2.x accept a bare RFC-4122 uuid only and exit 1 with "Invalid
 * session ID. Must be a valid UUID." on anything else. Each thread therefore
 * carries its own uuid on `metadata.claudeSessionId`, minted once and reused
 * for every later turn: re-seeding an id claude already knows fails with
 * "already in use", so the mint must not repeat.
 */
async function threadClaudeSessionId(projectDir: string, thread: string): Promise<string> {
  try {
    const existing = await getSession(projectDir, thread);
    const persisted = existing.metadata?.claudeSessionId;
    if (typeof persisted === "string" && persisted !== "") return persisted;
  } catch {
    // No record for this thread yet — mint its first uuid below.
  }
  return randomUUID();
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

// ---------------------------------------------------------------------------
// Derived phase (read side)
// ---------------------------------------------------------------------------

/**
 * A session as a reader gets it: the stored record plus its reconciled phase.
 *
 * `phase` is DERIVED per response and never persisted — the store has no such
 * field and cannot be given one. It is the single answer to "is this session
 * live right now"; the raw `status` still travels for the record's own state.
 */
type SessionView = SessionMeta & { phase: SessionPhase };

/**
 * Epoch-ms deadline the claimed run will be killed at, when the spawn site
 * persisted one. Validated rather than trusted — a hand-edited index can carry
 * anything under this key.
 */
function runDeadlineAt(session: SessionMeta): number | undefined {
  const value = session.metadata?.runDeadlineAt;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The claimed run's own deadline, standing in for the store's fixed heartbeat
 * TTL.
 *
 * `RUN_HEARTBEAT_TTL_MS` is sized to the runner's 10-minute DEFAULT_TIMEOUT_MS,
 * but `resolveTimeoutMs` honours an explicit `timeoutMs` and
 * `ARCS_CLAUDE_RUN_TIMEOUT_MS`, and nothing refreshes `heartbeatAt` mid-run —
 * so past minute 10 a perfectly healthy 30-minute run derives `idle`, and the
 * reconciler cannot rescue it because it early-returns on any non-`running`
 * derivation and never probes the pid. The spawn site is the only place that
 * knows the timeout, so it persists the resulting deadline on the claim
 * (`metadata.runDeadlineAt`) and it is read back here as that run's TTL:
 *
 *  - inside the deadline the pid decides, exactly as the reconciler would;
 *  - past it the claim is not evidence of anything — the runner has already
 *    SIGTERMed then SIGKILLed the child — so it demotes to `idle`.
 *
 * Only ever consulted for a record that still holds a claim AND carries a
 * deadline; anything else (including every claim written before this field
 * existed) keeps the reconciler's own answer untouched.
 */
function runDeadlinePhase(session: SessionMeta, phase: SessionPhase, now: number): SessionPhase {
  // A terminal status outranks every liveness signal — a session that is over
  // is never reopened here.
  if (phase === "failed" || phase === "ended") return phase;
  const deadlineAt = runDeadlineAt(session);
  if (sessionRunClaim(session) === undefined || deadlineAt === undefined) return phase;
  if (now > deadlineAt) return "idle";
  const pid = session.currentRunPid;
  // No pid to probe (the spawn produced none) — the deadline stands alone.
  if (typeof pid !== "number") return "running";
  return isProcessAlive(pid) ? "running" : "idle";
}

/**
 * Attaches the reconciled phase to each session of ONE response.
 *
 * `reconcileSessionPhases` takes the project's whole index and runs AT MOST one
 * `claude agents --json` probe for it, so this is never one probe per session —
 * and the detail route pays exactly what the list does. At most, because the
 * probe is lazy: a request whose records all answer from their own evidence
 * (terminal, idle, or holding a run claim) spawns no subprocess at all. A record
 * that appeared between the two reads is not in the reconciler's answer and
 * falls back to its own store-derived phase.
 */
async function withPhases(projectDir: string, sessions: SessionMeta[]): Promise<SessionView[]> {
  const now = Date.now();
  const reconciled = new Map(
    (await reconcileSessionPhases(projectDir, { now })).map((view) => [view.sessionId, view.phase]),
  );
  return sessions.map((session) => ({
    ...session,
    phase: runDeadlinePhase(
      session,
      reconciled.get(session.normalizedId) ?? deriveSessionPhase(session, { now }),
      now,
    ),
  }));
}

// ---------------------------------------------------------------------------
// Run claims
// ---------------------------------------------------------------------------

interface RunWriteBackContext {
  mode: "resume" | "oneshot" | "stable";
  writeTarget: SessionMeta;
  firstStableSpawn: boolean;
  /** Id of the run this write-back settles — the claim it is allowed to release. */
  runId: string;
  /**
   * Resolves once the spawn-time claim (including the child's pid) has landed.
   * The write-back MUST await it before settling: settling releases the claim,
   * so a pid write arriving afterwards would resurrect a run that already
   * ended and leave the session reading `running` until its deadline. Both ends
   * belong to the same request, so the ordering is expressed directly rather
   * than hoped for.
   */
  claimed: Promise<void>;
}

/** Existing `metadata.run` as a mergeable object — anything else reads empty. */
function runMetadata(session: SessionMeta): Record<string, unknown> {
  const run = session.metadata?.run;
  if (typeof run !== "object" || run === null || Array.isArray(run)) return {};
  return run as Record<string, unknown>;
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
 *   The run's own event log folds down first (assistant text plus one turn per
 *   tool_use, every turn tagged with the run id so a second fold is a no-op).
 *   Only when that fold produced no assistant text — no log, an empty log, a
 *   child that spoke only through the terminal `result` envelope — does the
 *   captured reply get appended as an assistant turn on a success outcome;
 *   error/timeout outcomes still append nothing. The fold is deliberately NOT
 *   run for resume mode: that sidecar is owned by the transcript mirror above,
 *   which already carries the same turns with their transcript line ids, so
 *   folding there would double every turn.
 *
 * Every path finalizes metadata.run with the settled record (pid/startedAt/
 * mode plus endedAt/outcome/error/replyChars) so the panel shows the true
 * result. Best-effort by contract: the runner swallows any error thrown here,
 * so a failed write-back never surfaces on the accepted 202.
 *
 * The run CLAIM is released here too, by `settleSessionRun` rather than by a
 * hand-assembled `metadata.run` write: releasing the claim and stamping the
 * outcome is one read-modify-write under the store lock, guarded by the run id
 * so a run that has already been superseded never settles a newer one out from
 * under it.
 */
async function writeBackRun(
  projectDir: string,
  ctx: RunWriteBackContext,
  record: ClaudeRunRecord,
): Promise<void> {
  // Never settle a claim that is still being written (see ctx.claimed).
  await ctx.claimed;

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
  } else {
    // Modes 2/3: fold the run's durable event log down into the sidecar first.
    // Idempotent by its own output — every folded turn carries the run id, and
    // a run already represented there folds to nothing.
    const fold = await foldRunEventLog(projectDir, ctx.writeTarget.normalizedId, ctx.runId);
    if (
      !fold.assistantTextFolded &&
      record.outcome === "success" &&
      record.replyText !== undefined
    ) {
      // Nothing in the log spoke for this run (no log at all, or only tool
      // turns): the captured reply lands in the sidecar as an assistant turn,
      // minted in the shared negative id space after the user turn and any
      // reference. Tagged with the run id too, so it is covered by the same
      // no-second-fold guard. Error/timeout outcomes append nothing.
      await appendSessionTurn(projectDir, ctx.writeTarget.normalizedId, {
        type: "assistant",
        text: record.replyText,
        run: ctx.runId,
      });
    }
  }

  // Bounded retention, every mode: the log that just settled is the newest, so
  // it always survives and the sessions dir stays capped at
  // RUN_EVENT_LOG_RETENTION logs per session however many runs it accumulates.
  await pruneRunEventLogs(projectDir, ctx.writeTarget.normalizedId);

  // Outcome + claim release, atomically. `endedAt` rides the record so the run
  // is stamped with the moment the CHILD exited, not the moment this write ran.
  const settled = await settleSessionRun(projectDir, ctx.writeTarget.normalizedId, {
    runId: ctx.runId,
    outcome: record.outcome,
    ...(record.error !== undefined && { error: record.error }),
    ...(record.endedAt !== undefined && { endedAt: record.endedAt }),
  });

  // Everything the RUNNER measured, which no claim could have known at spawn:
  // the pid/startedAt the child actually reported, the targeting mode, and the
  // stream observations — time-to-first-token and wire-format drift are only
  // readable after the fact if they reach disk. `settleSessionRun` takes the
  // outcome alone (a settle must not be a place where arbitrary run fields can
  // be smuggled in), so these merge onto the run object it just wrote.
  const run = runMetadata(settled);
  // A newer run already owns the record — the settle above refused it, and this
  // merge must not overwrite the new run's numbers with this one's either.
  if (run.runId !== ctx.runId) return;
  const metadata: Record<string, unknown> = {
    run: {
      ...run,
      pid: record.pid,
      startedAt: record.startedAt,
      mode: ctx.mode,
      ...(record.replyChars !== undefined && { replyChars: record.replyChars }),
      ...(record.firstTokenAt !== undefined && { firstTokenAt: record.firstTokenAt }),
      ...(record.skippedLines !== undefined && { skippedLines: record.skippedLines }),
      ...(record.eventLogLines !== undefined && { eventLogLines: record.eventLogLines }),
      // A log that could not be written is REPORTED here, never thrown: the run
      // itself already succeeded or failed on its own merits.
      ...(record.eventLogError !== undefined && { eventLogError: record.eventLogError }),
    },
  };
  if (ctx.mode === "stable" && ctx.firstStableSpawn && record.outcome === "success") {
    metadata.threadInitialized = true;
  }
  await updateSession(projectDir, { id: ctx.writeTarget.normalizedId, metadata });
}

sessionsRoute.get("/api/p/:slug/sessions", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const sessions = await listSessions(
      projectDir,
      parseFilters(c.req.query("status"), c.req.query("runtimeType")),
    );
    return { sessions: await withPhases(projectDir, sessions) };
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
    const session = await getSession(projectDir, c.req.param("id"));
    const [view] = await withPhases(projectDir, [session]);
    return view;
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
 * Queued delivery needs a terminal session to drain the queue, so it is gated
 * on the `canQueue` capability derived from the session's persisted origin. An
 * `arcs`-origin thread has nothing attached that would ever read the queue:
 * accepting the message would make this route a black hole that answers 200 and
 * silently drops the prompt, so it is refused outright and the caller is sent to
 * `POST /run`, which actually drives such a thread.
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
      if (!canQueue(session)) {
        throw new DagError(
          "SESSION_QUEUE_UNSUPPORTED",
          `cannot queue a message for session "${session.normalizedId}": it is an ARCS-owned ` +
            `thread with no terminal session attached, so nothing would ever drain the queue — ` +
            `drive it with POST /api/p/<slug>/sessions/${session.normalizedId}/run instead.`,
        );
      }
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
 *   sidecar; the first successful spawn seeds the thread's claude-facing uuid
 *   (`--session-id`), later spawns continue it (`--resume` alone).
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
      /** Stable mode only — the uuid claude itself keys the thread on. */
      let runClaudeSessionId: string | undefined;
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
            // `origin: "arcs"` is what makes this record unqueueable; the
            // `control` marker is kept for readers that still render it.
            origin: "arcs",
            metadata: { control: "arcs-owned", directory: dir },
          });
        } else {
          // stable — reuse the referenced session's own thread when ARCS owns
          // it (its persisted origin says so; no metadata string is consulted),
          // otherwise take the payload threadId or mint a fresh one. A payload
          // threadId names the ARCS thread record only and gets its own minted
          // claude uuid: attaching to an external session's real claude thread
          // is mode=resume's job, never stable's.
          const thread =
            (session.origin === "arcs" && session.runtimeSessionId) ||
            threadId ||
            `arcs-thread-${slug}-${randomUUID()}`;
          runThreadId = thread;
          // Read before the upsert: metadata merges shallowly, so writing an
          // unconditionally minted uuid would clobber the thread's own one.
          runClaudeSessionId = await threadClaudeSessionId(projectDir, thread);
          writeTarget = await upsertSession(projectDir, {
            runtimeType: "claude-code",
            runtimeSessionId: thread,
            // Create-only: a freshly minted thread is ARCS-owned, while a
            // payload threadId naming a session ARCS merely observes keeps its
            // own origin (a terminal is attached there, so its queue still
            // works) — the store never rewrites provenance on an upsert.
            origin: "arcs",
            metadata: {
              control: "arcs-owned",
              directory: dir,
              claudeSessionId: runClaudeSessionId,
            },
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
        // Stable threads speak claude's uuid, never the ARCS thread id. The
        // seed spawn claims the uuid with --session-id; every later turn
        // continues it with --resume ALONE — claude >= 2.x refuses the two
        // flags together unless --fork-session is set, and --fork-session is
        // deliberately unused because it mints a new id per turn, which would
        // scatter one conversation across a new thread every send.
        const claudeThread = runClaudeSessionId as string;
        argv = firstStableSpawn
          ? ["-p", message, "--session-id", claudeThread, "--output-format", "json"]
          : ["-p", message, "--resume", claudeThread, "--output-format", "json"];
      }

      // The run's own ceiling, resolved HERE so the deadline persisted with the
      // claim is the same number the runner arms its kill timer with (it
      // prefers this over its own env/default lookup).
      const runId = randomUUID();
      const timeoutMs = resolveTimeoutMs(undefined, process.env);
      // Persisted next to the claim rather than inside metadata.run, which
      // `beginSessionRun` replaces wholesale: as a sibling key the deadline
      // cannot be clobbered by the claim, nor the claim by it.
      await updateSession(projectDir, {
        id: writeTarget.normalizedId,
        metadata: { runDeadlineAt: Date.now() + timeoutMs },
      });
      // Claim the record BEFORE the child exists: from here on, a server that
      // dies mid-run leaves a claim behind rather than an invisible orphan, and
      // the startup sweep (settleOrphanedRunsOnStartup) is what settles it.
      await beginSessionRun(projectDir, writeTarget.normalizedId, { runId });

      // Gate for the write-back: it must not settle (and release) the claim
      // while the pid write below is still in flight.
      let claimComplete: () => void = () => {};
      const claimed = new Promise<void>((resolveClaim) => {
        claimComplete = resolveClaim;
      });

      // Fire-and-forget: the run proceeds out-of-band. The runner invokes the
      // registered write-back after the child fully exits (it resolves on
      // `close`) on every outcome path; write-back failures are swallowed by
      // the runner, so a failed mirror/finalize never surfaces on the accepted
      // 202. The trailing catch is defensive — the runner never rejects.
      runClaudeJob({
        argv,
        cwd: dir,
        timeoutMs,
        writeTargetKey: writeTarget.normalizedId,
        // The SAME runId the claim above persisted as currentRunId — the log's
        // filename and the session record can never name different runs.
        eventLog: { projectDir, sessionId: writeTarget.normalizedId, runId },
        onSettled: (record) =>
          writeBackRun(projectDir, { mode, writeTarget, firstStableSpawn, runId, claimed }, record),
      }).catch(() => {
        // Best-effort — the write-back lives inside the runner's onSettled.
      });

      // runClaudeJob spawns synchronously (nothing is awaited before its
      // beginRun), so the child's pid is readable right here — and the claim it
      // lands on is the one written above, never a later run's. `undefined`
      // means the spawn produced no live run at all and `null` means it
      // produced no pid; neither is something to persist, and the claim then
      // stands on its heartbeat/deadline alone.
      try {
        const pid = liveRunPid(writeTarget.normalizedId);
        if (typeof pid === "number") {
          await beginSessionRun(projectDir, writeTarget.normalizedId, { runId, pid });
        }
      } catch {
        // A claim ARCS could not complete is not a reason to fail an accepted
        // run — the record simply carries no pid for it.
      } finally {
        claimComplete();
      }

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
    // Retention only ever prunes at a settle, and a deleted session never
    // settles again — its logs would otherwise sit in the sessions dir forever.
    await pruneRunEventLogs(projectDir, session.normalizedId, 0);
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
