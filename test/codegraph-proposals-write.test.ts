import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_LINES } from "../src/utils/code-snippet.js";
import type { KnowledgeProposal } from "../src/utils/codegraph.js";
import {
  resolveAnchorRange,
  resolveAnchorRef,
  writeProposalsFile,
} from "../src/utils/codegraph-knowledge.js";
import { getProjectDir } from "../src/utils/paths.js";
import { readProposals } from "../src/utils/proposal-store.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const SLUG = "myproject";

function seedProject(): string {
  const dir = getProjectDir(SLUG);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedKnowledgeIndex(entries: unknown[]): void {
  const dir = getProjectDir(SLUG);
  const knowledgeDir = resolve(dir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(resolve(knowledgeDir, "index.json"), JSON.stringify({ entries }, null, 2), "utf-8");
}

function makeProposal(overrides: Partial<KnowledgeProposal> = {}): KnowledgeProposal {
  return {
    id: "codegraph-cluster-src-utils",
    kind: "architecture",
    label: "src/utils",
    structuralFacts: { memberCount: 5, fileCount: 3 },
    sourceFiles: [{ path: "src/utils/foo.ts" }],
    ...overrides,
  };
}

describe("writeProposalsFile", () => {
  it("round-trips proposals through readProposals", async () => {
    await withTempDataDir(async () => {
      seedProject();
      const proposals: KnowledgeProposal[] = [
        makeProposal(),
        makeProposal({
          id: "codegraph-god-foo",
          kind: "module",
          label: "foo",
          structuralFacts: { nodeFile: "src/foo.ts", nodeIn: 4, nodeOut: 2 },
          sourceFiles: [{ path: "src/foo.ts" }],
        }),
      ];

      const result = await writeProposalsFile(SLUG, proposals, '{"nodes":[]}');
      expect(result.written).toBe(2);
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);

      const file = await readProposals(SLUG);
      expect(file).not.toBeNull();
      expect(file?.version).toBe(1);
      expect(file?.graphFingerprint).toBe(result.fingerprint);
      expect(file?.proposals).toHaveLength(2);
      const ids = file?.proposals.map((p) => p.id).sort();
      expect(ids).toEqual(["codegraph-cluster-src-utils", "codegraph-god-foo"]);
      // Each proposal carries (possibly empty) suggestedDedupCandidates.
      for (const p of file?.proposals ?? []) {
        expect(Array.isArray(p.suggestedDedupCandidates)).toBe(true);
      }
    });
  });

  it("populates suggestedDedupCandidates when knowledge entries share sourceFiles", async () => {
    await withTempDataDir(async () => {
      seedProject();
      seedKnowledgeIndex([
        {
          id: "existing-pattern",
          normalizedId: "existing-pattern",
          title: "Existing pattern",
          kind: "pattern",
          keywords: [],
          summary: "",
          sourceFiles: [{ path: "src/utils/foo.ts" }],
          file: "knowledge/existing-pattern.md",
          createdAt: "2026-06-02T00:00:00.000Z",
          updatedAt: "2026-06-02T00:00:00.000Z",
        },
      ]);

      const proposals: KnowledgeProposal[] = [
        makeProposal({ sourceFiles: [{ path: "src/utils/foo.ts" }] }),
      ];

      await writeProposalsFile(SLUG, proposals, '{"nodes":[]}');

      const file = await readProposals(SLUG);
      expect(file?.proposals[0]?.suggestedDedupCandidates).toEqual([
        { id: "existing-pattern", overlap: ["src/utils/foo.ts"] },
      ]);
    });
  });

  it("writes a valid ProposalsFile when given an empty proposals list", async () => {
    await withTempDataDir(async () => {
      seedProject();

      const result = await writeProposalsFile(SLUG, [], '{"nodes":[]}');
      expect(result.written).toBe(0);
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);

      const file = await readProposals(SLUG);
      expect(file).not.toBeNull();
      expect(file?.proposals).toEqual([]);
      expect(file?.version).toBe(1);
      expect(file?.graphFingerprint).toBe(result.fingerprint);
    });
  });

  it("produces different fingerprints for different graph.json contents", async () => {
    await withTempDataDir(async () => {
      seedProject();
      const a = await writeProposalsFile(SLUG, [], '{"nodes":[],"links":[]}');
      const b = await writeProposalsFile(SLUG, [], '{"nodes":[{"id":"n1"}]}');
      expect(a.fingerprint).not.toBe(b.fingerprint);
    });
  });

  it("preserves existing proposals not present in the new extraction (merge semantics)", async () => {
    await withTempDataDir(async () => {
      seedProject();

      // First sync: writes 2 proposals.
      await writeProposalsFile(
        SLUG,
        [
          makeProposal({ id: "codegraph-cluster-old-a", label: "old-a" }),
          makeProposal({ id: "codegraph-cluster-old-b", label: "old-b" }),
        ],
        '{"nodes":[]}',
      );

      // Simulate a backfill or an agent decision that left a proposal pending
      // with a different id than what codegraph will produce next time.
      const before = await readProposals(SLUG);
      expect(before?.proposals.map((p) => p.id).sort()).toEqual([
        "codegraph-cluster-old-a",
        "codegraph-cluster-old-b",
      ]);

      // Second sync: codegraph produces ONE proposal that collides with old-a
      // and one new proposal old-b is gone from this extraction.
      const result = await writeProposalsFile(
        SLUG,
        [
          makeProposal({ id: "codegraph-cluster-old-a", label: "old-a-fresh" }),
          makeProposal({ id: "codegraph-cluster-new-c", label: "new-c" }),
        ],
        '{"nodes":[{"id":"changed"}]}',
      );

      expect(result.written).toBe(2);
      expect(result.preserved).toBe(1); // old-b survived

      const after = await readProposals(SLUG);
      const ids = after?.proposals.map((p) => p.id).sort();
      // old-a (refreshed), old-b (preserved), new-c (added) — three total.
      expect(ids).toEqual([
        "codegraph-cluster-new-c",
        "codegraph-cluster-old-a",
        "codegraph-cluster-old-b",
      ]);
      // Collision winner: the new extraction. old-a should now have label "old-a-fresh".
      const oldA = after?.proposals.find((p) => p.id === "codegraph-cluster-old-a");
      expect(oldA?.label).toBe("old-a-fresh");
    });
  });

  it("preserves backfill-shaped proposals (empty structuralFacts) across re-sync", async () => {
    await withTempDataDir(async () => {
      seedProject();

      // Simulate the post-backfill state: lossy proposals with empty facts.
      await writeProposalsFile(
        SLUG,
        [
          makeProposal({
            id: "codegraph-cluster-backfilled",
            label: "backfilled",
            structuralFacts: {},
          }),
        ],
        "backfill",
      );

      // Next codegraph-sync produces a different proposal entirely.
      await writeProposalsFile(
        SLUG,
        [makeProposal({ id: "codegraph-cluster-fresh", label: "fresh" })],
        '{"nodes":[]}',
      );

      const after = await readProposals(SLUG);
      const ids = after?.proposals.map((p) => p.id).sort();
      // Backfilled proposal survived — agent enrichment work is not lost.
      expect(ids).toEqual(["codegraph-cluster-backfilled", "codegraph-cluster-fresh"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Deterministic anchor → line-range resolution

describe("resolveAnchorRange", () => {
  it("matches whole words only — `foo` never matches inside `foobar`", () => {
    expect(resolveAnchorRange("const foobar = 1;\n", "foo")).toBeNull();

    const range = resolveAnchorRange("const foobar = 1;\nconst foo = 2;\n", "foo");
    expect(range).not.toBeNull();
    expect(range?.matchLine).toBe(2);
    expect(range?.matchCount).toBe(1);
    expect(range?.firstMatch).toBe(false);
  });

  it("resolves the first match on ambiguity and records that it did so", () => {
    const range = resolveAnchorRange("foo();\nfoo();\n", "foo");
    expect(range).not.toBeNull();
    expect(range?.firstMatch).toBe(true);
    expect(range?.matchCount).toBe(2);
    expect(range?.matchLine).toBe(1);
  });

  it("returns null when the anchor is absent", () => {
    expect(resolveAnchorRange("const bar = 1;\n", "foo")).toBeNull();
  });

  it("expands a declaration to its enclosing brace-balanced block", () => {
    const content = [
      "export function outer() {",
      "  const x = 1;",
      "  function foo() {",
      "    return foo_bar;",
      "  }",
      "}",
      "",
    ].join("\n");

    const range = resolveAnchorRange(content, "foo");
    expect(range?.startLine).toBe(1);
    expect(range?.endLine).toBe(6);
    expect(range?.matchLine).toBe(3);
    // `foo_bar` on line 4 is NOT a whole-word match.
    expect(range?.matchCount).toBe(1);
  });

  it("caps the resolved range at DEFAULT_MAX_LINES and keeps the match inside it", () => {
    const lines = ["function big() {"];
    for (let i = 2; i <= 501; i++) lines.push(i === 300 ? "  middle();" : "  x();");
    lines.push("}");

    const range = resolveAnchorRange(`${lines.join("\n")}\n`, "middle");
    expect(range).not.toBeNull();
    if (!range) return;
    expect(range.endLine - range.startLine + 1).toBe(DEFAULT_MAX_LINES);
    expect(range.startLine).toBeLessThanOrEqual(300);
    expect(range.endLine).toBeGreaterThanOrEqual(300);
  });
});

describe("resolveAnchorRef", () => {
  it("reads only the named file and returns a CodeRef", async () => {
    await withTempDataDir(async (dir) => {
      const ws = mkdtempSync(resolve(dir, "ws-"));
      writeFileSync(
        resolve(ws, "sym.ts"),
        "const foobar = 1;\nexport function target() {\n  return 1;\n}\n",
      );

      const ref = await resolveAnchorRef(ws, "sym.ts", "target");
      expect(ref).not.toBeNull();
      expect(ref?.path).toBe("sym.ts");
      expect(ref?.anchor).toBe("target");
      expect(ref?.startLine).toBe(1);
      // content ends with a trailing newline, so the file has 5 lines.
      expect(ref?.endLine).toBe(5);
    });
  });

  it("returns null for an unsafe path, a missing file, and an absent anchor", async () => {
    await withTempDataDir(async (dir) => {
      const ws = mkdtempSync(resolve(dir, "ws-"));
      writeFileSync(resolve(ws, "sym.ts"), "const bar = 1;\n");

      expect(await resolveAnchorRef(ws, "../escape.ts", "bar")).toBeNull();
      expect(await resolveAnchorRef(ws, "nope.ts", "bar")).toBeNull();
      expect(await resolveAnchorRef(ws, "sym.ts", "target")).toBeNull();
    });
  });

  it("records the chosen position on the ref when the match was ambiguous", async () => {
    await withTempDataDir(async (dir) => {
      const ws = mkdtempSync(resolve(dir, "ws-"));
      writeFileSync(resolve(ws, "dup.ts"), "foo();\nfoo();\n");

      const ref = await resolveAnchorRef(ws, "dup.ts", "foo");
      expect(ref?.anchor).toBe("foo (first match at line 1)");
    });
  });
});

describe("writeProposalsFile — anchor resolution", () => {
  it("resolves anchor-only source files to line ranges at write time", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = getProjectDir(SLUG);
      mkdirSync(projectDir, { recursive: true });
      const ws = mkdtempSync(resolve(dir, "ws-"));
      mkdirSync(resolve(ws, "src"), { recursive: true });
      writeFileSync(
        resolve(ws, "src/sym.ts"),
        "const foobar = 1;\nexport function target() {\n  return 1;\n}\n",
      );
      writeFileSync(
        resolve(projectDir, "meta.json"),
        JSON.stringify({ id: SLUG, workspacePaths: [ws] }),
        "utf-8",
      );

      await writeProposalsFile(
        SLUG,
        [makeProposal({ sourceFiles: [{ path: "src/sym.ts", anchor: "target" }] })],
        '{"nodes":[]}',
      );

      const file = await readProposals(SLUG);
      const sf = file?.proposals[0]?.sourceFiles[0] as unknown as {
        path: string;
        anchor?: string;
        startLine?: number;
        endLine?: number;
      };
      expect(sf.path).toBe("src/sym.ts");
      expect(sf.anchor).toBe("target");
      expect(sf.startLine).toBe(1);
      expect(sf.endLine).toBe(5);
    });
  });

  it("leaves anchor-only source files unchanged when no workspace is registered", async () => {
    await withTempDataDir(async () => {
      seedProject();

      await writeProposalsFile(
        SLUG,
        [makeProposal({ sourceFiles: [{ path: "src/sym.ts", anchor: "target" }] })],
        '{"nodes":[]}',
      );

      const file = await readProposals(SLUG);
      const sf = file?.proposals[0]?.sourceFiles[0] as unknown as { startLine?: number };
      expect(sf.startLine).toBeUndefined();
    });
  });

  it("leaves an unresolvable anchor without a range", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = getProjectDir(SLUG);
      mkdirSync(projectDir, { recursive: true });
      const ws = mkdtempSync(resolve(dir, "ws-"));
      writeFileSync(resolve(ws, "sym.ts"), "const bar = 1;\n");
      writeFileSync(
        resolve(projectDir, "meta.json"),
        JSON.stringify({ id: SLUG, workspacePaths: [ws] }),
        "utf-8",
      );

      await writeProposalsFile(
        SLUG,
        [makeProposal({ sourceFiles: [{ path: "sym.ts", anchor: "does-not-exist" }] })],
        '{"nodes":[]}',
      );

      const file = await readProposals(SLUG);
      const sf = file?.proposals[0]?.sourceFiles[0] as unknown as {
        anchor?: string;
        startLine?: number;
      };
      expect(sf.anchor).toBe("does-not-exist");
      expect(sf.startLine).toBeUndefined();
    });
  });
});
