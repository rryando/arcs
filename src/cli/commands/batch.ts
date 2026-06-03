// ---------------------------------------------------------------------------
// Batch command — registry-based
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { attemptDiagramUpdate } from "../../utils/diagram-store.js";
import { getProjectDir } from "../../utils/paths.js";
import { PROJECT_DOC_FILES, type ProjectDocType } from "../../utils/project-documents.js";
import {
  createKnowledgeEntry,
  createPlan,
  createTask,
  deleteKnowledgeEntry,
  deletePlan,
  deleteTask,
  type FileRef,
  type KnowledgeKind,
  type PlanStatus,
  type TaskPriority,
  type TaskStatus,
  updateKnowledgeEntry,
  updatePlan,
  updateTask,
} from "../../utils/project-memory.js";
import { normalizeIdentifier } from "../../utils/slug.js";
import { readStdin } from "../../utils/stdin.js";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { failure, success } from "../output-envelope.js";

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------

interface BatchOp {
  op: string;
  slug: string;
  [key: string]: unknown;
}

interface BatchResult {
  index: number;
  op: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

interface BatchOpInfo {
  canonical: string;
  description: string;
}

const BATCH_OPS: BatchOpInfo[] = [
  { canonical: "task-create", description: "Create a new task" },
  { canonical: "task-transition", description: "Transition task status" },
  { canonical: "task-update", description: "Update task metadata" },
  { canonical: "knowledge-create", description: "Create a knowledge entry" },
  { canonical: "knowledge-update-meta", description: "Update knowledge entry metadata" },
  { canonical: "knowledge-update-body", description: "Update knowledge entry body" },
  { canonical: "plan-create", description: "Create a plan" },
  { canonical: "plan-update-meta", description: "Update plan metadata" },
  { canonical: "plan-delete", description: "Delete a plan" },
  { canonical: "task-delete", description: "Delete a task" },
  { canonical: "knowledge-delete", description: "Delete a knowledge entry" },
  { canonical: "doc-update", description: "Update a project document" },
];

/**
 * Validate that a batch op name is one of the canonical kebab-case
 * operations. No alias resolution — legacy `tool:` / `cli:` / snake_case
 * names are rejected with a clear error downstream.
 */
function normalizeBatchOp(op: string): string {
  return op;
}

const batchParams = {
  file: {
    type: "string",
    required: (params) => !params["list-ops"] && !params.stdin,
    description: "Path to JSON file with operations",
  },
  stdin: { type: "boolean", required: false, description: "Read operations JSON from stdin" },
  "list-ops": { type: "boolean", description: "List valid batch operations" },
  "fail-fast": {
    type: "boolean",
    required: false,
    description: "Abort on first operation failure",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "batch",
  description: "Run batch operations from a JSON file",
  mutation: true,
  params: batchParams,
  handler: handleBatch,
});

async function handleBatch(
  params: ParsedParams<typeof batchParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const listOps = params["list-ops"];
  if (listOps) {
    return success({ ops: BATCH_OPS });
  }

  const failFast = params["fail-fast"];
  const stdinFlag = params.stdin;
  const filePath = params.file;

  if (!filePath && !stdinFlag) {
    return failure("missing_param", "Either --file or --stdin is required", {
      usage: "arcs batch --file=<path> or arcs batch --stdin",
    });
  }

  let ops: BatchOp[];
  try {
    let raw: string;
    if (stdinFlag) {
      raw = await readStdin();
    } else {
      if (!existsSync(filePath!)) {
        return failure("file_not_found", `Batch file not found: ${filePath}`);
      }
      raw = readFileSync(filePath!, "utf-8");
    }
    ops = JSON.parse(raw);
    if (!Array.isArray(ops)) {
      return failure("invalid_format", "Batch input must contain a JSON array");
    }
  } catch (err) {
    return failure(
      "parse_error",
      `Failed to parse batch input: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const results: BatchResult[] = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    op.op = normalizeBatchOp(op.op);
    // Unwrap nested params format: {op, params:{...}} → flat {op, ...}
    if (op.params && typeof op.params === "object") {
      Object.assign(op, op.params);
      delete op.params;
    }
    try {
      switch (op.op) {
        case "task-transition": {
          const projectDir = getProjectDir(op.slug);
          const taskId = op.taskId as string;
          const status = op.status as TaskStatus;
          if (!taskId || !status) throw new Error("taskId and status required");
          await updateTask(projectDir, { id: taskId, status });

          // Atomic diagram update if both planId and diagramNodeId provided
          const planId = op.planId as string | undefined;
          const diagramNodeId = op.diagramNodeId as string | undefined;
          if (planId && diagramNodeId) {
            const diagramResult = attemptDiagramUpdate(op.slug, planId, diagramNodeId, status);
            results.push({
              index: i,
              op: op.op,
              success: true,
              result: { taskId, status, diagramNodeId, ...diagramResult },
            });
          } else {
            results.push({ index: i, op: op.op, success: true, result: { taskId, status } });
          }
          break;
        }
        case "task-create": {
          const projectDir = getProjectDir(op.slug);
          const title = op.title as string;
          if (!title) throw new Error("title required");
          const task = await createTask(projectDir, {
            title,
            status: op.status as TaskStatus | undefined,
            priority: op.priority as TaskPriority | undefined,
            planId: op.planId as string | undefined,
            sourceFiles: op.sourceFiles as FileRef[] | undefined,
          });
          results.push({ index: i, op: op.op, success: true, result: { taskId: task.id } });
          break;
        }
        case "task-update": {
          const projectDir = getProjectDir(op.slug);
          const taskId = op.taskId as string;
          if (!taskId) throw new Error("taskId required");
          const task = await updateTask(projectDir, {
            id: taskId,
            title: op.title as string | undefined,
            status: op.status as TaskStatus | undefined,
            priority: op.priority as TaskPriority | undefined,
            planId: op.planId as string | null | undefined,
            sourceFiles: op.sourceFiles as FileRef[] | undefined,
          });
          results.push({
            index: i,
            op: op.op,
            success: true,
            result: { taskId: task.id, status: task.status },
          });
          break;
        }
        case "knowledge-create": {
          const projectDir = getProjectDir(op.slug);
          const title = op.title as string;
          const kind = op.kind as KnowledgeKind;
          if (!title || !kind) throw new Error("title and kind required");
          const id = normalizeIdentifier(title);
          const entry = await createKnowledgeEntry(projectDir, {
            id,
            title,
            kind,
            keywords: (op.keywords as string[]) ?? [],
            content: op.body as string | undefined,
          });
          results.push({ index: i, op: op.op, success: true, result: { id: entry.id } });
          break;
        }
        case "knowledge-update-meta": {
          const projectDir = getProjectDir(op.slug);
          const entryId2 = op.entryId as string;
          if (!entryId2) throw new Error("entryId required");
          const entry = await updateKnowledgeEntry(projectDir, {
            id: entryId2,
            title: op.title as string | undefined,
            kind: op.kind as KnowledgeKind | undefined,
            summary: op.summary as string | undefined,
            keywords: op.keywords as string[] | undefined,
            sourceFiles: op.sourceFiles as FileRef[] | undefined,
          });
          results.push({ index: i, op: op.op, success: true, result: { entryId: entry.id } });
          break;
        }
        case "knowledge-update-body": {
          const projectDir = getProjectDir(op.slug);
          const entryId = op.entryId as string;
          const body = op.body as string;
          if (!entryId || !body) throw new Error("entryId and body required");
          const normalizedId2 = normalizeIdentifier(entryId);
          const metaPath2 = resolve(projectDir, "knowledge", `${normalizedId2}.meta.json`);
          if (!existsSync(metaPath2)) throw new Error(`knowledge entry not found: ${entryId}`);
          const rawMeta2 = JSON.parse(readFileSync(metaPath2, "utf-8"));
          const bodyPath = resolve(projectDir, rawMeta2.file);
          await writeFile(bodyPath, body, "utf-8");
          results.push({ index: i, op: op.op, success: true, result: { entryId } });
          break;
        }
        case "plan-create": {
          const projectDir = getProjectDir(op.slug);
          const title = op.title as string;
          if (!title) throw new Error("title required");
          const planId = normalizeIdentifier(title);
          const plan = await createPlan(projectDir, {
            id: planId,
            title,
            status: (op.status as PlanStatus) ?? "proposed",
            keywords: (op.keywords as string[]) ?? [],
            summary: op.summary as string | undefined,
            content: op.body as string | undefined,
            sourceFiles: op.sourceFiles as FileRef[] | undefined,
          });
          results.push({ index: i, op: op.op, success: true, result: { planId: plan.id } });
          break;
        }
        case "plan-update-meta": {
          const projectDir = getProjectDir(op.slug);
          const planId = op.planId as string;
          if (!planId) throw new Error("planId required");
          const plan = await updatePlan(projectDir, {
            id: planId,
            title: op.title as string | undefined,
            status: op.status as PlanStatus | undefined,
            summary: op.summary as string | undefined,
            keywords: op.keywords as string[] | undefined,
            sourceFiles: op.sourceFiles as FileRef[] | undefined,
          });
          results.push({
            index: i,
            op: op.op,
            success: true,
            result: { planId: plan.id, status: plan.status },
          });
          break;
        }
        case "doc-update": {
          const projectDir = getProjectDir(op.slug);
          const docType = (op.doc ?? op.docType) as ProjectDocType;
          const content = (op.content ?? op.body) as string;
          if (!docType || !content) throw new Error("docType and content required");
          const docFile = PROJECT_DOC_FILES[docType];
          if (!docFile) throw new Error(`Unknown doc type: ${docType}`);
          const docPath = resolve(projectDir, docFile);
          await writeFile(docPath, content, "utf-8");
          results.push({ index: i, op: op.op, success: true, result: { docType } });
          break;
        }
        case "task-delete": {
          const projectDir = getProjectDir(op.slug);
          const taskId = op.taskId as string;
          if (!taskId) throw new Error("taskId required");
          await deleteTask(projectDir, taskId);
          results.push({ index: i, op: op.op, success: true, result: { deleted: taskId } });
          break;
        }
        case "knowledge-delete": {
          const projectDir = getProjectDir(op.slug);
          const entryId = op.entryId as string;
          if (!entryId) throw new Error("entryId required");
          await deleteKnowledgeEntry(projectDir, entryId);
          results.push({ index: i, op: op.op, success: true, result: { deleted: entryId } });
          break;
        }
        case "plan-delete": {
          const projectDir = getProjectDir(op.slug);
          const planId = op.planId as string;
          if (!planId) throw new Error("planId required");
          await deletePlan(projectDir, planId);
          results.push({ index: i, op: op.op, success: true, result: { deleted: planId } });
          break;
        }
        default:
          results.push({ index: i, op: op.op, success: false, error: `Unknown op: ${op.op}` });
          if (failFast) {
            return success({ results, abortedAt: i, totalOps: ops.length, completed: false });
          }
      }
    } catch (err) {
      const opResult: BatchResult = {
        index: i,
        op: op.op,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
      results.push(opResult);
      if (failFast) {
        return success({ results, abortedAt: i, totalOps: ops.length, completed: false });
      }
    }
  }

  return success(results);
}
