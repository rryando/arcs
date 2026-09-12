// ---------------------------------------------------------------------------
// report — read-only access to persisted completion receipts
//
// `arcs done` captures a completion receipt (base/head shas, branch, commit
// link, diffstat, capped diff) and stores it under the project's data dir.
// These commands read it back without ever re-running git or touching a remote.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { getDataDir } from "../../utils/paths.js";
import { getTask } from "../../utils/project-memory.js";
import { resolveProject } from "../../utils/project-resolver.js";
import { listReceipts, readReceipt } from "../../utils/report-store.js";
import type { TaskReportRef } from "../../utils/run-report.js";
import { normalizeIdentifier } from "../../utils/slug.js";
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
// report get
// ---------------------------------------------------------------------------

const reportGetParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  taskId: {
    type: "string",
    required: true,
    positional: 1,
    description: "Task ID (or the receipt id) to look up",
  },
  planId: {
    type: "string",
    description: "Plan ID — fallback receipt id when no task receipt exists",
  },
  diff: { type: "boolean", description: "Include the capped unified diff body" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "report get",
  description: "Show a stored completion receipt",
  params: reportGetParams,
  handler: handleReportGet,
});

async function handleReportGet(
  params: ParsedParams<typeof reportGetParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const { taskId, planId } = params;
  const includeDiff = params.diff === true;

  const resolved = await resolveProject(params.slug);
  if (!resolved.ok) return resolved.result;
  const { slug, projectDir } = resolved;

  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
      hint: "Run 'arcs project list' to see available projects.",
    });
  }

  const dataRoot = getDataDir();
  let receipt = readReceipt(dataRoot, slug, taskId);
  if (receipt === null && planId !== undefined) {
    receipt = readReceipt(dataRoot, slug, planId);
  }
  if (receipt === null) {
    return failure(ERROR_CODES.ENTITY_NOT_FOUND, `No completion receipt found for "${taskId}"`, {
      hint: `Run the task to completion to capture a receipt, or check 'arcs report list ${slug}'.`,
    });
  }

  let meta: TaskReportRef | undefined;
  try {
    meta = (await getTask(projectDir, taskId)).report;
  } catch {
    meta = undefined;
  }

  return success({
    slug,
    taskId,
    ...(planId !== undefined ? { planId } : {}),
    ...(meta ? { meta } : {}),
    receipt: {
      repoRoot: receipt.repoRoot,
      baseRef: receipt.baseRef,
      baseSha: receipt.baseSha,
      headSha: receipt.headSha,
      branch: receipt.branch,
      remoteUrl: receipt.remoteUrl,
      url: receipt.url,
      filesChanged: receipt.filesChanged,
      insertions: receipt.insertions,
      deletions: receipt.deletions,
      truncated: receipt.diffTruncated,
      capturedAt: receipt.capturedAt,
      // Snapshot markers, copied through unchanged. Omitted for legacy
      // receipts captured before working-tree snapshots existed.
      ...(receipt.dirty !== undefined ? { dirty: receipt.dirty } : {}),
      ...(receipt.untracked !== undefined ? { untracked: receipt.untracked } : {}),
    },
    // The stored diff is already capped by captureReceipt; still only emitted
    // on request so the default envelope stays small.
    ...(includeDiff ? { diff: receipt.diff } : {}),
  });
}

// ---------------------------------------------------------------------------
// report list
// ---------------------------------------------------------------------------

const reportListParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "report list",
  description: "List stored completion receipts for a project",
  params: reportListParams,
  handler: handleReportList,
});

async function handleReportList(
  params: ParsedParams<typeof reportListParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const resolved = await resolveProject(params.slug);
  if (!resolved.ok) return resolved.result;
  const { slug, projectDir } = resolved;

  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
      hint: "Run 'arcs project list' to see available projects.",
    });
  }

  const receipts = listReceipts(getDataDir(), slug).map((r) => {
    const rawId = r.taskId ?? r.planId ?? "";
    return {
      id: rawId === "" ? "" : normalizeIdentifier(rawId),
      ...(r.taskId !== undefined ? { taskId: r.taskId } : {}),
      ...(r.planId !== undefined ? { planId: r.planId } : {}),
      headSha: r.headSha,
      ...(r.url !== null ? { url: r.url } : {}),
      filesChanged: r.filesChanged,
      insertions: r.insertions,
      deletions: r.deletions,
      truncated: r.diffTruncated,
      capturedAt: r.capturedAt,
      ...(r.dirty !== undefined ? { dirty: r.dirty } : {}),
      ...(r.untracked !== undefined ? { untracked: r.untracked } : {}),
    };
  });

  return success(receipts);
}
