/**
 * Typed error helpers for consistent CLI command error responses.
 */

import { toolError } from "./tool-response.js";

export class DagError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DagError";
  }
}

export function projectNotFound(slug: string): DagError {
  return new DagError("PROJECT_NOT_FOUND", `Project "${slug}" does not exist.`);
}

export function projectAlreadyExists(slug: string): DagError {
  return new DagError("PROJECT_ALREADY_EXISTS", `Project "${slug}" already exists.`);
}

export function invalidDocType(doc: string): DagError {
  return new DagError(
    "INVALID_DOC_TYPE",
    `Invalid document type "${doc}". Must be one of: overview, tasks, dependencies, knowledge.`,
  );
}

export function cycleDetected(fromSlug: string, toSlug: string): DagError {
  return new DagError(
    "CYCLE_DETECTED",
    `Adding dependency "${fromSlug}" → "${toSlug}" would create a cycle.`,
  );
}

export function taskDependencyCycleDetected(cyclePath: string[]): DagError {
  return new DagError(
    "TASK_DEPENDENCY_CYCLE",
    `Dependency cycle detected: ${cyclePath.join(" → ")}`,
  );
}

export function taskDependencyNotFound(depId: string): DagError {
  return new DagError("TASK_DEPENDENCY_NOT_FOUND", `Task dependency "${depId}" does not exist.`);
}

export function dependencyNotFound(ids: string[]): DagError {
  return new DagError("DEPENDENCY_NOT_FOUND", `Unknown dependency target(s): ${ids.join(", ")}`);
}

export function invalidPlanStatus(status: string): DagError {
  return new DagError("INVALID_PLAN_STATUS", `Invalid plan status "${status}".`);
}

export function invalidTaskStatus(status: string): DagError {
  return new DagError("INVALID_TASK_STATUS", `Invalid task status "${status}".`);
}

export function invalidTaskPriority(priority: string): DagError {
  return new DagError("INVALID_TASK_PRIORITY", `Invalid task priority "${priority}".`);
}

export function invalidKnowledgeKind(kind: string): DagError {
  return new DagError("INVALID_KNOWLEDGE_KIND", `Invalid knowledge kind "${kind}".`);
}

export function invalidKeyword(keyword: string): DagError {
  return new DagError("INVALID_KEYWORD", `Invalid keyword "${keyword}".`);
}

export function invalidFileRef(detail: string): DagError {
  return new DagError("INVALID_FILE_REF", `Invalid file reference: ${detail}`);
}

export function normalizedIdCollision(
  kind: "plan" | "knowledge entry" | "task",
  requestedId: string,
  normalizedId: string,
): DagError {
  return new DagError(
    "NORMALIZED_ID_COLLISION",
    `Cannot create ${kind} "${requestedId}" because normalized id "${normalizedId}" already exists.`,
  );
}

export function itemNotFound(kind: "plan" | "knowledge entry" | "task", id: string): DagError {
  return new DagError("ITEM_NOT_FOUND", `Could not find ${kind} "${id}".`);
}

export function planNotFound(slug: string, planId: string): DagError {
  return new DagError("PLAN_NOT_FOUND", `Plan "${planId}" does not exist in project "${slug}".`);
}

export function invalidFileFormat(filePath: string, details: string): DagError {
  return new DagError("INVALID_FILE_FORMAT", `Invalid file format in "${filePath}": ${details}`);
}

export function indexRebuildFailed(kind: "plans" | "knowledge", reason: string): DagError {
  return new DagError("INDEX_REBUILD_FAILED", `Unable to rebuild ${kind} index: ${reason}`);
}

export function noProjectMatch(workspacePath: string): DagError {
  return new DagError(
    "NO_PROJECT_MATCH",
    `No project found matching workspace path "${workspacePath}". ` +
      `Register a workspace path using update_project_paths(slug, "add", [path]).`,
  );
}

export function ambiguousProjectMatch(workspacePath: string, slugs: string[]): DagError {
  return new DagError(
    "AMBIGUOUS_PROJECT_MATCH",
    `Multiple projects match workspace path "${workspacePath}" at the same depth: ${slugs.join(", ")}. ` +
      `Use more specific workspace paths or remove duplicates with update_project_paths.`,
  );
}

export function invalidWorkspacePath(path: string): DagError {
  return new DagError(
    "INVALID_WORKSPACE_PATH",
    `Workspace path "${path}" is not absolute. Paths must start with "/".`,
  );
}

export function noWorkspacePaths(slug: string): DagError {
  return new DagError(
    "NO_WORKSPACE_PATHS",
    `No workspace paths registered for project "${slug}". Use update_project_paths to add paths first.`,
  );
}

/**
 * Format a DagError into a CLI command error response.
 * Delegates to the canonical `toolError` helper so all error responses
 * share the same `[CODE] message` shape.
 */
export function formatError(err: DagError) {
  return toolError(err.code, err.message);
}
