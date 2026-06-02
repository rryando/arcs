/**
 * Storage layer for `~/.arcs/projects/<slug>/proposals/graphify.json`.
 *
 * Graphify ingestion writes here (instead of `knowledge/`) so a downstream
 * gate can review proposals before they are promoted into the durable
 * knowledge index. Reads/writes mirror the rest of the storage layer:
 * Zod-validated I/O, atomic writes via `withLock`, descriptive errors.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { invalidFileFormat } from "./errors.js";
import { withLock } from "./file-lock.js";
import { readJsonSafe } from "./json.js";
import { knowledgeIndexSchema, proposalsFileSchema } from "./json-schemas.js";
import { getProjectDir } from "./paths.js";
import { ensureDir, fileExists, writeJson } from "./storage-utils.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProposalKind = "architecture" | "module" | "gotcha" | "pattern";

export interface Proposal {
  id: string;
  kind: ProposalKind;
  label: string;
  /**
   * Structural facts extracted from the graph. Treated permissively here
   * (`Record<string, unknown>`); T007 will define the precise shape.
   */
  structuralFacts: Record<string, unknown>;
  sourceFiles: Array<{ path: string; anchor?: string }>;
  suggestedDedupCandidates: Array<{ id: string; overlap: string[] }>;
}

export interface ProposalsFile {
  version: 1;
  generatedAt: string;
  graphFingerprint: string;
  proposals: Proposal[];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function proposalsDirPath(slug: string): string {
  return join(getProjectDir(slug), "proposals");
}

function proposalsFilePath(slug: string): string {
  return join(proposalsDirPath(slug), "graphify.json");
}

function knowledgeIndexPath(slug: string): string {
  return join(getProjectDir(slug), "knowledge", "index.json");
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/**
 * Read the proposals file. Returns null if it does not exist.
 * Throws an `invalidFileFormat` DagError if the file fails Zod validation.
 */
export async function readProposals(slug: string): Promise<ProposalsFile | null> {
  const filePath = proposalsFilePath(slug);
  if (!(await fileExists(filePath))) {
    return null;
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw invalidFileFormat(
      filePath,
      `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = proposalsFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw invalidFileFormat(filePath, issues);
  }

  return result.data as ProposalsFile;
}

/**
 * Write the proposals file atomically through `withLock`.
 * Validates the payload with Zod before writing; creates `proposals/`
 * if missing; produces 2-space JSON with a trailing newline.
 */
export async function writeProposals(slug: string, data: ProposalsFile): Promise<void> {
  const filePath = proposalsFilePath(slug);
  const dirPath = proposalsDirPath(slug);

  const result = proposalsFileSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw invalidFileFormat(filePath, issues);
  }

  await ensureDir(dirPath);
  await withLock(filePath, async () => {
    await writeJson(filePath, result.data);
  });
}

/**
 * Remove a proposal by id. Returns true if a proposal was removed,
 * false if no proposal with that id existed (or the file does not exist).
 * Idempotent — never throws on a missing target.
 */
export async function removeProposal(slug: string, proposalId: string): Promise<boolean> {
  const filePath = proposalsFilePath(slug);
  if (!(await fileExists(filePath))) {
    return false;
  }

  let removed = false;

  await withLock(filePath, async () => {
    const current = await readProposals(slug);
    if (!current) {
      return;
    }

    const next = current.proposals.filter((p) => p.id !== proposalId);
    if (next.length === current.proposals.length) {
      return;
    }

    removed = true;
    const updated: ProposalsFile = { ...current, proposals: next };
    await writeJson(filePath, updated);
  });

  return removed;
}

// ---------------------------------------------------------------------------
// Dedup-candidate annotation
// ---------------------------------------------------------------------------

/**
 * For each proposal, scan the project's `knowledge/index.json` for entries
 * whose `sourceFiles[].path` overlap with the proposal's `sourceFiles[].path`.
 * Returns proposals with `suggestedDedupCandidates` populated.
 *
 * Pure — does not write anywhere. Caller decides when (and whether) to persist.
 */
export async function annotateDedupCandidates(
  slug: string,
  proposals: Proposal[],
): Promise<Proposal[]> {
  const indexPath = knowledgeIndexPath(slug);
  const rawIndex = await readJsonSafe<unknown>(indexPath);

  const entries: Array<{ id: string; sourceFiles?: Array<{ path: string }> }> = (() => {
    if (!rawIndex) return [];
    const result = knowledgeIndexSchema.safeParse(rawIndex);
    if (!result.success) {
      // A malformed knowledge index is not this module's problem to surface;
      // treat it as "no candidates" so graphify can proceed. Knowledge-store
      // owns the rebuild path.
      return [];
    }
    return result.data.entries;
  })();

  return proposals.map((proposal) => {
    const proposalPaths = new Set(proposal.sourceFiles.map((f) => f.path));
    const candidates: Array<{ id: string; overlap: string[] }> = [];

    for (const entry of entries) {
      if (!entry.sourceFiles || entry.sourceFiles.length === 0) {
        continue;
      }
      const overlap = entry.sourceFiles.map((f) => f.path).filter((p) => proposalPaths.has(p));
      if (overlap.length > 0) {
        candidates.push({ id: entry.id, overlap });
      }
    }

    return { ...proposal, suggestedDedupCandidates: candidates };
  });
}

// ---------------------------------------------------------------------------
// Graph fingerprint
// ---------------------------------------------------------------------------

/**
 * Compute a SHA256 hex digest of the given graph.json content.
 * Deterministic — identical input bytes always produce the same digest.
 */
export function computeGraphFingerprint(graphJsonContent: string): string {
  return createHash("sha256").update(graphJsonContent, "utf-8").digest("hex");
}
