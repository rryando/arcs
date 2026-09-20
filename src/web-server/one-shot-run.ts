/**
 * The shared one-shot run starter — ONE path for every web surface that spawns
 * a headless runtime against a project (the ask turn and the proposal-doc
 * promote, today).
 *
 * Extracted verbatim from the ask route so both callers inherit exactly the
 * same lifecycle instead of a second, subtly different copy. The sequence, and
 * why each step sits where it does:
 *
 *  1. a read-only `liveRun` probe answers the common overlapping request with a
 *     proper RUN_IN_PROGRESS before anything is spawned or written;
 *  2. the workspace the run executes in is resolved (guessing is not an option:
 *     a run in the wrong directory would silently point the agent at the wrong
 *     repository);
 *  3. the spawn-time workspace snapshot is captured and persisted
 *     best-effort — the baseline a later settle-time diff or revert renders
 *     against;
 *  4. the caller builds the prompt (it receives the resolved workspace dir) and
 *     the driver turns it into argv;
 *  5. `beginRun` CLAIMS the project's single live-run slot — before the child
 *     exists, so a server that dies mid-run leaves a claim behind rather than an
 *     invisible orphan;
 *  6. the child is spawned fire-and-forget through `runClaudeJob` with a
 *     write-back that settles the claim on every outcome;
 *  7. the child's pid is read synchronously (the runner spawns before its first
 *     await) and stamped on the claim, gated so the write-back cannot settle the
 *     claim while that pid write is still in flight.
 *
 * The write-back (fold the durable log, recognise a lost continuation, settle
 * the claim, prune logs, diff the workspace) lives here too: it is a function of
 * the run, not of who started it, so it must not be re-implemented per route.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DagError } from "../utils/errors.js";
import { readJsonSafe } from "../utils/json.js";
import type { SessionRuntimeType } from "../utils/storage-utils.js";
import {
  type ClaudeRunRecord,
  liveRunPid,
  resolveTimeoutMs,
  runClaudeJob,
} from "./claude-runner.js";
import {
  captureWorkspaceSnapshot,
  persistRunSnapshot,
  writeSettledRunChanges,
} from "./run-diff.js";
import type { RunDriverAdapter } from "./run-driver.js";
import { foldRunEventLog, pruneRunEventLogs } from "./run-event-log.js";
import { beginRun, liveRun, settleRun, updateRunPid } from "./run-store.js";

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

/**
 * The worktree a run should execute in — copied verbatim from the deleted
 * sessions route (via the ask route). Guessing is not an option: a run in the
 * wrong directory would silently point the agent at the wrong repository.
 */
export async function primaryWorkspacePath(projectDir: string, slug: string): Promise<string> {
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
 * Each driver's own words for "I do not know that session id", keyed by runtime
 * type. The pi and claude-code patterns are documented at the driver seam
 * ("No conversation found" / "session … not found"); the opencode/codex entries
 * are the same vocabulary as those runtimes' resume failures.
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
   * Resolves once the spawn-time claim (including the child's pid) has landed.
   * The write-back MUST await it before settling: settling stamps the outcome
   * and releases the claim, so a pid write arriving afterwards would resurrect
   * a run that already ended. Both ends belong to the same request, so the
   * ordering is expressed directly rather than hoped for.
   */
  claimed: Promise<void>;
}

/**
 * The write-back registered on runClaudeJob, invoked by the runner after the
 * child fully exits — on every outcome (success / error / timeout / killed).
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
 *  3. the run store stamps the outcome — one write, keyed on the run id, so a
 *     settle whose run has already settled (a cancel that won the race) is a
 *     byte-identical no-op.
 *
 * Retention belongs here too: the log that just settled is the newest, so it
 * always survives and the project's sessions dir stays capped at
 * RUN_EVENT_LOG_RETENTION logs however many runs it accumulates.
 *
 * Best-effort by contract: the runner swallows any error thrown here, so a
 * failed write-back never surfaces on the accepted response.
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

  // Workspace diff against the spawn-time snapshot — the approve/revert
  // review surface. Guarded exactly like the rest of this write-back's
  // best-effort contract: a failed diff (or an absent/errored snapshot)
  // degrades GET /changes to an empty list, never the settled claim.
  try {
    await writeSettledRunChanges(projectDir, ctx.slug, ctx.runId);
  } catch {
    // Swallowed — see the write-back doc comment above.
  }
}

// ---------------------------------------------------------------------------
// startOneShotRun
// ---------------------------------------------------------------------------

/** What the caller gets back: the accepted run's identity and where to tail it. */
export interface OneShotRunStarted {
  runId: string;
  /** Server-built stream URL, already keyed on the run id. */
  streamUrl: string;
  projectSlug: string;
}

export interface StartOneShotRunInput {
  /** Project data dir (the claim, event log and snapshot all live under it). */
  projectDir: string;
  /** Project slug — the log's directory segment and the stream URL's key. */
  slug: string;
  /** The runtime adapter that shapes argv for this run. */
  driver: RunDriverAdapter;
  /**
   * Builds the run's prompt. It receives the RESOLVED workspace directory the
   * child will run in, so a caller whose prompt names that directory does not
   * have to resolve — and risk disagreeing with — the same path itself.
   */
  buildPrompt: (workspaceDir: string) => string;
  /**
   * Runtime session id to continue; absent/blank means a fresh thread. A
   * continuation also materializes the pi session store dir, exactly as the
   * ask route always did.
   */
  continueSessionId?: string;
  /**
   * Key serializing this run's in-memory runner slot (claude-runner's
   * `beginRun`). The durable single-live-run gate is the run store's claim
   * above; this key only keeps the runner's own map coherent, so callers pass a
   * surface-scoped key (`ask:<slug>`, `promote:<slug>`).
   */
  writeTargetKey: string;
}

/**
 * Claims the project's one live-run slot, spawns the driver's one-shot child in
 * the project's primary workspace, and returns the run's id, stream URL and
 * slug — the acceptance, not the result: the run proceeds out-of-band and the
 * child's exit-time write-back settles it.
 *
 * Concurrency: one live run per PROJECT. The run store's `beginRun` is the
 * atomic claim (under the same lock the settle releases it under); the
 * read-only `liveRun` probe here answers the common overlapping case with a
 * proper 409 RUN_IN_PROGRESS before anything is spawned or written.
 */
export async function startOneShotRun(input: StartOneShotRunInput): Promise<OneShotRunStarted> {
  const { projectDir, slug, driver, buildPrompt, writeTargetKey } = input;

  // One live run per project — refuse before anything is written. The CODE is
  // the historical overlap signal (the sessions route's CLAUDE_RUN_IN_PROGRESS),
  // kept so clients have one 409 to handle.
  if ((await liveRun(projectDir)) !== undefined) {
    throw new DagError("RUN_IN_PROGRESS", `a run for project "${slug}" is already in progress`);
  }

  const dir = await primaryWorkspacePath(projectDir, slug);
  const runId = randomUUID();

  // The workspace baseline the settle-time diff renders against — captured
  // HERE, after the workspace is resolved and before the claim is taken, so the
  // state the run actually saw is what a later diff or revert compares to.
  // Best-effort: capture is total by contract (a failure records `error` on the
  // snapshot) and a persist failure degrades GET /changes to an empty list —
  // neither can fail the accepted response.
  const snapshot = await captureWorkspaceSnapshot(dir);
  await persistRunSnapshot(projectDir, slug, runId, snapshot).catch(() => {
    // Snapshot unpersistable — the review surface simply never materialises.
  });
  // The run's own ceiling, resolved HERE so the deadline persisted with the
  // claim is the same number the runner arms its kill timer with (it prefers
  // this over its own env/default lookup).
  const timeoutMs = resolveTimeoutMs(undefined, process.env);

  const continued =
    typeof input.continueSessionId === "string" && input.continueSessionId.trim() !== "";
  const argv = driver.buildArgv({
    message: buildPrompt(dir),
    ...(continued && {
      runtimeSessionId: input.continueSessionId,
      // An adapter without a session-dir flag ignores this; pi keys its
      // `--session-dir` off it so the store survives cwd changes.
      sessionDir: await piSessionsDir(projectDir),
    }),
  });

  // Claim the project's slot BEFORE the child exists: from here on, a server
  // that dies mid-run leaves a claim behind rather than an invisible orphan,
  // and the startup sweep (settleOrphanedRuns) is what settles it.
  await beginRun(projectDir, {
    runId,
    deadlineAt: Date.now() + timeoutMs,
    runtimeType: driver.runtimeType,
    runner: driver.binary,
    logSegment: slug,
  });

  // Gate for the write-back: it must not settle (and release) the claim while
  // the pid write below is still in flight.
  let claimComplete: () => void = () => {};
  const claimed = new Promise<void>((resolveClaim) => {
    claimComplete = resolveClaim;
  });

  // Fire-and-forget: the run proceeds out-of-band. The runner invokes the
  // registered write-back after the child fully exits (it resolves on `close`)
  // on every outcome path; write-back failures are swallowed by the runner, so
  // a failed finalize never surfaces on the accepted response. The trailing
  // catch is defensive — the runner never rejects.
  runClaudeJob(
    {
      argv,
      cwd: dir,
      timeoutMs,
      // The project's one-live-run slot, shared with run-store's claim.
      writeTargetKey,
      // A driver runtime owns its own wire format: its argv reaches the child
      // verbatim, never rewritten onto the claude output contract.
      streamJsonArgv: false,
      // The SAME runId the claim above persisted — the log's filename and the
      // run record can never name different runs.
      eventLog: { projectDir, sessionId: slug, runId },
      onSettled: (record) =>
        writeBackRun(projectDir, { slug, runId, runtimeType: driver.runtimeType, claimed }, record),
    },
    // The binary the driver names travels as the runner option — the runner
    // stays binary-agnostic.
    { binary: driver.binary },
  ).catch(() => {
    // Best-effort — the write-back lives inside the runner's onSettled.
  });

  // runClaudeJob spawns synchronously (nothing is awaited before its beginRun),
  // so the child's pid is readable right here — and the claim it lands on is the
  // one written above, never a later run's. `undefined` means the spawn produced
  // no live run at all and `null` means it produced no pid; neither is something
  // to persist, and the claim then stands on its deadline alone.
  try {
    const pid = liveRunPid(writeTargetKey);
    if (typeof pid === "number") {
      await updateRunPid(projectDir, { runId, pid });
    }
  } catch {
    // A claim ARCS could not complete is not a reason to fail an accepted run —
    // the record simply carries no pid for it.
  } finally {
    claimComplete();
  }

  return {
    runId,
    streamUrl: `/api/p/${slug}/runs/${runId}/stream`,
    projectSlug: slug,
  };
}
