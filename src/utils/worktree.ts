// ---------------------------------------------------------------------------
// Worktree — timeout-bounded git worktree plumbing (1 plan = 1 tree)
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { GIT_ASYNC_TIMEOUT_MS } from "./git.js";
import { normalizeIdentifier } from "./slug.js";

const execFileAsync = promisify(execFile);

/** Slack the raced deadline allows the child's own kill path before giving up
 *  on it, so a child that DOES die on signal reports its real failure. */
const GIT_DEADLINE_GRACE_MS = 100;

/**
 * One entry of `git worktree list --porcelain`. `branch` is the short name
 * (`arcs/plan-x`) or null for bare/detached entries; `head` is null when git
 * did not report a HEAD line.
 */
export interface WorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
}

/** Result of a successful `git worktree add`. */
export interface AddedWorktree {
  path: string;
  branch: string;
}

/**
 * Async: run `git` with an argv array, never a shell, and settle to `null`
 * for ANY failure — same fail-closed contract as `src/utils/git.ts`, whose
 * deadline race this mirrors (duplicated rather than imported because that
 * helper is module-private and this file must stay additive).
 *
 * The deadline is RACED, not delegated to Node's `timeout` option: a child
 * that cannot act on its kill signal never settles the underlying promise,
 * so racing our own unref'd timer is what actually bounds the caller —
 * see `execAsync` in `src/utils/git.ts` for the full rationale.
 */
async function execAsync(args: string[], cwd: string): Promise<string | null> {
  const ran = execFileAsync("git", args, {
    encoding: "utf-8",
    cwd,
    timeout: GIT_ASYNC_TIMEOUT_MS,
    killSignal: "SIGKILL",
    windowsHide: true,
  })
    .then(({ stdout }) => stdout.trim())
    .catch(() => null);

  const expired = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), GIT_ASYNC_TIMEOUT_MS + GIT_DEADLINE_GRACE_MS).unref();
  });

  return Promise.race([ran, expired]);
}

/** Resolve to an absolute forward-slash path so comparisons and git argv are
 *  stable across platforms (Windows `resolve()` yields backslashes). */
function normalizePath(p: string): string {
  return resolve(p).replace(/\\/g, "/");
}

/** Branch name for a plan's worktree: `arcs/<normalized-plan-id>`. The arcs/
 *  namespace keeps agent branches out of the way of human branches. */
export function planBranchName(planId: string): string {
  return `arcs/${normalizeIdentifier(planId)}`;
}

/** Sibling convention: `<parent-of-repo>/<repo-name>-worktrees`. Sibling (not
 *  inside) so worktrees never show up in the main repo's globs or watchers. */
export function defaultWorktreeRoot(repoPath: string): string {
  const abs = normalizePath(repoPath);
  return `${dirname(abs)}/${basename(abs)}-worktrees`;
}

/** Where a plan's worktree lives by default: `<worktree-root>/<plan-id>`. */
export function resolvePlanWorktreePath(repoPath: string, planId: string): string {
  return `${defaultWorktreeRoot(repoPath)}/${normalizeIdentifier(planId)}`;
}

/**
 * Parse `git worktree list --porcelain`: newline records separated by blank
 * lines, each field `key value` with the value possibly containing spaces
 * (paths), so split on the FIRST space only. Empty output → [].
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const output = await execAsync(["worktree", "list", "--porcelain"], repoPath);
  if (!output) return [];

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  const flush = () => {
    if (current.path) {
      worktrees.push({
        path: current.path,
        head: current.head ?? null,
        branch: current.branch ?? null,
        bare: current.bare ?? false,
        detached: current.detached ?? false,
      });
    }
    current = {};
  };

  for (const line of output.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    const sep = line.indexOf(" ");
    const key = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? "" : line.slice(sep + 1);
    switch (key) {
      case "worktree":
        current.path = normalizePath(value);
        break;
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branch = value.replace(/^refs\/heads\//, "");
        break;
      case "bare":
        current.bare = true;
        break;
      case "detached":
        current.detached = true;
        break;
    }
  }
  flush();

  return worktrees;
}

/**
 * Create a worktree via `git worktree add`. With `createBranch` the branch is
 * created first (`-b <branch> [<base-ref>]`); otherwise `<branch>` must
 * already exist and is checked out. Returns null on any failure — including
 * branch-already-checked-out, which callers detect up front via
 * `isBranchCheckedOutInAnotherWorktree`.
 */
export async function addWorktree(
  repoPath: string,
  options: { path: string; branch: string; baseRef?: string; createBranch?: boolean },
): Promise<AddedWorktree | null> {
  const wtPath = normalizePath(options.path);
  const args = options.createBranch
    ? ["worktree", "add", "-b", options.branch, wtPath]
    : ["worktree", "add", wtPath, options.branch];
  if (options.createBranch && options.baseRef) {
    args.push(options.baseRef);
  }

  const output = await execAsync(args, repoPath);
  // `add` narrates progress on stderr, so empty stdout is still success; a
  // non-zero exit or an expired deadline is the only failure signal.
  if (output === null) return null;
  return { path: wtPath, branch: options.branch };
}

/** Remove a worktree (`git worktree remove [--force]`). True on success. */
export async function removeWorktree(
  repoPath: string,
  path: string,
  force = false,
): Promise<boolean> {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(normalizePath(path));
  return (await execAsync(args, repoPath)) !== null;
}

/** Drop stale worktree admin entries (`git worktree prune`). True on success. */
export async function pruneWorktrees(repoPath: string): Promise<boolean> {
  return (await execAsync(["worktree", "prune"], repoPath)) !== null;
}

/**
 * True when `branch` is checked out in any non-bare worktree other than
 * `excludePath` — the mutual-exclusion primitive: two orchestrators must not
 * dispatch onto the same plan branch.
 *
 * Fails CLOSED: if the listing cannot be read, returns TRUE (treat as
 * contended). A false negative here lets two writers share a branch; a false
 * positive merely blocks a dispatch that `ensure` would fail anyway.
 */
export async function isBranchCheckedOutInAnotherWorktree(
  repoPath: string,
  branch: string,
  excludePath?: string,
): Promise<boolean> {
  const worktrees = await listWorktrees(repoPath);
  if (worktrees.length === 0) return true;

  const excluded = excludePath ? normalizePath(excludePath) : null;
  return worktrees.some((wt) => !wt.bare && wt.branch === branch && wt.path !== excluded);
}

/**
 * Count commits on the worktree's HEAD not reachable from its upstream, or —
 * when no upstream is configured — from `main`/`master`. 0 means safe to
 * prune; null means unknown (no upstream AND no base branch found, detached
 * HEAD, or any git failure), which callers must treat as NOT safe.
 */
export async function countUnmergedCommits(worktreePath: string): Promise<number | null> {
  const upstream = await execAsync(
    ["rev-parse", "--abbrev-ref", "--verify", "HEAD@{upstream}"],
    worktreePath,
  );
  const base = upstream ?? (await firstExistingRef(worktreePath, ["main", "master"]));
  if (!base) return null;

  const count = await execAsync(["rev-list", "--count", `${base}..HEAD`], worktreePath);
  if (count === null) return null;
  const parsed = Number.parseInt(count, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** First ref in `candidates` that resolves, else null. */
async function firstExistingRef(cwd: string, candidates: string[]): Promise<string | null> {
  for (const ref of candidates) {
    if (await execAsync(["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`], cwd)) {
      return ref;
    }
  }
  return null;
}

/**
 * Short branch name currently checked out in `worktreePath`, or null when
 * detached (a detached HEAD is not a branch) or on any failure.
 */
export async function currentBranch(worktreePath: string): Promise<string | null> {
  const branch = await execAsync(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
  if (!branch || branch === "HEAD") return null;
  return branch;
}
