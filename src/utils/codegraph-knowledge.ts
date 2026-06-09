import type { KnowledgeProposal } from "./codegraph.js";
import {
  annotateDedupCandidates,
  computeGraphFingerprint,
  type Proposal,
  type ProposalsFile,
  readProposals,
  writeProposals,
} from "./proposal-store.js";

/**
 * Convert codegraph ingestion output into the proposals file payload
 * and persist it through `proposal-store.writeProposals()`.
 *
 * Replaces the legacy direct-write path that used to populate
 * `knowledge/index.json` and `knowledge/<id>.md` at ingest time. Codegraph
 * proposals now sit in the proposals gate until a skill-aware host enriches
 * them into durable knowledge entries.
 *
 * Merge semantics: if a proposals file already exists, proposals from the
 * existing file with ids NOT present in the new extraction are preserved.
 * This protects backfilled proposals (with empty structuralFacts) and any
 * other pending entries from being clobbered when codegraph re-runs. The new
 * extraction wins on collisions — a fresh extraction produces fresher facts.
 */
export async function writeProposalsFile(
  slug: string,
  proposals: KnowledgeProposal[],
  graphJsonContent: string,
): Promise<{ written: number; fingerprint: string; preserved: number }> {
  // Map ingestion shape → storage shape. The storage `Proposal` adds an
  // initially-empty `suggestedDedupCandidates`; `annotateDedupCandidates`
  // populates it from the existing knowledge index.
  const draft: Proposal[] = proposals.map((p) => ({
    id: p.id,
    kind: p.kind,
    label: p.label,
    structuralFacts: p.structuralFacts as unknown as Record<string, unknown>,
    sourceFiles: p.sourceFiles,
    suggestedDedupCandidates: [],
  }));

  const annotated = await annotateDedupCandidates(slug, draft);

  // Preserve existing proposals not present in the new extraction. This
  // protects the lossy backfill payload (structuralFacts: {}) and any other
  // pending agent-enrichment work from being silently dropped on the next
  // sync. New extraction wins on id collisions.
  const existing = await readProposals(slug);
  const newIds = new Set(annotated.map((p) => p.id));
  const preserved = existing ? existing.proposals.filter((p) => !newIds.has(p.id)) : [];

  const fingerprint = computeGraphFingerprint(graphJsonContent);

  const payload: ProposalsFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    graphFingerprint: fingerprint,
    proposals: [...annotated, ...preserved],
  };

  await writeProposals(slug, payload);

  return { written: proposals.length, fingerprint, preserved: preserved.length };
}
