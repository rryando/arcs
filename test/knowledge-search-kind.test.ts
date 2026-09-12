// ---------------------------------------------------------------------------
// Tests for `arcs knowledge search --kind` enum coverage (all 8 kinds)
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCommand } from "../src/cli/command-registry.js";
import { renderMarkdown } from "../src/cli/md-renderer.js";
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

describe("arcs knowledge get markdown rendering of code chunks", () => {
  it("renders each chunk as a fenced block headed by path:start-end", () => {
    const md = renderMarkdown("knowledge get", {
      meta: {
        title: "Chunked entry",
        kind: "reference",
        summary: "Has evidence",
        codeChunks: [
          {
            path: "src/a.ts",
            startLine: 10,
            endLine: 12,
            language: "typescript",
            snippet: "const x = 1;",
            capturedAt: "2025-01-01T00:00:00.000Z",
          },
          {
            path: "src/b.sh",
            startLine: 3,
            endLine: 4,
            snippet: "echo hi",
            capturedAt: "2025-01-01T00:00:00.000Z",
          },
        ],
      },
    });

    expect(md).toBeTruthy();
    // Header line carries the chunk range.
    expect(md!).toContain("src/a.ts:10-12");
    // Fence info string uses the stored language; snippet is inside the fence.
    expect(md!).toContain("```typescript");
    expect(md!).toContain("const x = 1;");
    // Missing language falls back to a plain fence.
    expect(md!).toContain("src/b.sh:3-4");
    expect(md!).toContain("echo hi");
  });

  it("renders chunks alongside the body when --body is used", () => {
    const md = renderMarkdown("knowledge get", {
      meta: {
        title: "With body",
        kind: "reference",
        codeChunks: [
          {
            path: "p.ts",
            startLine: 1,
            endLine: 1,
            snippet: "bodychunk",
            capturedAt: "2025-01-01T00:00:00.000Z",
          },
        ],
      },
      body: "main body text",
    });

    expect(md!).toContain("main body text");
    expect(md!).toContain("p.ts:1-1");
    expect(md!).toContain("bodychunk");
  });

  it("leaves an entry without chunks unchanged", () => {
    const md = renderMarkdown("knowledge get", {
      meta: { title: "Plain", kind: "gotcha", summary: "sum" },
    });

    expect(md).toBe("**Plain** (gotcha)\n\nsum");
  });
});
