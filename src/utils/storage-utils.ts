/**
 * Shared storage utilities for ARCS project stores.
 *
 * Filesystem helpers, validation utilities, and common types used by
 * plan-store, knowledge-store, and task-store modules.
 */

import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  invalidFileRef,
  invalidKeyword,
  invalidKnowledgeKind,
  invalidPlanStatus,
  invalidTaskPriority,
  invalidTaskStatus,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Enums — Plans
// ---------------------------------------------------------------------------

export const PLAN_STATUSES = [
  "proposed",
  "planned",
  "in_progress",
  "blocked",
  "done",
  "archived",
] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const KNOWLEDGE_KINDS = [
  "lesson",
  "gotcha",
  "pattern",
  "architecture",
  "module",
  "feature",
  "reference",
  "decision",
] as const;

export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_AUDIENCES = [
  "orchestrator",
  "implementer",
  "designer",
  "universal",
] as const;

export type KnowledgeAudience = (typeof KNOWLEDGE_AUDIENCES)[number];

// ---------------------------------------------------------------------------
// Enums — Tasks
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ["backlog", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

// ---------------------------------------------------------------------------
// FileRef type
// ---------------------------------------------------------------------------

export interface FileRef {
  path: string;
  anchor?: string;
}

/**
 * Validates and normalizes an array of FileRef objects.
 * - path: backslashes normalized to forward slashes first, then validated.
 *   Must be relative (no leading /), no .., no empty, no #, comma, or colon.
 * - anchor: if provided, must be non-empty/non-whitespace, no # or comma.
 * Returns a new array with normalized paths. Throws on invalid input.
 */
export function sanitizeFileRefs(refs: FileRef[]): FileRef[] {
  return refs.map((ref) => {
    // Normalize backslashes to forward slashes first (Windows path compat)
    const path = ref.path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!path?.trim()) {
      throw invalidFileRef("path must not be empty");
    }
    if (path.startsWith("/")) {
      throw invalidFileRef(`path must be relative, got "${path}"`);
    }
    if (/(^|\/)\.\.($|\/)/.test(path)) {
      throw invalidFileRef(`path must not contain ".." segments, got "${path}"`);
    }
    // Note: backslash already normalized above, so only check #, comma, colon
    if (/[#,:]/.test(path)) {
      throw invalidFileRef(`path must not contain #, comma, or colon, got "${path}"`);
    }
    const result: FileRef = { path };
    if (ref.anchor !== undefined) {
      if (!ref.anchor?.trim()) {
        throw invalidFileRef("anchor must not be empty or whitespace-only");
      }
      if (/[#,]/.test(ref.anchor)) {
        throw invalidFileRef(`anchor must not contain # or comma, got "${ref.anchor}"`);
      }
      result.anchor = ref.anchor;
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validatePlanStatus(status: string): asserts status is PlanStatus {
  if (!(PLAN_STATUSES as readonly string[]).includes(status)) {
    throw invalidPlanStatus(status);
  }
}

export function validateKnowledgeKind(kind: string): asserts kind is KnowledgeKind {
  if (!(KNOWLEDGE_KINDS as readonly string[]).includes(kind)) {
    throw invalidKnowledgeKind(kind);
  }
}

export function validateTaskStatus(status: string): asserts status is TaskStatus {
  if (!(TASK_STATUSES as readonly string[]).includes(status)) {
    throw invalidTaskStatus(status);
  }
}

export function validateTaskPriority(priority: string): asserts priority is TaskPriority {
  if (!(TASK_PRIORITIES as readonly string[]).includes(priority)) {
    throw invalidTaskPriority(priority);
  }
}

/** A valid keyword is a non-empty, lowercase, alpha-numeric-or-dash string. */
export function sanitizeKeywords(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const kw of raw) {
    const trimmed = kw.trim().toLowerCase();
    // Reject empty/blank or anything that normalizes to nothing useful
    if (!trimmed || !/[a-z0-9]/.test(trimmed)) {
      throw invalidKeyword(kw);
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export function nowISO(override?: string): string {
  return override ?? new Date().toISOString();
}

// ---------------------------------------------------------------------------
// H1 rewrite
// ---------------------------------------------------------------------------

/**
 * Build body markdown. If `content` is supplied and already starts with
 * a matching H1, use as-is. Otherwise, prepend `# title\n\n`.
 */
export function buildBody(title: string, content?: string): string {
  if (content !== undefined) {
    // If content starts with the correct H1, keep it
    if (content.startsWith(`# ${title}`)) {
      return content;
    }
    // If it starts with a different H1, replace it
    if (content.startsWith("# ")) {
      const rest = content.slice(content.indexOf("\n"));
      return `# ${title}${rest}`;
    }
    return `# ${title}\n\n${content}`;
  }
  return `# ${title}\n\n`;
}

/**
 * Rewrite the leading H1 in an existing body file.
 */
export async function rewriteH1(filePath: string, newTitle: string): Promise<void> {
  const body = await readFile(filePath, "utf-8");
  if (body.startsWith("# ")) {
    const rest = body.slice(body.indexOf("\n"));
    await writeFile(filePath, `# ${newTitle}${rest}`, "utf-8");
  } else {
    await writeFile(filePath, `# ${newTitle}\n\n${body}`, "utf-8");
  }
}
