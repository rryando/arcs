import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

describe("diagram init", () => {
  it("creates .mmd with correct content from plan tasks", async () => {
    await withTempDataDir(async () => {
      await runCommand("project init", ["testproj", "--description=Test project"]);
      const planResult = await runCommand("plan create", [
        "testproj",
        "Test Plan",
        "--summary=test",
        "--status=planned",
      ]);
      expect(planResult.ok).toBe(true);
      const planId = (planResult.data as { id: string }).id;

      await runCommand("task create", ["testproj", "Task One", `--planId=${planId}`]);
      await runCommand("task create", ["testproj", "Task Two", `--planId=${planId}`]);

      const result = await runCommand("diagram init", ["testproj", planId]);

      expect(result.ok).toBe(true);
      expect((result.data as { nodeCount: number }).nodeCount).toBe(2);

      const mmd = await readFile((result.data as { path: string }).path, "utf-8");
      expect(mmd).toContain("flowchart TD");
      expect(mmd).toContain("classDef backlog");
      expect(mmd).toContain("Task One");
      expect(mmd).toContain(`%% plan: ${planId}`);
      expect(mmd).toContain("T001[");
    });
  });

  it("returns entity_not_found when plan has no tasks", async () => {
    await withTempDataDir(async () => {
      await runCommand("project init", ["testproj", "--description=Test project"]);
      const planResult = await runCommand("plan create", [
        "testproj",
        "Empty Plan",
        "--summary=empty",
        "--status=planned",
      ]);
      const planId = (planResult.data as { id: string }).id;

      const result = await runCommand("diagram init", ["testproj", planId]);

      expect(result.ok).toBe(false);
      expect((result as { code: string }).code).toBe("entity_not_found");
    });
  });

  it("returns conflict when .mmd exists without --force", async () => {
    await withTempDataDir(async () => {
      await runCommand("project init", ["testproj", "--description=Test project"]);
      const planResult = await runCommand("plan create", [
        "testproj",
        "Test Plan",
        "--summary=s",
        "--status=planned",
      ]);
      const planId = (planResult.data as { id: string }).id;
      await runCommand("task create", ["testproj", "T1", `--planId=${planId}`]);

      await runCommand("diagram init", ["testproj", planId]);
      const second = await runCommand("diagram init", ["testproj", planId]);

      expect(second.ok).toBe(false);
      expect((second as { code: string }).code).toBe("conflict");
    });
  });

  it("--force overwrites existing .mmd", async () => {
    await withTempDataDir(async () => {
      await runCommand("project init", ["testproj", "--description=Test project"]);
      const planResult = await runCommand("plan create", [
        "testproj",
        "Test Plan",
        "--summary=s",
        "--status=planned",
      ]);
      const planId = (planResult.data as { id: string }).id;
      await runCommand("task create", ["testproj", "T1", `--planId=${planId}`]);

      await runCommand("diagram init", ["testproj", planId]);
      const result = await runCommand("diagram init", ["testproj", planId, "--force"]);

      expect(result.ok).toBe(true);
    });
  });

  it("translates dependsOn taskIds into diagram node IDs (edges + blocked-by)", async () => {
    await withTempDataDir(async () => {
      await runCommand("project init", ["testproj", "--description=Test project"]);
      const planResult = await runCommand("plan create", [
        "testproj",
        "Dep Plan",
        "--summary=s",
        "--status=planned",
      ]);
      const planId = (planResult.data as { id: string }).id;

      const a = await runCommand("task create", ["testproj", "Alpha", `--planId=${planId}`]);
      const aId = (a.data as { id: string }).id;
      const b = await runCommand("task create", [
        "testproj",
        "Bravo",
        `--planId=${planId}`,
        `--dependsOn=${aId}`,
      ]);
      const bId = (b.data as { id: string }).id;
      await runCommand("task create", [
        "testproj",
        "Charlie",
        `--planId=${planId}`,
        `--dependsOn=${aId},${bId}`,
      ]);

      const result = await runCommand("diagram init", ["testproj", planId]);
      expect(result.ok).toBe(true);

      const mmd = await readFile((result.data as { path: string }).path, "utf-8");

      // Stable id-sorted ordering: Alpha=T001, Bravo=T002, Charlie=T003
      expect(mmd).toContain("T001 --> T002");
      expect(mmd).toContain("T001 --> T003");
      expect(mmd).toContain("T002 --> T003");

      // Per-node blocked-by metadata
      expect(mmd).toMatch(/%% node: T002[\s\S]*?%% blocked-by: T001/);
      expect(mmd).toMatch(/%% node: T003[\s\S]*?%% blocked-by: T001, T002/);

      // Plan-level ready/blocked summary
      expect(mmd).toContain("%% ready: T001");
      expect(mmd).toContain("%% blocked: T002, T003");
    });
  });

  it("assigns stable node IDs by task.id regardless of priority", async () => {
    await withTempDataDir(async () => {
      await runCommand("project init", ["testproj", "--description=Test project"]);
      const planResult = await runCommand("plan create", [
        "testproj",
        "Stable Plan",
        "--summary=s",
        "--status=planned",
      ]);
      const planId = (planResult.data as { id: string }).id;

      // Create in order; second has higher priority — must NOT jump ahead.
      // Titles "Alpha" and "Bravo" are chosen so derived task IDs sort
      // lexicographically in creation order (alpha < bravo). Renaming these
      // tasks will invalidate the assertion — keep names ASCII-sorted.
      await runCommand("task create", [
        "testproj",
        "Alpha",
        `--planId=${planId}`,
        "--priority=low",
      ]);
      await runCommand("task create", [
        "testproj",
        "Bravo",
        `--planId=${planId}`,
        "--priority=high",
      ]);

      const result = await runCommand("diagram init", ["testproj", planId]);
      const mmd = await readFile((result.data as { path: string }).path, "utf-8");

      // Alpha (low priority, created first, taskId sorts first) must be T001.
      // Bravo (high priority) must NOT jump ahead — proves sort is by id, not priority.
      expect(mmd).toMatch(/%% node: T001[\s\S]*?%% title: Alpha/);
      expect(mmd).toMatch(/%% node: T002[\s\S]*?%% title: Bravo/);
    });
  });

  it("populates per-node metadata blocks from task fields (--scope, --acceptance, --verify, --skill, --source-files)", async () => {
    await withTempDataDir(async () => {
      await runCommand("project init", ["testproj", "--description=Test project"]);
      const planResult = await runCommand("plan create", [
        "testproj",
        "Meta Plan",
        "--summary=s",
        "--status=planned",
      ]);
      const planId = (planResult.data as { id: string }).id;

      const created = await runCommand("task create", [
        "testproj",
        "Metadata Task",
        `--planId=${planId}`,
        "--scope=src/foo.ts",
        "--acceptance=passes test X",
        "--verify=vitest run foo.test.ts",
        "--skill=quick-dev",
        "--source-files=src/foo.ts:line-42",
      ]);
      expect(created.ok).toBe(true);

      const result = await runCommand("diagram init", ["testproj", planId, "--force"]);
      expect(result.ok).toBe(true);

      const mmd = await readFile((result.data as { path: string }).path, "utf-8");

      expect(mmd).toContain("%% skill: quick-dev");
      expect(mmd).toContain("%% scope: src/foo.ts");
      expect(mmd).toContain("%% files: src/foo.ts:line-42");
      expect(mmd).toContain("%% acceptance: passes test X");
      expect(mmd).toContain("%% verify: vitest run foo.test.ts");
      // No (TBD) leakage when fields are populated
      expect(mmd).not.toContain("%% scope: (TBD)");
      expect(mmd).not.toContain("%% acceptance: (TBD)");
    });
  });

  it("falls back to (TBD) for tasks without metadata fields (backward compat)", async () => {
    await withTempDataDir(async () => {
      await runCommand("project init", ["testproj", "--description=Test project"]);
      const planResult = await runCommand("plan create", [
        "testproj",
        "Bare Plan",
        "--summary=s",
        "--status=planned",
      ]);
      const planId = (planResult.data as { id: string }).id;

      // Task created with no metadata flags
      await runCommand("task create", ["testproj", "Bare Task", `--planId=${planId}`]);

      const result = await runCommand("diagram init", ["testproj", planId]);
      const mmd = await readFile((result.data as { path: string }).path, "utf-8");

      expect(mmd).toContain("%% skill: quick-dev");
      expect(mmd).toContain("%% scope: (TBD)");
      expect(mmd).toContain("%% acceptance: (TBD)");
      expect(mmd).toContain("%% verify: npm test");
      // %% files: line is omitted entirely when sourceFiles is absent
      expect(mmd).not.toContain("%% files:");
    });
  });
});
