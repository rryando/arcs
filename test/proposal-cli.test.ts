// ---------------------------------------------------------------------------
// proposal CLI — E2E tests for `proposal list | promote | drop | backfill`
// (codegraph proposal queue) and `proposal-doc create|list|get|edit|promote`
// (human-in-the-loop proposal docs in the project data dir)
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

/**
 * Seed a project resolvable by `resolveProject` (root-meta registration +
 * project meta.json with workspacePaths) so `proposal-doc` commands can run.
 * `workspacePaths: [""]` mimics a project with no usable workspace path —
 * proposal docs must work via the project data dir alone.
 */
function seedResolvableProject(dataDir: string): string {
  const rootMeta = {
    version: "1.0",
    projects: [{ id: SLUG, name: "Demo Project", status: "active", dependsOn: [] }],
  };
  writeFileSync(resolve(dataDir, "meta.json"), JSON.stringify(rootMeta), "utf-8");

  const dir = getProjectDir(SLUG);
  mkdirSync(dir, { recursive: true });
  const projectMeta = {
    id: SLUG,
    name: "Demo Project",
    description: "A demo project",
    createdAt: "2025-01-01T00:00:00Z",
    workspacePaths: [process.cwd()],
  };
  writeFileSync(resolve(dir, "meta.json"), JSON.stringify(projectMeta), "utf-8");
  return dir;
}

/**
 * Seed a project with no usable workspace path (empty stored path). The
 * resolver still matches it (registered in root meta), but `workspacePath`
 * resolves to "" — proposal docs must succeed via the project data dir.
 */
function seedWorkspacelessProject(dataDir: string): string {
  const rootMeta = {
    version: "1.0",
    projects: [{ id: SLUG, name: "Demo Project", status: "active", dependsOn: [] }],
  };
  writeFileSync(resolve(dataDir, "meta.json"), JSON.stringify(rootMeta), "utf-8");

  const dir = getProjectDir(SLUG);
  mkdirSync(dir, { recursive: true });
  const projectMeta = {
    id: SLUG,
    name: "Demo Project",
    description: "A demo project",
    createdAt: "2025-01-01T00:00:00Z",
    workspacePaths: [""],
  };
  writeFileSync(resolve(dir, "meta.json"), JSON.stringify(projectMeta), "utf-8");
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

// ---------------------------------------------------------------------------
// proposal-doc — human-in-the-loop proposal docs in the project data dir
// ---------------------------------------------------------------------------

function seedProposalDoc(id: string, body: string): string {
  const dir = join(getProjectDir(SLUG), "proposals");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${id}.proposal.md`);
  writeFileSync(filePath, body, "utf-8");
  return filePath;
}

describe("proposal-doc create", () => {
  it("scaffolds a proposal doc under the project data dir without workspace paths", async () => {
    await withTempDataDir(async (dataDir) => {
      seedWorkspacelessProject(dataDir);

      const result = await runCommand("proposal-doc create", [SLUG, "Storage Move Proposal"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { id: string; path: string; fullPath: string };
      expect(data.id).toBe("storage-move-proposal");
      expect(data.path).toBe("proposals/storage-move-proposal.proposal.md");
      expect(data.fullPath).toBe(
        resolve(getProjectDir(SLUG), "proposals", "storage-move-proposal.proposal.md"),
      );
      expect(data.fullPath.startsWith(dataDir)).toBe(true);

      // Template body written with the requested title
      const body = await readFile(data.fullPath, "utf-8");
      expect(body).toContain("# Storage Move Proposal");
    });
  });

  it("scaffolds into the data dir when the project has zero registered workspace paths", async () => {
    await withTempDataDir(async (dataDir) => {
      seedWorkspacelessProject(dataDir);
      // The true workspace-less shape: no paths at all (not just an empty one).
      writeFileSync(
        resolve(getProjectDir(SLUG), "meta.json"),
        JSON.stringify({
          id: SLUG,
          name: "Demo Project",
          description: "A demo project",
          createdAt: "2025-01-01T00:00:00Z",
          workspacePaths: [],
        }),
        "utf-8",
      );

      const result = await runCommand("proposal-doc create", [SLUG, "No Paths Doc"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { path: string; fullPath: string };
      expect(data.path).toBe("proposals/no-paths-doc.proposal.md");
      expect(data.fullPath.startsWith(dataDir)).toBe(true);
    });
  });

  it("dry-run reports the data-dir path shape without writing", async () => {
    await withTempDataDir(async (dataDir) => {
      seedResolvableProject(dataDir);

      const result = await runCommand("proposal-doc create", [SLUG, "Dry Run Doc", "--dry-run"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as {
        dryRun: boolean;
        wouldCreate: { path: string; hasBody: boolean };
      };
      expect(data.dryRun).toBe(true);
      expect(data.wouldCreate.path).toBe("proposals/dry-run-doc.proposal.md");
      expect(existsSync(join(getProjectDir(SLUG), "proposals"))).toBe(false);
    });
  });

  it("fails with create_error when the doc already exists", async () => {
    await withTempDataDir(async (dataDir) => {
      seedResolvableProject(dataDir);
      seedProposalDoc("existing-doc", "# Existing\n");

      const result = await runCommand("proposal-doc create", [SLUG, "Existing Doc"]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("create_error");
      expect(result.message).toContain("proposals/existing-doc.proposal.md");
    });
  });

  it("returns project_not_found for unknown slugs", async () => {
    await withTempDataDir(async () => {
      const result = await runCommand("proposal-doc create", ["nope", "Title"]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("project_not_found");
    });
  });
});

describe("proposal-doc list", () => {
  it("lists pending docs as {id, path} with data-dir-relative paths", async () => {
    await withTempDataDir(async (dataDir) => {
      seedResolvableProject(dataDir);
      seedProposalDoc("beta-doc", "# Beta\n");
      seedProposalDoc("alpha-doc", "# Alpha\n");

      const result = await runCommand("proposal-doc list", [SLUG]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { slug: string; proposals: Array<{ id: string; path: string }> };
      expect(data.proposals).toEqual([
        { id: "alpha-doc", path: "proposals/alpha-doc.proposal.md" },
        { id: "beta-doc", path: "proposals/beta-doc.proposal.md" },
      ]);
    });
  });

  it("never lists the codegraph queue file (cohabitation)", async () => {
    await withTempDataDir(async (dataDir) => {
      seedResolvableProject(dataDir);
      const proposalsDir = join(getProjectDir(SLUG), "proposals");
      mkdirSync(proposalsDir, { recursive: true });
      writeFileSync(
        join(proposalsDir, "codegraph.json"),
        JSON.stringify({ proposals: [] }),
        "utf-8",
      );
      seedProposalDoc("real-doc", "# Real\n");

      const result = await runCommand("proposal-doc list", [SLUG]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { proposals: Array<{ id: string }> };
      expect(data.proposals).toHaveLength(1);
      expect(data.proposals[0]?.id).toBe("real-doc");
    });
  });

  it("returns an empty list when the proposals dir is absent", async () => {
    await withTempDataDir(async (dataDir) => {
      seedWorkspacelessProject(dataDir);

      const result = await runCommand("proposal-doc list", [SLUG]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { proposals: unknown[] };
      expect(data.proposals).toEqual([]);
    });
  });
});

describe("proposal-doc get", () => {
  it("returns a pending doc body with data-dir path shape", async () => {
    await withTempDataDir(async (dataDir) => {
      seedWorkspacelessProject(dataDir);
      seedProposalDoc("my-doc", "# My Doc\n\nBody text.\n");

      const result = await runCommand("proposal-doc get", [SLUG, "my-doc"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { status: string; path: string; body: string };
      expect(data.status).toBe("pending");
      expect(data.path).toBe("proposals/my-doc.proposal.md");
      expect(data.body).toContain("Body text.");
    });
  });

  it("falls back to the accepted doc with status accepted", async () => {
    await withTempDataDir(async (dataDir) => {
      seedResolvableProject(dataDir);
      const proposalsDir = join(getProjectDir(SLUG), "proposals");
      mkdirSync(proposalsDir, { recursive: true });
      writeFileSync(join(proposalsDir, "done-doc.accepted.md"), "# Done\n", "utf-8");

      const result = await runCommand("proposal-doc get", [SLUG, "done-doc"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { status: string; path: string };
      expect(data.status).toBe("accepted");
      expect(data.path).toBe("proposals/done-doc.accepted.md");
    });
  });

  it("fails with entity_not_found when neither file exists", async () => {
    await withTempDataDir(async (dataDir) => {
      seedResolvableProject(dataDir);

      const result = await runCommand("proposal-doc get", [SLUG, "missing-doc"]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("entity_not_found");
    });
  });
});

describe("proposal-doc edit", () => {
  it("replaces the body and reports the data-dir path", async () => {
    await withTempDataDir(async (dataDir) => {
      seedWorkspacelessProject(dataDir);
      seedProposalDoc("editable", "# Editable\n");

      const result = await runCommand("proposal-doc edit", [
        SLUG,
        "editable",
        "--body=Replaced content.",
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { status: string; path: string; bodyLength: number };
      expect(data.status).toBe("pending");
      expect(data.path).toBe("proposals/editable.proposal.md");
      expect(data.bodyLength).toBe("Replaced content.".length);

      const stored = await readFile(
        join(getProjectDir(SLUG), "proposals", "editable.proposal.md"),
        "utf-8",
      );
      expect(stored).toBe("Replaced content.");
    });
  });

  it("dry-run reports the wouldUpdate path shape without writing", async () => {
    await withTempDataDir(async (dataDir) => {
      seedResolvableProject(dataDir);
      seedProposalDoc("dry-edit", "# Dry\n");

      const result = await runCommand("proposal-doc edit", [
        SLUG,
        "dry-edit",
        "--body=New body.",
        "--dry-run",
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { dryRun: boolean; wouldUpdate: { path: string } };
      expect(data.dryRun).toBe(true);
      expect(data.wouldUpdate.path).toBe("proposals/dry-edit.proposal.md");
    });
  });

  it("requires --body, --body-file, or --body-stdin", async () => {
    await withTempDataDir(async (dataDir) => {
      seedResolvableProject(dataDir);

      const result = await runCommand("proposal-doc edit", [SLUG, "any-doc"]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("missing_param");
    });
  });
});

describe("proposal-doc promote", () => {
  it("renames to accepted and returns the planCommand with data-dir paths", async () => {
    await withTempDataDir(async (dataDir) => {
      seedWorkspacelessProject(dataDir);
      seedProposalDoc("promote-me", "# Promote Me\n\nPlan body.\n");

      const result = await runCommand("proposal-doc promote", [SLUG, "promote-me"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as {
        id: string;
        title: string;
        docPath: string;
        planCommand: string;
        recovered?: boolean;
      };
      expect(data.id).toBe("promote-me");
      expect(data.title).toBe("Promote Me");
      expect(data.docPath).toBe("proposals/promote-me.accepted.md");
      expect(data.planCommand).toBe(
        `arcs plan create ${SLUG} "Promote Me" --body-file="${resolve(
          getProjectDir(SLUG),
          "proposals",
          "promote-me.accepted.md",
        )}"`,
      );
      expect(data.recovered).toBeUndefined();

      // .proposal.md renamed away, .accepted.md present
      expect(existsSync(join(getProjectDir(SLUG), "proposals", "promote-me.proposal.md"))).toBe(
        false,
      );
      expect(existsSync(join(getProjectDir(SLUG), "proposals", "promote-me.accepted.md"))).toBe(
        true,
      );
    });
  });

  it("recovers from a completed rename when the derived plan does not exist yet", async () => {
    await withTempDataDir(async (dataDir) => {
      seedResolvableProject(dataDir);
      const proposalsDir = join(getProjectDir(SLUG), "proposals");
      mkdirSync(proposalsDir, { recursive: true });
      // Crash window state: rename done, plan never created
      writeFileSync(
        join(proposalsDir, "crashed-doc.accepted.md"),
        "# Crashed Doc\n\nBody.\n",
        "utf-8",
      );

      const result = await runCommand("proposal-doc promote", [SLUG, "crashed-doc"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { title: string; recovered: boolean; planCommand: string };
      expect(data.recovered).toBe(true);
      expect(data.title).toBe("Crashed Doc");
      expect(data.planCommand).toContain("--body-file=");
    });
  });

  it("does not recover when the derived plan already exists", async () => {
    await withTempDataDir(async (dataDir) => {
      const dir = seedResolvableProject(dataDir);
      const proposalsDir = join(getProjectDir(SLUG), "proposals");
      mkdirSync(proposalsDir, { recursive: true });
      writeFileSync(
        join(proposalsDir, "planned-doc.accepted.md"),
        "# Planned Doc\n\nBody.\n",
        "utf-8",
      );
      // Plan with the id derived from the accepted doc's first H1 — both the
      // index and the per-plan meta file must exist so readPlanIndex does not
      // treat the index as stale and rebuild it as empty.
      const plansDir = join(dir, "plans");
      mkdirSync(plansDir, { recursive: true });
      const planMeta = {
        id: "planned-doc",
        normalizedId: "planned-doc",
        title: "Planned Doc",
        status: "planned",
        keywords: [],
        summary: "",
        file: "plans/planned-doc.md",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      writeFileSync(join(plansDir, "index.json"), JSON.stringify({ plans: [planMeta] }), "utf-8");
      writeFileSync(join(plansDir, "planned-doc.meta.json"), JSON.stringify(planMeta), "utf-8");

      const result = await runCommand("proposal-doc promote", [SLUG, "planned-doc"]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("entity_not_found");
    });
  });

  it("dry-run reports the wouldPromote shape without renaming", async () => {
    await withTempDataDir(async (dataDir) => {
      seedResolvableProject(dataDir);
      seedProposalDoc("dry-promo", "# Dry Promo\n");

      const result = await runCommand("proposal-doc promote", [SLUG, "dry-promo", "--dry-run"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as {
        dryRun: boolean;
        wouldPromote: { title: string; planAction: string };
      };
      expect(data.dryRun).toBe(true);
      expect(data.wouldPromote.title).toBe("Dry Promo");
      expect(data.wouldPromote.planAction).toContain("arcs plan create");
      // No rename happened
      expect(existsSync(join(getProjectDir(SLUG), "proposals", "dry-promo.proposal.md"))).toBe(
        true,
      );
    });
  });

  it("fails when the doc does not exist", async () => {
    await withTempDataDir(async (dataDir) => {
      seedResolvableProject(dataDir);

      const result = await runCommand("proposal-doc promote", [SLUG, "ghost-doc"]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("entity_not_found");
      expect(result.message).toContain("proposals/ghost-doc.proposal.md");
    });
  });
});
