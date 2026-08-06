/**
 * Headless `claude -p` run lifecycle (T001 of the session-panel async-runs plan).
 *
 * Owns everything between "the web route decided to run a job" and a finished
 * run record: spawn, streaming stdout capture, timeout escalation, NDJSON event
 * parsing, exit mapping, per-write-target concurrency serialization and
 * ARCS_HOOK_* env scrubbing. The route supplies argv/cwd and this module never
 * decides what the child *does* — but it does own the child's OUTPUT CONTRACT:
 * every run is normalized onto `--output-format stream-json
 * --include-partial-messages --verbose` (see withStreamJsonArgv), so stdout is
 * always the newline-delimited event stream the reader below understands. The
 * route's post-run write-back (transcript mirror + metadata.run finalization)
 * plugs in as the per-job `onSettled` callback, invoked after the child exits.
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
  /**
   * Epoch ms (Date.now(), same unit as startedAt/endedAt — never an ISO string)
   * of the first assistant content seen on the event stream: time-to-first-token
   * is `firstTokenAt - startedAt`. Absent when the run produced no content
   * (spawn failure, refused overlap, a timeout before the model spoke).
   */
  firstTokenAt?: number;
  /**
   * Count of stdout lines the NDJSON reader could not use — unparsable JSON,
   * non-object JSON, or an unknown event type. Omitted when zero. A nonzero
   * count on an otherwise successful run is the wire-format drift signal: the
   * run still settles normally, the number says the reader fell behind claude.
   */
  skippedLines?: number;
}

export interface ClaudeJobInput {
  /**
   * Argv for the child, e.g. ["-p", "…", "--resume", "<id>"]. Any caller-supplied
   * output-format flags are rewritten by withStreamJsonArgv — the runner owns
   * that part of the contract because it owns the reader.
   */
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
/**
 * Bound on the *raw* stdout tail kept as the last-resort reply for a child that
 * emits no usable events. It no longer truncates real replies — those are
 * assembled from whole event lines as they arrive.
 */
export const STDOUT_CAP = 1024 * 1024; // 1 MB
export const STDERR_CAP = 4 * 1024; // 4 KB
/**
 * Ceiling on a single *unterminated* line the NDJSON reader will buffer — a
 * memory guard against a child that never emits a newline, not a reply cap. It
 * sits well above any single claude event (one message cannot approach 8 MB), so
 * a long reply split across chunks still reassembles whole.
 */
export const MAX_EVENT_LINE = 8 * STDOUT_CAP; // 8 MB

/**
 * Output contract the runner forces onto every child. `--include-partial-messages`
 * is what makes first-token timing observable at all, and claude >= 2.x refuses
 * both companions in print mode: "--include-partial-messages requires --print and
 * --output-format=stream-json" and "When using --print, --output-format=stream-json
 * requires --verbose" — both exit 1 at flag validation, before any network call.
 * The three therefore travel together and are never split.
 */
const STREAM_JSON_ARGV = [
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
];

/** Keys never forwarded to the child env — the hook handshake must not leak. */
const ENV_SCRUB_KEYS = ["ARCS_HOOK_TOKEN", "ARCS_HOOK_SLUG", "ARCS_HOOK_URL"];

/**
 * Rewrites caller argv onto the runner's output contract: drops any
 * `--output-format <v>` / `--output-format=<v>` the caller chose (routes still
 * build plain `--output-format json`) plus any duplicate stream companions, then
 * appends STREAM_JSON_ARGV. Everything else — `-p`, the prompt, `--resume`,
 * `--session-id` — passes through untouched and in order.
 */
export function withStreamJsonArgv(argv: string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output-format") {
      i += 1; // drop the flag together with its value
      continue;
    }
    if (arg.startsWith("--output-format=")) continue;
    if (arg === "--include-partial-messages" || arg === "--verbose") continue;
    rest.push(arg);
  }
  return [...rest, ...STREAM_JSON_ARGV];
}

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

/**
 * Pid of the child currently holding a write-target's slot.
 *
 * `undefined` means no live run (the spawn threw, or the slot was refused);
 * `null` means a live run whose child never reported a pid (an async spawn
 * failure — node reports ENOENT on the `error` event, not at spawn).
 *
 * Exists so the run route can persist the child's pid on the session's run
 * claim: `runClaudeJob` spawns synchronously (nothing is awaited before
 * `beginRun`), so a caller that reads this immediately after calling it —
 * before its own first await — sees the pid of the child it just started.
 * Read-only: it cannot start, stop or observe anything else about the run.
 */
export function liveRunPid(writeTargetKey: string): number | null | undefined {
  const live = liveRuns.get(writeTargetKey);
  if (live === undefined) return undefined;
  return live.child.pid ?? null;
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
    // NOTE: no "--cwd" flag — claude >= 2.x rejects it; the working directory
    // rides spawn options only.
    child = spawnImpl(binary, withStreamJsonArgv(argv), {
      cwd,
      env: scrubEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    // Streamed observations survive every outcome — a timed-out run that spoke
    // before the kill still carries its TTFT number.
    if (settled.firstTokenAt !== undefined) record.firstTokenAt = settled.firstTokenAt;
    if (settled.skippedLines !== undefined) record.skippedLines = settled.skippedLines;
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
  firstTokenAt?: number;
  skippedLines?: number;
}

function settleRun(child: ChildProcess, ctx: SettleContext): Promise<SettleResult> {
  return new Promise<SettleResult>((resolve) => {
    const stdout = makeStreamReader({ rawCap: STDOUT_CAP, lineCap: MAX_EVENT_LINE });
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

    // Every settle path — error, close, timeout — carries whatever the stream
    // already observed, so these two never depend on how the run ended.
    const settle = (result: SettleResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      const seen = stdout.snapshot();
      resolve({
        ...result,
        ...(seen.firstTokenAt !== undefined && { firstTokenAt: seen.firstTokenAt }),
        ...(seen.skippedLines > 0 && { skippedLines: seen.skippedLines }),
      });
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

    // Resolve on `close` (after stdio drained) rather than `exit` so the reader
    // sees the complete output. `close` also fires after a failed spawn.
    child.on("close", (code, signal) => {
      // A final line that never got its newline is still a line.
      stdout.flush();
      settle(
        mapExit({
          code,
          signal: signal ?? null,
          timedOut,
          stdout: stdout.snapshot(),
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
  stdout: StreamSnapshot;
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
    const { result } = input.stdout;
    if (result?.isError) {
      return {
        endedAt,
        outcome: "error",
        error: result.text?.trim() || "claude reported an error (is_error)",
      };
    }
    return { endedAt, outcome: "success", replyText: replyFrom(input.stdout) };
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

/**
 * Reply precedence, most authoritative first: the terminal `result` event's own
 * text (verbatim, never trimmed — the model owns its whitespace), then the
 * assembled text of the completed assistant messages, then the raw stdout tail
 * for a child that spoke no events at all. Only the last one is STDOUT_CAP-bound.
 */
function replyFrom(stream: StreamSnapshot): string {
  if (typeof stream.result?.text === "string") return stream.result.text;
  const assistant = stream.assistantText.trim();
  if (assistant) return assistant;
  return stream.rawTail.trim();
}

/**
 * The ceiling a run will actually be killed at: an explicit override first,
 * then ARCS_CLAUDE_RUN_TIMEOUT_MS, then the 10-minute default.
 *
 * Exported because the run route has to persist the resulting DEADLINE with the
 * session's run claim (a claim is only proof of life until the child is killed),
 * and a second copy of this precedence in the route would silently drift from
 * the one the timer here is armed with.
 */
export function resolveTimeoutMs(
  timeoutMs: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
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

// ---------------------------------------------------------------------------
// stream-json NDJSON reader
// ---------------------------------------------------------------------------

/** What the reader observed so far; read at settle time, never mid-flight. */
interface StreamSnapshot {
  /** The terminal `result` event, when the stream carried one. */
  result?: { isError: boolean; text?: string };
  /** Concatenated text of completed `assistant` messages (fallback reply). */
  assistantText: string;
  /** Epoch ms of the first assistant content seen (partial delta or message). */
  firstTokenAt?: number;
  /** Raw stdout tail — last-resort reply for a child that emits no events. */
  rawTail: string;
  /** Lines skipped: unparsable, non-object, or unknown-type. */
  skippedLines: number;
}

interface StreamReader {
  push(chunk: string): void;
  /** Consumes a trailing line that arrived without its newline (at close). */
  flush(): void;
  snapshot(): StreamSnapshot;
}

/** Event types the reader knows; anything else is ignored (and counted). */
const KNOWN_EVENT_TYPES = new Set(["result", "assistant", "user", "system", "stream_event"]);

/**
 * Line-oriented reader over `--output-format stream-json` stdout.
 *
 * Tolerant by construction, because the wire schema is claude's to change:
 * unknown event types are ignored rather than fatal, unparsable lines are
 * skipped and counted, and no shape assumption is made beyond "JSON object with
 * a string `type`". It never throws — a reader that can fail a run would make
 * every future claude release a potential outage.
 *
 * Chunk boundaries are irrelevant: a chunk that ends mid-JSON leaves the partial
 * line buffered until its newline arrives, and one line split across ten chunks
 * parses exactly once. Because complete lines are consumed as they arrive, the
 * reply is never truncated by either cap — `rawCap` bounds only the unused raw
 * fallback tail, and `lineCap` only a single *unterminated* line (a runaway
 * child with no newlines), which is then dropped along with the rest of it.
 */
function makeStreamReader(caps: { rawCap: number; lineCap: number }): StreamReader {
  const { rawCap, lineCap } = caps;
  const raw = makeTailBuffer(rawCap);
  const state: StreamSnapshot = { assistantText: "", rawTail: "", skippedLines: 0 };
  let pending = "";
  let dropping = false;

  const consumeLine = (line: string): void => {
    // Tolerate CRLF: the trailing \r is not part of the JSON.
    const text = (line.endsWith("\r") ? line.slice(0, -1) : line).trim();
    if (text === "") return; // blank separator lines are normal, not drift
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      state.skippedLines += 1;
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      state.skippedLines += 1;
      return;
    }
    applyEvent(value as Record<string, unknown>, state);
  };

  return {
    push(chunk: string): void {
      raw.push(chunk);
      const parts = (pending + chunk).split("\n");
      // The last part has not met its newline yet — it stays buffered, which is
      // exactly how a chunk that ends mid-JSON survives to be parsed once.
      pending = parts.pop() ?? "";
      for (const line of parts) {
        // The tail of an over-cap line ends here; the next line is clean again.
        if (dropping) dropping = false;
        else consumeLine(line);
      }
      if (dropping) {
        pending = "";
      } else if (pending.length > lineCap) {
        // One line longer than the cap with no newline in sight — drop it (and
        // the rest of it) so a runaway child cannot balloon memory.
        state.skippedLines += 1;
        dropping = true;
        pending = "";
      }
    },
    flush(): void {
      if (!dropping && pending !== "") consumeLine(pending);
      pending = "";
      dropping = false;
    },
    snapshot(): StreamSnapshot {
      return { ...state, rawTail: raw.text() };
    },
  };
}

/**
 * Folds one decoded event into the snapshot. Every branch is defensive about
 * field types — a `result` without a string `result`, an `assistant` without
 * content, a `stream_event` with a shape we have never seen are all survivable.
 */
function applyEvent(event: Record<string, unknown>, state: StreamSnapshot): void {
  const type = typeof event.type === "string" ? event.type : "";

  if (type === "result" || (!KNOWN_EVENT_TYPES.has(type) && isLegacyEnvelope(event))) {
    // The legacy single-object `--output-format json` envelope has no `type`;
    // an older or wrapped claude still settles the same way.
    state.result = {
      isError: event.is_error === true,
      ...(typeof event.result === "string" && { text: event.result }),
    };
    return;
  }

  if (type === "assistant") {
    const text = assistantMessageText(event.message);
    if (text !== "") {
      state.assistantText += text;
      markFirstToken(state);
    }
    return;
  }

  if (type === "stream_event") {
    // Partial deltas are the earliest possible content signal — this is the
    // line `--include-partial-messages` exists to deliver, and where TTFT is
    // actually measured. Their text is NOT accumulated: the completed
    // `assistant` message repeats it, and double-counting would duplicate the
    // fallback reply.
    if (partialText(event.event) !== "") markFirstToken(state);
    return;
  }

  // `user`, `system` and friends carry no reply text — known, so not drift.
  if (!KNOWN_EVENT_TYPES.has(type)) state.skippedLines += 1;
}

/** The pre-stream `{is_error?, result?}` object, recognized by shape alone. */
function isLegacyEnvelope(event: Record<string, unknown>): boolean {
  return typeof event.is_error === "boolean" || typeof event.result === "string";
}

function markFirstToken(state: StreamSnapshot): void {
  if (state.firstTokenAt === undefined) state.firstTokenAt = Date.now();
}

/** Text blocks of a completed assistant message, tolerant of string content. */
function assistantMessageText(message: unknown): string {
  const content = readField(message, "content");
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (readField(block, "type") !== "text") continue;
    const blockText = readField(block, "text");
    if (typeof blockText === "string") text += blockText;
  }
  return text;
}

/** Text carried by a partial-message event (`content_block_delta` and kin). */
function partialText(inner: unknown): string {
  for (const key of ["delta", "content_block"]) {
    const text = readField(readField(inner, key), "text");
    if (typeof text === "string" && text !== "") return text;
  }
  return "";
}

function readField(node: unknown, key: string): unknown {
  if (typeof node !== "object" || node === null) return undefined;
  return (node as Record<string, unknown>)[key];
}
