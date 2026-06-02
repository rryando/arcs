import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectDir } from "../src/utils/paths.js";
import {
  annotateDedupCandidates,
  computeGraphFingerprint,
  type Proposal,
  type ProposalsFile,
  readProposals,
  removeProposal,
  writeProposals,
} from "../src/utils/proposal-store.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const SLUG = "demo";

function seedProject(): string {
  const dir = getProjectDir(SLUG);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "graphify-cluster-src-utils",
    kind: "architecture",
    label: "src/utils",
    structuralFacts: { fanIn: 3, fanOut: 5 },
    sourceFiles: [{ path: "src/utils/foo.ts" }],
    suggestedDedupCandidates: [],
    ...overrides,
  };
}

function makeFile(proposals: Proposal[]): ProposalsFile {
  return {
    version: 1,
    generatedAt: "2026-06-02T00:00:00.000Z",
    graphFingerprint: "deadbeef",
    proposals,
  };
}

describe("proposal-store", () => {
  describe("readProposals", () => {
    it("returns null when the file does not exist", async () => {
      await withTempDataDir(async () => {
        seedProject();
        const result = await readProposals(SLUG);
        expect(result).toBeNull();
      });
    });

    it("throws a descriptive error on Zod schema violation", async () => {
      await withTempDataDir(async () => {
        const dir = seedProject();
        const proposalsDir = join(dir, "proposals");
        mkdirSync(proposalsDir, { recursive: true });
        // Missing required fields (proposals, graphFingerprint, generatedAt)
        writeFileSync(join(proposalsDir, "graphify.json"), JSON.stringify({ version: 1 }), "utf-8");

        await expect(readProposals(SLUG)).rejects.toThrow(/proposals|graphify\.json/i);
      });
    });

    it("returns parsed payload for a valid file", async () => {
      await withTempDataDir(async () => {
        seedProject();
        const payload = makeFile([makeProposal()]);
        await writeProposals(SLUG, payload);

        const result = await readProposals(SLUG);
        expect(result).not.toBeNull();
        expect(result?.proposals).toHaveLength(1);
        expect(result?.proposals[0]?.id).toBe("graphify-cluster-src-utils");
      });
    });
  });

  describe("writeProposals", () => {
    it("creates the proposals/ directory if missing and writes 2-space JSON with trailing newline", async () => {
      await withTempDataDir(async () => {
        const dir = seedProject();
        const proposalsDir = join(dir, "proposals");
        expect(existsSync(proposalsDir)).toBe(false);

        const payload = makeFile([makeProposal()]);
        await writeProposals(SLUG, payload);

        const target = join(proposalsDir, "graphify.json");
        expect(existsSync(target)).toBe(true);

        const raw = await readFile(target, "utf-8");
        expect(raw.endsWith("\n")).toBe(true);
        // 2-space indent: a nested key should be indented exactly two spaces
        expect(raw).toContain('\n  "version": 1');
      });
    });

    it("serializes two concurrent writes via the lock", async () => {
      await withTempDataDir(async () => {
        seedProject();

        const a = makeFile([makeProposal({ id: "a", label: "A" })]);
        const b = makeFile([makeProposal({ id: "b", label: "B" })]);

        await Promise.all([writeProposals(SLUG, a), writeProposals(SLUG, b)]);

        const final = await readProposals(SLUG);
        expect(final).not.toBeNull();
        // Whichever wrote last wins; key invariant is that the file is intact
        // (parses) and contains exactly one of the two proposals.
        expect(final?.proposals).toHaveLength(1);
        expect(["a", "b"]).toContain(final?.proposals[0]?.id);

        // No leftover lock file
        const dir = getProjectDir(SLUG);
        expect(existsSync(join(dir, "proposals", "graphify.json.lock"))).toBe(false);
      });
    });
  });

  describe("removeProposal", () => {
    it("is idempotent: returns false when id is absent and does not throw", async () => {
      await withTempDataDir(async () => {
        seedProject();
        const payload = makeFile([makeProposal({ id: "keep-me" })]);
        await writeProposals(SLUG, payload);

        const removed = await removeProposal(SLUG, "does-not-exist");
        expect(removed).toBe(false);

        const after = await readProposals(SLUG);
        expect(after?.proposals).toHaveLength(1);
        expect(after?.proposals[0]?.id).toBe("keep-me");
      });
    });

    it("returns true and drops the proposal when id matches", async () => {
      await withTempDataDir(async () => {
        seedProject();
        const payload = makeFile([makeProposal({ id: "a" }), makeProposal({ id: "b" })]);
        await writeProposals(SLUG, payload);

        const removed = await removeProposal(SLUG, "a");
        expect(removed).toBe(true);

        const after = await readProposals(SLUG);
        expect(after?.proposals.map((p) => p.id)).toEqual(["b"]);
      });
    });

    it("returns false when the proposals file is missing entirely", async () => {
      await withTempDataDir(async () => {
        seedProject();
        const removed = await removeProposal(SLUG, "anything");
        expect(removed).toBe(false);
      });
    });
  });

  describe("annotateDedupCandidates", () => {
    function seedKnowledgeIndex(entries: unknown[]): void {
      const dir = getProjectDir(SLUG);
      const knowledgeDir = join(dir, "knowledge");
      mkdirSync(knowledgeDir, { recursive: true });
      writeFileSync(
        join(knowledgeDir, "index.json"),
        JSON.stringify({ entries }, null, 2),
        "utf-8",
      );
    }

    it("returns proposals with empty suggestedDedupCandidates when knowledge index is empty/missing", async () => {
      await withTempDataDir(async () => {
        seedProject();
        const proposals = [makeProposal({ sourceFiles: [{ path: "src/foo.ts" }] })];
        const result = await annotateDedupCandidates(SLUG, proposals);
        expect(result).toHaveLength(1);
        expect(result[0]?.suggestedDedupCandidates).toEqual([]);
      });
    });

    it("matches a knowledge entry when sourceFiles overlap on a single file", async () => {
      await withTempDataDir(async () => {
        seedProject();
        seedKnowledgeIndex([
          {
            id: "existing-knowledge-id",
            normalizedId: "existing-knowledge-id",
            title: "Existing",
            kind: "pattern",
            keywords: [],
            summary: "",
            sourceFiles: [{ path: "src/foo.ts" }],
            file: "knowledge/existing-knowledge-id.md",
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
          },
        ]);

        const proposals = [makeProposal({ sourceFiles: [{ path: "src/foo.ts" }] })];
        const result = await annotateDedupCandidates(SLUG, proposals);

        expect(result[0]?.suggestedDedupCandidates).toEqual([
          { id: "existing-knowledge-id", overlap: ["src/foo.ts"] },
        ]);
      });
    });

    it("lists all overlapping files when multiple paths match", async () => {
      await withTempDataDir(async () => {
        seedProject();
        seedKnowledgeIndex([
          {
            id: "k1",
            normalizedId: "k1",
            title: "K1",
            kind: "pattern",
            keywords: [],
            summary: "",
            sourceFiles: [
              { path: "src/a.ts" },
              { path: "src/b.ts" },
              { path: "src/c.ts" }, // not in proposal
            ],
            file: "knowledge/k1.md",
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
          },
        ]);

        const proposals = [
          makeProposal({
            sourceFiles: [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/d.ts" }],
          }),
        ];
        const result = await annotateDedupCandidates(SLUG, proposals);

        expect(result[0]?.suggestedDedupCandidates).toHaveLength(1);
        const candidate = result[0]?.suggestedDedupCandidates[0];
        expect(candidate?.id).toBe("k1");
        expect(candidate?.overlap.sort()).toEqual(["src/a.ts", "src/b.ts"]);
      });
    });

    it("never matches a knowledge entry that has no sourceFiles", async () => {
      await withTempDataDir(async () => {
        seedProject();
        seedKnowledgeIndex([
          {
            id: "no-files",
            normalizedId: "no-files",
            title: "No files",
            kind: "pattern",
            keywords: [],
            summary: "",
            file: "knowledge/no-files.md",
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
          },
        ]);

        const proposals = [makeProposal({ sourceFiles: [{ path: "src/foo.ts" }] })];
        const result = await annotateDedupCandidates(SLUG, proposals);
        expect(result[0]?.suggestedDedupCandidates).toEqual([]);
      });
    });
  });

  describe("computeGraphFingerprint", () => {
    it("is deterministic for the same input", () => {
      const a = computeGraphFingerprint('{"hello":"world"}');
      const b = computeGraphFingerprint('{"hello":"world"}');
      expect(a).toBe(b);
      // sha256 hex = 64 chars
      expect(a).toMatch(/^[a-f0-9]{64}$/);
    });

    it("differs for different inputs", () => {
      const a = computeGraphFingerprint('{"hello":"world"}');
      const b = computeGraphFingerprint('{"hello":"there"}');
      expect(a).not.toBe(b);
    });
  });
});
