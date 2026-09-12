/**
 * Persistence for completion receipts.
 *
 * A receipt is stored as a sidecar pair under the project's data directory:
 *
 *   <dataRoot>/projects/<slug>/reports/<taskId|planId>.json   — the Receipt
 *   <dataRoot>/projects/<slug>/reports/<taskId|planId>.diff   — the raw diff
 *
 * The engine (`run-report.ts`) produces the Receipt; this module only writes,
 * reads and lists them. It performs no git calls and never contacts a remote.
 * Filesystem writes are synchronous by design: `writeReceipt` returns the
 * `TaskReportRef` pointer directly (not a promise), matching its contract and
 * the small, one-shot nature of a completion write.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readJsonSafeSync } from "./json.js";
import type { Receipt, TaskReportRef } from "./run-report.js";
import { normalizeIdentifier } from "./slug.js";

/**
 * Per-task attribution recorded on a PLAN receipt: how each of the plan's
 * tasks contributed to the aggregate base→head range. `commit` is the head
 * sha the task itself completed at, and the file/line stats come from the
 * task's own persisted receipt when one exists (so no diffs are recomputed).
 */
export interface PlanTaskAttribution {
  taskId: string;
  startHead?: string;
  commit?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

/**
 * A receipt as persisted on disk. Identical to {@link Receipt} plus the
 * optional plan-level {@link PlanTaskAttribution}, so every existing reader of
 * `Receipt` keeps working unchanged.
 */
export interface StoredReceipt extends Receipt {
  taskAttribution?: PlanTaskAttribution[];
}

/** Directory holding a project's receipts. */
export function reportsDir(dataRoot: string, slug: string): string {
  return join(dataRoot, "projects", slug, "reports");
}

/**
 * Resolve the storage id: explicit option > the receipt's own task/plan id.
 * Normalized the same way every other store normalizes identifiers so that a
 * write and a later read agree on the file name.
 */
function resolveId(opts: { taskId?: string; planId?: string }, receipt: Receipt): string | null {
  const raw = opts.taskId ?? opts.planId ?? receipt.taskId ?? receipt.planId;
  if (raw === undefined) return null;
  const id = normalizeIdentifier(raw);
  return id === "" ? null : id;
}

/**
 * Write a receipt and its `.diff` sidecar, returning the pointer at them.
 * `reportFile`/`diffFile` are paths relative to `dataRoot`. Throws only when
 * no task/plan id is available to name the files.
 */
export function writeReceipt(
  dataRoot: string,
  slug: string,
  receipt: Receipt,
  opts: { taskId?: string; planId?: string; taskAttribution?: PlanTaskAttribution[] } = {},
): TaskReportRef {
  const id = resolveId(opts, receipt);
  if (id === null) {
    throw new Error("writeReceipt requires a taskId or planId to name the receipt files");
  }

  const dir = reportsDir(dataRoot, slug);
  mkdirSync(dir, { recursive: true });

  const reportPath = join(dir, `${id}.json`);
  const diffPath = join(dir, `${id}.diff`);
  const stored: StoredReceipt =
    opts.taskAttribution !== undefined
      ? { ...receipt, taskAttribution: opts.taskAttribution }
      : receipt;
  writeFileSync(reportPath, `${JSON.stringify(stored, null, 2)}\n`, "utf-8");
  writeFileSync(diffPath, receipt.diff, "utf-8");

  return {
    ...(receipt.headSha !== "" && { commit: receipt.headSha }),
    ...(receipt.branch !== "" && { branch: receipt.branch }),
    ...(receipt.baseRef !== "" && { baseRef: receipt.baseRef }),
    ...(receipt.url !== null && { url: receipt.url }),
    filesChanged: receipt.filesChanged,
    insertions: receipt.insertions,
    deletions: receipt.deletions,
    reportFile: relative(dataRoot, reportPath),
    diffFile: relative(dataRoot, diffPath),
    truncated: receipt.diffTruncated,
    capturedAt: receipt.capturedAt,
  };
}

/** Read one receipt, or null when it is missing or unparseable. Never throws. */
export function readReceipt(dataRoot: string, slug: string, id: string): StoredReceipt | null {
  const norm = normalizeIdentifier(id);
  if (norm === "") return null;
  return readJsonSafeSync<StoredReceipt>(join(reportsDir(dataRoot, slug), `${norm}.json`)) ?? null;
}

/**
 * List every receipt for a project, oldest first (ties broken by file name).
 * A missing directory or an unparseable file yields an empty/short list rather
 * than an error.
 */
export function listReceipts(dataRoot: string, slug: string): Receipt[] {
  const dir = reportsDir(dataRoot, slug);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const receipts: Receipt[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const parsed = readJsonSafeSync<Receipt>(join(dir, name));
    if (parsed !== undefined) receipts.push(parsed);
  }
  receipts.sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0));
  return receipts;
}
