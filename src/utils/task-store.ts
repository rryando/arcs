/**
 * Task CRUD storage for ARCS projects.
 *
 * Provides create, list, get, update, delete operations for tasks,
 * with a flat JSON index and markdown render for human-readable output.
 */

import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { invalidateGraphCache } from "../retrieval/graph-invalidate.js";
import {
  itemNotFound,
  normalizedIdCollision,
  taskDependencyCycleDetected,
  taskDependencyNotFound,
} from "./errors.js";
import { withLock } from "./file-lock.js";
import { readJsonSafe } from "./json.js";
import { normalizeIdentifier } from "./slug.js";
import {
  ensureDir,
  fileExists,
  nowISO,
  sanitizeFileRefs,
  validateTaskPriority,
  validateTaskStatus,
  writeJson,
} from "./storage-utils.js";
import { detectCycle } from "./toposort.js";

// ---------------------------------------------------------------------------
// Re-export types used by consumers
// ---------------------------------------------------------------------------

export type { FileRef, TaskPriority, TaskStatus } from "./storage-utils.js";
export { TASK_PRIORITIES, TASK_STATUSES } from "./storage-utils.js";

export type TaskWorkMode = "bounded" | "inspect";

const TASK_WORK_MODES: readonly TaskWorkMode[] = ["bounded", "inspect"];

function validateTaskWorkMode(workMode: string): asserts workMode is TaskWorkMode {
  if (!TASK_WORK_MODES.includes(workMode as TaskWorkMode)) {
    throw new Error(`Invalid task work mode "${workMode}". Expected bounded or inspect.`);
  }
}

// ---------------------------------------------------------------------------
// Meta types
// ---------------------------------------------------------------------------

export interface TaskMeta {
  id: string;
  normalizedId: string;
  title: string;
  status: import("./storage-utils.js").TaskStatus;
  priority: import("./storage-utils.js").TaskPriority;
  planId?: string;
  dependsOn?: string[];
  sourceFiles?: import("./storage-utils.js").FileRef[];
  /** Per-node `%% scope:` metadata for plan diagrams (paths/dirs in scope). */
  scope?: string;
  /** Per-node `%% acceptance:` metadata: human-readable acceptance criterion. */
  acceptance?: string;
  /** Per-node `%% verify:` metadata: shell command to verify task completion. */
  verify?: string;
  /** Per-node `%% skill:` metadata: which skill to load when executing the task. */
  skill?: string;
  /** Per-node `%% work-mode:` metadata for implementation task routing. */
  workMode?: TaskWorkMode;
  createdAt: string;
  updatedAt: string;
}

interface TaskIndex {
  tasks: TaskMeta[];
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  title: string;
  status?: import("./storage-utils.js").TaskStatus;
  priority?: import("./storage-utils.js").TaskPriority;
  planId?: string;
  dependsOn?: string[];
  sourceFiles?: import("./storage-utils.js").FileRef[];
  scope?: string;
  acceptance?: string;
  verify?: string;
  skill?: string;
  workMode?: TaskWorkMode;
  now?: string;
}

export interface UpdateTaskInput {
  id: string;
  title?: string;
  status?: import("./storage-utils.js").TaskStatus;
  priority?: import("./storage-utils.js").TaskPriority;
  planId?: string | null;
  dependsOn?: string[] | null;
  sourceFiles?: import("./storage-utils.js").FileRef[];
  /** Pass `null` to clear; pass string to set. */
  scope?: string | null;
  /** Pass `null` to clear; pass string to set. */
  acceptance?: string | null;
  /** Pass `null` to clear; pass string to set. */
  verify?: string | null;
  /** Pass `null` to clear; pass string to set. */
  skill?: string | null;
  /** Pass `null` to clear; pass a work mode to set. */
  workMode?: TaskWorkMode | null;
  now?: string;
}

// ---------------------------------------------------------------------------
// Dependency validation helpers
// ---------------------------------------------------------------------------

function validateDependsOn(dependsOn: string[], index: TaskIndex, taskNormalizedId: string): void {
  // Check all referenced IDs exist
  for (const depId of dependsOn) {
    if (!index.tasks.some((t) => t.normalizedId === depId || t.id === depId)) {
      throw taskDependencyNotFound(depId);
    }
  }

  // Check for cycles using proposed graph state
  const proposed = index.tasks.map((t) => ({
    id: t.normalizedId,
    dependsOn: t.normalizedId === taskNormalizedId ? dependsOn : t.dependsOn,
  }));
  const cycle = detectCycle(proposed);
  if (cycle) {
    throw taskDependencyCycleDetected(cycle);
  }
}

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

export function normalizeTaskWorkMetadata(task: TaskMeta): TaskMeta {
  if (task.skill === "quick-dev") {
    return { ...task, skill: "implementation", workMode: "bounded" };
  }
  if (task.skill === "code-agent") {
    return { ...task, skill: "implementation", workMode: "inspect" };
  }
  return { ...task };
}

async function readTaskIndex(projectDir: string): Promise<TaskIndex> {
  const tasksDir = join(projectDir, "tasks");
  if (!(await fileExists(tasksDir))) {
    return { tasks: [] };
  }
  const indexPath = join(tasksDir, "index.json");
  const index = await readJsonSafe<TaskIndex>(indexPath);
  if (!index || !Array.isArray(index.tasks)) {
    return { tasks: [] };
  }
  return { tasks: index.tasks.map(normalizeTaskWorkMetadata) };
}

async function writeTaskIndex(projectDir: string, index: TaskIndex): Promise<void> {
  const tasksDir = join(projectDir, "tasks");
  await ensureDir(tasksDir);
  const indexPath = join(tasksDir, "index.json");
  await withLock(indexPath, async () => {
    await writeJson(indexPath, index);
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<import("./storage-utils.js").TaskPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function sortByPriority(tasks: TaskMeta[]): TaskMeta[] {
  return [...tasks].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}

export async function renderTasksMd(projectDir: string, index: TaskIndex): Promise<void> {
  const metaPath = join(projectDir, "meta.json");
  const meta = await readJsonSafe<{ name?: string }>(metaPath);
  const name = meta?.name ?? "Unknown";

  const sections: string[] = [`# Tasks — ${name}\n`];

  const statusConfig: Array<{
    status: import("./storage-utils.js").TaskStatus;
    heading: string;
    marker: string;
    showPriority: boolean;
  }> = [
    { status: "in_progress", heading: "In Progress", marker: "[/]", showPriority: true },
    { status: "backlog", heading: "Backlog", marker: "[ ]", showPriority: true },
    { status: "done", heading: "Done", marker: "[x]", showPriority: false },
    { status: "cancelled", heading: "Cancelled", marker: "[~]", showPriority: false },
  ];

  for (const { status, heading, marker, showPriority } of statusConfig) {
    const tasks = sortByPriority(index.tasks.filter((t) => t.status === status));
    if (tasks.length === 0) continue;

    sections.push(`## ${heading}`);
    for (const task of tasks) {
      const priorityTag = showPriority ? ` **[${task.priority}]**` : "";
      sections.push(`- ${marker}${priorityTag} ${task.title}`);
    }
    sections.push("");
  }

  await writeFile(join(projectDir, "tasks.md"), sections.join("\n"), "utf-8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createTask(projectDir: string, input: CreateTaskInput): Promise<TaskMeta> {
  const status = input.status ?? "backlog";
  const priority = input.priority ?? "medium";
  validateTaskStatus(status);
  validateTaskPriority(priority);
  if (input.workMode !== undefined) {
    validateTaskWorkMode(input.workMode);
  }
  const sourceFiles = input.sourceFiles ? sanitizeFileRefs(input.sourceFiles) : undefined;

  const normalizedId = normalizeIdentifier(input.title);
  const index = await readTaskIndex(projectDir);

  if (index.tasks.some((t) => t.normalizedId === normalizedId)) {
    throw normalizedIdCollision("task", input.title, normalizedId);
  }

  if (input.dependsOn && input.dependsOn.length > 0) {
    validateDependsOn(input.dependsOn, index, normalizedId);
  }

  const ts = nowISO(input.now);

  const meta = normalizeTaskWorkMetadata({
    id: normalizedId,
    normalizedId,
    title: input.title,
    status,
    priority,
    ...(input.planId && { planId: input.planId }),
    ...(input.dependsOn && input.dependsOn.length > 0 && { dependsOn: input.dependsOn }),
    ...(sourceFiles && { sourceFiles }),
    ...(input.scope && { scope: input.scope }),
    ...(input.acceptance && { acceptance: input.acceptance }),
    ...(input.verify && { verify: input.verify }),
    ...(input.skill && { skill: input.skill }),
    ...(input.workMode && { workMode: input.workMode }),
    createdAt: ts,
    updatedAt: ts,
  });

  index.tasks.push(meta);
  await writeTaskIndex(projectDir, index);
  await renderTasksMd(projectDir, index);

  invalidateGraphCache(basename(projectDir));
  return meta;
}

export async function listTasks(
  projectDir: string,
  filters?: {
    status?: import("./storage-utils.js").TaskStatus;
    priority?: import("./storage-utils.js").TaskPriority;
  },
): Promise<TaskMeta[]> {
  const index = await readTaskIndex(projectDir);
  let tasks = index.tasks;

  if (filters?.status) {
    tasks = tasks.filter((t) => t.status === filters.status);
  }
  if (filters?.priority) {
    tasks = tasks.filter((t) => t.priority === filters.priority);
  }

  return tasks;
}

export async function getTask(projectDir: string, taskId: string): Promise<TaskMeta> {
  const normalizedId = normalizeIdentifier(taskId);
  const index = await readTaskIndex(projectDir);
  const task = index.tasks.find((t) => t.normalizedId === normalizedId);
  if (!task) {
    throw itemNotFound("task", taskId);
  }
  return task;
}

export async function updateTask(projectDir: string, input: UpdateTaskInput): Promise<TaskMeta> {
  if (input.status !== undefined) {
    validateTaskStatus(input.status);
  }
  if (input.priority !== undefined) {
    validateTaskPriority(input.priority);
  }
  if (input.workMode !== undefined && input.workMode !== null) {
    validateTaskWorkMode(input.workMode);
  }

  const normalizedId = normalizeIdentifier(input.id);
  const index = await readTaskIndex(projectDir);
  const taskIndex = index.tasks.findIndex((t) => t.normalizedId === normalizedId);
  if (taskIndex === -1) {
    throw itemNotFound("task", input.id);
  }
  const task = index.tasks[taskIndex];

  if (input.title !== undefined) task.title = input.title;
  if (input.status !== undefined) task.status = input.status;
  if (input.priority !== undefined) task.priority = input.priority;
  if (input.planId !== undefined) {
    if (input.planId === null) {
      delete task.planId;
    } else {
      task.planId = input.planId;
    }
  }
  if (input.dependsOn !== undefined) {
    if (input.dependsOn === null || input.dependsOn.length === 0) {
      delete task.dependsOn;
    } else {
      validateDependsOn(input.dependsOn, index, normalizedId);
      task.dependsOn = input.dependsOn;
    }
  }
  if (input.sourceFiles !== undefined) {
    if (input.sourceFiles.length === 0) {
      delete task.sourceFiles;
    } else {
      task.sourceFiles = sanitizeFileRefs(input.sourceFiles);
    }
  }
  if (input.scope !== undefined) {
    if (input.scope === null || input.scope === "") {
      delete task.scope;
    } else {
      task.scope = input.scope;
    }
  }
  if (input.acceptance !== undefined) {
    if (input.acceptance === null || input.acceptance === "") {
      delete task.acceptance;
    } else {
      task.acceptance = input.acceptance;
    }
  }
  if (input.verify !== undefined) {
    if (input.verify === null || input.verify === "") {
      delete task.verify;
    } else {
      task.verify = input.verify;
    }
  }
  if (input.skill !== undefined) {
    if (input.skill === null || input.skill === "") {
      delete task.skill;
    } else {
      task.skill = input.skill;
    }
  }
  if (input.workMode !== undefined) {
    if (input.workMode === null) {
      delete task.workMode;
    } else {
      task.workMode = input.workMode;
    }
  }
  task.updatedAt = nowISO(input.now);

  const normalizedTask = normalizeTaskWorkMetadata(task);
  index.tasks[taskIndex] = normalizedTask;

  await writeTaskIndex(projectDir, index);
  await renderTasksMd(projectDir, index);

  invalidateGraphCache(basename(projectDir));
  return normalizedTask;
}

export async function deleteTask(projectDir: string, taskId: string): Promise<void> {
  const normalizedId = normalizeIdentifier(taskId);
  const index = await readTaskIndex(projectDir);
  const task = index.tasks.find((t) => t.normalizedId === normalizedId);
  if (!task) {
    throw itemNotFound("task", taskId);
  }

  index.tasks = index.tasks.filter((t) => t.normalizedId !== normalizedId);
  await writeTaskIndex(projectDir, index);
  await renderTasksMd(projectDir, index);
}
