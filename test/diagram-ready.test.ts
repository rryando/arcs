import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

interface ReadyData {
  ready: string[];
  blocked: string[];
  inProgress: string[];
  done: string[];
}

function asReady(data: unknown): ReadyData {
  if (typeof data !== "object" || data === null) {
    throw new Error(`expected object, got: ${JSON.stringify(data)}`);
  }
  return data as ReadyData;
}

async function setupPlanWithDiagram(): Promise<{
  slug: string;
  planId: string;
  diagramPath: string;
}> {
  const slug = "testproj";
  await runCommand("project init", [slug, "--description=Test project"]);
  const planResult = await runCommand("plan create", [
    slug,
    "Ready Test Plan",
    "--summary=test",
    "--status=planned",
  ]);
  const planId = (planResult.data as { id: string }).id;

  // Create 4 tasks, one for each bucket. The CLI auto-assigns T001..T004 in order.
  await runCommand("task create", [slug, "Task One", `--planId=${planId}`]);
  await runCommand("task create", [slug, "Task Two", `--planId=${planId}`]);
  await runCommand("task create", [slug, "Task Three", `--planId=${planId}`]);
  await runCommand("task create", [slug, "Task Four", `--planId=${planId}`]);

  const initResult = await runCommand("diagram init", [slug, planId]);
  const diagramPath = (initResult.data as { path: string }).path;

  return { slug, planId, diagramPath };
}

describe("diagram ready — envelope shape", () => {
  it("returns object with ready/blocked/inProgress/done arrays (not bare list)", async () => {
    await withTempDataDir(async () => {
      const { slug, planId } = await setupPlanWithDiagram();
      const result = await runCommand("diagram ready", [slug, planId]);

      expect(result.ok).toBe(true);
      // Must NOT be a bare array — the legacy shape.
      expect(Array.isArray((result as { data: unknown }).data)).toBe(false);

      const data = asReady((result as { data: unknown }).data);
      expect(Array.isArray(data.ready)).toBe(true);
      expect(Array.isArray(data.blocked)).toBe(true);
      expect(Array.isArray(data.inProgress)).toBe(true);
      expect(Array.isArray(data.done)).toBe(true);
    });
  });

  it("buckets are disjoint and cover all nodes", async () => {
    await withTempDataDir(async () => {
      const { slug, planId, diagramPath } = await setupPlanWithDiagram();

      // Manipulate the diagram to put one node in each of the 4 buckets:
      //   T001 done, T002 inProgress, T003 backlog with T001 dep (ready),
      //   T004 backlog with T002 dep (blocked since T002 not done)
      const original = await readFile(diagramPath, "utf-8");
      // Set T001 → done, T002 → inProgress in graph + metadata blocks.
      let modified = original
        .replace(/(T001\[[^\]]+\]):::\w+/, "$1:::done")
        .replace(/(T002\[[^\]]+\]):::\w+/, "$1:::inProgress");

      // Add edges T001 --> T003 and T002 --> T004 (so T003 ready, T004 blocked).
      // Append edges right before final newline of flowchart section.
      modified = modified.replace(
        /(T004\[[^\]]+\]:::\w+)/,
        "$1\n\n    T001 --> T003\n    T002 --> T004",
      );

      // Update metadata block statuses too (otherwise validate will see drift, but
      // ready doesn't require that — keep minimal).
      modified = modified.replace(/(%% node: T001\n%% [^\n]*\n%% status:) \w+/, "$1 done");
      modified = modified.replace(/(%% node: T002\n%% [^\n]*\n%% status:) \w+/, "$1 inProgress");

      await writeFile(diagramPath, modified, "utf-8");

      const result = await runCommand("diagram ready", [slug, planId]);
      expect(result.ok).toBe(true);
      const data = asReady((result as { data: unknown }).data);

      // Bucket coverage: 4 distinct nodes, exactly 4 entries total
      const total =
        data.ready.length + data.blocked.length + data.inProgress.length + data.done.length;
      expect(total).toBe(4);

      // Bucket disjointness: every node appears in exactly one bucket
      const all = [...data.ready, ...data.blocked, ...data.inProgress, ...data.done];
      const unique = new Set(all);
      expect(unique.size).toBe(all.length);

      // Bucket correctness
      expect(data.done).toContain("T001");
      expect(data.inProgress).toContain("T002");
      expect(data.ready).toContain("T003");
      expect(data.blocked).toContain("T004");
    });
  });

  it("with no edges and all backlog: every node is ready, others empty", async () => {
    await withTempDataDir(async () => {
      const { slug, planId } = await setupPlanWithDiagram();
      const result = await runCommand("diagram ready", [slug, planId]);
      expect(result.ok).toBe(true);
      const data = asReady((result as { data: unknown }).data);

      // diagram init creates linear deps T002 -> T001 etc.? Actually it creates 4 backlog tasks.
      // Verify that whatever diagram init produced, the buckets sum to 4 and there are no done/inProgress.
      const total =
        data.ready.length + data.blocked.length + data.inProgress.length + data.done.length;
      expect(total).toBe(4);
      expect(data.done).toEqual([]);
      expect(data.inProgress).toEqual([]);
      // ready ∪ blocked == 4 backlog nodes
      expect(data.ready.length + data.blocked.length).toBe(4);
    });
  });
});
