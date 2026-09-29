// ---------------------------------------------------------------------------
// Change-ledger commands — task record-change, task changes, plan changes
//
// The ledger itself lives in src/utils/change-ledger.ts and is written by
// `done` automatically; these commands are the explicit surface for what the
// lifecycle cannot know on its own (a PR link, commits made before the task
// was opened, an over-recorded baseline) and the read side per task and plan.
//
// The ledger is git-derived and OFFLINE: no command here contacts a network
// (there is no `gh pr view` dependency), and `--patch` re-renders a patch from
// git only while its sha is still reachable — the ledger never stores a body.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import {
  type ChangeRecord,
  readChanges,
  recordCommits,
  recordPr,
  removeChange,
  summarizeChanges,
} from "../../utils/change-ledger.js";
import {
  getCommitPatch,
  isGitRepo,
  isValidSha,
  listCommits,
  resolveCommit,
} from "../../utils/git.js";
import { getTask, listTasks, readPlanIndex } from "../../utils/project-memory.js";
import { resolveProject } from "../../utils/project-resolver.js";
import { normalizeIdentifier } from "../../utils/slug.js";
import { resolveTaskRepoRoot } from "../../utils/task-store.js";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  ERROR_CODES,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { failure, success } from "../output-envelope.js";

/** Resolve a project slug to `{ slug, projectDir }`, or a failure envelope. */
async function requireProject(
  slug: string,
): Promise<{ slug: string; projectDir: string } | CLIResult> {
  const resolved = await resolveProject(slug);
  if (!resolved.ok) return resolved.result;
  if (!existsSync(resolved.projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
      hint: "Run 'arcs project list' to see available projects.",
    });
  }
  return { slug: resolved.slug, projectDir: resolved.projectDir };
}

/**
 * A cwd a ledger read can check reachability in, or undefined when the
 * workspace is not a git repository. `resolveTaskRepoRoot` is worktree-aware
 * (plan worktree first, then the registered workspace path); the git check is
 * what keeps a non-git workspace from being mistaken for "every sha dangling".
 */
async function resolveLedgerCwd(
  projectDir: string,
  planId: string | undefined,
): Promise<string | undefined> {
  const root = await resolveTaskRepoRoot(projectDir, planId);
  return root !== "" && isGitRepo(root) ? root : undefined;
}

/** Attach the re-rendered patch to each REACHABLE commit record only. */
function withPatches(
  cwd: string,
  records: ChangeRecord[],
  paths: string[],
): Array<ChangeRecord & { patch?: string }> {
  return records.map((record) => {
    if (record.kind !== "commit" || !record.sha || record.reachable === false) return record;
    const patch = getCommitPatch(cwd, record.sha, paths);
    return patch === null ? record : { ...record, patch };
  });
}

// ---------------------------------------------------------------------------
// task record-change
// ---------------------------------------------------------------------------

const recordChangeParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  taskId: { type: "string", required: true, positional: 1, description: "Task ID" },
  commits: { type: "string", description: "Comma-separated commit shas to record" },
  range: {
    type: "string",
    description:
      "Git range to record, e.g. abc123..HEAD; `..HEAD` alone means from the task's startHead baseline",
  },
  pr: { type: "string", description: "Pull-request URL to attach (stored verbatim, offline)" },
  remove: { type: "string", description: "Comma-separated shas to retract from the task's ledger" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "task record-change",
  description:
    "Record commits, a git range or a PR link in a task's change ledger, or retract a sha",
  mutation: true,
  params: recordChangeParams,
  handler: handleRecordChange,
});

async function handleRecordChange(
  params: ParsedParams<typeof recordChangeParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const resolved = await requireProject(params.slug);
  if ("ok" in resolved) return resolved;
  const { slug, projectDir } = resolved;

  const { commits, range, pr, remove } = params;
  if (!commits && !range && !pr && !remove) {
    return failure(
      ERROR_CODES.MISSING_PARAM,
      "One of --commits, --range, --pr or --remove is required",
      {
        param: "commits",
      },
    );
  }

  let task: Awaited<ReturnType<typeof getTask>>;
  try {
    task = await getTask(projectDir, params.taskId);
  } catch (err) {
    return failure(ERROR_CODES.ENTITY_NOT_FOUND, err instanceof Error ? err.message : String(err));
  }

  const cwd = await resolveLedgerCwd(projectDir, task.planId);
  const needsGit = Boolean(commits || range);
  if (needsGit && cwd === undefined) {
    return failure("no_git_workspace", `No usable git workspace for project "${slug}"`);
  }

  // Resolve every sha the request names BEFORE writing anything, so a bad
  // range or sha is reported with nothing recorded.
  const shas: string[] = [];
  if (cwd !== undefined) {
    if (commits) {
      for (const raw of commits
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        const full = resolveCommit(cwd, raw);
        if (!full) {
          return failure(
            ERROR_CODES.ENTITY_NOT_FOUND,
            `Commit "${raw}" does not resolve in ${cwd}`,
          );
        }
        shas.push(full);
      }
    }
    if (range) {
      let effective = range;
      if (range.startsWith("..")) {
        if (!task.startHead) {
          return failure(
            ERROR_CODES.MISSING_PARAM,
            `Range "${range}" needs the task's startHead baseline, which is not set; pass a full range like abc123..HEAD`,
            { param: "range" },
          );
        }
        effective = `${task.startHead}${range}`;
      }
      const listed = listCommits(cwd, effective);
      if (listed.length === 0) {
        return failure(
          ERROR_CODES.ENTITY_NOT_FOUND,
          `Range "${effective}" lists no commits in ${cwd}`,
        );
      }
      for (const sha of listed) if (!shas.includes(sha)) shas.push(sha);
    }
  }

  // A retraction names a sha the LEDGER holds, not one git holds — the usual
  // reason to retract is that git no longer has it (a rebase). So each
  // `--remove` is resolved against the task's own recorded commits by prefix,
  // and a sha that matches none is refused rather than tombstoned into thin air.
  const removals: string[] = [];
  if (remove) {
    const recordedShas = (await readChanges(projectDir, { taskId: task.id }))
      .filter((c) => c.kind === "commit" && c.sha !== undefined)
      .map((c) => c.sha as string);
    for (const raw of remove
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!isValidSha(raw)) {
        return failure("invalid_param", `"${raw}" is not a commit sha`, { param: "remove" });
      }
      const matches = recordedShas.filter((sha) => sha.startsWith(raw.toLowerCase()));
      if (matches.length === 0) {
        return failure(
          ERROR_CODES.ENTITY_NOT_FOUND,
          `No recorded commit on task "${task.id}" starts with "${raw}"`,
          { hint: `arcs task changes ${slug} ${task.id} --json lists what is recorded.` },
        );
      }
      if (matches.length > 1) {
        return failure(
          ERROR_CODES.AMBIGUOUS_ARG,
          `"${raw}" matches ${matches.length} recorded commits`,
        );
      }
      removals.push(matches[0]);
    }
  }

  if (flags.dryRun) {
    return success({
      dryRun: true,
      wouldRecord: {
        slug,
        taskId: task.id,
        commits: shas,
        ...(pr && { pr }),
        ...(removals.length > 0 && { remove: removals }),
      },
    });
  }

  const recorded: unknown[] = [];
  const skipped: unknown[] = [];
  if (shas.length > 0 && cwd !== undefined) {
    const written = await recordCommits(projectDir, {
      taskId: task.id,
      ...(task.planId && { planId: task.planId }),
      cwd,
      shas,
      recordedBy: "record-change",
    });
    recorded.push(...written.recorded);
    skipped.push(...written.skipped);
  }
  if (pr) {
    const entry = await recordPr(projectDir, {
      taskId: task.id,
      ...(task.planId && { planId: task.planId }),
      url: pr,
      recordedBy: "record-change",
    });
    recorded.push(entry);
  }
  const removed: string[] = [];
  for (const sha of removals) {
    await removeChange(projectDir, task.id, sha);
    removed.push(sha);
  }

  return success({
    taskId: task.id,
    recorded,
    skipped,
    ...(removed.length > 0 && { removed }),
  });
}

// ---------------------------------------------------------------------------
// task changes / plan changes
// ---------------------------------------------------------------------------

const readChangesParams = {
  patch: {
    type: "boolean",
    description: "Re-render each reachable commit's diff from git (never stored in the ledger)",
  },
  files: { type: "string", description: "Comma-separated paths to restrict --patch to" },
  limit: { type: "number", description: "Most-recent-N cap" },
} as const;

const taskChangesParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  taskId: { type: "string", required: true, positional: 1, description: "Task ID" },
  ...readChangesParams,
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "task changes",
  description: "List what a task changed: recorded commits, pending worktree state and PR links",
  params: taskChangesParams,
  handler: handleTaskChanges,
});

async function handleTaskChanges(
  params: ParsedParams<typeof taskChangesParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const resolved = await requireProject(params.slug);
  if ("ok" in resolved) return resolved;
  const { projectDir } = resolved;

  let task: Awaited<ReturnType<typeof getTask>>;
  try {
    task = await getTask(projectDir, params.taskId);
  } catch (err) {
    return failure(ERROR_CODES.ENTITY_NOT_FOUND, err instanceof Error ? err.message : String(err));
  }

  const cwd = await resolveLedgerCwd(projectDir, task.planId);

  let changes: Array<ChangeRecord & { patch?: string }> = await readChanges(projectDir, {
    taskId: task.id,
    ...(params.limit !== undefined && { limit: params.limit }),
    ...(cwd !== undefined && { cwd }),
  });
  if (params.patch && cwd !== undefined) {
    changes = withPatches(cwd, changes, parseFiles(params.files));
  }

  return success({
    taskId: task.id,
    changes,
    summary: summarizeChanges(changes),
    ...(params.patch && cwd === undefined
      ? { warning: "no git workspace: patches cannot be rendered" }
      : {}),
  });
}

const planChangesParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  planId: { type: "string", required: true, positional: 1, description: "Plan ID" },
  ...readChangesParams,
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "plan changes",
  description: "List every change recorded under a plan's tasks",
  params: planChangesParams,
  handler: handlePlanChanges,
});

async function handlePlanChanges(
  params: ParsedParams<typeof planChangesParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const resolved = await requireProject(params.slug);
  if ("ok" in resolved) return resolved;
  const { projectDir } = resolved;

  const planKey = normalizeIdentifier(params.planId);
  const planIndex = await readPlanIndex(projectDir);
  const plan = planIndex.plans.find((p) => p.normalizedId === planKey || p.id === params.planId);
  if (!plan) {
    return failure(ERROR_CODES.ENTITY_NOT_FOUND, `Plan "${params.planId}" not found`, {
      hint: `Run 'arcs plan list ${params.slug}' to see available plans.`,
    });
  }

  // Roll up across the plan's TASKS, not just entries that happen to carry a
  // planId — an entry recorded before the task's planId was set must still show.
  const planTasks = (await listTasks(projectDir)).filter((t) => t.planId === plan.id);
  const taskIds = new Set(planTasks.map((t) => t.id));

  const cwd = await resolveLedgerCwd(projectDir, plan.id);
  const all = await readChanges(projectDir, {
    ...(cwd !== undefined && { cwd }),
  });
  let changes = all.filter(
    (e) =>
      (e.planId !== undefined && normalizeIdentifier(e.planId) === planKey) ||
      taskIds.has(e.taskId),
  );
  if (params.limit !== undefined) changes = changes.slice(0, params.limit);

  let enriched: Array<ChangeRecord & { patch?: string }> = changes;
  if (params.patch && cwd !== undefined) {
    enriched = withPatches(cwd, changes, parseFiles(params.files));
  }

  return success({
    planId: plan.id,
    changes: enriched,
    summary: summarizeChanges(enriched),
    ...(params.patch && cwd === undefined
      ? { warning: "no git workspace: patches cannot be rendered" }
      : {}),
  });
}

function parseFiles(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
