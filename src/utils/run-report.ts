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
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

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
  /**
   * Working-tree snapshot marker, copied from the receipt. Absent on legacy
   * pointers written before snapshot capture existed. `true` means the receipt
   * was taken over a dirty working tree (uncommitted/staged/untracked content).
   */
  dirty?: boolean;
  /** Repo-relative, sorted untracked paths included in the snapshot body. */
  untracked?: string[];
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
  /**
   * True when the working tree differed from HEAD at capture time (staged,
   * unstaged, or untracked content present). This describes the REPOSITORY at
   * capture, not the receipt body: a head-pinned receipt is a committed range
   * yet still reports the repo state. Absent on legacy receipts.
   */
  dirty?: boolean;
  /**
   * Repo-relative, sorted untracked paths folded into the snapshot body. Empty
   * for a head-pinned (committed-range) receipt — untracked content is never
   * part of a committed range. Absent on legacy receipts.
   */
  untracked?: string[];
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
    const proc = spawnSync(
      "git",
      ["-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false", "-C", root, ...args],
      {
        encoding: "utf-8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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

/**
 * First RUN_REPORT_DIFF_MAX_LINES lines, then at most RUN_REPORT_DIFF_MAX_BYTES
 * UTF-8 bytes. The byte cut lands on a byte boundary and any partial trailing
 * code point the decoder replaced is trimmed, so a multibyte body cannot slip
 * past the byte cap. ASCII bodies are cut exactly as before.
 */
function capDiff(text: string): string {
  const lines = text.split("\n");
  const kept =
    lines.length > RUN_REPORT_DIFF_MAX_LINES ? lines.slice(0, RUN_REPORT_DIFF_MAX_LINES) : lines;
  let out = kept.join("\n");
  if (Buffer.byteLength(out, "utf-8") > RUN_REPORT_DIFF_MAX_BYTES) {
    out = Buffer.from(out, "utf-8").subarray(0, RUN_REPORT_DIFF_MAX_BYTES).toString("utf-8");
    while (Buffer.byteLength(out, "utf-8") > RUN_REPORT_DIFF_MAX_BYTES) {
      out = out.slice(0, -1);
    }
  }
  return out;
}

function isTruncated(text: string): boolean {
  if (text.split("\n").length > RUN_REPORT_DIFF_MAX_LINES) return true;
  return Buffer.byteLength(text, "utf-8") > RUN_REPORT_DIFF_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// Untracked files — synthesized new-file diffs (git has no baseline for them)
// ---------------------------------------------------------------------------

/** Bytes of an untracked file inspected for a NUL byte before it is classed binary. */
const UNTRACKED_BINARY_SNIFF_BYTES = 8_000;

interface UntrackedFileRead {
  /** False when the file is missing/unreadable/not a regular file. */
  ok: boolean;
  /** True when a NUL byte appears in the sniffed prefix. */
  binary: boolean;
  /** UTF-8 text of the bytes read (empty when binary or unreadable). */
  text: string;
  /** True when the file is larger than the read budget. */
  truncated: boolean;
}

/**
 * Read up to `maxBytes` of an untracked file without ever throwing. Bounded so
 * a huge untracked file cannot exhaust memory; a missing file, a directory, a
 * symlink, or a permission error all degrade to `{ ok: false }`.
 *
 * `lstat` (not `stat`) deliberately refuses symlinks: following one could read
 * a file OUTSIDE the repo into the receipt, and `run-diff.ts` walks with the
 * same "never step outside the root" rule. A refused path is still enumerated
 * in `untracked`; it simply contributes no diff entry.
 */
function readUntrackedFile(absPath: string, maxBytes: number): UntrackedFileRead {
  let fd: number | undefined;
  try {
    const info = lstatSync(absPath);
    if (!info.isFile()) return { ok: false, binary: false, text: "", truncated: false };
    if (info.size === 0) return { ok: true, binary: false, text: "", truncated: false };

    const toRead = Math.min(info.size, maxBytes + 1);
    fd = openSync(absPath, "r");
    const buf = Buffer.allocUnsafe(toRead);
    let total = 0;
    while (total < toRead) {
      const n = readSync(fd, buf, total, toRead - total, total);
      if (n <= 0) break;
      total += n;
    }
    const slice = buf.subarray(0, total);
    const sniff = slice.subarray(0, Math.min(total, UNTRACKED_BINARY_SNIFF_BYTES));
    if (sniff.includes(0)) return { ok: true, binary: true, text: "", truncated: false };
    return { ok: true, binary: false, text: slice.toString("utf-8"), truncated: info.size > total };
  } catch {
    return { ok: false, binary: false, text: "", truncated: false };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed — nothing to do.
      }
    }
  }
}

/**
 * Quote a path for the `a/<path> b/<path>` diff header when it contains
 * whitespace or quoting characters — the same C-quoting shape git uses and
 * `parseDiffFileRanges` unquotes. Plain paths are returned verbatim.
 */
function quoteGitPath(path: string): string {
  if (!/[ \t"\\]/.test(path)) return path;
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface UntrackedDiffBlock {
  text: string;
  insertions: number;
  truncated: boolean;
}

/**
 * Synthesize a `new file mode` unified-diff block for one untracked file. The
 * `@@ -0,0 +1,N @@` header is computed from the lines actually emitted, so a
 * capped file stays a self-consistent hunk. Binary files emit git's
 * `Binary files ... differ` line and contribute zero insertions; the whole
 * block is bounded by the same per-file line/byte budgets as tracked diffs.
 */
function buildUntrackedDiff(path: string, read: UntrackedFileRead): UntrackedDiffBlock {
  const token = quoteGitPath(path);
  if (read.binary) {
    return {
      text:
        `diff --git a/${token} b/${token}\n` +
        "new file mode 100644\n" +
        `Binary files /dev/null and b/${token} differ\n`,
      insertions: 0,
      truncated: false,
    };
  }

  let lines = read.text.split("\n");
  // A trailing newline yields a trailing empty element that is not a file line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let truncated = read.truncated;
  if (lines.length > RUN_REPORT_DIFF_MAX_LINES) {
    lines = lines.slice(0, RUN_REPORT_DIFF_MAX_LINES);
    truncated = true;
  }

  const header = `diff --git a/${token} b/${token}\nnew file mode 100644\n`;
  if (lines.length === 0) return { text: header, insertions: 0, truncated };

  const hunk = `@@ -0,0 +1,${lines.length} @@\n`;
  const body = `${lines.map((line) => `+${line}`).join("\n")}\n`;
  return {
    text: `${header}--- /dev/null\n+++ b/${token}\n${hunk}${body}`,
    insertions: lines.length,
    truncated,
  };
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
 *
 * TWO receipt shapes, selected by whether the caller pins a head:
 *
 *  - SNAPSHOT (no `opts.headRef`): the body is `git diff <baseSha>` — the
 *    committed-since-base changes PLUS staged PLUS unstaged edits to tracked
 *    files — and every untracked file is synthesized as a new-file diff and
 *    folded in. This is what makes a plan worktree full of uncommitted work
 *    produce real evidence instead of an empty diff.
 *  - COMMITTED RANGE (`opts.headRef` pinned, e.g. `--commit <sha>`): the body
 *    is `git diff <baseSha> <headSha>` and the working tree contributes
 *    NOTHING — no untracked files either. `untracked` is `[]` in this mode.
 *
 * `dirty`/`untracked` describe the REPOSITORY, computed independently of the
 * shape: `dirty` is true whenever the working tree differs from HEAD at
 * capture time (even for a committed-range receipt), while `untracked` is the
 * sorted set of untracked paths actually folded into the SNAPSHOT body (empty
 * for a committed range). This one rule is deliberate and coherent: the range
 * is history, the flags are the tree's state.
 *
 * Every untracked read is bounded (RUN_REPORT_DIFF_MAX_BYTES) and the whole
 * body still passes through the same line/byte caps as before; a file deleted
 * between the `git ls-files` listing and the read, an unreadable path, and a
 * git timeout all degrade instead of throwing or hanging.
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

  // Repo state at capture, independent of the receipt shape: any tracked edit
  // (staged or unstaged) or untracked file makes the tree dirty. A failed
  // status call degrades to "not dirty" rather than failing the capture.
  const statusRes = runGit(repoRoot, ["status", "--porcelain"], timeoutMs);
  const dirty = !statusRes.failed && statusRes.stdout.trim() !== "";

  // Untracked enumeration only applies to the SNAPSHOT shape. A pinned head is
  // a committed range, so its `untracked` is always the empty list.
  const pinnedHead = opts.headRef !== undefined;
  let untracked: string[] = [];
  if (!pinnedHead) {
    const others = runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"], timeoutMs);
    if (!others.failed) {
      untracked = others.stdout
        .split("\n")
        .filter((line) => line !== "")
        .sort();
    }
  }

  // SNAPSHOT: `git diff <base>` = committed-since-base + staged + unstaged.
  // COMMITTED RANGE: `git diff <base> <head>` = history only.
  const rangeArgs = pinnedHead ? [baseSha, headSha] : [baseSha];

  const nameOnly = runGit(repoRoot, ["diff", "--name-only", ...rangeArgs], timeoutMs);
  if (nameOnly.failed) return { ok: false, reason: "git diff --name-only failed" };
  let filesChanged = nameOnly.stdout.split("\n").filter((line) => line !== "").length;

  const numstat = runGit(repoRoot, ["diff", "--numstat", ...rangeArgs], timeoutMs);
  if (numstat.failed) return { ok: false, reason: "git diff --numstat failed" };
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.stdout.split("\n")) {
    if (line === "") continue;
    const [added, removed] = line.split("\t");
    if (/^\d+$/.test(added ?? "")) insertions += Number(added);
    if (/^\d+$/.test(removed ?? "")) deletions += Number(removed);
  }

  const full = runGit(repoRoot, ["diff", ...rangeArgs], timeoutMs);
  if (full.failed) return { ok: false, reason: "git diff failed" };

  // Fold each untracked file into the body as a synthesized new-file diff. A
  // path that vanished between listing and read is skipped (not counted); a
  // per-file cap keeps one huge file from consuming the whole budget.
  let diffText = full.stdout;
  let untrackedTruncated = false;
  for (const path of untracked) {
    const read = readUntrackedFile(join(repoRoot, path), RUN_REPORT_DIFF_MAX_BYTES);
    if (!read.ok) continue;
    const block = buildUntrackedDiff(path, read);
    diffText += block.text;
    insertions += block.insertions;
    if (block.truncated) untrackedTruncated = true;
    filesChanged += 1;
  }

  const diffTruncated = isTruncated(diffText) || untrackedTruncated;

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
      diff: capDiff(diffText),
      diffTruncated,
      capturedAt: opts.capturedAt ?? new Date().toISOString(),
      dirty,
      untracked,
    },
  };
}
