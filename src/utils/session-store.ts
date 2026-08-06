/**
 * Session CRUD storage for ARCS projects.
 *
 * Tracks agent runtime sessions (opencode, claude-code) that are attached to a
 * project. Unlike tasks/plans/knowledge these records are volatile runtime
 * state: they carry no markdown mirror and never invalidate the graph cache.
 */

import { join } from "node:path";
import {
  invalidSessionId,
  invalidSessionLink,
  itemNotFound,
  normalizedIdCollision,
} from "./errors.js";
import { withLock } from "./file-lock.js";
import { readJsonSafe } from "./json.js";
import { readPlanIndex } from "./plan-store.js";
import { normalizeIdentifier } from "./slug.js";
import {
  ensureDir,
  fileExists,
  nowISO,
  validateSessionLinkedNodeType,
  validateSessionRuntimeType,
  validateSessionStatus,
  writeJson,
} from "./storage-utils.js";
import { getTask } from "./task-store.js";

// ---------------------------------------------------------------------------
// Re-export types used by consumers
// ---------------------------------------------------------------------------

export type {
  SessionLinkedNodeType,
  SessionRuntimeType,
  SessionStatus,
} from "./storage-utils.js";
export {
  SESSION_LINKED_NODE_TYPES,
  SESSION_RUNTIME_TYPES,
  SESSION_STATUSES,
} from "./storage-utils.js";

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

/**
 * Where a session record came from — its provenance, not its state.
 *
 * - `observed` — a runtime session ARCS merely watches: a terminal `claude`
 *   session announcing itself through the hook bridge, or an opencode session
 *   discovered (or created) on a live opencode server. ARCS can nudge it, but
 *   something outside ARCS drives it.
 * - `arcs` — a record ARCS minted for itself (the headless oneshot/stable
 *   threads). No terminal is attached, so nothing ever drains its message
 *   queue; it is driven by headless runs only.
 *
 * Declared here rather than in storage-utils alongside the other session enums
 * because origin is derived by this module (legacy promotion below) and every
 * consumer already imports the session enums through this file.
 */
export const SESSION_ORIGINS = ["observed", "arcs"] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];

// ---------------------------------------------------------------------------
// Meta types
// ---------------------------------------------------------------------------

export interface SessionMeta {
  id: string;
  normalizedId: string;
  runtimeType: import("./storage-utils.js").SessionRuntimeType;
  /** Runtime-native session id, verbatim (e.g. opencode "ses_04f…"). */
  runtimeSessionId: string;
  /**
   * Provenance of the record. Persisted, never client-settable, and never
   * rewritten by an upsert — whoever created the record fixed it. Always
   * present on a value read through this module even when the stored record
   * predates the field (see `withDerivedOrigin`).
   */
  origin: SessionOrigin;
  status: import("./storage-utils.js").SessionStatus;
  startedAt: string;
  lastMessageAt?: string;
  updatedAt: string;
  userEmail?: string;
  /**
   * DAG node this session is working on. Always set together with
   * `linkedNodeId` — a half-set link is never persisted.
   */
  linkedNodeType?: import("./storage-utils.js").SessionLinkedNodeType;
  /** Normalized task/plan id — never a diagram node id (T001…). */
  linkedNodeId?: string;
  /**
   * Messages accepted from the web UI but not yet delivered. Only runtimes
   * without a live channel (claude-code) ever populate this: the runtime drains
   * the queue itself at its next checkpoint. Absent means "nothing pending".
   */
  messageQueue?: string[];
  /**
   * Id of the headless run currently claimed on this record — written when the
   * run is spawned and cleared when it settles (`beginSessionRun` /
   * `settleSessionRun`). Its presence IS the claim: a record carrying one is
   * believed to have a live `claude` child behind it.
   *
   * Written for the runs ARCS drives itself, so in practice every `arcs`-origin
   * thread; an `observed` record only carries one while a headless run targets
   * it. Deliberately absent from `UpdateSessionInput`: a claim is a fact about
   * a process, never something a caller hands in.
   */
  currentRunId?: string;
  /**
   * OS pid of the claimed run's child. Persisted because in-memory liveness
   * dies with the server and the restart case is exactly the one that has to be
   * recoverable — the startup sweep probes this pid to tell a live run from an
   * orphaned claim.
   */
  currentRunPid?: number;
  /**
   * ISO-8601 proof of life for the claimed run. Same unit as every other
   * top-level timestamp on this record; `metadata.run.*` keeps epoch ms and the
   * two never mix.
   *
   * SHORTCUT: nothing refreshes this mid-run yet, so it equals the run's spawn
   * time and RUN_HEARTBEAT_TTL_MS has to cover a whole run; upgrade to a
   * periodic touch (and a far shorter TTL) when the runner grows a heartbeat.
   */
  heartbeatAt?: string;
  /**
   * ISO-8601 time of the last runtime checkpoint ARCS observed — Claude Code's
   * `UserPromptSubmit` and `Stop` hooks. The only liveness evidence an
   * `observed` session ever produces: nothing else reports that a terminal
   * session is still working.
   */
  lastCheckpointAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionIndex {
  sessions: SessionMeta[];
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  runtimeType: import("./storage-utils.js").SessionRuntimeType;
  runtimeSessionId: string;
  /**
   * Provenance, set once at creation and defaulting to `observed`. Only the
   * ARCS-minted headless threads pass `arcs`. Deliberately absent from every
   * request schema: origin is what capability is derived from, so a client that
   * could set it could talk itself out of the queue refusal below.
   */
  origin?: SessionOrigin;
  status?: import("./storage-utils.js").SessionStatus;
  startedAt?: string;
  lastMessageAt?: string;
  userEmail?: string;
  metadata?: Record<string, unknown>;
  now?: string;
}

export interface UpdateSessionInput {
  id: string;
  status?: import("./storage-utils.js").SessionStatus;
  /** Pass `null` to clear; pass an ISO timestamp to set. */
  lastMessageAt?: string | null;
  /**
   * ISO timestamp of a runtime checkpoint just observed (`null` clears it).
   * Settable here — unlike the run claim — because a checkpoint is a report the
   * hook bridge relays, not a process ARCS owns.
   */
  lastCheckpointAt?: string | null;
  /** Pass `null` to clear; pass a string to set. */
  userEmail?: string | null;
  /** Pass `null` to clear; merged shallowly into the existing metadata. */
  metadata?: Record<string, unknown> | null;
  /**
   * Link target kind. `null` (on either linkage field) clears the whole link.
   * Setting a link requires both fields to resolve to a value.
   */
  linkedNodeType?: import("./storage-utils.js").SessionLinkedNodeType | null;
  /** Normalized task/plan id — validated against the task/plan store. */
  linkedNodeId?: string | null;
  /**
   * Whole-queue replacement (`null` clears it). Appending/draining goes through
   * `enqueueSessionMessage`/`drainSessionMessageQueue` instead — a shallow merge
   * cannot express those safely under concurrent access.
   */
  messageQueue?: string[] | null;
  now?: string;
}

export interface SessionFilters {
  status?: import("./storage-utils.js").SessionStatus;
  runtimeType?: import("./storage-utils.js").SessionRuntimeType;
}

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

/**
 * Fills in `origin` for a record persisted before the field existed.
 *
 * Legacy ARCS-minted records are recognisable by the marker the run route used
 * to write, `metadata.control === "arcs-owned"`; every other record was a
 * session ARCS observed. Promotion happens on READ, so there is no migration
 * script and no flag day: the derived value is persisted the next time the
 * record is written through this store. A record created after this change
 * always carries a real `origin`, so `metadata.control` can never influence it.
 */
function withDerivedOrigin(session: SessionMeta): SessionMeta {
  // Typed as required, but absent on disk for pre-origin records — and a
  // hand-edited index could hold anything, so validate rather than trust.
  const persisted: string | undefined = session.origin;
  if (persisted !== undefined && (SESSION_ORIGINS as readonly string[]).includes(persisted)) {
    return session;
  }
  return { ...session, origin: session.metadata?.control === "arcs-owned" ? "arcs" : "observed" };
}

export async function readSessionIndex(projectDir: string): Promise<SessionIndex> {
  const sessionsDir = join(projectDir, "sessions");
  if (!(await fileExists(sessionsDir))) {
    return { sessions: [] };
  }
  const indexPath = join(sessionsDir, "index.json");
  const index = await readJsonSafe<SessionIndex>(indexPath);
  if (!index || !Array.isArray(index.sessions)) {
    return { sessions: [] };
  }
  // Every read path in this module funnels through here, so the promotion is
  // applied exactly once — reads, writes and capability checks all agree.
  return { sessions: index.sessions.map(withDerivedOrigin) };
}

/**
 * Capability: may a message be handed to this session through `messageQueue`?
 *
 * Queued delivery only works when something drains the queue, and the only
 * drainer is the Claude Code hook script running inside a real terminal
 * session — an `observed` claude-code record. An `arcs`-origin thread has no
 * terminal attached, so a message queued for it would sit there forever
 * (that black hole is what the queue refusal on POST /message closes), and
 * opencode records take live injection instead of ever queueing.
 *
 * Derived from `origin`, never from a metadata string.
 */
export function canQueue(session: SessionMeta): boolean {
  return session.origin === "observed" && session.runtimeType === "claude-code";
}

// ---------------------------------------------------------------------------
// Derived phase
// ---------------------------------------------------------------------------

/**
 * What a session is doing right now, as a reader of the UI would say it.
 *
 * DERIVED, never stored: there is no `phase` field on `SessionMeta` and no way
 * to write one through this module. A stored phase is a second source of truth
 * that goes stale the instant a process dies without telling anyone — which is
 * precisely the "stuck on running forever" failure this replaces.
 */
export const SESSION_PHASES = ["running", "idle", "failed", "ended"] as const;
export type SessionPhase = (typeof SESSION_PHASES)[number];

/**
 * Outcome vocabulary persisted on `metadata.run.outcome`. A superset of the
 * runner's own `RunOutcome` ("success" | "error" | "timeout"): `interrupted` is
 * never produced BY a run, it is written FOR a run whose process disappeared
 * without ever settling — a restart's orphan. Declared here rather than
 * imported from the web server because `utils/` must not depend on
 * `web-server/`; claude-runner's union stays exactly what a child can return.
 */
export const SESSION_RUN_OUTCOMES = ["success", "error", "timeout", "interrupted"] as const;
export type SessionRunOutcome = (typeof SESSION_RUN_OUTCOMES)[number];

/**
 * How long a run claim's heartbeat counts as proof of life. Sized to the
 * runner's default 10-minute run ceiling because nothing refreshes the
 * heartbeat mid-run yet (see `SessionMeta.heartbeatAt`) — a shorter window
 * would demote a perfectly healthy long run to `idle`.
 */
export const RUN_HEARTBEAT_TTL_MS = 10 * 60 * 1000;

/**
 * How long a runtime checkpoint counts as proof of life for an observed
 * session. Deliberately shorter than the run TTL: checkpoints arrive at every
 * prompt and every turn end, so a terminal that has produced neither in five
 * minutes is waiting on a human, not working.
 */
export const CHECKPOINT_TTL_MS = 5 * 60 * 1000;

export interface SessionPhaseOptions {
  /** Clock in epoch ms; defaults to `Date.now()`. */
  now?: number;
  heartbeatTtlMs?: number;
  checkpointTtlMs?: number;
}

/**
 * The record's run claim, or `undefined` when it holds none. Validated rather
 * than trusted: a hand-edited index can carry anything under this key.
 */
export function sessionRunClaim(session: SessionMeta): string | undefined {
  const runId: unknown = session.currentRunId;
  return typeof runId === "string" && runId !== "" ? runId : undefined;
}

/** Whether an ISO timestamp is within `ttlMs` of `now` (epoch ms). */
function isFresh(timestamp: string | undefined, now: number, ttlMs: number): boolean {
  if (typeof timestamp !== "string" || timestamp === "") return false;
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return false;
  // A future timestamp (clock skew between the hook script and the server)
  // still counts as fresh — only age ever demotes.
  return now - at <= ttlMs;
}

/**
 * Derives a session's phase from its own persisted evidence, in one place.
 *
 * Precedence, strongest first:
 *  1. a terminal `status` — `failed` is `failed`, `completed`/`disconnected`
 *     are `ended`. Nothing observed later reopens a session that is over.
 *  2. a run claim (`currentRunId`) — ARCS spawned a child for this record, so
 *     its `heartbeatAt` is the freshest evidence there is. Stale means the
 *     claim outlived its proof of life, which reads `idle`, not `failed`: the
 *     run is settled by the reconciler, not guessed at here.
 *  3. `lastCheckpointAt` — the only signal an observed terminal session emits.
 *
 * `metadata.run.outcome` is deliberately NOT an input. That field is run-level
 * history (rendered next to the run), while phase answers "is this session live
 * right now" — a run that failed an hour ago leaves the session idle and ready
 * for the next one, not permanently `failed`.
 *
 * Pure: a record plus a clock, no I/O, no process probing. Liveness that needs
 * the world (a pid, `claude agents`) belongs to the reconciler, which starts
 * from this value and can only ever demote it.
 *
 * SHORTCUT: checkpoint freshness cannot tell `UserPromptSubmit` (turn started)
 * from `Stop` (turn ended), so a session reads `running` for the TTL after its
 * last turn; upgrade to a persisted checkpoint kind when the panel needs
 * turn-level precision.
 */
export function deriveSessionPhase(
  session: SessionMeta,
  options: SessionPhaseOptions = {},
): SessionPhase {
  if (session.status === "failed") return "failed";
  if (session.status === "completed" || session.status === "disconnected") return "ended";

  const now = options.now ?? Date.now();
  if (sessionRunClaim(session) !== undefined) {
    const ttlMs = options.heartbeatTtlMs ?? RUN_HEARTBEAT_TTL_MS;
    return isFresh(session.heartbeatAt, now, ttlMs) ? "running" : "idle";
  }
  const ttlMs = options.checkpointTtlMs ?? CHECKPOINT_TTL_MS;
  return isFresh(session.lastCheckpointAt, now, ttlMs) ? "running" : "idle";
}

function sessionStoreLockPath(projectDir: string): string {
  return join(projectDir, "sessions", ".store");
}

async function writeSessionState(projectDir: string, index: SessionIndex): Promise<void> {
  const sessionsDir = join(projectDir, "sessions");
  await ensureDir(sessionsDir);
  await writeJson(join(sessionsDir, "index.json"), index);
}

function buildSession(input: CreateSessionInput, normalizedId: string): SessionMeta {
  const ts = nowISO(input.now);
  return {
    id: normalizedId,
    normalizedId,
    runtimeType: input.runtimeType,
    runtimeSessionId: input.runtimeSessionId,
    origin: input.origin ?? "observed",
    status: input.status ?? "active",
    startedAt: input.startedAt ?? ts,
    ...(input.lastMessageAt && { lastMessageAt: input.lastMessageAt }),
    updatedAt: ts,
    ...(input.userEmail && { userEmail: input.userEmail }),
    ...(input.metadata && { metadata: input.metadata }),
  };
}

/**
 * Validates a create/upsert payload and returns the canonical normalized id.
 * Runtime session ids are opaque runtime-native strings, so the only structural
 * requirement is that they normalize to a non-empty identifier.
 */
function validateCreateInput(input: CreateSessionInput): string {
  validateSessionRuntimeType(input.runtimeType);
  validateSessionStatus(input.status ?? "active");
  const normalizedId = normalizeIdentifier(input.runtimeSessionId);
  if (!normalizedId) {
    throw invalidSessionId(input.runtimeSessionId);
  }
  return normalizedId;
}

/**
 * Resolves a link target against the task/plan store and returns its canonical
 * normalized id. Throws `ITEM_NOT_FOUND` when the target does not exist, so a
 * session can never point at a task/plan that was never created (or was
 * deleted). There is no cross-store validation helper to share here — the
 * task/plan stores are the only source of truth for their own ids.
 */
async function resolveLinkedNodeId(
  projectDir: string,
  nodeType: import("./storage-utils.js").SessionLinkedNodeType,
  nodeId: string,
): Promise<string> {
  if (nodeType === "task") {
    return (await getTask(projectDir, nodeId)).normalizedId;
  }
  const normalizedId = normalizeIdentifier(nodeId);
  const { plans } = await readPlanIndex(projectDir);
  const plan = plans.find((p) => p.normalizedId === normalizedId);
  if (!plan) {
    throw itemNotFound("plan", nodeId);
  }
  return plan.normalizedId;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function createSessionUnlocked(
  projectDir: string,
  input: CreateSessionInput,
): Promise<SessionMeta> {
  const normalizedId = validateCreateInput(input);
  const index = await readSessionIndex(projectDir);

  if (index.sessions.some((s) => s.normalizedId === normalizedId)) {
    throw normalizedIdCollision("session", input.runtimeSessionId, normalizedId);
  }

  const meta = buildSession(input, normalizedId);
  index.sessions.push(meta);
  await writeSessionState(projectDir, index);
  return meta;
}

export async function createSession(
  projectDir: string,
  input: CreateSessionInput,
): Promise<SessionMeta> {
  await ensureDir(join(projectDir, "sessions"));
  return withLock(sessionStoreLockPath(projectDir), () => createSessionUnlocked(projectDir, input));
}

async function upsertSessionUnlocked(
  projectDir: string,
  input: CreateSessionInput,
): Promise<SessionMeta> {
  const normalizedId = validateCreateInput(input);
  const index = await readSessionIndex(projectDir);
  const existingIndex = index.sessions.findIndex((s) => s.normalizedId === normalizedId);

  if (existingIndex === -1) {
    const meta = buildSession(input, normalizedId);
    index.sessions.push(meta);
    await writeSessionState(projectDir, index);
    return meta;
  }

  const existing = index.sessions[existingIndex];
  // `origin` is deliberately absent from this merge: it is provenance, so the
  // creating writer fixes it for good. A hook observation must not demote an
  // ARCS-owned thread (that would reopen the queue black hole), and an ARCS run
  // claiming an existing record as its write-target must not erase the fact
  // that a real terminal session is attached to it.
  const merged: SessionMeta = {
    ...existing,
    runtimeType: input.runtimeType,
    runtimeSessionId: input.runtimeSessionId,
    ...(input.status && { status: input.status }),
    ...(input.startedAt && { startedAt: input.startedAt }),
    ...(input.lastMessageAt && { lastMessageAt: input.lastMessageAt }),
    ...(input.userEmail && { userEmail: input.userEmail }),
    ...(input.metadata && { metadata: { ...existing.metadata, ...input.metadata } }),
    updatedAt: nowISO(input.now),
  };
  index.sessions[existingIndex] = merged;
  await writeSessionState(projectDir, index);
  return merged;
}

/**
 * Create-or-update by runtime session id. Used by runtime discovery bridges,
 * which see the same session many times and must stay idempotent.
 *
 * Deliberately never touches `linkedNodeType`/`linkedNodeId`: discovery
 * refreshes carry status/metadata only and must not silently unlink a session
 * a human just linked. Linkage is `updateSession`-only.
 */
export async function upsertSession(
  projectDir: string,
  input: CreateSessionInput,
): Promise<SessionMeta> {
  await ensureDir(join(projectDir, "sessions"));
  return withLock(sessionStoreLockPath(projectDir), () => upsertSessionUnlocked(projectDir, input));
}

export async function listSessions(
  projectDir: string,
  filters?: SessionFilters,
): Promise<SessionMeta[]> {
  const index = await readSessionIndex(projectDir);
  let sessions = index.sessions;

  if (filters?.status) {
    sessions = sessions.filter((s) => s.status === filters.status);
  }
  if (filters?.runtimeType) {
    sessions = sessions.filter((s) => s.runtimeType === filters.runtimeType);
  }

  return sessions;
}

export async function getSession(projectDir: string, sessionId: string): Promise<SessionMeta> {
  const normalizedId = normalizeIdentifier(sessionId);
  const index = await readSessionIndex(projectDir);
  const session = index.sessions.find((s) => s.normalizedId === normalizedId);
  if (!session) {
    throw itemNotFound("session", sessionId);
  }
  return session;
}

async function updateSessionUnlocked(
  projectDir: string,
  input: UpdateSessionInput,
): Promise<SessionMeta> {
  if (input.status !== undefined) {
    validateSessionStatus(input.status);
  }

  const normalizedId = normalizeIdentifier(input.id);
  const index = await readSessionIndex(projectDir);
  const sessionIndex = index.sessions.findIndex((s) => s.normalizedId === normalizedId);
  if (sessionIndex === -1) {
    throw itemNotFound("session", input.id);
  }
  const session = index.sessions[sessionIndex];

  if (input.status !== undefined) session.status = input.status;
  if (input.lastMessageAt !== undefined) {
    if (input.lastMessageAt === null || input.lastMessageAt === "") {
      delete session.lastMessageAt;
    } else {
      session.lastMessageAt = input.lastMessageAt;
    }
  }
  if (input.lastCheckpointAt !== undefined) {
    if (input.lastCheckpointAt === null || input.lastCheckpointAt === "") {
      delete session.lastCheckpointAt;
    } else {
      session.lastCheckpointAt = input.lastCheckpointAt;
    }
  }
  if (input.userEmail !== undefined) {
    if (input.userEmail === null || input.userEmail === "") {
      delete session.userEmail;
    } else {
      session.userEmail = input.userEmail;
    }
  }
  if (input.metadata !== undefined) {
    if (input.metadata === null) {
      delete session.metadata;
    } else {
      session.metadata = { ...session.metadata, ...input.metadata };
    }
  }
  if (input.messageQueue !== undefined) {
    if (input.messageQueue === null || input.messageQueue.length === 0) {
      delete session.messageQueue;
    } else {
      session.messageQueue = [...input.messageQueue];
    }
  }
  if (input.linkedNodeType !== undefined || input.linkedNodeId !== undefined) {
    const clearing =
      input.linkedNodeType === null || input.linkedNodeId === null || input.linkedNodeId === "";
    if (clearing) {
      // Unlinking is atomic: both halves go, never one without the other.
      delete session.linkedNodeType;
      delete session.linkedNodeId;
    } else {
      const nodeType = input.linkedNodeType ?? session.linkedNodeType;
      const nodeId = input.linkedNodeId ?? session.linkedNodeId;
      if (!nodeType || !nodeId) {
        throw invalidSessionLink("linkedNodeType and linkedNodeId must be set together");
      }
      validateSessionLinkedNodeType(nodeType);
      session.linkedNodeId = await resolveLinkedNodeId(projectDir, nodeType, nodeId);
      session.linkedNodeType = nodeType;
    }
  }
  session.updatedAt = nowISO(input.now);

  index.sessions[sessionIndex] = session;
  await writeSessionState(projectDir, index);
  return session;
}

export async function updateSession(
  projectDir: string,
  input: UpdateSessionInput,
): Promise<SessionMeta> {
  await ensureDir(join(projectDir, "sessions"));
  return withLock(sessionStoreLockPath(projectDir), () => updateSessionUnlocked(projectDir, input));
}

function findSessionIndex(index: SessionIndex, sessionId: string): number {
  const normalizedId = normalizeIdentifier(sessionId);
  const position = index.sessions.findIndex((s) => s.normalizedId === normalizedId);
  if (position === -1) {
    throw itemNotFound("session", sessionId);
  }
  return position;
}

async function enqueueSessionMessageUnlocked(
  projectDir: string,
  sessionId: string,
  message: string,
): Promise<SessionMeta> {
  const index = await readSessionIndex(projectDir);
  const position = findSessionIndex(index, sessionId);
  const session = index.sessions[position];

  session.messageQueue = [...(session.messageQueue ?? []), message];
  session.updatedAt = nowISO();

  index.sessions[position] = session;
  await writeSessionState(projectDir, index);
  return session;
}

/**
 * Appends a message to a session's pending queue.
 *
 * Deliberately not part of `updateSession`: the generic path shallow-merges
 * whatever the caller passes, which would let two concurrent senders read the
 * same array and write back a queue missing one message. Append happens inside
 * the store lock, so the read-modify-write is atomic.
 *
 * The message is stored verbatim — callers validate content (the route rejects
 * empty strings before it gets here).
 */
export async function enqueueSessionMessage(
  projectDir: string,
  sessionId: string,
  message: string,
): Promise<SessionMeta> {
  await ensureDir(join(projectDir, "sessions"));
  return withLock(sessionStoreLockPath(projectDir), () =>
    enqueueSessionMessageUnlocked(projectDir, sessionId, message),
  );
}

async function drainSessionMessageQueueUnlocked(
  projectDir: string,
  sessionId: string,
): Promise<string[]> {
  const index = await readSessionIndex(projectDir);
  const position = findSessionIndex(index, sessionId);
  const session = index.sessions[position];

  const drained = session.messageQueue ?? [];
  if (drained.length === 0) {
    // Nothing pending — the common case at a checkpoint. Skip the write so an
    // idle session's index.json does not churn on every prompt.
    return [];
  }

  delete session.messageQueue;
  session.lastMessageAt = nowISO();
  session.updatedAt = session.lastMessageAt;

  index.sessions[position] = session;
  await writeSessionState(projectDir, index);
  return drained;
}

/**
 * Reads and clears a session's pending queue in one lock acquisition.
 *
 * Read-then-clear must be atomic: a checkpoint that read the queue and cleared
 * it in two calls would drop any message enqueued in between. Delivery is
 * at-most-once — a consumer that crashes after draining loses the batch, which
 * is the accepted trade for never replaying a message twice into a session.
 */
export async function drainSessionMessageQueue(
  projectDir: string,
  sessionId: string,
): Promise<string[]> {
  await ensureDir(join(projectDir, "sessions"));
  return withLock(sessionStoreLockPath(projectDir), () =>
    drainSessionMessageQueueUnlocked(projectDir, sessionId),
  );
}

// ---------------------------------------------------------------------------
// Run claims
// ---------------------------------------------------------------------------

export interface BeginSessionRunInput {
  /** Caller-minted id for this run — the claim's identity. */
  runId: string;
  /** OS pid of the spawned child; absent/`null` when the spawn produced none. */
  pid?: number | null;
  /** ISO override for the heartbeat and `updatedAt` stamps (tests). */
  now?: string;
}

export interface SettleSessionRunInput {
  /**
   * Settles only when it matches the persisted claim. Omit to settle whatever
   * claim is there (the startup sweep passes the id it read, so a run that
   * started in between is never settled out from under itself).
   */
  runId?: string;
  outcome: SessionRunOutcome;
  error?: string;
  /** Epoch ms for `metadata.run.endedAt` — defaults to now. */
  endedAt?: number;
  /**
   * Extra `metadata.run` fields stamped in the SAME write as the outcome: what
   * the RUNNER measured and no claim could have known at spawn (the pid and
   * startedAt the child actually reported, the run's mode, the stream
   * observations). Merged UNDER the settle's own fields, so `outcome`/`endedAt`/
   * `error` can never be smuggled past the settle that owns them.
   */
  run?: Record<string, unknown>;
  /**
   * Sibling `metadata` keys written in the same read-modify-write, shallow
   * merged as `updateSession` merges. The seed-decision repair rides here: a
   * settle that released the claim in one write and repaired the record in a
   * second is readable in between as "this run failed" while still carrying the
   * seed state that failed it — and the second write can land AFTER a newer run
   * has already claimed the record, clobbering its live `metadata.run`. Merged
   * UNDER `run`, so `run` can never be rewritten through this door.
   */
  metadata?: Record<string, unknown>;
  /** ISO override for `updatedAt` (tests). */
  now?: string;
}

/** Epoch ms for an ISO stamp, falling back to now for an unparsable override. */
function epochMs(isoTimestamp: string): number {
  const parsed = Date.parse(isoTimestamp);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** Existing `metadata.run` as a mergeable object — anything else reads empty. */
function existingRunMetadata(session: SessionMeta): Record<string, unknown> {
  const run = session.metadata?.run;
  if (typeof run !== "object" || run === null || Array.isArray(run)) return {};
  return run as Record<string, unknown>;
}

async function beginSessionRunUnlocked(
  projectDir: string,
  sessionId: string,
  input: BeginSessionRunInput,
): Promise<SessionMeta> {
  const index = await readSessionIndex(projectDir);
  const position = findSessionIndex(index, sessionId);
  const session = index.sessions[position];
  const ts = nowISO(input.now);
  const pid =
    typeof input.pid === "number" && Number.isInteger(input.pid) && input.pid > 0
      ? input.pid
      : undefined;

  session.currentRunId = input.runId;
  if (pid === undefined) delete session.currentRunPid;
  else session.currentRunPid = pid;
  session.heartbeatAt = ts;
  // A fresh claim REPLACES metadata.run rather than merging into it: one run
  // object per record, so a live claim can never sit next to the previous run's
  // outcome. Epoch ms here, matching every other metadata.run timestamp.
  session.metadata = {
    ...session.metadata,
    run: { runId: input.runId, pid: pid ?? null, startedAt: epochMs(ts) },
  };
  session.updatedAt = ts;

  index.sessions[position] = session;
  await writeSessionState(projectDir, index);
  return session;
}

/**
 * Claims a session for a headless run: persists the run id, the child's pid and
 * the first heartbeat, all of which survive the server process that made them.
 *
 * The claim is what makes a run recoverable. In-memory liveness (the runner's
 * `liveRuns` map) dies with the server, so without a persisted claim a run
 * interrupted by a restart would leave the session reading `running` forever
 * with nothing left that could ever settle it.
 */
export async function beginSessionRun(
  projectDir: string,
  sessionId: string,
  input: BeginSessionRunInput,
): Promise<SessionMeta> {
  await ensureDir(join(projectDir, "sessions"));
  return withLock(sessionStoreLockPath(projectDir), () =>
    beginSessionRunUnlocked(projectDir, sessionId, input),
  );
}

async function settleSessionRunUnlocked(
  projectDir: string,
  sessionId: string,
  input: SettleSessionRunInput,
): Promise<SessionMeta> {
  const index = await readSessionIndex(projectDir);
  const position = findSessionIndex(index, sessionId);
  const session = index.sessions[position];

  const claim = sessionRunClaim(session);
  // Either there is nothing to settle, or a newer run already owns the record.
  // Both mean the caller is settling a run that is no longer current, so the
  // record is left byte-identical — no write, no churn, no clobbered outcome.
  if (claim === undefined) return session;
  if (input.runId !== undefined && input.runId !== claim) return session;

  const ts = nowISO(input.now);
  const run: Record<string, unknown> = {
    ...existingRunMetadata(session),
    ...input.run,
    outcome: input.outcome,
    endedAt: input.endedAt ?? epochMs(ts),
    ...(input.error !== undefined && { error: input.error }),
  };

  // The claim and its proof of life go together: a heartbeat left behind on a
  // settled record would be evidence for a process that is no longer running.
  delete session.currentRunId;
  delete session.currentRunPid;
  delete session.heartbeatAt;
  session.metadata = { ...session.metadata, ...input.metadata, run };
  session.updatedAt = ts;

  index.sessions[position] = session;
  await writeSessionState(projectDir, index);
  return session;
}

/**
 * Releases a session's run claim, records how the run ended on `metadata.run`,
 * and applies whatever the settle repaired — in ONE lock acquisition.
 *
 * Read-modify-write has to be atomic: `metadata.run` is replaced wholesale by
 * every writer, so settling through the generic `updateSession` would race the
 * route's own write-back and could drop the run's pid/startedAt.
 *
 * Everything a settle concludes therefore goes in HERE rather than in a
 * follow-up `updateSession`. The claim is the only thing serializing a run
 * against the next one, and releasing it is the LAST thing this write does — so
 * a conclusion left to a second write is both observable in the gap (the record
 * reads settled while still carrying the state the run just disproved) and
 * unguarded outside it: the `input.runId` check above holds only for the
 * duration of this lock, and a newer run can claim the record the moment it is
 * released.
 */
export async function settleSessionRun(
  projectDir: string,
  sessionId: string,
  input: SettleSessionRunInput,
): Promise<SessionMeta> {
  await ensureDir(join(projectDir, "sessions"));
  return withLock(sessionStoreLockPath(projectDir), () =>
    settleSessionRunUnlocked(projectDir, sessionId, input),
  );
}

async function deleteSessionUnlocked(projectDir: string, sessionId: string): Promise<void> {
  const normalizedId = normalizeIdentifier(sessionId);
  const index = await readSessionIndex(projectDir);
  const session = index.sessions.find((s) => s.normalizedId === normalizedId);
  if (!session) {
    throw itemNotFound("session", sessionId);
  }

  index.sessions = index.sessions.filter((s) => s.normalizedId !== normalizedId);
  await writeSessionState(projectDir, index);
}

export async function deleteSession(projectDir: string, sessionId: string): Promise<void> {
  await ensureDir(join(projectDir, "sessions"));
  await withLock(sessionStoreLockPath(projectDir), () =>
    deleteSessionUnlocked(projectDir, sessionId),
  );
}
