import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeChunk, KnowledgeMeta, PlanMeta } from "../src/utils/project-memory.js";

vi.mock("../src/utils/paths.js", () => ({
  getProjectDir: (slug: string) => `/fake/${slug}`,
}));

vi.mock("../src/utils/project-memory.js", () => ({
  readKnowledgeIndex: vi.fn(),
  readPlanIndex: vi.fn(),
}));

import {
  buildProjectRetrievalIndex,
  chunkFieldText,
  knowledgeToDocument,
  MAX_CHUNK_TEXT_BYTES,
} from "../src/retrieval/index-builder.js";
import { readKnowledgeIndex, readPlanIndex } from "../src/utils/project-memory.js";

const mockReadKnowledge = vi.mocked(readKnowledgeIndex);
const mockReadPlans = vi.mocked(readPlanIndex);

function makeKnowledge(
  overrides: Partial<KnowledgeMeta> & { id: string; title: string },
): KnowledgeMeta {
  return {
    normalizedId: overrides.id,
    kind: "reference",
    keywords: [],
    summary: "",
    file: `knowledge/${overrides.id}.md`,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  } as KnowledgeMeta;
}

function makePlan(overrides: Partial<PlanMeta> & { id: string; title: string }): PlanMeta {
  return {
    normalizedId: overrides.id,
    status: "planned",
    keywords: [],
    summary: "",
    file: `plans/${overrides.id}.md`,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  } as PlanMeta;
}

function makeChunk(overrides: Partial<CodeChunk> & { path: string; snippet: string }): CodeChunk {
  return {
    startLine: 1,
    endLine: 1,
    capturedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildProjectRetrievalIndex", () => {
  it("returns a RetrievalIndex with search methods", async () => {
    mockReadKnowledge.mockResolvedValue({ entries: [] });
    mockReadPlans.mockResolvedValue({ plans: [] });

    const index = await buildProjectRetrievalIndex("test-project");

    expect(index.searchKnowledge).toBeTypeOf("function");
    expect(index.searchPlans).toBeTypeOf("function");
    expect(index.searchAll).toBeTypeOf("function");
  });

  it("searchKnowledge returns scored entries matching query", async () => {
    mockReadKnowledge.mockResolvedValue({
      entries: [
        makeKnowledge({
          id: "k1",
          title: "BM25 search algorithm",
          keywords: ["search", "bm25"],
          summary: "Full text search",
        }),
        makeKnowledge({
          id: "k2",
          title: "Project setup",
          keywords: ["setup"],
          summary: "How to set up",
        }),
      ],
    });
    mockReadPlans.mockResolvedValue({ plans: [] });

    const index = await buildProjectRetrievalIndex("test-project");
    const results = index.searchKnowledge("search algorithm");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("k1");
    expect(results[0].type).toBe("knowledge");
    expect(results[0].title).toBe("BM25 search algorithm");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("searchPlans returns scored entries matching query", async () => {
    mockReadKnowledge.mockResolvedValue({ entries: [] });
    mockReadPlans.mockResolvedValue({
      plans: [
        makePlan({
          id: "p1",
          title: "Implement retrieval",
          keywords: ["retrieval", "search"],
          summary: "Add search feature",
        }),
        makePlan({
          id: "p2",
          title: "Database migration",
          keywords: ["database"],
          summary: "Migrate to postgres",
        }),
      ],
    });

    const index = await buildProjectRetrievalIndex("test-project");
    const results = index.searchPlans("retrieval search");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("p1");
    expect(results[0].type).toBe("plan");
    expect(results[0].title).toBe("Implement retrieval");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("searchAll merges knowledge and plan results sorted by score", async () => {
    mockReadKnowledge.mockResolvedValue({
      entries: [
        makeKnowledge({
          id: "k1",
          title: "Search patterns",
          keywords: ["search"],
          summary: "Search patterns reference",
        }),
      ],
    });
    mockReadPlans.mockResolvedValue({
      plans: [
        makePlan({
          id: "p1",
          title: "Search implementation plan",
          keywords: ["search"],
          summary: "Build search",
        }),
      ],
    });

    const index = await buildProjectRetrievalIndex("test-project");
    const results = index.searchAll("search");

    expect(results.length).toBe(2);
    // Sorted by score desc
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    // Both types present
    const types = results.map((r) => r.type);
    expect(types).toContain("knowledge");
    expect(types).toContain("plan");
  });

  it("searchAll respects limit parameter", async () => {
    mockReadKnowledge.mockResolvedValue({
      entries: [
        makeKnowledge({ id: "k1", title: "Search one", keywords: ["search"] }),
        makeKnowledge({ id: "k2", title: "Search two", keywords: ["search"] }),
      ],
    });
    mockReadPlans.mockResolvedValue({
      plans: [makePlan({ id: "p1", title: "Search plan", keywords: ["search"] })],
    });

    const index = await buildProjectRetrievalIndex("test-project");
    const results = index.searchAll("search", 2);

    expect(results.length).toBe(2);
  });

  it("handles empty knowledge gracefully", async () => {
    mockReadKnowledge.mockResolvedValue({ entries: [] });
    mockReadPlans.mockResolvedValue({
      plans: [makePlan({ id: "p1", title: "Some plan", keywords: ["test"] })],
    });

    const index = await buildProjectRetrievalIndex("test-project");
    const results = index.searchKnowledge("anything");

    expect(results).toEqual([]);
  });

  it("handles empty plans gracefully", async () => {
    mockReadKnowledge.mockResolvedValue({
      entries: [makeKnowledge({ id: "k1", title: "Entry", keywords: ["test"] })],
    });
    mockReadPlans.mockResolvedValue({ plans: [] });

    const index = await buildProjectRetrievalIndex("test-project");
    const results = index.searchPlans("anything");

    expect(results).toEqual([]);
  });

  it("handles non-existent project gracefully (read throws)", async () => {
    mockReadKnowledge.mockRejectedValue(new Error("ENOENT"));
    mockReadPlans.mockRejectedValue(new Error("ENOENT"));

    const index = await buildProjectRetrievalIndex("nonexistent");

    expect(index.searchAll("query")).toEqual([]);
    expect(index.searchKnowledge("query")).toEqual([]);
    expect(index.searchPlans("query")).toEqual([]);
  });

  it("title field has higher weight than summary", async () => {
    mockReadKnowledge.mockResolvedValue({
      entries: [
        makeKnowledge({ id: "k1", title: "Unrelated title", summary: "search term here" }),
        makeKnowledge({ id: "k2", title: "search term here", summary: "Unrelated summary" }),
      ],
    });
    mockReadPlans.mockResolvedValue({ plans: [] });

    const index = await buildProjectRetrievalIndex("test-project");
    const results = index.searchKnowledge("search term");

    // k2 should rank higher because "search term" is in title (weight 3) vs summary (weight 1)
    expect(results[0].id).toBe("k2");
  });

  it("ScoredEntry includes summary from the entry", async () => {
    mockReadKnowledge.mockResolvedValue({
      entries: [
        makeKnowledge({ id: "k1", title: "Test entry", keywords: ["test"], summary: "My summary" }),
      ],
    });
    mockReadPlans.mockResolvedValue({ plans: [] });

    const index = await buildProjectRetrievalIndex("test-project");
    const results = index.searchKnowledge("test");

    expect(results[0].summary).toBe("My summary");
  });
});

describe("knowledge code chunks in the retrieval document", () => {
  it("finds an entry by a term that appears only inside a chunk snippet", async () => {
    mockReadKnowledge.mockResolvedValue({
      entries: [
        makeKnowledge({
          id: "k1",
          title: "Unrelated title",
          summary: "Nothing relevant in the prose",
          codeChunks: [makeChunk({ path: "src/a.ts", snippet: "const zephyrquartz = 1;" })],
        }),
      ],
    });
    mockReadPlans.mockResolvedValue({ plans: [] });

    const index = await buildProjectRetrievalIndex("test-project");
    const results = index.searchKnowledge("zephyrquartz");

    expect(results.map((r) => r.id)).toContain("k1");
  });

  it("finds an entry by a term that appears only in a chunk file path", async () => {
    mockReadKnowledge.mockResolvedValue({
      entries: [
        makeKnowledge({
          id: "k1",
          title: "Unrelated title",
          summary: "Nothing relevant",
          codeChunks: [makeChunk({ path: "src/flibbertigibbet.ts", snippet: "noop" })],
        }),
      ],
    });
    mockReadPlans.mockResolvedValue({ plans: [] });

    const index = await buildProjectRetrievalIndex("test-project");
    const results = index.searchKnowledge("flibbertigibbet");

    expect(results.map((r) => r.id)).toContain("k1");
  });

  it("weights a chunk-path term below a title term", async () => {
    mockReadKnowledge.mockResolvedValue({
      entries: [
        makeKnowledge({ id: "k-title", title: "flibbertigibbet", summary: "" }),
        makeKnowledge({
          id: "k-path",
          title: "Unrelated",
          summary: "Unrelated",
          codeChunks: [makeChunk({ path: "src/flibbertigibbet.ts", snippet: "noop" })],
        }),
      ],
    });
    mockReadPlans.mockResolvedValue({ plans: [] });

    const index = await buildProjectRetrievalIndex("test-project");
    const results = index.searchKnowledge("flibbertigibbet");

    const byId = new Map(results.map((r) => [r.id, r.score]));
    // Path-only entry is still a hit, but the title hit outranks it.
    expect(byId.has("k-path")).toBe(true);
    expect(results[0].id).toBe("k-title");
    expect(byId.get("k-title")!).toBeGreaterThan(byId.get("k-path")!);
  });

  it("produces a byte-identical document for an entry with zero chunks", () => {
    const entry = makeKnowledge({
      id: "k1",
      title: "Fixed fixture",
      keywords: ["alpha", "beta"],
      summary: "A fixed summary",
    });
    // The exact pre-change document shape: only title/keywords/summary.
    const expected = {
      id: "k1",
      fields: { title: "Fixed fixture", keywords: "alpha beta", summary: "A fixed summary" },
    };

    const doc = knowledgeToDocument(entry);
    expect(doc).toEqual(expected);
    expect(JSON.stringify(doc)).toBe(JSON.stringify(expected));
    expect(Object.keys(doc.fields)).toEqual(["title", "keywords", "summary"]);
  });

  it("treats an explicitly empty codeChunks array as no chunks", () => {
    const entry = makeKnowledge({
      id: "k1",
      title: "Fixed",
      keywords: [],
      summary: "",
      codeChunks: [],
    });
    expect(knowledgeToDocument(entry).fields).toEqual({
      title: "Fixed",
      keywords: "",
      summary: "",
    });
  });

  it("orders multiple chunks deterministically by path then startLine", () => {
    const a = makeChunk({ path: "b.ts", startLine: 5, endLine: 6, snippet: "beta" });
    const b = makeChunk({ path: "a.ts", startLine: 9, endLine: 10, snippet: "alpha" });
    const c = makeChunk({ path: "b.ts", startLine: 2, endLine: 3, snippet: "gamma" });

    const text = chunkFieldText([a, b, c]);
    const idxAlpha = text.indexOf("alpha");
    const idxGamma = text.indexOf("gamma");
    const idxBeta = text.indexOf("beta");

    expect(idxAlpha).toBeGreaterThanOrEqual(0);
    expect(idxAlpha).toBeLessThan(idxGamma); // a.ts before b.ts
    expect(idxGamma).toBeLessThan(idxBeta); // b.ts:2 before b.ts:5
    // Order-independent: a shuffled input yields the same field text.
    expect(chunkFieldText([c, b, a])).toBe(text);
  });

  it("caps indexed chunk snippet text so one huge chunk cannot dominate", () => {
    const huge = makeChunk({ path: "src/big.ts", snippet: "dominance ".repeat(50000) });
    const field = chunkFieldText([huge]);

    // The header path is preserved in full; only the snippet is capped.
    const snippetBytes =
      Buffer.byteLength(field, "utf8") - Buffer.byteLength("src/big.ts\n", "utf8");
    expect(snippetBytes).toBeLessThanOrEqual(MAX_CHUNK_TEXT_BYTES);
    // The cap actually truncated the enormous snippet.
    expect(field.length).toBeLessThan(huge.snippet.length);

    // A small chunk is emitted in full alongside its header.
    const small = makeChunk({ path: "src/small.ts", snippet: "tiny" });
    expect(chunkFieldText([small])).toBe("src/small.ts\ntiny");
  });

  it("does not let a capped huge chunk dominate an entry with a small chunk", async () => {
    const hugeChunk = makeChunk({ path: "src/huge.ts", snippet: "bulwark ".repeat(20000) });
    const smallChunk = makeChunk({ path: "src/small.ts", snippet: "bulwark" });
    mockReadKnowledge.mockResolvedValue({
      entries: [
        makeKnowledge({ id: "k-huge", title: "Huge", summary: "", codeChunks: [hugeChunk] }),
        makeKnowledge({ id: "k-small", title: "Small", summary: "", codeChunks: [smallChunk] }),
      ],
    });
    mockReadPlans.mockResolvedValue({ plans: [] });

    const index = await buildProjectRetrievalIndex("test-project");
    const results = index.searchKnowledge("bulwark");

    const hugeField = knowledgeToDocument(
      makeKnowledge({ id: "x", title: "Huge", codeChunks: [hugeChunk] }),
    ).fields.chunks!;
    // The capped huge chunk contributes at most its path plus the byte cap,
    // so it cannot balloon the corpus/index compared with a small chunk.
    const hugeBytes = Buffer.byteLength(hugeField, "utf8");
    expect(hugeBytes).toBeLessThanOrEqual(
      Buffer.byteLength("src/huge.ts\n", "utf8") + MAX_CHUNK_TEXT_BYTES,
    );
    expect(hugeField.length).toBeLessThan(hugeChunk.snippet.length);
    expect(results.map((r) => r.id).sort()).toEqual(["k-huge", "k-small"]);
  });
});
