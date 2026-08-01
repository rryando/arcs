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
// Meta types
// ---------------------------------------------------------------------------

export interface SessionMeta {
  id: string;
  normalizedId: string;
  runtimeType: import("./storage-utils.js").SessionRuntimeType;
  /** Runtime-native session id, verbatim (e.g. opencode "ses_04f…"). */
  runtimeSessionId: string;
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
  return { sessions: index.sessions };
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
