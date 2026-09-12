// ---------------------------------------------------------------------------
// Tests for `arcs done` command
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/cli/md-renderer.js";
import { deriveDiffCodeRanges, parseDiffFileRanges } from "../src/utils/code-snippet.js";
import { readReceipt } from "../src/utils/report-store.js";
import { getTask } from "../src/utils/task-store.js";
import { upsertWorktreeEntry } from "../src/utils/worktree-store.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

function seedProject(dir: string, slug: string, opts?: { tasks?: unknown[]; plans?: unknown[] }) {
  const rootMeta = {
    version: "1.0",
    projects: [{ id: slug, name: "Test Project", status: "active", dependsOn: [] }],
  };
  writeFileSync(resolve(dir, "meta.json"), JSON.stringify(rootMeta), "utf-8");

  const projDir = resolve(dir, "projects", slug);
  mkdirSync(projDir, { recursive: true });

  const cwd = process.cwd();
  const projectMeta = {
    id: slug,
    name: "Test Project",
    description: "A test project",
    createdAt: "2025-01-01T00:00:00Z",
    workspacePaths: [cwd],
  };
  writeFileSync(resolve(projDir, "meta.json"), JSON.stringify(projectMeta), "utf-8");
  writeFileSync(resolve(projDir, "overview.md"), "Overview content.\n", "utf-8");

  const tasksDir = resolve(projDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const tasks = opts?.tasks ?? [
    {
      id: "t1",
      normalizedId: "t1",
      title: "Implement feature X",
      status: "backlog",
      priority: "high",
      planId: "p1",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    },
    {
      id: "t2",
      normalizedId: "t2",
      title: "Write tests",
      status: "backlog",
      priority: "medium",
      planId: "p1",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    },
  ];
  writeFileSync(resolve(tasksDir, "index.json"), JSON.stringify({ tasks }), "utf-8");

  const plansDir = resolve(projDir, "plans");
  mkdirSync(plansDir, { recursive: true });
  const plans = opts?.plans ?? [
    {
      id: "p1",
      normalizedId: "p1",
      title: "Feature Plan",
      status: "in_progress",
      keywords: [],
      summary: "This plan implements feature X.",
      file: "plans/p1.md",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    },
  ];
  writeFileSync(resolve(plansDir, "index.json"), JSON.stringify({ plans }), "utf-8");
  for (const p of plans as Array<{ normalizedId: string } & Record<string, unknown>>) {
    writeFileSync(resolve(plansDir, `${p.normalizedId}.meta.json`), JSON.stringify(p), "utf-8");
  }

  const knowledgeDir = resolve(projDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(resolve(knowledgeDir, "index.json"), JSON.stringify({ entries: [] }), "utf-8");
}

describe("arcs done", () => {
  it("marks task as done and returns next task as JSON", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "test-proj");
      const result = await runCommand("done", ["test-proj", "t1", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      const completed = data.completed as Record<string, unknown>;
      expect(completed.id).toBe("t1");
      expect(completed.title).toBe("Implement feature X");
      const next = data.next as Record<string, unknown>;
      expect(next).not.toBeNull();
      expect(next.id).toBe("t2");
      expect(next.title).toBe("Write tests");
    });
  });

  it("returns null next when last open task is completed", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "single-proj", {
        tasks: [
          {
            id: "t1",
            normalizedId: "t1",
            title: "Only task",
            status: "backlog",
            priority: "medium",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
        ],
        plans: [],
      });
      const result = await runCommand("done", ["single-proj", "t1", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      expect((data.completed as Record<string, unknown>).id).toBe("t1");
      expect(data.next).toBeNull();
    });
  });

  it("returns human-readable output with next task", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "human-proj");
      const result = await runCommand("done", ["human-proj", "t1"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const output = result.data as string;
      expect(output).toContain("✓ Done: Implement feature X");
      expect(output).toContain("Next: Write tests");
      expect(output).toContain("Run: arcs done human-proj t2");
    });
  });

  it("returns all-done message when no tasks remain", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "final-proj", {
        tasks: [
          {
            id: "last",
            normalizedId: "last",
            title: "Last task",
            status: "backlog",
            priority: "medium",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
        ],
        plans: [],
      });
      const result = await runCommand("done", ["final-proj", "last"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const output = result.data as string;
      expect(output).toContain("✓ Done: Last task");
      expect(output).toContain("All tasks complete");
    });
  });

  it("returns error for unknown task ID", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "err-proj");
      const result = await runCommand("done", ["err-proj", "nonexistent-task", "--json"]);
      expect(result.ok).toBe(false);
    });
  });

  it("returns error for unknown project slug", async () => {
    await withTempDataDir(async () => {
      const result = await runCommand("done", ["no-such-proj", "t1", "--json"]);
      expect(result.ok).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Completion receipt coverage

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
  git(dir, ["config", "user.name", "Done Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function commitFile(dir: string, name: string, content: string): string {
  writeFileSync(resolve(dir, name), content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `add ${name}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/**
 * A real linked git worktree of `mainRepo`, created under the test data dir so
 * `withTempDataDir` cleans it up. `git worktree add` creates the path itself.
 */
function addWorktree(mainRepo: string, baseDir: string, name: string, branch: string): string {
  const path = resolve(baseDir, `wt-${name}`);
  git(mainRepo, ["worktree", "add", "-q", path, "-b", branch]);
  return path;
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

/** Seed a project whose single workspace path is `workspacePath`. */
function seedProjectAt(dir: string, slug: string, workspacePath: string, tasks: unknown[]): void {
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
  writeFileSync(resolve(plansDir, "index.json"), JSON.stringify({ plans: [] }), "utf-8");

  const knowledgeDir = resolve(projDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(resolve(knowledgeDir, "index.json"), JSON.stringify({ entries: [] }), "utf-8");
}

/** Repo with one base commit, seeded project, and a t1 in_progress with startHead set. */
async function withReceiptProject(
  dir: string,
  slug: string,
  run: (ctx: { repo: string; base: string }) => Promise<void>,
  opts: { remote?: string } = {},
): Promise<void> {
  const repo = mkdtempSync(resolve(dir, "repo-"));
  initRepo(repo);
  const base = commitFile(repo, "a.txt", "one\n");
  seedProjectAt(dir, slug, repo, [makeTask("t1")]);

  const transition = await runCommand("task transition", [slug, "t1", "in_progress", "--json"]);
  expect(transition.ok).toBe(true);

  if (opts.remote) {
    git(repo, ["remote", "add", "origin", opts.remote]);
  }

  await run({ repo, base });
}

describe("arcs done — completion receipts", () => {
  it("captures and persists a receipt on the in_progress → done path", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "rcpt-proj";
      await withReceiptProject(
        dir,
        slug,
        async ({ repo, base }) => {
          const head = commitFile(repo, "b.txt", "two\n");
          const result = await runCommand("done", [slug, "t1", "--json"]);
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const data = result.data as Record<string, unknown>;
          const report = data.report as Record<string, unknown>;
          expect(report).toBeDefined();
          expect(report.commit).toBe(head);
          expect(report.baseRef).toBe(base);
          expect(report.filesChanged).toBeGreaterThanOrEqual(1);
          expect(report.insertions).toBeGreaterThanOrEqual(1);
          expect(report.deletions).toBe(0);
          expect(report.truncated).toBe(false);

          // TaskMeta.report persisted
          const task = await getTask(resolve(dir, "projects", slug), "t1");
          expect(task.status).toBe("done");
          expect(task.report?.commit).toBe(head);

          // Sidecar files on disk
          expect(existsSync(resolve(dir, "projects", slug, "reports", "t1.json"))).toBe(true);
          expect(existsSync(resolve(dir, "projects", slug, "reports", "t1.diff"))).toBe(true);
        },
        { remote: "git@github.com:owner/repo.git" },
      );
    });
  });

  it("includes the /commit/<sha> link when a GitHub remote is set", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "remote-proj";
      await withReceiptProject(
        dir,
        slug,
        async ({ repo }) => {
          const head = commitFile(repo, "b.txt", "two\n");
          const result = await runCommand("done", [slug, "t1", "--json"]);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const report = (result.data as Record<string, unknown>).report as Record<string, unknown>;
          expect(report.url).toBe(`https://github.com/owner/repo/commit/${head}`);
        },
        { remote: "git@github.com:owner/repo.git" },
      );
    });
  });

  it("omits the url when there is no remote and still succeeds", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "local-proj";
      await withReceiptProject(dir, slug, async ({ repo }) => {
        const head = commitFile(repo, "b.txt", "two\n");
        const result = await runCommand("done", [slug, "t1", "--json"]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const report = (result.data as Record<string, unknown>).report as Record<string, unknown>;
        expect(report.commit).toBe(head);
        expect(report.url).toBeUndefined();
      });
    });
  });

  it("renders the commit link and diffstat in human output", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "human-rcpt";
      await withReceiptProject(
        dir,
        slug,
        async ({ repo }) => {
          const head = commitFile(repo, "b.txt", "two\n");
          const result = await runCommand("done", [slug, "t1"]);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const output = result.data as string;
          expect(output).toContain("✓ Done: Task t1");
          expect(output).toContain("Report:");
          expect(output).toContain(head.slice(0, 7));
          expect(output).toContain(`https://github.com/owner/repo/commit/${head}`);
          expect(output).toContain("Diffstat:");
          expect(output).toContain("1 file changed");
          expect(output).toContain("+1/-0");
        },
        { remote: "git@github.com:owner/repo.git" },
      );
    });
  });

  it("md-renderer renders the same receipt info as the JSON path", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "md-rcpt";
      await withReceiptProject(
        dir,
        slug,
        async ({ repo }) => {
          const head = commitFile(repo, "b.txt", "two\n");
          const result = await runCommand("done", [slug, "t1", "--json"]);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const md = renderMarkdown("done", result.data);
          expect(md).not.toBeNull();
          expect(md).toContain(`https://github.com/owner/repo/commit/${head}`);
          expect(md).toContain("Diffstat:");
        },
        { remote: "git@github.com:owner/repo.git" },
      );
    });
  });

  it("--no-report skips capture and writes no receipt", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "noreport-proj";
      await withReceiptProject(dir, slug, async ({ repo }) => {
        commitFile(repo, "b.txt", "two\n");
        const result = await runCommand("done", [slug, "t1", "--no-report", "--json"]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const data = result.data as Record<string, unknown>;
        expect(data.report).toBeUndefined();
        expect(data.reportSkipped).toBeUndefined();
        expect(existsSync(resolve(dir, "projects", slug, "reports"))).toBe(false);

        const task = await getTask(resolve(dir, "projects", slug), "t1");
        expect(task.status).toBe("done");
        expect(task.report).toBeUndefined();
      });
    });
  });

  it("succeeds with no receipt when the workspace is not a git repo", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "nogit-proj";
      const plain = mkdtempSync(resolve(dir, "plain-"));
      seedProjectAt(dir, slug, plain, [makeTask("t1")]);

      const result = await runCommand("done", [slug, "t1", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      expect(data.report).toBeUndefined();
      expect(existsSync(resolve(dir, "projects", slug, "reports"))).toBe(false);

      const task = await getTask(resolve(dir, "projects", slug), "t1");
      expect(task.status).toBe("done");
    });
  });

  it("still completes the task and reports why when capture fails", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "fail-proj";
      await withReceiptProject(dir, slug, async ({ repo }) => {
        commitFile(repo, "b.txt", "two\n");
        const result = await runCommand("done", [
          slug,
          "t1",
          "--since=no-such-ref-exists",
          "--json",
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const data = result.data as Record<string, unknown>;
        expect(data.report).toBeUndefined();
        expect(typeof data.reportSkipped).toBe("string");
        expect(String(data.reportSkipped)).toContain("no-such-ref-exists");

        const task = await getTask(resolve(dir, "projects", slug), "t1");
        expect(task.status).toBe("done");
      });
    });
  });

  it("--commit overrides the receipt head", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "commit-proj";
      await withReceiptProject(dir, slug, async ({ repo, base }) => {
        commitFile(repo, "b.txt", "two\n");
        const result = await runCommand("done", [slug, "t1", `--commit=${base}`, "--json"]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const report = (result.data as Record<string, unknown>).report as Record<string, unknown>;
        expect(report.commit).toBe(base);
        expect(report.filesChanged).toBe(0);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// `arcs done --learn` — code chunks derived from the receipt's own diff
// ---------------------------------------------------------------------------

/** Repo whose base commit contains `files`, a seeded project, and an in_progress t1. */
async function withRepoFiles(
  dir: string,
  slug: string,
  files: Record<string, string>,
  run: (ctx: { repo: string; base: string }) => Promise<void>,
): Promise<void> {
  const repo = mkdtempSync(resolve(dir, "repo-"));
  initRepo(repo);
  for (const [name, content] of Object.entries(files)) {
    const target = resolve(repo, name);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  seedProjectAt(dir, slug, repo, [makeTask("t1")]);

  const transition = await runCommand("task transition", [slug, "t1", "in_progress", "--json"]);
  expect(transition.ok).toBe(true);

  await run({ repo, base });
}

/** Read the persisted `codeChunks` array for a knowledge entry id. */
function readKnowledgeChunks(
  dir: string,
  slug: string,
  id: string,
): Array<Record<string, unknown>> {
  const metaPath = resolve(dir, "projects", slug, "knowledge", `${id}.meta.json`);
  const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
  return (meta.codeChunks as Array<Record<string, unknown>>) ?? [];
}

describe("diff-derived code ranges (unit)", () => {
  it("drops a file deleted in the diff (`+++ /dev/null`) and keeps modified files", () => {
    const diff = [
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-keep",
      "diff --git a/kept.txt b/kept.txt",
      "--- a/kept.txt",
      "+++ b/kept.txt",
      "@@ -1,3 +1,2 @@",
      " a",
      "-b",
      " c",
    ].join("\n");

    const files = parseDiffFileRanges(diff);
    expect(files.map((f) => f.path)).toEqual(["kept.txt"]);
    expect(files[0]?.ranges).toEqual([{ startLine: 1, endLine: 2 }]);
  });

  it("merges overlapping and touching hunks into one range per file", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,5 @@",
      " a",
      "@@ -6,2 +6,3 @@",
      " b",
      "@@ -20 +21 @@",
      " c",
    ].join("\n");

    expect(parseDiffFileRanges(diff)).toEqual([
      {
        path: "x.ts",
        ranges: [
          { startLine: 1, endLine: 8 },
          { startLine: 21, endLine: 21 },
        ],
      },
    ]);
  });

  it("maps a pure-deletion (+c,0) hunk to a 1-line in-bounds window", () => {
    const diff = [
      "diff --git a/empty.txt b/empty.txt",
      "--- a/empty.txt",
      "+++ b/empty.txt",
      "@@ -1,4 +0,0 @@",
      "-a",
      "-b",
      "-c",
      "-d",
    ].join("\n");

    expect(parseDiffFileRanges(diff)).toEqual([
      { path: "empty.txt", ranges: [{ startLine: 1, endLine: 1 }] },
    ]);
  });
});

describe("arcs done --learn — chunks derived from the receipt diff", () => {
  it("stores capped, non-overlapping chunks whose snippets contain the changed lines", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "learn-chunks";
      const baseA = `${Array.from({ length: 60 }, (_, i) => `const a${i + 1} = ${i + 1};`).join("\n")}\n`;
      const baseB = `${Array.from({ length: 60 }, (_, i) => `const b${i + 1} = ${i + 1};`).join("\n")}\n`;

      await withRepoFiles(dir, slug, { "a.ts": baseA, "b.ts": baseB }, async ({ repo }) => {
        const a = baseA.split("\n");
        a[2] = "const DISTINCTIVE_ADDED_A = 1;";
        a[40] = "const DISTINCTIVE_ADDED_A2 = 2;";
        writeFileSync(resolve(repo, "a.ts"), a.join("\n"));
        const b = baseB.split("\n");
        b[10] = "const DISTINCTIVE_ADDED_B = 3;";
        writeFileSync(resolve(repo, "b.ts"), b.join("\n"));
        git(repo, ["add", "-A"]);
        git(repo, ["commit", "-q", "-m", "edit both"]);

        const result = await runCommand("done", [
          slug,
          "t1",
          "--learn",
          "always derive chunks from the receipt diff",
          "--json",
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const learned = (result.data as Record<string, unknown>).learned as Record<string, unknown>;
        expect(learned).toBeDefined();
        const chunks = readKnowledgeChunks(dir, slug, String(learned.id));

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.length).toBeLessThanOrEqual(10);

        const snippets = chunks.map((c) => String(c.snippet)).join("\n");
        expect(snippets).toContain("DISTINCTIVE_ADDED_A");
        expect(snippets).toContain("DISTINCTIVE_ADDED_A2");
        expect(snippets).toContain("DISTINCTIVE_ADDED_B");

        // Non-overlapping, ascending ranges per file.
        const byPath = new Map<string, Array<{ start: number; end: number }>>();
        for (const chunk of chunks) {
          const list = byPath.get(String(chunk.path)) ?? [];
          list.push({ start: Number(chunk.startLine), end: Number(chunk.endLine) });
          byPath.set(String(chunk.path), list);
        }
        for (const list of byPath.values()) {
          list.sort((x, y) => x.start - y.start);
          for (let i = 1; i < list.length; i++) {
            expect(list[i].start).toBeGreaterThan(list[i - 1].end);
          }
        }

        const meta = JSON.parse(
          readFileSync(
            resolve(dir, "projects", slug, "knowledge", `${learned.id}.meta.json`),
            "utf-8",
          ),
        ) as Record<string, unknown>;
        expect((meta.sourceFiles as unknown[]).length).toBe(chunks.length);
      });
    });
  });

  it("yields a valid in-bounds range for a pure-deletion hunk", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "learn-deletion";
      await withRepoFiles(
        dir,
        slug,
        { "gone.txt": "first\nsecond\nthird\nfourth\n" },
        async ({ repo }) => {
          writeFileSync(resolve(repo, "gone.txt"), "");
          git(repo, ["add", "-A"]);
          git(repo, ["commit", "-q", "-m", "empty the file"]);

          const result = await runCommand("done", [
            slug,
            "t1",
            "--learn",
            "watch out for pure deletion hunks",
            "--json",
          ]);
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const learned = (result.data as Record<string, unknown>).learned as Record<
            string,
            unknown
          >;
          const chunks = readKnowledgeChunks(dir, slug, String(learned.id));
          expect(chunks).toHaveLength(1);
          expect(chunks[0].path).toBe("gone.txt");
          expect(chunks[0].startLine).toBe(1);
          expect(chunks[0].endLine).toBe(1);
          expect(typeof chunks[0].snippet).toBe("string");
        },
      );
    });
  });

  it("caps chunks and selects deterministically when a commit touches more files than the cap", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "learn-cap";
      const files: Record<string, string> = {};
      for (let i = 1; i <= 12; i++) {
        files[`f${String(i).padStart(2, "0")}.ts`] = `${Array.from(
          { length: 30 },
          (_, j) => `export const v${j + 1} = ${j + 1};`,
        ).join("\n")}\n`;
      }

      await withRepoFiles(dir, slug, files, async ({ repo }) => {
        for (let i = 1; i <= 12; i++) {
          const name = `f${String(i).padStart(2, "0")}.ts`;
          const lines = files[name].split("\n");
          // Change `i` consecutive lines so each file has a distinct hunk size.
          for (let k = 0; k < i; k++) {
            lines[k] = `export const CHANGED_${i}_${k} = ${i * 100 + k};`;
          }
          writeFileSync(resolve(repo, name), lines.join("\n"));
        }
        git(repo, ["add", "-A"]);
        git(repo, ["commit", "-q", "-m", "touch twelve files"]);

        const result = await runCommand("done", [
          slug,
          "t1",
          "--learn",
          "always cap derived chunks",
          "--json",
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const report = (result.data as Record<string, unknown>).report as Record<string, unknown>;
        expect(report.filesChanged).toBe(12);

        const learned = (result.data as Record<string, unknown>).learned as Record<string, unknown>;
        const chunks = readKnowledgeChunks(dir, slug, String(learned.id));
        expect(chunks).toHaveLength(10);

        // The same diff selects the same ranges, and the stored chunks match
        // the documented largest-first selection.
        const diff = readFileSync(resolve(dir, "projects", slug, "reports", "t1.diff"), "utf-8");
        const expected = deriveDiffCodeRanges(diff);
        expect(expected).toHaveLength(10);
        expect(deriveDiffCodeRanges(diff)).toEqual(expected);
        expect(
          chunks.map((c) => ({
            path: c.path,
            startLine: c.startLine,
            endLine: c.endLine,
          })),
        ).toEqual(expected);
      });
    });
  });

  it("--no-report --learn stores an entry with no chunks and no error", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "learn-noreport";
      await withRepoFiles(dir, slug, { "x.ts": "export const x = 1;\n" }, async ({ repo }) => {
        writeFileSync(resolve(repo, "x.ts"), "export const x = 2;\n");
        git(repo, ["add", "-A"]);
        git(repo, ["commit", "-q", "-m", "edit"]);

        const result = await runCommand("done", [
          slug,
          "t1",
          "--no-report",
          "--learn",
          "lesson learned about no report",
          "--json",
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const data = result.data as Record<string, unknown>;
        expect(data.report).toBeUndefined();
        const learned = data.learned as Record<string, unknown>;
        expect(learned).toBeDefined();
        expect(readKnowledgeChunks(dir, slug, String(learned.id))).toEqual([]);
        expect(existsSync(resolve(dir, "projects", slug, "reports"))).toBe(false);
      });
    });
  });

  it("skips a diff file that no longer exists instead of failing", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "learn-missing";
      await withRepoFiles(
        dir,
        slug,
        { "keep.ts": "export const keep = 1;\n" },
        async ({ repo }) => {
          writeFileSync(resolve(repo, "added.ts"), "export const fresh = 1;\n");
          writeFileSync(resolve(repo, "keep.ts"), "export const keep = 2;\n");
          git(repo, ["add", "-A"]);
          git(repo, ["commit", "-q", "-m", "add and edit"]);

          // Replace the committed file with a symlink to a missing target
          // WITHOUT committing: the snapshot diff still references added.ts
          // (base had no such path), but reading it fails at learn time.
          rmSync(resolve(repo, "added.ts"), { force: true });
          symlinkSync("missing-target", resolve(repo, "added.ts"));

          const result = await runCommand("done", [
            slug,
            "t1",
            "--learn",
            "lesson: skip a missing diff file",
            "--json",
          ]);
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const data = result.data as Record<string, unknown>;
          const learned = data.learned as Record<string, unknown>;
          const paths = readKnowledgeChunks(dir, slug, String(learned.id)).map((c) => c.path);
          expect(paths).toContain("keep.ts");
          expect(paths).not.toContain("added.ts");
          expect(String(data.learnedChunksSkipped)).toContain("skipped");
        },
      );
    });
  });
});

describe("arcs done --learn — chunk-derivation degradation", () => {
  it("still creates the entry when a derived chunk cannot be stored, reporting why", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "learn-badpath";
      // A comma in the path is legal for git but rejected by the knowledge
      // store's FileRef validator, so attaching the chunk must fail soft.
      await withRepoFiles(
        dir,
        slug,
        { "weird,name.ts": "export const v = 1;\n" },
        async ({ repo }) => {
          writeFileSync(resolve(repo, "weird,name.ts"), "export const v = 2;\n");
          git(repo, ["add", "-A"]);
          git(repo, ["commit", "-q", "-m", "edit comma path"]);

          const result = await runCommand("done", [
            slug,
            "t1",
            "--learn",
            "lesson: degrade when a chunk path is invalid",
            "--json",
          ]);
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const data = result.data as Record<string, unknown>;
          const learned = data.learned as Record<string, unknown>;
          expect(learned).toBeDefined();
          expect(readKnowledgeChunks(dir, slug, String(learned.id))).toEqual([]);
          expect(String(data.learnedChunksSkipped)).toContain("could not attach code chunks");
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Receipts resolve to the task's plan worktree, not the main checkout
// ---------------------------------------------------------------------------

/**
 * Temp project whose `workspacePaths[0]` is repo A and whose worktree registry
 * maps plan `p1` to a REAL linked worktree B of A (`git worktree add`), seeded
 * through the worktree-store write path. Returns the fixture paths; the caller
 * drives the transition and the diverging commits.
 */
async function seedWorktreeProject(
  dir: string,
  slug: string,
  task: Record<string, unknown>,
): Promise<{ a: string; b: string; base: string }> {
  const a = mkdtempSync(resolve(dir, "repo-a-"));
  initRepo(a);
  const base = commitFile(a, "a.txt", "one\n");
  const b = addWorktree(a, dir, slug, "arcs/p1");
  seedProjectAt(dir, slug, a, [task]);
  const projDir = resolve(dir, "projects", slug);
  await upsertWorktreeEntry(projDir, { planId: "p1", path: b, branch: "arcs/p1" });
  return { a, b, base };
}

describe("arcs done — receipts resolve to the plan worktree", () => {
  it("captures the task receipt from the worktree (repoRoot and diff are B's)", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "wt-rcpt";
      const { a, b, base } = await seedWorktreeProject(dir, slug, makeTask("t1", { planId: "p1" }));

      const transition = await runCommand("task transition", [slug, "t1", "in_progress", "--json"]);
      expect(transition.ok).toBe(true);

      // A and B diverge: each gets its own commit, so a receipt taken against
      // the wrong tree would carry the other file (and the other HEAD).
      commitFile(a, "a-only.txt", "a\n");
      const bHead = commitFile(b, "b-only.txt", "b\n");

      const result = await runCommand("done", [slug, "t1", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const stored = readReceipt(dir, slug, "t1");
      expect(stored).not.toBeNull();
      expect(stored?.repoRoot).toBe(b);
      expect(stored?.headSha).toBe(bHead);
      expect(stored?.baseRef).toBe(base);
      expect(stored?.diff).toContain("b-only.txt");
      expect(stored?.diff).not.toContain("a-only.txt");
    });
  });

  it("captures the receipt from workspacePaths[0] when the task has no planId", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "wt-noplan";
      // Registry still maps p1→B; the task deliberately carries no planId.
      const { a, b, base } = await seedWorktreeProject(dir, slug, makeTask("t1"));

      const transition = await runCommand("task transition", [slug, "t1", "in_progress", "--json"]);
      expect(transition.ok).toBe(true);

      const aHead = commitFile(a, "a-only.txt", "a\n");
      commitFile(b, "b-only.txt", "b\n");

      const result = await runCommand("done", [slug, "t1", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const stored = readReceipt(dir, slug, "t1");
      expect(stored).not.toBeNull();
      expect(stored?.repoRoot).toBe(a);
      expect(stored?.headSha).toBe(aHead);
      expect(stored?.baseRef).toBe(base);
      expect(stored?.diff).toContain("a-only.txt");
      expect(stored?.diff).not.toContain("b-only.txt");
    });
  });

  it("falls back to the workspace and still succeeds when the worktree path was deleted", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "wt-stale";
      const { a, b } = await seedWorktreeProject(dir, slug, makeTask("t1", { planId: "p1" }));
      rmSync(b, { recursive: true, force: true });

      const transition = await runCommand("task transition", [slug, "t1", "in_progress", "--json"]);
      expect(transition.ok).toBe(true);

      const aHead = commitFile(a, "a-only.txt", "a\n");
      const result = await runCommand("done", [slug, "t1", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const stored = readReceipt(dir, slug, "t1");
      expect(stored?.repoRoot ?? a).toBe(a);
      expect(stored?.headSha).toBe(aHead);
    });
  });

  it("falls back to the workspace when the registered worktree is not a git repo", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "wt-nongit";
      const a = mkdtempSync(resolve(dir, "repo-a-"));
      initRepo(a);
      const base = commitFile(a, "a.txt", "one\n");
      const plain = mkdtempSync(resolve(dir, "plain-wt-"));
      seedProjectAt(dir, slug, a, [makeTask("t1", { planId: "p1" })]);
      await upsertWorktreeEntry(resolve(dir, "projects", slug), {
        planId: "p1",
        path: plain,
        branch: "arcs/p1",
      });

      const transition = await runCommand("task transition", [slug, "t1", "in_progress", "--json"]);
      expect(transition.ok).toBe(true);
      const aHead = commitFile(a, "a-only.txt", "a\n");

      const result = await runCommand("done", [slug, "t1", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const stored = readReceipt(dir, slug, "t1");
      expect(stored?.repoRoot).toBe(a);
      expect(stored?.headSha).toBe(aHead);
      expect(stored?.baseRef).toBe(base);
    });
  });

  it("uses the workspace when the task has a planId but no worktree is registered", async () => {
    await withTempDataDir(async (dir) => {
      const slug = "wt-noreg";
      const a = mkdtempSync(resolve(dir, "repo-a-"));
      initRepo(a);
      const base = commitFile(a, "a.txt", "one\n");
      seedProjectAt(dir, slug, a, [makeTask("t1", { planId: "p1" })]);

      const transition = await runCommand("task transition", [slug, "t1", "in_progress", "--json"]);
      expect(transition.ok).toBe(true);
      const aHead = commitFile(a, "a-only.txt", "a\n");

      const result = await runCommand("done", [slug, "t1", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const stored = readReceipt(dir, slug, "t1");
      expect(stored?.repoRoot).toBe(a);
      expect(stored?.headSha).toBe(aHead);
      expect(stored?.baseRef).toBe(base);
    });
  });
});
