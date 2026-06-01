// ---------------------------------------------------------------------------
// Graph-related commands — related, graph inspect (registry-based)
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { createGraphCache } from "../../retrieval/graph-cache.js";
import { retrieveRelated } from "../../retrieval/graph-retrieval.js";
import { getProjectDir } from "../../utils/paths.js";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  ERROR_CODES,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { failure, success } from "../output-envelope.js";

// ---------------------------------------------------------------------------
// related
// ---------------------------------------------------------------------------

const relatedParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  task: { type: "string", description: "Task ID to find related entities for" },
  plan: { type: "string", description: "Plan ID to find related entities for" },
  knowledge: { type: "string", description: "Knowledge entry ID to find related entities for" },
  limit: { type: "number", description: "Max results to return (default 10)" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "related",
  description: "Find entities related to a task, knowledge entry, or plan via the knowledge graph",
  params: relatedParams,
  handler: handleRelatedCmd,
});

async function handleRelatedCmd(
  params: ParsedParams<typeof relatedParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const taskId = params.task;
  const knowledgeId = params.knowledge;
  const planId = params.plan;

  if (!taskId && !knowledgeId && !planId) {
    return failure(ERROR_CODES.MISSING_PARAM, "One of --task, --knowledge, or --plan is required", {
      usage:
        "arcs related <slug> --task=<id> | --knowledge=<id> | --plan=<id> [--limit=N] [--json]",
    });
  }

  let startNodeId: string;
  if (taskId) {
    startNodeId = `task:${taskId}`;
  } else if (knowledgeId) {
    startNodeId = `knowledge:${knowledgeId}`;
  } else {
    startNodeId = `plan:${planId}`;
  }

  const limit = params.limit ?? 10;
  const results = await retrieveRelated(slug, startNodeId, { limit });

  return success({ related: results });
}

// ---------------------------------------------------------------------------
// graph inspect
// ---------------------------------------------------------------------------

const graphInspectParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "graph inspect",
  description: "Show knowledge graph index statistics for a project",
  params: graphInspectParams,
  handler: handleGraphInspectCmd,
});

async function handleGraphInspectCmd(
  params: ParsedParams<typeof graphInspectParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;

  const projectDir = getProjectDir(slug);
  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`);
  }

  const cache = createGraphCache();
  const index = await cache.getOrBuild(slug);

  const nodeCount = index.nodes.size;

  let edgeCount = 0;
  for (const edgeList of index.edges.values()) {
    edgeCount += edgeList.length;
  }

  const nodesByType: Record<string, number> = {};
  for (const node of index.nodes.values()) {
    nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
  }

  const mostConnectedFiles = [...index.fileIndex.entries()]
    .map(([path, refs]) => ({ path, refs: refs.length }))
    .sort((a, b) => b.refs - a.refs)
    .slice(0, 10);

  // Orphan nodes: no outgoing AND no incoming edges
  const hasConnection = new Set<string>();
  for (const [source, edgeList] of index.edges.entries()) {
    if (edgeList.length > 0) hasConnection.add(source);
    for (const edge of edgeList) {
      hasConnection.add(edge.target);
    }
  }
  const orphanNodes: string[] = [];
  for (const nodeId of index.nodes.keys()) {
    if (!hasConnection.has(nodeId)) orphanNodes.push(nodeId);
  }

  const density = nodeCount > 1 ? edgeCount / (nodeCount * (nodeCount - 1)) : 0;

  return success({
    nodeCount,
    edgeCount,
    nodesByType,
    mostConnectedFiles,
    orphanNodes,
    density: Math.round(density * 1000) / 1000,
  });
}
