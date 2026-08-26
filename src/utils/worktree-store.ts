/**
 * Worktree registry storage for ARCS projects.
 *
 * Maps plans to their dedicated git worktrees (one plan = one tree).
 * The registry is a plain JSON file (`worktrees.json`) in the project
 * data directory; git state itself is never consulted here — callers
 * cross-check registry rows against `git worktree list`.
 */

import { basename, join, resolve } from "node:path";
import { invalidateGraphCache } from "../retrieval/graph-invalidate.js";
import { withLock } from "./file-lock.js";
import { readJsonSafe } from "./json.js";
import { normalizeIdentifier } from "./slug.js";
import { ensureDir, nowISO, writeJson } from "./storage-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorktreeEntry {
  planId: string;
  /** Absolute path to the worktree checkout. */
  path: string;
  /** Branch checked out in the worktree (e.g. `arcs/<plan-id>`). */
  branch: string;
  /** Commit the worktree branched from, when known. */
  baseCommit?: string;
  createdAt: string;
}

export interface UpsertWorktreeInput {
  planId: string;
  path: string;
  branch: string;
  baseCommit?: string;
}

interface WorktreeRegistryFile {
  worktrees: unknown[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WORKTREES_FILE = "worktrees.json";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function registryPath(projectDir: string): string {
  return join(projectDir, WORKTREES_FILE);
}

/**
 * A registry row is usable only when its core fields are strings. Malformed
 * rows are dropped rather than failing the whole read — a hand-edited or
 * partially-written file degrades to "fewer worktrees registered", which
 * `validate` surfaces as drift instead of crashing commands.
 */
function sanitizeRows(rows: unknown[]): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const candidate = row as Partial<WorktreeEntry>;
    if (
      typeof candidate.planId === "string" &&
      candidate.planId &&
      typeof candidate.path === "string" &&
      candidate.path &&
      typeof candidate.branch === "string" &&
      candidate.branch
    ) {
      out.push({
        planId: candidate.planId,
        path: candidate.path,
        branch: candidate.branch,
        ...(typeof candidate.baseCommit === "string" && { baseCommit: candidate.baseCommit }),
        createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : "",
      });
    }
  }
  return out;
}

/** Normalize a registered path so collision checks compare like with like. */
function normalizeEntryPath(path: string): string {
  return resolve(path.replace(/\\/g, "/"));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read all worktree registrations for a project. Missing or corrupt file
 * yields an empty registry (fail open); malformed rows are skipped.
 */
export async function readWorktreeRegistry(projectDir: string): Promise<WorktreeEntry[]> {
  const data = await readJsonSafe<WorktreeRegistryFile>(registryPath(projectDir));
  if (!data || !Array.isArray(data.worktrees)) {
    return [];
  }
  return sanitizeRows(data.worktrees);
}

/**
 * Insert or update a worktree registration keyed by normalized plan id.
 * Existing `createdAt` is preserved on update; path/branch/baseCommit are
 * refreshed. Returns the persisted row.
 */
export async function upsertWorktreeEntry(
  projectDir: string,
  input: UpsertWorktreeInput,
): Promise<WorktreeEntry> {
  await ensureDir(projectDir);

  const planId = normalizeIdentifier(input.planId);
  return withLock(registryPath(projectDir), async () => {
    const existing = await readWorktreeRegistry(projectDir);
    const prior = existing.find((entry) => entry.planId === planId);

    const entry: WorktreeEntry = {
      planId,
      path: input.path,
      branch: input.branch,
      ...(input.baseCommit !== undefined ? { baseCommit: input.baseCommit } : {}),
      createdAt: prior?.createdAt || nowISO(),
    };

    const rows = prior
      ? existing.map((row) => (row.planId === planId ? entry : row))
      : [...existing, entry];

    await writeJson(registryPath(projectDir), { worktrees: rows });
    invalidateGraphCache(basename(projectDir));
    return entry;
  });
}

/**
 * Remove the registration for a plan. Returns true if a row was removed,
 * false when the plan had no registration.
 */
export async function removeWorktreeEntry(projectDir: string, planId: string): Promise<boolean> {
  await ensureDir(projectDir);

  const normalizedId = normalizeIdentifier(planId);
  return withLock(registryPath(projectDir), async () => {
    const existing = await readWorktreeRegistry(projectDir);
    const rows = existing.filter((entry) => entry.planId !== normalizedId);
    if (rows.length === existing.length) {
      return false;
    }
    await writeJson(registryPath(projectDir), { worktrees: rows });
    invalidateGraphCache(basename(projectDir));
    return true;
  });
}

/** Find the worktree registered for a plan, if any. */
export async function findWorktreeByPlan(
  projectDir: string,
  planId: string,
): Promise<WorktreeEntry | null> {
  const normalizedId = normalizeIdentifier(planId);
  const registry = await readWorktreeRegistry(projectDir);
  return registry.find((entry) => entry.planId === normalizedId) ?? null;
}

export interface PathCollision {
  /** Normalized path claimed by more than one registry row. */
  path: string;
  planIds: string[];
}

/**
 * Detect registry rows claiming the same resolved path across different
 * plans (or duplicated rows for one plan). Healthy registries return [].
 */
export function findPathCollisions(entries: WorktreeEntry[]): PathCollision[] {
  const byPath = new Map<string, Set<string>>();
  for (const entry of entries) {
    const key = normalizeEntryPath(entry.path);
    const owners = byPath.get(key) ?? new Set<string>();
    owners.add(entry.planId);
    byPath.set(key, owners);
  }

  const collisions: PathCollision[] = [];
  for (const [path, owners] of byPath) {
    if (owners.size > 1 || countRowsForPath(entries, path) > 1) {
      collisions.push({ path, planIds: [...owners].sort() });
    }
  }
  return collisions;
}

function countRowsForPath(entries: WorktreeEntry[], normalizedPath: string): number {
  let count = 0;
  for (const entry of entries) {
    if (normalizeEntryPath(entry.path) === normalizedPath) count++;
  }
  return count;
}
