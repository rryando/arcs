/**
 * Headless `claude -p` run lifecycle (T001 of the session-panel async-runs plan).
 *
 * Owns everything between "the web route decided to run a job" and a finished
 * run record: spawn, output capture with caps, timeout escalation, `--output-
 * format json` parsing, exit mapping, per-write-target concurrency serialization
 * and ARCS_HOOK_* env scrubbing. The module is argv-agnostic — the calling route
 * supplies argv/cwd; this module never decides what the child does. The route's
 * post-run write-back (transcript mirror + metadata.run finalization) plugs in
 * as the per-job `onSettled` callback, invoked after the child fully exits.
 *
 * Injectable `spawnImpl` + `binary` keep tests free of real children; the
 * default impl is plain node child_process `spawn` with `stdio:
 * ["ignore","pipe","pipe"]`. Every child-side failure resolves to an outcome
 * record — this module never throws on spawn/exit/timeout paths.
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";

export type RunOutcome = "success" | "error" | "timeout";

export interface ClaudeRunRecord {
  pid: number | null;
  startedAt: number;
  endedAt?: number;
  outcome: RunOutcome;
  error?: string;
  replyText?: string;
  replyChars?: number;
}

export interface ClaudeJobInput {
  /** Full argv for the child, e.g. ["-p", "…", "--output-format", "json"]. */
  argv: string[];
  /** Working directory for the child; defaults to the server's cwd. */
  cwd?: string;
  /** Timeout override; defaults to ARCS_CLAUDE_RUN_TIMEOUT_MS then 10 min. */
  timeoutMs?: number;
  /**
   * Key serializing runs that write to the same target — a second live run for
   * the same key is refused (see beginRun).
   */
  writeTargetKey: string;
  /** Base env for the child (defaults to process.env) minus the ARCS_HOOK_*
   *  handshake keys (ARCS_HOOK_TOKEN, ARCS_HOOK_SLUG, ARCS_HOOK_URL). */
  env?: NodeJS.ProcessEnv;
  /**
   * Post-run write-back invoked with the settled record after the child has
   * fully exited (`close` fired, stdio drained) — on every path that yields a
   * record: success, error, timeout, even a refused overlap. The calling route
   * registers this to mirror the resumed session's transcript and finalize
   * metadata.run (mode-1 write-back); the runner itself stays argv-agnostic and
   * never decides what the callback does. Errors thrown by the callback are
   * swallowed — the write-back is best-effort and must never change the record
   * the runner returns.
   */
  onSettled?: (record: ClaudeRunRecord) => void | Promise<void>;
}

/** Minimal spawn surface so tests can inject a fake without a real child. */
export type SpawnImpl = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface ClaudeRunnerOptions {
  /** Overrides `spawn` (tests). */
  spawnImpl?: SpawnImpl;
  /** Binary name to spawn (tests); default "claude". */
  binary?: string;
  /** SIGTERM → SIGKILL grace period; default 5s. */
  killGraceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_KILL_GRACE_MS = 5_000;
export const STDOUT_CAP = 1024 * 1024; // 1 MB
export const STDERR_CAP = 4 * 1024; // 4 KB

/** Keys never forwarded to the child env — the hook handshake must not leak. */
const ENV_SCRUB_KEYS = ["ARCS_HOOK_TOKEN", "ARCS_HOOK_SLUG", "ARCS_HOOK_URL"];

// ---------------------------------------------------------------------------
// Concurrency — one live run per write-target key
// ---------------------------------------------------------------------------

export type BeginRunResult =
  | { ok: true; startedAt: number }
  | { ok: false; reason: "ALREADY_RUNNING"; message: string };

interface LiveRun {
  child: ChildProcess;
  startedAt: number;
}

/** writeTargetKey → live child. Module-level: shared across all web routes. */
const liveRuns = new Map<string, LiveRun>();

/**
 * Atomically claims the slot for a write-target key. Returns a typed refusal
 * when a live run already holds it. Synchronous and called immediately after
 * spawn (no await in between), so two overlapping requests cannot both win.
 */
export function beginRun(writeTargetKey: string, child: ChildProcess): BeginRunResult {
  if (liveRuns.has(writeTargetKey)) {
    return {
      ok: false,
      reason: "ALREADY_RUNNING",
      message: `a claude run for "${writeTargetKey}" is already in progress`,
    };
  }
  const startedAt = Date.now();
  liveRuns.set(writeTargetKey, { child, startedAt });
  return { ok: true, startedAt };
}

/** Releases the slot for a write-target key (idempotent). */
export function endRun(writeTargetKey: string): void {
  liveRuns.delete(writeTargetKey);
}

/** Read-only liveness probe for the same slot (routes / UI status). */
export function isRunLive(writeTargetKey: string): boolean {
  return liveRuns.has(writeTargetKey);
}

// ---------------------------------------------------------------------------
// runClaudeJob
// ---------------------------------------------------------------------------

export async function runClaudeJob(
  input: ClaudeJobInput,
  options: ClaudeRunnerOptions = {},
): Promise<ClaudeRunRecord> {
  const { argv, cwd, writeTargetKey } = input;
  const spawnImpl = options.spawnImpl ?? spawn;
  const binary = options.binary ?? "claude";
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const env = input.env ?? process.env;
  const timeoutMs = resolveTimeoutMs(input.timeoutMs, env);
  const startedAt = Date.now();

  const fail = (outcome: RunOutcome, error: string): ClaudeRunRecord => ({
    pid: null,
    startedAt,
    endedAt: Date.now(),
    outcome,
    error,
  });

  let child: ChildProcess;
  try {
    child = spawnImpl(binary, argv, { cwd, env: scrubEnv(env), stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    // Some spawn failures surface synchronously (fake impls, odd platforms).
    return writeBack(input, fail("error", spawnErrorMessage(err, binary)));
  }

  const begin = beginRun(writeTargetKey, child);
  if (!begin.ok) {
    // A live run holds the slot — drop the freshly spawned child immediately.
    // Attach a no-op error listener first: the refused child has no other
    // listeners, so a spawn failure surfacing on it would otherwise crash.
    child.on("error", () => {});
    safeKill(child, "SIGKILL");
    return writeBack(input, fail("error", begin.message));
  }

  const record: ClaudeRunRecord = { pid: child.pid ?? null, startedAt, outcome: "success" };
  try {
    const settled = await settleRun(child, { timeoutMs, killGraceMs, binary });
    record.endedAt = settled.endedAt;
    record.outcome = settled.outcome;
    if (settled.error !== undefined) record.error = settled.error;
    if (settled.replyText !== undefined) {
      record.replyText = settled.replyText;
      record.replyChars = settled.replyText.length;
    }
  } catch (err) {
    // Never throw on child-side failures — every path resolves to a record.
    record.outcome = "error";
    record.error = `runner failed: ${String(err)}`;
  } finally {
    endRun(writeTargetKey);
  }
  return writeBack(input, record);
}

/**
 * Fires the route-registered write-back (onSettled) against the settled record.
 * Runs after endRun so the concurrency slot frees before the write-back's store
 * work begins. Every record-producing path funnels through here — including
 * sync spawn failures and refused overlaps — so the route can mirror the
 * runtime transcript and finalize metadata.run regardless of outcome. Callback
 * errors are swallowed: the write-back is best-effort and never changes the
 * returned record.
 */
async function writeBack(input: ClaudeJobInput, record: ClaudeRunRecord): Promise<ClaudeRunRecord> {
  if (input.onSettled === undefined) return record;
  try {
    await input.onSettled(record);
  } catch {
    // Write-back failure is a swallowed no-op — the run itself already settled.
  }
  return record;
}

// ---------------------------------------------------------------------------
// Spawn / capture / timeout / parse internals
// ---------------------------------------------------------------------------

interface SettleContext {
  timeoutMs: number;
  killGraceMs: number;
  binary: string;
}

interface SettleResult {
  endedAt: number;
  outcome: RunOutcome;
  error?: string;
  replyText?: string;
}

function settleRun(child: ChildProcess, ctx: SettleContext): Promise<SettleResult> {
  return new Promise<SettleResult>((resolve) => {
    const stdout = makeTailBuffer(STDOUT_CAP);
    const stderr = makeTailBuffer(STDERR_CAP);
    let settled = false;
    let timedOut = false;
    let termTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const clearTimers = (): void => {
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      termTimer = null;
      killTimer = null;
    };

    const settle = (result: SettleResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      resolve(result);
    };

    termTimer = setTimeout(() => {
      timedOut = true;
      safeKill(child, "SIGTERM");
      killTimer = setTimeout(() => {
        safeKill(child, "SIGKILL");
      }, ctx.killGraceMs);
    }, ctx.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => stdout.push(String(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(String(chunk)));

    child.on("error", (err: Error) => {
      settle({
        endedAt: Date.now(),
        outcome: "error",
        error: spawnErrorMessage(err, ctx.binary),
      });
    });

    // Resolve on `close` (after stdio drained) rather than `exit` so the caps
    // see the complete output. `close` also fires after a failed spawn.
    child.on("close", (code, signal) => {
      settle(
        mapExit({
          code,
          signal: signal ?? null,
          timedOut,
          stdout,
          stderr,
          timeoutMs: ctx.timeoutMs,
        }),
      );
    });
  });
}

function mapExit(input: {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: TailBuffer;
  stderr: TailBuffer;
  timeoutMs: number;
}): SettleResult {
  const endedAt = Date.now();

  if (input.timedOut) {
    return {
      endedAt,
      outcome: "timeout",
      error: `claude run timed out after ${input.timeoutMs}ms (SIGTERM, then SIGKILL)`,
    };
  }

  if (input.code === 0) {
    const parsed = parseClaudeJson(input.stdout.text());
    if (parsed) {
      if (parsed.is_error) {
        return {
          endedAt,
          outcome: "error",
          error: parsed.result?.trim() || "claude reported an error (is_error)",
        };
      }
      // `result` is optional — fall back to the trimmed raw stdout when absent.
      const replyText =
        typeof parsed.result === "string" ? parsed.result : input.stdout.text().trim();
      return { endedAt, outcome: "success", replyText };
    }
    // Unparsable stdout on exit 0 — treat the trimmed raw stdout as the reply.
    return { endedAt, outcome: "success", replyText: input.stdout.text().trim() };
  }

  if (input.signal) {
    return {
      endedAt,
      outcome: "error",
      error: `claude run was terminated by signal ${input.signal}`,
    };
  }

  const stderrTail = input.stderr.text().trim();
  return {
    endedAt,
    outcome: "error",
    error: stderrTail || `claude exited with status ${input.code}`,
  };
}

interface ClaudeJsonOutput {
  is_error?: boolean;
  result?: string;
}

/**
 * Parses `claude --output-format json` stdout. Returns null when the output is
 * not a JSON object carrying the is_error/result envelope, so the caller can
 * fall back to raw stdout. Never throws.
 */
function parseClaudeJson(stdout: string): ClaudeJsonOutput | null {
  const text = stdout.trim();
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as ClaudeJsonOutput;
  if (typeof candidate.is_error !== "boolean" && typeof candidate.result !== "string") {
    return null;
  }
  return candidate;
}

function resolveTimeoutMs(timeoutMs: number | undefined, env: NodeJS.ProcessEnv): number {
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }
  const raw = env.ARCS_CLAUDE_RUN_TIMEOUT_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

/** process.env minus the ARCS_HOOK_* handshake keys (the explicit 3-key
 *  denylist above — not a prefix wildcard scrub). */
function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (ENV_SCRUB_KEYS.includes(key)) continue;
    childEnv[key] = value;
  }
  return childEnv;
}

function spawnErrorMessage(err: unknown, binary: string): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return "claude not found on PATH";
  return `failed to spawn ${binary}: ${String(err)}`;
}

function safeKill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Child already exited — nothing to signal.
  }
}

// ---------------------------------------------------------------------------
// Tail-capped capture buffer
// ---------------------------------------------------------------------------

interface TailBuffer {
  push(chunk: string): void;
  text(): string;
}

/**
 * Accumulates output keeping only the most recent `limit` characters, dropping
 * overflow from the head. Used so a runaway child cannot balloon memory while
 * the important (tail) output survives.
 *
 * SHORTCUT: caps count UTF-16 code units, not bytes; upgrade to
 * Buffer.byteLength accounting when non-ASCII payloads sit at the cap boundary.
 */
function makeTailBuffer(limit: number): TailBuffer {
  const chunks: string[] = [];
  let size = 0;
  return {
    push(chunk: string): void {
      if (chunk.length === 0) return;
      chunks.push(chunk);
      size += chunk.length;
      while (size > limit && chunks.length > 1) {
        size -= chunks[0].length;
        chunks.shift();
      }
      if (size > limit) {
        // Single chunk larger than the cap — keep its tail.
        const overflow = size - limit;
        chunks[0] = chunks[0].slice(overflow);
        size -= overflow;
      }
    },
    text(): string {
      return chunks.join("");
    },
  };
}
