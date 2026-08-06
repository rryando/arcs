/**
 * Session state vocabulary: what state a session is in, which states can be
 * filtered on, which of them mean a session is still live or currently attached
 * to a process, and the glyph + badge that render one.
 *
 * Matching, classifying and rendering live here; the DERIVATION itself lives in
 * `src/shared/session-vocabulary.ts`, a zero-import leaf the server route reads
 * too, so client and server cannot drift apart about what state a session is
 * in. `sessionState`, `isSessionLive`, `isSessionAttached` and
 * `SessionStateSource` are re-exported below, so every call site (and every
 * test) still imports the whole vocabulary from this one module.
 *
 * Every Tailwind class is written as a literal string in the lookup maps below.
 * Templated class names (`text-term-${x}`) are silently dropped by the Tailwind
 * scanner in plugin mode, so these maps must stay literal.
 */

import {
  isSessionAttached,
  isSessionLive,
  type SessionStateSource,
  sessionState,
} from "../../../src/shared/session-vocabulary.js";
import { cx } from "../lib/format";
import { Badge, type BadgeColor } from "./Badge";

export type { SessionStateSource };
export { isSessionAttached, isSessionLive, sessionState };

export const SESSION_STATUSES = ["active", "idle", "completed", "failed", "disconnected"] as const;

/** Derived liveness the server sends on session reads (`SessionMeta.phase`) —
 *  what this badge actually shows. Ordered live-first, with the raw statuses
 *  following in SESSION_STATE_ORDER for a record read from an endpoint that
 *  carries no phase. */
export const SESSION_PHASES = ["running", "idle", "failed", "ended"] as const;

/** Sort rank for whatever the badge is rendering — one ordering across both
 *  vocabularies, so a column showing phases sorts the way it reads. */
export const SESSION_STATE_ORDER: readonly string[] = [...SESSION_PHASES, ...SESSION_STATUSES];

/** Rank of one rendered state; anything unrecognised sorts last rather than
 *  first, which a bare `indexOf` would do with its -1. */
export function sessionStateRank(state: string): number {
  const index = SESSION_STATE_ORDER.indexOf(state);
  return index === -1 ? SESSION_STATE_ORDER.length : index;
}

/**
 * The sessions matching one filter chip — `null` being "all".
 *
 * Matching goes through `sessionState`, the same function the badge renders, so
 * a row can never appear under a chip its badge contradicts.
 */
export function filterSessionsByState<T extends SessionStateSource>(
  sessions: readonly T[],
  state: string | null,
): readonly T[] {
  return state === null ? sessions : sessions.filter((s) => sessionState(s) === state);
}

/**
 * The filter chips to offer for a list: the states actually on screen, ordered
 * live-first.
 *
 * Derived from the rows rather than fixed to `SESSION_PHASES` so the two ends
 * stay honest in both directions — every visible row has a chip that finds it,
 * and no chip is offered that matches nothing. A record that arrived without a
 * phase is badged with its raw status, so its raw status is offered too.
 */
export function sessionStateChips(
  sessions: readonly SessionStateSource[],
  active: string | null,
): string[] {
  const states = new Set(sessions.map(sessionState));
  // The active chip outlives its last row: without this, filtering to `running`
  // and watching that run end would leave an empty table and no lit chip to
  // click off.
  if (active) states.add(active);
  return [...states].sort((a, b) => sessionStateRank(a) - sessionStateRank(b));
}

export const SESSION_STATUS_GLYPH: Record<string, string> = {
  running: "●",
  ended: "○",
  active: "●",
  idle: "◐",
  completed: "✓",
  failed: "✕",
  disconnected: "○",
};

export const SESSION_STATUS_TEXT_CLASS: Record<string, string> = {
  running: "text-term-green",
  ended: "text-term-dim",
  active: "text-term-green",
  idle: "text-term-amber",
  completed: "text-term-cyan",
  failed: "text-term-red",
  disconnected: "text-term-dim",
};

export function sessionStatusColor(status: string): BadgeColor {
  switch (status) {
    case "running":
    case "active":
      return "green";
    case "idle":
      return "amber";
    case "completed":
      return "cyan";
    case "failed":
      return "red";
    default:
      return "dim";
  }
}

/**
 * Takes the record, not a status string: the badge derives what it shows so no
 * call site can hand it a stale persisted status while the table beside it
 * shows the live phase. That split is exactly what this component is for.
 */
export function SessionStatusBadge({ session }: { session: SessionStateSource }) {
  const state = sessionState(session);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cx("font-bold", SESSION_STATUS_TEXT_CLASS[state] ?? "text-term-dim")}>
        {SESSION_STATUS_GLYPH[state] ?? "•"}
      </span>
      <Badge color={sessionStatusColor(state)}>{state}</Badge>
    </span>
  );
}
