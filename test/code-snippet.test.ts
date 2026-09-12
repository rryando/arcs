import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CodeChunk,
  type CodeRef,
  isChunkStale,
  languageFromPath,
  parseCodeRef,
  readCodeChunk,
} from "../src/utils/code-snippet.js";
import { codeChunkSchema, codeRefSchema, knowledgeMetaSchema } from "../src/utils/json-schemas.js";

const TEN_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

let workspaceRoot: string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "arcs-code-snippet-"));
});

afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

async function makeFile(name: string, content: string): Promise<string> {
  const rel = `fixtures/${name}`;
  await mkdir(join(workspaceRoot, "fixtures"), { recursive: true });
  await writeFile(join(workspaceRoot, rel), content, "utf-8");
  return rel;
}

describe("parseCodeRef", () => {
  it("parses a well-formed path:start-end ref", () => {
    expect(parseCodeRef("src/x.ts:12-34")).toEqual({
      path: "src/x.ts",
      startLine: 12,
      endLine: 34,
    });
  });

  it("parses a single-line range", () => {
    expect(parseCodeRef("a/b.ts:7-7")).toEqual({ path: "a/b.ts", startLine: 7, endLine: 7 });
  });

  it("returns null for malformed refs", () => {
    const malformed = [
      "",
      "src/x.ts",
      "src/x.ts:12",
      "src/x.ts:12-",
      "src/x.ts:-12-34",
      "src/x.ts:12:34",
      "src/x.ts:12-34-56",
      "src/x.ts:34-12",
      "src/x.ts:0-5",
      "src/x.ts:12-0",
      "src/x.ts:abc-def",
      ":12-34",
      "src/x.ts: 12-34",
    ];
    for (const raw of malformed) {
      expect(parseCodeRef(raw), raw).toBeNull();
    }
  });

  it("returns null when the path is whitespace only", () => {
    expect(parseCodeRef("   :1-2")).toBeNull();
  });
});

describe("readCodeChunk", () => {
  it("reads the exact inclusive range", async () => {
    const path = await makeFile("range.ts", TEN_LINES);
    const ref: CodeRef = { path, startLine: 2, endLine: 5 };
    const chunk = (await readCodeChunk(workspaceRoot, ref, { headRev: "abc123" })) as CodeChunk;

    expect(chunk).not.toBeNull();
    expect(chunk.path).toBe(path);
    expect(chunk.startLine).toBe(2);
    expect(chunk.endLine).toBe(5);
    expect(chunk.snippet).toBe("line 2\nline 3\nline 4\nline 5");
    expect(chunk.language).toBe("typescript");
    expect(chunk.headRev).toBe("abc123");
    expect(typeof chunk.capturedAt).toBe("string");
    expect(Number.isNaN(Date.parse(chunk.capturedAt))).toBe(false);
  });

  it("leaves headRev undefined when not supplied", async () => {
    const path = await makeFile("no-rev.ts", TEN_LINES);
    const chunk = await readCodeChunk(workspaceRoot, { path, startLine: 1, endLine: 1 });
    expect(chunk?.headRev).toBeUndefined();
  });

  it("truncates at maxLines", async () => {
    const path = await makeFile("max-lines.ts", TEN_LINES);
    const chunk = await readCodeChunk(
      workspaceRoot,
      { path, startLine: 1, endLine: 10 },
      {
        maxLines: 3,
      },
    );
    expect(chunk?.snippet).toBe("line 1\nline 2\nline 3");
  });

  it("truncates at maxBytes while staying valid", async () => {
    const path = await makeFile("max-bytes.ts", "aaaa\nbbbb\ncccc\ndddd");
    const chunk = await readCodeChunk(
      workspaceRoot,
      { path, startLine: 1, endLine: 4 },
      {
        maxBytes: 6,
      },
    );
    expect(chunk?.snippet).toBe("aaaa\nb");
    expect(Buffer.byteLength(chunk?.snippet ?? "", "utf-8")).toBeLessThanOrEqual(6);
  });

  it("does not split a multi-byte code point when truncating", async () => {
    // "é" is two UTF-8 bytes; a byte cap of 2 must stop before it rather than
    // emit a broken code point.
    const path = await makeFile("utf8.ts", "aé\ncd");
    const chunk = await readCodeChunk(
      workspaceRoot,
      { path, startLine: 1, endLine: 1 },
      {
        maxBytes: 2,
      },
    );
    expect(chunk?.snippet).toBe("a");
  });

  it("returns null for a missing file", async () => {
    expect(
      await readCodeChunk(workspaceRoot, {
        path: "fixtures/does-not-exist.ts",
        startLine: 1,
        endLine: 2,
      }),
    ).toBeNull();
  });

  it("returns null for a span beyond EOF", async () => {
    const path = await makeFile("short.ts", "one\ntwo");
    expect(await readCodeChunk(workspaceRoot, { path, startLine: 1, endLine: 5 })).toBeNull();
    expect(await readCodeChunk(workspaceRoot, { path, startLine: 9, endLine: 10 })).toBeNull();
  });

  it("returns null when the path escapes the workspace root", async () => {
    expect(
      await readCodeChunk(workspaceRoot, { path: "../outside.ts", startLine: 1, endLine: 1 }),
    ).toBeNull();
  });
});

describe("isChunkStale", () => {
  it("is false immediately after capture", async () => {
    const path = await makeFile("stale-ok.ts", "alpha\nbeta\ngamma");
    const chunk = (await readCodeChunk(workspaceRoot, {
      path,
      startLine: 1,
      endLine: 2,
    })) as CodeChunk;
    expect(isChunkStale(workspaceRoot, chunk)).toBe(false);
  });

  it("is true after the underlying lines change", async () => {
    const path = await makeFile("stale-drift.ts", "alpha\nbeta\ngamma");
    const chunk = (await readCodeChunk(workspaceRoot, {
      path,
      startLine: 1,
      endLine: 2,
    })) as CodeChunk;
    await writeFile(join(workspaceRoot, path), "alpha\nCHANGED\ngamma", "utf-8");
    expect(isChunkStale(workspaceRoot, chunk)).toBe(true);
  });

  it("is true when the file is deleted", async () => {
    const path = await makeFile("stale-gone.ts", "alpha\nbeta");
    const chunk = (await readCodeChunk(workspaceRoot, {
      path,
      startLine: 1,
      endLine: 2,
    })) as CodeChunk;
    await unlink(join(workspaceRoot, path));
    expect(isChunkStale(workspaceRoot, chunk)).toBe(true);
  });
});

describe("languageFromPath", () => {
  it("maps known extensions", () => {
    expect(languageFromPath("a.ts")).toBe("typescript");
    expect(languageFromPath("a.tsx")).toBe("typescriptreact");
    expect(languageFromPath("a.js")).toBe("javascript");
    expect(languageFromPath("a.mjs")).toBe("javascript");
    expect(languageFromPath("a.cjs")).toBe("javascript");
    expect(languageFromPath("a.json")).toBe("json");
    expect(languageFromPath("a.md")).toBe("markdown");
    expect(languageFromPath("a.py")).toBe("python");
    expect(languageFromPath("a.sh")).toBe("shell");
    expect(languageFromPath("a.yml")).toBe("yaml");
    expect(languageFromPath("a.yaml")).toBe("yaml");
  });

  it("is case-insensitive and returns undefined for unknown extensions", () => {
    expect(languageFromPath("A.TS")).toBe("typescript");
    expect(languageFromPath("a.unknownext")).toBeUndefined();
    expect(languageFromPath("noext")).toBeUndefined();
  });
});

describe("zod schemas", () => {
  const validChunk: CodeChunk = {
    path: "src/x.ts",
    startLine: 1,
    endLine: 2,
    language: "typescript",
    snippet: "a\nb",
    headRev: "abc",
    capturedAt: "2024-01-01T00:00:00.000Z",
  };

  it("round-trips a valid code chunk", () => {
    expect(codeChunkSchema.parse(validChunk)).toEqual(validChunk);
  });

  it("round-trips a minimal code ref", () => {
    const ref: CodeRef = { path: "src/x.ts", startLine: 3, endLine: 9 };
    expect(codeRefSchema.parse(ref)).toEqual(ref);
  });

  it("rejects malformed chunks", () => {
    expect(() =>
      codeChunkSchema.parse({ path: "x", startLine: 0, endLine: 1, snippet: "", capturedAt: "t" }),
    ).toThrow();
    expect(() =>
      codeChunkSchema.parse({ path: "x", startLine: 5, endLine: 1, snippet: "", capturedAt: "t" }),
    ).toThrow();
    expect(() => codeChunkSchema.parse({ ...validChunk, snippet: 123 })).toThrow();
    expect(() => codeChunkSchema.parse({ ...validChunk, capturedAt: undefined })).toThrow();
  });

  it("rejects a ref with endLine before startLine", () => {
    expect(() => codeRefSchema.parse({ path: "x", startLine: 5, endLine: 1 })).toThrow();
  });

  it("validates knowledge meta without codeChunks (back-compat)", () => {
    const meta = {
      id: "K001",
      normalizedId: "k001",
      title: "t",
      kind: "lesson",
      keywords: ["a"],
      summary: "s",
      file: "k001.md",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    expect(knowledgeMetaSchema.parse(meta)).toEqual(meta);
  });

  it("validates knowledge meta with codeChunks", () => {
    const meta = {
      id: "K002",
      normalizedId: "k002",
      title: "t",
      kind: "lesson",
      keywords: ["a"],
      summary: "s",
      file: "k002.md",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      codeChunks: [validChunk],
    };
    const parsed = knowledgeMetaSchema.parse(meta);
    expect(parsed.codeChunks).toEqual([validChunk]);
  });
});
