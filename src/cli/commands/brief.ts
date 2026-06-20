// ---------------------------------------------------------------------------
// brief — Tight T0 routing brief for orchestrator
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { extractOverviewContent } from "../../utils/content-assembly.js";
import {
  KNOWLEDGE_AUDIENCES,
  listTasks,
  readKnowledgeIndex,
  readPlanIndex,
} from "../../utils/project-memory.js";
import { resolveProject } from "../../utils/project-resolver.js";
import { deriveOperatingBrief } from "../../utils/workflow-policy.js";
import { renderBrief } from "../brief-renderer.js";
import { defineCommand } from "../command-registry.js";
import { failure, success } from "../output-envelope.js";

// ---------------------------------------------------------------------------

defineCommand({
  path: "brief",
  description: "Tight T0 routing brief for orchestrator (slug, focus, counts, top knowledge)",
  params: {
    pathOrSlug: {
      type: "string",
      positional: 0,
      description: "Absolute path or project slug (defaults to cwd)",
    },
    audience: {
      type: "string",
      description: "Knowledge audience filter (default: orchestrator)",
      enum: ["orchestrator", "implementer", "designer"],
    },
    full: {
      type: "boolean",
      description: "Include done tasks/plans (default: false — only active items)",
    },
  },
  handler: async (params, flags) => {
    const rawArg = params.pathOrSlug;
    const audience = params.audience ?? "orchestrator";
    const full = params.full;

    if (params.audience && !(KNOWLEDGE_AUDIENCES as readonly string[]).includes(params.audience)) {
      return failure(
        "invalid_enum",
        `Invalid audience "${params.audience}". Valid: ${KNOWLEDGE_AUDIENCES.join(", ")}`,
      );
    }

    // --- Resolve project ---
    const resolved = await resolveProject(rawArg);
    if (!resolved.ok) return resolved.result;

    const { slug, name, projectDir } = resolved;

    // --- Summary from overview ---
    const overviewPath = resolve(projectDir, "overview.md");
    let summary = "";
    if (existsSync(overviewPath)) {
      const raw = await readFile(overviewPath, "utf-8");
      const content = extractOverviewContent(raw);
      if (content) {
        summary = pickFirstProseParagraph(content);
      }
    }

    // --- Plans ---
    const planIndex = await readPlanIndex(projectDir);
    const activePlans = full
      ? planIndex.plans
      : planIndex.plans.filter((p) => p.status !== "done" && p.status !== "archived");

    // --- Tasks ---
    const allTasks = await listTasks(projectDir);
    const openTasks = full
      ? allTasks
      : allTasks.filter((t) => t.status !== "done" && t.status !== "cancelled");

    // --- Knowledge (top 5 by recency, filtered by audience) ---
    const knowledgeIndex = await readKnowledgeIndex(projectDir);
    const filtered = knowledgeIndex.entries.filter(
      (e) => !e.audience || e.audience === audience || e.audience === "universal",
    );
    // Sort by updatedAt descending
    filtered.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const topKnowledge = filtered
      .slice(0, 5)
      .map((e) => ({ id: e.id, title: e.title, kind: e.kind }));

    // --- Knowledge health (thin/stale) over the full index ---
    // thin: missing summary OR missing sourceFiles; stale: not updated in 180+ days.
    const STALE_KNOWLEDGE_DAYS = 180;
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let thinCount = 0;
    let staleCount = 0;
    for (const e of knowledgeIndex.entries) {
      const missingSummary = !e.summary || e.summary.trim().length === 0;
      const missingSourceFiles = !e.sourceFiles || e.sourceFiles.length === 0;
      if (missingSummary || missingSourceFiles) thinCount++;
      if (e.updatedAt) {
        const ageDays = Math.floor((now - new Date(e.updatedAt).getTime()) / MS_PER_DAY);
        if (ageDays > STALE_KNOWLEDGE_DAYS) staleCount++;
      }
    }
    const knowledgeHealth = {
      total: knowledgeIndex.entries.length,
      thin: thinCount,
      stale: staleCount,
    };

    const operatingBrief = deriveOperatingBrief({
      tasks: allTasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        planId: t.planId,
        priority: t.priority,
      })),
      plans: planIndex.plans.map((p) => ({ id: p.id, title: p.title, status: p.status })),
    });

    // Top open tasks (up to 7) for markdown rendering
    const topOpenTasks = openTasks
      .slice(0, 7)
      .map((t) => ({ id: t.id, title: t.title, status: t.status }));

    const activePlanTitles = activePlans.map((p) => p.title);

    const data = {
      slug,
      name,
      summary,
      operatingBrief,
      activePlansCount: activePlans.length,
      activePlanTitles,
      openTasksCount: openTasks.length,
      topOpenTasks,
      topKnowledge,
      knowledgeHealth,
    };

    if (!flags.json) {
      return success(renderBrief(data));
    }
    return success(data);
  },
});

// ---------------------------------------------------------------------------
// Summary extraction
// ---------------------------------------------------------------------------

/**
 * Walk paragraphs and return the first one that's actual prose (not a heading,
 * not a list, not a code fence). Truncates to 200 chars to keep the brief tight.
 *
 * Rationale: the ARCS project's own overview.md opens with `## Summary` which
 * is a heading — taking the first paragraph naively rendered the heading text
 * verbatim. By skipping until we find prose, we always emit a real description.
 */
function pickFirstProseParagraph(content: string): string {
  const paragraphs = content
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (const para of paragraphs) {
    // Skip headings, fenced code blocks, list-only blocks, and blockquotes
    if (para.startsWith("#")) continue;
    if (para.startsWith("```")) continue;
    if (para.startsWith(">")) continue;
    // Skip blocks that are entirely list items (every line starts with - or *)
    const allLines = para
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (allLines.length > 0 && allLines.every((l) => /^[-*]\s/.test(l))) continue;
    return para.length > 200 ? para.slice(0, 200) : para;
  }
  // Fallback: nothing prose-like found, take the first non-empty paragraph as-is
  const fallback = paragraphs[0] ?? "";
  return fallback.length > 200 ? fallback.slice(0, 200) : fallback;
}
