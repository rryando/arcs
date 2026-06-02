// ---------------------------------------------------------------------------
// done — Mark a task as done and show the next task to work on
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { attemptDiagramUpdate } from "../../utils/diagram-store.js";
import {
  createKnowledgeEntry,
  getTask,
  listTasks,
  readPlanIndex,
  updateTask,
} from "../../utils/project-memory.js";
import { resolveProject } from "../../utils/project-resolver.js";
import { normalizeIdentifier } from "../../utils/slug.js";
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

const doneParams = {
  slug: {
    type: "string",
    required: true,
    positional: 0,
    description: "Project slug",
  },
  taskId: {
    type: "string",
    required: true,
    positional: 1,
    description: "Task ID to mark as done",
  },
  planId: { type: "string", description: "Plan ID (enables atomic diagram update)" },
  diagramNodeId: { type: "string", description: "Diagram node ID to update (e.g. T001)" },
  learn: { type: "string", description: "Capture a quick insight linked to this task" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "done",
  description: "Mark a task as done and show the next task",
  mutation: true,
  params: doneParams,
  handler: handleDone,
});

// ---------------------------------------------------------------------------

async function handleDone(
  params: ParsedParams<typeof doneParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const rawSlug = params.slug;
  const taskId = params.taskId;
  const planIdParam = params.planId;
  const diagramNodeId = params.diagramNodeId;
  const learnText = params.learn;

  const resolved = await resolveProject(rawSlug);
  if (!resolved.ok) return resolved.result;

  const { slug, projectDir } = resolved;

  // Validate project directory exists
  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
      hint: "Run 'arcs project list' to see available projects.",
    });
  }

  // Get and transition the task
  let completedTask: { id: string; title: string };
  try {
    const task = await getTask(projectDir, taskId);
    await updateTask(projectDir, { id: taskId, status: "done" });
    completedTask = { id: task.id, title: task.title };

    // Attempt diagram update if planId and diagramNodeId available
    const effectivePlanId = planIdParam ?? task.planId;
    if (effectivePlanId && diagramNodeId) {
      attemptDiagramUpdate(slug, effectivePlanId, diagramNodeId, "done");
    }
  } catch (err) {
    return failure(ERROR_CODES.ENTITY_NOT_FOUND, err instanceof Error ? err.message : String(err));
  }

  // Derive next task
  const [allTasks, planIndex] = await Promise.all([
    listTasks(projectDir),
    readPlanIndex(projectDir),
  ]);

  const openTasks = allTasks.filter((t) => t.status !== "done" && t.status !== "cancelled");

  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sorted = [...openTasks].sort((a, b) => {
    if (a.status === "in_progress" && b.status !== "in_progress") return -1;
    if (b.status === "in_progress" && a.status !== "in_progress") return 1;
    const pa = priorityOrder[a.priority ?? "medium"] ?? 1;
    const pb = priorityOrder[b.priority ?? "medium"] ?? 1;
    return pa - pb;
  });

  const nextTask = sorted[0];
  const nextPlan = nextTask?.planId
    ? planIndex.plans.find((p) => p.id === nextTask.planId)
    : undefined;

  const nextData = nextTask
    ? { id: nextTask.id, title: nextTask.title, plan: nextPlan?.title ?? null }
    : null;

  // Capture --learn insight if provided
  let learnedEntry: { id: string; title: string; kind: string } | null = null;
  if (learnText) {
    try {
      const lower = learnText.toLowerCase();
      const kind = /don't|never|careful|watch out|gotcha/.test(lower)
        ? "gotcha"
        : /learned|lesson|realized|mistake/.test(lower)
          ? "lesson"
          : /pattern|always|convention|rule/.test(lower)
            ? "pattern"
            : "lesson";
      const title = learnText.length <= 50 ? learnText : `${learnText.slice(0, 50)}...`;
      const id = normalizeIdentifier(title);
      const entry = await createKnowledgeEntry(projectDir, {
        id,
        title,
        kind: kind as "gotcha" | "lesson" | "pattern",
        keywords: [completedTask.id],
        summary: learnText,
      });
      learnedEntry = { id: entry.id, title: entry.title, kind: entry.kind };
    } catch {
      // Best-effort — don't fail the done command for a learn error
    }
  }

  if (flags.json) {
    return success({
      completed: completedTask,
      next: nextData,
      ...(learnedEntry ? { learned: learnedEntry } : {}),
    });
  }

  const lines: string[] = [`✓ Done: ${completedTask.title}`, ""];

  if (nextData) {
    lines.push(`Next: ${nextData.title}`);
    if (nextData.plan) lines.push(`Plan: ${nextData.plan}`);
    lines.push("");
    lines.push(`Run: arcs done ${slug} ${nextData.id}`);
  } else {
    lines.push("All tasks complete! Nothing left to do.");
  }

  if (learnedEntry) {
    lines.push(`✓ Remembered [${learnedEntry.kind}]: ${learnedEntry.title}`);
  }

  return success(lines.join("\n"));
}
