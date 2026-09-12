// ---------------------------------------------------------------------------
// Tests for the read-only `arcs report` commands
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/cli/md-renderer.js";
import { writeReceipt } from "../src/utils/report-store.js";
import type { Receipt } from "../src/utils/run-report.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const SLUG = "rp";

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    taskId: "t1",
    repoRoot: "/repo",
    baseRef: "base123",
    baseSha: "base123",
    headSha: "head456",
    branch: "main",
    remoteUrl: "git@github.com:owner/repo.git",
    url: "https://github.com/owner/repo/commit/head456",
    filesChanged: 2,
    insertions: 5,
    deletions: 1,
    diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n",
    diffTruncated: false,
    capturedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const REPORT_REF = {
  commit: "head456",
  branch: "main",
  baseRef: "base123",
  url: "https://github.com/owner/repo/commit/head456",
  filesChanged: 2,
  insertions: 5,
  deletions: 1,
  reportFile: `projects/${SLUG}/reports/t1.json`,
  diffFile: `projects/${SLUG}/reports/t1.diff`,
  truncated: false,
  capturedAt: "2026-01-01T00:00:00Z",
};

function seedProject(dir: string, tasks: unknown[] = []): void {
  writeFileSync(
    resolve(dir, "meta.json"),
    JSON.stringify({
      version: "1.0",
      projects: [{ id: SLUG, name: "Report Project", status: "active", dependsOn: [] }],
    }),
    "utf-8",
  );

  const projDir = resolve(dir, "projects", SLUG);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    resolve(projDir, "meta.json"),
    JSON.stringify({
      id: SLUG,
      name: "Report Project",
      description: "A test project",
      createdAt: "2026-01-01T00:00:00Z",
      workspacePaths: [dir],
    }),
    "utf-8",
  );

  const tasksDir = resolve(projDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(resolve(tasksDir, "index.json"), JSON.stringify({ tasks }), "utf-8");

  const plansDir = resolve(projDir, "plans");
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(resolve(plansDir, "index.json"), JSON.stringify({ plans: [] }), "utf-8");
}

function taskWithReport(id = "t1"): Record<string, unknown> {
  return {
    id,
    normalizedId: id,
    title: `Task ${id}`,
    status: "done",
    priority: "medium",
    report: REPORT_REF,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("arcs report get", () => {
  it("round-trips a persisted receipt with its meta pointer", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, [taskWithReport()]);
      writeReceipt(dir, SLUG, makeReceipt(), { taskId: "t1" });

      const result = await runCommand("report get", [SLUG, "t1", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      const receipt = data.receipt as Record<string, unknown>;
      expect(receipt.headSha).toBe("head456");
      expect(receipt.baseSha).toBe("base123");
      expect(receipt.filesChanged).toBe(2);
      expect(receipt.insertions).toBe(5);
      expect(receipt.deletions).toBe(1);
      expect(receipt.url).toBe("https://github.com/owner/repo/commit/head456");
      expect((data.meta as Record<string, unknown>).commit).toBe("head456");
      // The diff body is not inlined by default.
      expect(data.diff).toBeUndefined();
    });
  });

  it("includes the capped diff only with --diff", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, [taskWithReport()]);
      const receipt = makeReceipt();
      writeReceipt(dir, SLUG, receipt, { taskId: "t1" });

      const result = await runCommand("report get", [SLUG, "t1", "--diff", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.data as Record<string, unknown>).diff).toBe(receipt.diff);
    });
  });

  it("carries dirty and untracked through the JSON envelope", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, [taskWithReport()]);
      writeReceipt(dir, SLUG, makeReceipt({ dirty: true, untracked: ["new.txt", "extra.txt"] }), {
        taskId: "t1",
      });

      const result = await runCommand("report get", [SLUG, "t1", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const receipt = (result.data as Record<string, unknown>).receipt as Record<string, unknown>;
      expect(receipt.dirty).toBe(true);
      expect(receipt.untracked).toEqual(["new.txt", "extra.txt"]);
    });
  });

  it("marks a dirty receipt in markdown but leaves a clean one unchanged", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, [taskWithReport()]);
      writeReceipt(dir, SLUG, makeReceipt({ dirty: true, untracked: ["new.txt"] }), {
        taskId: "t1",
      });
      writeReceipt(dir, SLUG, makeReceipt({ taskId: "clean", dirty: false, untracked: [] }), {
        taskId: "clean",
      });

      const dirtyResult = await runCommand("report get", [SLUG, "t1", "--json"]);
      expect(dirtyResult.ok).toBe(true);
      if (!dirtyResult.ok) return;
      const dirtyMd = renderMarkdown("report get", dirtyResult.data);
      expect(dirtyMd).toContain("(uncommitted working tree)");

      const cleanResult = await runCommand("report get", [SLUG, "clean", "--json"]);
      expect(cleanResult.ok).toBe(true);
      if (!cleanResult.ok) return;
      const cleanMd = renderMarkdown("report get", cleanResult.data);
      expect(cleanMd).not.toContain("uncommitted working tree");
      expect(cleanMd).toContain("## Receipt: clean");
    });
  });

  it("reads and renders a legacy receipt without dirty/untracked", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, [taskWithReport()]);
      // Legacy-shaped receipt: no dirty/untracked keys at all.
      writeReceipt(dir, SLUG, makeReceipt(), { taskId: "t1" });

      const result = await runCommand("report get", [SLUG, "t1", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const receipt = (result.data as Record<string, unknown>).receipt as Record<string, unknown>;
      expect(receipt.dirty).toBeUndefined();
      expect(receipt.untracked).toBeUndefined();

      const md = renderMarkdown("report get", result.data);
      expect(md).toContain("## Receipt: t1");
      expect(md).toContain("Diffstat:");
      expect(md).not.toContain("uncommitted working tree");
    });
  });

  it("returns a structured not-found failure for an unknown id", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, []);
      const result = await runCommand("report get", [SLUG, "missing", "--json"]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("entity_not_found");
      expect(result.message).toContain("missing");
    });
  });

  it("renders markdown instead of dumping JSON", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, [taskWithReport()]);
      writeReceipt(dir, SLUG, makeReceipt(), { taskId: "t1" });

      const result = await runCommand("report get", [SLUG, "t1", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const md = renderMarkdown("report get", result.data);
      expect(md).toContain("## Receipt: t1");
      expect(md).toContain("head456");
      expect(md).toContain("Diffstat:");
    });
  });
});

describe("arcs report list", () => {
  it("lists persisted receipts for a project", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, []);
      writeReceipt(dir, SLUG, makeReceipt(), { taskId: "t1" });
      writeReceipt(dir, SLUG, makeReceipt({ taskId: "t2", headSha: "head789" }), {
        taskId: "t2",
      });

      const result = await runCommand("report list", [SLUG, "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const receipts = result.data as Array<Record<string, unknown>>;
      expect(receipts).toHaveLength(2);
      expect(receipts.map((r) => r.id).sort()).toEqual(["t1", "t2"]);
    });
  });

  it("returns an empty list for a project with no receipts", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, []);
      const result = await runCommand("report list", [SLUG, "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toEqual([]);
    });
  });
});
