// ---------------------------------------------------------------------------
// Tests for `arcs batch` knowledge-create op: summary, sourceFiles, audience
// pass-through to createKnowledgeEntry.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

function seedProject(dir: string, slug: string) {
  const rootMeta = {
    version: "1.0",
    projects: [{ id: slug, name: "Test Project", status: "active", dependsOn: [] }],
  };
  writeFileSync(resolve(dir, "meta.json"), JSON.stringify(rootMeta), "utf-8");
  const projDir = resolve(dir, "projects", slug);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    resolve(projDir, "meta.json"),
    JSON.stringify({ id: slug, name: "Test Project", workspacePaths: [] }),
    "utf-8",
  );
  const knowledgeDir = resolve(projDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(resolve(knowledgeDir, "index.json"), JSON.stringify({ entries: [] }), "utf-8");
  return knowledgeDir;
}

describe("batch knowledge-create pass-through", () => {
  it("passes summary, sourceFiles, and audience to createKnowledgeEntry", async () => {
    await withTempDataDir(async (dir) => {
      const kdir = seedProject(dir, "bkc-proj");
      const batchFile = resolve(dir, "ops.json");
      const ops = [
        {
          op: "knowledge-create",
          slug: "bkc-proj",
          title: "Batch KC",
          kind: "pattern",
          summary: "A batched summary",
          keywords: ["a", "b"],
          sourceFiles: ["src/one.ts", "src/two.ts:Anchor"],
          audience: "implementer",
        },
      ];
      writeFileSync(batchFile, JSON.stringify(ops), "utf-8");

      const result = await runCommand("batch", [`--file=${batchFile}`]);
      expect(result.ok).toBe(true);

      const meta = JSON.parse(readFileSync(resolve(kdir, "batch-kc.meta.json"), "utf-8"));
      expect(meta.summary).toBe("A batched summary");
      expect(meta.sourceFiles).toEqual([
        { path: "src/one.ts" },
        { path: "src/two.ts", anchor: "Anchor" },
      ]);
      expect(meta.audience).toBe("implementer");
    });
  });

  it("works without summary/sourceFiles/audience (backward compat)", async () => {
    await withTempDataDir(async (dir) => {
      const kdir = seedProject(dir, "bkc-proj2");
      const batchFile = resolve(dir, "ops2.json");
      const ops = [{ op: "knowledge-create", slug: "bkc-proj2", title: "Bare KC", kind: "lesson" }];
      writeFileSync(batchFile, JSON.stringify(ops), "utf-8");

      const result = await runCommand("batch", [`--file=${batchFile}`]);
      expect(result.ok).toBe(true);

      const meta = JSON.parse(readFileSync(resolve(kdir, "bare-kc.meta.json"), "utf-8"));
      expect(meta.summary).toBe("");
      expect("sourceFiles" in meta).toBe(false);
      expect("audience" in meta).toBe(false);
    });
  });
});
