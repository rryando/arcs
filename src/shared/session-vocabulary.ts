/**
 * Session-state vocabulary — the ONE derivation both sides of the wire read.
 *
 * A session carries two state fields: `status`, persisted by the store, and
 * `phase`, derived per response and never persisted. The moment two call sites
 * pick between them independently the product starts disagreeing with itself —
 * a table badged `running` under an `active` chip, or a server refusing the
 * resume the client just offered. Everything user-facing and every server gate
 * goes through `sessionState()` here, so there is nothing to keep in sync.
 *
 * The predicates take the RECORD, never a pre-picked string, for the same
 * reason the badge component does: handing the badge a record protects badge
 * call sites only, and a counter or an affordance gate takes no badge prop.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE MUST HAVE ZERO IMPORTS. Do not add one — not a type-only import,
 * not a `import type { SessionMeta }` for the parameter shapes below.
 *
 * `web/` imports this file directly by relative path (there is no alias and no
 * third package). Its being a LEAF — not the directory it sits in — is the
 * entire guarantee that no server module graph is dragged into the client
 * bundle. One import of anything under `src/utils/` or `src/web-server/` and
 * the CLI's transitive graph starts resolving inside `vite build`.
 *
 * The corollary of that reach: this file is typechecked under BOTH tsconfigs,
 * and `web/tsconfig.json` sets `noUncheckedIndexedAccess` and
 * `verbatimModuleSyntax` where the root tsconfig sets neither. A root-legal
 * edit here can fail `npm --workspace @arcs/web run typecheck`. Run both.
 * ---------------------------------------------------------------------------
 */

/**
 * The two fields a session's state is read from — all this module ever needs of
 * a record, so a store record, a reconciled server view and a wire-shaped
 * client record can all be filtered, gated and badged through one derivation.
 *
 * Typed as plain strings rather than the `SessionStatus`/`SessionPhase` literal
 * unions on purpose. Pinning those here would mean either an import (forbidden
 * above) or a third hand-written copy of the wire vocabulary that the server
 * store and `web/src/api/client.ts` already mirror deliberately. What is shared
 * across the boundary is the DERIVATION, not the wire types; every caller keeps
 * passing its own precisely-typed record, which is assignable to this.
 */
export interface SessionStateSource {
  status: string;
  phase?: string;
}

/**
 * The state a session is in, as the UI states it everywhere and as the server
 * decides from: the derived phase — the only signal reflecting whether the
 * session is live right now — falling back to the record's own status for a
 * record that reached a decision site without one (the record echoed by
 * `POST /run` carries no phase, and neither does a pre-phase endpoint).
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

/**
 * States meaning "a process is driving this session right now".
 *
 * Deliberately NARROWER than `LIVE_STATES`, and the reason both sets are
 * private to this module rather than living at their call sites: `idle` is live
 * — the record is not over and the session list counts it — but nothing holds
 * its runtime thread, which is exactly the session a headless resume works on.
 * One shared "live" set would silently conflate "not over" with "attached" and
 * take the resume affordance away from every session that can actually use it.
 *
 * REACHABLE PAIRS. The server's derivation (`deriveSessionPhase` →
 * `reconcilePhase` → `runDeadlinePhase`, all composed in `withPhases`) can only
 * ever produce these (`status`, `phase`) pairs, exhaustively:
 *
 *   active/idle · active/running · completed/ended · disconnected/ended ·
 *   failed/failed · idle/idle · idle/running
 *
 * So `ended` comes ONLY from a terminal status (`completed`/`disconnected`):
 * the derivation returns it before looking at any liveness evidence, the
 * reconciler early-returns on every non-`running` derivation, and both probes
 * can only demote `running` to `idle`. A record stored `active` whose process
 * is gone therefore derives `idle` — "no fresh evidence of attachment" — and
 * never `ended`. Both sit outside this set, so this predicate answers the same
 * either way; the pair that carries the meaning is `active`/`idle`, because
 * that is what "the process is gone" actually looks like on the wire.
 *
 * `active` itself is a persisted status, reachable only through
 * `sessionState`'s fallback for a record handed to a predicate without a
 * derived phase. Server call sites go through `withPhases` first, so the phase
 * decides in practice; the fallback is the conservative answer for anything
 * that does not — treat as attached and refuse, rather than silently accept.
 */
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
 * the composer's headless resume and the server route behind it, neither of
 * which can attach to a session a terminal is already driving. Reading the
 * persisted status here is wrong in BOTH directions, and both are reachable
 * pairs: a record stored `active` whose process is gone derives `idle` — no
 * fresh evidence of attachment — and would be refused the resume it is the
 * perfect candidate for (`active`/`idle`), while a live `running` session
 * stored `idle` would be offered one that cannot work (`idle`/`running`).
 * `idle` is the state the whole affordance turns on; it is never `ended`, which
 * only a terminal status produces.
 */
export function isSessionAttached(session: SessionStateSource): boolean {
  return ATTACHED_STATES.has(sessionState(session));
}
