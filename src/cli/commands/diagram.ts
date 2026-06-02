// ---------------------------------------------------------------------------
// Diagram commands — registry-based
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { generateDiagramFromTasks } from "../../utils/diagram-generator.js";
import {
  findDiagramScript,
  resolveDiagramPath,
  runDiagramScript,
} from "../../utils/diagram-store.js";
import { getProjectDir } from "../../utils/paths.js";
import { listTasks } from "../../utils/project-memory.js";
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
// Helpers
// ---------------------------------------------------------------------------

function requireScript(): CLIResult | string {
  const scriptPath = findDiagramScript();
  if (!scriptPath) {
    return failure(
      "script_not_found",
      "manage-diagram.mjs not found. Install ARCS OpenCode bundle: arcs setup",
    );
  }
  return scriptPath;
}

function requireDiagramFile(slug: string, planId: string): CLIResult | string {
  const diagramPath = resolveDiagramPath(slug, planId);
  if (!existsSync(diagramPath)) {
    return failure(
      ERROR_CODES.ENTITY_NOT_FOUND,
      `No diagram found for plan "${planId}" in project "${slug}". Create one via brainstorm workflow.`,
    );
  }
  return diagramPath;
}

function parseScriptOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return { output };
  }
}

// ---------------------------------------------------------------------------
// diagram ready
// ---------------------------------------------------------------------------

const diagramReadyParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  planId: { type: "string", required: true, positional: 1, description: "Plan ID" },
} as const satisfies Record<string, ParamDef>;

interface InspectNode {
  id: string;
  status: string;
}
interface InspectEdge {
  from: string;
  to: string;
}
interface InspectShape {
  nodes: InspectNode[];
  edges: InspectEdge[];
}

interface ReadyShape {
  ready: string[];
  blocked: string[];
  inProgress: string[];
  done: string[];
}

defineCommand({
  path: "diagram ready",
  description: "Classify diagram nodes into ready/blocked/inProgress/done buckets",
  params: diagramReadyParams,
  handler: handleDiagramReady,
});

/**
 * Compute the four disjoint status buckets for a diagram by deriving them from
 * `manage-diagram.mjs inspect` output (nodes + edges + statuses). The buckets
 * partition every node in the diagram exactly once:
 *   - done       — node.status === "done"
 *   - inProgress — node.status === "inProgress"
 *   - ready      — node.status === "backlog" AND every incoming dep is done
 *   - blocked    — anything else still backlog (≥1 dep not done) OR
 *                  explicit node.status === "blocked"
 */
function classifyNodes(inspect: InspectShape): ReadyShape {
  const nodeStatus = new Map<string, string>();
  for (const n of inspect.nodes) nodeStatus.set(n.id, n.status);

  const ready: string[] = [];
  const blocked: string[] = [];
  const inProgress: string[] = [];
  const done: string[] = [];

  for (const node of inspect.nodes) {
    if (node.status === "done") {
      done.push(node.id);
      continue;
    }
    if (node.status === "inProgress") {
      inProgress.push(node.id);
      continue;
    }
    if (node.status === "blocked") {
      blocked.push(node.id);
      continue;
    }
    // backlog — depends on incoming edges
    const incoming = inspect.edges.filter((e) => e.to === node.id).map((e) => e.from);
    const allDepsDone = incoming.every((depId) => nodeStatus.get(depId) === "done");
    if (allDepsDone) ready.push(node.id);
    else blocked.push(node.id);
  }

  return { ready, blocked, inProgress, done };
}

function isInspectShape(value: unknown): value is InspectShape {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { nodes?: unknown; edges?: unknown };
  return Array.isArray(v.nodes) && Array.isArray(v.edges);
}

async function handleDiagramReady(
  params: ParsedParams<typeof diagramReadyParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const planId = params.planId;

  const diagramPath = requireDiagramFile(slug, planId);
  if (typeof diagramPath !== "string") return diagramPath;

  const scriptPath = requireScript();
  if (typeof scriptPath !== "string") return scriptPath;

  try {
    // Source nodes + edges + statuses from `inspect` so we can compute all four
    // buckets in one place. The script's own `ready` subcommand only emits the
    // bare list and is kept for direct file-level use.
    const output = runDiagramScript(scriptPath, "inspect", diagramPath);
    const parsed = parseScriptOutput(output);
    if (!isInspectShape(parsed)) {
      return failure("diagram_error", "diagram ready: inspect output missing nodes/edges arrays");
    }
    return success(classifyNodes(parsed));
  } catch (err) {
    const msg =
      err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
    return failure("diagram_error", `diagram ready failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// diagram inspect
// ---------------------------------------------------------------------------

const diagramInspectParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  planId: { type: "string", positional: 1, description: "Plan ID" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "diagram inspect",
  description: "Show diagram structure and metadata",
  params: diagramInspectParams,
  handler: handleDiagramInspect,
});

async function handleDiagramInspect(
  params: ParsedParams<typeof diagramInspectParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const planId = params.planId;

  const projectDir = getProjectDir(slug);
  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`);
  }

  if (!planId) {
    return failure(ERROR_CODES.MISSING_PARAM, "--planId is required", {
      hint: "usage: arcs diagram inspect <slug> <planId>",
    });
  }

  const diagramPath = requireDiagramFile(slug, planId);
  if (typeof diagramPath !== "string") return diagramPath;

  const scriptPath = requireScript();
  if (typeof scriptPath !== "string") return scriptPath;

  try {
    const output = runDiagramScript(scriptPath, "inspect", diagramPath);
    return success(parseScriptOutput(output));
  } catch (err) {
    const msg =
      err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
    return failure("diagram_error", `diagram inspect failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// diagram validate
// ---------------------------------------------------------------------------

const diagramValidateParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  planId: { type: "string", required: true, positional: 1, description: "Plan ID" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "diagram validate",
  description: "Validate diagram integrity",
  params: diagramValidateParams,
  handler: handleDiagramValidate,
});

async function handleDiagramValidate(
  params: ParsedParams<typeof diagramValidateParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const planId = params.planId;

  const diagramPath = requireDiagramFile(slug, planId);
  if (typeof diagramPath !== "string") return diagramPath;

  const scriptPath = requireScript();
  if (typeof scriptPath !== "string") return scriptPath;

  try {
    const output = runDiagramScript(scriptPath, "validate", diagramPath);
    return success(parseScriptOutput(output));
  } catch (err) {
    const msg =
      err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
    return failure("diagram_error", `diagram validate failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// diagram status
// ---------------------------------------------------------------------------

const diagramStatusParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  planId: { type: "string", required: true, positional: 1, description: "Plan ID" },
  nodeId: { type: "string", required: true, positional: 2, description: "Node ID to update" },
  status: {
    type: "string",
    required: true,
    positional: 3,
    description: "New status",
    enum: ["backlog", "in_progress", "done", "blocked"],
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "diagram status",
  description: "Update a diagram node's status",
  mutation: true,
  params: diagramStatusParams,
  handler: handleDiagramStatus,
});

async function handleDiagramStatus(
  params: ParsedParams<typeof diagramStatusParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const planId = params.planId;
  const nodeId = params.nodeId;
  const status = params.status;

  const diagramPath = requireDiagramFile(slug, planId);
  if (typeof diagramPath !== "string") return diagramPath;

  const scriptPath = requireScript();
  if (typeof scriptPath !== "string") return scriptPath;

  try {
    const output = runDiagramScript(scriptPath, "status", diagramPath, [nodeId, status]);
    return success(parseScriptOutput(output));
  } catch (err) {
    const msg =
      err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
    return failure("diagram_error", `diagram status failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// diagram sort-metadata
// ---------------------------------------------------------------------------

const diagramSortMetadataParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  planId: { type: "string", required: true, positional: 1, description: "Plan ID" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "diagram sort-metadata",
  description: "Sort metadata blocks in diagram file",
  mutation: true,
  params: diagramSortMetadataParams,
  handler: handleDiagramSortMetadata,
});

async function handleDiagramSortMetadata(
  params: ParsedParams<typeof diagramSortMetadataParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const planId = params.planId;

  const diagramPath = requireDiagramFile(slug, planId);
  if (typeof diagramPath !== "string") return diagramPath;

  const scriptPath = requireScript();
  if (typeof scriptPath !== "string") return scriptPath;

  try {
    const output = runDiagramScript(scriptPath, "sort-metadata", diagramPath);
    return success(parseScriptOutput(output));
  } catch (err) {
    const msg =
      err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
    return failure("diagram_error", `diagram sort-metadata failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// diagram show
// ---------------------------------------------------------------------------

const diagramShowParams = {
  path: { type: "string", required: true, positional: 0, description: "Path to .mmd file" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "diagram show",
  description: "Render diagram in terminal",
  params: diagramShowParams,
  handler: handleDiagramShow,
});

async function handleDiagramShow(
  params: ParsedParams<typeof diagramShowParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const path = params.path;

  if (!existsSync(path)) {
    return failure(ERROR_CODES.ENTITY_NOT_FOUND, `File not found: ${path}`);
  }

  try {
    const { renderDiagramShow } = await import("../diagram-renderer.js");
    const output = renderDiagramShow(path);
    return success({ output });
  } catch (err) {
    return failure("diagram_error", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// diagram init
// ---------------------------------------------------------------------------

defineCommand({
  path: "diagram init",
  description: "Generate skeleton .diagram.mmd for a plan from its existing tasks",
  params: {
    slug: { type: "string", positional: 0, required: true, description: "Project slug" },
    planId: { type: "string", positional: 1, required: true, description: "Plan ID" },
    force: { type: "boolean", description: "Overwrite existing .mmd file" },
  },
  mutation: true,
  errorCodes: ["project_not_found", "entity_not_found", "conflict"],
  handler: async (params, _flags) => {
    const { slug, planId, force } = params;
    const projectDir = getProjectDir(slug);

    try {
      await access(projectDir);
    } catch {
      return { ok: false, code: "project_not_found", message: `Project not found: ${slug}` };
    }

    const allTasks = await listTasks(projectDir);
    const planTasks = allTasks.filter((t) => t.planId === planId);
    if (planTasks.length === 0) {
      return {
        ok: false,
        code: "entity_not_found",
        message: `No tasks found for plan '${planId}' in project '${slug}'. Create tasks with --planId first.`,
      };
    }

    const diagramPath = resolveDiagramPath(slug, planId);
    if (!force) {
      try {
        await access(diagramPath);
        return {
          ok: false,
          code: "conflict",
          message: `Diagram already exists: ${diagramPath}. Use --force to overwrite.`,
        };
      } catch {
        // file does not exist — proceed
      }
    }

    const { mmd, nodes } = generateDiagramFromTasks(planId, planTasks);
    await writeFile(diagramPath, mmd, "utf-8");

    return { ok: true, data: { path: diagramPath, planId, nodeCount: nodes.length, nodes } };
  },
});
