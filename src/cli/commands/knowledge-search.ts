// ---------------------------------------------------------------------------
// Knowledge search command — split from knowledge.ts for 400-line limit
// ---------------------------------------------------------------------------
import { existsSync } from "node:fs";
import { buildProjectRetrievalIndex } from "../../retrieval/index-builder.js";
import { getProjectDir } from "../../utils/paths.js";
import { readKnowledgeIndex } from "../../utils/project-memory.js";
import { KNOWLEDGE_KINDS } from "../../utils/storage-utils.js";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  ERROR_CODES,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { failure, success } from "../output-envelope.js";

const knowledgeSearchParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  query: { type: "string", required: true, positional: 1, description: "Search query" },
  kind: {
    type: "string",
    description: "Filter by kind",
    enum: KNOWLEDGE_KINDS,
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "knowledge search",
  description: "Search knowledge entries using BM25 scoring",
  params: knowledgeSearchParams,
  handler: handleKnowledgeSearch,
});

async function handleKnowledgeSearch(
  params: ParsedParams<typeof knowledgeSearchParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const { slug, query, kind } = params;
  const projectDir = getProjectDir(slug);
  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
      hint: "Run 'arcs project list' to see available projects.",
    });
  }
  const index = await buildProjectRetrievalIndex(slug);
  let results = index.searchKnowledge(query, 10);
  if (kind) {
    const knowledgeIndex = await readKnowledgeIndex(projectDir);
    const kindSet = new Set(knowledgeIndex.entries.filter((e) => e.kind === kind).map((e) => e.id));
    results = results.filter((r) => kindSet.has(r.id));
  }
  return success(results);
}
