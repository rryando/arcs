/**
 * Discovery routes: per-project graph (serialized adjacency index),
 * BM25 cross-project search, and codegraph proposal queue actions.
 */

import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { searchAcrossProjects } from "../../retrieval/cross-project-search.js";
import { buildAdjacencyIndex } from "../../retrieval/graph-builder.js";
import type { GraphNode } from "../../retrieval/graph-types.js";
import { DagError } from "../../utils/errors.js";
import { withLock } from "../../utils/file-lock.js";
import {
  createKnowledgeEntry,
  deleteKnowledgeEntry,
  type KnowledgeMeta,
  readKnowledgeIndex,
} from "../../utils/knowledge-store.js";
import { readPlanIndex } from "../../utils/plan-store.js";
import { readProposals, removeProposal } from "../../utils/proposal-store.js";
import { listTasks } from "../../utils/task-store.js";
import { parseBody, requireProjectDir, respond } from "../respond.js";

export const discoveryRoute = new Hono();

// ---------------------------------------------------------------------------
// GET /api/p/:slug/graph — serialized adjacency index, enriched with entity meta
// ---------------------------------------------------------------------------

interface EnrichedNode extends GraphNode {
  kind?: string;
  status?: string;
  priority?: string;
}

discoveryRoute.get("/api/p/:slug/graph", async (c) =>
  respond(c, async () => {
    const slug = c.req.param("slug");
    const projectDir = requireProjectDir(slug);

    const adjacency = await buildAdjacencyIndex(slug);

    const [knowledge, plans, tasks] = await Promise.all([
      readKnowledgeIndex(projectDir).catch(() => ({ entries: [] as KnowledgeMeta[] })),
      readPlanIndex(projectDir).catch(() => ({ plans: [] })),
      listTasks(projectDir).catch(() => []),
    ]);

    const kindByKnowledgeId = new Map(knowledge.entries.map((e) => [e.normalizedId, e.kind]));
    const statusByPlanId = new Map(plans.plans.map((p) => [p.normalizedId, p.status]));
    const taskByNormalizedId = new Map(tasks.map((t) => [t.normalizedId, t]));

    const nodes: EnrichedNode[] = [...adjacency.nodes.values()].map((node) => {
      const sep = node.id.indexOf(":");
      const rawId = sep >= 0 ? node.id.slice(sep + 1) : node.id;
      const enriched: EnrichedNode = { ...node };

      if (node.type === "knowledge") {
        enriched.kind = kindByKnowledgeId.get(rawId);
      } else if (node.type === "plan") {
        enriched.status = statusByPlanId.get(rawId);
      } else if (node.type === "task") {
        const task = taskByNormalizedId.get(rawId);
        enriched.status = task?.status;
        enriched.priority = task?.priority;
      }
      return enriched;
    });

    const edges = [...adjacency.edges.values()].flat();

    return {
      nodes,
      edges,
      buildTime: adjacency.buildTime,
      sourceHashes: adjacency.sourceHashes,
    };
  }),
);

// ---------------------------------------------------------------------------
// GET /api/search?q=... — BM25 search across projects
// ---------------------------------------------------------------------------

discoveryRoute.get("/api/search", async (c) =>
  respond(c, async () => {
    const rawQuery = c.req.query("q") ?? "";
    if (rawQuery.length > 256) {
      throw new DagError("INVALID_QUERY", "Search queries must be 256 characters or fewer");
    }
    const q = rawQuery.trim();
    const slug = c.req.query("slug");
    const kind = c.req.query("kind");
    const limitRaw = Number(c.req.query("limit") ?? "20");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 100) : 20;

    if (q.length < 2) return { results: [], query: q };

    const results = await searchAcrossProjects({
      query: q,
      limit,
      projectSlugs: slug ? [slug] : undefined,
      includeKnowledge: true,
      includePlans: true,
      kind: kind || undefined,
    });

    return { results, query: q };
  }),
);

// ---------------------------------------------------------------------------
// Proposals — list, drop, promote
// ---------------------------------------------------------------------------

discoveryRoute.get("/api/p/:slug/proposals", async (c) =>
  respond(c, async () => {
    const slug = c.req.param("slug");
    requireProjectDir(slug);
    const file = await readProposals(slug);
    return {
      proposals: file?.proposals ?? [],
      generatedAt: file?.generatedAt ?? null,
      graphFingerprint: file?.graphFingerprint ?? null,
    };
  }),
);

discoveryRoute.post("/api/p/:slug/proposals/:id/drop", async (c) =>
  respond(c, async () => {
    const slug = c.req.param("slug");
    requireProjectDir(slug);
    const removed = await removeProposal(slug, c.req.param("id"));
    if (!removed) {
      throw new DagError("ENTITY_NOT_FOUND", `Proposal "${c.req.param("id")}" not found`);
    }
    return { removed: true };
  }),
);

const promoteSchema = z.object({
  title: z.string().min(1).optional(),
  summary: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  content: z.string().optional(),
});

discoveryRoute.post("/api/p/:slug/proposals/:id/promote", async (c) =>
  respond(
    c,
    async () => {
      const slug = c.req.param("slug");
      const projectDir = requireProjectDir(slug);
      const proposalId = c.req.param("id");
      const overrides = await parseBody(c, promoteSchema);

      return withLock(join(projectDir, ".proposal-promotion"), async () => {
        const file = await readProposals(slug);
        const proposal = file?.proposals.find((entry) => entry.id === proposalId);
        if (!proposal) {
          throw new DagError("ENTITY_NOT_FOUND", `Proposal "${proposalId}" not found`);
        }

        const defaultContent = [
          `# ${overrides.title ?? proposal.label}`,
          "",
          "## Structural facts",
          "",
          "```json",
          JSON.stringify(proposal.structuralFacts, null, 2),
          "```",
          "",
          "## Source files",
          "",
          ...proposal.sourceFiles.map(
            (source) => `- \`${source.path}\`${source.anchor ? ` — ${source.anchor}` : ""}`,
          ),
          "",
        ].join("\n");

        const created = await createKnowledgeEntry(projectDir, {
          id: proposal.id,
          title: overrides.title ?? proposal.label,
          kind: proposal.kind,
          keywords: overrides.keywords ?? [],
          summary: overrides.summary ?? "",
          content: overrides.content ?? defaultContent,
          sourceFiles: proposal.sourceFiles,
        });

        try {
          const removed = await removeProposal(slug, proposalId);
          if (!removed) throw new Error(`Proposal "${proposalId}" disappeared during promotion`);
        } catch (error) {
          try {
            await deleteKnowledgeEntry(projectDir, created.normalizedId);
          } catch (rollbackError) {
            throw new DagError(
              "PROMOTION_INCOMPLETE",
              `Proposal promotion created knowledge entry "${created.normalizedId}" but both proposal removal and rollback failed. Delete the knowledge entry or drop the proposal before retrying. Removal error: ${error instanceof Error ? error.message : String(error)}. Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}.`,
            );
          }
          throw error;
        }

        return { promoted: true, entry: created };
      });
    },
    201,
  ),
);
