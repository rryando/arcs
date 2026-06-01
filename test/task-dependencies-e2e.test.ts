/**
 * End-to-end integration tests for task dependency features.
 *
 * Covers:
 * - Task store: create/update with dependsOn, cycle detection, missing ref detection
 * - next command: respects dependency order
 * - Diagram generator: emits --> arrows and %% blocked-by: metadata
 * - Graph builder: emits task_blocks_task edges
 * - Backward compatibility: tasks without dependsOn still work
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAdjacencyIndex } from "../src/retrieval/graph-builder.js";
import { generateDiagramFromTasks } from "../src/utils/diagram-generator.js";
import { createTask, listTasks, updateTask } from "../src/utils/task-store.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempProjectDir(): { projectDir: string; cleanup: () => void } {
  const base = mkdtempSync(resolve(tmpdir(), "arcs-dep-e2e-"));
  // Write a meta.json for project name resolution used by renderTasksMd
  writeFileSync(resolve(base, "meta.json"), JSON.stringify({ id: "dep-test", name: "Dep Test" }));
  return {
    projectDir: base,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Seed a project into dir with tasks that have dependsOn relationships */
function seedProjectWithDeps(
  dir: string,
  slug: string,
  tasks: Array<{
    id: string;
    title: string;
    status?: string;
    priority?: string;
    dependsOn?: string[];
  }>,
): void {
  const rootMeta = {
    version: "1.0",
    projects: [{ id: slug, name: "Dep Test", status: "active", dependsOn: [] }],
  };
  writeFileSync(resolve(dir, "meta.json"), JSON.stringify(rootMeta), "utf-8");

  const projDir = resolve(dir, "projects", slug);
  mkdirSync(projDir, { recursive: true });

  writeFileSync(
    resolve(projDir, "meta.json"),
    JSON.stringify({
      id: slug,
      name: "Dep Test",
      description: "Dependency integration tests",
      createdAt: "2025-01-01T00:00:00Z",
      workspacePaths: [process.cwd()],
    }),
    "utf-8",
  );
  writeFileSync(resolve(projDir, "overview.md"), "# Overview\n\nDep test overview.\n", "utf-8");

  const tasksDir = resolve(projDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const normalizedTasks = tasks.map((t) => ({
    id: t.id,
    normalizedId: t.id,
    title: t.title,
    status: t.status ?? "backlog",
    priority: t.priority ?? "medium",
    ...(t.dependsOn && t.dependsOn.length > 0 ? { dependsOn: t.dependsOn } : {}),
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  }));
  writeFileSync(
    resolve(tasksDir, "index.json"),
    JSON.stringify({ tasks: normalizedTasks }),
    "utf-8",
  );

  const plansDir = resolve(projDir, "plans");
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(resolve(plansDir, "index.json"), JSON.stringify({ plans: [] }), "utf-8");

  const knowledgeDir = resolve(projDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(resolve(knowledgeDir, "index.json"), JSON.stringify({ entries: [] }), "utf-8");
}

// ---------------------------------------------------------------------------
// 1. Task Store Layer — Dependency Chain
// ---------------------------------------------------------------------------

describe("Task Store — dependency chain", () => {
  let projectDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempProjectDir();
    projectDir = tmp.projectDir;
    cleanup = tmp.cleanup;
  });

  afterEach(() => cleanup());

  it("creates tasks A→B→C and persists dependsOn", async () => {
    const a = await createTask(projectDir, { title: "Task Alpha", priority: "high" });
    const b = await createTask(projectDir, {
      title: "Task Beta",
      dependsOn: [a.id],
      priority: "medium",
    });
    const c = await createTask(projectDir, {
      title: "Task Gamma",
      dependsOn: [b.id],
      priority: "low",
    });

    expect(a.dependsOn).toBeUndefined();
    expect(b.dependsOn).toEqual([a.id]);
    expect(c.dependsOn).toEqual([b.id]);

    const tasks = await listTasks(projectDir);
    const bStored = tasks.find((t) => t.id === b.id);
    const cStored = tasks.find((t) => t.id === c.id);
    expect(bStored?.dependsOn).toEqual([a.id]);
    expect(cStored?.dependsOn).toEqual([b.id]);
  });
});

// ---------------------------------------------------------------------------
// 2. Task Store Layer — Cycle Rejection
// ---------------------------------------------------------------------------

describe("Task Store — cycle rejection", () => {
  let projectDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempProjectDir();
    projectDir = tmp.projectDir;
    cleanup = tmp.cleanup;
  });

  afterEach(() => cleanup());

  it("rejects an update that would create a cycle", async () => {
    const a = await createTask(projectDir, { title: "Cycle Alpha" });
    const b = await createTask(projectDir, { title: "Cycle Beta", dependsOn: [a.id] });

    // A → B already. Now try to make B → A (cycle).
    await expect(updateTask(projectDir, { id: a.id, dependsOn: [b.id] })).rejects.toThrow(/cycle/i);
  });

  it("rejects an update that creates a longer cycle A→B→C→A", async () => {
    const a = await createTask(projectDir, { title: "Long Cycle A" });
    const b = await createTask(projectDir, { title: "Long Cycle B", dependsOn: [a.id] });
    const c = await createTask(projectDir, { title: "Long Cycle C", dependsOn: [b.id] });

    await expect(updateTask(projectDir, { id: a.id, dependsOn: [c.id] })).rejects.toThrow(/cycle/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Task Store Layer — Missing Reference Rejection
// ---------------------------------------------------------------------------

describe("Task Store — missing reference rejection", () => {
  let projectDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempProjectDir();
    projectDir = tmp.projectDir;
    cleanup = tmp.cleanup;
  });

  afterEach(() => cleanup());

  it("rejects creating a task with a nonexistent dependsOn reference", async () => {
    await expect(
      createTask(projectDir, { title: "Orphan Task", dependsOn: ["nonexistent-id"] }),
    ).rejects.toThrow(/not found|does not exist/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Next Command — Respects Dependencies
// ---------------------------------------------------------------------------

describe("arcs next — respects dependency order", () => {
  it("returns only the unblocked task when deps exist", async () => {
    await withTempDataDir(async (dir) => {
      seedProjectWithDeps(dir, "deps-proj", [
        { id: "task-a", title: "Task A", status: "backlog", priority: "high" },
        {
          id: "task-b",
          title: "Task B",
          status: "backlog",
          priority: "high",
          dependsOn: ["task-a"],
        },
        {
          id: "task-c",
          title: "Task C",
          status: "backlog",
          priority: "high",
          dependsOn: ["task-b"],
        },
      ]);

      const result = await runCommand("next", ["deps-proj", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      const task = data.task as Record<string, unknown>;
      // Only task-a has no deps; B and C are blocked
      expect(task.id).toBe("task-a");
    });
  });

  it("unblocks task B after task A is done", async () => {
    await withTempDataDir(async (dir) => {
      seedProjectWithDeps(dir, "seq-proj", [
        { id: "task-a", title: "Task A", status: "done", priority: "high" },
        {
          id: "task-b",
          title: "Task B",
          status: "backlog",
          priority: "high",
          dependsOn: ["task-a"],
        },
        {
          id: "task-c",
          title: "Task C",
          status: "backlog",
          priority: "high",
          dependsOn: ["task-b"],
        },
      ]);

      const result = await runCommand("next", ["seq-proj", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      const task = data.task as Record<string, unknown>;
      expect(task.id).toBe("task-b");
    });
  });

  it("unblocks task C after tasks A and B are done", async () => {
    await withTempDataDir(async (dir) => {
      seedProjectWithDeps(dir, "seq2-proj", [
        { id: "task-a", title: "Task A", status: "done", priority: "high" },
        { id: "task-b", title: "Task B", status: "done", priority: "high", dependsOn: ["task-a"] },
        {
          id: "task-c",
          title: "Task C",
          status: "backlog",
          priority: "high",
          dependsOn: ["task-b"],
        },
      ]);

      const result = await runCommand("next", ["seq2-proj", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      const task = data.task as Record<string, unknown>;
      expect(task.id).toBe("task-c");
    });
  });

  it("returns nothing-to-do when all deps are undone and only blocked tasks remain", async () => {
    await withTempDataDir(async (dir) => {
      seedProjectWithDeps(dir, "blocked-proj", [
        { id: "gate", title: "Gate Task", status: "in_progress", priority: "high" },
        {
          id: "blocked",
          title: "Blocked Task",
          status: "backlog",
          priority: "high",
          dependsOn: ["gate"],
        },
      ]);

      // gate is in_progress so it should be next (it has no deps)
      const result = await runCommand("next", ["blocked-proj", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      const task = data.task as Record<string, unknown>;
      expect(task.id).toBe("gate");
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Diagram Generator — Arrows From Dependencies
// ---------------------------------------------------------------------------

describe("generateDiagramFromTasks — dependency arrows", () => {
  it("emits --> arrows for dependsOn relationships", () => {
    const tasks = [
      {
        id: "task-a",
        normalizedId: "task-a",
        title: "Task A",
        status: "backlog" as const,
        priority: "high" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
      {
        id: "task-b",
        normalizedId: "task-b",
        title: "Task B",
        status: "backlog" as const,
        priority: "medium" as const,
        dependsOn: ["task-a"],
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
    ];

    const { mmd, nodes } = generateDiagramFromTasks("test-plan", tasks);

    // Should have a --> arrow from the A node to the B node
    const nodeA = nodes.find((n) => n.taskId === "task-a");
    const nodeB = nodes.find((n) => n.taskId === "task-b");
    expect(nodeA).toBeDefined();
    expect(nodeB).toBeDefined();
    expect(mmd).toContain(`${nodeA!.nodeId} --> ${nodeB!.nodeId}`);
  });

  it("emits %% blocked-by: metadata for dependent tasks", () => {
    const tasks = [
      {
        id: "task-a",
        normalizedId: "task-a",
        title: "Task A",
        status: "backlog" as const,
        priority: "high" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
      {
        id: "task-b",
        normalizedId: "task-b",
        title: "Task B",
        status: "backlog" as const,
        priority: "medium" as const,
        dependsOn: ["task-a"],
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
    ];

    const { mmd, nodes } = generateDiagramFromTasks("test-plan", tasks);

    const nodeA = nodes.find((n) => n.taskId === "task-a");
    expect(mmd).toContain(`%% blocked-by: ${nodeA!.nodeId}`);
  });

  it("emits arrows for a three-task chain A→B→C", () => {
    const tasks = [
      {
        id: "task-a",
        normalizedId: "task-a",
        title: "Task A",
        status: "backlog" as const,
        priority: "high" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
      {
        id: "task-b",
        normalizedId: "task-b",
        title: "Task B",
        status: "backlog" as const,
        priority: "medium" as const,
        dependsOn: ["task-a"],
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
      {
        id: "task-c",
        normalizedId: "task-c",
        title: "Task C",
        status: "backlog" as const,
        priority: "low" as const,
        dependsOn: ["task-b"],
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
    ];

    const { mmd, nodes } = generateDiagramFromTasks("test-plan", tasks);

    const nodeA = nodes.find((n) => n.taskId === "task-a");
    const nodeB = nodes.find((n) => n.taskId === "task-b");
    const nodeC = nodes.find((n) => n.taskId === "task-c");

    expect(mmd).toContain(`${nodeA!.nodeId} --> ${nodeB!.nodeId}`);
    expect(mmd).toContain(`${nodeB!.nodeId} --> ${nodeC!.nodeId}`);
  });
});

// ---------------------------------------------------------------------------
// 6. Graph Builder — task_blocks_task Edges
// ---------------------------------------------------------------------------

describe("buildAdjacencyIndex — task_blocks_task edges", () => {
  it("emits task_blocks_task edges for tasks with dependsOn", async () => {
    await withTempDataDir(async (dir) => {
      seedProjectWithDeps(dir, "graph-proj", [
        { id: "task-a", title: "Task A" },
        { id: "task-b", title: "Task B", dependsOn: ["task-a"] },
      ]);

      const index = await buildAdjacencyIndex("graph-proj");

      // There should be a task_blocks_task edge between task-a and task-b
      const allEdges = Array.from(index.edges.values()).flat();
      const blockEdges = allEdges.filter((e) => e.relation === "task_blocks_task");

      expect(blockEdges.length).toBeGreaterThan(0);

      // Check that the edge links task-a and task-b
      const hasEdge = blockEdges.some(
        (e) =>
          (e.source === "task:task-a" && e.target === "task:task-b") ||
          (e.source === "task:task-b" && e.target === "task:task-a"),
      );
      expect(hasEdge).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Backward Compatibility — tasks without dependsOn
// ---------------------------------------------------------------------------

describe("Backward compatibility — tasks without dependsOn", () => {
  it("next command picks by priority when no dependsOn exists", async () => {
    await withTempDataDir(async (dir) => {
      seedProjectWithDeps(dir, "compat-proj", [
        { id: "task-low", title: "Low Priority Task", status: "backlog", priority: "low" },
        { id: "task-high", title: "High Priority Task", status: "backlog", priority: "high" },
        { id: "task-med", title: "Medium Priority Task", status: "backlog", priority: "medium" },
      ]);

      const result = await runCommand("next", ["compat-proj", "--json"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Record<string, unknown>;
      const task = data.task as Record<string, unknown>;
      expect(task.id).toBe("task-high");
    });
  });

  it("diagram has no --> arrows when no dependsOn exists", () => {
    const tasks = [
      {
        id: "task-a",
        normalizedId: "task-a",
        title: "Task A",
        status: "backlog" as const,
        priority: "high" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
      {
        id: "task-b",
        normalizedId: "task-b",
        title: "Task B",
        status: "backlog" as const,
        priority: "medium" as const,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
    ];

    const { mmd } = generateDiagramFromTasks("no-deps-plan", tasks);
    expect(mmd).not.toContain("-->");
    expect(mmd).not.toContain("%% blocked-by:");
  });

  it("graph has no task_blocks_task edges when no dependsOn exists", async () => {
    await withTempDataDir(async (dir) => {
      seedProjectWithDeps(dir, "no-edges-proj", [
        { id: "task-a", title: "Task A" },
        { id: "task-b", title: "Task B" },
      ]);

      const index = await buildAdjacencyIndex("no-edges-proj");
      const allEdges = Array.from(index.edges.values()).flat();
      const blockEdges = allEdges.filter((e) => e.relation === "task_blocks_task");
      expect(blockEdges).toHaveLength(0);
    });
  });

  it("createTask without dependsOn works as before", async () => {
    const { projectDir, cleanup } = makeTempProjectDir();
    try {
      const task = await createTask(projectDir, { title: "Plain Task", priority: "high" });
      expect(task.dependsOn).toBeUndefined();
      expect(task.id).toBeTruthy();
      expect(task.status).toBe("backlog");
    } finally {
      cleanup();
    }
  });
});
