import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestGraph } from "../src/utils/graphify.js";

const FIXTURE = resolve(__dirname, "fixtures", "sample-graph.json");

describe("ingestGraph (enriched proposals)", () => {
  it("produces proposals with structuralFacts populated per kind", () => {
    const result = ingestGraph(FIXTURE, "test-slug");
    expect(result.proposals.length).toBeGreaterThan(0);

    for (const p of result.proposals) {
      expect(typeof p.id).toBe("string");
      expect(p.id.length).toBeGreaterThan(0);
      expect(["architecture", "module", "gotcha", "pattern"]).toContain(p.kind);
      expect(typeof p.label).toBe("string");
      expect(p.structuralFacts).toBeDefined();
      expect(Array.isArray(p.sourceFiles)).toBe(true);
    }
  });

  it("filters out document-only clusters", () => {
    const result = ingestGraph(FIXTURE, "test-slug");
    const clusterProposals = result.proposals.filter((p) => p.kind === "architecture");
    const labels = clusterProposals.map((p) => p.label);

    // The "docs" community is document-only and must be excluded.
    expect(labels).not.toContain("docs");

    // The mixed "src/cli" cluster (3 code + 1 document) must be retained.
    expect(labels).toContain("src/cli");
    // The pure-code "src/utils" cluster must be retained.
    expect(labels).toContain("src/utils");
  });

  it("cluster proposals include topHubs, topFilesByEntityCount, fileTypeBreakdown and cross-cluster degrees", () => {
    const result = ingestGraph(FIXTURE, "test-slug");
    const utils = result.proposals.find(
      (p) => p.kind === "architecture" && p.label === "src/utils",
    );
    expect(utils).toBeDefined();
    if (!utils) return;

    const facts = utils.structuralFacts;
    expect(facts.memberCount).toBe(5);
    expect(facts.fileCount).toBe(3);
    expect(facts.fileTypeBreakdown).toEqual({ code: 5 });

    // Top hub is u1 (getProjectDir) with in=4, out=2.
    expect(facts.topHubs).toBeDefined();
    expect(facts.topHubs?.length).toBeGreaterThan(0);
    const topHub = facts.topHubs?.[0];
    expect(topHub?.label).toBe("getProjectDir");
    expect(topHub?.file).toBe("src/utils/paths.ts");
    expect(topHub?.in).toBe(4);
    expect(topHub?.out).toBe(2);

    // Top hubs capped at 3.
    expect(facts.topHubs?.length).toBeLessThanOrEqual(3);

    // topFilesByEntityCount: top 3 — paths.ts (2), storage-utils.ts (2), errors.ts (1).
    expect(facts.topFilesByEntityCount?.length).toBe(3);
    const fileSet = new Set(facts.topFilesByEntityCount?.map((f) => f.file));
    expect(fileSet).toEqual(
      new Set(["src/utils/paths.ts", "src/utils/storage-utils.ts", "src/utils/errors.ts"]),
    );
    const pathsEntry = facts.topFilesByEntityCount?.find((f) => f.file === "src/utils/paths.ts");
    expect(pathsEntry?.count).toBe(2);

    // Cross-cluster degrees: src/utils has 2 outgoing (u1→c1, u1→c2), 0 incoming.
    expect(facts.outgoingToOtherClusters).toBe(2);
    expect(facts.incomingFromOtherClusters).toBe(0);
  });

  it("mixed cluster reports document file_type in breakdown", () => {
    const result = ingestGraph(FIXTURE, "test-slug");
    const cli = result.proposals.find((p) => p.kind === "architecture" && p.label === "src/cli");
    expect(cli).toBeDefined();
    if (!cli) return;
    expect(cli.structuralFacts.fileTypeBreakdown).toEqual({ code: 3, document: 1 });
    expect(cli.structuralFacts.memberCount).toBe(4);
  });

  it("god-node proposals include nodeFile, nodeIn, nodeOut, topCallers, and topCallees", () => {
    const result = ingestGraph(FIXTURE, "test-slug");
    const godNodes = result.proposals.filter((p) => p.kind === "module");
    expect(godNodes.length).toBe(1);

    const god = godNodes[0];
    expect(god.label).toBe("getProjectDir");
    expect(god.structuralFacts.nodeFile).toBe("src/utils/paths.ts");
    expect(god.structuralFacts.nodeIn).toBe(4);
    expect(god.structuralFacts.nodeOut).toBe(2);

    // topCallers: u2..u5 (incoming edges to u1). Top 5 — only 4 exist.
    const callers = god.structuralFacts.topCallers;
    expect(callers).toBeDefined();
    expect(callers?.length).toBe(4);
    const callerLabels = new Set(callers?.map((c) => c.label));
    expect(callerLabels).toEqual(
      new Set(["ArcsError", "withLock", "TASK_PRIORITIES", "resolveDataDir"]),
    );

    // topCallees: c1, c2 (outgoing edges from u1).
    const callees = god.structuralFacts.topCallees;
    expect(callees).toBeDefined();
    expect(callees?.length).toBe(2);
    const calleeLabels = new Set(callees?.map((c) => c.label));
    expect(calleeLabels).toEqual(new Set(["registerCommands", "defineCommand"]));
  });

  it("coupling proposals include couplingA, couplingB, and relations", () => {
    const result = ingestGraph(FIXTURE, "test-slug");
    const couplings = result.proposals.filter((p) => p.kind === "gotcha");
    expect(couplings.length).toBe(2);

    for (const c of couplings) {
      expect(c.structuralFacts.couplingA).toBeDefined();
      expect(c.structuralFacts.couplingB).toBeDefined();
      expect(c.structuralFacts.couplingA?.label).toBeDefined();
      expect(c.structuralFacts.couplingA?.file).toBeDefined();
      expect(typeof c.structuralFacts.couplingA?.degree).toBe("number");
      expect(c.structuralFacts.couplingB?.label).toBeDefined();
      expect(c.structuralFacts.couplingB?.file).toBeDefined();
      expect(typeof c.structuralFacts.couplingB?.degree).toBe("number");
      expect(Array.isArray(c.structuralFacts.relations)).toBe(true);
      expect(c.structuralFacts.relations).toContain("calls");
    }

    // One coupling pairs u1 with c1; the other u1 with c2.
    const couplingLabels = couplings
      .map((c) => {
        const a = c.structuralFacts.couplingA?.label;
        const b = c.structuralFacts.couplingB?.label;
        return [a, b].sort().join("|");
      })
      .sort();
    expect(couplingLabels).toEqual(
      ["defineCommand|getProjectDir", "getProjectDir|registerCommands"].sort(),
    );
  });

  it("each proposal has a stable, slug-like id", () => {
    const result = ingestGraph(FIXTURE, "test-slug");
    const ids = result.proposals.map((p) => p.id);
    // All ids unique.
    expect(new Set(ids).size).toBe(ids.length);
    // All ids are slug-like (lowercase, dash-separated, alphanumeric).
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
    // Cluster ids are prefixed with "graphify-cluster-".
    const clusterIds = result.proposals.filter((p) => p.kind === "architecture").map((p) => p.id);
    for (const id of clusterIds) {
      expect(id.startsWith("graphify-cluster-")).toBe(true);
    }
  });
});
