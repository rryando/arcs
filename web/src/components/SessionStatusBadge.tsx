/**
 * Session state vocabulary: what state a session is in, which states can be
 * filtered on, which of them mean a session is still live or currently attached
 * to a process, and the glyph + badge that render one.
 *
 * Deriving, matching, classifying and rendering all live in this one module on
 * purpose. A session carries two state fields (persisted `status`, derived
 * `phase`), and the moment two call sites pick between them independently the
 * UI starts disagreeing with itself — a table badged `running` under an
 * `active` chip. Everything user-facing goes through `sessionState()`, so there
 * is nothing to keep in sync.
 *
 * The liveness predicates below take the RECORD for the same reason the badge
 * does: giving the badge a record protects badge call sites only, and a counter
 * or an affordance gate takes no badge prop. Handing them the record too is
 * what extends that protection past the badge.
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

/** States meaning "this session is not over": the live phases, plus the raw
 *  `active`/`idle` a record that arrived without a phase is badged with. */
const LIVE_STATES = new Set(["running", "idle", "active"]);

/** States meaning "a process is driving this session right now".
 *
 *  Deliberately NARROWER than `LIVE_STATES`, and the reason both sets belong in
 *  this module rather than at their call sites: `idle` is live — the record is
 *  not over and the session list counts it — but nothing holds its runtime
 *  thread, which is exactly the session a headless resume works on. One shared
 *  "live" set would silently conflate "not over" with "attached" and take the
 *  resume affordance away from every session that can actually use it.
 *
 *  REACHABLE PAIRS. The server's derivation (`deriveSessionPhase` →
 *  `reconcilePhase` → `runDeadlinePhase`, all composed in `withPhases`) can
 *  only ever produce these (`status`, `phase`) pairs, exhaustively:
 *
 *    active/idle · active/running · completed/ended · disconnected/ended ·
 *    failed/failed · idle/idle · idle/running
 *
 *  So `ended` comes ONLY from a terminal status (`completed`/`disconnected`):
 *  the derivation returns it before looking at any liveness evidence, the
 *  reconciler early-returns on every non-`running` derivation, and both probes
 *  can only demote `running` to `idle`. A record stored `active` whose process
 *  is gone therefore derives `idle` — "no fresh evidence of attachment" — and
 *  never `ended`. Both sit outside this set, so this predicate answers the same
 *  either way; the pair that carries the meaning is `active`/`idle`, because
 *  that is what "the process is gone" actually looks like on the wire. */
const ATTACHED_STATES = new Set(["running", "active"]);

/**
 * Is this a session a human could still reach — as the badge beside it reads?
 *
 * What the sessions header counts as "N live". Takes the record so the count is
 * computed from the same field the badge one row below renders, rather than
 * from whichever of the two a call site happened to reach for.
 *
 * This is the SAFE half of the pair: across the reachable pairs above, `status`
 * and `phase` never disagree about liveness. A record stored `active` whose
 * process is gone derives `idle`, and `idle` is live — the record is not over —
 * so the count is right read either way. That is a property of today's
 * derivation, not a guarantee; reading the record keeps the count correct if it
 * stops holding. `isSessionAttached` below is where the two genuinely disagree.
 */
export function isSessionLive(session: SessionStateSource): boolean {
  return LIVE_STATES.has(sessionState(session));
}

/**
 * Is a process driving this session right now?
 *
 * The gate on affordances that need the session's runtime thread free — today
 * the composer's headless resume, which cannot attach to a session a terminal
 * is already driving. Reading the persisted status here is wrong in BOTH
 * directions, and both are reachable pairs: a record stored `active` whose
 * process is gone derives `idle` — no fresh evidence of attachment — and would
 * be refused the resume it is the perfect candidate for (`active`/`idle`),
 * while a live `running` session stored `idle` would be offered one that cannot
 * work (`idle`/`running`). `idle` is the state the whole affordance turns on;
 * it is never `ended`, which only a terminal status produces.
 */
export function isSessionAttached(session: SessionStateSource): boolean {
  return ATTACHED_STATES.has(sessionState(session));
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
