/**
 * The change ledger — the deterministic, git-derived record of what each task
 * actually changed, kept at `<projectDir>/workflow/changes.jsonl`.
 *
 * Every line is derived from git by `src/utils/git.ts`, never from an agent's
 * account of its own work: a `commit` entry is a sha plus the file/hunk summary
 * and rebase-stable `patchId` git reported for it; a `pending` entry is the
 * worktree diffstat `done` saw when a task closed with uncommitted work; a `pr`
 * entry is an offline link. The patch body itself is NEVER stored — git already
 * has it, and the read commands re-render it on demand while a sha is reachable
 * — so the ledger stays small.
 *
 * Append-only. A correction is a `tombstone` line naming the `(taskId, sha)` it
 * retracts; existing lines are never rewritten. `readChanges` applies tombstones
 * and supersession so callers see the effective ledger, not the raw log.
 *
 * Invariants (see `docs/audits/cc-arcs/deep-dive-ledger-graph-build-commits.md`):
 *   * the baseline is the task's EXISTING `TaskMeta.startHead` — there is no
 *     `baselineCommit` field and this module never introduces one;
 *   * `reachable` is computed on read via `isAncestor` and is never stored;
 *   * `patchId` is advisory only and is never used for matching (dedup is by
 *     `(taskId, sha)`);
 *   * recording never fails a task transition — a workspace without git simply
 *     records nothing.
 */

import { appendFile, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { invalidateGraphCache } from "../retrieval/graph-invalidate.js";
import { withLock } from "./file-lock.js";
import {
  type CommitFileChange,
  getCommitChanges,
  getWorktreeDiffstat,
  isAncestor,
  isValidSha,
} from "./git.js";
import { ensureDir, nowISO } from "./storage-utils.js";

export type ChangeKind = "commit" | "pending" | "pr" | "tombstone";

/** Who or what appended the entry — provenance of the record itself. */
export type ChangeRecorder = "done" | "record-change";

export interface ChangeEntry {
  taskId: string;
  planId?: string;
  kind: ChangeKind;
  /** Full sha for `commit`; the retracted sha for `tombstone`. */
  sha?: string;
  /** `git patch-id --stable` — survives rebase, squash and cherry-pick. Advisory only. */
  patchId?: string;
  subject?: string;
  author?: string;
  authoredAt?: string;
  /** Per-file snapshot; `hunks` are the `@@ … @@` header lines only. */
  files?: CommitFileChange[];
  /** Untracked paths in a `pending` entry — files git has never seen. */
  untracked?: string[];
  pr?: { url: string; headSha?: string; state?: string };
  recordedBy: ChangeRecorder;
  /** ISO timestamp of the record. */
  at: string;
}

/** A `commit` entry as listed, with whether HEAD still reaches it. */
export type ChangeRecord = ChangeEntry & { reachable?: boolean };

function ledgerPath(projectDir: string): string {
  return join(projectDir, "workflow", "changes.jsonl");
}

async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Read every raw line, oldest first. A missing file is `[]`; an unparseable
 * line is skipped rather than thrown, because the ledger must never turn a
 * corrupt byte into a failed task transition or a broken graph build.
 */
export async function readRawChanges(projectDir: string): Promise<ChangeEntry[]> {
  const raw = await readFileSafe(ledgerPath(projectDir));
  if (raw === undefined) return [];
  const entries: ChangeEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      entries.push(JSON.parse(trimmed) as ChangeEntry);
    } catch {
      // Skip a damaged line — the rest of the ledger is still evidence.
    }
  }
  return entries;
}

/** Append one line to the ledger. Caller must already hold the ledger lock. */
async function appendLine(path: string, entry: ChangeEntry): Promise<void> {
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf-8");
}

/** Append one line, creating `workflow/` if needed. Never rewrites. */
export async function appendChange(projectDir: string, entry: ChangeEntry): Promise<void> {
  const path = ledgerPath(projectDir);
  await ensureDir(join(projectDir, "workflow"));
  await withLock(path, () => appendLine(path, entry));
  // The graph builder draws `task_changed_file` edges from this file.
  invalidateGraphCache(basename(projectDir));
}

export interface ReadChangesOptions {
  taskId?: string;
  planId?: string;
  /** Most-recent-N cap, applied after filtering. */
  limit?: number;
  /** Workspace to check sha reachability in; omitted → `reachable` is not reported. */
  cwd?: string;
}

/**
 * The EFFECTIVE ledger, newest first:
 *
 *   * a `tombstone` retracts every earlier `commit` entry with its `(taskId, sha)`
 *     and is itself never listed;
 *   * a `pending` entry is superseded by any `commit` entry recorded for the
 *     same task after it — the uncommitted work it described has since landed;
 *   * the same `(taskId, sha)` appearing twice lists once (the first record).
 *
 * The filter runs before the cap, so `limit` means "the N most recent changes
 * of THIS task/plan". Reachability is computed here (never stored).
 */
export async function readChanges(
  projectDir: string,
  options: ReadChangesOptions = {},
): Promise<ChangeRecord[]> {
  const { taskId, planId, limit, cwd } = options;
  const raw = await readRawChanges(projectDir);

  const tombstoned = new Set<string>();
  for (const e of raw) {
    if (e.kind === "tombstone" && e.sha) tombstoned.add(`${e.taskId}\u0000${e.sha}`);
  }
  const lastCommitAtByTask = new Map<string, string>();
  for (const e of raw) {
    if (e.kind !== "commit" || !e.sha || tombstoned.has(`${e.taskId}\u0000${e.sha}`)) continue;
    const prev = lastCommitAtByTask.get(e.taskId);
    if (!prev || e.at > prev) lastCommitAtByTask.set(e.taskId, e.at);
  }

  const seen = new Set<string>();
  const effective: ChangeRecord[] = [];
  for (const e of raw) {
    if (e.kind === "tombstone") continue;
    if (taskId !== undefined && e.taskId !== taskId) continue;
    if (planId !== undefined && e.planId !== planId) continue;
    if (e.kind === "commit" && e.sha) {
      const key = `${e.taskId}\u0000${e.sha}`;
      if (tombstoned.has(key) || seen.has(key)) continue;
      seen.add(key);
    }
    if (e.kind === "pending") {
      const laterCommit = lastCommitAtByTask.get(e.taskId);
      if (laterCommit && laterCommit > e.at) continue;
    }
    const record: ChangeRecord = { ...e };
    if (cwd && e.kind === "commit" && e.sha) {
      record.reachable = isAncestor(cwd, e.sha);
    }
    effective.push(record);
  }

  effective.reverse();
  return limit === undefined ? effective : effective.slice(0, limit);
}

/** Whether an effective `commit` entry exists for `(taskId, sha)`. */
export async function hasChange(projectDir: string, taskId: string, sha: string): Promise<boolean> {
  const entries = await readChanges(projectDir, { taskId });
  return entries.some((e) => e.kind === "commit" && e.sha === sha);
}

/** Retract a recorded commit by appending a tombstone. */
export async function removeChange(
  projectDir: string,
  taskId: string,
  sha: string,
  recordedBy: ChangeRecorder = "record-change",
): Promise<void> {
  await appendChange(projectDir, { taskId, kind: "tombstone", sha, recordedBy, at: nowISO() });
}

export interface RecordCommitsInput {
  taskId: string;
  planId?: string;
  /** The workspace the shas live in. */
  cwd: string;
  shas: string[];
  recordedBy: ChangeRecorder;
  /**
   * When set, a commit is recorded only if it touches at least one of these
   * workspace-relative paths (exact file, or a directory prefix). Absent →
   * every resolvable sha is recorded.
   */
  onlyTouching?: string[];
}

export interface RecordCommitsResult {
  recorded: ChangeEntry[];
  skipped: Array<{
    sha: string;
    reason: "already_recorded" | "unreachable" | "invalid" | "outside_scope";
  }>;
}

/** Does a commit's file list intersect the declared paths? */
function touchesAny(files: CommitFileChange[], paths: string[]): boolean {
  return files.some((f) =>
    paths.some((p) => f.path === p || f.path.startsWith(p.endsWith("/") ? p : `${p}/`)),
  );
}

/**
 * Snapshot each sha from git and append it, skipping what is already recorded
 * or does not resolve. The one write path both `done` and `record-change`
 * share, so the two can never disagree about what a commit entry contains.
 *
 * The git snapshot for every sha happens OUTSIDE the lock (it is the slow part),
 * but the dedup read and the appends happen INSIDE a single lock. Re-reading the
 * effective ledger there — rather than trusting a precomputed set — is what
 * closes the donor's D7 window where two concurrent writers both saw an empty
 * ledger and appended the same `(taskId, sha)` twice.
 */
export async function recordCommits(
  projectDir: string,
  input: RecordCommitsInput,
): Promise<RecordCommitsResult> {
  const { taskId, planId, cwd, shas, recordedBy, onlyTouching } = input;
  const result: RecordCommitsResult = { recorded: [], skipped: [] };

  // Phase 1 (unlocked): resolve each requested sha from git into an entry.
  const resolved: Array<{ sha: string; files: CommitFileChange[]; entry: ChangeEntry }> = [];
  for (const requested of shas) {
    if (!isValidSha(requested)) {
      result.skipped.push({ sha: requested, reason: "invalid" });
      continue;
    }
    const changes = getCommitChanges(cwd, requested);
    if (!changes) {
      result.skipped.push({ sha: requested, reason: "unreachable" });
      continue;
    }
    const entry: ChangeEntry = {
      taskId,
      ...(planId && { planId }),
      kind: "commit",
      sha: changes.sha,
      ...(changes.patchId && { patchId: changes.patchId }),
      subject: changes.subject,
      author: changes.author,
      authoredAt: changes.authoredAt,
      files: changes.files,
      recordedBy,
      at: nowISO(),
    };
    resolved.push({ sha: changes.sha, files: changes.files, entry });
  }

  // Phase 2 (locked): re-read, dedup, and append atomically.
  const path = ledgerPath(projectDir);
  await ensureDir(join(projectDir, "workflow"));
  await withLock(path, async () => {
    const existing = await readChanges(projectDir, { taskId });
    const known = new Set(
      existing.filter((e) => e.kind === "commit" && e.sha).map((e) => e.sha as string),
    );
    for (const item of resolved) {
      if (known.has(item.sha)) {
        result.skipped.push({ sha: item.sha, reason: "already_recorded" });
        continue;
      }
      if (onlyTouching && onlyTouching.length > 0 && !touchesAny(item.files, onlyTouching)) {
        result.skipped.push({ sha: item.sha, reason: "outside_scope" });
        continue;
      }
      await appendLine(path, item.entry);
      known.add(item.sha);
      result.recorded.push(item.entry);
    }
  });
  if (result.recorded.length > 0) invalidateGraphCache(basename(projectDir));
  return result;
}

/**
 * Record the worktree's uncommitted state as a `pending` entry, or nothing when
 * the tree is clean. Returns the entry written, if any.
 */
export async function recordPending(
  projectDir: string,
  input: { taskId: string; planId?: string; cwd: string; recordedBy: ChangeRecorder },
): Promise<ChangeEntry | undefined> {
  const stat = getWorktreeDiffstat(input.cwd);
  if (!stat) return undefined;
  const entry: ChangeEntry = {
    taskId: input.taskId,
    ...(input.planId && { planId: input.planId }),
    kind: "pending",
    files: stat.files.map((f) => ({ ...f, hunks: [] })),
    ...(stat.untracked.length > 0 && { untracked: stat.untracked }),
    recordedBy: input.recordedBy,
    at: nowISO(),
  };
  await appendChange(projectDir, entry);
  return entry;
}

export interface RecordPrInput {
  taskId: string;
  planId?: string;
  url: string;
  /** Advisory PR head/state, when the caller already knows them. Never fetched here. */
  headSha?: string;
  state?: string;
  recordedBy: ChangeRecorder;
}

/**
 * Record a pull-request link. Offline by design: the URL is stored verbatim and
 * no network call is made (the donor's `gh pr view` enrichment is deliberately
 * dropped — the ledger must stay usable without `gh` or credentials).
 */
export async function recordPr(projectDir: string, input: RecordPrInput): Promise<ChangeEntry> {
  const entry: ChangeEntry = {
    taskId: input.taskId,
    ...(input.planId && { planId: input.planId }),
    kind: "pr",
    pr: {
      url: input.url,
      ...(input.headSha && { headSha: input.headSha }),
      ...(input.state && { state: input.state }),
    },
    recordedBy: input.recordedBy,
    at: nowISO(),
  };
  await appendChange(projectDir, entry);
  return entry;
}

/** Roll-up totals over a set of effective records. */
export function summarizeChanges(records: ChangeRecord[]): {
  commits: number;
  pending: number;
  prs: number;
  files: number;
  additions: number;
  deletions: number;
} {
  const paths = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let commits = 0;
  let pending = 0;
  let prs = 0;
  for (const r of records) {
    if (r.kind === "commit") commits += 1;
    if (r.kind === "pending") pending += 1;
    if (r.kind === "pr") prs += 1;
    for (const f of r.files ?? []) {
      paths.add(f.path);
      additions += f.additions;
      deletions += f.deletions;
    }
    for (const p of r.untracked ?? []) paths.add(p);
  }
  return { commits, pending, prs, files: paths.size, additions, deletions };
}
