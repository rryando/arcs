/**
 * Adapter that builds BM25 retrieval indexes from ARCS project knowledge and plan entries.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getProjectDir } from "../utils/paths.js";
import {
  type KnowledgeMeta,
  type PlanMeta,
  readKnowledgeIndex,
  readPlanIndex,
} from "../utils/project-memory.js";
import type { CodeChunk } from "../utils/storage-utils.js";
import { type Bm25Index, createBm25Index, type Document } from "./bm25.js";

export interface ScoredEntry {
  id: string;
  type: "knowledge" | "plan";
  title: string;
  summary: string;
  score: number;
}

export interface RetrievalIndex {
  searchKnowledge(query: string, limit?: number): ScoredEntry[];
  searchPlans(query: string, limit?: number): ScoredEntry[];
  searchAll(query: string, limit?: number): ScoredEntry[];
}

const retrievalCache = new Map<string, { signature: string; index: RetrievalIndex }>();

async function sourceSignature(projectDir: string): Promise<string | null> {
  const paths = [
    join(projectDir, "knowledge", "index.json"),
    join(projectDir, "plans", "index.json"),
  ];
  const parts = await Promise.all(
    paths.map(async (path) => {
      try {
        const info = await stat(path);
        return `${info.mtimeMs}:${info.size}:${info.ino}`;
      } catch {
        return null;
      }
    }),
  );
  return parts.some((part) => part === null) ? null : parts.join("|");
}

/**
 * BM25 field weights. `title`, `keywords`, and `summary` are the primary
 * signals; `chunks` (captured code evidence, folded in as `path` + `snippet`)
 * is deliberately down-weighted to half of `summary` because chunks are
 * supporting evidence rather than the entry's authored intent. Keeping the
 * chunk weight below `summary` preserves the existing
 * title > keywords > summary ranking.
 */
const FIELD_WEIGHTS = { title: 3, keywords: 2, summary: 1, chunks: 0.5 };

/**
 * Ceiling (in UTF-8 bytes) on the snippet text a single code chunk contributes
 * to the BM25 document field. Chunk snippets are already bounded at capture
 * time (see `DEFAULT_MAX_BYTES` in code-snippet.ts), but this second cap keeps
 * one oversized or pre-existing chunk from dominating the corpus or bloating
 * the on-disk index cache.
 */
export const MAX_CHUNK_TEXT_BYTES = 4096;

/** Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

/**
 * Fold captured code chunks into one string for the BM25 `chunks` field.
 *
 * Chunks are ordered deterministically (by `path`, then `startLine`) so the
 * cached index is reproducible across runs. Each chunk contributes its file
 * `path` and its captured `snippet` (itself capped at `MAX_CHUNK_TEXT_BYTES`),
 * so a query term can match either the path or the source text at the same low
 * `chunks` weight. Returns `""` when there are no chunks, so a chunkless entry
 * gets no `chunks` field and its document is byte-identical to before.
 */
export function chunkFieldText(chunks: readonly CodeChunk[] | undefined): string {
  if (!chunks || chunks.length === 0) return "";
  const ordered = [...chunks].sort((a, b) =>
    a.path === b.path ? a.startLine - b.startLine : a.path < b.path ? -1 : 1,
  );
  const parts: string[] = [];
  for (const chunk of ordered) {
    const snippet = truncateToBytes(chunk.snippet ?? "", MAX_CHUNK_TEXT_BYTES);
    parts.push(snippet.length > 0 ? `${chunk.path}\n${snippet}` : chunk.path);
  }
  return parts.join("\n");
}

/**
 * Build the BM25 document for a knowledge entry. A `chunks` field is added
 * only when the entry actually carries code chunks, keeping chunkless entries
 * byte-identical to the pre-chunk document shape.
 */
export function knowledgeToDocument(entry: KnowledgeMeta): Document {
  const fields: Record<string, string> = {
    title: entry.title,
    keywords: entry.keywords.join(" "),
    summary: entry.summary ?? "",
  };
  const chunks = chunkFieldText(entry.codeChunks);
  if (chunks !== "") fields.chunks = chunks;
  return { id: entry.id, fields };
}

function planToDocument(plan: PlanMeta): Document {
  return {
    id: plan.id,
    fields: {
      title: plan.title,
      keywords: plan.keywords.join(" "),
      summary: plan.summary ?? "",
    },
  };
}

function buildSearchFn(
  index: Bm25Index,
  metaMap: Map<string, { title: string; summary: string; type: "knowledge" | "plan" }>,
): (query: string, limit?: number) => ScoredEntry[] {
  return (query: string, limit = 10): ScoredEntry[] => {
    const results = index.search(query, limit);
    return results.map((r) => {
      const meta = metaMap.get(r.id)!;
      return {
        id: r.id,
        type: meta.type,
        title: meta.title,
        summary: meta.summary,
        score: r.score,
      };
    });
  };
}

/**
 * Builds a retrieval index for a project's knowledge and plan entries.
 * Gracefully returns empty results if the project data cannot be read.
 */
export async function buildProjectRetrievalIndex(slug: string): Promise<RetrievalIndex> {
  const projectDir = getProjectDir(slug);
  const signature = await sourceSignature(projectDir);
  const cached = retrievalCache.get(projectDir);
  if (signature !== null && cached?.signature === signature) return cached.index;

  let knowledgeEntries: KnowledgeMeta[] = [];
  let planEntries: PlanMeta[] = [];

  try {
    const knowledgeIndex = await readKnowledgeIndex(projectDir);
    knowledgeEntries = knowledgeIndex.entries;
  } catch {
    // Graceful: empty knowledge
  }

  try {
    const planIndex = await readPlanIndex(projectDir);
    planEntries = planIndex.plans;
  } catch {
    // Graceful: empty plans
  }

  // Build BM25 indexes
  const knowledgeDocs = knowledgeEntries.map(knowledgeToDocument);
  const planDocs = planEntries.map(planToDocument);

  const knowledgeBm25 = createBm25Index(knowledgeDocs, FIELD_WEIGHTS);
  const planBm25 = createBm25Index(planDocs, FIELD_WEIGHTS);

  // Build meta maps for hydrating results
  const knowledgeMetaMap = new Map<
    string,
    { title: string; summary: string; type: "knowledge" | "plan" }
  >();
  for (const entry of knowledgeEntries) {
    knowledgeMetaMap.set(entry.id, {
      title: entry.title,
      summary: entry.summary ?? "",
      type: "knowledge",
    });
  }

  const planMetaMap = new Map<
    string,
    { title: string; summary: string; type: "knowledge" | "plan" }
  >();
  for (const plan of planEntries) {
    planMetaMap.set(plan.id, { title: plan.title, summary: plan.summary ?? "", type: "plan" });
  }

  const searchKnowledge = buildSearchFn(knowledgeBm25, knowledgeMetaMap);
  const searchPlans = buildSearchFn(planBm25, planMetaMap);

  const searchAll = (query: string, limit = 10): ScoredEntry[] => {
    const knowledgeResults = searchKnowledge(query, limit);
    const planResults = searchPlans(query, limit);
    const merged = [...knowledgeResults, ...planResults];
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, limit);
  };

  const index = { searchKnowledge, searchPlans, searchAll };
  if (signature !== null) retrievalCache.set(projectDir, { signature, index });
  else retrievalCache.delete(projectDir);
  return index;
}
