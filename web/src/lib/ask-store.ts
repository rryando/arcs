/**
 * The Ask-AI session manager — ONE conversation per runner, owned entirely by
 * the browser.
 *
 * The stateless ask surface has no thread record anywhere: the server accepts
 * one turn at a time and mints a fresh run; continuity is the runtime-native
 * session id a settled run harvests, which rides the stream's `end` frame and
 * lands here. This module is that client-side memory:
 *
 *   - `arcs:askai:<slug>:<runner>` → `AskConversation` — a local transcript of
 *     one per-runner conversation (user/assistant/tool/error turns, optional
 *     runtime `continueSessionId`). One conversation per runner, so switching
 *     the picker switches threads without losing either.
 *   - `arcs:askai:selection` → the selected runner id (`"pi"` by default).
 *
 * The CAP is deliberate: `historyForSend` renders the conversation tail the
 * NEXT turn carries as `history`, bounded by turn count and character budget —
 * the client's half of the stateless continuation contract.
 *
 * Failure handling is degrade-not-throw: unreadable localStorage answers the
 * empty conversation, and a write that hits the quota TRIMS the oldest turns
 * rather than throwing, so a long conversation degrades to a shorter one
 * instead of a broken panel.
 */

import { useSyncExternalStore } from "react";
import type { RunnerId, SessionReference } from "../api/client";

// ---------------------------------------------------------------------------
// Keys + shape
// ---------------------------------------------------------------------------

const CONVERSATION_PREFIX = "arcs:askai:";
const SELECTION_KEY = "arcs:askai:selection";

/** The one conversation per runner, persisted per project. */
export interface AskConversation {
  turns: AskStoredTurn[];
  /** Runtime-native session id, harvested from a settled run's end frame. Its
   *  presence makes the next send a CONTINUATION of that runtime thread. */
  continueSessionId?: string;
}

export interface AskStoredTurn {
  id: string;
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  /** ISO timestamp of when the turn was persisted. */
  ts: string;
  /** The reference this turn carried, when it had one. */
  ref?: SessionReference;
  /** The run that produced this turn — the stream-run substitution key. */
  run?: string;
  /** Diff-review state, written by the changes/revert wave. */
  reviewState?: "pending" | "approved" | "reverted";
}

const TURN_ROLES = new Set(["user", "assistant", "tool", "error"]);
const REVIEW_STATES = new Set(["pending", "approved", "reverted"]);

/** A stored turn that is usable as one — anything else is dropped on read. */
function isStoredTurn(value: unknown): value is AskStoredTurn {
  if (typeof value !== "object" || value === null) return false;
  const turn = value as Record<string, unknown>;
  if (typeof turn.id !== "string" || turn.id === "") return false;
  if (typeof turn.role !== "string" || !TURN_ROLES.has(turn.role)) return false;
  if (typeof turn.text !== "string") return false;
  if (typeof turn.ts !== "string") return false;
  if (
    turn.reviewState !== undefined &&
    (typeof turn.reviewState !== "string" || !REVIEW_STATES.has(turn.reviewState))
  ) {
    return false;
  }
  return true;
}

function conversationKey(slug: string, runner: RunnerId): string {
  return `${CONVERSATION_PREFIX}${slug}:${runner}`;
}

// ---------------------------------------------------------------------------
// Change notification — the store's subscription surface
// ---------------------------------------------------------------------------

type AskStoreListener = () => void;

/** Bumped on every successful read-write cycle, so external stores (the panel's
 *  `useLocalTranscript`) re-read on change without tracking individual keys. */
let version = 0;
const listeners = new Set<AskStoreListener>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Subscribe to store changes; returns the unsubscribe. */
export function subscribeAskStore(listener: AskStoreListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic change counter — the `getSnapshot` for useSyncExternalStore. */
export function getAskStoreVersion(): number {
  return version;
}

function safeRead(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Unavailable/blocked storage — nothing we can persist; reads answer the
    // defaults and the panel still works for the session.
  }
}

// ---------------------------------------------------------------------------
// Conversation IO — degrade-not-throw, quota-trim on write
// ---------------------------------------------------------------------------

/** The persisted conversation for one (slug, runner) pair, validated
 *  defensively (a hand-edited or corrupted record is dropped, never thrown
 *  on). */
export function getConversation(slug: string, runner: RunnerId): AskConversation {
  const raw = safeRead(conversationKey(slug, runner));
  if (raw === null) return { turns: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { turns: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { turns: [] };
  }
  const record = parsed as Record<string, unknown>;
  const turns = Array.isArray(record.turns) ? record.turns.filter(isStoredTurn) : [];
  const continueSessionId =
    typeof record.continueSessionId === "string" && record.continueSessionId !== ""
      ? record.continueSessionId
      : undefined;
  return { turns, ...(continueSessionId !== undefined && { continueSessionId }) };
}

/**
 * Persists the conversation, trimming the OLDEST turns while the write keeps
 * failing (quota) rather than throwing. A store that never accepts writes
 * eventually trims to nothing and gives up silently — degrade, not throw.
 */
function persistConversation(slug: string, runner: RunnerId, conversation: AskConversation): void {
  const key = conversationKey(slug, runner);
  let candidate = conversation;
  for (;;) {
    try {
      localStorage.setItem(key, JSON.stringify(candidate));
      break;
    } catch {
      if (candidate.turns.length === 0) break;
      candidate = { ...candidate, turns: candidate.turns.slice(1) };
    }
  }
  bump();
}

/** Turns are keyed by a locally unique id — the session-row `<React.Fragment>`
 *  key, never a server index. crypto.randomUUID is the modern path; the
 *  fallback covers non-secure contexts (plain HTTP hosts). */
export function newTurnId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Appends one turn and persists. Returns the stored conversation. */
export function appendTurn(slug: string, runner: RunnerId, turn: AskStoredTurn): AskConversation {
  const conversation = getConversation(slug, runner);
  const next = { ...conversation, turns: [...conversation.turns, turn] };
  persistConversation(slug, runner, next);
  return next;
}

/**
 * Records (or clears, with `null`) the runtime continuation handle a settled
 * run's end frame carried — the next send's `continueSessionId`.
 */
export function setContinueSessionId(
  slug: string,
  runner: RunnerId,
  sessionId: string | null,
): void {
  const conversation = getConversation(slug, runner);
  const next =
    sessionId === null || sessionId === ""
      ? { ...conversation, continueSessionId: undefined }
      : { ...conversation, continueSessionId: sessionId };
  persistConversation(slug, runner, next);
}

/** Drops the stored conversation for one (slug, runner) pair. */
export function clearConversation(slug: string, runner: RunnerId): void {
  const key = conversationKey(slug, runner);
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore — unreadable storage simply has nothing to clear.
  }
  bump();
}

/** The review state a settled run's changes are in on its assistant turn:
 *  pending → the user has not acted; approved/reverted end the review. No-op
 *  when the turn is unknown (the conversation was cleared mid-flight). */
export function setTurnReviewState(
  slug: string,
  runner: RunnerId,
  turnId: string,
  reviewState: "pending" | "approved" | "reverted",
): void {
  const conversation = getConversation(slug, runner);
  let changed = false;
  const turns = conversation.turns.map((turn) => {
    if (turn.id !== turnId) return turn;
    changed = true;
    return { ...turn, reviewState };
  });
  if (!changed) return;
  persistConversation(slug, runner, { ...conversation, turns });
}

/** Whole conversation rendered as markdown — a portable, human-readable copy. */
export function exportConversation(slug: string, runner: RunnerId): string {
  const { turns, continueSessionId } = getConversation(slug, runner);
  const lines: string[] = [`# Ask-AI transcript — ${slug} / ${runner}`, ""];
  if (continueSessionId !== undefined) {
    lines.push(`> runtime session: ${continueSessionId}`, "");
  }
  for (const turn of turns) {
    const speaker =
      turn.role === "user"
        ? "You"
        : turn.role === "assistant"
          ? "Assistant"
          : turn.role === "tool"
            ? "Tool"
            : "Error";
    lines.push(`## ${speaker} — ${turn.ts}`, "", turn.text, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Runner selection
// ---------------------------------------------------------------------------

const RUNNER_IDS: readonly RunnerId[] = ["pi", "opencode", "claude-code", "codex"];
const DEFAULT_RUNNER: RunnerId = "pi";

function isRunnerId(value: string): value is RunnerId {
  return (RUNNER_IDS as readonly string[]).includes(value);
}

/**
 * The stored runner selection, validated against the ids a caller knows about
 * — the server's runners list when available, the static id union otherwise.
 * A stale/unknown value falls back to `"pi"` rather than being cast through.
 */
export function getSelectedRunner(availableIds?: readonly string[]): RunnerId {
  const raw = safeRead(SELECTION_KEY);
  if (raw !== null && isRunnerId(raw)) {
    if (availableIds === undefined || availableIds.includes(raw)) return raw;
  }
  return DEFAULT_RUNNER;
}

/** Persists the runner selection; unknown ids are refused (keeps the stored
 *  value intact — a stale picker must not corrupt the selection). */
export function setSelectedRunner(runner: RunnerId): void {
  if (!isRunnerId(runner)) return;
  safeWrite(SELECTION_KEY, runner);
  bump();
}

// ---------------------------------------------------------------------------
// History cap — what the next send carries as `history`
// ---------------------------------------------------------------------------

export interface HistoryCap {
  /** Ceiling on the number of user/assistant turns carried. */
  maxTurns?: number;
  /** Ceiling on total text characters carried. */
  maxChars?: number;
}

/**
 * The transcript tail a send carries as `history`: user/assistant turns, kept
 * as the NEWEST slice within the caps and RENDERED oldest-first — the overflow
 * (too old, or past the character budget) drops from the head, so the context
 * the runtime sees is the most recent slice of the conversation, never a hole
 * in it. Tool/error turns are not prompt material and never travel.
 */
export function historyForSend(
  conversation: AskConversation,
  options: HistoryCap = {},
): { role: "user" | "assistant"; text: string }[] {
  const maxTurns = options.maxTurns ?? 20;
  const maxChars = options.maxChars ?? 6000;
  const eligible = conversation.turns.filter(
    (turn): turn is AskStoredTurn & { role: "user" | "assistant" } =>
      turn.role === "user" || turn.role === "assistant",
  );
  const newest = eligible.slice(-Math.max(0, maxTurns));

  // Grow the kept window from the NEWEST end while it fits the budget — the
  // dropped prefix is exactly the "overflow head".
  let from = newest.length;
  let used = 0;
  for (let i = newest.length - 1; i >= 0; i -= 1) {
    const turn = newest[i];
    if (turn === undefined) continue;
    if (used + turn.text.length > maxChars) break;
    from = i;
    used += turn.text.length;
  }
  return newest.slice(from).map((turn) => ({ role: turn.role, text: turn.text }));
}

// ---------------------------------------------------------------------------
// React bindings over the store
// ---------------------------------------------------------------------------

/** The current conversation turns for one (slug, runner) pair, re-read on
 *  every store write — the client-side replacement for the deleted server
 *  transcript query. The subscription alone drives re-renders: the snapshot
 *  value is the change signal, and the conversation is read straight from the
 *  store on each render. */
export function useLocalTranscript(slug: string, runner: RunnerId): AskStoredTurn[] {
  useSyncExternalStore(subscribeAskStore, getAskStoreVersion);
  return getConversation(slug, runner).turns;
}

/** The selected runner, re-read on store writes and clamped against the
 *  server's runners list when it is available. */
export function useSelectedRunner(availableIds?: readonly string[]): RunnerId {
  useSyncExternalStore(subscribeAskStore, getAskStoreVersion);
  return getSelectedRunner(availableIds);
}
