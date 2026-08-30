/**
 * The web client's two SSE channels, which are deliberately NOT one channel.
 *
 *  - `useServerEvents` — the DAG watcher. Debounced server-side (250ms) and
 *    consumed as cache invalidation: aggregate state for a graph repaint.
 *  - `useRunStream` — a stateless tail of ONE headless run's event log, polled
 *    server-side an order faster and consumed as text. A quarter second of
 *    coalescing is invisible on a repaint and unusable on tokens arriving word
 *    by word, so the two have different budgets and stay separate connections.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "./client";
import { keysForArea } from "./hooks";

export interface SseState {
  connected: boolean;
  lastEvent: ChangeEvent | null;
}

export function useServerEvents(): SseState {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<ChangeEvent | null>(null);
  const retryRef = useRef(0);

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      source = new EventSource("/api/events");

      source.onopen = () => {
        retryRef.current = 0;
        setConnected(true);
      };

      source.addEventListener("change", (raw) => {
        try {
          const event = JSON.parse((raw as MessageEvent).data) as ChangeEvent;
          setLastEvent(event);
          for (const key of keysForArea(event.slug, event.area)) {
            void qc.invalidateQueries({ queryKey: key });
          }
        } catch {
          // Malformed event — ignore.
        }
      });

      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (closed) return;
        const delay = Math.min(10_000, 1_000 * 2 ** retryRef.current++);
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [qc]);

  return { connected, lastEvent };
}

// ---------------------------------------------------------------------------
// Run event stream — the second channel
// ---------------------------------------------------------------------------

/** One tool call, as the ticker shows it: what ran, and on what.
 *
 *  A ticker, never a transcript — the call's arguments collapse to a single
 *  TARGET (the first identifying field it carries), so a run that reads twenty
 *  files reads as twenty short rows instead of twenty argument objects. */
export interface RunToolTick {
  /** Stable within a run: `<line offset>:<content block index>`. The log is
   *  append-only, so a tick's line offset never names a different tick. */
  id: string;
  name: string;
  /** Absent when the call carries no field this recognizes as its subject. */
  target?: string;
}

/**
 * Where the tail is.
 *  - `idle`        — nothing to tail (no run selected).
 *  - `connecting`  — attaching, or the browser is retrying a dropped socket.
 *  - `open`        — attached.
 *  - `ended`       — the run SETTLED (an `end` frame), which is the only
 *                    status that means the text is final.
 *  - `failed`      — the browser gave up, i.e. the route REFUSED (a pruned or
 *                    unknown run answers 404 and an `EventSource` does not
 *                    retry that). Distinct from `ended`: nothing settled.
 */
export type RunStreamStatus = "idle" | "connecting" | "open" | "ended" | "failed";

/** Live view of one run, folded from its event log's lines. */
export interface RunStreamState {
  /** The run this state describes; `null` while nothing is being tailed. Every
   *  consumer keys on it, so state from a previous run can never be read as
   *  this one's. */
  runId: string | null;
  status: RunStreamStatus;
  /** Text of COMPLETED `assistant` messages. */
  text: string;
  /** Partial deltas since the last completed message. Held apart from `text`
   *  because the completed message REPEATS them — see `foldRunLine`. */
  partial: string;
  tools: RunToolTick[];
  /**
   * The resume cursor: the `?from=` a fresh connection would pass, which is
   * exactly the route's contract — last seen line offset + 1, read off the
   * frame's OWN offset rather than counted here. An absolute line index into an
   * append-only log means the same thing to every connection, so resuming at it
   * can neither duplicate nor skip.
   */
  nextOffset: number;
  /** `metadata.run.outcome`, when the end frame could still read it. */
  outcome?: string;
  /** The log is NOT the whole stream — a hole, not an ending. Only ever known
   *  at settle, and absent (never `false`) when unknowable. */
  truncated?: boolean;
  /** The runtime-native session id the end frame harvested — the continuation
   *  handle the client persists as the next send's `continueSessionId`. */
  runtimeSessionId?: string;
  /** Typed failure code the end frame carried. `CONTINUATION_LOST` means the
   *  stored `continueSessionId` is dead — the client clears it and re-seeds on
   *  the next send (its full local transcript travels as `history`). */
  errorCode?: string;
}

export const EMPTY_RUN_STREAM: RunStreamState = {
  runId: null,
  status: "idle",
  text: "",
  partial: "",
  tools: [],
  nextOffset: 0,
};

/** `line` frame payload — the log's line at `offset`, verbatim. */
export interface RunLineFrame {
  offset: number;
  line: string;
}

/** `end` frame payload — the run settled and the log is drained. */
export interface RunEndFrame {
  offset: number;
  outcome?: string;
  truncated?: boolean;
  /** Continuation handle harvested from the run log, when the settle found one. */
  runtimeSessionId?: string;
  /** Typed failure code, when the settled record carries one (CONTINUATION_LOST). */
  errorCode?: string;
}

/** Everything the run has said so far: completed messages plus the deltas of
 *  the message still being written. */
export function runStreamText(state: RunStreamState): string {
  return state.text + state.partial;
}

/** Ceiling on one ticker target — the ticker is compact by contract. */
const RUN_TOOL_TARGET_MAX = 72;

/** Fields a `tool_use` may carry that name what it acted on, most specific
 *  first. Deliberately short: a tool this does not recognize ticks by NAME
 *  alone rather than spilling its argument object into the panel. */
const TOOL_TARGET_KEYS = [
  "file_path",
  "notebook_path",
  "path",
  "pattern",
  "command",
  "url",
  "query",
];

/** The keys an opencode `tool_use` part may name its tool under, top-level or
 *  nested in `part.state` — mirrors `opencodeToolName` in run-driver.ts. */
const OPENCODE_TOOL_NAME_KEYS = ["tool", "name"];

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Text carried by a partial-message event (`content_block_delta` and kin).
 *  Mirrors the runner's own reader — a `thinking` or `input_json_delta` delta
 *  carries no `text` and therefore contributes nothing. */
function partialDeltaText(inner: unknown): string {
  for (const key of ["delta", "content_block"]) {
    const text = asObject(inner)?.[key];
    const value = asObject(text)?.text;
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/** The subject of a tool call, capped — the first recognized field, in order. */
function toolTarget(input: unknown): string | undefined {
  const args = asObject(input);
  if (!args) return undefined;
  for (const key of TOOL_TARGET_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value !== "") {
      return value.length > RUN_TOOL_TARGET_MAX
        ? `${value.slice(0, RUN_TOOL_TARGET_MAX - 1)}…`
        : value;
    }
  }
  return undefined;
}

/** A tool name an opencode `tool_use` may carry: `part.tool` or `part.name`,
 *  or the same keys nested in `part.state`. First non-empty string wins; an
 *  empty answer means no usable name and no tick. Mirrors the opencode driver's
 *  normalizer. */
function opencodeToolName(part: unknown): string | undefined {
  const state = asObject(part)?.state;
  for (const node of [asObject(part), asObject(state)]) {
    if (node === null) continue;
    for (const key of OPENCODE_TOOL_NAME_KEYS) {
      const value = node[key];
      if (typeof value === "string" && value !== "") return value;
    }
  }
  return undefined;
}

/** Agent text carried by a codex item: flat `text`, or claude-like
 *  `message.content` text blocks. Empty when the item carries neither.
 *  Mirrors `codexItemText` in run-driver.ts. */
function codexItemText(item: unknown): string {
  const direct = asObject(item)?.text;
  if (typeof direct === "string" && direct !== "") return direct;
  const content = asObject(asObject(item)?.message)?.content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    const value = asObject(block)?.text;
    if (typeof value === "string") text += value;
  }
  return text;
}

/** One tool tick for a line-shaped tool event — the line offset is unique
 *  within a run, so `<line>:#tool` never collides with content-block ids. */
function lineToolTick(offset: number, name: string): RunToolTick {
  return { id: `${offset}:tool`, name };
}

/** Text and tool calls of ONE completed `assistant` message, in block order —
 *  the same content blocks the server's settle-time fold walks, so the ticker
 *  and the folded turns that replace it describe the same calls.
 *
 *  SHORTCUT: the ticker shows what the model REQUESTED, never what came back —
 *  the `user` events carrying `tool_result` are folded to nothing, so a call
 *  that failed ticks the same as one that succeeded. Upgrade when the panel
 *  needs to show a failing tool without waiting for the run to settle. */
function foldAssistantMessage(
  message: unknown,
  offset: number,
): { text: string; tools: RunToolTick[] } {
  const content = asObject(message)?.content;
  if (typeof content === "string") return { text: content, tools: [] };
  if (!Array.isArray(content)) return { text: "", tools: [] };

  let text = "";
  const tools: RunToolTick[] = [];
  content.forEach((raw, index) => {
    const block = asObject(raw);
    if (!block) return;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
      return;
    }
    if (block.type === "tool_use" && typeof block.name === "string") {
      const target = toolTarget(block.input);
      tools.push({ id: `${offset}:${index}`, name: block.name, ...(target && { target }) });
    }
  });
  return { text, tools };
}

/**
 * Folds one `line` frame into the view.
 *
 * The cursor advances off the FRAME's offset, never off a count of frames this
 * client rendered: the two agree only until something is skipped, and the log's
 * absolute index is the one the route resumes on.
 *
 * The text rule is where a naive fold doubles every reply. A completed
 * `assistant` message REPEATS the deltas that streamed it, so the two are never
 * added: deltas accumulate in `partial`, and the completed message supersedes
 * them (`partial` back to empty, its text appended to `text`). That is also why
 * nothing here dedupes — a client-side dedupe would paper over exactly the
 * resume bugs the offset contract exists to make impossible.
 *
 * Unparsable and unknown lines fold to nothing, deliberately: the log holds
 * every byte the child wrote, wire drift included, and a view of it must not
 * fail on a line it has never seen before.
 *
 * The runtime-native shapes fold alongside the unified claude contract, each
 * mirroring the server's run-driver normalizer:
 *  - `assistant` (claude-code) — completed messages, which REPEAT the deltas
 *    that streamed them, hence the supersede rule.
 *  - `message_update` / `tool_execution_start` (pi) — `text_delta` deltas are
 *    the reply; thinking/input_json deltas carry none; each named tool start
 *    ticks.
 *  - `text` / `tool_use` (opencode) — chunked reply text coalesces in
 *    `partial`; a named tool call ticks.
 *  - `item.*` / `agent_message` / `tool_execution` (codex) — agent text folds
 *    from agent-message items (the completed echo repeats the start's payload
 *    only for command runs, so text is folded from BOTH, the tick from the
 *    START alone).
 */
export function foldRunLine(state: RunStreamState, frame: RunLineFrame): RunStreamState {
  const next: RunStreamState = {
    ...state,
    nextOffset: Math.max(state.nextOffset, frame.offset + 1),
  };
  const event = asObject(safeParse(frame.line));
  if (!event) return next;

  if (event.type === "stream_event") {
    const text = partialDeltaText(event.event);
    return text === "" ? next : { ...next, partial: next.partial + text };
  }
  if (event.type === "assistant") {
    const { text, tools } = foldAssistantMessage(event.message, frame.offset);
    return {
      ...next,
      text: next.text + text,
      partial: "",
      tools: tools.length === 0 ? next.tools : [...next.tools, ...tools],
    };
  }
  if (event.type === "message_update") {
    // pi: only a text_delta carries reply text — a thinking or input_json
    // delta carries none by contract, so those fold to nothing.
    const assistantEvent = asObject(event.assistantMessageEvent);
    const delta = assistantEvent?.type === "text_delta" ? assistantEvent.delta : undefined;
    return typeof delta === "string" && delta !== ""
      ? { ...next, partial: next.partial + delta }
      : next;
  }
  if (event.type === "tool_execution_start") {
    // pi: a named tool begins — one tick per start event.
    const name = event.toolName;
    return typeof name === "string" && name !== ""
      ? { ...next, tools: [...next.tools, lineToolTick(frame.offset, name)] }
      : next;
  }
  if (event.type === "text") {
    // opencode: chunked reply text — consecutive chunks coalesce in partial.
    const part = asObject(event.part);
    const text = typeof part?.text === "string" ? part.text : "";
    return text === "" ? next : { ...next, partial: next.partial + text };
  }
  if (event.type === "tool_use") {
    // opencode: a named tool call.
    const name = opencodeToolName(event.part);
    return name === undefined
      ? next
      : { ...next, tools: [...next.tools, lineToolTick(frame.offset, name)] };
  }
  if (event.type === "item.started" || event.type === "item.completed") {
    // codex: agent text folds from agent-message items (both echoes carry the
    // text); a command_execution START opens the tick, the completed echo
    // would duplicate it.
    const item = asObject(event.item);
    const itemType = item?.type;
    if (itemType === "agent_message") {
      const text = codexItemText(item);
      return text === "" ? next : { ...next, partial: next.partial + text };
    }
    if (itemType === "command_execution" && event.type === "item.started") {
      return {
        ...next,
        tools: [...next.tools, lineToolTick(frame.offset, "command_execution")],
      };
    }
    return next;
  }
  if (event.type === "agent_message") {
    // codex, documented alternative shape: text at payload, string or
    // claude-like.
    const payload = event.payload;
    const text = typeof payload === "string" ? payload : codexItemText(payload);
    return text === "" ? next : { ...next, partial: next.partial + text };
  }
  if (event.type === "tool_execution") {
    // codex, documented alternative shape: payload carries the tool name.
    const payload = asObject(event.payload);
    const name = payload?.toolName ?? payload?.name;
    return typeof name === "string" && name !== ""
      ? { ...next, tools: [...next.tools, lineToolTick(frame.offset, name)] }
      : next;
  }
  return next;
}

/** Folds the `end` frame: the run settled and the log is drained. Its offset is
 *  the log's total line count — the `from` that would now return nothing. The
 *  end frame's continuation handle and typed failure code ride into the state
 *  so the caller can persist/clear the conversation's `continueSessionId`. */
export function foldRunEnd(state: RunStreamState, frame: RunEndFrame): RunStreamState {
  return {
    ...state,
    status: "ended",
    nextOffset: Math.max(state.nextOffset, frame.offset),
    ...(frame.outcome !== undefined && { outcome: frame.outcome }),
    ...(frame.truncated !== undefined && { truncated: frame.truncated }),
    ...(frame.runtimeSessionId !== undefined && { runtimeSessionId: frame.runtimeSessionId }),
    ...(frame.errorCode !== undefined && { errorCode: frame.errorCode }),
  };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseLineFrame(data: string): RunLineFrame | null {
  const frame = asObject(safeParse(data));
  if (!frame || typeof frame.line !== "string") return null;
  if (typeof frame.offset !== "number" || !Number.isInteger(frame.offset)) return null;
  return { offset: frame.offset, line: frame.line };
}

function parseEndFrame(data: string): RunEndFrame | null {
  const frame = asObject(safeParse(data));
  if (!frame || typeof frame.offset !== "number" || !Number.isInteger(frame.offset)) return null;
  return {
    offset: frame.offset,
    ...(typeof frame.outcome === "string" && { outcome: frame.outcome }),
    ...(typeof frame.truncated === "boolean" && { truncated: frame.truncated }),
    ...(typeof frame.runtimeSessionId === "string" && {
      runtimeSessionId: frame.runtimeSessionId,
    }),
    ...(typeof frame.errorCode === "string" && { errorCode: frame.errorCode }),
  };
}

/**
 * Tails one headless run's event log for as long as `runId` names one.
 *
 * The run is the only unit of persistence on the stateless ask surface — there
 * is no session record to key on, so this takes `(slug, runId)` and builds the
 * run-keyed stream URL `/api/p/{slug}/runs/{runId}/stream?from=…`.
 *
 * A SEPARATE `EventSource` from `useServerEvents`, with no retry logic of its
 * own — and that absence is the design, not a gap. On a dropped socket the
 * browser reconnects by itself and replays the last `id` it saw as
 * `Last-Event-ID`; the route's `id` IS the resume cursor (`offset + 1`) and
 * merges as `max(from, Last-Event-ID)`, so the reconnection resumes at the
 * first line this client has not seen. Nothing is duplicated, nothing is
 * skipped, and no client-side dedupe is involved.
 *
 * `?from=` covers the case the header cannot: a request carrying
 * `Last-Event-ID` can never rewind below it, and a browser only replays that
 * header on an automatic reconnect of the SAME instance. Any connection this
 * effect BUILDS is a fresh `EventSource` that sends no header at all (a
 * re-mount, or StrictMode's double invoke), so it carries the cursor in the URL
 * instead — which is why the cursor is a ref: it is read when a connection is
 * constructed, not when the panel renders.
 *
 * `close()` on `end` is the client's half of the contract: an `EventSource`
 * reconnects on ANY stream end, the settled one included.
 */
export function useRunStream(slug: string, runId: string | null): RunStreamState {
  const [state, setState] = useState<RunStreamState>(EMPTY_RUN_STREAM);
  const cursorRef = useRef<{ runId: string | null; from: number }>({ runId: null, from: 0 });

  useEffect(() => {
    if (runId === null) {
      setState(EMPTY_RUN_STREAM);
      return;
    }
    // A different run is a different log: an absolute line index is only stable
    // within one, so the cursor never carries across runs.
    if (cursorRef.current.runId !== runId) cursorRef.current = { runId, from: 0 };
    const from = cursorRef.current.from;
    setState((prev) =>
      prev.runId === runId
        ? { ...prev, status: prev.status === "ended" ? prev.status : "connecting" }
        : { ...EMPTY_RUN_STREAM, runId, status: "connecting" },
    );

    const source = new EventSource(
      `/api/p/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}/stream?from=${from}`,
    );
    // `ended` is terminal for this run — a late frame or a socket teardown must
    // never walk a settled run back to "connecting".
    const settle = (fold: (prev: RunStreamState) => RunStreamState) =>
      setState((prev) => (prev.status === "ended" ? prev : fold(prev)));

    source.onopen = () => settle((prev) => ({ ...prev, status: "open" }));

    source.addEventListener("line", (raw) => {
      const frame = parseLineFrame((raw as MessageEvent).data);
      if (!frame) return;
      cursorRef.current = { runId, from: Math.max(cursorRef.current.from, frame.offset + 1) };
      settle((prev) => foldRunLine({ ...prev, status: "open" }, frame));
    });

    source.addEventListener("end", (raw) => {
      const frame = parseEndFrame((raw as MessageEvent).data);
      if (frame) {
        cursorRef.current = { runId, from: Math.max(cursorRef.current.from, frame.offset) };
        settle((prev) => foldRunEnd(prev, frame));
      }
      source.close();
    });

    source.onerror = () =>
      // CONNECTING is the browser's own retry, already in flight with the
      // resume cursor on it. CLOSED means it gave up, which for this route is a
      // refusal (404 on a pruned or unknown run) rather than a drop.
      settle((prev) => ({
        ...prev,
        status: source.readyState === EventSource.CLOSED ? "failed" : "connecting",
      }));

    return () => source.close();
  }, [slug, runId]);

  return state;
}
