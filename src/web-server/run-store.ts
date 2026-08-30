/**
 * Per-run claims — the durable spine of the stateless Ask-AI turn surface.
 *
 * Replaces the sessions-entity run claims (session-store's `currentRunId` +
 * `metadata.run`) with a store keyed by RUN, not by session: per-project
 * `runs/index.json` records every run a project spawned, and a record with no
 * `outcome` IS the live claim. There is no thread record anywhere — a run is
 * the only unit of persistence, and everything a client needs to continue a
 * conversation (the end frame's `runtimeSessionId`, harvested by the fold)
 * reaches it out of band.
 *
 * Concurrency: ONE live run per project. `beginRun` refuses (DagError
 * `RUN_IN_PROGRESS`, mapped to HTTP 409 by respond.ts) while an unsettled
 * claim holds the index — the same single overlap signal the sessions route
 * used, renamed.
 *
 * Liveness survives a restart the same way it always did: the claim persists
 * the child's pid, and `settleOrphanedRuns` (the startup sweep) probes it.
 * Deliberately narrowed from the old reconciler: a dead pid alone no longer
 * settles — the run's own deadline must also have passed, so a claim written
 * by a previous server process whose child outlived the restart is left alone,
 * and a claim whose child died mid-run settles `interrupted` exactly once.
 */

import { join, resolve } from "node:path";
import { readRootMeta } from "../utils/dag.js";
import { DagError } from "../utils/errors.js";
import { withLock } from "../utils/file-lock.js";
import { readJsonSafe } from "../utils/json.js";
import { getDataDir } from "../utils/paths.js";
import { ensureDir, writeJson } from "../utils/storage-utils.js";
import { pruneRunEventLogs } from "./run-event-log.js";

/** How a run ended. A superset of the runner's own `RunOutcome`: `interrupted`
 *  is never produced BY a run, it is written FOR a run whose process vanished
 *  without settling — a restart's orphan, or a cancel. */
export type RunOutcome = "success" | "error" | "timeout" | "interrupted";

/**
 * One run record. `outcome` absent ⇢ the record IS the live claim; present ⇢
 * the run has settled and `endedAt` is stamped.
 *
 * All timestamps are epoch ms (`Date.now()`), matching the runner's own record
 * unit. Fields are validated on read — a hand-edited index can carry anything.
 */
export interface RunRecord {
  /** UUID the route minted — the claim's identity and the log's filename key. */
  runId: string;
  /** OS pid of the spawned child; absent when the spawn produced none. */
  pid?: number;
  /** Epoch ms of the claim. */
  startedAt: number;
  /** Epoch ms the runner's kill timer is armed for (resolveTimeoutMs + now). */
  deadlineAt: number;
  /** The driver's runtime type ("pi" | "opencode" | "claude-code" | "codex"). */
  runtimeType: string;
  /** The binary the runner spawned. */
  runner: string;
  /** The runtime session id this run continued, when it was a continuation. */
  continueSessionId?: string;
  /**
   * Directory segment the run's event log is keyed under (`sessions/`
   * filename prefix) — the project slug for the ask route. Retention and the
   * startup sweep prune logs by this segment, so it rides the claim rather
   * than being re-derived by a process that was not the spawner.
   */
  logSegment: string;

  // --- Settled fields -------------------------------------------------------
  outcome?: RunOutcome;
  error?: string;
  /**
   * Epoch ms the CHILD exited — stamped from the runner's record, so a settle
   * that runs after a restart (the sweep) stamps its own now.
   */
  endedAt?: number;
  /** Length of the run's reply text, as the runner measured it. */
  replyChars?: number;
  /** The runtime-native session id the fold harvested from the run log — the
   *  continuation handle the end frame carries to the client. */
  runtimeSessionId?: string;
  /** Typed failure the client can act on (e.g. "CONTINUATION_LOST"). */
  errorCode?: string;
  /** The run's event log hit its cap or lost bytes — the end frame reports it
   *  so a consumer knows it reached a hole, never a silent end. */
  eventLogTruncated?: boolean;
  /** Epoch ms the run's workspace changes were reverted (POST /revert). Once
   *  stamped, a second revert is refused — one revert per run, whatever it
   *  found to revert. Lives on the record (not the sidecars) so it survives
   *  their retention pruning. */
  revertedAt?: number;
}

export interface RunIndex {
  runs: RunRecord[];
}

// ---------------------------------------------------------------------------
// Index IO
// ---------------------------------------------------------------------------

/** Index path — the pattern session-store used for `sessions/index.json`. */
export function runsIndexPath(projectDir: string): string {
  return join(projectDir, "runs", "index.json");
}

function runStoreLockPath(projectDir: string): string {
  return join(projectDir, "runs", ".store");
}

/** A decoded record that is usable as a run — anything else is dropped on
 *  read, exactly as session-store dropped records with unknown runtime types. */
function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.runId !== "string" || record.runId === "") return false;
  const startedAt = record.startedAt;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return false;
  const runtimeType = record.runtimeType;
  if (typeof runtimeType !== "string" || runtimeType === "") return false;
  return true;
}

async function readRunsIndex(projectDir: string): Promise<RunRecord[]> {
  const index = await readJsonSafe<RunIndex>(runsIndexPath(projectDir));
  if (!index || !Array.isArray(index.runs)) return [];
  return index.runs.filter(isRunRecord);
}

async function writeRunsIndex(projectDir: string, runs: RunRecord[]): Promise<void> {
  await ensureDir(join(projectDir, "runs"));
  await writeJson(runsIndexPath(projectDir), { runs });
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export interface BeginRunInput {
  /** Caller-minted id for this run — the claim's identity. */
  runId: string;
  /** OS pid of the spawned child; absent/`null` when the spawn produced none. */
  pid?: number | null;
  /** Epoch ms the runner will kill the child at — persisted WITH the claim so
   *  the startup sweep can tell "still within its window" from "orphaned". */
  deadlineAt: number;
  /** Driver runtime type that shaped the run's argv. */
  runtimeType: string;
  /** Binary the runner spawns. */
  runner: string;
  /** The runtime session id this run continues, when it is a continuation. */
  continueSessionId?: string;
  /** Directory segment the run's event log is keyed under (see RunRecord). */
  logSegment: string;
}

/**
 * Claims the project's one live-run slot for `runId`.
 *
 * Refuses with `RUN_IN_PROGRESS` (409 on the wire) while ANY unsettled claim
 * holds the index — the atomic single-live-run gate, checked under the same
 * lock the settle releases it under, so two overlapping POSTs cannot both win.
 * The claim lands BEFORE the child exists: from here on, a server that dies
 * mid-run leaves a claim behind rather than an invisible orphan, and the
 * startup sweep is what settles it.
 */
export async function beginRun(projectDir: string, input: BeginRunInput): Promise<RunRecord> {
  await ensureDir(join(projectDir, "runs"));
  return withLock(runStoreLockPath(projectDir), async () => {
    const runs = await readRunsIndex(projectDir);
    const live = runs.find((run) => run.outcome === undefined);
    if (live !== undefined) {
      throw new DagError(
        "RUN_IN_PROGRESS",
        `a run for this project is already in progress (run ${live.runId})`,
      );
    }
    const pid =
      typeof input.pid === "number" && Number.isInteger(input.pid) && input.pid > 0
        ? input.pid
        : undefined;
    const claim: RunRecord = {
      runId: input.runId,
      startedAt: Date.now(),
      deadlineAt: input.deadlineAt,
      runtimeType: input.runtimeType,
      runner: input.runner,
      logSegment: input.logSegment,
      ...(pid !== undefined && { pid }),
      ...(input.continueSessionId !== undefined &&
        input.continueSessionId !== "" && {
          continueSessionId: input.continueSessionId,
        }),
    };
    runs.push(claim);
    await writeRunsIndex(projectDir, runs);
    return claim;
  });
}

/** Records the child's pid on the claim AFTER the spawn produced one. No-op
 *  when the claim is already gone (the run settled in the gap) — a pid write
 *  must never resurrect a settled run. */
export async function updateRunPid(
  projectDir: string,
  input: { runId: string; pid: number },
): Promise<void> {
  await ensureDir(join(projectDir, "runs"));
  await withLock(runStoreLockPath(projectDir), async () => {
    const runs = await readRunsIndex(projectDir);
    const claim = runs.find((run) => run.runId === input.runId);
    if (claim === undefined || claim.outcome !== undefined) return;
    claim.pid = input.pid;
    await writeRunsIndex(projectDir, runs);
  });
}

export interface SettleRunInput {
  /** Settles only when it matches the persisted claim — a run that has already
   *  settled (or was superseded) is never settled twice. */
  runId: string;
  outcome: RunOutcome;
  error?: string;
  /** Epoch ms the run ended — defaults to now. */
  endedAt?: number;
  replyChars?: number;
  /** The runtime-native session id the fold harvested — the continuation handle. */
  runtimeSessionId?: string;
  /** Typed failure code the client can act on (CONTINUATION_LOST, …). */
  errorCode?: string;
  eventLogTruncated?: boolean;
}

/**
 * Stamps the outcome onto the run's claim in ONE lock acquisition — the same
 * write that releases the claim, so "claim gone" and "outcome readable" can
 * never disagree (the stream's end frame depends on that).
 *
 * Keyed on the run id: a settle whose run has already settled (a cancel that
 * won the race, or a newer claim) is a byte-identical no-op.
 */
export async function settleRun(
  projectDir: string,
  input: SettleRunInput,
): Promise<RunRecord | undefined> {
  await ensureDir(join(projectDir, "runs"));
  return withLock(runStoreLockPath(projectDir), async () => {
    const runs = await readRunsIndex(projectDir);
    const claim = runs.find((run) => run.runId === input.runId);
    if (claim === undefined || claim.outcome !== undefined) return claim;
    claim.outcome = input.outcome;
    claim.endedAt = input.endedAt ?? Date.now();
    if (input.error !== undefined) claim.error = input.error;
    if (input.replyChars !== undefined) claim.replyChars = input.replyChars;
    if (input.runtimeSessionId !== undefined) claim.runtimeSessionId = input.runtimeSessionId;
    if (input.errorCode !== undefined) claim.errorCode = input.errorCode;
    // Only ever written `true` (the runner omits the flag otherwise), so its
    // absence on a settled record means the log is whole.
    if (input.eventLogTruncated === true) claim.eventLogTruncated = true;
    await writeRunsIndex(projectDir, runs);
    return claim;
  });
}

/** One run record, or `undefined` when the index does not list the run id. */
export async function getRun(projectDir: string, runId: string): Promise<RunRecord | undefined> {
  const runs = await readRunsIndex(projectDir);
  return runs.find((run) => run.runId === runId);
}

// ---------------------------------------------------------------------------
// Revert state
// ---------------------------------------------------------------------------

/**
 * Stamps the run's workspace changes as reverted (POST /revert), once.
 *
 * Refuses with `RUN_ALREADY_REVERTED` (409 on the wire) when the run has
 * already been reverted, `RUN_NOT_FOUND` when the run is not in the index, and
 * `RUN_NOT_SETTLED` while the run is still live — a claim in flight may still
 * be writing, so its changes are not final and must not be reverted.
 * Under the same lock every other mutation uses, so a second revert racing
 * the first can never both win.
 */
export async function markRunReverted(projectDir: string, runId: string): Promise<RunRecord> {
  await ensureDir(join(projectDir, "runs"));
  return withLock(runStoreLockPath(projectDir), async () => {
    const runs = await readRunsIndex(projectDir);
    const claim = runs.find((run) => run.runId === runId);
    if (claim === undefined) {
      throw new DagError("RUN_NOT_FOUND", `no run "${runId}" on this project`);
    }
    if (claim.outcome === undefined) {
      throw new DagError(
        "RUN_NOT_SETTLED",
        `run "${runId}" is still live — only a settled run's changes can be reverted`,
      );
    }
    if (claim.revertedAt !== undefined) {
      throw new DagError(
        "RUN_ALREADY_REVERTED",
        `the changes of run "${runId}" were already reverted`,
      );
    }
    claim.revertedAt = Date.now();
    await writeRunsIndex(projectDir, runs);
    return claim;
  });
}

/** The project's current in-flight run claim, or `undefined`. */
export async function liveRun(projectDir: string): Promise<RunRecord | undefined> {
  const runs = await readRunsIndex(projectDir);
  return runs.find((run) => run.outcome === undefined);
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/**
 * Whether a pid is a live process, via signal 0 (no signal delivered).
 *
 * SHORTCUT: pids are reused, so a recycled pid reads alive and keeps an orphan
 * claim standing; upgrade to a start-time check (`/proc/<pid>/stat` field 22 or
 * `ps -o lstart`) when a stuck claim is ever actually observed.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — alive.
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// Startup sweep
// ---------------------------------------------------------------------------

export interface SweepOptions {
  /** Injectable pid liveness (tests). */
  isAlive?: (pid: number) => boolean;
  /** Clock in epoch ms; defaults to `Date.now()`. */
  now?: number;
}

function orphanError(pid: number | undefined): string {
  return pid === undefined
    ? "run was interrupted: no pid was recorded for it, so nothing could report how it ended"
    : `run was interrupted: its process (pid ${pid}) is gone and never reported an outcome`;
}

/**
 * Settles every run claim in a project whose process is gone AND whose
 * deadline has passed, as `interrupted`.
 *
 * A claim only stands while its pid is still alive within its own deadline — a
 * run spawned by a previous server process either outlived the restart (leave
 * it be; it still holds the project's slot) or died with it, and a dead claim
 * that is never cleared is a project stuck on "a run is in progress" forever.
 * The deadline condition is what keeps a claim whose child merely outlived a
 * crash from being settled out from under a live process.
 *
 * A settle here also prunes the project's run event logs, exactly as the
 * route's own write-back does — this is the ONLY settle an interrupted run
 * ever gets, so it is the only place that can bound the logs of a project
 * whose runs never settle normally.
 *
 * Never throws: a project whose index cannot be read is skipped, and a record
 * deleted mid-sweep is simply not settled.
 */
export async function settleOrphanedRuns(
  projectDir: string,
  options: SweepOptions = {},
): Promise<RunRecord[]> {
  const alive = options.isAlive ?? isProcessAlive;
  const now = options.now ?? Date.now();
  const runs = await readRunsIndex(projectDir);
  const settled: RunRecord[] = [];
  for (const claim of runs) {
    if (claim.outcome !== undefined) continue;
    if (typeof claim.pid === "number" && alive(claim.pid)) continue;
    // The pid is dead (or was never recorded) — settle only once the run's own
    // deadline has passed. A non-finite/missing deadline is treated as passed:
    // every claim this store writes carries one, so anything else un-wedges.
    const deadlineAt = claim.deadlineAt;
    if (typeof deadlineAt === "number" && Number.isFinite(deadlineAt) && deadlineAt > now) {
      continue;
    }

    const settledClaim = await settleRun(projectDir, {
      runId: claim.runId,
      outcome: "interrupted",
      error: orphanError(claim.pid),
      endedAt: now,
    });
    if (settledClaim !== undefined) settled.push(settledClaim);
    // Retention belongs to every settle, and this is the one settle path that
    // is not a run's own write-back. A server that dies mid-run never reaches
    // the route's prune, so a project whose runs are always interrupted would
    // otherwise accumulate one RUN_EVENT_LOG_MAX_BYTES log per run forever.
    try {
      await pruneRunEventLogs(projectDir, claim.logSegment, RUN_LOG_RETENTION_KEEP);
    } catch {
      // Pruning never throws; this catch is defensive only.
    }
  }
  return settled;
}

/** The log-retention budget the sweep prunes to after an interrupted settle.
 *  Mirrors run-event-log's default, stated here so the sweep cannot drift. */
const RUN_LOG_RETENTION_KEEP = 5;

/**
 * Startup sweep across every registered project, keyed by RUN. Composition-time
 * work (app.ts calls it once, fire-and-forget) — one pass, never a poller.
 *
 * Never throws — a data dir without a readable meta.json settles nothing,
 * rather than taking the server down at boot.
 */
export async function settleOrphanedRunsOnStartup(
  dataDir: string = getDataDir(),
  options: SweepOptions = {},
): Promise<RunRecord[]> {
  let slugs: string[];
  try {
    slugs = (await readRootMeta(dataDir)).projects.map((project) => project.id);
  } catch {
    return [];
  }

  const settled: RunRecord[] = [];
  for (const slug of slugs) {
    settled.push(...(await settleOrphanedRuns(resolve(dataDir, "projects", slug), options)));
  }
  return settled;
}
