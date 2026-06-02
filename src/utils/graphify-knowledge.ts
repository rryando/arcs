import type { KnowledgeProposal } from "./graphify.js";
import {
  annotateDedupCandidates,
  computeGraphFingerprint,
  type Proposal,
  type ProposalsFile,
  writeProposals,
} from "./proposal-store.js";

/**
 * Convert graphify ingestion output into a `proposals/graphify.json` payload
 * and persist it through `proposal-store.writeProposals()`.
 *
 * Replaces the legacy direct-write path that used to populate
 * `knowledge/index.json` and `knowledge/<id>.md` at ingest time. Graphify
 * proposals now sit in the proposals gate until a skill-aware host enriches
 * them into durable knowledge entries.
 */
export async function writeProposalsFile(
  slug: string,
  proposals: KnowledgeProposal[],
  graphJsonContent: string,
): Promise<{ written: number; fingerprint: string }> {
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
  const fingerprint = computeGraphFingerprint(graphJsonContent);

  const payload: ProposalsFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    graphFingerprint: fingerprint,
    proposals: annotated,
  };

  await writeProposals(slug, payload);

  return { written: proposals.length, fingerprint };
}
