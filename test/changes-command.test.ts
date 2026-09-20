// ---------------------------------------------------------------------------
// Tests for the change-ledger CLI surface:
//   task record-change  — record commits / a range / a PR URL, or retract a sha
//   task changes        — per-task read view, --patch re-rendered from git
//   plan changes        — roll-up across the plan's tasks
//
// Envelope behavior plus the offline/reachable-only guarantees: --patch renders
// a live patch from git, and a dangling sha reports reachable:false with no
// patch. No command here may contact a network.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

function git(dir: string, args: string[]): string {
  const proc = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return (proc.stdout ?? "").trim();
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Changes Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function commitFile(dir: string, name: string, content: string, message: string): string {
  writeFileSync(resolve(dir, name), content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function makeTask(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    normalizedId: id,
    title: `Task ${id}`,
    status: "in_progress",
    priority: "medium",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...extra,
  };
}

function makePlan(id: string): Record<string, unknown> {
  return {
    id,
    normalizedId: id,
    title: `Plan ${id}`,
    status: "in_progress",
    keywords: [],
    summary: "plan",
    file: `plans/${id}.md`,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };
}

function seedProject(
  dir: string,
  slug: string,
  workspacePath: string,
  tasks: unknown[],
  plans: unknown[] = [],
): void {
  writeFileSync(
    resolve(dir, "meta.json"),
    JSON.stringify({
      version: "1.0",
      projects: [{ id: slug, name: "Test Project", status: "active", dependsOn: [] }],
    }),
    "utf-8",
  );

  const projDir = resolve(dir, "projects", slug);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    resolve(projDir, "meta.json"),
    JSON.stringify({
      id: slug,
      name: "Test Project",
      description: "A test project",
      createdAt: "2025-01-01T00:00:00Z",
      workspacePaths: [workspacePath],
    }),
    "utf-8",
  );

  const tasksDir = resolve(projDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(resolve(tasksDir, "index.json"), JSON.stringify({ tasks }), "utf-8");

  const plansDir = resolve(projDir, "plans");
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(resolve(plansDir, "index.json"), JSON.stringify({ plans }), "utf-8");
  for (const plan of plans as Array<{ normalizedId: string } & Record<string, unknown>>) {
    writeFileSync(
      resolve(plansDir, `${plan.normalizedId}.meta.json`),
      JSON.stringify(plan),
      "utf-8",
    );
  }

  const knowledgeDir = resolve(projDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(resolve(knowledgeDir, "index.json"), JSON.stringify({ entries: [] }), "utf-8");
}

function ledgerLines(dir: string, slug: string): Array<Record<string, unknown>> {
  const path = resolve(dir, "projects", slug, "workflow", "changes.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("arcs task record-change / task changes", () => {
  it("records a baseline..HEAD range and lists it back", async () => {
    await withTempDataDir(async (dir) => {
      const repo = mkdtempSync(resolve(dir, "repo-"));
      initRepo(repo);
      const base = commitFile(repo, "a.txt", "one\n", "base");
      seedProject(dir, "ledger-proj", repo, [makeTask("t1", { startHead: base })]);
      const head = commitFile(repo, "b.txt", "two\n", "add b");

      const record = await runCommand("task record-change", [
        "ledger-proj",
        "t1",
        "--range=..HEAD",
        "--json",
      ]);
      expect(record.ok).toBe(true);
      if (!record.ok) return;
      const recorded = (record.data as { recorded: Array<{ sha: string }> }).recorded;
      expect(recorded).toHaveLength(1);
      expect(recorded[0].sha).toBe(head);

      const list = await runCommand("task changes", ["ledger-proj", "t1", "--json"]);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const data = list.data as {
        changes: Array<{ kind: string; sha: string; subject: string; reachable?: boolean }>;
        summary: { commits: number; files: number; additions: number };
      };
      expect(data.changes).toHaveLength(1);
      expect(data.changes[0].kind).toBe("commit");
      expect(data.changes[0].sha).toBe(head);
      expect(data.changes[0].reachable).toBe(true);
      expect(data.summary.commits).toBe(1);
      expect(data.summary.files).toBe(1);
    });
  });

  it("re-renders --patch from git for a reachable commit only", async () => {
    await withTempDataDir(async (dir) => {
      const repo = mkdtempSync(resolve(dir, "repo-"));
      initRepo(repo);
      const base = commitFile(repo, "a.txt", "one\n", "base");
      seedProject(dir, "patch-proj", repo, [makeTask("t1", { startHead: base })]);
      commitFile(repo, "b.txt", "two\n", "add b");

      expect(
        (await runCommand("task record-change", ["patch-proj", "t1", "--range=..HEAD", "--json"]))
          .ok,
      ).toBe(true);

      const list = await runCommand("task changes", ["patch-proj", "t1", "--patch", "--json"]);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const changes = (list.data as { changes: Array<{ patch?: string }> }).changes;
      expect(changes[0].patch).toContain("diff --git a/b.txt b/b.txt");
      expect(changes[0].patch).toContain("+two");

      // The ledger on disk still holds no body.
      const raw = readFileSync(
        resolve(dir, "projects", "patch-proj", "workflow", "changes.jsonl"),
        "utf-8",
      );
      expect(raw).not.toContain("diff --git");
    });
  });

  it("reports reachable:false for a sha HEAD no longer reaches, and omits its patch", async () => {
    await withTempDataDir(async (dir) => {
      const repo = mkdtempSync(resolve(dir, "repo-"));
      initRepo(repo);
      const base = commitFile(repo, "a.txt", "one\n", "base");
      seedProject(dir, "dangling-proj", repo, [makeTask("t1", { startHead: base })]);
      commitFile(repo, "b.txt", "two\n", "add b");

      expect(
        (
          await runCommand("task record-change", [
            "dangling-proj",
            "t1",
            "--range=..HEAD",
            "--json",
          ])
        ).ok,
      ).toBe(true);

      // Rewind HEAD so the recorded commit is no longer an ancestor of HEAD.
      git(repo, ["reset", "--hard", base]);

      const list = await runCommand("task changes", ["dangling-proj", "t1", "--patch", "--json"]);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const changes = (list.data as { changes: Array<{ reachable?: boolean; patch?: string }> })
        .changes;
      expect(changes).toHaveLength(1);
      expect(changes[0].reachable).toBe(false);
      expect(changes[0].patch).toBeUndefined();
    });
  });

  it("stores a --pr URL offline without contacting a network", async () => {
    await withTempDataDir(async (dir) => {
      const repo = mkdtempSync(resolve(dir, "repo-"));
      initRepo(repo);
      const base = commitFile(repo, "a.txt", "one\n", "base");
      seedProject(dir, "pr-proj", repo, [makeTask("t1", { startHead: base })]);

      const result = await runCommand("task record-change", [
        "pr-proj",
        "t1",
        "--pr=https://example.com/pull/7",
        "--json",
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const recorded = (result.data as { recorded: Array<{ kind: string; pr?: { url: string } }> })
        .recorded;
      expect(recorded[0].kind).toBe("pr");
      expect(recorded[0].pr?.url).toBe("https://example.com/pull/7");

      const lines = ledgerLines(dir, "pr-proj");
      expect(lines[0].pr).toEqual({ url: "https://example.com/pull/7" });
    });
  });

  it("retracts a recorded sha with --remove", async () => {
    await withTempDataDir(async (dir) => {
      const repo = mkdtempSync(resolve(dir, "repo-"));
      initRepo(repo);
      const base = commitFile(repo, "a.txt", "one\n", "base");
      seedProject(dir, "remove-proj", repo, [makeTask("t1", { startHead: base })]);
      const head = commitFile(repo, "b.txt", "two\n", "add b");
      await runCommand("task record-change", ["remove-proj", "t1", "--range=..HEAD", "--json"]);

      const removed = await runCommand("task record-change", [
        "remove-proj",
        "t1",
        `--remove=${head.slice(0, 7)}`,
        "--json",
      ]);
      expect(removed.ok).toBe(true);
      if (!removed.ok) return;
      expect((removed.data as { removed: string[] }).removed).toEqual([head]);

      const list = await runCommand("task changes", ["remove-proj", "t1", "--json"]);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect((list.data as { changes: unknown[] }).changes).toHaveLength(0);
    });
  });

  it("--dry-run resolves everything without writing", async () => {
    await withTempDataDir(async (dir) => {
      const repo = mkdtempSync(resolve(dir, "repo-"));
      initRepo(repo);
      const base = commitFile(repo, "a.txt", "one\n", "base");
      seedProject(dir, "dry-proj", repo, [makeTask("t1", { startHead: base })]);
      const head = commitFile(repo, "b.txt", "two\n", "add b");

      const result = await runCommand("task record-change", [
        "dry-proj",
        "t1",
        "--range=..HEAD",
        "--dry-run",
        "--json",
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { dryRun: boolean; wouldRecord: { commits: string[] } };
      expect(data.dryRun).toBe(true);
      expect(data.wouldRecord.commits).toEqual([head]);
      expect(ledgerLines(dir, "dry-proj")).toHaveLength(0);
    });
  });

  it("errors when no selector is given", async () => {
    await withTempDataDir(async (dir) => {
      const repo = mkdtempSync(resolve(dir, "repo-"));
      initRepo(repo);
      commitFile(repo, "a.txt", "one\n", "base");
      seedProject(dir, "noname-proj", repo, [makeTask("t1")]);

      const result = await runCommand("task record-change", ["noname-proj", "t1", "--json"]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("missing_param");
    });
  });

  it("errors for an unknown task", async () => {
    await withTempDataDir(async (dir) => {
      const repo = mkdtempSync(resolve(dir, "repo-"));
      initRepo(repo);
      commitFile(repo, "a.txt", "one\n", "base");
      seedProject(dir, "notask-proj", repo, [makeTask("t1")]);

      const result = await runCommand("task changes", ["notask-proj", "ghost", "--json"]);
      expect(result.ok).toBe(false);
    });
  });

  it("errors for an unknown project", async () => {
    await withTempDataDir(async () => {
      const result = await runCommand("task changes", ["no-such-proj", "t1", "--json"]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("project_not_found");
    });
  });
});

describe("arcs plan changes", () => {
  it("rolls up a plan's tasks even when an entry carries no planId", async () => {
    await withTempDataDir(async (dir) => {
      const repo = mkdtempSync(resolve(dir, "repo-"));
      initRepo(repo);
      const base = commitFile(repo, "a.txt", "one\n", "base");
      seedProject(
        dir,
        "plan-proj",
        repo,
        [makeTask("t1", { startHead: base, planId: "p1" })],
        [makePlan("p1")],
      );
      const head = commitFile(repo, "b.txt", "two\n", "add b");
      await runCommand("task record-change", ["plan-proj", "t1", "--range=..HEAD", "--json"]);

      const result = await runCommand("plan changes", ["plan-proj", "p1", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as {
        planId: string;
        changes: Array<{ sha: string }>;
        summary: { commits: number };
      };
      expect(data.planId).toBe("p1");
      expect(data.changes).toHaveLength(1);
      expect(data.changes[0].sha).toBe(head);
      expect(data.summary.commits).toBe(1);
    });
  });

  it("errors for an unknown plan", async () => {
    await withTempDataDir(async (dir) => {
      const repo = mkdtempSync(resolve(dir, "repo-"));
      initRepo(repo);
      commitFile(repo, "a.txt", "one\n", "base");
      seedProject(dir, "noplan-proj", repo, [makeTask("t1")], []);

      const result = await runCommand("plan changes", ["noplan-proj", "ghost", "--json"]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("entity_not_found");
    });
  });
});

// ---------------------------------------------------------------------------
// `arcs done` wiring — the ledger is recorded by the transition and never
// fails it.

describe("arcs done → change ledger", () => {
  it("records the committed range and a pending worktree entry", async () => {
    await withTempDataDir(async (dir) => {
      const repo = mkdtempSync(resolve(dir, "repo-"));
      initRepo(repo);
      const base = commitFile(repo, "a.txt", "one\n", "base");
      seedProject(dir, "done-proj", repo, [
        makeTask("t1", { startHead: base, status: "in_progress" }),
      ]);
      const head = commitFile(repo, "b.txt", "two\n", "add b");
      // Uncommitted work left behind at `done` time.
      writeFileSync(resolve(repo, "wip.txt"), "wip\n");

      const done = await runCommand("done", ["done-proj", "t1", "--json"]);
      expect(done.ok).toBe(true);
      if (!done.ok) return;
      const ledger = (done.data as { ledger?: { recorded: Array<{ kind: string; sha?: string }> } })
        .ledger;
      expect(ledger).toBeDefined();
      const kinds = ledger?.recorded.map((r) => r.kind) ?? [];
      expect(kinds).toContain("commit");
      expect(kinds).toContain("pending");
      const commit = ledger?.recorded.find((r) => r.kind === "commit");
      expect(commit?.sha).toBe(head);

      const list = await runCommand("task changes", ["done-proj", "t1", "--json"]);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const data = list.data as {
        changes: Array<{ kind: string }>;
        summary: { commits: number; pending: number };
      };
      expect(data.summary.commits).toBe(1);
      expect(data.summary.pending).toBe(1);
    });
  });

  it("does not fail the transition in a non-git workspace and reports ledgerSkipped", async () => {
    await withTempDataDir(async (dir) => {
      const plain = mkdtempSync(resolve(dir, "plain-"));
      seedProject(dir, "nogit-ledger", plain, [makeTask("t1", { status: "in_progress" })]);

      const done = await runCommand("done", ["nogit-ledger", "t1", "--json"]);
      expect(done.ok).toBe(true);
      if (!done.ok) return;
      const data = done.data as { ledger?: unknown; ledgerSkipped?: string };
      expect(data.ledger).toBeUndefined();
      expect(typeof data.ledgerSkipped).toBe("string");
      expect(ledgerLines(dir, "nogit-ledger")).toHaveLength(0);
    });
  });
});
