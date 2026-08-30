/**
 * Ask-AI turn routes — the stateless, run-keyed replacement for the sessions
 * entity.
 *
 * Three routes, one surface:
 *
 *  - `POST /api/p/:slug/ask` — accept one turn of a headless conversation.
 *    Stateless by construction: there is no thread record anywhere. The client
 *    sends (message, optional references, optional bounded history,
 *    optional `continueSessionId`) and the server claims the project's ONE
 *    live-run slot, spawns the chosen runtime's one-shot driver and answers
 *    202 with the run id and its stream URL. Continuation state is the
 *    runtime-native session id the settled run harvests from its own log — it
 *    rides the stream's `end` frame and the client keeps it in localStorage.
 *  - `GET /api/p/:slug/runs/:runId/stream` — the stateless SSE tail of one
 *    run's durable event log, re-homed verbatim from the sessions route and
 *    keyed on the run store instead of the session record.
 *  - `DELETE /api/p/:slug/runs/:runId` — cancel a live run: SIGTERM its child
 *    and settle it `interrupted`.
 *
 * The RUNTIME policy — argv shapes and wire format — lives in run-driver.ts
 * adapters; the generic lifecycle stays in claude-runner.ts and
 * run-event-log.ts; the per-run claim lives in run-store.ts. Every route here
 * is browser-facing and therefore already behind the global loopback-only
 * `secureLocalRequest` middleware — no per-route auth.
 */

import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { DagError } from "../../utils/errors.js";
import { readJsonSafe } from "../../utils/json.js";
import type { SessionReference } from "../../utils/run-transcript.js";
import { SESSION_RUNTIME_TYPES, type SessionRuntimeType } from "../../utils/storage-utils.js";
import { renderHistory, renderReferences } from "../ask-prompt.js";
import {
  type ClaudeRunRecord,
  liveRunPid,
  resolveTimeoutMs,
  runClaudeJob,
} from "../claude-runner.js";
import { fail, parseBody, requireProjectDir, respond } from "../respond.js";
import { getRunDriver } from "../run-driver.js";
import {
  foldRunEventLog,
  pruneRunEventLogs,
  RUN_EVENT_LOG_MAX_BYTES,
  runEventLogPath,
} from "../run-event-log.js";
import {
  beginRun,
  getRun,
  liveRun,
  type RunOutcome,
  runsIndexPath,
  settleRun,
  updateRunPid,
} from "../run-store.js";

export const askRoute = new Hono();

// ---------------------------------------------------------------------------
// Reference schema — MOVED VERBATIM from the deleted sessions route
// ---------------------------------------------------------------------------

/**
 * The `doc` variant — a markdown document section.
 *
 * FROZEN, field for field: this is the only reference shape that existed before
 * the union, so every reference a caller (or a stored record) already has
 * carries exactly these keys and nothing else. The tag is REQUIRED here,
 * exactly as on the pointer variants: a legacy body carrying no tag never
 * reaches this schema untagged, because `sessionReferenceSchema`'s preprocess
 * fills it in before the union runs.
 */
const docReferenceSchema = z.object({
  type: z.literal("doc"),
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

/** The `file` variant — a line range in a workspace file. `headRev` rides along
 *  so a later diff can tell whether the file moved under the agent. */
const fileReferenceSchema = z.object({
  type: z.literal("file"),
  path: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  excerpt: z.string().optional(),
  headRev: z.string().optional(),
});

/** The `node` variant — a DAG entity, with no text slice of its own. */
const nodeReferenceSchema = z.object({
  type: z.literal("node"),
  kind: z.enum(["task", "plan", "knowledge"]),
  id: z.string().min(1),
});

/**
 * Something the caller is pointing the turn at, discriminated on `type` — an
 * unknown variant is REJECTED (400 INVALID_BODY naming the three tags) rather
 * than coerced into the nearest shape. The one accommodation is the preprocess
 * below: a body with no `type` at all can only be a pre-union doc reference,
 * so the tag is filled in before the union sees it.
 */
const sessionReferenceSchema = z
  .preprocess(
    (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value) && !("type" in value)
        ? { ...value, type: "doc" }
        : value,
    z.discriminatedUnion("type", [docReferenceSchema, fileReferenceSchema, nodeReferenceSchema]),
  )
  .superRefine((reference, ctx) => {
    // A backwards slice would render a nonsense pointer into the prompt.
    if (reference.type === "file" && reference.endLine < reference.startLine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endLine"],
        message: `endLine (${reference.endLine}) must be >= startLine (${reference.startLine})`,
      });
    }
  });

/**
 * Payload for POST /ask — one turn of a stateless headless conversation.
 *
 * `runner` defaults to "pi" — and an UNKNOWN runner string also degrades to
 * "pi" (a runtime the server does not recognise cannot be a deliberate pick;
 * refusing the whole turn over a picker that shipped a stale label would only
 * break the client). A runner WITH a registered type but NO registered driver
 * is refused with 400 UNKNOWN_RUNNER — that is a real gap in this server, not
 * a client typo.
 *
 * `history` is the client's local transcript tail, rendered into the prompt;
 * `continueSessionId` is the runtime-native session id a previous run's end
 * frame carried — its presence makes this turn a CONTINUATION of that thread.
 */
const askSchema = z.object({
  runner: z
    .preprocess(
      (value) =>
        typeof value === "string" && (SESSION_RUNTIME_TYPES as readonly string[]).includes(value)
          ? value
          : "pi",
      z.enum(SESSION_RUNTIME_TYPES),
    )
    .default("pi"),
  message: z.string().min(1),
  refs: z.array(sessionReferenceSchema).optional(),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).optional(),
  continueSessionId: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Prompt assembly — message + refs + history
// ---------------------------------------------------------------------------

/**
 * The turn's prompt: the message, then its rendered reference block, then the
 * bounded history block. References and history ride the PROMPT — the turn's
 * own tier — never a system tier, which is what keeps a later stable tier
 * byte-identical across turns.
 */
function askPrompt(
  message: string,
  refs: SessionReference[] | undefined,
  history: { role: "user" | "assistant"; text: string }[] | undefined,
): string {
  const parts = [message];
  const refsBlock = renderReferences(refs ?? []);
  if (refsBlock !== "") parts.push(refsBlock);
  const historyBlock = renderHistory(history);
  if (historyBlock !== "") parts.push(historyBlock);
  return parts.join("\n\n");
}

/**
 * The worktree a run should execute in — copied from the deleted sessions
 * route. Guessing is not an option: a turn run in the wrong directory would
 * silently point the agent at the wrong repository.
 */
async function primaryWorkspacePath(projectDir: string, slug: string): Promise<string> {
  const meta = await readJsonSafe<{ workspacePaths?: string[] }>(resolve(projectDir, "meta.json"));
  const directory = meta?.workspacePaths?.[0];
  if (!directory) {
    throw new DagError(
      "PROJECT_WORKSPACE_UNSET",
      `Project "${slug}" has no registered workspace path, so there is no directory to ` +
        `run an ask turn in — run \`arcs project update-paths ${slug} --add <path>\` first.`,
    );
  }
  return directory;
}

/**
 * Directory the pi driver keeps its session store in, created on demand so a
 * continuation `--session-dir` stays stable across cwd changes. Other drivers
 * ignore the `sessionDir` input (their adapters either have no such flag or
 * keep sessions under the caller's cwd themselves).
 */
async function piSessionsDir(projectDir: string): Promise<string> {
  const dir = join(projectDir, "pi-sessions");
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Run write-back
// ---------------------------------------------------------------------------

/**
 * Claude's own words for the two ways a runtime says "I do not know that
 * session id", per driver. The pi and claude-code patterns are documented at
 * the driver seam ("No conversation found" / "session … not found"); the
 * opencode/codex entries are the same vocabulary as those runtimes' resume
 * failures.
 *
 * FRAGILE BY CONSTRUCTION, and stated as such rather than hidden: these are
 * human-facing CLI stderr strings, not a stable contract, and a runtime patch
 * can reword either without notice. Each is a REPAIR rather than a behaviour:
 * a message that stops matching costs the client the CONTINUATION_LOST signal,
 * never the run.
 */
const CONTINUATION_LOST_PATTERNS: Record<string, RegExp> = {
  pi: /No conversation found|session.*not found/i,
  "claude-code": /No conversation found with session ID/i,
  opencode: /session.*not found|conversation.*not found/i,
  codex: /session.*not found|conversation.*not found/i,
};

interface RunWriteBackContext {
  /** Project slug — the run log's directory segment. */
  slug: string;
  /** Id of the run this write-back settles — the claim it is allowed to stamp. */
  runId: string;
  /** Runtime type that shaped the run — selects the log's normalizer. */
  runtimeType: SessionRuntimeType;
  /**
   * Resolves once the spawn-time claim (including the child's pid) has
   * landed. The write-back MUST await it before settling: settling stamps the
   * outcome and releases the claim, so a pid write arriving afterwards would
   * resurrect a run that already ended. Both ends belong to the same request,
   * so the ordering is expressed directly rather than hoped for.
   */
  claimed: Promise<void>;
}

/**
 * The write-back the route registers on runClaudeJob, invoked by the runner
 * after the child fully exits — on every outcome (success / error / timeout /
 * killed).
 *
 * Three things happen here:
 *  1. the run's durable event log folds down through the run's own driver
 *     normalizer — what the fold hands back that matters is the harvested
 *     `runtimeSessionId`, the continuation handle the end frame carries.
 *  2. a continuation failure ("I do not know that session id") is recognised
 *     from the child's error text and settles with `errorCode:
 *     "CONTINUATION_LOST"` — the client's signal to re-seed: it keeps its own
 *     full local transcript, so the next turn sends that transcript as
 *     `history` and no `continueSessionId`.
 *  3. the run store stamps the outcome — one write, keyed on the run id, so
 *     a settle whose run has already settled (a cancel that won the race) is
 *     a byte-identical no-op.
 *
 * Retention belongs here too: the log that just settled is the newest, so it
 * always survives and the project's sessions dir stays capped at
 * RUN_EVENT_LOG_RETENTION logs however many runs it accumulates.
 *
 * Best-effort by contract: the runner swallows any error thrown here, so a
 * failed write-back never surfaces on the accepted 202.
 */
async function writeBackRun(
  projectDir: string,
  ctx: RunWriteBackContext,
  record: ClaudeRunRecord,
): Promise<void> {
  // Never settle a claim whose pid write is still in flight (see ctx.claimed).
  await ctx.claimed;

  const fold = await foldRunEventLog(projectDir, ctx.slug, ctx.runId, {
    runtimeType: ctx.runtimeType,
  });

  const errorText = typeof record.error === "string" ? record.error : "";
  const continuationLost = CONTINUATION_LOST_PATTERNS[ctx.runtimeType]?.test(errorText) === true;

  await settleRun(projectDir, {
    runId: ctx.runId,
    // A continuation the runtime refused is an error outcome by definition.
    outcome: continuationLost ? "error" : record.outcome,
    ...(record.error !== undefined && { error: record.error }),
    ...(record.endedAt !== undefined && { endedAt: record.endedAt }),
    ...(record.replyChars !== undefined && { replyChars: record.replyChars }),
    // The harvested continuation handle lands with the settle — from the
    // moment the claim is released the next turn is accepted, and it has to
    // see the id or it mints a fresh runtime thread instead of continuing.
    ...(fold.runtimeSessionId !== undefined && { runtimeSessionId: fold.runtimeSessionId }),
    ...(continuationLost && { errorCode: "CONTINUATION_LOST" }),
    // A capped log reports `eventLogTruncated` so the stream's end frame can
    // say "you reached a hole" instead of "the run fell silent".
    ...(record.eventLogTruncated === true && { eventLogTruncated: true }),
  });
  await pruneRunEventLogs(projectDir, ctx.slug);
}

// ---------------------------------------------------------------------------
// POST /api/p/:slug/ask
// ---------------------------------------------------------------------------

/**
 * One turn of a stateless headless conversation. Answers 202 with the run's id
 * and the stream to tail it on — the acceptance, not the result: the run
 * proceeds out-of-band in the runner, whose exit-time write-back settles it.
 *
 * TODO(snapshot): workspace diffing lands in a later wave. The snapshot hook
 * belongs HERE — after the workspace is resolved and before the claim is
 * taken — so a later diff can be rendered against the state the run actually
 * saw.
 *
 * Concurrency: one live run per PROJECT. The run store's beginRun is the
 * atomic claim (under the same lock the settle releases it under); the
 * read-only `liveRun` probe here answers the common overlapping case with a
 * proper 409 RUN_IN_PROGRESS before anything is spawned or written.
 */
askRoute.post("/api/p/:slug/ask", async (c) =>
  respond(
    c,
    async () => {
      const slug = c.req.param("slug");
      const projectDir = requireProjectDir(slug);
      const input = await parseBody(c, askSchema);
      const { runner, message, refs, history, continueSessionId } = input;

      const driver = getRunDriver(runner);
      if (driver === undefined) {
        throw new DagError(
          "UNKNOWN_RUNNER",
          `no one-shot driver is registered for runtime "${runner}"`,
        );
      }

      // One live run per project — refuse before anything is written. The CODE
      // is the historical overlap signal (the sessions route's
      // CLAUDE_RUN_IN_PROGRESS), kept so clients have one 409 to handle.
      if ((await liveRun(projectDir)) !== undefined) {
        throw new DagError("RUN_IN_PROGRESS", `a run for project "${slug}" is already in progress`);
      }

      // TODO(snapshot): see the route doc comment — the workspace snapshot
      // hook goes here (it must capture state BEFORE the claim is taken).

      const dir = await primaryWorkspacePath(projectDir, slug);
      const runId = randomUUID();
      // The run's own ceiling, resolved HERE so the deadline persisted with
      // the claim is the same number the runner arms its kill timer with (it
      // prefers this over its own env/default lookup).
      const timeoutMs = resolveTimeoutMs(undefined, process.env);

      const continued = typeof continueSessionId === "string" && continueSessionId.trim() !== "";
      const argv = driver.buildArgv({
        message: askPrompt(message, refs, history),
        ...(continued && {
          runtimeSessionId: continueSessionId,
          // An adapter without a session-dir flag ignores this; pi keys its
          // `--session-dir` off it so the store survives cwd changes.
          sessionDir: await piSessionsDir(projectDir),
        }),
      });

      // Claim the project's slot BEFORE the child exists: from here on, a
      // server that dies mid-run leaves a claim behind rather than an
      // invisible orphan, and the startup sweep (settleOrphanedRuns) is what
      // settles it.
      await beginRun(projectDir, {
        runId,
        deadlineAt: Date.now() + timeoutMs,
        runtimeType: runner,
        runner: driver.binary,
        logSegment: slug,
      });

      // Gate for the write-back: it must not settle (and release) the claim
      // while the pid write below is still in flight.
      let claimComplete: () => void = () => {};
      const claimed = new Promise<void>((resolveClaim) => {
        claimComplete = resolveClaim;
      });

      // Fire-and-forget: the run proceeds out-of-band. The runner invokes the
      // registered write-back after the child fully exits (it resolves on
      // `close`) on every outcome path; write-back failures are swallowed by
      // the runner, so a failed finalize never surfaces on the accepted 202.
      // The trailing catch is defensive — the runner never rejects.
      runClaudeJob(
        {
          argv,
          cwd: dir,
          timeoutMs,
          // The project's one-live-run slot, shared with run-store's claim.
          writeTargetKey: `ask:${slug}`,
          // A driver runtime owns its own wire format: its argv reaches the
          // child verbatim, never rewritten onto the claude output contract.
          streamJsonArgv: false,
          // The SAME runId the claim above persisted — the log's filename and
          // the run record can never name different runs.
          eventLog: { projectDir, sessionId: slug, runId },
          onSettled: (record) =>
            writeBackRun(projectDir, { slug, runId, runtimeType: runner, claimed }, record),
        },
        // The binary the driver names travels as the runner option — the
        // runner stays binary-agnostic.
        { binary: driver.binary },
      ).catch(() => {
        // Best-effort — the write-back lives inside the runner's onSettled.
      });

      // runClaudeJob spawns synchronously (nothing is awaited before its
      // beginRun), so the child's pid is readable right here — and the claim
      // it lands on is the one written above, never a later run's. `undefined`
      // means the spawn produced no live run at all and `null` means it
      // produced no pid; neither is something to persist, and the claim then
      // stands on its deadline alone.
      try {
        const pid = liveRunPid(`ask:${slug}`);
        if (typeof pid === "number") {
          await updateRunPid(projectDir, { runId, pid });
        }
      } catch {
        // A claim ARCS could not complete is not a reason to fail an accepted
        // run — the record simply carries no pid for it.
      } finally {
        claimComplete();
      }

      return {
        runId,
        streamUrl: `/api/p/${slug}/runs/${runId}/stream`,
        projectSlug: slug,
      };
    },
    202,
  ),
);

// ---------------------------------------------------------------------------
// DELETE /api/p/:slug/runs/:runId — cancel
// ---------------------------------------------------------------------------

/**
 * Cancels a live run: SIGTERM the child from the claim, then settle the run
 * `interrupted` ("cancelled by user").
 *
 * Idempotent: a run that is unknown or already settled (by its own write-back,
 * by a timeout, or by an earlier cancel) answers 404 — there is nothing left
 * to cancel, and a second cancel must not re-stamp a settled record. The
 * runner's own settle for the SIGTERMed child races this one, and loses by
 * construction: `settleRun` is keyed on the run id, so whichever writes first
 * releases the claim and the other becomes a byte-identical no-op — and this
 * route's `interrupted` semantics are the ones the client asked for.
 */
askRoute.delete("/api/p/:slug/runs/:runId", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const runId = c.req.param("runId");
    const run = await getRun(projectDir, runId);
    if (run === undefined || run.outcome !== undefined) {
      throw new DagError(
        "RUN_NOT_FOUND",
        `no live run "${runId}" on project "${c.req.param("slug")}" to cancel`,
      );
    }
    if (typeof run.pid === "number") {
      try {
        process.kill(run.pid, "SIGTERM");
      } catch {
        // The child is already gone — nothing to signal.
      }
    }
    await settleRun(projectDir, { runId, outcome: "interrupted", error: "cancelled by user" });
    return { cancelled: runId };
  }),
);

// ---------------------------------------------------------------------------
// Run event stream — a stateless tail of one run's event log
// ---------------------------------------------------------------------------

/**
 * How often an attached tail re-reads the log. Polling rather than
 * `fs.watch`: watch semantics vary by platform and filesystem (and still need
 * a poll fallback to be total), and a watcher is per-connection state — the
 * one thing this route may not hold.
 */
const RUN_TAIL_POLL_MS = 100;

/** The framing byte. A line is only a record once THIS terminates it. */
const RUN_LOG_NEWLINE = 0x0a;

/** What the tail can tell about a run without holding anything of its own. */
interface RunTailState {
  /** Nothing will ever be appended to this run's log again. */
  settled: boolean;
  /** The run's stamped outcome, when its own record is readable. */
  outcome?: RunOutcome;
  /**
   * Whether the log is the WHOLE stream, when the run's own record is
   * readable. `undefined` means UNKNOWN, never "complete": the record is gone
   * or superseded, so the tail must not manufacture a `false` for it.
   */
  truncated?: boolean;
  /** The harvested continuation handle, when the settled record carries one. */
  runtimeSessionId?: string;
  /** Typed failure code (CONTINUATION_LOST), when the settled record has one. */
  errorCode?: string;
}

/**
 * Whether the run store, read DIRECTLY, answers that THIS run is not in it —
 * the only thing that turns `getRun`'s silence into "the run is gone".
 *
 * `getRun`'s `undefined` is NOT by itself evidence of deletion:
 * `readRunsIndex` folds an unreadable index into an empty one
 * (`readJsonSafe` swallows every error class), so an EACCES, an EISDIR or a
 * malformed index on a live store arrives looking exactly like a run that was
 * never recorded. So a not-found is believed only when a DIRECT read of the
 * index says this run is not listed (or that there is no index at all);
 * anything else is reported as unavailable and the tail keeps polling —
 * absent evidence must never look like evidence of silence.
 */
async function runIndexAnsweredDirect(projectDir: string, runId: string): Promise<boolean> {
  try {
    const raw = await readFile(runsIndexPath(projectDir), "utf-8");
    const parsed = JSON.parse(raw) as { runs?: { runId?: string }[] };
    if (!Array.isArray(parsed?.runs)) return false;
    return !parsed.runs.some((run) => run?.runId === runId);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Whether the run is still live, read from the RUN STORE rather than from the
 * runner's in-memory `liveRuns` map.
 *
 * The claim is the only liveness signal that survives a restart, and it is
 * what keeps this route stateless: the in-memory probe would answer "no" for
 * every run inherited from a dead server process, closing a stream whose child
 * is still writing. The claim also stamps its outcome exactly once, under the
 * store lock, in the same write that releases it — so "claim gone" and
 * "outcome readable" can never disagree.
 */
async function readRunTailState(projectDir: string, runId: string): Promise<RunTailState> {
  const run = await getRun(projectDir, runId);
  if (run === undefined) {
    // Two reads, and only their AGREEMENT settles: `getRun` answered nothing
    // AND a direct read of the index answers that this run is not in it (or
    // that there is no index at all). Everything else keeps the tail polling,
    // because absent evidence must not look like evidence of silence: the
    // `end` frame a transient read failure would emit here is byte-identical
    // to the legitimate superseded-run one, and a live run's remaining lines
    // would never reach the consumer at all.
    return { settled: await runIndexAnsweredDirect(projectDir, runId) };
  }
  // A live claim (no outcome stamped yet): the run holds the project's slot.
  if (run.outcome === undefined) return { settled: false };

  return {
    settled: true,
    outcome: run.outcome,
    // Only ever written as `true` (the write-back omits it otherwise), so its
    // absence on THIS run's own record means the log is whole.
    truncated: run.eventLogTruncated === true,
    ...(run.runtimeSessionId !== undefined && { runtimeSessionId: run.runtimeSessionId }),
    ...(run.errorCode !== undefined && { errorCode: run.errorCode }),
  };
}

/** Complete lines read out of the log, and how many bytes they consumed. */
interface RunTailRead {
  lines: string[];
  /** Bytes consumed — always lands just past a newline, or 0. */
  bytes: number;
}

const EMPTY_TAIL_READ: RunTailRead = { lines: [], bytes: 0 };

/**
 * Every COMPLETE line the log holds at or after `byteOffset`.
 *
 * The trailing-partial rule is the whole point of this function. While a run
 * is live the file's last bytes may be a record the child is still writing,
 * and the log also leaves an orphaned fragment behind wherever it lost bytes
 * and refused to extend the open line. Both look identical from here —
 * unterminated bytes at EOF — so neither is ever emitted: consumption stops AT
 * the last newline and `bytes` reports only that much, leaving the fragment to
 * be re-read by the next poll once (and if) it completes. Emitting it would
 * fabricate a record the child never wrote, and a fabricated record is
 * undetectable downstream.
 */
async function readRunLogLines(path: string, byteOffset: number): Promise<RunTailRead> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return EMPTY_TAIL_READ;
  }
  try {
    const { size } = await handle.stat();
    // Bounded by the same ceiling `foldRunEventLog` reads against.
    const end = Math.min(size, RUN_EVENT_LOG_MAX_BYTES);
    // Nothing new. `<` rather than `===` covers the file shrinking under us.
    if (end <= byteOffset) return EMPTY_TAIL_READ;

    const buffer = Buffer.allocUnsafe(end - byteOffset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, byteOffset);
    const chunk = buffer.subarray(0, bytesRead);

    const lines: string[] = [];
    let consumed = 0;
    for (;;) {
      const at = chunk.indexOf(RUN_LOG_NEWLINE, consumed);
      if (at === -1) break;
      // Verbatim, terminator excluded: the log is the source of truth and this
      // is a view of it, so nothing here trims, parses or repairs a line.
      lines.push(chunk.toString("utf-8", consumed, at));
      consumed = at + 1;
    }
    return { lines, bytes: consumed };
  } catch {
    return EMPTY_TAIL_READ;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Digits and nothing else — no sign, no exponent, no whitespace, no separators.
 */
const RUN_TAIL_OFFSET_PATTERN = /^\d+$/;

/**
 * Where the tail starts, as an ABSOLUTE line offset into the log — the index
 * of the next line the client has NOT seen (last seen offset + 1), so a
 * reconnect at it can neither duplicate nor skip. Two sources, and the LARGER
 * wins: `from` is what an explicit reconnect passes; `Last-Event-ID` is what a
 * browser `EventSource` replays automatically on its own reconnect, where the
 * URL (and therefore `from`) is frozen. A request that carries `Last-Event-ID`
 * CANNOT REWIND below it, whatever `?from=` says.
 *
 * Garbage is REFUSED rather than clamped: the only clamp available is 0, which
 * silently replays the entire log — precisely the duplicate storm the offset
 * exists to prevent.
 */
function parseRunTailOffset(from: string | undefined, lastEventId: string | undefined): number {
  const parse = (raw: string | undefined, label: string): number => {
    if (raw === undefined || raw === "") return 0;
    if (!RUN_TAIL_OFFSET_PATTERN.test(raw) || Number(raw) > Number.MAX_SAFE_INTEGER) {
      throw new DagError(
        "INVALID_RUN_STREAM_OFFSET",
        `${label} must be a non-negative integer line offset no greater than ` +
          `${Number.MAX_SAFE_INTEGER}, got "${raw}"`,
      );
    }
    return Number(raw);
  };
  return Math.max(parse(from, "from"), parse(lastEventId, "Last-Event-ID"));
}

/**
 * Answers a pre-stream resolution failure as JSON rather than as a stream.
 * `respond` cannot be reused: it wraps the SUCCESS path in the envelope too,
 * and this route's success is an event stream with no envelope at all.
 */
function runStreamFailure(c: Context, err: unknown): Response {
  if (err instanceof DagError) {
    return c.json(fail(err.code, err.message), err.code.includes("NOT_FOUND") ? 404 : 400);
  }
  console.error("[arcs-web] run stream preflight failed", err);
  return c.json(fail("internal_error", "Unexpected server error"), 500);
}

/**
 * Tails one run's durable event log as SSE, live or after the fact.
 *
 * The log is the source of truth and this is a VIEW of it — a stateless tail,
 * not a subscription. Every frame is derived from `?from=` plus the file, the
 * only state is two numbers on this request's own stack, and nothing keyed on
 * a run or a connection exists anywhere in this module. That is what makes a
 * server restart cost exactly one client reconnect: the new process can
 * answer the same GET with the same bytes.
 *
 * Frames, all carrying an absolute line offset:
 *  - `line`  `{ offset, line }` — the log's line at `offset`, verbatim.
 *  - `end`   `{ offset, outcome?, truncated?, runtimeSessionId?, errorCode? }`
 *            — the run has settled and the log is drained; `offset` is the
 *            log's total complete-line count, i.e. the `from` that would now
 *            return nothing. `runtimeSessionId` is the harvested continuation
 *            handle the client persists (its next turn's `continueSessionId`);
 *            `errorCode` is a typed failure (CONTINUATION_LOST) the client
 *            re-seeds from.
 *
 * The SSE `id` field is the RESUME cursor rather than the frame's own index,
 * which is what makes an `EventSource` auto-reconnect land exactly where it
 * left off. Note that an `EventSource` reconnects on ANY stream end, `end`
 * frame included — the client is expected to `close()` on `end`.
 *
 * Ordering that carries the whole live/settled distinction: the settle is
 * observed BEFORE the read, never after. A run settled at that instant appends
 * nothing later, so the read that follows is guaranteed to see the log whole.
 *
 * `truncated` on the `end` frame is how a consumer tells "I reached the end of
 * the stream" from "I reached a hole the log refused to fill". It is only
 * readable at settle: while the run is live the flag lives in the writer's
 * memory and reaches disk only when the write-back stamps the outcome.
 *
 * A read route by construction — it opens nothing, spawns nothing and writes
 * nothing — so it sits behind the loopback check alone, exactly like every
 * other GET here, and the `X-ARCS-Token` mutation gate passes it through on
 * method.
 */
askRoute.get("/api/p/:slug/runs/:runId/stream", async (c) => {
  const runId = c.req.param("runId");
  let projectDir: string;
  let logPath: string;
  let fromOffset: number;
  try {
    projectDir = requireProjectDir(c.req.param("slug"));
    const slug = c.req.param("slug");
    fromOffset = parseRunTailOffset(c.req.query("from"), c.req.header("last-event-id"));
    // Keyed on the slug, exactly as the writer keys it (the spawn site passes
    // `sessionId: slug`); the run id reaches a filename through
    // `runEventLogSegment`, which sanitizes it, so a traversal-shaped runId
    // cannot address anything outside the sessions dir.
    logPath = runEventLogPath(projectDir, slug, runId);

    let logged = false;
    try {
      logged = (await stat(logPath)).isFile();
    } catch {
      // Not written yet — the claim lands BEFORE the child spawns, so a tail
      // that connects on the 202 legitimately arrives ahead of the file.
    }
    const run = await getRun(projectDir, runId);
    // Neither a log nor a claim: the run never existed under this id, or
    // retention has already pruned it. Refused rather than answered with an
    // empty stream — absent evidence must never look like evidence of silence.
    if (!logged && (run === undefined || run.outcome !== undefined)) {
      throw new DagError(
        "RUN_RUN_LOG_NOT_FOUND",
        `no event log for run "${runId}" on project "${slug}" — it is not the ` +
          `project's live run and its log is not on disk (pruned, or never written)`,
      );
    }
  } catch (err) {
    return runStreamFailure(c, err);
  }

  return streamSSE(c, async (stream) => {
    /** Absolute index of the next line at `byteOffset`. */
    let lineOffset = 0;
    /** Bytes of the log already framed into lines — never inside a record. */
    let byteOffset = 0;

    while (!stream.aborted) {
      const state = await readRunTailState(projectDir, runId);
      const { lines, bytes } = await readRunLogLines(logPath, byteOffset);
      byteOffset += bytes;

      for (const line of lines) {
        const offset = lineOffset;
        lineOffset += 1;
        // Counted but not sent: the client already holds it. Counting is what
        // keeps offsets ABSOLUTE — a skipped line still occupies its index.
        if (offset < fromOffset) continue;
        await stream.writeSSE({
          event: "line",
          id: String(offset + 1),
          data: JSON.stringify({ offset, line }),
        });
      }

      if (state.settled) {
        await stream.writeSSE({
          event: "end",
          id: String(lineOffset),
          data: JSON.stringify({
            offset: lineOffset,
            ...(state.outcome !== undefined && { outcome: state.outcome }),
            ...(state.truncated !== undefined && { truncated: state.truncated }),
            ...(state.runtimeSessionId !== undefined && {
              runtimeSessionId: state.runtimeSessionId,
            }),
            ...(state.errorCode !== undefined && { errorCode: state.errorCode }),
          }),
        });
        return;
      }

      await stream.sleep(RUN_TAIL_POLL_MS);
    }
  });
});
