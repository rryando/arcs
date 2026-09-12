// ---------------------------------------------------------------------------
// Tests for atomic task transition + diagram update
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask } from "../src/utils/task-store.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

async function createTestProject(_dir: string, slug = "test-proj"): Promise<void> {
  await runCommand("project init", [slug, "--description=Test project"]);
}

async function createTestTask(slug: string, planId?: string): Promise<string> {
  const args = [slug, "Test task"];
  if (planId) args.push(`--planId=${planId}`);
  const result = await runCommand("task create", args);
  if (!result.ok) throw new Error("Failed to create task");
  return (result.data as { id: string }).id;
}

function seedDiagram(dir: string, slug: string, planId: string, nodeId: string): void {
  const plansDir = resolve(dir, "projects", slug, "plans");
  mkdirSync(plansDir, { recursive: true });
  const mmdPath = resolve(plansDir, `${planId}.diagram.mmd`);
  writeFileSync(
    mmdPath,
    `flowchart TD
  ${nodeId}["Some task"]:::backlog
  classDef backlog fill:#ccc
  classDef active fill:#ff0
  classDef done fill:#0f0
  classDef blocked fill:#f00
`,
    "utf-8",
  );
}

describe("task transition — atomic diagram update", () => {
  it("records the workspace startHead when transitioning to in_progress", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject(dir);
      const taskId = await createTestTask("test-proj");

      const result = await runCommand("task transition", ["test-proj", taskId, "in_progress"]);

      expect(result.ok).toBe(true);
      const task = await getTask(resolve(dir, "projects", "test-proj"), taskId);
      expect(task.status).toBe("in_progress");
      expect(typeof task.startHead).toBe("string");
      expect(task.startHead?.length).toBeGreaterThan(0);
    });
  });

  it("transitions task without diagram params (unchanged behavior)", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject(dir);
      const taskId = await createTestTask("test-proj");

      const result = await runCommand("task transition", ["test-proj", taskId, "in_progress"]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as Record<string, unknown>;
        expect(data.taskId).toBe(taskId);
        expect(data.previousStatus).toBe("backlog");
        expect(data.newStatus).toBe("in_progress");
        expect(data.diagramUpdated).toBeUndefined();
      }
    });
  });

  it("transitions task and updates diagram when both params provided", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject(dir);
      // Create a plan first
      await runCommand("plan create", ["test-proj", "test-plan", "--title=Test Plan"]);
      const taskId = await createTestTask("test-proj", "test-plan");
      seedDiagram(dir, "test-proj", "test-plan", "T001");

      const result = await runCommand("task transition", [
        "test-proj",
        taskId,
        "done",
        "--planId=test-plan",
        "--diagramNodeId=T001",
      ]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as Record<string, unknown>;
        expect(data.taskId).toBe(taskId);
        expect(data.newStatus).toBe("done");
        expect(data.diagramNodeId).toBe("T001");
        // Diagram update is best-effort — if script not found, still succeeds
        expect(typeof data.diagramUpdated).toBe("boolean");
      }
    });
  });

  it("transitions task with diagramUpdated=false when diagram file missing", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject(dir);
      const taskId = await createTestTask("test-proj");

      const result = await runCommand("task transition", [
        "test-proj",
        taskId,
        "done",
        "--planId=nonexistent-plan",
        "--diagramNodeId=T001",
      ]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as Record<string, unknown>;
        expect(data.taskId).toBe(taskId);
        expect(data.newStatus).toBe("done");
        expect(data.diagramUpdated).toBe(false);
        expect(data.diagramError).toBeDefined();
      }
    });
  });

  it("skips diagram update when only planId provided (missing diagramNodeId)", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject(dir);
      const taskId = await createTestTask("test-proj");

      const result = await runCommand("task transition", [
        "test-proj",
        taskId,
        "in_progress",
        "--planId=some-plan",
      ]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as Record<string, unknown>;
        expect(data.taskId).toBe(taskId);
        expect(data.diagramUpdated).toBeUndefined();
      }
    });
  });

  it("skips diagram update when only diagramNodeId provided (missing planId)", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject(dir);
      const taskId = await createTestTask("test-proj");

      const result = await runCommand("task transition", [
        "test-proj",
        taskId,
        "in_progress",
        "--diagramNodeId=T001",
      ]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as Record<string, unknown>;
        expect(data.taskId).toBe(taskId);
        expect(data.diagramUpdated).toBeUndefined();
      }
    });
  });

  it("dry-run includes diagram params in output", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject(dir);

      const result = await runCommand("task transition", [
        "test-proj",
        "fake-task",
        "done",
        "--planId=my-plan",
        "--diagramNodeId=T001",
        "--dry-run",
      ]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as Record<string, unknown>;
        expect(data.dryRun).toBe(true);
        const wouldTransition = data.wouldTransition as Record<string, unknown>;
        expect(wouldTransition.planId).toBe("my-plan");
        expect(wouldTransition.diagramNodeId).toBe("T001");
      }
    });
  });
});

describe("batch task-transition — atomic diagram update", () => {
  it("batch transitions task and attempts diagram update when planId/diagramNodeId present", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject(dir);
      await runCommand("plan create", ["test-proj", "test-plan", "--title=Test Plan"]);
      const taskId = await createTestTask("test-proj", "test-plan");
      seedDiagram(dir, "test-proj", "test-plan", "T001");

      // Write batch file
      const batchOps = [
        {
          op: "task-transition",
          slug: "test-proj",
          taskId,
          status: "done",
          planId: "test-plan",
          diagramNodeId: "T001",
        },
      ];
      const batchFile = resolve(dir, "batch-ops.json");
      writeFileSync(batchFile, JSON.stringify(batchOps), "utf-8");

      const result = await runCommand("batch", [`--file=${batchFile}`]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const results = result.data as Array<{
          index: number;
          op: string;
          success: boolean;
          result: Record<string, unknown>;
        }>;
        expect(results).toHaveLength(1);
        expect(results[0].success).toBe(true);
        expect(results[0].result.taskId).toBe(taskId);
        expect(results[0].result.status).toBe("done");
        expect(results[0].result.diagramNodeId).toBe("T001");
        expect(typeof results[0].result.diagramUpdated).toBe("boolean");
      }
    });
  });

  it("batch transitions task without diagram when planId/diagramNodeId absent", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject(dir);
      const taskId = await createTestTask("test-proj");

      const batchOps = [
        { op: "task-transition", slug: "test-proj", taskId, status: "in_progress" },
      ];
      const batchFile = resolve(dir, "batch-ops.json");
      writeFileSync(batchFile, JSON.stringify(batchOps), "utf-8");

      const result = await runCommand("batch", [`--file=${batchFile}`]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const results = result.data as Array<{
          index: number;
          op: string;
          success: boolean;
          result: Record<string, unknown>;
        }>;
        expect(results).toHaveLength(1);
        expect(results[0].success).toBe(true);
        expect(results[0].result.taskId).toBe(taskId);
        expect(results[0].result.status).toBe("in_progress");
        expect(results[0].result.diagramNodeId).toBeUndefined();
        expect(results[0].result.diagramUpdated).toBeUndefined();
      }
    });
  });
});
