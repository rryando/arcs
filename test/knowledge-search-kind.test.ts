// ---------------------------------------------------------------------------
// Tests for `arcs knowledge search --kind` enum coverage (all 8 kinds)
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCommand } from "../src/cli/command-registry.js";
import { KNOWLEDGE_KINDS } from "../src/utils/storage-utils.js";
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
}

describe("arcs knowledge search --kind enum", () => {
  it("exposes all 8 KNOWLEDGE_KINDS in the --kind enum", () => {
    const cmd = getCommand("knowledge search");
    expect(cmd).toBeDefined();
    const kindEnum = cmd!.params?.kind?.enum;
    expect(kindEnum).toBeDefined();
    expect([...(kindEnum as readonly string[])].sort()).toEqual([...KNOWLEDGE_KINDS].sort());
    expect((kindEnum as readonly string[]).length).toBe(8);
  });

  it("accepts kind=architecture (previously rejected)", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "ks-proj");
      const result = await runCommand("knowledge search", [
        "ks-proj",
        "anything",
        "--kind=architecture",
      ]);
      expect(result.ok).toBe(true);
    });
  });

  it("accepts kind=module (previously rejected)", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "ks-proj2");
      const result = await runCommand("knowledge search", [
        "ks-proj2",
        "anything",
        "--kind=module",
      ]);
      expect(result.ok).toBe(true);
    });
  });
});
