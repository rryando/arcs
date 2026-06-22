// ---------------------------------------------------------------------------
// Utility commands — context, search, agents-md, validate (registry-based)
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildProjectRetrievalIndex } from "../../retrieval/index-builder.js";
import { extractOverviewContent } from "../../utils/content-assembly.js";
import {
  extractBodyContentLength,
  isBodyShallow,
  SHALLOW_BODY_MIN_CHARS,
} from "../../utils/knowledge-templates.js";
import { getProjectDir } from "../../utils/paths.js";
import {
  KNOWLEDGE_AUDIENCES,
  listTasks,
  readKnowledgeIndex,
  readPlanIndex,
} from "../../utils/project-memory.js";
import { resolveProject } from "../../utils/project-resolver.js";
import { deriveOperatingBrief } from "../../utils/workflow-policy.js";
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
// context
// ---------------------------------------------------------------------------

const contextParams = {
  pathOrSlug: {
    type: "string",
    positional: 0,
    description: "Absolute path or project slug (defaults to cwd)",
  },
  audience: {
    type: "string",
    description: "Target audience for knowledge filtering (default: orchestrator)",
    enum: ["orchestrator", "implementer", "designer"],
  },
  // TODO: wire task-scoped context via src/retrieval/task-scoped.ts
  full: {
    type: "boolean",
    description: "Include done/cancelled tasks and done/archived plans (default: false)",
  },
  "no-graph": { type: "boolean", description: "Skip graph-based retrieval" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "context",
  description: "Resolve project context for a workspace path or slug",
  params: contextParams,
  handler: handleContext,
});

async function handleContext(
  params: ParsedParams<typeof contextParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const rawArg = params.pathOrSlug;
  const audience = params.audience ?? "orchestrator";
  const full = params.full;
  const _noGraph = params["no-graph"];

  if (audience && !(KNOWLEDGE_AUDIENCES as readonly string[]).includes(audience)) {
    return failure(
      "invalid_enum",
      `Invalid audience "${audience}". Valid: ${KNOWLEDGE_AUDIENCES.join(", ")}`,
    );
  }

  // Resolve path/slug
  const resolved = await resolveProject(rawArg);
  if (!resolved.ok) return resolved.result;

  const { slug, name, description, projectDir } = resolved;

  // Build JSON output
  const overviewPath = resolve(projectDir, "overview.md");
  let overview: string | null = null;
  if (existsSync(overviewPath)) {
    const overviewRaw = await readFile(overviewPath, "utf-8");
    overview = extractOverviewContent(overviewRaw);
  }

  const knowledgeIndex = await readKnowledgeIndex(projectDir);
  const filteredKnowledge = knowledgeIndex.entries.filter(
    (e) => !e.audience || e.audience === audience || e.audience === "universal",
  );
  const planIndex = await readPlanIndex(projectDir);
  const allTasks = await listTasks(projectDir);

  // Default-filter done items unless --full
  const filteredPlans = full
    ? planIndex.plans
    : planIndex.plans.filter((p) => p.status !== "done" && p.status !== "archived");
  const filteredTasks = full
    ? allTasks
    : allTasks.filter((t) => t.status !== "done" && t.status !== "cancelled");

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

  return success({
    slug,
    name,
    description,
    overview,
    audience,
    operatingBrief,
    tasks: filteredTasks,
    plans: filteredPlans,
    knowledge: filteredKnowledge,
  });
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const searchParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  query: { type: "string", required: true, positional: 1, description: "Search query" },
  kind: { type: "string", description: "Filter results by entity kind" },
  limit: { type: "number", default: 10, description: "Max results to return" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "search",
  description: "BM25 search across all project entities",
  params: searchParams,
  handler: handleSearch,
});

async function handleSearch(
  params: ParsedParams<typeof searchParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const query = params.query;
  const kind = params.kind;
  const limit = params.limit;

  const projectDir = getProjectDir(slug);
  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
      hint: "Run 'arcs project list' to see available projects.",
    });
  }

  const index = await buildProjectRetrievalIndex(slug);
  let results = index.searchAll(query, limit);

  if (kind) {
    results = results.filter((r) => r.type === kind);
  }

  return success(results);
}

// ---------------------------------------------------------------------------
// agents-md
// ---------------------------------------------------------------------------

const agentsMdParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "agents-md",
  description: "Read project's AGENTS.md content",
  params: agentsMdParams,
  handler: handleAgentsMd,
});

async function handleAgentsMd(
  params: ParsedParams<typeof agentsMdParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;

  const projectDir = getProjectDir(slug);
  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
      hint: "Run 'arcs project list' to see available projects.",
    });
  }

  const agentsMdPath = resolve(projectDir, "AGENTS.md");
  if (!existsSync(agentsMdPath)) {
    return failure(ERROR_CODES.ENTITY_NOT_FOUND, `No AGENTS.md found for project '${slug}'`, {
      hint: `Run: arcs sync-agents-md ${slug} --analysis-file=<path>`,
    });
  }

  const content = readFileSync(agentsMdPath, "utf-8");
  return success({ slug, content });
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

const validateParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  checks: {
    type: "string",
    description:
      "Comma-separated checks to run (default: all). Valid: all, sourcefiles, status-drift, diagrams, agents-md, knowledge-health",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "validate",
  description: "Run health checks on a project's DAG state",
  params: validateParams,
  handler: handleValidate,
});

interface ValidationIssue {
  severity: "error" | "warning" | "info";
  kind: string;
  message: string;
  file?: string;
  repair?: string;
  safeToAutoRepair?: boolean;
}

const VALID_CHECKS = [
  "all",
  "sourcefiles",
  "status-drift",
  "diagrams",
  "agents-md",
  "knowledge-health",
] as const;
type CheckName = (typeof VALID_CHECKS)[number];

const STALE_KNOWLEDGE_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseChecks(raw: string | undefined): Set<CheckName> {
  if (!raw || raw === "all") return new Set(VALID_CHECKS);
  const parts = raw.split(",").map((s) => s.trim()) as CheckName[];
  return new Set(parts);
}

/**
 * Core validation logic — exported for reuse by the `audit` alias command.
 */
export async function runValidation(slug: string, checks: Set<CheckName>): Promise<CLIResult> {
  const projectDir = getProjectDir(slug);
  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
      hint: "Run 'arcs project list' to see available projects.",
    });
  }

  const metaPath = resolve(projectDir, "meta.json");
  let workspacePaths: string[] = [];
  try {
    const rawMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
    workspacePaths = rawMeta.workspacePaths ?? [];
  } catch {
    // continue with empty workspace paths
  }

  const issues: ValidationIssue[] = [];
  let totalChecks = 0;

  // Check 1: Knowledge sourceFiles exist
  if (checks.has("all") || checks.has("sourcefiles")) {
    const knowledgeIndex = await readKnowledgeIndex(projectDir);
    for (const entry of knowledgeIndex.entries) {
      const sourceFiles = entry.sourceFiles ?? [];
      for (const ref of sourceFiles) {
        totalChecks++;
        const found = workspacePaths.some((ws) => existsSync(resolve(ws, ref.path)));
        if (!found && workspacePaths.length > 0) {
          issues.push({
            severity: "warning",
            kind: "stale_knowledge_source",
            message: `Knowledge entry "${entry.title}" references missing file: ${ref.path}`,
            file: ref.path,
            repair: `Remove stale sourceFile reference from knowledge entry "${entry.id}"`,
            safeToAutoRepair: false,
          });
        }
      }
    }
  }

  // Check 2: AGENTS.md exists in workspace paths
  if (checks.has("all") || checks.has("agents-md")) {
    for (const ws of workspacePaths) {
      totalChecks++;
      const agentsPath = resolve(ws, "AGENTS.md");
      if (!existsSync(agentsPath)) {
        issues.push({
          severity: "info",
          kind: "missing_agents_md",
          message: `No AGENTS.md found at workspace path: ${ws}`,
          file: agentsPath,
          repair: `Run: arcs sync-agents-md ${slug} --analysis-file=<path>`,
          safeToAutoRepair: true,
        });
      }
    }
  }

  // Check 3: Plan diagrams
  if (checks.has("all") || checks.has("diagrams")) {
    const planIndex = await readPlanIndex(projectDir);
    const plansDir = resolve(projectDir, "plans");
    const activeStatuses = ["planned", "in_progress", "blocked"];

    for (const plan of planIndex.plans) {
      if (!activeStatuses.includes(plan.status)) continue;
      totalChecks++;
      const diagramPath = resolve(plansDir, `${plan.normalizedId}.diagram.mmd`);
      if (!existsSync(diagramPath)) {
        issues.push({
          severity: "info",
          kind: "missing_plan_diagram",
          message: `Active plan "${plan.title}" has no diagram file`,
          file: diagramPath,
          repair: `Create diagram for plan "${plan.id}" using to-diagram skill`,
          safeToAutoRepair: false,
        });
      }
    }
  }

  // Check 4: Plan status vs task completion
  if (checks.has("all") || checks.has("status-drift")) {
    const planIndex = await readPlanIndex(projectDir);
    const plansDir = resolve(projectDir, "plans");
    const activeStatuses = ["planned", "in_progress", "blocked"];
    const allTasks = await listTasks(projectDir);

    for (const plan of planIndex.plans) {
      if (!activeStatuses.includes(plan.status)) continue;
      const planTasks = allTasks.filter((t) => t.planId === plan.id);
      if (planTasks.length === 0) continue;
      totalChecks++;
      const allDone =
        planTasks.every((t) => t.status === "done") &&
        !planTasks.some((t) => t.status === "cancelled");
      if (allDone) {
        issues.push({
          severity: "warning",
          kind: "plan_status_drift",
          message: `Plan "${plan.title}" is "${plan.status}" but all ${planTasks.length} tasks are done`,
          file: resolve(plansDir, `${plan.normalizedId}.meta.json`),
          repair: `Update plan "${plan.id}" status to "done"`,
          safeToAutoRepair: false,
        });
      }
    }
  }

  // Check 5: Knowledge metadata health (thin/stale) — distinct from the
  // sourcefiles check above, which flags references to MISSING files.
  if (checks.has("all") || checks.has("knowledge-health")) {
    const knowledgeIndex = await readKnowledgeIndex(projectDir);
    const now = Date.now();
    for (const entry of knowledgeIndex.entries) {
      totalChecks++;
      const missingSummary = !entry.summary || entry.summary.trim().length === 0;
      const missingSourceFiles = !entry.sourceFiles || entry.sourceFiles.length === 0;
      if (missingSummary || missingSourceFiles) {
        const missing: string[] = [];
        if (missingSummary) missing.push("summary");
        if (missingSourceFiles) missing.push("source-files");
        issues.push({
          severity: "warning",
          kind: "thin_knowledge",
          message: `Knowledge entry "${entry.title}" is thin: missing ${missing.join(", ")}`,
          repair: `Enrich knowledge entry "${entry.id}" with summary and source-files`,
          safeToAutoRepair: false,
        });
      }
      if (entry.updatedAt) {
        const ageDays = Math.floor((now - new Date(entry.updatedAt).getTime()) / MS_PER_DAY);
        if (ageDays > STALE_KNOWLEDGE_DAYS) {
          issues.push({
            severity: "info",
            kind: "stale_knowledge",
            message: `Knowledge entry "${entry.title}" is stale: not updated in ${ageDays} days`,
            repair: `Review and refresh knowledge entry "${entry.id}"`,
            safeToAutoRepair: false,
          });
        }
      }
      const bodyPath = resolve(projectDir, entry.file);
      const body = existsSync(bodyPath) ? await readFile(bodyPath, "utf-8") : "";
      if (isBodyShallow(body)) {
        issues.push({
          severity: "warning",
          kind: "shallow_knowledge",
          message: `Knowledge entry "${entry.title}" is shallow: body has ${extractBodyContentLength(body)} chars of real content (floor ${SHALLOW_BODY_MIN_CHARS}) — fill the kind's template sections`,
          repair: `Enrich the body of "${entry.id}" — scaffold with: arcs knowledge template --kind=${entry.kind}`,
          safeToAutoRepair: false,
        });
      }
    }
  }

  return success({
    issues,
    summary: {
      totalChecks,
      issueCount: issues.length,
      bySeverity: {
        error: issues.filter((i) => i.severity === "error").length,
        warning: issues.filter((i) => i.severity === "warning").length,
        info: issues.filter((i) => i.severity === "info").length,
      },
    },
  });
}

async function handleValidate(
  params: ParsedParams<typeof validateParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const checks = parseChecks(params.checks);
  return runValidation(slug, checks);
}
