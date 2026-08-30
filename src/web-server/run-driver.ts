/**
 * Runtime seam for headless one-shot runs (T003 of the one-shot CLI bridge plan).
 *
 * Owns everything about a RUNTIME that the shared runner machinery must not
 * know: how to build argv for a one-shot invocation (fresh thread vs continued)
 * and how to read that runtime's NDJSON stdout back into fold turns. The
 * generic lifecycle — spawn, per-write-target concurrency slot, durable event
 * log, timeout + kill grace — stays in claude-runner.ts and run-event-log.ts;
 * an adapter here is pure policy over argv and wire format, so adding a runtime
 * never touches the runner.
 *
 * The registry is keyed by `SessionRuntimeType`. A runtime type without a
 * registered adapter (`getRunDriver` → undefined) is one the web server cannot
 * drive one-shot yet — callers decide whether that is a refusal or a fallback.
 *
 * Normalizers are total functions over raw stdout text: they never throw, they
 * tolerate unparsable lines by counting them (`skippedLines`, the same
 * wire-format-drift signal the claude reader reports), and every field access
 * on a decoded event is defensive because the wire schema is the runtime's to
 * change. The turns they produce are shaped exactly like what `foldRunEventLog`
 * appends through `appendSessionTurn` — assistant text plus one turn per tool
 * call — so a run's transcript fold needs no runtime-specific code downstream.
 */

import type { SessionRuntimeType } from "../utils/storage-utils.js";

// ---------------------------------------------------------------------------
// Seam types
// ---------------------------------------------------------------------------

/**
 * One turn a run folds into the transcript sidecar — the assistant variant of
 * `SessionTurnInput` (claude-transcript.ts), minus the `run` tag the fold adds.
 * A tool call rides as its own turn with empty text, exactly as
 * `foldAssistantEvent` emits them.
 */
export interface RunFoldTurn {
  type: "assistant";
  text: string;
  tool?: { name: string };
}

/** Input for building one headless invocation's argv. */
export interface OneShotRunInput {
  /** The staged user message; may be multiple words. Never mutated. */
  message: string;
  /** Thread title for a FRESH thread; ignored when continuing. */
  title?: string;
  /**
   * Runtime session id to continue. Absent (or blank) means a fresh thread —
   * except a blank-but-present id, which throws: silently minting a new thread
   * would fork conversation state on what is clearly a caller bug.
   */
  runtimeSessionId?: string;
  /**
   * Directory for the runtime's session storage when continuing (pi:
   * `--session-dir`), so a runtime that stores sessions under the caller's cwd
   * keeps the same store across cwd changes. Adapters that have no such flag
   * ignore it, and every adapter must work without it — the caller wiring that
   * supplies it lands separately.
   */
  sessionDir?: string;
}

/** What one run's raw stdout folded down to. */
export interface RunOutputFold {
  /** Turns in stream order, ready for `appendSessionTurn` (minus the run tag). */
  turns: RunFoldTurn[];
  /** Concatenated text-part content — the run's reply text. */
  replyText: string;
  /**
   * The runtime's own session id, taken from the first stdout line that
   * carried one. This is what lets a first turn lazily mint the session's
   * `runtimeSessionId`: the caller persists it after the run settles.
   */
  runtimeSessionId?: string;
  /** Message of the last `error` event the stream carried, when any. */
  error?: string;
  /** Lines skipped: unparsable JSON, non-object JSON, or an unknown event type. */
  skippedLines: number;
}

/** What one runtime contributes to the shared runner machinery. */
export interface RunDriverAdapter {
  /** The session runtime type this adapter drives. */
  readonly runtimeType: SessionRuntimeType;
  /** Binary spawned for this runtime (PATH-resolved at spawn time). */
  readonly binary: string;
  /** Argv after the binary, for a fresh vs continued one-shot invocation. */
  buildArgv(input: OneShotRunInput): string[];
  /** Normalizes raw NDJSON stdout into fold turns + session id + reply/error. */
  foldOutput(raw: string): RunOutputFold;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const adapters = new Map<SessionRuntimeType, RunDriverAdapter>();

/** Registers (or replaces) the adapter for a runtime type. Idempotent. */
export function registerRunDriver(adapter: RunDriverAdapter): void {
  adapters.set(adapter.runtimeType, adapter);
}

/**
 * The adapter for a runtime type, or undefined when that runtime has no
 * one-shot driver yet (a future runtime type is simply not drivable).
 */
export function getRunDriver(runtimeType: SessionRuntimeType): RunDriverAdapter | undefined {
  return adapters.get(runtimeType);
}

/**
 * Every runtime type with a registered one-shot adapter, in registration order.
 * The runners route enumerates the drivable surface from this rather than a
 * maintained list, so a driver added later shows up automatically.
 */
export function getRunDriverRuntimeTypes(): SessionRuntimeType[] {
  return [...adapters.keys()];
}

// ---------------------------------------------------------------------------
// Opencode adapter — verified against opencode 1.18.19
// ---------------------------------------------------------------------------

/**
 * Argv for `opencode run --format json`.
 *
 * Fresh thread: ["run", "--format", "json", "--title", <title>, <message>]
 * Continuation: ["run", "--format", "json", "-s", <runtimeSessionId>, <message>]
 *
 * The message travels as ONE argv element even though it may contain many
 * words — the CLI accepts multiple positionals, but a single element cannot be
 * re-tokenized by a shell and keeps the staged message byte-identical. A fresh
 * thread without a title falls back to opencode's own truncated-prompt title.
 */
export function buildOpencodeRunArgv(input: OneShotRunInput): string[] {
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new Error("opencode run requires a non-empty message");
  }
  const sessionId = input.runtimeSessionId?.trim();
  if (input.runtimeSessionId !== undefined && sessionId === "") {
    throw new Error("opencode run requires a non-blank runtimeSessionId to continue");
  }

  const argv = ["run", "--format", "json"];
  if (sessionId !== undefined && sessionId !== "") {
    // Continuation carries no --title: the thread already has its name.
    argv.push("-s", sessionId);
  } else {
    const title = input.title?.trim();
    if (title) argv.push("--title", title);
  }
  argv.push(input.message);
  return argv;
}

/** Event types the opencode normalizer knows; anything else is drift. */
const OPENCODE_EVENT_TYPES = new Set([
  "step_start",
  "text",
  "step_finish",
  "tool_use",
  "reasoning",
  "error",
]);

function isBlock(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readField(node: unknown, key: string): unknown {
  if (!isBlock(node)) return undefined;
  return node[key];
}

/**
 * A tool_use event's tool name, wherever this opencode build put it: `part.tool`
 * or `part.name` directly, or the same keys nested in `part.state`. First
 * non-empty string wins; anything else means no usable name and no tool turn.
 */
function opencodeToolName(part: unknown): string | undefined {
  const state = readField(part, "state");
  for (const node of [part, state]) {
    for (const key of ["tool", "name"]) {
      const value = readField(node, key);
      if (typeof value === "string" && value !== "") return value;
    }
  }
  return undefined;
}

/** An error event's message, tolerating string payloads and `{name, message}`. */
function opencodeErrorMessage(event: Record<string, unknown>): string | undefined {
  const err = event.error;
  if (typeof err === "string" && err !== "") return err;
  if (isBlock(err)) {
    if (typeof err.message === "string" && err.message !== "") return err.message;
    if (typeof err.name === "string" && err.name !== "") return err.name;
  }
  return undefined;
}

/**
 * Normalizes raw `opencode run --format json` stdout into fold turns.
 *
 * Every line is expected to be one JSON object `{type, timestamp, sessionID,
 * part?|error?}` with type ∈ step_start | text | step_finish | tool_use |
 * reasoning | error — but the schema is opencode's to change, so nothing here
 * is fatal: unparsable lines are skipped and counted, unknown types are skipped
 * and counted, and `sessionID` is harvested from ANY decoded object line (the
 * contract puts it on every emitted line; taking it from an unexpected shape
 * still beats losing it). Consecutive `text` events coalesce into one turn —
 * they are chunks of one reply segment — and each named `tool_use` becomes its
 * own turn, mirroring how the claude fold reads content blocks. `reasoning`
 * events are known but folded by nothing: thinking is not the reply.
 */
export function foldOpencodeOutput(raw: string): RunOutputFold {
  const turns: RunFoldTurn[] = [];
  let pendingText = "";
  let replyText = "";
  let runtimeSessionId: string | undefined;
  let error: string | undefined;
  let skippedLines = 0;

  const flushText = (): void => {
    if (pendingText === "") return;
    turns.push({ type: "assistant", text: pendingText });
    pendingText = "";
  };

  for (const line of raw.split("\n")) {
    // Tolerate CRLF: the trailing \r is not part of the JSON.
    const text = (line.endsWith("\r") ? line.slice(0, -1) : line).trim();
    if (text === "") continue; // blank separator lines are normal, not drift
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (!isBlock(value)) {
      skippedLines += 1;
      continue;
    }

    // The session id rides every emitted line; harvest it before anything else
    // so even a drifted event shape still mints the runtimeSessionId.
    const sid = value.sessionID;
    if (runtimeSessionId === undefined && typeof sid === "string" && sid !== "") {
      runtimeSessionId = sid;
    }

    const type = typeof value.type === "string" ? value.type : "";
    if (!OPENCODE_EVENT_TYPES.has(type)) {
      skippedLines += 1;
      continue;
    }

    if (type === "text") {
      const partText = readField(value.part, "text");
      if (typeof partText === "string" && partText !== "") {
        pendingText += partText;
        replyText += partText;
      }
      continue;
    }

    if (type === "tool_use") {
      const name = opencodeToolName(value.part);
      if (name !== undefined) {
        flushText();
        turns.push({ type: "assistant", text: "", tool: { name } });
      }
      continue;
    }

    if (type === "error") {
      const message = opencodeErrorMessage(value);
      if (message !== undefined) error = message;
    }

    // step_start / step_finish / reasoning carry no reply content.
  }
  flushText();

  return {
    turns,
    replyText,
    ...(runtimeSessionId !== undefined && { runtimeSessionId }),
    ...(error !== undefined && { error }),
    skippedLines,
  };
}

/** The opencode one-shot driver, registered at module load. */
registerRunDriver({
  runtimeType: "opencode",
  binary: "opencode",
  buildArgv: buildOpencodeRunArgv,
  foldOutput: foldOpencodeOutput,
});

// ---------------------------------------------------------------------------
// Pi adapter — verified against pi 0.84.4
// ---------------------------------------------------------------------------

/**
 * Argv for `pi -p --mode json`.
 *
 * Fresh thread: ["-p", "--mode", "json", <message>]
 * Continuation: ["-p", "--mode", "json", "--session-id", <id>, <message>]
 *   plus `--session-dir`, <dir> when the caller supplies sessionDir, so pi's
 *   session store stays stable across cwd changes.
 *
 * Allow-all policy: NO tool-permission flags — the old ask/change intent
 * machinery is being deleted project-wide and runs are full-tool, so the path
 * has no permission vocabulary to emit. The message travels as ONE argv
 * element exactly like opencode's, so a multi-word staged message stays
 * byte-identical and can never be re-tokenized by a shell.
 */
export function buildPiRunArgv(input: OneShotRunInput): string[] {
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new Error("pi -p requires a non-empty message");
  }
  const sessionId = input.runtimeSessionId?.trim();
  if (input.runtimeSessionId !== undefined && sessionId === "") {
    throw new Error("pi -p requires a non-blank runtimeSessionId to continue");
  }

  const argv = ["-p", "--mode", "json"];
  if (sessionId !== undefined && sessionId !== "") {
    // Continuation: --session-id is the exact project session id (created if
    // missing, per `pi --help`); a fresh thread picks pi's own generated id.
    argv.push("--session-id", sessionId);
    const sessionDir = input.sessionDir?.trim();
    if (sessionDir) argv.push("--session-dir", sessionDir);
  }
  argv.push(input.message);
  return argv;
}

/** Event types the pi normalizer knows; anything else is drift. */
const PI_EVENT_TYPES = new Set([
  "session",
  "agent_start",
  "turn_start",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "turn_end",
  "agent_end",
  "agent_settled",
]);

/**
 * The reply-text delta of a `message_update`, or undefined when the event
 * carries none. Only `assistantMessageEvent.type === "text_delta"` produces
 * reply text — the documented rule is that a thinking or input_json_delta
 * delta carries no text, so those are ignored rather than folded.
 */
function piTextDelta(event: Record<string, unknown>): string | undefined {
  const assistantEvent = readField(event, "assistantMessageEvent");
  if (!isBlock(assistantEvent) || assistantEvent.type !== "text_delta") return undefined;
  const delta = assistantEvent.delta;
  return typeof delta === "string" && delta !== "" ? delta : undefined;
}

/**
 * Normalizes raw `pi -p --mode json` stdout into fold turns.
 *
 * Every line is expected to be one JSON object from the event stream
 * (`session` header, `message_update` deltas, `tool_execution_start`/`_end`,
 * agent/turn bookkeeping) — but the schema is pi's to change, so nothing here
 * is fatal: unparsable lines and unknown event types are skipped and counted,
 * the session id is harvested from the `session` header line only, and
 * consecutive `text_delta`s coalesce into ONE assistant turn (they are chunks
 * of one reply segment). Each named `tool_execution_start` becomes its own
 * tool turn after flushing pending text, mirroring the opencode tool fold;
 * `thinking_delta` and the tool result carries are folded by nothing.
 */
export function foldPiOutput(raw: string): RunOutputFold {
  const turns: RunFoldTurn[] = [];
  let pendingText = "";
  let replyText = "";
  let runtimeSessionId: string | undefined;
  let skippedLines = 0;

  const flushText = (): void => {
    if (pendingText === "") return;
    turns.push({ type: "assistant", text: pendingText });
    pendingText = "";
  };

  for (const line of raw.split("\n")) {
    // Tolerate CRLF: the trailing \r is not part of the JSON.
    const text = (line.endsWith("\r") ? line.slice(0, -1) : line).trim();
    if (text === "") continue; // blank separator lines are normal, not drift
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (!isBlock(value)) {
      skippedLines += 1;
      continue;
    }

    const type = typeof value.type === "string" ? value.type : "";
    if (!PI_EVENT_TYPES.has(type)) {
      skippedLines += 1;
      continue;
    }

    if (type === "session") {
      // The header line is where pi carries its session id; first one wins.
      const sid = value.id;
      if (runtimeSessionId === undefined && typeof sid === "string" && sid !== "") {
        runtimeSessionId = sid;
      }
      continue;
    }

    if (type === "message_update") {
      const delta = piTextDelta(value);
      if (delta !== undefined) {
        pendingText += delta;
        replyText += delta;
      }
      continue;
    }

    if (type === "tool_execution_start") {
      const name = readField(value, "toolName");
      if (typeof name === "string" && name !== "") {
        flushText();
        turns.push({ type: "assistant", text: "", tool: { name } });
      }
    }

    // session header handled above; agent/turn/message start-end events and
    // tool_execution_update/_end carry no reply content.
  }
  flushText();

  return {
    turns,
    replyText,
    ...(runtimeSessionId !== undefined && { runtimeSessionId }),
    skippedLines,
  };
}

/** The pi one-shot driver, registered at module load. */
registerRunDriver({
  runtimeType: "pi",
  binary: "pi",
  buildArgv: buildPiRunArgv,
  foldOutput: foldPiOutput,
});

// ---------------------------------------------------------------------------
// Claude-code adapter — verified against claude 2.1.247
// ---------------------------------------------------------------------------

/**
 * Argv for `claude -p --output-format json`.
 *
 * Fresh thread: ["-p", "--output-format", "json", "--dangerously-skip-permissions", <message>]
 * Continuation: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", <id>, <message>]
 *
 * `--dangerously-skip-permissions` is REQUIRED so a headless `-p` run never
 * blocks on an approval prompt — the approved allow-all design, with the
 * diff-review safety gate living in the web UI rather than the driver. Runs
 * through this driver reach the child verbatim (streamJsonArgv: false at the
 * call site), so the fold below reads exactly this output contract.
 */
export function buildClaudeCodeRunArgv(input: OneShotRunInput): string[] {
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new Error("claude -p requires a non-empty message");
  }
  const sessionId = input.runtimeSessionId?.trim();
  if (input.runtimeSessionId !== undefined && sessionId === "") {
    throw new Error("claude -p requires a non-blank runtimeSessionId to continue");
  }

  const argv = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];
  if (sessionId !== undefined && sessionId !== "") {
    argv.push("--resume", sessionId);
  }
  argv.push(input.message);
  return argv;
}

/** Event types the claude-code normalizer knows; anything else is drift. */
const CLAUDE_DRIVER_EVENT_TYPES = new Set(["system", "user", "assistant", "result"]);

/**
 * Normalizes raw `claude -p --output-format json` stdout into fold turns.
 *
 * Line shapes: `system` (init carries the `session_id`), `user` (echoed turn),
 * `assistant` (message with content blocks), `result` (terminal envelope with
 * `result` text and `is_error`). The legacy pre-stream envelope — a single
 * `{is_error, result}` object with no `type` — is recognized by shape alone,
 * exactly as the built-in runner reader does. Tolerant by construction: every
 * field access is defensive, unparsable/unknown lines are skipped and counted,
 * and the session id is harvested from any decoded line that carries one.
 * Text blocks of one assistant message flush as ONE turn with tool_use blocks
 * as their own turns in block order (the run-event-log's claude fold shape);
 * a terminal `result` string is the reply-text fallback only when no assistant
 * content was folded, and a failing `result` (is_error) surfaces as `error`
 * instead of reply text — mirroring the runner's reply precedence.
 */
export function foldClaudeCodeOutput(raw: string): RunOutputFold {
  const turns: RunFoldTurn[] = [];
  let pendingText = "";
  let replyText = "";
  let runtimeSessionId: string | undefined;
  let error: string | undefined;
  let skippedLines = 0;

  const flushText = (): void => {
    if (pendingText === "") return;
    turns.push({ type: "assistant", text: pendingText });
    pendingText = "";
  };

  for (const line of raw.split("\n")) {
    // Tolerate CRLF: the trailing \r is not part of the JSON.
    const text = (line.endsWith("\r") ? line.slice(0, -1) : line).trim();
    if (text === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (!isBlock(value)) {
      skippedLines += 1;
      continue;
    }

    // The init line puts the session id at the top level — harvest it before
    // anything else so even a drifted event shape still mints the id. The
    // terminal result envelope repeats it, so first non-empty wins.
    const sid = value.session_id;
    if (runtimeSessionId === undefined && typeof sid === "string" && sid !== "") {
      runtimeSessionId = sid;
    }

    const type = typeof value.type === "string" ? value.type : "";
    // The legacy single-object envelope has no `type`; recognize it by shape.
    const legacyResult =
      type === "" && (typeof value.is_error === "boolean" || typeof value.result === "string");
    if (!CLAUDE_DRIVER_EVENT_TYPES.has(type) && !legacyResult) {
      skippedLines += 1;
      continue;
    }

    if (type === "assistant") {
      const content = readField(value.message, "content");
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isBlock(block)) continue;
          if (block.type === "text" && typeof block.text === "string") {
            pendingText += block.text;
            replyText += block.text;
            continue;
          }
          if (block.type === "tool_use" && typeof block.name === "string" && block.name !== "") {
            flushText();
            turns.push({ type: "assistant", text: "", tool: { name: block.name } });
          }
        }
      }
      flushText(); // flush-per-message: one assistant turn per message
      continue;
    }

    if (type === "result" || legacyResult) {
      const resultText = typeof value.result === "string" ? value.result : undefined;
      if (value.is_error === true) {
        if (error === undefined && resultText !== undefined && resultText !== "") {
          error = resultText;
        }
      } else if (resultText !== undefined && resultText !== "" && replyText === "") {
        // Reply fallback: a result with no assistant content on the stream.
        replyText = resultText;
      }
    }

    // system / user carry no reply content.
  }
  flushText();

  return {
    turns,
    replyText,
    ...(runtimeSessionId !== undefined && { runtimeSessionId }),
    ...(error !== undefined && { error }),
    skippedLines,
  };
}

/** The claude-code one-shot driver, registered at module load. */
registerRunDriver({
  runtimeType: "claude-code",
  binary: "claude",
  buildArgv: buildClaudeCodeRunArgv,
  foldOutput: foldClaudeCodeOutput,
});

// ---------------------------------------------------------------------------
// Codex adapter — verified against codex-cli 0.150.1
// ---------------------------------------------------------------------------

/**
 * Argv for `codex exec --json`.
 *
 * Fresh thread: ["exec", "--json", "--sandbox", "workspace-write", <message>]
 * Continuation: ["exec", "resume", <id>, "--json", "--sandbox", "workspace-write", <message>]
 *
 * `--sandbox workspace-write` is the full-write sandbox this allow-all design
 * runs under; `--json` is the NDJSON event stream the fold reads. The resume
 * id is the `thread_id` a settled run harvested from its `thread.started`
 * line. Runs through this driver reach the child verbatim
 * (streamJsonArgv: false at the call site).
 */
export function buildCodexRunArgv(input: OneShotRunInput): string[] {
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new Error("codex exec requires a non-empty message");
  }
  const sessionId = input.runtimeSessionId?.trim();
  if (input.runtimeSessionId !== undefined && sessionId === "") {
    throw new Error("codex exec requires a non-blank runtimeSessionId to continue");
  }

  if (sessionId !== undefined && sessionId !== "") {
    return ["exec", "resume", sessionId, "--json", "--sandbox", "workspace-write", input.message];
  }
  return ["exec", "--json", "--sandbox", "workspace-write", input.message];
}

/**
 * Top-level event types the codex normalizer knows; anything else is drift.
 * `agent_message` / `tool_execution` are the documented alternative shapes
 * (older or wrapped builds); 0.150.1 emits `item.*` events instead, which the
 * item-level types below handle.
 */
const CODEX_EVENT_TYPES = new Set([
  "thread.started",
  "thread.completed",
  "turn.started",
  "turn.completed",
  "item.started",
  "item.completed",
  "agent_message",
  "tool_execution",
]);

/**
 * Item types folded inside `item.*` events. `agent_message` is reply text and
 * `command_execution` a tool call — both observed on 0.150.1. Any other item
 * type (approval prompts, reasoning, unknown) is drift, counted like any
 * unrecognized line.
 */
const CODEX_ITEM_TYPES = new Set(["agent_message", "command_execution"]);

/**
 * Agent text carried by a codex item, tolerant of the observed flat `text`
 * and the claude-like `message.content` block shape of the documented
 * payload alternative. Empty when the item carries none.
 */
function codexItemText(item: unknown): string {
  const direct = readField(item, "text");
  if (typeof direct === "string" && direct !== "") return direct;
  const content = readField(readField(item, "message"), "content");
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (!isBlock(block) || block.type !== "text") continue;
    const blockText = readField(block, "text");
    if (typeof blockText === "string") text += blockText;
  }
  return text;
}

/**
 * Normalizes raw `codex exec --json` stdout into fold turns.
 *
 * EXTRA conservative on purpose: the codex wire has drifted between builds
 * (the observed 0.150.1 emits `item.*` events; the documented shape wraps
 * agent text in `agent_message` payloads), so nothing here may throw and
 * anything unrecognized is skipped and counted. Text folds from agent-message
 * items (consecutive ones coalesce into one turn), tool turns come from
 * `command_execution` start items (one per invocation, named by the item
 * type), the thread id is harvested from any line that carries one, and
 * ambiguous shapes fold text only — the panels tick tools by name and tolerate
 * missing detail.
 */
export function foldCodexOutput(raw: string): RunOutputFold {
  const turns: RunFoldTurn[] = [];
  let pendingText = "";
  let replyText = "";
  let runtimeSessionId: string | undefined;
  let skippedLines = 0;

  const flushText = (): void => {
    if (pendingText === "") return;
    turns.push({ type: "assistant", text: pendingText });
    pendingText = "";
  };

  const addText = (text: string): void => {
    if (text === "") return;
    pendingText += text;
    replyText += text;
  };

  for (const line of raw.split("\n")) {
    // Tolerate CRLF: the trailing \r is not part of the JSON.
    const text = (line.endsWith("\r") ? line.slice(0, -1) : line).trim();
    if (text === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (!isBlock(value)) {
      skippedLines += 1;
      continue;
    }

    // The session/thread id rides the thread.started line (and may ride
    // others in future builds); harvest it before anything else, first wins.
    const threadId = value.thread_id;
    if (runtimeSessionId === undefined && typeof threadId === "string" && threadId !== "") {
      runtimeSessionId = threadId;
    }

    const type = typeof value.type === "string" ? value.type : "";
    if (!CODEX_EVENT_TYPES.has(type)) {
      skippedLines += 1;
      continue;
    }

    if (
      type === "thread.started" ||
      type === "thread.completed" ||
      type === "turn.started" ||
      type === "turn.completed"
    ) {
      // Session/turn bookkeeping — no reply content.
      continue;
    }

    if (type === "item.started" || type === "item.completed") {
      const item = readField(value, "item");
      if (!isBlock(item)) {
        skippedLines += 1;
        continue;
      }
      const itemType = typeof item.type === "string" ? item.type : "";
      if (!CODEX_ITEM_TYPES.has(itemType)) {
        skippedLines += 1;
        continue;
      }
      if (itemType === "agent_message") {
        addText(codexItemText(item));
        continue;
      }
      // command_execution: item.started opens the call, item.completed echoes
      // the same item — so only the START folds a tool turn.
      if (type === "item.started") {
        flushText();
        turns.push({ type: "assistant", text: "", tool: { name: "command_execution" } });
      }
      continue;
    }

    if (type === "agent_message") {
      // Documented alternative shape: text at payload, string or claude-like.
      const payload = readField(value, "payload");
      addText(typeof payload === "string" ? payload : codexItemText(payload));
      continue;
    }

    // tool_execution (documented alternative): payload carries the tool name.
    const payload = readField(value, "payload");
    const name = readField(payload, "toolName") ?? readField(payload, "name");
    if (typeof name === "string" && name !== "") {
      flushText();
      turns.push({ type: "assistant", text: "", tool: { name } });
    }
  }
  flushText();

  return {
    turns,
    replyText,
    ...(runtimeSessionId !== undefined && { runtimeSessionId }),
    skippedLines,
  };
}

/** The codex one-shot driver, registered at module load. */
registerRunDriver({
  runtimeType: "codex",
  binary: "codex",
  buildArgv: buildCodexRunArgv,
  foldOutput: foldCodexOutput,
});
