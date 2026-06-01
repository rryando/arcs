import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/paths.js", () => ({
  getProjectDir: vi.fn(),
  getDataDir: vi.fn(() => "/tmp/arcs-data"),
}));

import { buildAdjacencyIndex } from "../src/retrieval/graph-builder.js";
import { getProjectDir } from "../src/utils/paths.js";

const mockedGetProjectDir = vi.mocked(getProjectDir);

const tempDirs: string[] = [];

function makeProjectDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "arcs-graph-builder-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function writeKnowledgeIndex(dir: string, entries: Array<Record<string, unknown>>): void {
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "index.json"), { entries });
  for (const entry of entries) {
    writeJson(join(dir, `${entry.normalizedId}.meta.json`), entry);
    writeFileSync(join(dir, `${entry.id}.md`), `# ${entry.title}\n`);
  }
}

function writePlanIndex(dir: string, plans: Array<Record<string, unknown>>): void {
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "index.json"), { plans });
  for (const plan of plans) {
    writeJson(join(dir, `${plan.normalizedId}.meta.json`), plan);
    writeFileSync(join(dir, `${plan.id}.md`), `# ${plan.title}\n`);
  }
}

function writeTaskIndex(dir: string, tasks: Array<Record<string, unknown>>): void {
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "index.json"), { tasks });
}

const KNOWLEDGE_ENTRY = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  normalizedId: id,
  title: `Entry ${id}`,
  kind: "pattern",
  keywords: [] as string[],
  summary: "",
  file: `${id}.md`,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

const PLAN_ENTRY = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  normalizedId: id,
  title: `Plan ${id}`,
  status: "in_progress",
  keywords: [] as string[],
  summary: "",
  file: `${id}.md`,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

const TASK_ENTRY = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  normalizedId: id,
  title: `Task ${id}`,
  status: "backlog",
  priority: "medium",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildAdjacencyIndex", () => {
  it("returns empty graph for non-existent project", async () => {
    mockedGetProjectDir.mockReturnValue("/tmp/nonexistent-arcs-project-xyz");

    const graph = await buildAdjacencyIndex("nonexistent-project-xyz");
    expect(graph.nodes.size).toBe(0);
    expect(graph.edges.size).toBe(0);
    expect(graph.fileIndex.size).toBe(0);
    expect(graph.buildTime).toBeTruthy();
  });

  it("builds knowledge nodes and file nodes from knowledge index", async () => {
    const projectDir = makeProjectDir();
    writeKnowledgeIndex(join(projectDir, "knowledge"), [
      KNOWLEDGE_ENTRY("k1", {
        title: "Auth Pattern",
        keywords: ["auth", "jwt"],
        sourceFiles: [{ path: "src/auth.ts" }],
      }),
    ]);

    mockedGetProjectDir.mockReturnValue(projectDir);
    const graph = await buildAdjacencyIndex("test-slug");

    expect(graph.nodes.has("knowledge:k1")).toBe(true);
    expect(graph.nodes.get("knowledge:k1")?.type).toBe("knowledge");
    expect(graph.nodes.get("knowledge:k1")?.title).toBe("Auth Pattern");
    expect(graph.nodes.get("knowledge:k1")?.keywords).toEqual(["auth", "jwt"]);
    expect(graph.nodes.has("file:src/auth.ts")).toBe(true);
    expect(graph.nodes.get("file:src/auth.ts")?.type).toBe("file");

    const edges = graph.edges.get("knowledge:k1") ?? [];
    expect(
      edges.some((e) => e.target === "file:src/auth.ts" && e.relation === "knowledge_touches_file"),
    ).toBe(true);
  });

  it("builds task→plan edges when tasks have planId", async () => {
    const projectDir = makeProjectDir();
    writePlanIndex(join(projectDir, "plans"), [
      PLAN_ENTRY("p1", { title: "Migration Plan", keywords: ["migration"] }),
    ]);
    writeTaskIndex(join(projectDir, "tasks"), [
      TASK_ENTRY("t1", { title: "Do migration step", planId: "p1" }),
    ]);

    mockedGetProjectDir.mockReturnValue(projectDir);
    const graph = await buildAdjacencyIndex("test-slug");

    expect(graph.nodes.has("task:t1")).toBe(true);
    expect(graph.nodes.has("plan:p1")).toBe(true);

    const taskEdges = graph.edges.get("task:t1") ?? [];
    expect(
      taskEdges.some((e) => e.target === "plan:p1" && e.relation === "task_belongs_to_plan"),
    ).toBe(true);

    const planEdges = graph.edges.get("plan:p1") ?? [];
    expect(
      planEdges.some((e) => e.target === "task:t1" && e.relation === "plan_contains_task"),
    ).toBe(true);
  });

  it("creates shares_source_file edges when 2+ entities reference same file", async () => {
    const projectDir = makeProjectDir();
    writeKnowledgeIndex(join(projectDir, "knowledge"), [
      KNOWLEDGE_ENTRY("k1", { sourceFiles: [{ path: "src/shared.ts" }] }),
      KNOWLEDGE_ENTRY("k2", { sourceFiles: [{ path: "src/shared.ts" }] }),
    ]);

    mockedGetProjectDir.mockReturnValue(projectDir);
    const graph = await buildAdjacencyIndex("test-slug");

    const k1Edges = graph.edges.get("knowledge:k1") ?? [];
    const k2Edges = graph.edges.get("knowledge:k2") ?? [];
    expect(
      k1Edges.some((e) => e.target === "knowledge:k2" && e.relation === "shares_source_file"),
    ).toBe(true);
    expect(
      k2Edges.some((e) => e.target === "knowledge:k1" && e.relation === "shares_source_file"),
    ).toBe(true);
  });

  it("creates shares_keywords edges for knowledge entries with keyword overlap", async () => {
    const projectDir = makeProjectDir();
    writeKnowledgeIndex(join(projectDir, "knowledge"), [
      KNOWLEDGE_ENTRY("k1", { keywords: ["auth", "jwt", "security"] }),
      KNOWLEDGE_ENTRY("k2", { keywords: ["auth", "security", "oauth"] }),
      KNOWLEDGE_ENTRY("k3", { keywords: ["database", "sql"] }),
    ]);

    mockedGetProjectDir.mockReturnValue(projectDir);
    const graph = await buildAdjacencyIndex("test-slug");

    const k1Edges = graph.edges.get("knowledge:k1") ?? [];
    expect(
      k1Edges.some((e) => e.target === "knowledge:k2" && e.relation === "shares_keywords"),
    ).toBe(true);

    const k3Edges = graph.edges.get("knowledge:k3") ?? [];
    expect(k3Edges.some((e) => e.relation === "shares_keywords")).toBe(false);
  });

  it("fileIndex correctly maps file paths to referencing node IDs", async () => {
    const projectDir = makeProjectDir();
    writeKnowledgeIndex(join(projectDir, "knowledge"), [
      KNOWLEDGE_ENTRY("k1", { sourceFiles: [{ path: "src/foo.ts" }] }),
    ]);
    writeTaskIndex(join(projectDir, "tasks"), [
      TASK_ENTRY("t1", { sourceFiles: [{ path: "src/foo.ts" }] }),
    ]);

    mockedGetProjectDir.mockReturnValue(projectDir);
    const graph = await buildAdjacencyIndex("test-slug");

    const fooRefs = graph.fileIndex.get("src/foo.ts");
    expect(fooRefs).toBeDefined();
    expect(fooRefs).toContain("knowledge:k1");
    expect(fooRefs).toContain("task:t1");
  });
  it("sourceHashes are populated with mtimes", async () => {
    const projectDir = makeProjectDir();
    writeKnowledgeIndex(join(projectDir, "knowledge"), []);
    writePlanIndex(join(projectDir, "plans"), []);
    writeTaskIndex(join(projectDir, "tasks"), []);

    mockedGetProjectDir.mockReturnValue(projectDir);
    const graph = await buildAdjacencyIndex("test-slug");

    expect(graph.sourceHashes.knowledge).toBeGreaterThan(0);
    expect(graph.sourceHashes.plans).toBeGreaterThan(0);
    expect(graph.sourceHashes.tasks).toBeGreaterThan(0);
  });

  it("creates task_blocks_task edges for tasks with dependsOn", async () => {
    const projectDir = makeProjectDir();
    writeTaskIndex(join(projectDir, "tasks"), [
      TASK_ENTRY("t1"),
      TASK_ENTRY("t2", { dependsOn: ["t1"] }),
    ]);

    mockedGetProjectDir.mockReturnValue(projectDir);
    const graph = await buildAdjacencyIndex("test-slug");

    expect(graph.nodes.has("task:t1")).toBe(true);
    expect(graph.nodes.has("task:t2")).toBe(true);

    // Forward: t1 blocks t2
    const t1Edges = graph.edges.get("task:t1") ?? [];
    expect(t1Edges.some((e) => e.target === "task:t2" && e.relation === "task_blocks_task")).toBe(
      true,
    );

    // Reverse: t2 depends on t1
    const t2Edges = graph.edges.get("task:t2") ?? [];
    expect(t2Edges.some((e) => e.target === "task:t1" && e.relation === "task_blocks_task")).toBe(
      true,
    );
  });

  it("task_blocks_task edges have weight 0.95", async () => {
    const projectDir = makeProjectDir();
    writeTaskIndex(join(projectDir, "tasks"), [
      TASK_ENTRY("t1"),
      TASK_ENTRY("t2", { dependsOn: ["t1"] }),
    ]);

    mockedGetProjectDir.mockReturnValue(projectDir);
    const graph = await buildAdjacencyIndex("test-slug");

    const t1Edges = graph.edges.get("task:t1") ?? [];
    const blockEdge = t1Edges.find(
      (e) => e.target === "task:t2" && e.relation === "task_blocks_task",
    );
    expect(blockEdge?.weight).toBe(0.95);
  });

  it("creates dep node even if dep task not in index", async () => {
    const projectDir = makeProjectDir();
    writeTaskIndex(join(projectDir, "tasks"), [TASK_ENTRY("t2", { dependsOn: ["t-external"] })]);

    mockedGetProjectDir.mockReturnValue(projectDir);
    const graph = await buildAdjacencyIndex("test-slug");

    expect(graph.nodes.has("task:t-external")).toBe(true);
    const extEdges = graph.edges.get("task:t-external") ?? [];
    expect(extEdges.some((e) => e.target === "task:t2" && e.relation === "task_blocks_task")).toBe(
      true,
    );
  });
});
