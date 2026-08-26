// ---------------------------------------------------------------------------
// Worktree Commands — plan-scoped git worktrees (1 plan = 1 tree)
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { GIT_ASYNC_TIMEOUT_MS, getHeadCommitAsync } from "../../utils/git.js";
import { getProjectDir } from "../../utils/paths.js";
import { readPlanIndex } from "../../utils/project-memory.js";
import { normalizeIdentifier } from "../../utils/slug.js";
import {
  addWorktree,
  countUnmergedCommits,
  currentBranch,
  defaultWorktreeRoot,
  isBranchCheckedOutInAnotherWorktree,
  listWorktrees,
  planBranchName,
  pruneWorktrees,
  removeWorktree,
  resolvePlanWorktreePath,
} from "../../utils/worktree.js";
import {
  findPathCollisions,
  findWorktreeByPlan,
  readWorktreeRegistry,
  removeWorktreeEntry,
  upsertWorktreeEntry,
  type WorktreeEntry,
} from "../../utils/worktree-store.js";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  ERROR_CODES,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { failure, success } from "../output-envelope.js";
import { requireWriteGate } from "../write-gate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

function requireProject(slug: string): CLIResult | string {
  const dir = getProjectDir(slug);
  if (!existsSync(dir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
      hint: "Run 'arcs project list' to see available projects.",
    });
  }
  return dir;
}

/**
 * Resolve the target repo from the CLI's cwd: arcs runs INSIDE the user's
 * project checkout, so the repo is always `git rev-parse --show-toplevel`
 * from `process.cwd()` — never derived from $ARCS_DATA. Null when cwd is
 * not inside a git work tree.
 */
async function resolveRepoRoot(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      cwd: process.cwd(),
      timeout: GIT_ASYNC_TIMEOUT_MS,
      windowsHide: true,
    });
    const root = stdout.trim().replace(/\\/g, "/");
    return root || null;
  } catch {
    return null;
  }
}

/** Normalize a path for registry-vs-git comparisons (absolute, forward slashes). */
function normalizePathKey(p: string): string {
  return resolve(p).replace(/\\/g, "/");
}

/** Sibling-convention leaf pair: `<anything>-worktrees/<id>`. */
const WORKTREE_NAMING = /\/[^/]+-worktrees\/[^/]+$/;

function matchesArcsNaming(path: string): boolean {
  return WORKTREE_NAMING.test(normalizePathKey(path));
}

/** True when a local branch `refs/heads/<branch>` exists in the repo. */
async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      encoding: "utf-8",
      cwd: repoPath,
      timeout: GIT_ASYNC_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Count uncommitted changes in a worktree (`git status --porcelain`). Null on failure. */
async function countDirtyFiles(worktreePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      encoding: "utf-8",
      cwd: worktreePath,
      timeout: GIT_ASYNC_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return null;
  }
}

interface WorktreeFinding {
  code: string;
  planId?: string;
  path?: string;
  detail: string;
}

function formatFinding(finding: WorktreeFinding): string {
  const where = finding.planId ? ` [${finding.planId}]` : "";
  return `${finding.code}${where}: ${finding.detail}`;
}

const ACTIVE_PLAN_STATUSES = new Set(["in_progress", "blocked"]);
const PRUNABLE_PLAN_STATUSES = new Set(["done", "archived"]);

// ---------------------------------------------------------------------------
// worktree ensure
// ---------------------------------------------------------------------------

const worktreeEnsureParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  planId: { type: "string", required: true, positional: 1, description: "Plan ID" },
  base: { type: "string", description: "Base ref to branch from (default: HEAD)" },
  root: {
    type: "string",
    description: "Worktree parent directory override (default: sibling <repo>-worktrees)",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "worktree ensure",
  description: "Idempotently create and register a dedicated worktree for a plan",
  mutation: true,
  params: worktreeEnsureParams,
  handler: handleWorktreeEnsure,
});

async function handleWorktreeEnsure(
  params: ParsedParams<typeof worktreeEnsureParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const projectCheck = requireProject(params.slug);
  if (typeof projectCheck !== "string") return projectCheck;
  const projectDir = projectCheck;

  const planIndex = await readPlanIndex(projectDir);
  const plan = planIndex.plans.find(
    (p) => p.id === params.planId || p.normalizedId === params.planId,
  );
  if (!plan) {
    return failure(ERROR_CODES.ENTITY_NOT_FOUND, `Plan "${params.planId}" not found`, {
      hint: `Run 'arcs plan list ${params.slug}' to see available plans.`,
    });
  }

  const repoRoot = await resolveRepoRoot();
  if (!repoRoot) {
    return failure("not_a_git_repo", "The current directory is not inside a git work tree", {
      hint: "Run worktree commands from within the project checkout — the target repo is the CLI's cwd, not $ARCS_DATA.",
    });
  }

  const branch = planBranchName(plan.normalizedId);
  const path = params.root
    ? `${normalizePathKey(params.root)}/${plan.normalizedId}`
    : resolvePlanWorktreePath(repoRoot, plan.normalizedId);

  // Idempotent: a registered row backed by a live tree on the right branch
  // is the done state — return it instead of recreating anything.
  const existing = await findWorktreeByPlan(projectDir, plan.normalizedId);
  if (existing && existsSync(existing.path)) {
    const checkedOut = await currentBranch(existing.path);
    if (checkedOut === existing.branch) {
      return success({
        planId: existing.planId,
        path: existing.path,
        branch: existing.branch,
        created: false,
      });
    }
  }

  // Mutual exclusion: two orchestrators must not dispatch onto one branch.
  if (await isBranchCheckedOutInAnotherWorktree(repoRoot, branch)) {
    return failure("branch_busy", `Branch "${branch}" is already checked out in another worktree`, {
      hint: "Another orchestrator may hold this plan. Run 'arcs worktree list' to locate the holder.",
    });
  }

  if (flags.dryRun) {
    return success({
      dryRun: true,
      wouldCreate: { planId: plan.normalizedId, path, branch, baseRef: params.base ?? "HEAD" },
    });
  }

  const baseCommit = await getHeadCommitAsync(repoRoot);
  let added = await addWorktree(repoRoot, {
    path,
    branch,
    createBranch: true,
    ...(params.base ? { baseRef: params.base } : {}),
  });
  // Prune never deletes branches, so a re-ensure after a prune finds `-b`
  // refusing an existing branch — fall back to checking that branch out
  // (mutual exclusion above already proved no other worktree holds it).
  if (!added && (await branchExists(repoRoot, branch))) {
    added = await addWorktree(repoRoot, { path, branch, createBranch: false });
  }
  if (!added) {
    return failure("worktree_error", `git worktree add failed for "${path}" (branch "${branch}")`, {
      hint: "The branch may already exist without a worktree, or the path may be occupied. Inspect 'git worktree list'.",
    });
  }

  const entry = await upsertWorktreeEntry(projectDir, {
    planId: plan.normalizedId,
    path: added.path,
    branch,
    ...(baseCommit ? { baseCommit } : {}),
  });

  return success({
    planId: entry.planId,
    path: entry.path,
    branch: entry.branch,
    ...(entry.baseCommit ? { baseCommit: entry.baseCommit } : {}),
    created: true,
  });
}

// ---------------------------------------------------------------------------
// worktree validate
// ---------------------------------------------------------------------------

const worktreeValidateParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "worktree validate",
  description: "Cross-check worktree registry, plan statuses, and git worktree state",
  params: worktreeValidateParams,
  handler: handleWorktreeValidate,
});

async function handleWorktreeValidate(
  params: ParsedParams<typeof worktreeValidateParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const projectCheck = requireProject(params.slug);
  if (typeof projectCheck !== "string") return projectCheck;
  const projectDir = projectCheck;

  const repoRoot = await resolveRepoRoot();
  if (!repoRoot) {
    return failure("not_a_git_repo", "The current directory is not inside a git work tree", {
      hint: "Run worktree commands from within the project checkout — the target repo is the CLI's cwd, not $ARCS_DATA.",
    });
  }

  const [registry, plans, disk] = await Promise.all([
    readWorktreeRegistry(projectDir),
    readPlanIndex(projectDir),
    listWorktrees(repoRoot),
  ]);
  const planById = new Map(plans.plans.map((p) => [p.normalizedId, p]));
  const diskByPath = new Map(disk.map((wt) => [wt.path, wt]));

  const violations: WorktreeFinding[] = [];
  const warnings: WorktreeFinding[] = [];
  const info: WorktreeFinding[] = [];

  // Registry rows: health, staleness, and drift signals.
  for (const entry of registry) {
    const plan = planById.get(entry.planId);
    const live = diskByPath.get(normalizePathKey(entry.path));

    if (!live) {
      violations.push({
        code: "worktree_missing_on_disk",
        planId: entry.planId,
        path: entry.path,
        detail: "Registered worktree has no live git worktree at this path",
      });
      continue;
    }

    if (live.branch !== entry.branch) {
      if (live.branch === null) {
        warnings.push({
          code: "unknown_state",
          planId: entry.planId,
          path: entry.path,
          detail: "Worktree is detached or bare — registered branch cannot be verified",
        });
      } else {
        violations.push({
          code: "branch_mismatch",
          planId: entry.planId,
          path: entry.path,
          detail: `Checked out "${live.branch}" but registry records "${entry.branch}"`,
        });
      }
    }

    if (plan && PRUNABLE_PLAN_STATUSES.has(plan.status)) {
      warnings.push({
        code: "stale_registration",
        planId: entry.planId,
        path: entry.path,
        detail: `Plan is ${plan.status} — run 'arcs worktree prune ${params.slug} ${entry.planId}'`,
      });
    }
    if (!plan) {
      warnings.push({
        code: "orphaned_registration",
        planId: entry.planId,
        path: entry.path,
        detail: "Registered plan no longer exists in the plan index",
      });
    }

    const dirtyCount = await countDirtyFiles(entry.path);
    if (dirtyCount !== null && dirtyCount > 0) {
      info.push({
        code: "dirty_worktree",
        planId: entry.planId,
        path: entry.path,
        detail: `${dirtyCount} uncommitted change(s)`,
      });
    }
    const unmerged = await countUnmergedCommits(entry.path);
    if (unmerged !== null && unmerged > 0) {
      info.push({
        code: "unmerged_commits",
        planId: entry.planId,
        path: entry.path,
        detail: `${unmerged} commit(s) not reachable from upstream/base`,
      });
    }
  }

  // Active plans must hold a registered worktree.
  for (const plan of plans.plans) {
    if (!ACTIVE_PLAN_STATUSES.has(plan.status)) continue;
    if (registry.some((entry) => entry.planId === plan.normalizedId)) continue;
    violations.push({
      code: "active_plan_unprotected",
      planId: plan.normalizedId,
      detail: `${plan.status} plan has no registered worktree — run 'arcs worktree ensure ${params.slug} ${plan.normalizedId}'`,
    });
  }

  // On-disk trees under ARCS naming that no registry row claims.
  for (const wt of disk) {
    if (wt.bare) continue;
    if (!matchesArcsNaming(wt.path)) continue;
    if (registry.some((entry) => normalizePathKey(entry.path) === wt.path)) continue;
    const guessedPlanId = basename(wt.path);
    const plan = planById.get(guessedPlanId);
    if (plan && PRUNABLE_PLAN_STATUSES.has(plan.status)) {
      warnings.push({
        code: "stale_tree_on_disk",
        planId: guessedPlanId,
        path: wt.path,
        detail: `Plan is ${plan.status} — run 'arcs worktree prune ${params.slug} ${guessedPlanId}'`,
      });
    } else {
      warnings.push({
        code: "unregistered_worktree",
        path: wt.path,
        detail: "Matches ARCS worktree naming but has no registry row",
      });
    }
  }

  // Registry rows claiming the same resolved path.
  for (const collision of findPathCollisions(registry)) {
    violations.push({
      code: "path_collision",
      path: collision.path,
      detail: `Claimed by multiple registry rows: ${collision.planIds.join(", ")}`,
    });
  }

  const summary = {
    violations: violations.length,
    warnings: warnings.length,
    info: info.length,
  };

  if (violations.length > 0) {
    const preview = violations.slice(0, 5).map(formatFinding).join("\n");
    const more = violations.length > 5 ? `\n… and ${violations.length - 5} more` : "";
    return failure(
      "validation_failed",
      `Worktree validation failed: ${summary.violations} violation(s), ${summary.warnings} warning(s), ${summary.info} info`,
      { hint: `${preview}${more}` },
    );
  }

  return success({ violations, warnings, info, summary });
}

// ---------------------------------------------------------------------------
// worktree prune
// ---------------------------------------------------------------------------

const worktreePruneParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  planId: {
    type: "string",
    positional: 1,
    description: "Plan ID (omit to prune all done/archived worktrees)",
  },
  force: { type: "boolean", description: "Remove even when unmerged commits exist" },
  token: { type: "string", description: "Write-gate token (required when ARCS_GUARDED=1)" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "worktree prune",
  description: "Remove plan worktrees (branches are never deleted)",
  mutation: true,
  params: worktreePruneParams,
  handler: handleWorktreePrune,
});

async function handleWorktreePrune(
  params: ParsedParams<typeof worktreePruneParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const projectCheck = requireProject(params.slug);
  if (typeof projectCheck !== "string") return projectCheck;
  const projectDir = projectCheck;

  const repoRoot = await resolveRepoRoot();
  if (!repoRoot) {
    return failure("not_a_git_repo", "The current directory is not inside a git work tree", {
      hint: "Run worktree commands from within the project checkout — the target repo is the CLI's cwd, not $ARCS_DATA.",
    });
  }

  if (flags.dryRun) {
    const candidates = params.planId
      ? [await findPruneTarget(projectDir, repoRoot, params.planId)]
      : await listPrunableEntries(projectDir);
    return success({
      dryRun: true,
      wouldRemove: candidates
        .filter((entry): entry is WorktreeEntry => entry !== null)
        .map((entry) => ({ planId: entry.planId, path: entry.path })),
    });
  }

  const gate = requireWriteGate(params.token);
  if (gate) return gate;

  if (params.planId) {
    return pruneSinglePlan(projectDir, repoRoot, params.slug, params.planId, params.force ?? false);
  }
  return pruneCompletedPlans(projectDir, repoRoot, params.force ?? false);
}

/** Registry row (or on-disk default-path tree) for a named prune target. */
async function findPruneTarget(
  projectDir: string,
  repoRoot: string,
  planId: string,
): Promise<WorktreeEntry | null> {
  const entry = await findWorktreeByPlan(projectDir, planId);
  if (entry) return entry;
  const fallback = resolvePlanWorktreePath(repoRoot, normalizeIdentifier(planId));
  if (existsSync(fallback)) {
    return {
      planId: normalizeIdentifier(planId),
      path: fallback,
      branch: planBranchName(planId),
      createdAt: "",
    };
  }
  return null;
}

/** Registry rows eligible for batch prune: done/archived plans only. */
async function listPrunableEntries(projectDir: string): Promise<WorktreeEntry[]> {
  const [registry, plans] = await Promise.all([
    readWorktreeRegistry(projectDir),
    readPlanIndex(projectDir),
  ]);
  const statusById = new Map(plans.plans.map((p) => [p.normalizedId, p.status]));
  return registry.filter((entry) => {
    const status = statusById.get(entry.planId);
    return status !== undefined && PRUNABLE_PLAN_STATUSES.has(status);
  });
}

/** Refuse to destroy unmergeable work unless --force overrides. */
async function unmergedBlock(path: string, force: boolean): Promise<CLIResult | null> {
  if (force) return null;
  const unmerged = await countUnmergedCommits(path);
  if (unmerged === null) {
    return failure(
      "unmerged_commits_unknown",
      `Cannot verify the merge state of "${path}" — refusing to remove without --force`,
      { hint: "Verify the branch is merged, then rerun with --force." },
    );
  }
  if (unmerged > 0) {
    return failure(
      "unmerged_commits",
      `"${path}" holds ${unmerged} unmerged commit(s) — refusing to remove without --force`,
      {
        hint: "Merge or push the branch, or rerun with --force to discard the worktree anyway (commits stay on the branch).",
      },
    );
  }
  return null;
}

async function pruneSinglePlan(
  projectDir: string,
  repoRoot: string,
  slug: string,
  planId: string,
  force: boolean,
): Promise<CLIResult> {
  const target = await findPruneTarget(projectDir, repoRoot, planId);
  if (!target) {
    return failure(ERROR_CODES.ENTITY_NOT_FOUND, `No worktree found for plan "${planId}"`, {
      hint: `Run 'arcs worktree list ${slug}' to see registered worktrees.`,
    });
  }

  const block = await unmergedBlock(target.path, force);
  if (block) return block;

  const removed = await removeWorktree(repoRoot, target.path, force);
  const registryRemoved = await removeWorktreeEntry(projectDir, target.planId);
  const adminEntriesPruned = await pruneWorktrees(repoRoot);

  return success({
    planId: target.planId,
    path: target.path,
    worktreeRemoved: removed,
    registryRemoved,
    adminEntriesPruned,
    branchesDeleted: false,
  });
}

async function pruneCompletedPlans(
  projectDir: string,
  repoRoot: string,
  force: boolean,
): Promise<CLIResult> {
  const registry = await readWorktreeRegistry(projectDir);
  const plans = await readPlanIndex(projectDir);
  const statusById = new Map(plans.plans.map((p) => [p.normalizedId, p.status]));

  const removed: Array<{ planId: string; path: string }> = [];
  const skipped: Array<{ planId: string; path: string; reason: string }> = [];

  for (const entry of registry) {
    const status = statusById.get(entry.planId);
    if (status === undefined || !PRUNABLE_PLAN_STATUSES.has(status)) {
      skipped.push({
        planId: entry.planId,
        path: entry.path,
        reason:
          status === undefined
            ? "plan not found in plan index"
            : `plan status is ${status}, not done/archived`,
      });
      continue;
    }

    if (!force) {
      const unmerged = await countUnmergedCommits(entry.path);
      if (unmerged === null) {
        skipped.push({
          planId: entry.planId,
          path: entry.path,
          reason: "merge state unknown; rerun with --force to override",
        });
        continue;
      }
      if (unmerged > 0) {
        skipped.push({
          planId: entry.planId,
          path: entry.path,
          reason: `${unmerged} unmerged commit(s); rerun with --force to override`,
        });
        continue;
      }
    }

    if (!(await removeWorktree(repoRoot, entry.path, force))) {
      skipped.push({
        planId: entry.planId,
        path: entry.path,
        reason: "git worktree remove failed",
      });
      continue;
    }
    await removeWorktreeEntry(projectDir, entry.planId);
    removed.push({ planId: entry.planId, path: entry.path });
  }

  const adminEntriesPruned = await pruneWorktrees(repoRoot);
  return success({ removed, skipped, adminEntriesPruned, branchesDeleted: false });
}

// ---------------------------------------------------------------------------
// worktree list
// ---------------------------------------------------------------------------

const worktreeListParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "worktree list",
  description: "List registered and on-disk plan worktrees with drift markers",
  params: worktreeListParams,
  handler: handleWorktreeList,
});

interface WorktreeRow {
  planId?: string;
  path: string;
  branch?: string | null;
  marker: "ok" | "missing" | "unregistered" | "collision" | "foreign-branch";
  detail?: string;
}

async function handleWorktreeList(
  params: ParsedParams<typeof worktreeListParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const projectCheck = requireProject(params.slug);
  if (typeof projectCheck !== "string") return projectCheck;
  const projectDir = projectCheck;

  const repoRoot = await resolveRepoRoot();
  if (!repoRoot) {
    return failure("not_a_git_repo", "The current directory is not inside a git work tree", {
      hint: "Run worktree commands from within the project checkout — the target repo is the CLI's cwd, not $ARCS_DATA.",
    });
  }

  const [registry, disk] = await Promise.all([
    readWorktreeRegistry(projectDir),
    listWorktrees(repoRoot),
  ]);
  const diskByPath = new Map(disk.map((wt) => [wt.path, wt]));
  const collisionPaths = new Set(findPathCollisions(registry).map((c) => c.path));
  const claimedPaths = new Set(registry.map((entry) => normalizePathKey(entry.path)));
  const defaultRoot = defaultWorktreeRoot(repoRoot);

  const rows: WorktreeRow[] = [];

  for (const entry of registry) {
    const key = normalizePathKey(entry.path);
    if (collisionPaths.has(key)) {
      rows.push({
        planId: entry.planId,
        path: entry.path,
        branch: entry.branch,
        marker: "collision",
        detail: "Path claimed by multiple registry rows",
      });
      continue;
    }
    const live = diskByPath.get(key);
    if (!live) {
      rows.push({
        planId: entry.planId,
        path: entry.path,
        branch: entry.branch,
        marker: "missing",
        detail: "No live git worktree at this path",
      });
      continue;
    }
    if (live.branch !== entry.branch) {
      rows.push({
        planId: entry.planId,
        path: entry.path,
        branch: entry.branch,
        marker: "foreign-branch",
        detail: `Checked out branch: ${live.branch ?? "detached HEAD"}`,
      });
      continue;
    }
    rows.push({ planId: entry.planId, path: entry.path, branch: entry.branch, marker: "ok" });
  }

  for (const wt of disk) {
    if (wt.bare) continue;
    if (!wt.path.startsWith(`${defaultRoot}/`)) continue;
    if (claimedPaths.has(wt.path)) continue;
    rows.push({
      path: wt.path,
      branch: wt.branch,
      marker: "unregistered",
      detail: "On-disk worktree with no registry row",
    });
  }

  const countBy = (marker: WorktreeRow["marker"]) =>
    rows.filter((row) => row.marker === marker).length;

  return success({
    worktrees: rows,
    counts: {
      total: rows.length,
      ok: countBy("ok"),
      missing: countBy("missing"),
      unregistered: countBy("unregistered"),
      collision: countBy("collision"),
      foreignBranch: countBy("foreign-branch"),
    },
  });
}
