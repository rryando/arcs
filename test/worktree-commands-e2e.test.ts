/**
 * End-to-end tests for the worktree commands, run against a REAL temp git
 * repo (git init + initial commit) with ARCS_DATA isolated via
 * withTempDataDir. Commands are invoked through the CLI registry
 * (runCommand), so the full handler path is exercised.
 *
 * Covers:
 * - ensure: creates a sibling worktree + arcs/<plan> branch, registers it,
 *   and is idempotent on re-run
 * - validate: healthy → ok; missing-on-disk / branch-mismatch / collision
 *   violations → failure envelope
 * - prune: guarded-mode token gate; unmerged-commit refusal unless --force;
 *   batch prune of done/archived plans only; branches are never deleted
 * - non-git cwd: graceful failure envelope, no crash
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CLIResult } from "../src/cli/command-registry.js";
import { getProjectDir } from "../src/utils/paths.js";
import { defaultWorktreeRoot, resolvePlanWorktreePath } from "../src/utils/worktree.js";
import { readWorktreeRegistry, upsertWorktreeEntry } from "../src/utils/worktree-store.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SLUG = "wt-e2e-proj";
const E2E_TIMEOUT = 30_000;

function assertOk(result: CLIResult): asserts result is Extract<CLIResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected success, got [${result.code}]: ${result.message}`);
}

function assertFailed(result: CLIResult): asserts result is Extract<CLIResult, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure envelope");
}

/**
 * Real git repo (one initial commit) inside a sandbox dir, so the sibling
 * `<repo>-worktrees` convention lands inside the sandbox too.
 */
function makeRepoSandbox(): { sandbox: string; repo: string; cleanup: () => void } {
  const sandbox = mkdtempSync(resolve(tmpdir(), "arcs-wt-e2e-"));
  const repo = join(sandbox, "repo");
  mkdirSync(repo);
  execSync("git init", { cwd: repo, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: repo, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: repo, stdio: "pipe" });
  writeFileSync(join(repo, "README.md"), "# test\n");
  execSync("git add README.md", { cwd: repo, stdio: "pipe" });
  execSync("git commit -qm 'initial'", { cwd: repo, stdio: "pipe" });
  return {
    sandbox,
    repo,
    cleanup: () => rmSync(sandbox, { recursive: true, force: true }),
  };
}

/** Seed a project dir with plans so requireProject/readPlanIndex succeed. */
function seedProject(plans: Array<{ id: string; status: string }>): string {
  const projectDir = getProjectDir(SLUG);
  mkdirSync(join(projectDir, "plans"), { recursive: true });
  writeFileSync(
    join(projectDir, "meta.json"),
    JSON.stringify({ id: SLUG, name: "Worktree E2E" }),
    "utf-8",
  );

  const ts = "2025-01-01T00:00:00Z";
  const metas = plans.map((p) => ({
    id: p.id,
    normalizedId: p.id,
    title: p.id,
    status: p.status,
    keywords: [],
    summary: "",
    file: `plans/${p.id}.md`,
    createdAt: ts,
    updatedAt: ts,
  }));
  for (const meta of metas) {
    writeFileSync(
      join(projectDir, "plans", `${meta.normalizedId}.meta.json`),
      JSON.stringify(meta),
      "utf-8",
    );
    writeFileSync(join(projectDir, "plans", `${meta.normalizedId}.md`), `# ${meta.title}\n`);
  }
  writeFileSync(join(projectDir, "plans", "index.json"), JSON.stringify({ plans: metas }), "utf-8");
  return projectDir;
}

/** Run the callback with the process cwd moved into `dir` (restored after). */
async function withCwd(dir: string, run: () => Promise<void>): Promise<void> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    await run();
  } finally {
    process.chdir(previous);
  }
}

/** True when a local branch exists in the repo. */
function branchExists(repo: string, branch: string): boolean {
  try {
    execSync(`git rev-parse --verify --quiet refs/heads/${branch}`, {
      cwd: repo,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ensure — creation, registration, idempotency
// ---------------------------------------------------------------------------

describe("worktree ensure", () => {
  it(
    "creates a sibling worktree on arcs/<plan>, registers it, then is idempotent",
    async () => {
      await withTempDataDir(async () => {
        const { repo, cleanup } = makeRepoSandbox();
        try {
          seedProject([{ id: "plan-alpha", status: "planned" }]);
          await withCwd(repo, async () => {
            const first = await runCommand("worktree ensure", [SLUG, "plan-alpha"]);
            assertOk(first);
            const data = first.data as Record<string, unknown>;

            expect(data.created).toBe(true);
            expect(data.planId).toBe("plan-alpha");
            expect(data.branch).toBe("arcs/plan-alpha");
            expect(data.path).toBe(resolvePlanWorktreePath(repo, "plan-alpha"));
            expect(dirname(String(data.path))).toBe(defaultWorktreeRoot(repo));
            expect(existsSync(String(data.path))).toBe(true);
            expect(typeof data.baseCommit).toBe("string");
            expect(String(data.baseCommit)).toMatch(/^[0-9a-f]+$/);

            const registry = await readWorktreeRegistry(getProjectDir(SLUG));
            expect(registry).toHaveLength(1);
            expect(registry[0]).toMatchObject({
              planId: "plan-alpha",
              path: String(data.path),
              branch: "arcs/plan-alpha",
            });

            const second = await runCommand("worktree ensure", [SLUG, "plan-alpha"]);
            assertOk(second);
            const secondData = second.data as Record<string, unknown>;
            expect(secondData.created).toBe(false);
            expect(secondData.path).toBe(data.path);
          });
        } finally {
          cleanup();
        }
      });
    },
    E2E_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// validate — healthy vs drift
// ---------------------------------------------------------------------------

describe("worktree validate", () => {
  it(
    "passes with zero violations for a freshly ensured worktree",
    async () => {
      await withTempDataDir(async () => {
        const { repo, cleanup } = makeRepoSandbox();
        try {
          seedProject([{ id: "plan-alpha", status: "planned" }]);
          await withCwd(repo, async () => {
            assertOk(await runCommand("worktree ensure", [SLUG, "plan-alpha"]));

            const result = await runCommand("worktree validate", [SLUG]);
            assertOk(result);
            const data = result.data as { summary: { violations: number } };
            expect(data.summary.violations).toBe(0);
          });
        } finally {
          cleanup();
        }
      });
    },
    E2E_TIMEOUT,
  );

  it(
    "reports worktree_missing_on_disk when the tree vanished from disk and git",
    async () => {
      await withTempDataDir(async () => {
        const { repo, cleanup } = makeRepoSandbox();
        try {
          seedProject([{ id: "plan-alpha", status: "planned" }]);
          await withCwd(repo, async () => {
            const ensured = await runCommand("worktree ensure", [SLUG, "plan-alpha"]);
            assertOk(ensured);
            const wtPath = String((ensured.data as Record<string, unknown>).path);

            rmSync(wtPath, { recursive: true, force: true });
            // git keeps prunable admin entries after rm -rf; drop them so
            // the registry row points at a path absent from git's listing.
            execSync("git worktree prune", { cwd: repo, stdio: "pipe" });

            const result = await runCommand("worktree validate", [SLUG]);
            assertFailed(result);
            expect(result.code).toBe("validation_failed");
            expect(result.hint).toContain("worktree_missing_on_disk");
          });
        } finally {
          cleanup();
        }
      });
    },
    E2E_TIMEOUT,
  );

  it(
    "reports branch_mismatch when the wrong branch is checked out in the tree",
    async () => {
      await withTempDataDir(async () => {
        const { repo, cleanup } = makeRepoSandbox();
        try {
          seedProject([{ id: "plan-alpha", status: "planned" }]);
          await withCwd(repo, async () => {
            const ensured = await runCommand("worktree ensure", [SLUG, "plan-alpha"]);
            assertOk(ensured);
            const wtPath = String((ensured.data as Record<string, unknown>).path);

            execSync("git checkout -q -b rogue-branch", { cwd: wtPath, stdio: "pipe" });

            const result = await runCommand("worktree validate", [SLUG]);
            assertFailed(result);
            expect(result.code).toBe("validation_failed");
            expect(result.hint).toContain("branch_mismatch");
          });
        } finally {
          cleanup();
        }
      });
    },
    E2E_TIMEOUT,
  );

  it(
    "reports path_collision when two registry rows claim the same path",
    async () => {
      await withTempDataDir(async () => {
        const { repo, cleanup } = makeRepoSandbox();
        try {
          const projectDir = seedProject([
            { id: "plan-alpha", status: "planned" },
            { id: "plan-beta", status: "planned" },
          ]);
          await withCwd(repo, async () => {
            const ensured = await runCommand("worktree ensure", [SLUG, "plan-alpha"]);
            assertOk(ensured);
            const alphaPath = String((ensured.data as Record<string, unknown>).path);

            // Register plan-beta over plan-alpha's path directly.
            await upsertWorktreeEntry(projectDir, {
              planId: "plan-beta",
              path: alphaPath,
              branch: "arcs/plan-beta",
            });

            const result = await runCommand("worktree validate", [SLUG]);
            assertFailed(result);
            expect(result.code).toBe("validation_failed");
            expect(result.hint).toContain("path_collision");
          });
        } finally {
          cleanup();
        }
      });
    },
    E2E_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// prune — write gate, unmerged refusal, batch semantics
// ---------------------------------------------------------------------------

describe("worktree prune", () => {
  it(
    "enforces the guarded write gate, then proceeds with a token",
    async () => {
      await withTempDataDir(async () => {
        const { repo, cleanup } = makeRepoSandbox();
        try {
          seedProject([{ id: "plan-alpha", status: "done" }]);
          await withCwd(repo, async () => {
            const ensured = await runCommand("worktree ensure", [SLUG, "plan-alpha"]);
            assertOk(ensured);
            const wtPath = String((ensured.data as Record<string, unknown>).path);

            const prevGuarded = process.env.ARCS_GUARDED;
            process.env.ARCS_GUARDED = "1";
            try {
              const denied = await runCommand("worktree prune", [SLUG, "plan-alpha"]);
              assertFailed(denied);
              expect(denied.code).toBe("missing_token");
              expect(existsSync(wtPath)).toBe(true);

              const allowed = await runCommand("worktree prune", [
                SLUG,
                "plan-alpha",
                "--token",
                "tok-123",
              ]);
              assertOk(allowed);
              expect(existsSync(wtPath)).toBe(false);
            } finally {
              if (prevGuarded === undefined) delete process.env.ARCS_GUARDED;
              else process.env.ARCS_GUARDED = prevGuarded;
            }
          });
        } finally {
          cleanup();
        }
      });
    },
    E2E_TIMEOUT,
  );

  it(
    "refuses unmerged commits without --force; --force removes the tree but never the branch",
    async () => {
      await withTempDataDir(async () => {
        const { repo, cleanup } = makeRepoSandbox();
        try {
          seedProject([{ id: "plan-alpha", status: "done" }]);
          await withCwd(repo, async () => {
            const ensured = await runCommand("worktree ensure", [SLUG, "plan-alpha"]);
            assertOk(ensured);
            const wtPath = String((ensured.data as Record<string, unknown>).path);

            // Commit work on the plan branch — unreachable from the base.
            writeFileSync(join(wtPath, "notes.md"), "wip\n");
            execSync("git add notes.md", { cwd: wtPath, stdio: "pipe" });
            execSync("git commit -qm wip", { cwd: wtPath, stdio: "pipe" });

            const refused = await runCommand("worktree prune", [SLUG, "plan-alpha"]);
            assertFailed(refused);
            expect(refused.code).toBe("unmerged_commits");
            expect(existsSync(wtPath)).toBe(true);

            const forced = await runCommand("worktree prune", [SLUG, "plan-alpha", "--force"]);
            assertOk(forced);
            const forcedData = forced.data as Record<string, unknown>;
            expect(forcedData.worktreeRemoved).toBe(true);
            expect(forcedData.registryRemoved).toBe(true);
            expect(forcedData.branchesDeleted).toBe(false);
            expect(existsSync(wtPath)).toBe(false);
            expect(await readWorktreeRegistry(getProjectDir(SLUG))).toEqual([]);
            expect(branchExists(repo, "arcs/plan-alpha")).toBe(true);
          });
        } finally {
          cleanup();
        }
      });
    },
    E2E_TIMEOUT,
  );

  it(
    "batch prune removes done/archived trees and skips the rest",
    async () => {
      await withTempDataDir(async () => {
        const { repo, cleanup } = makeRepoSandbox();
        try {
          seedProject([
            { id: "plan-done", status: "done" },
            { id: "plan-keep", status: "planned" },
          ]);
          await withCwd(repo, async () => {
            const doneTree = await runCommand("worktree ensure", [SLUG, "plan-done"]);
            assertOk(doneTree);
            const keepTree = await runCommand("worktree ensure", [SLUG, "plan-keep"]);
            assertOk(keepTree);
            const keepPath = String((keepTree.data as Record<string, unknown>).path);

            const result = await runCommand("worktree prune", [SLUG]);
            assertOk(result);
            const data = result.data as {
              removed: Array<{ planId: string }>;
              skipped: Array<{ planId: string; reason: string }>;
            };
            expect(data.removed.map((r) => r.planId)).toEqual(["plan-done"]);
            expect(data.skipped).toHaveLength(1);
            expect(data.skipped[0].planId).toBe("plan-keep");
            expect(data.skipped[0].reason).toContain("planned");

            const registry = await readWorktreeRegistry(getProjectDir(SLUG));
            expect(registry.map((row) => row.planId)).toEqual(["plan-keep"]);
            expect(existsSync(keepPath)).toBe(true);
            expect(branchExists(repo, "arcs/plan-done")).toBe(true);
          });
        } finally {
          cleanup();
        }
      });
    },
    E2E_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// non-git cwd — graceful failure envelope
// ---------------------------------------------------------------------------

describe("worktree commands outside a git repo", () => {
  it(
    "return not_a_git_repo failures instead of crashing",
    async () => {
      await withTempDataDir(async (dataDir) => {
        seedProject([{ id: "plan-alpha", status: "planned" }]);
        // dataDir itself is not a git repo.
        await withCwd(dataDir, async () => {
          const validated = await runCommand("worktree validate", [SLUG]);
          assertFailed(validated);
          expect(validated.code).toBe("not_a_git_repo");

          const ensured = await runCommand("worktree ensure", [SLUG, "plan-alpha"]);
          assertFailed(ensured);
          expect(ensured.code).toBe("not_a_git_repo");

          const pruned = await runCommand("worktree prune", [SLUG, "plan-alpha"]);
          assertFailed(pruned);
          expect(pruned.code).toBe("not_a_git_repo");
        });
      });
    },
    E2E_TIMEOUT,
  );
});
