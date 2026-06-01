// ---------------------------------------------------------------------------
// next — Tell the user what to work on next with relevant context
// ---------------------------------------------------------------------------

import { buildProjectRetrievalIndex } from "../../retrieval/index-builder.js";
import { listTasks, readKnowledgeIndex, readPlanIndex } from "../../utils/project-memory.js";
import { resolveProject } from "../../utils/project-resolver.js";
import { type ToposortInput, toposort } from "../../utils/toposort.js";
import { deriveOperatingBrief } from "../../utils/workflow-policy.js";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { success } from "../output-envelope.js";

// ---------------------------------------------------------------------------

const nextParams = {
  slug: {
    type: "string",
    positional: 0,
    description: "Project slug or path",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "next",
  description: "Show the next task to work on with relevant context",
  params: nextParams,
  handler: handleNext,
});

// ---------------------------------------------------------------------------

async function handleNext(
  params: ParsedParams<typeof nextParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const rawArg = params.slug;

  const resolved = await resolveProject(rawArg);
  if (!resolved.ok) return resolved.result;

  const { slug, projectDir } = resolved;

  const [allTasks, planIndex, retrievalIndex] = await Promise.all([
    listTasks(projectDir),
    readPlanIndex(projectDir),
    buildProjectRetrievalIndex(slug),
  ]);

  const openTasks = allTasks.filter((t) => t.status !== "done" && t.status !== "cancelled");

  if (openTasks.length === 0) {
    if (flags.json) {
      return success({ message: "Nothing to do. All tasks complete or no active plans." });
    }
    return success("Nothing to do. All tasks complete or no active plans.");
  }

  const brief = deriveOperatingBrief({
    tasks: allTasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      planId: t.planId,
      priority: t.priority,
      dependsOn: t.dependsOn,
    })),
    plans: planIndex.plans.map((p) => ({ id: p.id, title: p.title, status: p.status })),
  });

  // Pick the top open task — prefer in_progress, then ready backlog by toposort order
  const doneIds = new Set(allTasks.filter((t) => t.status === "done").map((t) => t.id));
  const isReady = (t: (typeof allTasks)[0]) =>
    !t.dependsOn || t.dependsOn.every((d) => doneIds.has(d));

  const toposortInputs: ToposortInput[] = allTasks.map((t) => ({
    id: t.id,
    dependsOn: t.dependsOn,
    priority: t.priority,
  }));
  let toposortOrder: string[];
  try {
    toposortOrder = toposort(toposortInputs);
  } catch {
    // Fallback to natural order on cycle (shouldn't happen in well-formed data)
    toposortOrder = allTasks.map((t) => t.id);
  }
  const orderMap = new Map(toposortOrder.map((id, i) => [id, i]));

  const sorted = [...openTasks].sort((a, b) => {
    if (a.status === "in_progress" && b.status !== "in_progress") return -1;
    if (b.status === "in_progress" && a.status !== "in_progress") return 1;
    const aReady = isReady(a);
    const bReady = isReady(b);
    if (aReady && !bReady) return -1;
    if (!aReady && bReady) return 1;
    return (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999);
  });

  const task = sorted[0]!;
  const plan = task.planId ? planIndex.plans.find((p) => p.id === task.planId) : undefined;

  const contextParts: string[] = [];
  if (plan?.summary) contextParts.push(plan.summary);
  if (brief.why) contextParts.push(brief.why);
  const context = contextParts.join(" ") || `Work on: ${task.title}`;

  const doneCommand = `arcs done ${slug} ${task.id}`;

  // Fetch top 2 related knowledge entries
  const knowledgeResults = retrievalIndex.searchKnowledge(task.title, 2);
  const relatedKnowledge = knowledgeResults.map((r) => ({
    id: r.id,
    title: r.title,
    kind: (r as { kind?: string }).kind ?? "lesson",
  }));

  // Also pull kind from the index for gotcha prefixing
  const knowledgeIndex = await readKnowledgeIndex(projectDir);
  const enrichedRelated = relatedKnowledge.map((rk) => {
    const entry = knowledgeIndex.entries.find((e) => e.id === rk.id);
    return { id: rk.id, title: rk.title, kind: entry?.kind ?? "lesson" };
  });

  if (flags.json) {
    return success({
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority ?? "medium",
      },
      context,
      planTitle: plan?.title ?? null,
      command: doneCommand,
      relatedKnowledge: enrichedRelated,
    });
  }

  const knowledgeLines = enrichedRelated.map((rk) => {
    const prefix = rk.kind === "gotcha" ? "⚠️  Watch out:" : "ℹ️ ";
    return `  ${prefix} ${rk.title}`;
  });

  const lines: string[] = [
    `Next: ${task.title}`,
    plan ? `Plan: ${plan.title}` : "",
    `Priority: ${task.priority ?? "medium"}`,
    "",
    "Context:",
    context,
    ...(knowledgeLines.length > 0 ? ["", "Related knowledge:", ...knowledgeLines] : []),
    "",
    `When done: ${doneCommand}`,
  ].filter((l, i) => i === 0 || l !== "" || i > 3);

  return success(lines.join("\n"));
}
