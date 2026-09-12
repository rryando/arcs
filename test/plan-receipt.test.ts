// ---------------------------------------------------------------------------
// Tests for plan-level completion receipts
//
// A plan receipt is captured by `arcs done` exactly once, when the plan's last
// open task completes. It covers the plan's base commit → HEAD, carries
// per-task attribution, and is surfaced by `arcs plan get`.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/cli/md-renderer.js";
import { getTask, readPlanIndex } from "../src/utils/project-memory.js";
import { readReceipt } from "../src/utils/report-store.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function git(dir: string, args: string[]): string {
  const proc = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (proc.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr ?? proc.error}`);
  }
  return (proc.stdout ?? "").trim();
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Plan Receipt Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function newRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "arcs-plan-receipt-repo-"));
  tempDirs.push(repo);
  initRepo(repo);
  return repo;
}

function commitFile(dir: string, name: string, content: string): string {
  writeFileSync(resolve(dir, name), content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `add ${name}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function makeTask(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    normalizedId: id,
    title: `Task ${id}`,
    status: "backlog",
    priority: "medium",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...extra,
  };
}

function makePlan(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    normalizedId: id,
    title: `Plan ${id}`,
    status: "in_progress",
    keywords: [],
    summary: `Summary for ${id}`,
    file: `plans/${id}.md`,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...extra,
  };
}

function seedProject(
  dataDir: string,
  slug: string,
  opts: { workspacePath: string; tasks: unknown[]; plans?: unknown[] },
): void {
  writeFileSync(
    resolve(dataDir, "meta.json"),
    JSON.stringify({
      version: "1.0",
      projects: [{ id: slug, name: "Test Project", status: "active", dependsOn: [] }],
    }),
    "utf-8",
  );

  const projDir = resolve(dataDir, "projects", slug);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    resolve(projDir, "meta.json"),
    JSON.stringify({
      id: slug,
      name: "Test Project",
      description: "A test project",
      createdAt: "2025-01-01T00:00:00Z",
      workspacePaths: [opts.workspacePath],
    }),
    "utf-8",
  );

  const tasksDir = resolve(projDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(resolve(tasksDir, "index.json"), JSON.stringify({ tasks: opts.tasks }), "utf-8");

  const plansDir = resolve(projDir, "plans");
  mkdirSync(plansDir, { recursive: true });
  const plans = opts.plans ?? [];
  writeFileSync(resolve(plansDir, "index.json"), JSON.stringify({ plans }), "utf-8");
  for (const raw of plans as Array<Record<string, unknown>>) {
    const id = raw.normalizedId as string;
    writeFileSync(resolve(plansDir, `${id}.meta.json`), JSON.stringify(raw), "utf-8");
    writeFileSync(resolve(plansDir, `${id}.md`), `# ${raw.title}\n\nBody for ${id}.\n`, "utf-8");
  }

  const knowledgeDir = resolve(projDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(resolve(knowledgeDir, "index.json"), JSON.stringify({ entries: [] }), "utf-8");
}

function seedWorktree(
  dataDir: string,
  slug: string,
  entry: { planId: string; path: string; branch: string; baseCommit?: string },
): void {
  writeFileSync(
    resolve(dataDir, "projects", slug, "worktrees.json"),
    JSON.stringify({
      worktrees: [{ ...entry, createdAt: "2025-01-01T00:00:00Z" }],
    }),
    "utf-8",
  );
}

function projectDir(dataDir: string, slug: string): string {
  return resolve(dataDir, "projects", slug);
}

async function planMeta(dataDir: string, slug: string, planId: string) {
  const index = await readPlanIndex(projectDir(dataDir, slug));
  return index.plans.find((p) => p.id === planId || p.normalizedId === planId);
}

/**
 * Two-task plan: t1 then t2. t1 is completed at `head1` and t2 at `head2`.
 * Returns the shas so tests can assert on base/head resolution.
 */
async function runTwoTaskPlan(
  dataDir: string,
  slug: string,
  opts: { remote?: string; worktreeBase?: string; planId?: string } = {},
): Promise<{ repo: string; base: string; head1: string; head2: string; planId: string }> {
  const planId = opts.planId ?? "p1";
  const repo = newRepo();
  const base = commitFile(repo, "a.txt", "one\n");
  if (opts.remote) git(repo, ["remote", "add", "origin", opts.remote]);

  seedProject(dataDir, slug, {
    workspacePath: repo,
    tasks: [makeTask("t1", { planId }), makeTask("t2", { planId })],
    plans: [makePlan(planId)],
  });
  if (opts.worktreeBase) {
    seedWorktree(dataDir, slug, {
      planId,
      path: repo,
      branch: `arcs/${planId}`,
      baseCommit: opts.worktreeBase,
    });
  }

  expect((await runCommand("task transition", [slug, "t1", "in_progress", "--json"])).ok).toBe(
    true,
  );
  const head1 = commitFile(repo, "b.txt", "two\n");
  expect((await runCommand("done", [slug, "t1", "--json"])).ok).toBe(true);

  expect((await runCommand("task transition", [slug, "t2", "in_progress", "--json"])).ok).toBe(
    true,
  );
  const head2 = commitFile(repo, "c.txt", "three\n");

  return { repo, base, head1, head2, planId };
}

// ---------------------------------------------------------------------------
// Capture lifecycle
// ---------------------------------------------------------------------------

describe("plan completion receipt", () => {
  it("writes a plan receipt only when the LAST task completes", async () => {
    await withTempDataDir(async (dataDir) => {
      const slug = "two-task";
      const { base, head1, head2 } = await runTwoTaskPlan(dataDir, slug);

      const reports = resolve(projectDir(dataDir, slug), "reports");

      // After t1: task receipt only, no plan receipt yet.
      expect(existsSync(resolve(reports, "t1.json"))).toBe(true);
      expect(existsSync(resolve(reports, "p1.json"))).toBe(false);
      expect((await planMeta(dataDir, slug, "p1"))?.report).toBeUndefined();

      // t2 is the last open task.
      const done = await runCommand("done", [slug, "t2", "--json"]);
      expect(done.ok).toBe(true);
      if (!done.ok) return;
      const data = done.data as Record<string, unknown>;
      const planReport = data.planReport as Record<string, unknown>;
      expect(planReport).toBeDefined();
      expect(planReport.commit).toBe(head2);

      // Sidecar pair on disk.
      expect(existsSync(resolve(reports, "p2.json"))).toBe(false);
      expect(existsSync(resolve(reports, "p1.json"))).toBe(true);
      expect(existsSync(resolve(reports, "p1.diff"))).toBe(true);

      // Pointer persisted on PlanMeta.
      const meta = await planMeta(dataDir, slug, "p1");
      expect(meta?.report).toBeDefined();
      expect(meta?.report?.commit).toBe(head2);
      expect(meta?.report?.baseRef).toBe(base);
      // Additive: the plan's status is not flipped by this change.
      expect(meta?.status).toBe("in_progress");

      // Head is HEAD; base is the plan's first startHead (case c).
      const receipt = readReceipt(dataDir, slug, "p1");
      expect(receipt).not.toBeNull();
      expect(receipt?.headSha).toBe(head2);
      expect(receipt?.baseSha).toBe(base);
      expect(receipt?.planId).toBe("p1");

      // Per-task attribution for every task, with its completion commit.
      const attribution = receipt?.taskAttribution;
      expect(attribution).toHaveLength(2);
      const byId = new Map((attribution ?? []).map((a) => [a.taskId, a]));
      expect(byId.get("t1")?.commit).toBe(head1);
      expect(byId.get("t2")?.commit).toBe(head2);
      expect(byId.get("t1")?.startHead).toBe(base);
      expect(byId.get("t1")?.filesChanged).toBe(1);
      expect(byId.get("t1")?.insertions).toBe(1);
    });
  });

  it("uses the first task's startHead as base when no worktree is registered", async () => {
    await withTempDataDir(async (dataDir) => {
      const slug = "case-c";
      const { base } = await runTwoTaskPlan(dataDir, slug);

      const t1 = await getTask(projectDir(dataDir, slug), "t1");
      expect(t1.startHead).toBe(base);

      await runCommand("done", [slug, "t2", "--json"]);
      const receipt = readReceipt(dataDir, slug, "p1");
      expect(receipt?.baseSha).toBe(t1.startHead);
      expect(receipt?.baseSha).toBe(base);
    });
  });

  it("uses the registered worktree baseCommit as base (case b)", async () => {
    await withTempDataDir(async (dataDir) => {
      const slug = "case-b";
      // base0 is older than the tasks' startHead: the worktree base wins.
      const repo = newRepo();
      const base0 = commitFile(repo, "root.txt", "root\n");
      const base1 = commitFile(repo, "z.txt", "zz\n");

      seedProject(dataDir, slug, {
        workspacePath: repo,
        tasks: [makeTask("t1", { planId: "p1" }), makeTask("t2", { planId: "p1" })],
        plans: [makePlan("p1")],
      });
      seedWorktree(dataDir, slug, {
        planId: "p1",
        path: repo,
        branch: "arcs/p1",
        baseCommit: base0,
      });

      await runCommand("task transition", [slug, "t1", "in_progress", "--json"]);
      const t1Start = (await getTask(projectDir(dataDir, slug), "t1")).startHead;
      expect(t1Start).toBe(base1);

      commitFile(repo, "b.txt", "two\n");
      await runCommand("done", [slug, "t1", "--json"]);
      await runCommand("task transition", [slug, "t2", "in_progress", "--json"]);
      const head2 = commitFile(repo, "c.txt", "three\n");
      await runCommand("done", [slug, "t2", "--json"]);

      const receipt = readReceipt(dataDir, slug, "p1");
      expect(receipt?.baseSha).toBe(base0);
      expect(receipt?.baseSha).not.toBe(t1Start);
      expect(receipt?.headSha).toBe(head2);
    });
  });

  it("honors --since and --commit overrides", async () => {
    await withTempDataDir(async (dataDir) => {
      const slug = "overrides";
      const { base, head1 } = await runTwoTaskPlan(dataDir, slug);

      // Explicit --since wins for base; explicit --commit wins for head.
      const done = await runCommand("done", [
        slug,
        "t2",
        `--since=${head1}`,
        `--commit=${head1}`,
        "--json",
      ]);
      expect(done.ok).toBe(true);
      if (!done.ok) return;

      const receipt = readReceipt(dataDir, slug, "p1");
      expect(receipt?.baseSha).toBe(head1);
      expect(receipt?.headSha).toBe(head1);
      expect(receipt?.baseSha).not.toBe(base);

      // The task receipt and the plan pointer agree on the override head.
      const meta = await planMeta(dataDir, slug, "p1");
      expect(meta?.report?.commit).toBe(head1);
    });
  });

  it("does not fail and captures nothing when workspace is not a git repo", async () => {
    await withTempDataDir(async (dataDir) => {
      const slug = "nogit";
      const plain = mkdtempSync(join(tmpdir(), "arcs-plan-receipt-plain-"));
      tempDirs.push(plain);
      seedProject(dataDir, slug, {
        workspacePath: plain,
        tasks: [makeTask("t1", { planId: "p1" })],
        plans: [makePlan("p1")],
      });

      const done = await runCommand("done", [slug, "t1", "--json"]);
      expect(done.ok).toBe(true);
      if (!done.ok) return;
      const data = done.data as Record<string, unknown>;
      expect(data.planReport).toBeUndefined();
      expect(data.planReportSkipped).toBeUndefined();
      expect(existsSync(resolve(projectDir(dataDir, slug), "reports"))).toBe(false);
      expect((await planMeta(dataDir, slug, "p1"))?.report).toBeUndefined();
    });
  });

  it("does not write a receipt for a plan with zero tasks or an unknown planId", async () => {
    await withTempDataDir(async (dataDir) => {
      const slug = "edge";
      const repo = newRepo();
      commitFile(repo, "a.txt", "one\n");
      seedProject(dataDir, slug, {
        workspacePath: repo,
        tasks: [makeTask("t1")],
        plans: [makePlan("empty")],
      });

      // Unknown planId: no plan tasks match, so no receipt and no error.
      const unknown = await runCommand("done", [slug, "t1", "--planId=nope", "--json"]);
      expect(unknown.ok).toBe(true);

      // Existing plan with zero tasks: still no receipt, no error.
      const empty = await runCommand("done", [slug, "t1", "--planId=empty", "--json"]);
      expect(empty.ok).toBe(true);
      expect((await planMeta(dataDir, slug, "empty"))?.report).toBeUndefined();
      expect(existsSync(resolve(projectDir(dataDir, slug), "reports", "empty.json"))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// plan get surfacing
// ---------------------------------------------------------------------------

describe("plan get surfaces the receipt", () => {
  async function completedPlan(
    dataDir: string,
    slug: string,
    opts: { remote?: string } = {},
  ): Promise<{ head2: string; planId: string }> {
    const { head2, planId } = await runTwoTaskPlan(dataDir, slug, opts);
    await runCommand("done", [slug, "t2", "--json"]);
    return { head2, planId };
  }

  it("returns the pointer and a compare URL in --json", async () => {
    await withTempDataDir(async (dataDir) => {
      const slug = "plan-get-json";
      const { head2 } = await completedPlan(dataDir, slug, {
        remote: "git@github.com:owner/repo.git",
      });

      const result = await runCommand("plan get", [slug, "p1", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;

      const report = data.report as Record<string, unknown>;
      expect(report).toBeDefined();
      expect(report.commit).toBe(head2);

      const receipt = data.receipt as Record<string, unknown>;
      expect(receipt).toBeDefined();
      expect(String(receipt.url)).toContain(`/compare/`);
      expect(String(receipt.url)).toContain(head2);
      expect(receipt.headSha).toBe(head2);
      expect(Array.isArray(receipt.taskAttribution)).toBe(true);
    });
  });

  it("prints the repo range link, diffstat, and per-task lines", async () => {
    await withTempDataDir(async (dataDir) => {
      const slug = "plan-get-human";
      const { head2 } = await completedPlan(dataDir, slug, {
        remote: "git@github.com:owner/repo.git",
      });

      const result = await runCommand("plan get", [slug, "p1"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const md = renderMarkdown("plan get", result.data);
      expect(md).not.toBeNull();
      expect(md).toContain("**Plan p1**");
      expect(md).toContain("https://github.com/owner/repo/compare/");
      expect(md).toContain(head2);
      expect(md).toContain("Diffstat:");
      expect(md).toContain("files changed");
      expect(md).toContain("Tasks:");
      expect(md).toContain("t1");
      expect(md).toContain("t2");
    });
  });

  it("renders a plan with no receipt exactly as before", async () => {
    await withTempDataDir(async (dataDir) => {
      const slug = "plan-no-receipt";
      const repo = newRepo();
      commitFile(repo, "a.txt", "one\n");
      seedProject(dataDir, slug, {
        workspacePath: repo,
        tasks: [],
        plans: [makePlan("p2", { status: "planned", summary: "Nothing done yet." })],
      });

      const result = await runCommand("plan get", [slug, "p2", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      expect(data.title).toBe("Plan p2");
      expect(data.report).toBeUndefined();
      expect(data.receipt).toBeUndefined();
      expect(data.diff).toBeUndefined();

      const md = renderMarkdown("plan get", result.data);
      expect(md).toBe("**Plan p2**\nStatus: planned\n\nNothing done yet.");
      expect(md).not.toContain("Diffstat:");
      expect(md).not.toContain("Commit:");
    });
  });

  it("includes the capped diff with --diff", async () => {
    await withTempDataDir(async (dataDir) => {
      const slug = "plan-get-diff";
      await completedPlan(dataDir, slug);

      const result = await runCommand("plan get", [slug, "p1", "--diff", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      expect(typeof data.diff).toBe("string");
      expect(String(data.diff)).toContain("@@");
    });
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe("plan index backward compatibility", () => {
  it("loads a plans/index.json written before the report field existed", async () => {
    await withTempDataDir(async (dataDir) => {
      const slug = "legacy";
      const legacy = makePlan("legacy-plan", { status: "planned" });
      // Legacy meta carries no `report` key at all.
      expect("report" in legacy).toBe(false);

      const plainWorkspace = mkdtempSync(join(tmpdir(), "arcs-plan-receipt-legacy-"));
      tempDirs.push(plainWorkspace);
      seedProject(dataDir, slug, {
        workspacePath: plainWorkspace,
        tasks: [],
        plans: [legacy],
      });

      const index = await readPlanIndex(projectDir(dataDir, slug));
      const loaded = index.plans.find((p) => p.id === "legacy-plan");
      expect(loaded).toBeDefined();
      expect(loaded?.report).toBeUndefined();
      expect(loaded?.title).toBe("Plan legacy-plan");
    });
  });
});
