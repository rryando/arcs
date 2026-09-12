/**
 * Deterministic completion-receipt engine.
 *
 * A completion receipt is a durable, offline record of what a task or plan
 * changed in a git tree: the base and head commits, the branch, a commit web
 * link (when the remote is recognizable), the changed-file count, line stats,
 * and a capped unified diff. It is the evidence half of the "evidence-linked
 * artifacts" work — nothing here contacts a remote, and every git call is a
 * fail-closed `spawnSync` with an argv array (never a shell) and a hard
 * timeout.
 *
 * The git-diff discipline mirrors `src/web-server/run-diff.ts` (the existing
 * deterministic diff engine): `spawnSync("git", ["-C", root, ...args])` with
 * `killSignal: "SIGKILL"`, and a diff capped at RUN_REPORT_DIFF_MAX_LINES /
 * RUN_REPORT_DIFF_MAX_BYTES. The two line/byte caps are duplicated here rather
 * than imported because `src/web-server/` depends on `src/utils/`, so importing
 * upward would invert the layering; they are kept numerically identical on
 * purpose.
 *
 * The caller owns base-ref selection: `worktree-store.ts` records a per-plan
 * `baseCommit`, and the caller passes it in as `opts.baseRef`. This module does
 * not read the worktree registry.
 */

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The pointer a caller gets back after persisting a receipt: enough to link a
 * task/plan to its evidence without re-reading the receipt body. `reportFile`
 * and `diffFile` are relative to the data root the receipt was written under.
 */
export interface TaskReportRef {
  commit?: string;
  branch?: string;
  baseRef?: string;
  url?: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  reportFile: string;
  diffFile?: string;
  truncated: boolean;
  capturedAt: string;
}

/** A captured completion receipt. */
export interface Receipt {
  taskId?: string;
  planId?: string;
  repoRoot: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  branch: string;
  remoteUrl: string | null;
  url: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** Capped unified diff — see RUN_REPORT_DIFF_MAX_LINES / _BYTES. */
  diff: string;
  diffTruncated: boolean;
  capturedAt: string;
}

/** Fail-closed capture result: `ok` discriminates a receipt from a reason. */
export type ReceiptCapture = { ok: true; report: Receipt } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Budgets — duplicated from src/web-server/run-diff.ts (see header for why)
// ---------------------------------------------------------------------------

/** Ceiling on one receipt diff's line count. */
export const RUN_REPORT_DIFF_MAX_LINES = 300;

/** Ceiling on one receipt diff's byte length. */
export const RUN_REPORT_DIFF_MAX_BYTES = 12 * 1024;

/** Ceiling on one `spawnSync` git call. A wedged git (stalled mount, held
 *  index.lock) must fail the capture closed, never hang the caller. */
export const RUN_REPORT_GIT_TIMEOUT_MS = 5_000;

interface GitResult {
  failed: boolean;
  stdout: string;
}

/**
 * One git call against `root`, argv only. `spawnSync` with a hard timeout and
 * SIGKILL: a wedged git fails the capture closed instead of pinning the
 * process. Matches `run-diff.ts`'s `runGit` contract exactly.
 */
function runGit(root: string, args: string[], timeoutMs: number): GitResult {
  try {
    const proc = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf-8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      failed: proc.error !== undefined || proc.status !== 0,
      stdout: typeof proc.stdout === "string" ? proc.stdout : "",
    };
  } catch {
    return { failed: true, stdout: "" };
  }
}

// ---------------------------------------------------------------------------
// commitUrl — pure remote→web-link mapping, NO network
// ---------------------------------------------------------------------------

interface ParsedRemote {
  /** host[:port], preserved verbatim for non-standard ports. */
  host: string;
  /** owner/repo[/nested/...], normalized without leading slash or `.git`. */
  path: string;
}

/**
 * Parse an ssh/https remote into host + repository path. Handles the scp-like
 * `git@host:owner/repo.git` form and any `scheme://` URL (including a
 * non-standard port and nested GitLab group paths). Returns null when the
 * string is not a recognizable git remote.
 */
function parseRemote(remoteUrl: string | null | undefined): ParsedRemote | null {
  if (remoteUrl === null || remoteUrl === undefined) return null;
  const raw = remoteUrl.trim();
  if (raw === "") return null;

  let host: string;
  let path: string;

  if (raw.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (parsed.host === "") return null;
    host = parsed.host;
    path = parsed.pathname;
  } else {
    // scp-like: [user@]host:path — the host part cannot contain `/` or `:`.
    const match = raw.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (!match) return null;
    host = match[1];
    path = match[2];
  }

  const normalized = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .trim();
  if (normalized === "") return null;
  return { host, path: normalized };
}

/**
 * Map a git remote URL + commit sha to a browsable commit URL, offline.
 * GitHub → `/commit/<sha>`, GitLab → `/-/commit/<sha>`, Bitbucket →
 * `/commits/<sha>`. Returns null for a null/empty/unknown host — an
 * unrecognized remote yields no link rather than a guessed one.
 */
export function commitUrl(remoteUrl: string | null | undefined, sha: string): string | null {
  const remote = parseRemote(remoteUrl);
  if (remote === null) return null;

  const hostname = remote.host.split(":")[0].toLowerCase();
  if (hostname.includes("github")) {
    return `https://${remote.host}/${remote.path}/commit/${sha}`;
  }
  if (hostname.includes("gitlab")) {
    return `https://${remote.host}/${remote.path}/-/commit/${sha}`;
  }
  if (hostname.includes("bitbucket")) {
    return `https://${remote.host}/${remote.path}/commits/${sha}`;
  }
  return null;
}

/**
 * `git remote get-url origin`, fail-closed to null. Never contacts a remote —
 * this only reads the local config.
 */
export async function getRemoteUrl(cwd: string): Promise<string | null> {
  const result = runGit(cwd, ["remote", "get-url", "origin"], RUN_REPORT_GIT_TIMEOUT_MS);
  if (result.failed) return null;
  const url = result.stdout.trim();
  return url === "" ? null : url;
}

// ---------------------------------------------------------------------------
// Diff caps
// ---------------------------------------------------------------------------

/** First RUN_REPORT_DIFF_MAX_LINES lines, then at most RUN_REPORT_DIFF_MAX_BYTES bytes. */
function capDiff(text: string): string {
  const lines = text.split("\n");
  const kept =
    lines.length > RUN_REPORT_DIFF_MAX_LINES ? lines.slice(0, RUN_REPORT_DIFF_MAX_LINES) : lines;
  let out = kept.join("\n");
  if (Buffer.byteLength(out, "utf-8") > RUN_REPORT_DIFF_MAX_BYTES) {
    out = out.slice(0, RUN_REPORT_DIFF_MAX_BYTES);
  }
  return out;
}

function isTruncated(text: string): boolean {
  if (text.split("\n").length > RUN_REPORT_DIFF_MAX_LINES) return true;
  return Buffer.byteLength(text, "utf-8") > RUN_REPORT_DIFF_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface CaptureOptions {
  /** Explicit base ref (wins over everything else). */
  baseRef?: string;
  /** Head ref; defaults to `HEAD`. */
  headRef?: string;
  /** Alias for `baseRef` used when the caller is expressing "since". */
  sinceRef?: string;
  /** Caller-supplied fallback base, tried after baseRef/sinceRef; last resort `HEAD~1`. */
  fallbackRef?: string;
  taskId?: string;
  planId?: string;
  /** Injectable timestamp for deterministic tests; defaults to now. */
  capturedAt?: string;
  /** Hard ceiling on each git call. */
  timeoutMs?: number;
}

/**
 * Capture a completion receipt for `cwd`. FAIL-CLOSED: outside a git repo, on
 * a git timeout, or on an unresolvable base/head ref it returns
 * `{ ok: false, reason }` and never throws and never emits a partial success.
 *
 * Base-ref precedence: `opts.baseRef` > `opts.sinceRef` > `opts.fallbackRef` >
 * `HEAD~1`. Head defaults to `HEAD`.
 */
export async function captureReceipt(
  cwd: string,
  opts: CaptureOptions = {},
): Promise<ReceiptCapture> {
  const timeoutMs = opts.timeoutMs ?? RUN_REPORT_GIT_TIMEOUT_MS;

  const probe = runGit(cwd, ["rev-parse", "--is-inside-work-tree"], timeoutMs);
  if (probe.failed) {
    return { ok: false, reason: `git is unavailable or timed out in "${cwd}"` };
  }
  if (probe.stdout.trim() !== "true") {
    return { ok: false, reason: `"${cwd}" is not inside a git work tree` };
  }

  const rootRes = runGit(cwd, ["rev-parse", "--show-toplevel"], timeoutMs);
  if (rootRes.failed || rootRes.stdout.trim() === "") {
    return { ok: false, reason: "could not resolve the repository root" };
  }
  const repoRoot = rootRes.stdout.trim();

  const headRef = opts.headRef ?? "HEAD";
  const headRes = runGit(repoRoot, ["rev-parse", headRef], timeoutMs);
  if (headRes.failed || headRes.stdout.trim() === "") {
    return { ok: false, reason: `head ref "${headRef}" is not resolvable` };
  }
  const headSha = headRes.stdout.trim();

  const baseRef = opts.baseRef ?? opts.sinceRef ?? opts.fallbackRef ?? "HEAD~1";
  const baseRes = runGit(repoRoot, ["rev-parse", baseRef], timeoutMs);
  if (baseRes.failed || baseRes.stdout.trim() === "") {
    return { ok: false, reason: `base ref "${baseRef}" is not resolvable` };
  }
  const baseSha = baseRes.stdout.trim();

  // `--abbrev-ref <sha>` returns nothing for a raw commit; the checked-out
  // branch is what a receipt records, so ask about HEAD directly (and "HEAD"
  // when detached).
  const branchRes = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs);
  const branch = branchRes.failed ? "" : branchRes.stdout.trim();

  const remoteUrl = await getRemoteUrl(repoRoot);
  const url = commitUrl(remoteUrl, headSha);

  const nameOnly = runGit(repoRoot, ["diff", "--name-only", baseSha, headSha], timeoutMs);
  if (nameOnly.failed) return { ok: false, reason: "git diff --name-only failed" };
  const filesChanged = nameOnly.stdout.split("\n").filter((line) => line !== "").length;

  const numstat = runGit(repoRoot, ["diff", "--numstat", baseSha, headSha], timeoutMs);
  if (numstat.failed) return { ok: false, reason: "git diff --numstat failed" };
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.stdout.split("\n")) {
    if (line === "") continue;
    const [added, removed] = line.split("\t");
    if (/^\d+$/.test(added ?? "")) insertions += Number(added);
    if (/^\d+$/.test(removed ?? "")) deletions += Number(removed);
  }

  const full = runGit(repoRoot, ["diff", baseSha, headSha], timeoutMs);
  if (full.failed) return { ok: false, reason: "git diff failed" };
  const diffTruncated = isTruncated(full.stdout);

  return {
    ok: true,
    report: {
      ...(opts.taskId !== undefined && { taskId: opts.taskId }),
      ...(opts.planId !== undefined && { planId: opts.planId }),
      repoRoot,
      baseRef,
      baseSha,
      headSha,
      branch,
      remoteUrl,
      url,
      filesChanged,
      insertions,
      deletions,
      diff: capDiff(full.stdout),
      diffTruncated,
      capturedAt: opts.capturedAt ?? new Date().toISOString(),
    },
  };
}
