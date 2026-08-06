/**
 * Session state vocabulary: what state a session is in, which states can be
 * filtered on, and the glyph + badge that render one.
 *
 * Deriving, matching and rendering all live in this one module on purpose. A
 * session carries two state fields (persisted `status`, derived `phase`), and
 * the moment two call sites pick between them independently the UI starts
 * disagreeing with itself — a table badged `running` under an `active` chip.
 * Everything user-facing goes through `sessionState()`, so there is nothing to
 * keep in sync.
 *
 * Every Tailwind class is written as a literal string in the lookup maps below.
 * Templated class names (`text-term-${x}`) are silently dropped by the Tailwind
 * scanner in plugin mode, so these maps must stay literal.
 */

import type { SessionMeta } from "../api/client";
import { cx } from "../lib/format";
import { Badge, type BadgeColor } from "./Badge";

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

/** The two fields a session's state is read from — all this module ever needs
 *  of a record, so lists of either shape can be filtered and badged. */
export type SessionStateSource = Pick<SessionMeta, "status" | "phase">;

/**
 * The state a session is in, as the UI states it everywhere: the server's
 * derived phase — the only signal that reflects whether the session is live
 * right now — falling back to the record's own status for a session that
 * reached the UI without one (the record echoed by `POST /run` carries no
 * phase, and neither does a pre-phase endpoint).
 *
 * This is the single derivation site. `status` is still readable on the row
 * (the status cell's tooltip), but nothing decides anything from it alone.
 */
export function sessionState(session: SessionStateSource): string {
  return session.phase ?? session.status;
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
