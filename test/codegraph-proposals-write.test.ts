import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { KnowledgeProposal } from "../src/utils/codegraph.js";
import { writeProposalsFile } from "../src/utils/codegraph-knowledge.js";
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
