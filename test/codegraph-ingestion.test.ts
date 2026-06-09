import type { SpawnSyncReturns } from "node:child_process";
import * as childProcess from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(childProcess.execSync);
const mockedSpawnSync = vi.mocked(childProcess.spawnSync);

import { ingestGraph } from "../src/utils/codegraph.js";

// ---------------------------------------------------------------------------
// Approach A (PREFERRED): hermetic. Mock node:child_process spawnSync to return
// canned codegraph `--json` payloads, routed by subcommand (args[0]). No real
// binary, no .codegraph index, fully deterministic.
//
// codegraph CLI JSON contract (see knowledge
// "codegraph v0.9.9 CLI --json Output Shapes"):
//   status   --json -> { initialized, nodeCount, edgeCount, fileCount, nodesByKind }
//   files    --json -> [{ path, language, nodeCount, size }]
//   query S  --json -> [{ node: { id, kind, name, filePath, ... }, score }]
//   callers S --json -> { symbol, callers: [{ name, kind, filePath, startLine }] }
//   callees S --json -> { symbol, callees: [{ name, kind, filePath, startLine }] }
// Missing symbol -> plain-text ANSI notice on stdout, exit 0, NO json.
// ---------------------------------------------------------------------------

function spawnJson(payload: unknown): SpawnSyncReturns<string> {
  return {
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
    error: undefined as unknown as Error,
    pid: 1,
    output: [],
    signal: null,
  };
}

function spawnRaw(stdout: string): SpawnSyncReturns<string> {
  return {
    status: 0,
    stdout,
    stderr: "",
    error: undefined as unknown as Error,
    pid: 1,
    output: [],
    signal: null,
  };
}

// Make detectCodegraph() report available.
function stubAvailable() {
  mockedExecSync.mockImplementation((cmd) => {
    if (cmd === "codegraph --version") return "codegraph 0.9.9\n";
    if (cmd === "which codegraph") return "/usr/local/bin/codegraph\n";
    return "";
  });
}

const STATUS = {
  initialized: true,
  nodeCount: 50,
  edgeCount: 80,
  fileCount: 12,
  nodesByKind: { function: 40, class: 10 },
};

/**
 * A workspace with two source dirs each holding 3+ files (→ communities),
 * plus a dominant hub function `getProjectDir` in src/utils/paths.ts that
 * has callers in src/utils AND src/cli (→ cross-module coupling).
 */
const FILES = [
  { path: "src/utils/paths.ts", language: "typescript", nodeCount: 6, size: 1000 },
  { path: "src/utils/storage-utils.ts", language: "typescript", nodeCount: 4, size: 800 },
  { path: "src/utils/errors.ts", language: "typescript", nodeCount: 2, size: 400 },
  { path: "src/cli/index.ts", language: "typescript", nodeCount: 5, size: 900 },
  { path: "src/cli/register.ts", language: "typescript", nodeCount: 3, size: 600 },
  { path: "src/cli/define.ts", language: "typescript", nodeCount: 2, size: 300 },
  // a test file — must be filtered out everywhere.
  { path: "test/paths.test.ts", language: "typescript", nodeCount: 9, size: 1200 },
];

// Function nodes returned by `query <term>`. We key by term (the basename of
// each densest file). The hub is getProjectDir.
const QUERY_BY_TERM: Record<string, Array<{ node: Record<string, unknown>; score: number }>> = {
  paths: [
    {
      node: { id: "u1", kind: "function", name: "getProjectDir", filePath: "src/utils/paths.ts" },
      score: 0.9,
    },
  ],
  "storage-utils": [
    {
      node: {
        id: "u2",
        kind: "function",
        name: "withLock",
        filePath: "src/utils/storage-utils.ts",
      },
      score: 0.5,
    },
  ],
  index: [
    {
      node: { id: "c1", kind: "function", name: "registerCommands", filePath: "src/cli/index.ts" },
      score: 0.4,
    },
  ],
};

// callers/callees keyed by symbol name.
const CALLERS_BY_NAME: Record<string, Array<Record<string, unknown>>> = {
  // getProjectDir is called from utils AND cli (cross-module).
  getProjectDir: [
    { name: "withLock", kind: "function", filePath: "src/utils/storage-utils.ts", startLine: 10 },
    { name: "loadErrors", kind: "function", filePath: "src/utils/errors.ts", startLine: 5 },
    { name: "registerCommands", kind: "function", filePath: "src/cli/index.ts", startLine: 3 },
    { name: "defineCommand", kind: "function", filePath: "src/cli/define.ts", startLine: 7 },
  ],
  withLock: [{ name: "getProjectDir", kind: "function", filePath: "src/utils/paths.ts" }],
  registerCommands: [{ name: "getProjectDir", kind: "function", filePath: "src/utils/paths.ts" }],
};

const CALLEES_BY_NAME: Record<string, Array<Record<string, unknown>>> = {
  getProjectDir: [
    { name: "resolve", kind: "function", filePath: "src/utils/storage-utils.ts" },
    { name: "join", kind: "function", filePath: "src/utils/errors.ts" },
  ],
};

/**
 * Route a codegraph CLI invocation to canned JSON. Unknown / missing symbols
 * return a plain-text ANSI "not found" notice on stdout (exit 0) to model the
 * real binary — ingestGraph MUST treat that as no-data, never throw.
 */
function routeSpawn(_cmd: string, args?: readonly string[]): SpawnSyncReturns<string> {
  const a = args ?? [];
  const sub = a[0];
  switch (sub) {
    case "status":
      return spawnJson(STATUS);
    case "files":
      return spawnJson(FILES);
    case "query": {
      const term = a[1];
      const hits = QUERY_BY_TERM[term] ?? [];
      return spawnJson(hits);
    }
    case "callers": {
      const name = a[1];
      const callers = CALLERS_BY_NAME[name];
      if (!callers) return spawnRaw("\u001b[36mℹ\u001b[0m Symbol not found");
      return spawnJson({ symbol: name, callers });
    }
    case "callees": {
      const name = a[1];
      const callees = CALLEES_BY_NAME[name];
      if (!callees) return spawnRaw("\u001b[36mℹ\u001b[0m Symbol not found");
      return spawnJson({ symbol: name, callees });
    }
    default:
      return spawnRaw("");
  }
}

/**
 * Install a spawnSync router. The cast goes through `unknown` because
 * spawnSync is heavily overloaded (Buffer vs string return); our router only
 * ever produces the string-encoded shape ingestGraph asks for.
 */
function installRouter(fn: (cmd: string, args?: readonly string[]) => SpawnSyncReturns<string>) {
  mockedSpawnSync.mockImplementation(fn as unknown as typeof childProcess.spawnSync);
}

beforeEach(() => {
  vi.clearAllMocks();
  stubAvailable();
  installRouter(routeSpawn);
});

describe("ingestGraph (codegraph CLI, mocked)", () => {
  it("returns empty when codegraph is unavailable", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    const result = ingestGraph("/tmp/ws", "test-slug");
    expect(result.proposals).toEqual([]);
    expect(result.stats.totalProposals).toBe(0);
  });

  it("returns empty when status reports zero nodes", () => {
    installRouter((cmd, args) => {
      if ((args ?? [])[0] === "status") {
        return spawnJson({ ...STATUS, nodeCount: 0 });
      }
      return routeSpawn(cmd, args);
    });
    const result = ingestGraph("/tmp/ws", "test-slug");
    expect(result.proposals).toEqual([]);
    expect(result.stats.totalProposals).toBe(0);
  });

  it("returns empty when status returns a non-JSON notice (no throw)", () => {
    installRouter((cmd, args) => {
      if ((args ?? [])[0] === "status") {
        return spawnRaw("\u001b[36mℹ\u001b[0m not initialized");
      }
      return routeSpawn(cmd, args);
    });
    expect(() => ingestGraph("/tmp/ws", "test-slug")).not.toThrow();
    const result = ingestGraph("/tmp/ws", "test-slug");
    expect(result.proposals).toEqual([]);
  });

  it("does not throw when callers/callees return ANSI not-found notices (treated as no-data)", () => {
    // Only getProjectDir resolves; the rest hit the spawnRaw notice branch.
    expect(() => ingestGraph("/tmp/ws", "test-slug")).not.toThrow();
  });

  it("creates directory-prefix community proposals (≥3 files per prefix)", () => {
    const result = ingestGraph("/tmp/ws", "test-slug");
    const communities = result.proposals.filter((p) => p.id.startsWith("codegraph-cluster-"));
    const labels = communities.map((p) => p.label);
    // src/utils (3 code files) and src/cli (3 code files) both qualify.
    expect(labels).toContain("src/utils");
    expect(labels).toContain("src/cli");
    expect(result.stats.communities).toBe(communities.length);

    const utils = communities.find((p) => p.label === "src/utils");
    expect(utils).toBeDefined();
    expect(utils?.structuralFacts.fileCount).toBe(3);
    expect(utils?.structuralFacts.fileTypeBreakdown).toEqual({ code: 3 });
    expect(utils?.structuralFacts.topFilesByEntityCount?.length).toBeGreaterThan(0);
  });

  it("excludes test files from communities", () => {
    const result = ingestGraph("/tmp/ws", "test-slug");
    for (const p of result.proposals) {
      for (const sf of p.sourceFiles) {
        expect(sf.path).not.toMatch(/^test\//);
        expect(sf.path).not.toMatch(/\.test\./);
      }
    }
  });

  it("produces a god-node proposal with nodeFile/nodeIn/nodeOut/topCallers/topCallees", () => {
    const result = ingestGraph("/tmp/ws", "test-slug");
    const godNodes = result.proposals.filter((p) => p.id.startsWith("codegraph-god-"));
    expect(godNodes.length).toBeGreaterThanOrEqual(1);

    const hub = godNodes.find((p) => p.label === "getProjectDir");
    expect(hub).toBeDefined();
    if (!hub) return;

    const facts = hub.structuralFacts;
    expect(facts.nodeFile).toBe("src/utils/paths.ts");
    expect(facts.nodeIn).toBe(CALLERS_BY_NAME.getProjectDir.length);
    expect(facts.nodeOut).toBe(CALLEES_BY_NAME.getProjectDir.length);
    expect(Array.isArray(facts.topCallers)).toBe(true);
    expect(facts.topCallers?.length).toBeGreaterThan(0);
    expect(Array.isArray(facts.topCallees)).toBe(true);
    expect(facts.topCallees?.length).toBeGreaterThan(0);
    // topCallers / topCallees capped at 5.
    expect(facts.topCallers?.length).toBeLessThanOrEqual(5);
    expect(facts.topCallees?.length).toBeLessThanOrEqual(5);

    expect(result.stats.godNodes).toBe(godNodes.length);
  });

  it("produces a cross-module coupling proposal with relations == ['calls']", () => {
    const result = ingestGraph("/tmp/ws", "test-slug");
    const couplings = result.proposals.filter((p) => p.id.startsWith("codegraph-coupling-"));
    expect(couplings.length).toBeGreaterThanOrEqual(1);

    for (const c of couplings) {
      expect(c.kind).toBe("gotcha");
      expect(c.structuralFacts.relations).toEqual(["calls"]);
      expect(c.structuralFacts.couplingA?.label).toBeDefined();
      expect(c.structuralFacts.couplingB?.label).toBeDefined();
      expect(typeof c.structuralFacts.couplingA?.degree).toBe("number");
    }
    // getProjectDir bridges src/utils ↔ src/cli.
    const labelSet = new Set(
      couplings.flatMap((c) => [
        c.structuralFacts.couplingA?.label,
        c.structuralFacts.couplingB?.label,
      ]),
    );
    expect(labelSet.has("src/utils")).toBe(true);
    expect(labelSet.has("src/cli")).toBe(true);
    expect(result.stats.crossModuleCouplings).toBe(couplings.length);
  });

  it("emits slug-like, unique proposal ids and an accurate stats object", () => {
    const result = ingestGraph("/tmp/ws", "test-slug");
    expect(result.proposals.length).toBeGreaterThan(0);

    const ids = result.proposals.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
    expect(result.stats.totalProposals).toBe(result.proposals.length);
    expect(result.stats.totalProposals).toBeLessThanOrEqual(20);
  });

  it("caps total proposals at 20", () => {
    const result = ingestGraph("/tmp/ws", "test-slug");
    expect(result.proposals.length).toBeLessThanOrEqual(20);
  });
});
