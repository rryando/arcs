// ---------------------------------------------------------------------------
// Tests for new knowledge CLI flags:
//   - create  --audience
//   - upsert  --source-files, --audience
//   - update-meta --source-files, --audience
// ---------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const X_FILE = [
  "export const a = 1;",
  "export const b = 2;",
  "export const c = 3;",
  "export const d = 4;",
  "export const e = 5;",
].join("\n");

const X_SNIPPET_1_3 = "export const a = 1;\nexport const b = 2;\nexport const c = 3;";

/**
 * Seed a project whose workspace path is a real temp dir containing
 * `src/x.ts` (5 lines) and `src/y.ts` (2 lines), so `--code` can read real
 * files. Returns the knowledge dir and the workspace root.
 */
function seedWorkspaceProject(dir: string, slug: string) {
  const workspaceDir = mkdtempSync(resolve(tmpdir(), `arcs-ws-${slug}-`));
  mkdirSync(resolve(workspaceDir, "src"), { recursive: true });
  writeFileSync(resolve(workspaceDir, "src", "x.ts"), `${X_FILE}\n`, "utf-8");
  writeFileSync(
    resolve(workspaceDir, "src", "y.ts"),
    "export const y1 = 1;\nexport const y2 = 2;\n",
    "utf-8",
  );

  const rootMeta = {
    version: "1.0",
    projects: [{ id: slug, name: "Test Project", status: "active", dependsOn: [] }],
  };
  writeFileSync(resolve(dir, "meta.json"), JSON.stringify(rootMeta), "utf-8");
  const projDir = resolve(dir, "projects", slug);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    resolve(projDir, "meta.json"),
    JSON.stringify({ id: slug, name: "Test Project", workspacePaths: [workspaceDir] }),
    "utf-8",
  );
  const knowledgeDir = resolve(projDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(resolve(knowledgeDir, "index.json"), JSON.stringify({ entries: [] }), "utf-8");
  return { knowledgeDir, workspaceDir };
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

// ---------------------------------------------------------------------------
// --code capture across knowledge write paths
// ---------------------------------------------------------------------------

function entriesIn(knowledgeDir: string): unknown[] {
  return JSON.parse(readFileSync(resolve(knowledgeDir, "index.json"), "utf-8")).entries;
}

describe("knowledge create --code", () => {
  it("captures the exact verbatim slice for a valid ref", async () => {
    await withTempDataDir(async (dir) => {
      const { knowledgeDir } = seedWorkspaceProject(dir, "kcode-create");
      const result = await runCommand("knowledge create", [
        "kcode-create",
        "Code Create",
        "--kind=module",
        "--code=src/x.ts:1-3",
      ]);
      expect(result.ok).toBe(true);
      const meta = readMeta(knowledgeDir, "code-create");
      expect(meta.codeChunks).toHaveLength(1);
      expect(meta.codeChunks[0].path).toBe("src/x.ts");
      expect(meta.codeChunks[0].startLine).toBe(1);
      expect(meta.codeChunks[0].endLine).toBe(3);
      expect(meta.codeChunks[0].snippet).toBe(X_SNIPPET_1_3);
      expect(meta.codeChunks[0].language).toBe("typescript");
      expect(typeof meta.codeChunks[0].capturedAt).toBe("string");
    });
  });

  it("accepts comma-separated refs in one flag", async () => {
    await withTempDataDir(async (dir) => {
      const { knowledgeDir } = seedWorkspaceProject(dir, "kcode-multi");
      const result = await runCommand("knowledge create", [
        "kcode-multi",
        "Code Multi",
        "--kind=module",
        "--code=src/x.ts:1-3,src/y.ts:1-2",
      ]);
      expect(result.ok).toBe(true);
      const meta = readMeta(knowledgeDir, "code-multi");
      expect(meta.codeChunks).toHaveLength(2);
      expect(meta.codeChunks[0].path).toBe("src/x.ts");
      expect(meta.codeChunks[0].snippet).toBe(X_SNIPPET_1_3);
      expect(meta.codeChunks[1].path).toBe("src/y.ts");
      expect(meta.codeChunks[1].snippet).toBe("export const y1 = 1;\nexport const y2 = 2;");
    });
  });

  it("returns a structured failure naming the value and creates nothing", async () => {
    await withTempDataDir(async (dir) => {
      const { knowledgeDir } = seedWorkspaceProject(dir, "kcode-bad");
      for (const bad of ["src/x.ts", "src/x.ts:0-5", "src/x.ts:20-10", ":5-9"]) {
        const result = await runCommand("knowledge create", [
          "kcode-bad",
          `Bad ${bad}`,
          "--kind=module",
          `--code=${bad}`,
        ]);
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.message).toContain(bad);
        expect(result.message).toContain("path:start-end");
      }
      // Nothing was created for any malformed value.
      expect(entriesIn(knowledgeDir)).toEqual([]);
    });
  });

  it("fails when the file is missing", async () => {
    await withTempDataDir(async (dir) => {
      const { knowledgeDir } = seedWorkspaceProject(dir, "kcode-missing");
      const result = await runCommand("knowledge create", [
        "kcode-missing",
        "Missing File",
        "--kind=module",
        "--code=src/nope.ts:1-3",
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("src/nope.ts:1-3");
      expect(entriesIn(knowledgeDir)).toEqual([]);
    });
  });

  it("fails when the range is past EOF", async () => {
    await withTempDataDir(async (dir) => {
      const { knowledgeDir } = seedWorkspaceProject(dir, "kcode-eof");
      const result = await runCommand("knowledge create", [
        "kcode-eof",
        "Past Eof",
        "--kind=module",
        "--code=src/x.ts:1-999",
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("src/x.ts:1-999");
      expect(entriesIn(knowledgeDir)).toEqual([]);
    });
  });

  it("fails clearly when no workspace path is registered", async () => {
    await withTempDataDir(async (dir) => {
      const kdir = seedProject(dir, "kcode-nows");
      const result = await runCommand("knowledge create", [
        "kcode-nows",
        "No Workspace",
        "--kind=module",
        "--code=src/x.ts:1-3",
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("workspace");
      expect(entriesIn(kdir)).toEqual([]);
    });
  });
});

describe("knowledge upsert --code", () => {
  it("captures chunks on the create path", async () => {
    await withTempDataDir(async (dir) => {
      const { knowledgeDir } = seedWorkspaceProject(dir, "kcode-upsert");
      const result = await runCommand("knowledge upsert", [
        "kcode-upsert",
        "Upsert Code",
        "--kind=module",
        "--code=src/x.ts:2-3",
      ]);
      expect(result.ok).toBe(true);
      const meta = readMeta(knowledgeDir, "upsert-code");
      expect(meta.codeChunks[0].snippet).toBe("export const b = 2;\nexport const c = 3;");
    });
  });

  it("captures chunks on the update path", async () => {
    await withTempDataDir(async (dir) => {
      const { knowledgeDir } = seedWorkspaceProject(dir, "kcode-upsert2");
      await runCommand("knowledge upsert", ["kcode-upsert2", "Upsert Code2", "--kind=module"]);
      const result = await runCommand("knowledge upsert", [
        "kcode-upsert2",
        "Upsert Code2",
        "--kind=module",
        "--code=src/x.ts:4-5",
      ]);
      expect(result.ok).toBe(true);
      const meta = readMeta(knowledgeDir, "upsert-code2");
      expect(meta.codeChunks[0].snippet).toBe("export const d = 4;\nexport const e = 5;");
    });
  });
});

describe("knowledge update-meta --code", () => {
  it("attaches chunks to an existing entry", async () => {
    await withTempDataDir(async (dir) => {
      const { knowledgeDir } = seedWorkspaceProject(dir, "kcode-meta");
      await runCommand("knowledge create", ["kcode-meta", "Meta Code", "--kind=module"]);
      const result = await runCommand("knowledge update-meta", [
        "kcode-meta",
        "meta-code",
        "--code=src/x.ts:1-2",
      ]);
      expect(result.ok).toBe(true);
      const meta = readMeta(knowledgeDir, "meta-code");
      expect(meta.codeChunks[0].snippet).toBe("export const a = 1;\nexport const b = 2;");
    });
  });

  it("rejects a malformed --code and leaves the entry chunkless", async () => {
    await withTempDataDir(async (dir) => {
      const { knowledgeDir } = seedWorkspaceProject(dir, "kcode-meta2");
      await runCommand("knowledge create", ["kcode-meta2", "Meta Code2", "--kind=module"]);
      const result = await runCommand("knowledge update-meta", [
        "kcode-meta2",
        "meta-code2",
        "--code=not-a-ref",
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("not-a-ref");
      const meta = readMeta(knowledgeDir, "meta-code2");
      expect("codeChunks" in meta).toBe(false);
    });
  });
});

describe("knowledge get returns codeChunks", () => {
  it("round-trips chunks through a JSON read", async () => {
    await withTempDataDir(async (dir) => {
      seedWorkspaceProject(dir, "kcode-get");
      await runCommand("knowledge create", [
        "kcode-get",
        "Get Code",
        "--kind=module",
        "--code=src/x.ts:1-3",
      ]);
      const result = await runCommand("knowledge get", ["kcode-get", "get-code"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { meta: { codeChunks: Array<{ snippet: string }> } };
      expect(data.meta.codeChunks[0]?.snippet).toBe(X_SNIPPET_1_3);
    });
  });
});

describe("batch knowledge ops accept --code", () => {
  it("captures chunks for knowledge-create", async () => {
    await withTempDataDir(async (dir) => {
      const { knowledgeDir } = seedWorkspaceProject(dir, "bcode-create");
      const batchFile = resolve(dir, "ops.json");
      writeFileSync(
        batchFile,
        JSON.stringify([
          {
            op: "knowledge-create",
            slug: "bcode-create",
            title: "Batch Code",
            kind: "module",
            code: "src/x.ts:1-3",
          },
        ]),
        "utf-8",
      );
      const result = await runCommand("batch", [`--file=${batchFile}`]);
      expect(result.ok).toBe(true);
      const meta = readMeta(knowledgeDir, "batch-code");
      expect(meta.codeChunks[0].snippet).toBe(X_SNIPPET_1_3);
    });
  });

  it("captures chunks for knowledge-update-meta", async () => {
    await withTempDataDir(async (dir) => {
      const { knowledgeDir } = seedWorkspaceProject(dir, "bcode-meta");
      await runCommand("knowledge create", ["bcode-meta", "Batch Meta", "--kind=module"]);
      const batchFile = resolve(dir, "ops2.json");
      writeFileSync(
        batchFile,
        JSON.stringify([
          {
            op: "knowledge-update-meta",
            slug: "bcode-meta",
            entryId: "batch-meta",
            code: ["src/y.ts:1-2"],
          },
        ]),
        "utf-8",
      );
      const result = await runCommand("batch", [`--file=${batchFile}`]);
      expect(result.ok).toBe(true);
      const meta = readMeta(knowledgeDir, "batch-meta");
      expect(meta.codeChunks[0].snippet).toBe("export const y1 = 1;\nexport const y2 = 2;");
    });
  });

  it("records a per-op failure for a malformed --code", async () => {
    await withTempDataDir(async (dir) => {
      const { knowledgeDir } = seedWorkspaceProject(dir, "bcode-bad");
      const batchFile = resolve(dir, "ops3.json");
      writeFileSync(
        batchFile,
        JSON.stringify([
          {
            op: "knowledge-create",
            slug: "bcode-bad",
            title: "Batch Bad",
            kind: "module",
            code: "oops",
          },
        ]),
        "utf-8",
      );
      const result = await runCommand("batch", [`--file=${batchFile}`]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const results = result.data as Array<{ success: boolean; error?: string }>;
      expect(results[0]?.success).toBe(false);
      expect(results[0]?.error).toContain("oops");
      expect(entriesIn(knowledgeDir)).toEqual([]);
    });
  });
});

describe("code chunk backward compatibility", () => {
  it("preserves codeChunks across an index rebuild", async () => {
    await withTempDataDir(async (dir) => {
      const { knowledgeDir } = seedWorkspaceProject(dir, "kcode-rebuild");
      await runCommand("knowledge create", [
        "kcode-rebuild",
        "Rebuild Code",
        "--kind=module",
        "--code=src/x.ts:1-3",
      ]);
      // Drop the index so the next read rebuilds it from the meta files.
      writeFileSync(resolve(knowledgeDir, "index.json"), "", "utf-8");

      const listed = await runCommand("knowledge list", ["kcode-rebuild"]);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      const data = listed.data as Array<{ codeChunks?: Array<{ snippet: string }> }>;
      expect(data[0]?.codeChunks?.[0]?.snippet).toBe(X_SNIPPET_1_3);

      // index.json rebuilt on disk also carries the chunks.
      const rebuilt = JSON.parse(readFileSync(resolve(knowledgeDir, "index.json"), "utf-8"));
      expect(rebuilt.entries[0].codeChunks).toHaveLength(1);
    });
  });

  it("loads and lists a legacy meta file with no codeChunks, without rewriting it", async () => {
    await withTempDataDir(async (dir) => {
      const knowledgeDir = seedProject(dir, "kcode-legacy");
      const legacyMeta = {
        id: "legacy-entry",
        normalizedId: "legacy-entry",
        title: "Legacy Entry",
        kind: "lesson",
        keywords: [],
        summary: "Written before codeChunks existed.",
        file: "knowledge/legacy-entry.md",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };
      writeFileSync(
        resolve(knowledgeDir, "legacy-entry.meta.json"),
        JSON.stringify(legacyMeta, null, 2),
        "utf-8",
      );
      writeFileSync(resolve(knowledgeDir, "legacy-entry.md"), "# Legacy Entry\n\nBody.\n", "utf-8");
      // Force a rebuild from the meta files.
      writeFileSync(resolve(knowledgeDir, "index.json"), "", "utf-8");

      const result = await runCommand("knowledge list", ["kcode-legacy"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as Array<{ id: string; codeChunks?: unknown }>;
      expect(data.map((e) => e.id)).toContain("legacy-entry");
      expect("codeChunks" in (data.find((e) => e.id === "legacy-entry") ?? {})).toBe(false);

      // The legacy meta file must not be rewritten by the read path.
      const onDisk = readFileSync(resolve(knowledgeDir, "legacy-entry.meta.json"), "utf-8");
      expect(JSON.parse(onDisk)).toEqual(legacyMeta);
    });
  });
});
