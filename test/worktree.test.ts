/**
 * Unit tests for worktree plumbing (src/utils/worktree.ts).
 *
 * Covers:
 * - planBranchName: arcs/<normalized-id> naming
 * - defaultWorktreeRoot / resolvePlanWorktreePath: sibling-convention paths
 * - listWorktrees: porcelain parsing incl. detached/bare entries and paths
 *   containing spaces
 * - isBranchCheckedOutInAnotherWorktree: fail-closed on unreadable listings
 * - countUnmergedCommits: 0 vs >0 vs unknown (null)
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countUnmergedCommits,
  defaultWorktreeRoot,
  isBranchCheckedOutInAnotherWorktree,
  listWorktrees,
  planBranchName,
  resolvePlanWorktreePath,
} from "../src/utils/worktree.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

/** Real git repo with one initial commit; returns root + cleanup. */
function makeGitRepo(prefix: string): { root: string; cleanup: () => void } {
  const root = makeTempDir(prefix);
  execSync("git init", { cwd: root, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: root, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "README.md"), "# test\n");
  execSync("git add README.md", { cwd: root, stdio: "pipe" });
  execSync("git commit -qm 'initial'", { cwd: root, stdio: "pipe" });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// planBranchName
// ---------------------------------------------------------------------------

describe("planBranchName", () => {
  it("prefixes arcs/ onto an already-normalized id", () => {
    expect(planBranchName("plan-alpha")).toBe("arcs/plan-alpha");
  });

  it("normalizes messy ids before prefixing", () => {
    expect(planBranchName("My Cool Plan!")).toBe("arcs/my-cool-plan");
  });
});

// ---------------------------------------------------------------------------
// defaultWorktreeRoot / resolvePlanWorktreePath
// ---------------------------------------------------------------------------

describe("defaultWorktreeRoot", () => {
  it("uses the sibling convention <parent>/<repo>-worktrees", () => {
    expect(defaultWorktreeRoot("/tmp/foo/repo")).toBe("/tmp/foo/repo-worktrees");
  });
});

describe("resolvePlanWorktreePath", () => {
  it("composes worktree root with the normalized plan id", () => {
    expect(resolvePlanWorktreePath("/tmp/foo/repo", "Plan X")).toBe(
      "/tmp/foo/repo-worktrees/plan-x",
    );
  });

  it("nests under the sibling root, not inside the repo", () => {
    const path = resolvePlanWorktreePath("/tmp/foo/repo", "plan-y");
    expect(dirname(path)).toBe(defaultWorktreeRoot("/tmp/foo/repo"));
    expect(path.startsWith("/tmp/foo/repo/")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listWorktrees — porcelain parsing
// ---------------------------------------------------------------------------

describe("listWorktrees", () => {
  let cleanupFns: Array<() => void>;

  beforeEach(() => {
    cleanupFns = [];
  });

  afterEach(() => {
    for (const fn of cleanupFns) fn();
  });

  function trackedRepo(prefix: string): string {
    const { root, cleanup } = makeGitRepo(prefix);
    cleanupFns.push(cleanup);
    return root;
  }

  it("parses the main worktree and linked worktrees with branches", async () => {
    const repo = trackedRepo("arcs-wt-parse-");
    execSync(`git worktree add -q "${join(repo, "linked")}" -b arcs/plan-a`, {
      cwd: repo,
      stdio: "pipe",
    });

    const worktrees = await listWorktrees(repo);

    expect(worktrees).toHaveLength(2);
    const main = worktrees.find((wt) => wt.path === resolve(repo));
    expect(main).toBeDefined();
    expect(main!.branch).toBeTruthy();
    expect(main!.bare).toBe(false);
    expect(main!.detached).toBe(false);
    expect(main!.head).toMatch(/^[0-9a-f]+$/);

    const linked = worktrees.find((wt) => wt.path !== resolve(repo));
    expect(linked!.branch).toBe("arcs/plan-a");
  });

  it("parses detached entries with null branch", async () => {
    const repo = trackedRepo("arcs-wt-detach-");
    execSync(`git worktree add -q --detach "${join(repo, "detached")}"`, {
      cwd: repo,
      stdio: "pipe",
    });

    const worktrees = await listWorktrees(repo);
    const detached = worktrees.find((wt) => wt.detached);

    expect(detached).toBeDefined();
    expect(detached!.branch).toBeNull();
    expect(detached!.head).toMatch(/^[0-9a-f]+$/);
  });

  it("parses a bare repo entry with bare=true and null branch", async () => {
    const dir = makeTempDir("arcs-wt-bare-");
    cleanupFns.push(() => rmSync(dir, { recursive: true, force: true }));
    const bare = join(dir, "bare.git");
    execSync(`git init -q --bare "${bare}"`, { stdio: "pipe" });

    const worktrees = await listWorktrees(bare);

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].path).toBe(resolve(bare));
    expect(worktrees[0].bare).toBe(true);
    expect(worktrees[0].branch).toBeNull();
    expect(worktrees[0].detached).toBe(false);
  });

  it("keeps paths containing spaces intact (split on first space only)", async () => {
    const repo = trackedRepo("arcs-wt-space-");
    const spaced = join(repo, "space wt");
    execSync(`git worktree add -q -b arcs/spaced "${spaced}"`, { cwd: repo, stdio: "pipe" });

    const worktrees = await listWorktrees(repo);
    const found = worktrees.find((wt) => wt.branch === "arcs/spaced");

    expect(found).toBeDefined();
    expect(found!.path).toBe(resolve(spaced));
  });

  it("returns [] for a directory that is not a git repo", async () => {
    const plain = makeTempDir("arcs-wt-plain-");
    cleanupFns.push(() => rmSync(plain, { recursive: true, force: true }));

    expect(await listWorktrees(plain)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isBranchCheckedOutInAnotherWorktree
// ---------------------------------------------------------------------------

describe("isBranchCheckedOutInAnotherWorktree", () => {
  let cleanupFns: Array<() => void>;

  beforeEach(() => {
    cleanupFns = [];
  });

  afterEach(() => {
    for (const fn of cleanupFns) fn();
  });

  it("fails closed (true) when the listing cannot be read", async () => {
    const plain = makeTempDir("arcs-wt-plain2-");
    cleanupFns.push(() => rmSync(plain, { recursive: true, force: true }));

    expect(await isBranchCheckedOutInAnotherWorktree(plain, "arcs/plan-a")).toBe(true);
  });

  it("is true when the branch is held by another worktree", async () => {
    const repo = makeGitRepo("arcs-wt-mutex-");
    cleanupFns.push(repo.cleanup);
    const linked = join(repo.root, "holder");
    execSync(`git worktree add -q "${linked}" -b arcs/plan-a`, {
      cwd: repo.root,
      stdio: "pipe",
    });

    expect(await isBranchCheckedOutInAnotherWorktree(repo.root, "arcs/plan-a")).toBe(true);
  });

  it("is false when the only holder is the excluded path", async () => {
    const repo = makeGitRepo("arcs-wt-mutex2-");
    cleanupFns.push(repo.cleanup);
    const linked = join(repo.root, "mine");
    execSync(`git worktree add -q "${linked}" -b arcs/plan-a`, {
      cwd: repo.root,
      stdio: "pipe",
    });

    const heldElsewhere = await isBranchCheckedOutInAnotherWorktree(
      repo.root,
      "arcs/plan-a",
      linked,
    );
    const freeBranch = await isBranchCheckedOutInAnotherWorktree(repo.root, "arcs/nobody", linked);

    expect(heldElsewhere).toBe(false);
    expect(freeBranch).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// countUnmergedCommits
// ---------------------------------------------------------------------------

describe("countUnmergedCommits", () => {
  let cleanupFns: Array<() => void>;

  beforeEach(() => {
    cleanupFns = [];
  });

  afterEach(() => {
    for (const fn of cleanupFns) fn();
  });

  function repoWithWorktree(prefix: string): { repo: string; wt: string } {
    const { root, cleanup } = makeGitRepo(prefix);
    cleanupFns.push(cleanup);
    const wt = join(root, "tree");
    execSync(`git worktree add -q "${wt}" -b arcs/counter`, { cwd: root, stdio: "pipe" });
    return { repo: root, wt };
  }

  it("returns 0 when the worktree branch sits at its base", async () => {
    const { wt } = repoWithWorktree("arcs-wt-count0-");
    expect(await countUnmergedCommits(wt)).toBe(0);
  });

  it("counts commits ahead of the base branch", async () => {
    const { wt } = repoWithWorktree("arcs-wt-count1-");
    writeFileSync(join(wt, "notes.md"), "wip\n");
    execSync("git add notes.md", { cwd: wt, stdio: "pipe" });
    execSync("git commit -qm wip", { cwd: wt, stdio: "pipe" });

    expect(await countUnmergedCommits(wt)).toBe(1);
  });

  it("returns null when neither upstream nor main/master exists", async () => {
    const { root, cleanup } = makeGitRepo("arcs-wt-null-");
    cleanupFns.push(cleanup);
    // Rename the default branch so neither `main` nor `master` resolves.
    const defaultBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: root })
      .toString()
      .trim();
    execSync(`git branch -m ${defaultBranch} trunk`, { cwd: root, stdio: "pipe" });
    const wt = join(root, "tree");
    execSync(`git worktree add -q "${wt}" -b arcs/orphan`, { cwd: root, stdio: "pipe" });

    expect(await countUnmergedCommits(wt)).toBeNull();
  });
});
