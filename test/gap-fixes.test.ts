// ---------------------------------------------------------------------------
// Regression guards for three CLI fixes:
//   GAP-1: diagram status `in_progress` → `inProgress` casing translation
//   GAP-2: project update-doc --content inline flag
//   GAP-3: batch nested {op, params:{...}} unwrapping + doc/body aliases
//
// These tests MUST pass with the fixes in place and will catch regressions if
// any of the three behaviors is reverted.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

async function createTestProject(slug = "gap-proj"): Promise<void> {
  const result = await runCommand("project init", [slug, "--description=Gap fixes test project"]);
  if (!result.ok) throw new Error(`project init failed: ${JSON.stringify(result)}`);
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
  classDef inProgress fill:#ff0
  classDef done fill:#0f0
  classDef blocked fill:#f00
`,
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// GAP-1: diagram status in_progress casing
// ---------------------------------------------------------------------------

describe("GAP-1: diagram status in_progress casing", () => {
  it("does not return diagram_error for in_progress (translates to inProgress)", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject();
      seedDiagram(dir, "gap-proj", "my-plan", "T001");

      const inProgress = await runCommand("diagram status", [
        "gap-proj",
        "my-plan",
        "T001",
        "in_progress",
      ]);

      // Regression: previously always failed with code "diagram_error".
      expect(inProgress.ok).toBe(true);
      if (!inProgress.ok) {
        expect(inProgress.code).not.toBe("diagram_error");
      }
    });
  });

  it("accepts done status as well", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject();
      seedDiagram(dir, "gap-proj", "my-plan", "T001");

      const done = await runCommand("diagram status", ["gap-proj", "my-plan", "T001", "done"]);

      expect(done.ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// GAP-2: project update-doc --content flag
// ---------------------------------------------------------------------------

describe("GAP-2: project update-doc --content flag", () => {
  it("accepts --content and writes it to the doc", async () => {
    await withTempDataDir(async () => {
      await createTestProject();

      const update = await runCommand("project update-doc", [
        "gap-proj",
        "overview",
        "--content=hello from content flag",
      ]);
      expect(update.ok).toBe(true);

      const get = await runCommand("project get", ["gap-proj", "--doc=overview"]);
      expect(get.ok).toBe(true);
      if (get.ok) {
        const data = get.data as { content: string };
        expect(data.content).toBe("hello from content flag");
      }
    });
  });

  it("gives --body-file precedence over --content", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject();

      const tmpFile = resolve(dir, "body.md");
      writeFileSync(tmpFile, "from file", "utf-8");

      const update = await runCommand("project update-doc", [
        "gap-proj",
        "overview",
        `--body-file=${tmpFile}`,
        "--content=from content",
      ]);
      expect(update.ok).toBe(true);

      const get = await runCommand("project get", ["gap-proj", "--doc=overview"]);
      expect(get.ok).toBe(true);
      if (get.ok) {
        const data = get.data as { content: string };
        expect(data.content).toBe("from file");
      }
    });
  });

  it("still fails with missing_param when no input source is given", async () => {
    await withTempDataDir(async () => {
      await createTestProject();

      const update = await runCommand("project update-doc", ["gap-proj", "overview"]);

      expect(update.ok).toBe(false);
      if (!update.ok) {
        expect(update.code).toBe("missing_param");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// GAP-3: batch params-unwrapping + doc/body aliases
// ---------------------------------------------------------------------------

describe("GAP-3: batch params-unwrapping + aliases", () => {
  it("unwraps nested params format for doc-update", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject();

      const batchFile = resolve(dir, "batch-nested-doc.json");
      writeFileSync(
        batchFile,
        JSON.stringify([
          {
            op: "doc-update",
            params: { slug: "gap-proj", doc: "overview", content: "nested works" },
          },
        ]),
        "utf-8",
      );

      const result = await runCommand("batch", [`--file=${batchFile}`]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as Array<{ success: boolean }>;
        expect(data[0].success).toBe(true);
      }
    });
  });

  it("accepts 'doc' as an alias for docType in doc-update (flat format)", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject();

      const batchFile = resolve(dir, "batch-doc-alias.json");
      writeFileSync(
        batchFile,
        JSON.stringify([
          { op: "doc-update", slug: "gap-proj", doc: "overview", content: "doc alias works" },
        ]),
        "utf-8",
      );

      const result = await runCommand("batch", [`--file=${batchFile}`]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as Array<{ success: boolean }>;
        expect(data[0].success).toBe(true);
      }
    });
  });

  it("unwraps nested params format for task-create", async () => {
    await withTempDataDir(async (dir) => {
      await createTestProject();

      const batchFile = resolve(dir, "batch-nested-task.json");
      writeFileSync(
        batchFile,
        JSON.stringify([{ op: "task-create", params: { slug: "gap-proj", title: "Nested Task" } }]),
        "utf-8",
      );

      const result = await runCommand("batch", [`--file=${batchFile}`]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as Array<{ success: boolean }>;
        expect(data[0].success).toBe(true);
      }
    });
  });
});
