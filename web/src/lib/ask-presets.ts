/**
 * One-click audit prompts for the Ask-AI panel.
 *
 * Each preset is a pure builder returning the message text for the composer —
 * never auto-sent, so the user can review or tailor it first. The manager tier
 * (`mode: "arcs"`) supplies the CLI surface and the audit discipline; these
 * prompts only name the target and the goal.
 */

import type { AskContext } from "../api/client";

export interface AskPreset {
  id: string;
  label: string;
  build: (slug: string, context: AskContext) => string;
}

const AUDIT_PROJECT = (slug: string): string =>
  `Audit the whole ARCS DAG for \`${slug}\`. Read the current state first, then report and fix: ` +
  "(1) task statuses that no longer match reality, (2) redundant or overlapping tasks, " +
  "(3) plans whose status lags their tasks, (4) knowledge that is duplicated, shallow, or " +
  "superseded. Apply safe status corrections and merge obvious duplicates; list anything you " +
  "need me to decide. Finish with a short summary of every change you made.";

const AUDIT_TASKS = (slug: string): string =>
  `Audit the task board for \`${slug}\`. Run \`arcs task list ${slug} --json\`, then cross-check ` +
  "each task's status against the workspace: mark finished work done, flag in_progress tasks " +
  "with no progress, surface blocked or stale items, and detect duplicate or superseded tasks. " +
  "Apply safe transitions; propose anything destructive before doing it.";

const AUDIT_PLANS = (slug: string): string =>
  `Audit the plans for \`${slug}\`. Run \`arcs plan list ${slug} --json\` and \`arcs task list ` +
  `${slug} --json\`. For each plan, check whether its status matches its tasks (all done → plan ` +
  "done/archived; work started → in_progress). Merge or retire redundant, empty, or superseded " +
  "plans. Apply safe status updates; propose merges.";

const AUDIT_KNOWLEDGE = (slug: string): string =>
  `Audit the knowledge base for \`${slug}\`. Run \`arcs knowledge list ${slug} --json\`, read the ` +
  "entries, and find duplicates, overlaps, and shallow or superseded content. Merge duplicates " +
  "into the best entry (update it, then delete the other), flag bloat for removal, and fix stale " +
  "summaries or keywords. Report each change.";

/** Audit the entity currently open in the SPA (only offered when one is). */
const AUDIT_CURRENT = (slug: string, context: AskContext): string => {
  const target =
    context.id !== undefined ? `\`${context.id}\`` : `the current ${context.area} view`;
  return (
    `Audit ${target} in \`${slug}\`. Read it, then cross-check it against the workspace and the ` +
    "rest of the DAG: is its status accurate, is it redundant with anything else, is it stale or " +
    "bloated? Apply safe corrections and report every change; propose destructive edits " +
    "before applying them."
  );
};

/** The full preset catalogue, in presentation order. */
export const ASK_PRESETS: AskPreset[] = [
  { id: "audit-current", label: "audit current view", build: AUDIT_CURRENT },
  { id: "audit-project", label: "audit project DAG", build: AUDIT_PROJECT },
  { id: "audit-tasks", label: "audit tasks", build: AUDIT_TASKS },
  { id: "audit-plans", label: "audit plans", build: AUDIT_PLANS },
  { id: "audit-knowledge", label: "audit knowledge", build: AUDIT_KNOWLEDGE },
];

/**
 * The presets worth showing for the open view: `audit current view` only when
 * a specific entity is open, everything else always.
 */
export function presetsForContext(context: AskContext | null): AskPreset[] {
  if (context?.id === undefined) return ASK_PRESETS.filter((p) => p.id !== "audit-current");
  return ASK_PRESETS;
}
