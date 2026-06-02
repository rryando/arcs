import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

// Mock graphify so the project-init handler thinks graphify is available
// and produces proposals — without shelling out to a real binary.
vi.mock("../src/utils/graphify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/graphify.js")>();
  return {
    ...actual,
    detectGraphify: () => ({ available: true, version: "0.8.0", path: "/fake/graphify" }),
    runExtraction: (workspacePath: string) => ({
      success: true as const,
      // Path doesn't need to exist — we mock ingestGraph below to bypass parsing.
      // But writeProposalsFile reads it. So we point at our seeded fixture.
      graphJsonPath: resolve(workspacePath, "graphify-out", "graph.json"),
    }),
    ingestGraph: () => ({
      proposals: [
        {
          id: "graphify-cluster-src-utils",
          kind: "architecture" as const,
          label: "src/utils",
          structuralFacts: { memberCount: 3, fileCount: 2 },
          sourceFiles: [{ path: "src/utils/foo.ts" }],
        },
        {
          id: "graphify-god-foo",
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

describe("project init — graphify proposals gate", () => {
  const originalSkipGraphify = process.env.ARCS_SKIP_GRAPHIFY;
  const originalSkipQuickScan = process.env.ARCS_SKIP_QUICK_SCAN;

  beforeEach(() => {
    // Allow graphify path to run. withTempDataDir sets this to "1"; override after.
    process.env.ARCS_SKIP_QUICK_SCAN = "1";
  });

  afterEach(() => {
    if (originalSkipGraphify === undefined) delete process.env.ARCS_SKIP_GRAPHIFY;
    else process.env.ARCS_SKIP_GRAPHIFY = originalSkipGraphify;
    if (originalSkipQuickScan === undefined) delete process.env.ARCS_SKIP_QUICK_SCAN;
    else process.env.ARCS_SKIP_QUICK_SCAN = originalSkipQuickScan;
  });

  it("writes proposals/graphify.json (not knowledge/) and returns pending_enrichment envelope", async () => {
    await withTempDataDir(async (dataDir) => {
      // withTempDataDir sets ARCS_SKIP_GRAPHIFY=1 — override for this test.
      process.env.ARCS_SKIP_GRAPHIFY = "0";

      // Seed a fake graph.json the mocked runExtraction will point at; the
      // handler reads its bytes for fingerprinting via writeProposalsFile.
      const ws = process.cwd();
      const graphifyOutDir = resolve(ws, "graphify-out");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(graphifyOutDir, { recursive: true });
      writeFileSync(
        resolve(graphifyOutDir, "graph.json"),
        JSON.stringify({ nodes: [], links: [] }),
        "utf-8",
      );

      try {
        const result = await runCommand("project init", ["demo", "--description=Demo project"]);

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const data = result.data as {
          slug: string;
          graphify: {
            proposed: number;
            pending_enrichment?: true;
            hint?: string;
            hooksHint?: string;
          } | null;
        };

        expect(data.graphify).not.toBeNull();
        expect(data.graphify?.proposed).toBe(2);
        expect(data.graphify?.pending_enrichment).toBe(true);
        expect(data.graphify?.hint).toMatch(/proposal list/);

        // proposals/graphify.json was written.
        const proposalsPath = resolve(dataDir, "projects", "demo", "proposals", "graphify.json");
        expect(existsSync(proposalsPath)).toBe(true);
        const proposalsFile = JSON.parse(readFileSync(proposalsPath, "utf-8"));
        expect(proposalsFile.version).toBe(1);
        expect(proposalsFile.proposals).toHaveLength(2);
        expect(typeof proposalsFile.graphFingerprint).toBe("string");

        // knowledge/index.json is the seeded empty index — not polluted by graphify.
        const knowledgeIndexPath = resolve(dataDir, "projects", "demo", "knowledge", "index.json");
        expect(existsSync(knowledgeIndexPath)).toBe(true);
        const knowledgeIndex = JSON.parse(readFileSync(knowledgeIndexPath, "utf-8"));
        expect(knowledgeIndex.entries).toEqual([]);
      } finally {
        const { rmSync } = await import("node:fs");
        rmSync(graphifyOutDir, { recursive: true, force: true });
      }
    });
  });
});
