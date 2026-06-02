// ---------------------------------------------------------------------------
// Project commands — registry-based
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type RootMeta, readRootMeta, writeRootMeta } from "../../utils/dag.js";
import { readJsonSafe } from "../../utils/json.js";
import { getDataDir, getProjectDir } from "../../utils/paths.js";
import { PROJECT_DOC_FILES, type ProjectDocType } from "../../utils/project-documents.js";
import {
  createTask,
  listTasks,
  readKnowledgeIndex,
  readPlanIndex,
} from "../../utils/project-memory.js";
import { quickScan } from "../../utils/quick-scan.js";
import { slugify } from "../../utils/slug.js";
import { getTemplatePath, renderTemplate } from "../../utils/template.js";
import { normalizeWorkspacePath } from "../../utils/workspace-match.js";
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
// project list
// ---------------------------------------------------------------------------

const projectListParams = {} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "project list",
  description: "List all tracked projects",
  params: projectListParams,
  handler: handleProjectList,
});

async function handleProjectList(
  _params: ParsedParams<typeof projectListParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const dataDir = getDataDir();
  let rootMeta: RootMeta;
  try {
    rootMeta = await readRootMeta(dataDir);
  } catch {
    return failure("read_error", "Could not read ARCS data directory");
  }

  const projects = [];
  for (const node of rootMeta.projects) {
    const metaPath = resolve(dataDir, "projects", node.id, "meta.json");
    let description = "";
    if (existsSync(metaPath)) {
      const raw = await readJsonSafe<Record<string, unknown>>(metaPath);
      if (raw && typeof raw.description === "string") {
        description = raw.description;
      }
    }
    projects.push({
      slug: node.id,
      name: node.name,
      status: node.status,
      description,
      dependsOn: node.dependsOn,
    });
  }

  return success(projects);
}

// ---------------------------------------------------------------------------
// project get
// ---------------------------------------------------------------------------

const projectGetParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  doc: {
    type: "string",
    description: "Specific doc to retrieve",
    enum: ["overview", "tasks", "dependencies", "knowledge"],
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "project get",
  description: "Get project metadata or a specific document",
  params: projectGetParams,
  handler: handleProjectGet,
});

async function handleProjectGet(
  params: ParsedParams<typeof projectGetParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const doc: ProjectDocType | undefined = params.doc;

  const projectDir = getProjectDir(slug);
  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
      hint: "Run 'arcs project list' to see available projects.",
    });
  }

  if (doc) {
    const fileName = PROJECT_DOC_FILES[doc];
    if (!fileName) {
      return failure(
        ERROR_CODES.INVALID_ENUM,
        `Invalid doc type "${doc}". Valid: overview, tasks, dependencies, knowledge`,
      );
    }
    const filePath = resolve(projectDir, fileName);
    if (!existsSync(filePath)) {
      return failure(ERROR_CODES.ENTITY_NOT_FOUND, `Doc file not found: ${fileName}`);
    }
    const content = await readFile(filePath, "utf-8");
    return success({ slug, doc, content });
  }

  // Return project metadata
  const metaPath = resolve(projectDir, "meta.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  return success(meta);
}

// ---------------------------------------------------------------------------
// project init
// ---------------------------------------------------------------------------

const projectInitParams = {
  name: { type: "string", required: true, positional: 0, description: "Project name" },
  description: { type: "string", required: true, description: "Project description" },
  path: { type: "string", description: "Workspace path to associate" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "project init",
  description: "Initialize a new project",
  mutation: true,
  params: projectInitParams,
  handler: handleProjectInit,
});

async function handleProjectInit(
  params: ParsedParams<typeof projectInitParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const name = params.name;
  const description = params.description;
  const wsPath = params.path;

  const slug = slugify(name);

  if (flags.dryRun) {
    return success({
      dryRun: true,
      wouldCreate: { slug, name, description, path: wsPath ?? process.cwd() },
    });
  }

  const dataDir = getDataDir();
  const projectDir = resolve(dataDir, "projects", slug);

  try {
    const rootMeta = await readRootMeta(dataDir);

    if (rootMeta.projects.some((p) => p.id === slug)) {
      return failure("already_exists", `Project "${slug}" already exists`);
    }

    await mkdir(projectDir, { recursive: true });

    const now = new Date().toISOString();
    const variables: Record<string, string> = {
      id: slug,
      name,
      description,
      repoUrl: "",
      status: "draft",
      createdAt: now,
      dependsOnList: "—",
      statusBlock: "**Status:** draft\n",
      repoBlock: "",
      upstreamBlock: "- None",
    };

    const templates = [
      { tmpl: "project-meta.json.tmpl", out: "meta.json" },
      { tmpl: "project.md.tmpl", out: "overview.md" },
      { tmpl: "task.md.tmpl", out: "tasks.md" },
      { tmpl: "dependency.md.tmpl", out: "dependencies.md" },
      { tmpl: "knowledge.md.tmpl", out: "knowledge.md" },
    ];

    for (const { tmpl, out } of templates) {
      const content = renderTemplate(getTemplatePath(tmpl), variables);
      await writeFile(resolve(projectDir, out), content, "utf-8");
    }

    // Inject workspacePaths
    const metaJsonPath = resolve(projectDir, "meta.json");
    const metaObj = JSON.parse(readFileSync(metaJsonPath, "utf-8"));
    metaObj.workspacePaths = [normalizeWorkspacePath(wsPath ?? process.cwd())];
    await writeFile(metaJsonPath, JSON.stringify(metaObj, null, 2), "utf-8");

    // Create indexes
    await mkdir(resolve(projectDir, "plans"), { recursive: true });
    await mkdir(resolve(projectDir, "knowledge"), { recursive: true });
    await mkdir(resolve(projectDir, "tasks"), { recursive: true });
    await writeFile(
      resolve(projectDir, "plans", "index.json"),
      JSON.stringify({ plans: [] }, null, 2),
      "utf-8",
    );
    await writeFile(
      resolve(projectDir, "knowledge", "index.json"),
      JSON.stringify({ entries: [] }, null, 2),
      "utf-8",
    );
    await writeFile(
      resolve(projectDir, "tasks", "index.json"),
      JSON.stringify({ tasks: [] }, null, 2),
      "utf-8",
    );

    // Update root meta
    rootMeta.projects.push({ id: slug, name, status: "draft", dependsOn: [] });
    await writeRootMeta(dataDir, rootMeta);

    // Graphify: extract code graph and seed structural proposals (non-fatal)
    // Only attempt if workspace looks like a real codebase (has .git or package.json)
    // Skip when ARCS_SKIP_GRAPHIFY=1 (used in tests to avoid spawning real binaries)
    let graphify: {
      proposed: number;
      pending_enrichment?: true;
      hint?: string;
      hooksHint?: string;
    } | null = null;
    const graphifyWorkspace = wsPath ?? process.cwd();
    const hasGit = existsSync(resolve(graphifyWorkspace, ".git"));
    const looksLikeCodebase = hasGit || existsSync(resolve(graphifyWorkspace, "package.json"));
    const skipGraphify = process.env.ARCS_SKIP_GRAPHIFY === "1";
    if (looksLikeCodebase && !skipGraphify) {
      try {
        const { detectGraphify, runExtraction, ingestGraph } = await import(
          "../../utils/graphify.js"
        );
        const { writeProposalsFile } = await import("../../utils/graphify-knowledge.js");
        const info = detectGraphify();
        if (info.available) {
          const extraction = runExtraction(graphifyWorkspace);
          if (extraction.success) {
            const { proposals, stats } = ingestGraph(extraction.graphJsonPath, slug);
            if (proposals.length > 0) {
              const graphJsonContent = await readFile(extraction.graphJsonPath, "utf-8");
              await writeProposalsFile(slug, proposals, graphJsonContent);
              graphify = {
                proposed: stats.totalProposals,
                pending_enrichment: true,
                hint: "Run `arcs proposal list <slug> --json` from a skill-aware host to enrich proposals into knowledge entries. Or run `arcs proposal list <slug>` to inspect.",
              };
            } else {
              graphify = { proposed: 0 };
            }
            // Offer git hook for auto-refresh on commit
            if (hasGit) {
              graphify.hooksHint =
                "Run `graphify hook install` in the workspace to auto-refresh the code graph on each commit.";
            }
          }
        }
      } catch {
        // Graphify failure never blocks project init
      }
    }

    // Quick scan: extract git context and auto-create initial tasks (non-fatal)
    // Skip when ARCS_SKIP_QUICK_SCAN=1 (used in tests)
    let quickScanResult: { tasksCreated: number; suggestedTasks: string[] } | null = null;
    const skipQuickScan = process.env.ARCS_SKIP_QUICK_SCAN === "1";
    if (!skipQuickScan) {
      try {
        const scanWorkspace = wsPath ?? process.cwd();
        const scan = quickScan(scanWorkspace);
        let tasksCreated = 0;
        for (const title of scan.suggestedTasks.slice(0, 5)) {
          try {
            await createTask(projectDir, { title, status: "backlog", priority: "medium" });
            tasksCreated++;
          } catch {
            // Skip duplicate or invalid tasks silently
          }
        }
        if (tasksCreated > 0 || scan.suggestedTasks.length > 0) {
          quickScanResult = { tasksCreated, suggestedTasks: scan.suggestedTasks };
        }
      } catch {
        // Quick scan failure never blocks project init
      }
    }

    return success({
      slug,
      name,
      status: "draft",
      dependsOn: [],
      graphify,
      quickScan: quickScanResult,
    });
  } catch (err) {
    return failure("init_error", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// project validate
// ---------------------------------------------------------------------------

const projectValidateParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "project validate",
  description: "Run structural health checks on a project",
  params: projectValidateParams,
  handler: handleProjectValidate,
});

interface ValidationIssue {
  severity: "error" | "warning" | "info";
  kind: string;
  message: string;
  file?: string;
  repair?: string;
  safeToAutoRepair: boolean;
}

async function handleProjectValidate(
  params: ParsedParams<typeof projectValidateParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;

  const projectDir = getProjectDir(slug);
  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`);
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

  // Check 2: AGENTS.md exists in workspace paths
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

  // Check 3: Plan diagrams
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

  // Check 4: Plan status vs task completion
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

  const report = {
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
  };

  return success(report);
}
