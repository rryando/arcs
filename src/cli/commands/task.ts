// ---------------------------------------------------------------------------
// Task commands — list, get, create, transition, update (registry-based)
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { attemptDiagramUpdate } from "../../utils/diagram-store.js";
import { getProjectDir } from "../../utils/paths.js";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  updateTask,
} from "../../utils/project-memory.js";
import { defineCommand, ERROR_CODES } from "../command-registry.js";
import { failure, success } from "../output-envelope.js";

// ---------------------------------------------------------------------------
// task list
// ---------------------------------------------------------------------------

defineCommand({
  path: "task list",
  description: "List tasks for a project",
  params: {
    slug: { type: "string", required: true, positional: 0, description: "Project slug" },
    status: {
      type: "string",
      description: "Filter by status",
      enum: ["backlog", "in_progress", "done", "cancelled"],
    },
    priority: {
      type: "string",
      description: "Filter by priority",
      enum: ["low", "medium", "high", "critical"],
    },
    planId: { type: "string", description: "Filter by plan ID" },
    fields: {
      type: "string",
      required: false,
      description: "Comma-separated field names to include in output",
    },
  },
  handler: async (params, _flags) => {
    const { slug, status, priority, planId, fields } = params;

    const projectDir = getProjectDir(slug);
    if (!existsSync(projectDir)) {
      return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
        hint: "Run 'arcs project list' to see available projects.",
      });
    }

    let tasks = await listTasks(projectDir, { status });

    if (priority) {
      tasks = tasks.filter((t) => t.priority === priority);
    }

    if (planId) {
      tasks = tasks.filter((t) => t.planId === planId);
    }

    if (fields) {
      const keys = fields.split(",").map((k) => k.trim());
      const projected = tasks.map((item) => {
        const out: Record<string, unknown> = {};
        for (const key of keys) {
          if (key in item) out[key] = (item as unknown as Record<string, unknown>)[key];
        }
        return out;
      });
      return success(projected);
    }

    return success(tasks);
  },
});

// ---------------------------------------------------------------------------
// task get
// ---------------------------------------------------------------------------

defineCommand({
  path: "task get",
  description: "Get task details",
  params: {
    slug: { type: "string", required: true, positional: 0, description: "Project slug" },
    taskId: { type: "string", required: true, positional: 1, description: "Task ID" },
  },
  handler: async (params, _flags) => {
    const { slug, taskId } = params;

    const projectDir = getProjectDir(slug);
    if (!existsSync(projectDir)) {
      return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
        hint: "Run 'arcs project list' to see available projects.",
      });
    }

    try {
      const task = await getTask(projectDir, taskId);
      return success(task);
    } catch (err) {
      return failure(
        ERROR_CODES.ENTITY_NOT_FOUND,
        err instanceof Error ? err.message : String(err),
      );
    }
  },
});

// ---------------------------------------------------------------------------
// task create
// ---------------------------------------------------------------------------

defineCommand({
  path: "task create",
  description: "Create a new task",
  mutation: true,
  params: {
    slug: { type: "string", required: true, positional: 0, description: "Project slug" },
    title: { type: "string", required: true, positional: 1, description: "Task title" },
    planId: { type: "string", description: "Associated plan ID" },
    dependsOn: { type: "string", description: "Comma-separated task IDs this task depends on" },
    priority: {
      type: "string",
      default: "medium",
      description: "Priority level",
      enum: ["critical", "high", "medium", "low"],
    },
    status: {
      type: "string",
      default: "backlog",
      description: "Initial status",
      enum: ["backlog", "in_progress", "done", "cancelled"],
    },
    "source-files": {
      type: "string",
      description: "Comma-separated source file refs (path[:anchor])",
    },
    scope: { type: "string", description: "Per-node %% scope: metadata for diagrams" },
    acceptance: { type: "string", description: "Per-node %% acceptance: metadata for diagrams" },
    verify: { type: "string", description: "Per-node %% verify: command for diagrams" },
    skill: { type: "string", description: "Per-node %% skill: name for diagrams" },
  },
  handler: async (params, flags) => {
    const { slug, title, planId, priority, status, scope, acceptance, verify, skill } = params;
    const dependsOnRaw = params.dependsOn;
    const dependsOn = dependsOnRaw
      ? dependsOnRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const sourceFilesRaw = params["source-files"];
    const sourceFiles = sourceFilesRaw
      ? sourceFilesRaw.split(",").map((s) => {
          const [path, anchor] = s.trim().split(":");
          return anchor ? { path, anchor } : { path };
        })
      : undefined;

    const projectDir = getProjectDir(slug);
    if (!existsSync(projectDir)) {
      return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
        hint: "Run 'arcs project list' to see available projects.",
      });
    }

    if (flags.dryRun) {
      return success({
        dryRun: true,
        wouldCreate: {
          title,
          slug,
          planId,
          priority,
          status,
          dependsOn,
          ...(sourceFiles && { sourceFiles }),
          ...(scope && { scope }),
          ...(acceptance && { acceptance }),
          ...(verify && { verify }),
          ...(skill && { skill }),
        },
      });
    }

    try {
      const task = await createTask(projectDir, {
        title,
        ...(planId && { planId }),
        ...(dependsOn && { dependsOn }),
        priority,
        status,
        ...(sourceFiles && { sourceFiles }),
        ...(scope && { scope }),
        ...(acceptance && { acceptance }),
        ...(verify && { verify }),
        ...(skill && { skill }),
      });
      return success(task);
    } catch (err) {
      return failure("task_create_error", err instanceof Error ? err.message : String(err));
    }
  },
});

// ---------------------------------------------------------------------------
// task transition
// ---------------------------------------------------------------------------

defineCommand({
  path: "task transition",
  description: "Transition task status",
  mutation: true,
  params: {
    slug: { type: "string", required: true, positional: 0, description: "Project slug" },
    taskId: { type: "string", required: true, positional: 1, description: "Task ID" },
    status: {
      type: "string",
      required: true,
      positional: 2,
      description: "New status",
      enum: ["backlog", "in_progress", "done", "cancelled"],
    },
    planId: { type: "string", description: "Plan ID (enables atomic diagram update)" },
    diagramNodeId: { type: "string", description: "Diagram node ID to update (e.g. T001)" },
  },
  handler: async (params, flags) => {
    const { slug, taskId, status, planId, diagramNodeId } = params;

    const projectDir = getProjectDir(slug);
    if (!existsSync(projectDir)) {
      return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
        hint: "Run 'arcs project list' to see available projects.",
      });
    }

    if (flags.dryRun) {
      return success({
        dryRun: true,
        wouldTransition: { slug, taskId, status, planId, diagramNodeId },
      });
    }

    try {
      const currentTask = await getTask(projectDir, taskId);
      const previousStatus = currentTask.status;
      await updateTask(projectDir, { id: taskId, status });

      // Atomic diagram update if both planId and diagramNodeId provided
      if (planId && diagramNodeId) {
        const diagramResult = attemptDiagramUpdate(slug, planId, diagramNodeId, status);
        return success({
          taskId,
          previousStatus,
          newStatus: status,
          diagramNodeId,
          ...diagramResult,
        });
      }

      return success({ taskId, previousStatus, newStatus: status });
    } catch (err) {
      return failure(
        ERROR_CODES.ENTITY_NOT_FOUND,
        err instanceof Error ? err.message : String(err),
      );
    }
  },
});

// ---------------------------------------------------------------------------
// task update
// ---------------------------------------------------------------------------

defineCommand({
  path: "task update",
  description: "Update task metadata",
  mutation: true,
  params: {
    slug: { type: "string", required: true, positional: 0, description: "Project slug" },
    taskId: { type: "string", required: true, positional: 1, description: "Task ID" },
    title: { type: "string", description: "New title" },
    priority: {
      type: "string",
      description: "New priority",
      enum: ["critical", "high", "medium", "low"],
    },
    planId: { type: "string", description: "Associated plan ID" },
    dependsOn: { type: "string", description: "Comma-separated task IDs (empty string to clear)" },
    "source-files": {
      type: "string",
      description: "Comma-separated source file refs (path[:anchor]); empty string clears",
    },
    scope: { type: "string", description: "Per-node %% scope: metadata (empty string clears)" },
    acceptance: {
      type: "string",
      description: "Per-node %% acceptance: metadata (empty string clears)",
    },
    verify: {
      type: "string",
      description: "Per-node %% verify: command (empty string clears)",
    },
    skill: { type: "string", description: "Per-node %% skill: name (empty string clears)" },
  },
  handler: async (params, flags) => {
    const { slug, taskId, title, priority, planId } = params;
    const dependsOnRaw = params.dependsOn;
    const dependsOn =
      dependsOnRaw !== undefined
        ? dependsOnRaw === ""
          ? []
          : dependsOnRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
        : undefined;
    const sourceFilesRaw = params["source-files"];
    const sourceFiles =
      sourceFilesRaw !== undefined
        ? sourceFilesRaw === ""
          ? []
          : sourceFilesRaw.split(",").map((s) => {
              const [path, anchor] = s.trim().split(":");
              return anchor ? { path, anchor } : { path };
            })
        : undefined;

    // Empty string clears the field; non-empty sets; undefined leaves untouched.
    const scopeUpdate =
      params.scope !== undefined ? (params.scope === "" ? null : params.scope) : undefined;
    const acceptanceUpdate =
      params.acceptance !== undefined
        ? params.acceptance === ""
          ? null
          : params.acceptance
        : undefined;
    const verifyUpdate =
      params.verify !== undefined ? (params.verify === "" ? null : params.verify) : undefined;
    const skillUpdate =
      params.skill !== undefined ? (params.skill === "" ? null : params.skill) : undefined;

    const projectDir = getProjectDir(slug);
    if (!existsSync(projectDir)) {
      return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
        hint: "Run 'arcs project list' to see available projects.",
      });
    }

    if (flags.dryRun) {
      return success({
        dryRun: true,
        wouldUpdate: {
          slug,
          taskId,
          title,
          priority,
          planId,
          dependsOn,
          ...(sourceFiles !== undefined && { sourceFiles }),
          ...(scopeUpdate !== undefined && { scope: scopeUpdate }),
          ...(acceptanceUpdate !== undefined && { acceptance: acceptanceUpdate }),
          ...(verifyUpdate !== undefined && { verify: verifyUpdate }),
          ...(skillUpdate !== undefined && { skill: skillUpdate }),
        },
      });
    }

    try {
      const task = await updateTask(projectDir, {
        id: taskId,
        ...(title && { title }),
        ...(priority && { priority }),
        ...(planId && { planId }),
        ...(dependsOn !== undefined && { dependsOn }),
        ...(sourceFiles !== undefined && { sourceFiles }),
        ...(scopeUpdate !== undefined && { scope: scopeUpdate }),
        ...(acceptanceUpdate !== undefined && { acceptance: acceptanceUpdate }),
        ...(verifyUpdate !== undefined && { verify: verifyUpdate }),
        ...(skillUpdate !== undefined && { skill: skillUpdate }),
      });
      return success(task);
    } catch (err) {
      return failure(
        ERROR_CODES.ENTITY_NOT_FOUND,
        err instanceof Error ? err.message : String(err),
      );
    }
  },
});

// ---------------------------------------------------------------------------
// task delete
// ---------------------------------------------------------------------------

defineCommand({
  path: "task delete",
  description: "Delete a task",
  mutation: true,
  params: {
    slug: { type: "string", required: true, positional: 0, description: "Project slug" },
    taskId: { type: "string", required: true, positional: 1, description: "Task ID" },
  },
  handler: async (params, flags) => {
    const { slug, taskId } = params;

    const projectDir = getProjectDir(slug);
    if (!existsSync(projectDir)) {
      return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
        hint: "Run 'arcs project list' to see available projects.",
      });
    }

    if (flags.dryRun) {
      return success({ dryRun: true, wouldDelete: { slug, taskId } });
    }

    try {
      await getTask(projectDir, taskId);
    } catch {
      return failure(ERROR_CODES.ENTITY_NOT_FOUND, `Task "${taskId}" not found`, {
        hint: `Run 'arcs task list ${slug}' to see available tasks.`,
      });
    }

    try {
      await deleteTask(projectDir, taskId);
      return success({ deleted: taskId });
    } catch (err) {
      return failure("task_delete_error", err instanceof Error ? err.message : String(err));
    }
  },
});
