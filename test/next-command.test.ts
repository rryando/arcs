// ---------------------------------------------------------------------------
// Tests for `arcs next` command
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
      title: "Done task",
      status: "done",
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
      summary: "This plan implements feature X for the system.",
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

describe("arcs next", () => {
  it("returns next task as JSON with context and command", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "test-proj");
      const result = await runCommand("next", ["test-proj", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      const task = data.task as Record<string, unknown>;
      expect(task.id).toBe("t1");
      expect(task.title).toBe("Implement feature X");
      expect(task.priority).toBe("high");
      expect(data.planTitle).toBe("Feature Plan");
      expect(data.context as string).toContain("feature X");
      expect(data.command as string).toContain("arcs done test-proj t1");
    });
  });

  it("returns human-readable output without --json", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "test-proj");
      const result = await runCommand("next", ["test-proj"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const output = result.data as string;
      expect(output).toContain("Next: Implement feature X");
      expect(output).toContain("Plan: Feature Plan");
      expect(output).toContain("Priority: high");
      expect(output).toContain("When done:");
    });
  });

  it("returns nothing-to-do message when all tasks are done", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "empty-proj", {
        tasks: [
          {
            id: "t1",
            normalizedId: "t1",
            title: "Done task",
            status: "done",
            priority: "medium",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
        ],
        plans: [],
      });
      const result = await runCommand("next", ["empty-proj", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      expect((data.message as string).toLowerCase()).toMatch(/nothing to do/i);
    });
  });

  it("prefers in_progress task over backlog", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "prio-proj", {
        tasks: [
          {
            id: "t-backlog",
            normalizedId: "t-backlog",
            title: "Backlog task",
            status: "backlog",
            priority: "high",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
          {
            id: "t-inprog",
            normalizedId: "t-inprog",
            title: "In progress task",
            status: "in_progress",
            priority: "low",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
        ],
        plans: [],
      });
      const result = await runCommand("next", ["prio-proj", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      const task = data.task as Record<string, unknown>;
      expect(task.id).toBe("t-inprog");
    });
  });

  it("returns error for unknown project slug", async () => {
    await withTempDataDir(async (_dir) => {
      // dir already has empty meta.json from withTempDataDir
      const result = await runCommand("next", ["unknown-proj", "--json"]);
      expect(result.ok).toBe(false);
    });
  });

  it("skips blocked task and returns the ready one", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "dep-proj", {
        tasks: [
          {
            id: "t-blocked",
            normalizedId: "t-blocked",
            title: "Blocked task",
            status: "backlog",
            priority: "high",
            dependsOn: ["t-prereq"],
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
          {
            id: "t-prereq",
            normalizedId: "t-prereq",
            title: "Prereq task",
            status: "backlog",
            priority: "low",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
        ],
        plans: [],
      });
      const result = await runCommand("next", ["dep-proj", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      const task = data.task as Record<string, unknown>;
      // t-prereq is ready (no deps); t-blocked is blocked
      expect(task.id).toBe("t-prereq");
    });
  });

  it("returns task when dep is done", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "done-dep-proj", {
        tasks: [
          {
            id: "t-main",
            normalizedId: "t-main",
            title: "Main task",
            status: "backlog",
            priority: "high",
            dependsOn: ["t-done"],
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
          {
            id: "t-done",
            normalizedId: "t-done",
            title: "Done dep",
            status: "done",
            priority: "medium",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
        ],
        plans: [],
      });
      const result = await runCommand("next", ["done-dep-proj", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      const task = data.task as Record<string, unknown>;
      // t-main is ready because t-done is done
      expect(task.id).toBe("t-main");
    });
  });
});
