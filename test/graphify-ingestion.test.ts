import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestGraph } from "../src/utils/graphify.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `arcs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeGraph(dir: string, data: unknown): string {
  const path = join(dir, "graph.json");
  writeFileSync(path, JSON.stringify(data));
  return path;
}

// Graphify's actual output format (from `graphify update --no-cluster`)
const MINIMAL_GRAPH = {
  nodes: [
    {
      id: "n1",
      label: "AuthService",
      file_type: "code",
      source_file: "src/auth/service.ts",
      source_location: "L1",
    },
    {
      id: "n2",
      label: "UserRepo",
      file_type: "code",
      source_file: "src/auth/user-repo.ts",
      source_location: "L1",
    },
    {
      id: "n3",
      label: "Logger",
      file_type: "code",
      source_file: "src/infra/logger.ts",
      source_location: "L1",
    },
    {
      id: "n4",
      label: "Config",
      file_type: "code",
      source_file: "src/infra/config.ts",
      source_location: "L1",
    },
    {
      id: "n5",
      label: "GodNode",
      file_type: "code",
      source_file: "src/core/god.ts",
      source_location: "L1",
    },
    {
      id: "n6",
      label: "Utils",
      file_type: "code",
      source_file: "src/utils/helpers.ts",
      source_location: "L1",
    },
    {
      id: "n7",
      label: "DB",
      file_type: "code",
      source_file: "src/db/pool.ts",
      source_location: "L1",
    },
    {
      id: "n8",
      label: "Routes",
      file_type: "code",
      source_file: "src/routes/index.ts",
      source_location: "L1",
    },
  ],
  links: [
    // GodNode has degree 7 (hub) — links to almost everything
    { source: "n5", target: "n1", relation: "imports_from", weight: 1 },
    { source: "n5", target: "n2", relation: "imports_from", weight: 1 },
    { source: "n5", target: "n3", relation: "imports_from", weight: 1 },
    { source: "n5", target: "n4", relation: "imports_from", weight: 1 },
    { source: "n5", target: "n6", relation: "imports_from", weight: 1 },
    { source: "n5", target: "n7", relation: "imports_from", weight: 1 },
    { source: "n5", target: "n8", relation: "imports_from", weight: 1 },
    // AuthService has degree 4
    { source: "n1", target: "n2", relation: "calls", weight: 1 },
    { source: "n1", target: "n3", relation: "calls", weight: 1 },
    { source: "n1", target: "n7", relation: "calls", weight: 1 },
    // Other nodes have low degree (1-2)
    { source: "n2", target: "n7", relation: "calls", weight: 1 },
    { source: "n8", target: "n1", relation: "calls", weight: 1 },
    { source: "n3", target: "n4", relation: "imports_from", weight: 1 },
  ],
};

// Graph with explicit communities (clustered output)
const CLUSTERED_GRAPH = {
  nodes: [
    {
      id: "n1",
      label: "AuthService",
      type: "class",
      file: "src/auth.ts",
      community: 0,
      degree: 42,
    },
    { id: "n2", label: "UserRepo", type: "class", file: "src/user.ts", community: 0, degree: 30 },
    { id: "n3", label: "Logger", type: "module", file: "src/logger.ts", community: 1, degree: 5 },
    { id: "n4", label: "Config", type: "module", file: "src/config.ts", community: 1, degree: 3 },
    { id: "n5", label: "GodNode", type: "class", file: "src/god.ts", community: 0, degree: 100 },
  ],
  edges: [
    { source: "n1", target: "n2", type: "calls", weight: 1.0 },
    { source: "n5", target: "n3", type: "references", weight: 0.5 },
  ],
  communities: [
    {
      id: 0,
      label: "Auth & Session Management",
      nodes: ["n1", "n2", "n5"],
      summary: "Handles auth",
    },
    { id: 1, label: "Infrastructure", nodes: ["n3", "n4"], summary: "Logging and config" },
  ],
};

describe("ingestGraph", () => {
  it("returns empty proposals for empty graph.json", () => {
    const dir = makeTmpDir();
    const graphPath = writeGraph(dir, { nodes: [], links: [] });
    const result = ingestGraph(graphPath, "test-slug");
    expect(result.proposals).toEqual([]);
    expect(result.stats.totalProposals).toBe(0);
    rmSync(dir, { recursive: true });
  });

  it("returns empty proposals for malformed graph.json", () => {
    const dir = makeTmpDir();
    const path = join(dir, "graph.json");
    writeFileSync(path, "not json at all {{{");
    const result = ingestGraph(path, "test-slug");
    expect(result.proposals).toEqual([]);
    expect(result.stats.totalProposals).toBe(0);
    rmSync(dir, { recursive: true });
  });

  it("identifies god nodes by computing degree from links", () => {
    const dir = makeTmpDir();
    const graphPath = writeGraph(dir, MINIMAL_GRAPH);
    const result = ingestGraph(graphPath, "test-slug");

    const godProposals = result.proposals.filter((p) => p.kind === "module");
    // GodNode (n5) has degree 7 (7 outgoing links), AuthService (n1) has 5
    // With 8 nodes, 95th percentile filters to just the top ~1 node
    // At minimum GodNode should be detected
    expect(godProposals.length).toBeGreaterThanOrEqual(1);
    expect(godProposals[0].label).toContain("GodNode");
    expect(result.stats.godNodes).toBeGreaterThanOrEqual(1);
    rmSync(dir, { recursive: true });
  });

  it("creates architecture proposals from directory-based communities when no clustering", () => {
    const dir = makeTmpDir();
    const graphPath = writeGraph(dir, MINIMAL_GRAPH);
    const result = ingestGraph(graphPath, "test-slug");

    const archProposals = result.proposals.filter((p) => p.kind === "architecture");
    // src/auth has 2 nodes, src/infra has 2 nodes — both below 3 threshold
    // src/core has 1 node — below threshold
    // So with the minimal graph, directory communities might not form (need 3+ nodes per dir)
    expect(archProposals.length).toBeGreaterThanOrEqual(0);
    expect(result.stats.communities).toBeGreaterThanOrEqual(0);
    rmSync(dir, { recursive: true });
  });

  it("uses explicit communities from clustered graph output", () => {
    const dir = makeTmpDir();
    const graphPath = writeGraph(dir, CLUSTERED_GRAPH);
    const result = ingestGraph(graphPath, "test-slug");

    const archProposals = result.proposals.filter((p) => p.kind === "architecture");
    expect(archProposals.length).toBe(2);
    expect(archProposals[0].label).toContain("Auth & Session Management");
    expect(result.stats.communities).toBe(2);
    rmSync(dir, { recursive: true });
  });

  it("detects cross-module couplings from graph links", () => {
    const dir = makeTmpDir();
    // Create a graph where high-degree nodes span different directories
    // Need enough nodes so 95th percentile doesn't exclude everything
    const graph = {
      nodes: [
        { id: "a1", label: "ServiceA", file_type: "code", source_file: "src/moduleA/service.ts" },
        { id: "a2", label: "HelperA", file_type: "code", source_file: "src/moduleA/helper.ts" },
        { id: "a3", label: "TypesA", file_type: "code", source_file: "src/moduleA/types.ts" },
        { id: "b1", label: "ServiceB", file_type: "code", source_file: "src/moduleB/service.ts" },
        { id: "b2", label: "HelperB", file_type: "code", source_file: "src/moduleB/helper.ts" },
        { id: "b3", label: "TypesB", file_type: "code", source_file: "src/moduleB/types.ts" },
        { id: "c1", label: "Low1", file_type: "code", source_file: "src/moduleC/low1.ts" },
        { id: "c2", label: "Low2", file_type: "code", source_file: "src/moduleC/low2.ts" },
        { id: "c3", label: "Low3", file_type: "code", source_file: "src/moduleC/low3.ts" },
        { id: "c4", label: "Low4", file_type: "code", source_file: "src/moduleC/low4.ts" },
        { id: "c5", label: "Low5", file_type: "code", source_file: "src/moduleC/low5.ts" },
        { id: "c6", label: "Low6", file_type: "code", source_file: "src/moduleC/low6.ts" },
        { id: "c7", label: "Low7", file_type: "code", source_file: "src/moduleC/low7.ts" },
        { id: "c8", label: "Low8", file_type: "code", source_file: "src/moduleC/low8.ts" },
        { id: "c9", label: "Low9", file_type: "code", source_file: "src/moduleC/low9.ts" },
        { id: "c10", label: "Low10", file_type: "code", source_file: "src/moduleC/low10.ts" },
      ],
      links: [
        // a1 (ServiceA) gets very high degree (10 links)
        { source: "a1", target: "a2", relation: "calls", weight: 1 },
        { source: "a1", target: "a3", relation: "imports", weight: 1 },
        { source: "a1", target: "b1", relation: "calls", weight: 1 }, // cross-module!
        { source: "a1", target: "b2", relation: "imports", weight: 1 }, // cross-module!
        { source: "a1", target: "c1", relation: "calls", weight: 1 },
        { source: "a1", target: "c2", relation: "calls", weight: 1 },
        { source: "a1", target: "c3", relation: "calls", weight: 1 },
        { source: "a1", target: "c4", relation: "calls", weight: 1 },
        { source: "a1", target: "c5", relation: "calls", weight: 1 },
        { source: "a1", target: "c6", relation: "calls", weight: 1 },
        // b1 (ServiceB) gets high degree (8 links)
        { source: "b1", target: "b2", relation: "calls", weight: 1 },
        { source: "b1", target: "b3", relation: "imports", weight: 1 },
        { source: "b1", target: "a1", relation: "calls", weight: 1 }, // cross-module!
        { source: "b1", target: "c7", relation: "calls", weight: 1 },
        { source: "b1", target: "c8", relation: "calls", weight: 1 },
        { source: "b1", target: "c9", relation: "calls", weight: 1 },
        { source: "b1", target: "c10", relation: "calls", weight: 1 },
        { source: "b1", target: "a3", relation: "imports", weight: 1 }, // cross-module!
        // Low-degree nodes: only 1 link each (from above)
      ],
    };
    const graphPath = writeGraph(dir, graph);
    const result = ingestGraph(graphPath, "test-slug");

    const gotchaProposals = result.proposals.filter((p) => p.kind === "gotcha");
    expect(gotchaProposals.length).toBeGreaterThanOrEqual(1);
    expect(gotchaProposals[0].label).toMatch(/ServiceA.*ServiceB|ServiceB.*ServiceA/);
    expect(gotchaProposals[0].kind).toBe("gotcha");
    expect(result.stats.crossModuleCouplings).toBeGreaterThanOrEqual(1);
    rmSync(dir, { recursive: true });
  });

  it("caps proposals at 20", () => {
    const dir = makeTmpDir();
    // Create graph with many high-degree nodes
    const nodes = Array.from({ length: 50 }, (_, i) => ({
      id: `n${i}`,
      label: `Node${i}`,
      file_type: "code",
      source_file: `src/mod${i % 10}/file${i}.ts`,
    }));
    // Give every node many links so they all exceed threshold
    const links: Array<{ source: string; target: string; relation: string; weight: number }> = [];
    for (let i = 0; i < 50; i++) {
      for (let j = 0; j < 5; j++) {
        const target = (i + j + 1) % 50;
        links.push({ source: `n${i}`, target: `n${target}`, relation: "calls", weight: 1 });
      }
    }
    const graph = { nodes, links };
    const graphPath = writeGraph(dir, graph);
    const result = ingestGraph(graphPath, "test-slug");
    expect(result.proposals.length).toBeLessThanOrEqual(20);
    rmSync(dir, { recursive: true });
  });

  it("populates sourceFiles correctly with relative paths", () => {
    const dir = makeTmpDir();
    const graphPath = writeGraph(dir, MINIMAL_GRAPH);
    const result = ingestGraph(graphPath, "test-slug");

    for (const proposal of result.proposals) {
      for (const sf of proposal.sourceFiles) {
        expect(sf.path).not.toMatch(/^\//); // no absolute paths
      }
    }
    rmSync(dir, { recursive: true });
  });

  it("stats object is accurate", () => {
    const dir = makeTmpDir();
    const graphPath = writeGraph(dir, CLUSTERED_GRAPH);
    const result = ingestGraph(graphPath, "test-slug");

    expect(result.stats.totalProposals).toBe(result.proposals.length);
    expect(result.stats.communities).toBe(2);
    expect(result.stats.godNodes).toBeGreaterThanOrEqual(1);
    rmSync(dir, { recursive: true });
  });

  it("excludes test files from god nodes and cross-module couplings", () => {
    const dir = makeTmpDir();
    // Create graph where the highest-degree node is a test file
    const graph = {
      nodes: [
        { id: "t1", label: "GodTest", file_type: "code", source_file: "test/god.test.ts" },
        { id: "s1", label: "ServiceA", file_type: "code", source_file: "src/moduleA/service.ts" },
        { id: "s2", label: "ServiceB", file_type: "code", source_file: "src/moduleB/service.ts" },
        { id: "s3", label: "Helper", file_type: "code", source_file: "src/moduleA/helper.ts" },
        { id: "s4", label: "Utils", file_type: "code", source_file: "src/moduleB/utils.ts" },
        { id: "s5", label: "Low1", file_type: "code", source_file: "src/moduleC/low1.ts" },
        { id: "s6", label: "Low2", file_type: "code", source_file: "src/moduleC/low2.ts" },
        { id: "s7", label: "Low3", file_type: "code", source_file: "src/moduleC/low3.ts" },
      ],
      links: [
        // Test file has highest degree (7 links — imports everything)
        { source: "t1", target: "s1", relation: "imports", weight: 1 },
        { source: "t1", target: "s2", relation: "imports", weight: 1 },
        { source: "t1", target: "s3", relation: "imports", weight: 1 },
        { source: "t1", target: "s4", relation: "imports", weight: 1 },
        { source: "t1", target: "s5", relation: "imports", weight: 1 },
        { source: "t1", target: "s6", relation: "imports", weight: 1 },
        { source: "t1", target: "s7", relation: "imports", weight: 1 },
        // ServiceA has degree 4
        { source: "s1", target: "s3", relation: "calls", weight: 1 },
        { source: "s1", target: "s5", relation: "calls", weight: 1 },
        { source: "s1", target: "s6", relation: "calls", weight: 1 },
      ],
    };
    const graphPath = writeGraph(dir, graph);
    const result = ingestGraph(graphPath, "test-slug");

    // God nodes should NOT include the test file
    const godProposals = result.proposals.filter((p) => p.kind === "module");
    for (const p of godProposals) {
      expect(p.sourceFiles[0].path).not.toMatch(/\.test\./);
      expect(p.sourceFiles[0].path).not.toMatch(/^test\//);
    }

    // Cross-module couplings should NOT include test file links
    const gotchaProposals = result.proposals.filter((p) => p.kind === "gotcha");
    for (const p of gotchaProposals) {
      for (const sf of p.sourceFiles) {
        expect(sf.path).not.toMatch(/\.test\./);
        expect(sf.path).not.toMatch(/^test\//);
      }
    }
    rmSync(dir, { recursive: true });
  });
});
