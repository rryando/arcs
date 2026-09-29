// ---------------------------------------------------------------------------
// done — Mark a task as done and show the next task to work on
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { recordCommits, recordPending } from "../../utils/change-ledger.js";
import { type CodeChunk, deriveDiffCodeRanges, readCodeChunk } from "../../utils/code-snippet.js";
import { attemptDiagramUpdate } from "../../utils/diagram-store.js";
import { isGitRepo, listCommits } from "../../utils/git.js";
import { getDataDir } from "../../utils/paths.js";
import {
  createKnowledgeEntry,
  getTask,
  listTasks,
  readPlanIndex,
  updatePlan,
  updateTask,
} from "../../utils/project-memory.js";
import { resolveProject } from "../../utils/project-resolver.js";
import { type PlanTaskAttribution, readReceipt, writeReceipt } from "../../utils/report-store.js";
import { captureReceipt, type Receipt, type TaskReportRef } from "../../utils/run-report.js";
import { normalizeIdentifier } from "../../utils/slug.js";
import type { FileRef } from "../../utils/storage-utils.js";
import { resolveTaskRepoRoot } from "../../utils/task-store.js";
import { findWorktreeByPlan } from "../../utils/worktree-store.js";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  ERROR_CODES,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { renderMarkdown } from "../md-renderer.js";
import { failure, formatHuman, success } from "../output-envelope.js";

// ---------------------------------------------------------------------------

const doneParams = {
  slug: {
    type: "string",
    required: true,
    positional: 0,
    description: "Project slug",
  },
  taskId: {
    type: "string",
    required: true,
    positional: 1,
    description: "Task ID to mark as done",
  },
  planId: { type: "string", description: "Plan ID (enables atomic diagram update)" },
  diagramNodeId: { type: "string", description: "Diagram node ID to update (e.g. T001)" },
  learn: { type: "string", description: "Capture a quick insight linked to this task" },
  "no-report": {
    type: "boolean",
    description: "Skip completion-receipt capture entirely",
  },
  since: { type: "string", description: "Base ref for the receipt diff (overrides startHead)" },
  commit: { type: "string", description: "Head ref for the receipt diff (overrides HEAD)" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "done",
  description: "Mark a task as done and show the next task",
  mutation: true,
  params: doneParams,
  handler: handleDone,
});

// ---------------------------------------------------------------------------

/**
 * Derive code chunks for `--learn` from the receipt's OWN diff.
 *
 * Deterministic and offline: {@link deriveDiffCodeRanges} recovers the merged,
 * capped NEW-file ranges from the receipt's capped unified diff, then each
 * range is lifted from the receipt's `repoRoot` (never the CWD) with the
 * frozen `readCodeChunk`. A file that no longer exists at that path, or whose
 * range is past EOF (a truncated diff), yields no chunk and is counted in
 * `skipped` rather than failing the command.
 *
 * `headRev` is the receipt's head sha — the revision the diff ranges refer to;
 * the snippet text itself is read from the working tree at `repoRoot`, which is
 * that commit in the normal just-committed flow.
 */
async function deriveLearnChunks(
  receipt: Receipt,
): Promise<{ chunks: CodeChunk[]; sourceFiles: FileRef[]; skipped: number }> {
  const ranges = deriveDiffCodeRanges(receipt.diff);
  const chunks: CodeChunk[] = [];
  const sourceFiles: FileRef[] = [];
  let skipped = 0;

  for (const range of ranges) {
    const chunk = await readCodeChunk(
      receipt.repoRoot,
      { path: range.path, startLine: range.startLine, endLine: range.endLine },
      { headRev: receipt.headSha },
    );
    if (chunk === null) {
      skipped++;
      continue;
    }
    chunks.push(chunk);
    sourceFiles.push({
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    });
  }

  return { chunks, sourceFiles, skipped };
}

async function handleDone(
  params: ParsedParams<typeof doneParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const rawSlug = params.slug;
  const taskId = params.taskId;
  const planIdParam = params.planId;
  const diagramNodeId = params.diagramNodeId;
  const learnText = params.learn;
  const noReport = params["no-report"] === true;
  const sinceRef = params.since;
  const commitRef = params.commit;

  const resolved = await resolveProject(rawSlug);
  if (!resolved.ok) return resolved.result;

  const { slug, projectDir } = resolved;

  // Validate project directory exists
  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
      hint: "Run 'arcs project list' to see available projects.",
    });
  }

  // Get and transition the task
  let completedTask: { id: string; title: string };
  let effectivePlanId: string | undefined;
  let taskStartHead: string | undefined;
  try {
    const task = await getTask(projectDir, taskId);
    taskStartHead = task.startHead;
    effectivePlanId = planIdParam ?? task.planId;
    await updateTask(projectDir, { id: taskId, status: "done" });
    completedTask = { id: task.id, title: task.title };

    // Attempt diagram update if planId and diagramNodeId available
    if (effectivePlanId && diagramNodeId) {
      attemptDiagramUpdate(slug, effectivePlanId, diagramNodeId, "done");
    }
  } catch (err) {
    return failure(ERROR_CODES.ENTITY_NOT_FOUND, err instanceof Error ? err.message : String(err));
  }

  // Resolve the repository the work actually happened in: the task's
  // registered plan worktree when one is usable, else `workspacePaths[0]`
  // (fail-soft — see resolveTaskRepoRoot). This is the tree both the task AND
  // plan receipts describe, so a receipt for worktree work is not taken
  // against the unrelated main checkout.
  const repoRoot = await resolveTaskRepoRoot(projectDir, effectivePlanId);

  // Capture a deterministic completion receipt. This NEVER fails the command:
  // outside a git repo, with --no-report, or on a capture error the task still
  // completes and the outcome (when notable) is reported instead.
  let reportRef: TaskReportRef | undefined;
  let reportSkipped: string | undefined;
  // Kept only so `--learn` can derive code chunks from the receipt's own diff.
  let learnReceipt: Receipt | undefined;
  if (!noReport) {
    if (repoRoot === "" || !isGitRepo(repoRoot)) {
      // Workspace-less or non-git project: succeed exactly as before, silently.
    } else {
      try {
        const capture = await captureReceipt(repoRoot, {
          ...(commitRef ? { headRef: commitRef } : {}),
          ...(sinceRef ? { sinceRef } : {}),
          ...(taskStartHead ? { fallbackRef: taskStartHead } : {}),
          taskId: completedTask.id,
          ...(effectivePlanId ? { planId: effectivePlanId } : {}),
        });
        if (capture.ok) {
          learnReceipt = capture.report;
          reportRef = writeReceipt(getDataDir(), slug, capture.report, {
            taskId: completedTask.id,
            ...(effectivePlanId ? { planId: effectivePlanId } : {}),
          });
          await updateTask(projectDir, { id: taskId, report: reportRef });
        } else {
          reportSkipped = capture.reason;
        }
      } catch (err) {
        reportRef = undefined;
        reportSkipped = `could not persist receipt: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
  }

  // Derive next task
  const [allTasks, planIndex] = await Promise.all([
    listTasks(projectDir),
    readPlanIndex(projectDir),
  ]);

  const openTasks = allTasks.filter((t) => t.status !== "done" && t.status !== "cancelled");

  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sorted = [...openTasks].sort((a, b) => {
    if (a.status === "in_progress" && b.status !== "in_progress") return -1;
    if (b.status === "in_progress" && a.status !== "in_progress") return 1;
    const pa = priorityOrder[a.priority ?? "medium"] ?? 1;
    const pb = priorityOrder[b.priority ?? "medium"] ?? 1;
    return pa - pb;
  });

  const nextTask = sorted[0];
  const nextPlan = nextTask?.planId
    ? planIndex.plans.find((p) => p.id === nextTask.planId)
    : undefined;

  const nextData = nextTask
    ? { id: nextTask.id, title: nextTask.title, plan: nextPlan?.title ?? null }
    : null;

  // Plan-level completion receipt. Captured exactly once, when the task just
  // completed is the LAST open task of its plan. Like the task path it NEVER
  // fails the command: capture errors are surfaced as `planReportSkipped`.
  let planReportRef: TaskReportRef | undefined;
  let planReportSkipped: string | undefined;
  if (!noReport && effectivePlanId !== undefined) {
    const planKey = normalizeIdentifier(effectivePlanId);
    const completedKey = normalizeIdentifier(taskId);
    const planTasks = allTasks.filter(
      (t) => t.planId !== undefined && normalizeIdentifier(t.planId) === planKey,
    );
    const otherOpen = planTasks.filter(
      (t) => t.normalizedId !== completedKey && t.status !== "done" && t.status !== "cancelled",
    );

    if (planTasks.length > 0 && otherOpen.length === 0) {
      if (repoRoot === "" || !isGitRepo(repoRoot)) {
        // Non-git / workspace-less: succeed exactly as before, silently.
      } else {
        try {
          // Base-ref priority (highest first):
          //   a. explicit --since passed to `done`
          //   b. the registered plan worktree's baseCommit (worktrees.json)
          //   c. the plan's start: the first task that recorded a startHead
          //   d. the task receipt's resolved base, else captureReceipt's HEAD~1
          const worktree = await findWorktreeByPlan(projectDir, effectivePlanId);
          let planBaseRef: string | undefined;
          if (sinceRef) {
            planBaseRef = sinceRef;
          } else if (worktree?.baseCommit) {
            planBaseRef = worktree.baseCommit;
          } else {
            // planTasks preserves task-index (creation) order, so the first
            // task carrying a startHead is the plan's recorded start.
            const startHead = planTasks.find((t) => t.startHead !== undefined)?.startHead;
            planBaseRef = startHead ?? reportRef?.baseRef;
          }

          const capture = await captureReceipt(repoRoot, {
            ...(planBaseRef ? { baseRef: planBaseRef } : {}),
            ...(commitRef ? { headRef: commitRef } : {}),
            planId: effectivePlanId,
          });

          if (capture.ok) {
            // Per-task attribution: prefer each task's already-persisted
            // receipt over recomputing a diff.
            const dataRoot = getDataDir();
            const taskAttribution: PlanTaskAttribution[] = planTasks.map((t) => {
              const stored = readReceipt(dataRoot, slug, t.id);
              const commit = stored?.headSha ?? t.report?.commit;
              return {
                taskId: t.id,
                ...(t.startHead !== undefined ? { startHead: t.startHead } : {}),
                ...(commit !== undefined ? { commit } : {}),
                ...(stored !== null
                  ? {
                      filesChanged: stored.filesChanged,
                      insertions: stored.insertions,
                      deletions: stored.deletions,
                    }
                  : {}),
              };
            });
            planReportRef = writeReceipt(dataRoot, slug, capture.report, {
              planId: effectivePlanId,
              taskAttribution,
            });
            await updatePlan(projectDir, { id: effectivePlanId, report: planReportRef });
          } else {
            planReportSkipped = capture.reason;
          }
        } catch (err) {
          planReportRef = undefined;
          planReportSkipped = `could not persist plan receipt: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }
    }
  }

  // Record the change ledger: the deterministic, git-derived record of what
  // this task changed. NEVER fails the command — a workspace without git, a
  // missing baseline, or any recording error degrades to `ledgerSkipped`. The
  // baseline is the task's EXISTING `startHead` (never a new field).
  let ledgerRecorded: unknown[] | undefined;
  let ledgerSkippedEntries: Array<{ sha: string; reason: string }> | undefined;
  let ledgerSkipped: string | undefined;
  try {
    const ledgerRoot = await resolveTaskRepoRoot(projectDir, effectivePlanId);
    if (ledgerRoot === "" || !isGitRepo(ledgerRoot)) {
      ledgerSkipped = "no git workspace to record changes in";
    } else {
      const recorded: unknown[] = [];
      const skipped: Array<{ sha: string; reason: string }> = [];
      if (taskStartHead) {
        const shas = listCommits(ledgerRoot, `${taskStartHead}..HEAD`);
        const written = await recordCommits(projectDir, {
          taskId: completedTask.id,
          ...(effectivePlanId ? { planId: effectivePlanId } : {}),
          cwd: ledgerRoot,
          shas,
          recordedBy: "done",
        });
        recorded.push(...written.recorded);
        skipped.push(...written.skipped);
      } else {
        ledgerSkipped = "task has no startHead baseline; committed range not recorded";
      }
      const pending = await recordPending(projectDir, {
        taskId: completedTask.id,
        ...(effectivePlanId ? { planId: effectivePlanId } : {}),
        cwd: ledgerRoot,
        recordedBy: "done",
      });
      if (pending) recorded.push(pending);
      if (recorded.length > 0) ledgerRecorded = recorded;
      if (skipped.length > 0) ledgerSkippedEntries = skipped;
    }
  } catch (err) {
    ledgerSkipped = `could not record change ledger: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  // Capture --learn insight if provided
  let learnedEntry: { id: string; title: string; kind: string } | null = null;
  let learnChunks: number | undefined;
  let learnChunksSkipped: string | undefined;
  if (learnText) {
    // Derive chunks from the receipt's own diff, deterministically. This is
    // best-effort evidence: any failure degrades to the pre-existing behaviour
    // (an entry with no chunks) and is reported, never thrown.
    let learnSourceFiles: FileRef[] | undefined;
    let learnCodeChunks: CodeChunk[] | undefined;
    if (learnReceipt) {
      try {
        const derived = await deriveLearnChunks(learnReceipt);
        if (derived.chunks.length > 0) {
          learnCodeChunks = derived.chunks;
          learnSourceFiles = derived.sourceFiles;
          learnChunks = derived.chunks.length;
        }
        if (derived.skipped > 0) {
          learnChunksSkipped = `${derived.skipped} diff file(s) skipped (deleted, truncated, or past EOF)`;
        }
      } catch (err) {
        learnChunksSkipped = `could not derive code chunks: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }

    try {
      const lower = learnText.toLowerCase();
      const kind = /don't|never|careful|watch out|gotcha/.test(lower)
        ? "gotcha"
        : /learned|lesson|realized|mistake/.test(lower)
          ? "lesson"
          : /pattern|always|convention|rule/.test(lower)
            ? "pattern"
            : "lesson";
      const title = learnText.length <= 50 ? learnText : `${learnText.slice(0, 50)}...`;
      const id = normalizeIdentifier(title);
      const baseInput = {
        id,
        title,
        kind: kind as "gotcha" | "lesson" | "pattern",
        keywords: [completedTask.id],
        summary: learnText,
      };
      let entry: Awaited<ReturnType<typeof createKnowledgeEntry>>;
      try {
        entry = await createKnowledgeEntry(projectDir, {
          ...baseInput,
          ...(learnSourceFiles ? { sourceFiles: learnSourceFiles } : {}),
          ...(learnCodeChunks ? { codeChunks: learnCodeChunks } : {}),
        });
      } catch (err) {
        // A derived chunk that the knowledge store rejects (e.g. a diff path
        // that fails FileRef validation) must not lose the insight: fall back
        // to the pre-chunk behaviour — the entry without any chunks.
        if (!learnCodeChunks && !learnSourceFiles) throw err;
        learnChunksSkipped = `could not attach code chunks: ${
          err instanceof Error ? err.message : String(err)
        }`;
        learnCodeChunks = undefined;
        learnSourceFiles = undefined;
        learnChunks = undefined;
        entry = await createKnowledgeEntry(projectDir, baseInput);
      }
      learnedEntry = { id: entry.id, title: entry.title, kind: entry.kind };
    } catch {
      // Best-effort — don't fail the done command for a learn error
    }
  }

  if (flags.json) {
    return success({
      slug,
      completed: completedTask,
      next: nextData,
      ...(reportRef ? { report: reportRef } : {}),
      ...(reportSkipped ? { reportSkipped } : {}),
      ...(planReportRef ? { planReport: planReportRef } : {}),
      ...(planReportSkipped ? { planReportSkipped } : {}),
      ...(ledgerRecorded
        ? {
            ledger: {
              recorded: ledgerRecorded,
              ...(ledgerSkippedEntries ? { skipped: ledgerSkippedEntries } : {}),
            },
          }
        : {}),
      ...(ledgerSkipped ? { ledgerSkipped } : {}),
      ...(learnedEntry ? { learned: learnedEntry } : {}),
      ...(learnChunks !== undefined ? { learnedChunks: learnChunks } : {}),
      ...(learnChunksSkipped ? { learnedChunksSkipped: learnChunksSkipped } : {}),
    });
  }

  // Human output is rendered from the same structured payload by the md-renderer
  // so the CLI and the OpenCode chat panel never drift apart.
  const human = renderMarkdown("done", {
    slug,
    completed: completedTask,
    next: nextData,
    ...(reportRef ? { report: reportRef } : {}),
    ...(reportSkipped ? { reportSkipped } : {}),
    ...(planReportRef ? { planReport: planReportRef } : {}),
    ...(planReportSkipped ? { planReportSkipped } : {}),
    ...(ledgerRecorded
      ? {
          ledger: {
            recorded: ledgerRecorded,
            ...(ledgerSkippedEntries ? { skipped: ledgerSkippedEntries } : {}),
          },
        }
      : {}),
    ...(ledgerSkipped ? { ledgerSkipped } : {}),
    ...(learnedEntry ? { learned: learnedEntry } : {}),
    ...(learnChunks !== undefined ? { learnedChunks: learnChunks } : {}),
    ...(learnChunksSkipped ? { learnedChunksSkipped: learnChunksSkipped } : {}),
  });

  return success(human ?? formatHuman({ slug, completed: completedTask, next: nextData }));
}
