import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

// Mock codegraph so the project-init handler thinks codegraph is available
// and produces proposals — without shelling out to a real binary.
vi.mock("../src/utils/codegraph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/codegraph.js")>();
  return {
    ...actual,
    detectCodegraph: () => ({ available: true, version: "0.9.9", path: "/fake/codegraph" }),
    runIndex: () => ({
      success: true as const,
      status: {
        initialized: true,
        nodeCount: 10,
        edgeCount: 5,
        fileCount: 3,
        nodesByKind: {},
      },
    }),
    ingestGraph: () => ({
      proposals: [
        {
          id: "codegraph-cluster-src-utils",
          kind: "architecture" as const,
          label: "src/utils",
          structuralFacts: { memberCount: 3, fileCount: 2 },
          sourceFiles: [{ path: "src/utils/foo.ts" }],
        },
        {
          id: "codegraph-god-foo-src-foo-ts",
          kind: "module" as const,
          label: "foo",
          structuralFacts: { nodeFile: "src/foo.ts", nodeIn: 4, nodeOut: 2 },
          sourceFiles: [{ path: "src/foo.ts" }],
        },
      ],
      stats: { godNodes: 1, communities: 1, crossModuleCouplings: 0, totalProposals: 2 },
    }),
  };
});

describe("project init — codegraph proposals gate", () => {
  const originalSkipCodegraph = process.env.ARCS_SKIP_CODEGRAPH;
  const originalSkipQuickScan = process.env.ARCS_SKIP_QUICK_SCAN;

  beforeEach(() => {
    // Allow codegraph path to run. withTempDataDir sets this to "1"; override after.
    process.env.ARCS_SKIP_QUICK_SCAN = "1";
  });

  afterEach(() => {
    if (originalSkipCodegraph === undefined) delete process.env.ARCS_SKIP_CODEGRAPH;
    else process.env.ARCS_SKIP_CODEGRAPH = originalSkipCodegraph;
    if (originalSkipQuickScan === undefined) delete process.env.ARCS_SKIP_QUICK_SCAN;
    else process.env.ARCS_SKIP_QUICK_SCAN = originalSkipQuickScan;
  });

  it("writes proposals/codegraph.json (not knowledge/) and returns pending_enrichment envelope", async () => {
    await withTempDataDir(async (dataDir) => {
      // withTempDataDir sets ARCS_SKIP_CODEGRAPH=1 — override for this test.
      process.env.ARCS_SKIP_CODEGRAPH = "0";

      const result = await runCommand("project init", ["demo", "--description=Demo project"]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const data = result.data as {
        slug: string;
        codegraph: {
          proposed: number;
          pending_enrichment?: true;
          hint?: string;
          hooksHint?: string;
        } | null;
      };

      expect(data.codegraph).not.toBeNull();
      expect(data.codegraph?.proposed).toBe(2);
      expect(data.codegraph?.pending_enrichment).toBe(true);
      expect(data.codegraph?.hint).toMatch(/proposal list/);

      // proposals/codegraph.json was written (gated codegraph ingestion).
      const proposalsPath = resolve(dataDir, "projects", "demo", "proposals", "codegraph.json");
      expect(existsSync(proposalsPath)).toBe(true);
      const proposalsFile = JSON.parse(readFileSync(proposalsPath, "utf-8"));
      expect(proposalsFile.version).toBe(1);
      expect(proposalsFile.proposals).toHaveLength(2);
      expect(typeof proposalsFile.graphFingerprint).toBe("string");

      // knowledge/index.json is the seeded empty index — not polluted by codegraph.
      const knowledgeIndexPath = resolve(dataDir, "projects", "demo", "knowledge", "index.json");
      expect(existsSync(knowledgeIndexPath)).toBe(true);
      const knowledgeIndex = JSON.parse(readFileSync(knowledgeIndexPath, "utf-8"));
      expect(knowledgeIndex.entries).toEqual([]);
    });
  });
});
