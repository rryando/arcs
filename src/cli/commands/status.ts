// ---------------------------------------------------------------------------
// status — Quick progress overview for a project
// ---------------------------------------------------------------------------

import { listTasks, readKnowledgeIndex, readPlanIndex } from "../../utils/project-memory.js";
import { resolveProject } from "../../utils/project-resolver.js";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { success } from "../output-envelope.js";

// ---------------------------------------------------------------------------

const statusParams = {
  slug: {
    type: "string",
    positional: 0,
    description: "Project slug or path",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "status",
  description: "Quick progress overview for a project",
  params: statusParams,
  handler: handleStatus,
});

// ---------------------------------------------------------------------------

async function handleStatus(
  params: ParsedParams<typeof statusParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const rawArg = params.slug;

  const resolved = await resolveProject(rawArg);
  if (!resolved.ok) return resolved.result;

  const { name, projectDir } = resolved;

  const [allTasks, planIndex, knowledgeIndex] = await Promise.all([
    listTasks(projectDir),
    readPlanIndex(projectDir),
    readKnowledgeIndex(projectDir),
  ]);

  // Tasks
  const openTasks = allTasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const doneTasks = allTasks.filter((t) => t.status === "done");

  // Plans
  const activePlans = planIndex.plans.filter(
    (p) => p.status === "in_progress" || p.status === "planned",
  );
  const donePlans = planIndex.plans.filter((p) => p.status === "done");
  const archivedPlans = planIndex.plans.filter((p) => p.status === "archived");

  // Knowledge by kind
  const kindCounts: Record<string, number> = {};
  for (const entry of knowledgeIndex.entries) {
    kindCounts[entry.kind] = (kindCounts[entry.kind] ?? 0) + 1;
  }
  const kindSummary = Object.entries(kindCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k}s`)
    .join(", ");

  // Recent: last 3 done tasks + next open task
  const recentDone = [...doneTasks]
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, 3);

  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const nextTask = [...openTasks].sort((a, b) => {
    if (a.status === "in_progress" && b.status !== "in_progress") return -1;
    if (b.status === "in_progress" && a.status !== "in_progress") return 1;
    return (
      (priorityOrder[a.priority ?? "medium"] ?? 1) - (priorityOrder[b.priority ?? "medium"] ?? 1)
    );
  })[0];

  if (flags.json) {
    return success({
      project: name,
      plans: {
        active: activePlans.length,
        done: donePlans.length,
        archived: archivedPlans.length,
      },
      tasks: {
        open: openTasks.length,
        done: doneTasks.length,
      },
      knowledge: {
        total: knowledgeIndex.entries.length,
        byKind: kindCounts,
      },
      recent: {
        done: recentDone.map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt })),
        next: nextTask ? { id: nextTask.id, title: nextTask.title } : null,
      },
    });
  }

  const isToday = (isoDate: string | undefined): boolean => {
    if (!isoDate) return false;
    const d = new Date(isoDate);
    const now = new Date();
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    );
  };

  const lines: string[] = [
    `Project: ${name}`,
    `Plans: ${activePlans.length} active, ${donePlans.length} done, ${archivedPlans.length} archived`,
    `Tasks: ${openTasks.length} open, ${doneTasks.length} done`,
    `Knowledge: ${knowledgeIndex.entries.length} entries${kindSummary ? ` (${kindSummary})` : ""}`,
    "",
    "Recent:",
    ...recentDone.map(
      (t) =>
        `  ✓ ${t.title} (${isToday(t.updatedAt) ? "today" : (t.updatedAt?.slice(0, 10) ?? "–")})`,
    ),
    ...(nextTask ? [`  → ${nextTask.title} (next)`] : ["  (no open tasks)"]),
  ];

  return success(lines.join("\n"));
}
