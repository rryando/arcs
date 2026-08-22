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
 * one-shot driver yet (claude-code drivers arrive against this same seam).
 */
export function getRunDriver(runtimeType: SessionRuntimeType): RunDriverAdapter | undefined {
  return adapters.get(runtimeType);
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
