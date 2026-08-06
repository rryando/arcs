/**
 * Session liveness reconciliation — the world's opinion on top of the store's.
 *
 * `deriveSessionPhase` (session-store) answers "what does this record claim" from
 * persisted evidence alone. This module answers "is that still true", using the
 * two liveness sources that exist outside the DAG:
 *
 *  - a run claim's pid, probed with signal 0. ARCS-driven runs are headless
 *    `claude -p` children ARCS spawned itself, so their liveness is a local
 *    process fact — and the persisted pid is what makes it readable from a
 *    server process that did not spawn them.
 *  - `claude agents --json`, which lists the live interactive/background
 *    sessions a terminal is driving. That is the only way to tell a session ARCS
 *    merely observes from one whose terminal has since been closed.
 *
 * Two shapes of work, deliberately separated:
 *
 *  - `settleOrphanedRuns` WRITES: a claim whose process is gone settles as
 *    outcome `interrupted` and the claim is cleared. Runs once at startup (see
 *    app.ts), because a claim persisted by a previous process can never be live
 *    in this one unless its child outlived the restart.
 *  - `reconcileSessionPhases` READS: it returns demoted phases and never writes.
 *    On-demand only — there is no timer here, and no poller.
 *
 * Everything that touches the outside world is tolerant by construction: the
 * probe is a subprocess of a binary that may not exist, running a command whose
 * output shape is claude's to change. A missing binary, a non-zero exit, an
 * empty stdout or unparsable JSON all degrade to the store-derived phase and
 * NEVER throw — a reconciler that can fail would take the sessions UI down with
 * every claude release.
 */

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { readRootMeta } from "../utils/dag.js";
import { getDataDir } from "../utils/paths.js";
import {
  deriveSessionPhase,
  listSessions,
  type SessionMeta,
  type SessionPhase,
  sessionRunClaim,
  settleSessionRun,
} from "../utils/session-store.js";
import { normalizeIdentifier } from "../utils/slug.js";

// ---------------------------------------------------------------------------
// `claude agents --json`
// ---------------------------------------------------------------------------

/**
 * One live agent as reported by `claude agents --json` (verified on claude
 * 2.1.223: live interactive and background sessions, `{pid, cwd, sessionId,
 * name, state|status}`). Every field is optional because the wire shape belongs
 * to claude — a release that renames one must degrade this module, not break it.
 */
export interface LiveAgent {
  pid?: number;
  cwd?: string;
  sessionId?: string;
  name?: string;
  /** `status`, falling back to `state` — reported, never branched on. */
  status?: string;
}

/** Raw probe result: `ok:false` covers missing binary, non-zero exit, timeout. */
export type AgentsProbeResult = { ok: true; stdout: string } | { ok: false };
export type AgentsProbe = () => Promise<AgentsProbeResult>;

const AGENTS_PROBE_TIMEOUT_MS = 5_000;
const AGENTS_PROBE_MAX_BUFFER = 4 * 1024 * 1024;

/** Keys an `agents --json` payload might wrap its array in. */
const AGENT_LIST_KEYS = ["agents", "sessions", "data", "items"];

function defaultAgentsProbe(): Promise<AgentsProbeResult> {
  return new Promise<AgentsProbeResult>((resolveProbe) => {
    try {
      execFile(
        "claude",
        ["agents", "--json"],
        {
          timeout: AGENTS_PROBE_TIMEOUT_MS,
          maxBuffer: AGENTS_PROBE_MAX_BUFFER,
          encoding: "utf-8",
        },
        (error, stdout) => {
          // ENOENT (no binary), a non-zero exit and the timeout kill all arrive
          // here as an error — none of them is a usable answer, and none of
          // them is fatal.
          if (error) resolveProbe({ ok: false });
          else resolveProbe({ ok: true, stdout: String(stdout) });
        },
      );
    } catch {
      // Some spawn failures surface synchronously depending on platform.
      resolveProbe({ ok: false });
    }
  });
}

function readString(node: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = node[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function readPid(node: Record<string, unknown>): number | undefined {
  const value = node.pid;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  // Tolerated: some CLIs stringify pids.
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

/** The array of rows inside a payload, or `null` when there is no usable one. */
function agentRows(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null) return null;
  const node = value as Record<string, unknown>;
  for (const key of AGENT_LIST_KEYS) {
    if (Array.isArray(node[key])) return node[key] as unknown[];
  }
  return null;
}

function toLiveAgent(row: unknown): LiveAgent | undefined {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
  const node = row as Record<string, unknown>;
  const pid = readPid(node);
  const sessionId = readString(node, "sessionId", "session_id");
  // A row that identifies neither a process nor a session cannot answer a
  // liveness question, so it is dropped rather than counted as an agent.
  if (pid === undefined && sessionId === undefined) return undefined;
  const cwd = readString(node, "cwd", "directory");
  const name = readString(node, "name");
  const status = readString(node, "status", "state");
  return {
    ...(pid !== undefined && { pid }),
    ...(cwd !== undefined && { cwd }),
    ...(sessionId !== undefined && { sessionId }),
    ...(name !== undefined && { name }),
    ...(status !== undefined && { status }),
  };
}

/**
 * Parses `claude agents --json` stdout into live agents.
 *
 * `null` means "the probe answered nothing usable" (empty output, non-JSON, a
 * JSON shape carrying no array) and is NOT the same as `[]`, which means "the
 * probe worked and no agent is live". Only the second may demote a session:
 * conflating them would mark every observed session idle the day claude changes
 * its output.
 */
export function parseLiveAgents(stdout: string): LiveAgent[] | null {
  const text = stdout.trim();
  if (text === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const rows = agentRows(value);
  if (rows === null) return null;
  const agents: LiveAgent[] = [];
  for (const row of rows) {
    const agent = toLiveAgent(row);
    if (agent !== undefined) agents.push(agent);
  }
  return agents;
}

/**
 * Runs the probe and parses it. `null` on every degraded path — missing binary,
 * non-zero exit, timeout, unparsable output, or a probe that threw.
 */
export async function listLiveClaudeAgents(
  options: { probe?: AgentsProbe } = {},
): Promise<LiveAgent[] | null> {
  const probe = options.probe ?? defaultAgentsProbe;
  let result: AgentsProbeResult;
  try {
    result = await probe();
  } catch {
    return null;
  }
  if (!result.ok) return null;
  return parseLiveAgents(result.stdout);
}

// ---------------------------------------------------------------------------
// Process liveness
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
// Phase reconciliation (read-only)
// ---------------------------------------------------------------------------

export interface ReconcileOptions {
  /** Injectable `claude agents --json` probe (tests). */
  probe?: AgentsProbe;
  /** Injectable pid liveness (tests). */
  isAlive?: (pid: number) => boolean;
  /** Clock in epoch ms; defaults to `Date.now()`. */
  now?: number;
}

export interface SessionPhaseView {
  sessionId: string;
  phase: SessionPhase;
}

/** Does this agent report the session behind this record? */
function agentMatchesSession(session: SessionMeta, agent: LiveAgent): boolean {
  const reported = agent.sessionId;
  if (reported === undefined) return false;
  if (reported === session.runtimeSessionId) return true;
  if (normalizeIdentifier(reported) === session.normalizedId) return true;
  // An ARCS thread runs under its own claude-facing uuid, which is what the
  // agent list reports — the ARCS thread id never reaches claude.
  const claudeSessionId = session.metadata?.claudeSessionId;
  return typeof claudeSessionId === "string" && reported === claudeSessionId;
}

/**
 * The store-derived phase, demoted when the world disagrees.
 *
 * Demotion is one-way: this can turn `running` into `idle`, never the reverse.
 * Nothing outside the record may promote a session — the DAG stays the source
 * of truth and the probe is only ever allowed to take evidence away.
 *
 * Which evidence applies depends on what the record claims, not on its origin:
 *  - a run claim is checked against its pid. `claude agents` never lists a
 *    headless `claude -p` child, so asking it about an ARCS run would demote
 *    every healthy run.
 *  - everything else is checked against the agent list. `agents === null` (the
 *    probe degraded) leaves the `lastCheckpointAt`-derived phase untouched.
 */
export function reconcilePhase(
  session: SessionMeta,
  agents: LiveAgent[] | null,
  options: ReconcileOptions = {},
): SessionPhase {
  const derived = deriveSessionPhase(session, { now: options.now });
  if (derived !== "running") return derived;

  if (sessionRunClaim(session) !== undefined) {
    const pid = session.currentRunPid;
    // No pid to probe (the spawn produced none) — the heartbeat stands alone.
    if (typeof pid !== "number") return derived;
    return (options.isAlive ?? isProcessAlive)(pid) ? "running" : "idle";
  }

  if (agents === null) return derived;
  return agents.some((agent) => agentMatchesSession(session, agent)) ? "running" : "idle";
}

/**
 * Whether this record's phase can depend on the agent list at all.
 *
 * Exactly the one branch of `reconcilePhase` that reads `agents`: a derived
 * `running` with no run claim. Everything else — terminal, idle, or claimed —
 * answers from the record alone and never looks at the list.
 */
function needsAgentList(session: SessionMeta, now: number | undefined): boolean {
  return (
    deriveSessionPhase(session, { now }) === "running" && sessionRunClaim(session) === undefined
  );
}

/**
 * Reconciled phase for every session in a project. Read-only: no writes, no
 * timer, and at most ONE `claude agents --json` for the whole index — never one
 * per session.
 *
 * The probe is LAZY: `claude agents --json` costs ~0.35s of wall clock and a
 * whole subprocess, and its answer is read at a single branch of
 * `reconcilePhase`. Every terminal record, every idle one and every ARCS run
 * holding a claim decides without it, so a probe fired before the phases are
 * derived is a subprocess whose result is thrown away — on EVERY sessions
 * request, list and detail alike, at whatever rate the watcher invalidates the
 * query. So the derivation runs first and the probe only follows when some
 * record actually reaches that branch.
 *
 * Skipping it passes `null` — the same value a degraded probe yields, and the
 * value no session left in this pass can read: reaching the `agents` branch is
 * precisely the condition that would have run the probe.
 */
export async function reconcileSessionPhases(
  projectDir: string,
  options: ReconcileOptions = {},
): Promise<SessionPhaseView[]> {
  const sessions = await listSessions(projectDir);
  // One clock for both passes, so the derivation that decides whether to probe
  // is the same one reconcilePhase answers from.
  const now = options.now ?? Date.now();
  const scoped: ReconcileOptions = { ...options, now };
  const agents = sessions.some((session) => needsAgentList(session, now))
    ? await listLiveClaudeAgents({ probe: options.probe })
    : null;
  return sessions.map((session) => ({
    sessionId: session.normalizedId,
    phase: reconcilePhase(session, agents, scoped),
  }));
}

// ---------------------------------------------------------------------------
// Orphan settling (startup, writes)
// ---------------------------------------------------------------------------

export interface SettledOrphan {
  sessionId: string;
  runId: string;
  pid?: number;
}

function orphanError(pid: number | undefined): string {
  return pid === undefined
    ? "run was interrupted: no pid was recorded for it, so nothing could report how it ended"
    : `run was interrupted: its process (pid ${pid}) is gone and never reported an outcome`;
}

/**
 * Settles every run claim in a project whose process is gone.
 *
 * A claim only survives when its pid is still alive — a run spawned by a
 * previous server process either outlived the restart (leave it be; it still
 * holds the write-target) or died with it, and a dead claim that is never
 * cleared is a session stuck on `running` for good. The settled run keeps
 * whatever `metadata.run` already held and gains `outcome: "interrupted"`,
 * which no live run can ever produce.
 *
 * Never throws: a project whose index cannot be read is skipped, and a record
 * deleted mid-sweep is simply not settled.
 */
export async function settleOrphanedRuns(
  projectDir: string,
  options: ReconcileOptions = {},
): Promise<SettledOrphan[]> {
  const alive = options.isAlive ?? isProcessAlive;
  let sessions: SessionMeta[];
  try {
    sessions = await listSessions(projectDir);
  } catch {
    return [];
  }

  const settled: SettledOrphan[] = [];
  for (const session of sessions) {
    const runId = sessionRunClaim(session);
    if (runId === undefined) continue;
    const pid = typeof session.currentRunPid === "number" ? session.currentRunPid : undefined;
    if (pid !== undefined && alive(pid)) continue;

    try {
      await settleSessionRun(projectDir, session.normalizedId, {
        runId,
        outcome: "interrupted",
        error: orphanError(pid),
        endedAt: options.now,
      });
      settled.push({ sessionId: session.normalizedId, runId, ...(pid !== undefined && { pid }) });
    } catch {
      // Record vanished between the read and the settle — nothing to settle.
    }
  }
  return settled;
}

/**
 * Startup sweep across every registered project.
 *
 * Composition-time work (app.ts calls it once, fire-and-forget) but the logic
 * lives here. One pass, no timer: liveness questions after startup are answered
 * on demand by `reconcileSessionPhases`.
 *
 * Never throws — a data dir without a readable meta.json settles nothing and
 * reports it, rather than taking the server down at boot.
 */
export async function settleOrphanedRunsOnStartup(
  dataDir: string = getDataDir(),
  options: ReconcileOptions = {},
): Promise<SettledOrphan[]> {
  let slugs: string[];
  try {
    slugs = (await readRootMeta(dataDir)).projects.map((project) => project.id);
  } catch {
    return [];
  }

  const settled: SettledOrphan[] = [];
  for (const slug of slugs) {
    settled.push(...(await settleOrphanedRuns(resolve(dataDir, "projects", slug), options)));
  }
  return settled;
}
