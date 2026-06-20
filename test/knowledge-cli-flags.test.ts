// ---------------------------------------------------------------------------
// Tests for new knowledge CLI flags:
//   - create  --audience
//   - upsert  --source-files, --audience
//   - update-meta --source-files, --audience
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
  return resolve(projDir, "knowledge");
}

function readMeta(knowledgeDir: string, normalizedId: string) {
  return JSON.parse(readFileSync(resolve(knowledgeDir, `${normalizedId}.meta.json`), "utf-8"));
}

describe("knowledge create --audience", () => {
  it("threads audience into the created entry", async () => {
    await withTempDataDir(async (dir) => {
      const kdir = seedProject(dir, "kc-proj");
      const result = await runCommand("knowledge create", [
        "kc-proj",
        "Audience Create",
        "--kind=pattern",
        "--audience=implementer",
      ]);
      expect(result.ok).toBe(true);
      const meta = readMeta(kdir, "audience-create");
      expect(meta.audience).toBe("implementer");
    });
  });

  it("rejects an invalid audience value", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "kc-proj2");
      const result = await runCommand("knowledge create", [
        "kc-proj2",
        "Bad Audience",
        "--kind=pattern",
        "--audience=nope",
      ]);
      expect(result.ok).toBe(false);
    });
  });
});

describe("knowledge upsert --source-files and --audience", () => {
  it("threads source-files and audience on create path", async () => {
    await withTempDataDir(async (dir) => {
      const kdir = seedProject(dir, "ku-proj");
      const result = await runCommand("knowledge upsert", [
        "ku-proj",
        "Upsert Sf",
        "--kind=lesson",
        "--source-files=src/a.ts,src/b.ts:Foo",
        "--audience=designer",
      ]);
      expect(result.ok).toBe(true);
      const meta = readMeta(kdir, "upsert-sf");
      expect(meta.sourceFiles).toEqual([{ path: "src/a.ts" }, { path: "src/b.ts", anchor: "Foo" }]);
      expect(meta.audience).toBe("designer");
    });
  });

  it("threads source-files and audience on update path", async () => {
    await withTempDataDir(async (dir) => {
      const kdir = seedProject(dir, "ku-proj2");
      await runCommand("knowledge upsert", ["ku-proj2", "Upsert Up", "--kind=lesson"]);
      const result = await runCommand("knowledge upsert", [
        "ku-proj2",
        "Upsert Up",
        "--kind=lesson",
        "--source-files=src/c.ts:Bar",
        "--audience=orchestrator",
      ]);
      expect(result.ok).toBe(true);
      const meta = readMeta(kdir, "upsert-up");
      expect(meta.sourceFiles).toEqual([{ path: "src/c.ts", anchor: "Bar" }]);
      expect(meta.audience).toBe("orchestrator");
    });
  });
});

describe("knowledge update-meta --source-files and --audience", () => {
  it("threads source-files and audience into existing entry", async () => {
    await withTempDataDir(async (dir) => {
      const kdir = seedProject(dir, "kum-proj");
      await runCommand("knowledge create", ["kum-proj", "Meta Target", "--kind=gotcha"]);
      const result = await runCommand("knowledge update-meta", [
        "kum-proj",
        "meta-target",
        "--source-files=src/x.ts,src/y.ts:Anchor",
        "--audience=universal",
      ]);
      expect(result.ok).toBe(true);
      const meta = readMeta(kdir, "meta-target");
      expect(meta.sourceFiles).toEqual([
        { path: "src/x.ts" },
        { path: "src/y.ts", anchor: "Anchor" },
      ]);
      expect(meta.audience).toBe("universal");
    });
  });

  it("rejects an invalid audience value", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "kum-proj2");
      await runCommand("knowledge create", ["kum-proj2", "Meta Target2", "--kind=gotcha"]);
      const result = await runCommand("knowledge update-meta", [
        "kum-proj2",
        "meta-target2",
        "--audience=bogus",
      ]);
      expect(result.ok).toBe(false);
    });
  });
});
