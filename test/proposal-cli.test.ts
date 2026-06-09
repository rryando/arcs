// ---------------------------------------------------------------------------
// proposal CLI — E2E tests for `proposal list | promote | drop | backfill`
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createKnowledgeEntry, readKnowledgeIndex } from "../src/utils/knowledge-store.js";
import { getProjectDir } from "../src/utils/paths.js";
import {
  type Proposal,
  type ProposalsFile,
  readProposals,
  writeProposals,
} from "../src/utils/proposal-store.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const SLUG = "demo";

function seedProject(): string {
  const dir = getProjectDir(SLUG);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  return dir;
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "graphify-cluster-src-utils",
    kind: "architecture",
    label: "src/utils",
    structuralFacts: { fanIn: 3, fanOut: 5 },
    sourceFiles: [{ path: "src/utils/foo.ts" }, { path: "src/utils/bar.ts", anchor: "doStuff" }],
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

// ---------------------------------------------------------------------------
// proposal list
// ---------------------------------------------------------------------------

describe("proposal list", () => {
  it("returns an empty payload when no proposals file exists", async () => {
    await withTempDataDir(async () => {
      seedProject();
      const result = await runCommand("proposal list", [SLUG]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as ProposalsFile & {
        generatedAt: string | null;
        graphFingerprint: string | null;
      };
      expect(data.version).toBe(1);
      expect(data.generatedAt).toBeNull();
      expect(data.graphFingerprint).toBeNull();
      expect(data.proposals).toEqual([]);
    });
  });

  it("returns the full proposals payload when the file exists", async () => {
    await withTempDataDir(async () => {
      seedProject();
      await writeProposals(SLUG, makeFile([makeProposal()]));

      const result = await runCommand("proposal list", [SLUG]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as ProposalsFile;
      expect(data.version).toBe(1);
      expect(data.generatedAt).toBe("2026-06-02T00:00:00.000Z");
      expect(data.graphFingerprint).toBe("deadbeef");
      expect(data.proposals).toHaveLength(1);
      expect(data.proposals[0]?.id).toBe("graphify-cluster-src-utils");
    });
  });

  it("returns project_not_found when the project does not exist", async () => {
    await withTempDataDir(async () => {
      const result = await runCommand("proposal list", ["does-not-exist"]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("project_not_found");
    });
  });
});

// ---------------------------------------------------------------------------
// proposal promote
// ---------------------------------------------------------------------------

describe("proposal promote", () => {
  it("creates a knowledge entry and removes the proposal", async () => {
    await withTempDataDir(async () => {
      seedProject();
      await writeProposals(SLUG, makeFile([makeProposal()]));

      const result = await runCommand("proposal promote", [
        SLUG,
        "graphify-cluster-src-utils",
        "--title=Storage and graph utility layer",
        "--kind=architecture",
        "--summary=Hub of getProjectDir, task-store, knowledge-store...",
        "--body=## Overview\n\nThis cluster groups the storage layer.",
        "--source-files=src/utils/paths.ts,src/utils/task-store.ts:foo",
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as {
        knowledgeId: string;
        proposalRemoved: boolean;
        merged: boolean;
      };
      expect(data.knowledgeId).toBe("storage-and-graph-utility-layer");
      expect(data.proposalRemoved).toBe(true);
      expect(data.merged).toBe(false);

      // Knowledge entry exists on disk
      const projectDir = getProjectDir(SLUG);
      const metaPath = resolve(
        projectDir,
        "knowledge",
        "storage-and-graph-utility-layer.meta.json",
      );
      expect(existsSync(metaPath)).toBe(true);

      // Proposal was removed from the proposals file
      const after = await readProposals(SLUG);
      expect(after?.proposals).toEqual([]);
    });
  });

  it("appends to an existing entry when --merge-with is supplied", async () => {
    await withTempDataDir(async () => {
      seedProject();
      // Create a target knowledge entry first
      const createResult = await runCommand("knowledge create", [
        SLUG,
        "Existing Architecture Note",
        "--kind=architecture",
        "--body=Original body content.",
      ]);
      expect(createResult.ok).toBe(true);

      await writeProposals(SLUG, makeFile([makeProposal()]));

      const result = await runCommand("proposal promote", [
        SLUG,
        "graphify-cluster-src-utils",
        "--title=Whatever",
        "--kind=architecture",
        "--summary=appended via merge",
        "--body=Appended section content.",
        "--merge-with=existing-architecture-note",
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as {
        knowledgeId: string;
        proposalRemoved: boolean;
        merged: boolean;
      };
      expect(data.knowledgeId).toBe("existing-architecture-note");
      expect(data.merged).toBe(true);
      expect(data.proposalRemoved).toBe(true);

      // Body file should contain the appended section
      const projectDir = getProjectDir(SLUG);
      const bodyPath = resolve(projectDir, "knowledge", "existing-architecture-note.md");
      const body = await readFile(bodyPath, "utf-8");
      expect(body).toContain("Original body content.");
      expect(body).toContain("From codegraph proposal");
      expect(body).toContain("Appended section content.");

      // Proposal removed
      const after = await readProposals(SLUG);
      expect(after?.proposals).toEqual([]);
    });
  });

  it("fails when --merge-with target does not exist", async () => {
    await withTempDataDir(async () => {
      seedProject();
      await writeProposals(SLUG, makeFile([makeProposal()]));

      const result = await runCommand("proposal promote", [
        SLUG,
        "graphify-cluster-src-utils",
        "--title=Whatever",
        "--kind=architecture",
        "--summary=summary",
        "--body=body",
        "--merge-with=no-such-entry",
      ]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("entity_not_found");

      // Proposal still present (no partial mutation)
      const after = await readProposals(SLUG);
      expect(after?.proposals).toHaveLength(1);
    });
  });

  it("fails when proposal id does not exist", async () => {
    await withTempDataDir(async () => {
      seedProject();
      await writeProposals(SLUG, makeFile([makeProposal()]));

      const result = await runCommand("proposal promote", [
        SLUG,
        "no-such-proposal",
        "--title=Whatever",
        "--kind=architecture",
        "--summary=summary",
        "--body=body",
      ]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("not_found");
    });
  });

  it("requires --body, --body-file, or --body-stdin", async () => {
    await withTempDataDir(async () => {
      seedProject();
      await writeProposals(SLUG, makeFile([makeProposal()]));

      const result = await runCommand("proposal promote", [
        SLUG,
        "graphify-cluster-src-utils",
        "--title=Whatever",
        "--kind=architecture",
        "--summary=summary",
      ]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("missing_param");
    });
  });
});

// ---------------------------------------------------------------------------
// proposal drop
// ---------------------------------------------------------------------------

describe("proposal drop", () => {
  it("removes a proposal and echoes the reason", async () => {
    await withTempDataDir(async () => {
      seedProject();
      await writeProposals(SLUG, makeFile([makeProposal()]));

      const result = await runCommand("proposal drop", [
        SLUG,
        "graphify-cluster-src-utils",
        "--reason=non-architectural",
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as {
        proposalId: string;
        removed: boolean;
        reason: string;
      };
      expect(data.proposalId).toBe("graphify-cluster-src-utils");
      expect(data.removed).toBe(true);
      expect(data.reason).toBe("non-architectural");

      const after = await readProposals(SLUG);
      expect(after?.proposals).toEqual([]);
    });
  });

  it("returns not_found when proposal id is unknown", async () => {
    await withTempDataDir(async () => {
      seedProject();
      await writeProposals(SLUG, makeFile([makeProposal()]));

      const result = await runCommand("proposal drop", [SLUG, "no-such-id", "--reason=noise"]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("not_found");

      // Existing proposal untouched
      const after = await readProposals(SLUG);
      expect(after?.proposals).toHaveLength(1);
    });
  });

  it("requires --reason", async () => {
    await withTempDataDir(async () => {
      seedProject();
      await writeProposals(SLUG, makeFile([makeProposal()]));

      const result = await runCommand("proposal drop", [SLUG, "graphify-cluster-src-utils"]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("missing_param");
    });
  });
});

// ---------------------------------------------------------------------------
// proposal backfill
// ---------------------------------------------------------------------------

interface BackfillData {
  scanned: number;
  matched: number;
  byKind: Record<string, number>;
  applied: boolean;
  knowledgeRemoved: string[];
  proposalsAdded: string[];
  skipped: Array<{ id: string; reason: string }>;
  hint?: string;
}

async function seedGraphifyTemplateEntries(projectDir: string): Promise<void> {
  // 1 architecture
  await createKnowledgeEntry(projectDir, {
    id: "architecture-cluster-src-utils",
    title: "Architecture cluster: src/utils",
    kind: "architecture",
    keywords: [],
    summary: "Auto-generated cluster entry.",
    content: "Old graphify body.\n",
    sourceFiles: [{ path: "src/utils/foo.ts" }, { path: "src/utils/bar.ts" }],
  });
  // 1 module
  await createKnowledgeEntry(projectDir, {
    id: "high-connectivity-module-task-store-ts",
    title: "High-connectivity module: task-store.ts",
    kind: "module",
    keywords: [],
    summary: "Auto-generated god-node entry.",
    content: "Old graphify body.\n",
    sourceFiles: [{ path: "src/utils/task-store.ts" }],
  });
  // 1 gotcha
  await createKnowledgeEntry(projectDir, {
    id: "cross-module-coupling-batch-ts-getprojectdir",
    title: "Cross-module coupling: batch.ts ↔ getProjectDir()",
    kind: "gotcha",
    keywords: [],
    summary: "Auto-generated coupling entry.",
    content: "Old graphify body.\n",
    sourceFiles: [
      { path: "src/cli/commands/batch.ts" },
      { path: "src/utils/paths.ts", anchor: "getProjectDir" },
    ],
  });
}

describe("proposal backfill", () => {
  it("returns matched: 0 when no graphify-template entries exist", async () => {
    await withTempDataDir(async () => {
      const dir = seedProject();
      await createKnowledgeEntry(dir, {
        id: "user-authored-note",
        title: "About the architecture cluster pattern",
        kind: "pattern",
        keywords: [],
        summary: "User-authored entry that mentions cluster mid-title.",
        content: "Body.\n",
      });

      const result = await runCommand("proposal backfill", [SLUG]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as BackfillData;
      expect(data.matched).toBe(0);
      expect(data.applied).toBe(false);
      expect(data.byKind).toEqual({});
      expect(data.hint).toContain("Nothing to backfill");

      // No mutations
      const idx = await readKnowledgeIndex(dir);
      expect(idx.entries).toHaveLength(1);
      expect(await readProposals(SLUG)).toBeNull();
    });
  });

  it("dry-run reports matches but makes ZERO mutations", async () => {
    await withTempDataDir(async () => {
      const dir = seedProject();
      await seedGraphifyTemplateEntries(dir);

      const before = await readKnowledgeIndex(dir);
      expect(before.entries).toHaveLength(3);

      const result = await runCommand("proposal backfill", [SLUG]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as BackfillData;
      expect(data.scanned).toBe(3);
      expect(data.matched).toBe(3);
      expect(data.byKind).toEqual({ architecture: 1, module: 1, gotcha: 1 });
      expect(data.applied).toBe(false);
      expect(data.knowledgeRemoved).toEqual([]);
      expect(data.proposalsAdded).toEqual([]);
      expect(data.hint).toContain("--apply");

      // No mutations on disk
      const after = await readKnowledgeIndex(dir);
      expect(after.entries).toHaveLength(3);
      expect(await readProposals(SLUG)).toBeNull();
    });
  });

  it("--apply migrates all 3 kinds: removes knowledge entries and writes proposals", async () => {
    await withTempDataDir(async () => {
      const dir = seedProject();
      await seedGraphifyTemplateEntries(dir);

      const result = await runCommand("proposal backfill", [SLUG, "--apply"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as BackfillData;
      expect(data.matched).toBe(3);
      expect(data.applied).toBe(true);
      expect(data.byKind).toEqual({ architecture: 1, module: 1, gotcha: 1 });
      expect(data.knowledgeRemoved).toHaveLength(3);
      expect(data.proposalsAdded).toHaveLength(3);
      expect(data.skipped).toEqual([]);
      // No "Nothing to backfill" hint when matches were applied.
      expect(data.hint).toBeUndefined();

      // Knowledge index shrunk to zero
      const idx = await readKnowledgeIndex(dir);
      expect(idx.entries).toEqual([]);

      // Proposals file populated, with 3 proposals
      const proposals = await readProposals(SLUG);
      expect(proposals).not.toBeNull();
      if (!proposals) return;
      expect(proposals.proposals).toHaveLength(3);
      const ids = proposals.proposals.map((p) => p.id).sort();
      expect(ids).toEqual([
        "graphify-cluster-src-utils",
        "graphify-coupling-batch-ts-getprojectdir",
        "graphify-godnode-task-store-ts",
      ]);

      // Proposals carry the right kinds and labels
      const cluster = proposals.proposals.find((p) => p.id === "graphify-cluster-src-utils");
      expect(cluster?.kind).toBe("architecture");
      expect(cluster?.label).toBe("src/utils");
      expect(cluster?.structuralFacts).toEqual({});
      expect(cluster?.sourceFiles).toEqual([
        { path: "src/utils/foo.ts" },
        { path: "src/utils/bar.ts" },
      ]);
      expect(cluster?.suggestedDedupCandidates).toEqual([]);

      const godnode = proposals.proposals.find((p) => p.id === "graphify-godnode-task-store-ts");
      expect(godnode?.kind).toBe("module");
      expect(godnode?.label).toBe("task-store.ts");

      const coupling = proposals.proposals.find(
        (p) => p.id === "graphify-coupling-batch-ts-getprojectdir",
      );
      expect(coupling?.kind).toBe("gotcha");
      expect(coupling?.label).toBe("batch.ts ↔ getProjectDir()");
    });
  });

  it("is idempotent — second run finds zero matches", async () => {
    await withTempDataDir(async () => {
      const dir = seedProject();
      await seedGraphifyTemplateEntries(dir);

      const first = await runCommand("proposal backfill", [SLUG, "--apply"]);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect((first.data as BackfillData).matched).toBe(3);

      const second = await runCommand("proposal backfill", [SLUG, "--apply"]);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      const data = second.data as BackfillData;
      expect(data.matched).toBe(0);
      expect(data.applied).toBe(false);
      expect(data.knowledgeRemoved).toEqual([]);
      expect(data.proposalsAdded).toEqual([]);

      // The proposals from the first run remain untouched
      const proposals = await readProposals(SLUG);
      expect(proposals?.proposals).toHaveLength(3);
      // No knowledge entries reappeared
      const idx = await readKnowledgeIndex(dir);
      expect(idx.entries).toEqual([]);
    });
  });

  it("dedups against existing proposals file — duplicates are skipped, not appended", async () => {
    await withTempDataDir(async () => {
      const dir = seedProject();
      // Pre-existing proposal with the same id we'd produce
      await writeProposals(
        SLUG,
        makeFile([
          {
            id: "graphify-cluster-src-utils",
            kind: "architecture",
            label: "pre-existing",
            structuralFacts: { fanIn: 99 },
            sourceFiles: [{ path: "src/utils/old.ts" }],
            suggestedDedupCandidates: [],
          },
        ]),
      );
      // Knowledge entry that would map onto the same id
      await createKnowledgeEntry(dir, {
        id: "architecture-cluster-src-utils",
        title: "Architecture cluster: src/utils",
        kind: "architecture",
        keywords: [],
        summary: "Auto-generated cluster entry.",
        content: "Old graphify body.\n",
        sourceFiles: [{ path: "src/utils/foo.ts" }],
      });

      const result = await runCommand("proposal backfill", [SLUG, "--apply"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as BackfillData;
      expect(data.matched).toBe(1);
      expect(data.applied).toBe(true);
      // Did NOT add the proposal (collision); did NOT remove the knowledge entry.
      expect(data.proposalsAdded).toEqual([]);
      expect(data.knowledgeRemoved).toEqual([]);
      expect(data.skipped).toHaveLength(1);
      expect(data.skipped[0]?.id).toBe("graphify-cluster-src-utils");

      const proposals = await readProposals(SLUG);
      expect(proposals?.proposals).toHaveLength(1);
      // Pre-existing proposal payload preserved.
      expect(proposals?.proposals[0]?.label).toBe("pre-existing");

      // Knowledge entry still present
      const idx = await readKnowledgeIndex(dir);
      expect(idx.entries).toHaveLength(1);
    });
  });

  it("handles missing sourceFiles on the source entry (defaults to empty array)", async () => {
    await withTempDataDir(async () => {
      const dir = seedProject();
      await createKnowledgeEntry(dir, {
        id: "architecture-cluster-tests",
        title: "Architecture cluster: tests",
        kind: "architecture",
        keywords: [],
        summary: "No source files.",
        content: "Body.\n",
        // No sourceFiles passed
      });

      const result = await runCommand("proposal backfill", [SLUG, "--apply"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as BackfillData;
      expect(data.matched).toBe(1);
      expect(data.applied).toBe(true);
      expect(data.proposalsAdded).toHaveLength(1);

      const proposals = await readProposals(SLUG);
      expect(proposals?.proposals[0]?.sourceFiles).toEqual([]);
    });
  });

  it("does NOT match user-authored entries that contain template phrases mid-title", async () => {
    await withTempDataDir(async () => {
      const dir = seedProject();
      // Mid-title containing "Architecture cluster:" — should NOT match.
      await createKnowledgeEntry(dir, {
        id: "user-note",
        title: "About the Architecture cluster: pattern in our codebase",
        kind: "pattern",
        keywords: [],
        summary: "User entry.",
        content: "Body.\n",
      });
      // Anchored prefix — SHOULD match.
      await createKnowledgeEntry(dir, {
        id: "graph-cluster",
        title: "Architecture cluster: src/utils",
        kind: "architecture",
        keywords: [],
        summary: "Graphify entry.",
        content: "Body.\n",
        sourceFiles: [{ path: "src/utils/x.ts" }],
      });

      const result = await runCommand("proposal backfill", [SLUG, "--apply"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as BackfillData;
      expect(data.matched).toBe(1);
      expect(data.proposalsAdded).toEqual(["graphify-cluster-src-utils"]);

      // User entry preserved
      const idx = await readKnowledgeIndex(dir);
      expect(idx.entries).toHaveLength(1);
      expect(idx.entries[0]?.id).toBe("user-note");
    });
  });

  it("does NOT match coupling-prefix without the ↔ separator", async () => {
    await withTempDataDir(async () => {
      const dir = seedProject();
      await createKnowledgeEntry(dir, {
        id: "fake-coupling",
        title: "Cross-module coupling: when to refactor",
        kind: "gotcha",
        keywords: [],
        summary: "User-written advice (no ↔).",
        content: "Body.\n",
      });

      const result = await runCommand("proposal backfill", [SLUG, "--apply"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as BackfillData;
      expect(data.matched).toBe(0);

      const idx = await readKnowledgeIndex(dir);
      expect(idx.entries).toHaveLength(1);
    });
  });

  it("returns project_not_found when the project does not exist", async () => {
    await withTempDataDir(async () => {
      const result = await runCommand("proposal backfill", ["does-not-exist"]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("project_not_found");
    });
  });
});
