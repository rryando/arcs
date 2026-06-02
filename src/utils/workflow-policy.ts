import { stripTaskCheckbox } from "./content-assembly.js";

export type WorkflowSurface = "queue" | "plan" | "memory";

export interface WorkflowPlanCandidate {
  title: string;
  status: string;
  updatedAt?: string;
}

export interface CurrentFocus {
  kind: "plan" | "task" | "none";
  label: string;
}

export interface OperatingBrief {
  currentFocus: string;
  recommendedSurface: "QUEUE" | "PLAN" | "MEMORY";
  why: string;
  nextAction: string;
}

export interface StructuredTask {
  id: string;
  title: string;
  status: "backlog" | "in_progress" | "done" | "cancelled";
  planId?: string;
  priority?: "critical" | "high" | "medium" | "low";
  dependsOn?: string[];
}

export interface StructuredPlan {
  id: string;
  title: string;
  status: "proposed" | "planned" | "in_progress" | "blocked" | "done" | "archived";
}

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function isTaskReady(task: StructuredTask, allTasks: StructuredTask[]): boolean {
  if (!task.dependsOn || task.dependsOn.length === 0) return true;
  const doneIds = new Set(allTasks.filter((t) => t.status === "done").map((t) => t.id));
  return task.dependsOn.every((d) => doneIds.has(d));
}

/**
 * Derive an operating brief from structured task and plan data.
 */
export function deriveOperatingBrief(input: {
  tasks: StructuredTask[];
  plans: StructuredPlan[];
}): OperatingBrief {
  const { tasks, plans } = input;

  // 1. Any task in_progress → QUEUE
  const inProgress = tasks.filter((t) => t.status === "in_progress");
  if (inProgress.length > 0) {
    const task = inProgress[0]!;
    return {
      currentFocus: task.title,
      recommendedSurface: "QUEUE",
      why: `Task in progress: ${task.title}`,
      nextAction: `Continue task ${task.id}`,
    };
  }

  // 2. Any plan in_progress with a backlog task → QUEUE
  const inProgressPlans = plans.filter((p) => p.status === "in_progress");
  for (const plan of inProgressPlans) {
    const readyTask = tasks.find(
      (t) => t.status === "backlog" && t.planId === plan.id && isTaskReady(t, tasks),
    );
    if (readyTask) {
      return {
        currentFocus: plan.title,
        recommendedSurface: "QUEUE",
        why: `Plan ${plan.title} has ready tasks`,
        nextAction: `Start task ${readyTask.id}`,
      };
    }
  }

  // 3. Any plan proposed or planned → PLAN
  const needsPlanning = plans.find((p) => p.status === "proposed" || p.status === "planned");
  if (needsPlanning) {
    return {
      currentFocus: needsPlanning.title,
      recommendedSurface: "PLAN",
      why: `Plan "${needsPlanning.title}" needs attention (status: ${needsPlanning.status})`,
      nextAction: `Advance plan ${needsPlanning.id}`,
    };
  }

  // 4. Any backlog task (no in-progress plan) → QUEUE, highest priority
  const backlog = tasks.filter((t) => t.status === "backlog");
  if (backlog.length > 0) {
    const readyBacklog = backlog.filter((t) => isTaskReady(t, tasks));
    if (readyBacklog.length === 0) {
      // All backlog tasks are blocked by unmet dependencies
      return {
        currentFocus: "No active work",
        recommendedSurface: "PLAN",
        why: "All remaining tasks are blocked by incomplete dependencies",
        nextAction: "Resolve dependencies or start a new plan",
      };
    }
    const sorted = [...readyBacklog].sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority ?? "medium"] ?? 1) -
        (PRIORITY_ORDER[b.priority ?? "medium"] ?? 1),
    );
    const task = sorted[0]!;
    return {
      currentFocus: task.title,
      recommendedSurface: "QUEUE",
      why: `Backlog task ready: ${task.title}`,
      nextAction: `Start task ${task.id}`,
    };
  }

  // 5. Nothing active
  return {
    currentFocus: "No active work",
    recommendedSurface: "MEMORY",
    why: "All plans/tasks complete",
    nextAction: "Review knowledge or start a new plan",
  };
}

export function chooseCurrentFocus(input: {
  plans: WorkflowPlanCandidate[];
  inProgressTasks: string[];
  backlogTasks: string[];
}): CurrentFocus {
  const inProgressPlans = input.plans.filter((plan) => plan.status === "in_progress");

  if (inProgressPlans.length > 0) {
    const sorted = [...inProgressPlans].sort((a, b) => {
      const aTime = safeTime(a.updatedAt);
      const bTime = safeTime(b.updatedAt);
      return bTime - aTime;
    });

    return { kind: "plan", label: sorted[0]?.title ?? "Unknown plan" };
  }

  if (input.inProgressTasks.length > 0) {
    return {
      kind: "task",
      label: stripTaskCheckbox(input.inProgressTasks[0] ?? ""),
    };
  }

  if (input.backlogTasks.length > 0) {
    return {
      kind: "task",
      label: stripTaskCheckbox(input.backlogTasks[0] ?? ""),
    };
  }

  return { kind: "none", label: "None" };
}

export function recommendSurface(input: {
  hasPlanSignals: boolean;
  hasDurableKnowledgeSignal: boolean;
  itemLabel?: string;
}): { surface: WorkflowSurface; why: string } {
  if (input.hasDurableKnowledgeSignal) {
    return {
      surface: "memory",
      why: "This should outlive the current task and be reusable later.",
    };
  }

  if (input.hasPlanSignals) {
    return {
      surface: "plan",
      why: "This work spans multiple steps and needs durable planning context.",
    };
  }

  return {
    surface: "queue",
    why: "This is best tracked as immediate execution state.",
  };
}

export function safeTime(value?: string): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
