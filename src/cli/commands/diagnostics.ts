// ---------------------------------------------------------------------------
// Diagnostic commands — audit (alias for validate --checks=sourcefiles), diff
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { getProjectDir } from "../../utils/paths.js";
import { listTasks, readKnowledgeIndex, readPlanIndex } from "../../utils/project-memory.js";
import { defineCommand, ERROR_CODES } from "../command-registry.js";
import { failure, success } from "../output-envelope.js";
import { runValidation } from "./utility.js";

// ---------------------------------------------------------------------------
// audit — thin alias delegating to validate with checks=sourcefiles
// ---------------------------------------------------------------------------

defineCommand({
  path: "audit",
  description: "Run a structural audit of a project (alias for validate --checks=sourcefiles)",
  params: {
    slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  },
  handler: async (params) => {
    const slug = params.slug;
    return runValidation(slug, new Set(["sourcefiles"]));
  },
});

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

function parseRelativeTime(input: string): string | null {
  const match = input.match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const [, num, unit] = match;
  const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit!]!;
  return new Date(Date.now() - parseInt(num!, 10) * ms).toISOString();
}

defineCommand({
  path: "diff",
  description: "Show what changed in a project since a given timestamp",
  params: {
    slug: { type: "string", required: true, positional: 0, description: "Project slug" },
    since: {
      type: "string",
      required: true,
      description: "ISO timestamp or relative time (e.g. 30m, 2h, 7d)",
    },
  },
  handler: async (params) => {
    const slug = params.slug;
    const sinceRaw = params.since;

    const sinceIso = parseRelativeTime(sinceRaw) ?? sinceRaw;
    const sinceMs = new Date(sinceIso).getTime();
    if (!Number.isFinite(sinceMs)) {
      return failure(ERROR_CODES.INVALID_TYPE, `Invalid ISO timestamp "${sinceRaw}"`);
    }

    const projectDir = getProjectDir(slug);
    if (!existsSync(projectDir)) {
      return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`);
    }

    const [planIndex, knowledgeIndex, tasks] = await Promise.all([
      readPlanIndex(projectDir),
      readKnowledgeIndex(projectDir),
      listTasks(projectDir),
    ]);

    const effectiveTs = (item: { updatedAt: string; createdAt: string }) =>
      item.updatedAt || item.createdAt;

    const isAfter = (item: { updatedAt: string; createdAt: string }) =>
      new Date(effectiveTs(item)).getTime() > sinceMs;

    const plans = planIndex.plans
      .filter(isAfter)
      .map((p) => ({ planId: p.id, title: p.title, status: p.status, updatedAt: effectiveTs(p) }))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const knowledge = knowledgeIndex.entries
      .filter(isAfter)
      .map((e) => ({ entryId: e.id, title: e.title, kind: e.kind, updatedAt: effectiveTs(e) }))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const taskResults = tasks
      .filter(isAfter)
      .map((t) => ({ taskId: t.id, title: t.title, status: t.status, updatedAt: effectiveTs(t) }))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return success({
      since: sinceIso,
      plans,
      knowledge,
      tasks: taskResults,
      counts: {
        plans: plans.length,
        knowledge: knowledge.length,
        tasks: taskResults.length,
        total: plans.length + knowledge.length + taskResults.length,
      },
    });
  },
});
