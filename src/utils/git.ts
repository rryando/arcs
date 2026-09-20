import { execFile, execSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";

export interface GitLogEntry {
  sha: string;
  message: string;
  date: string;
  filesChanged: string[];
}

const execFileAsync = promisify(execFile);

/**
 * Ceiling on one async git invocation. A `git` that never returns — a
 * network-backed worktree, an index.lock held by another process — must fail
 * closed to "no revision" rather than pin a request open forever. Generous
 * enough that a cold `rev-parse` on a large repo still answers.
 *
 * Exported for the tests that assert the deadline is actually honoured.
 */
export const GIT_ASYNC_TIMEOUT_MS = 2000;

/** Slack the raced deadline allows the child's own kill path before giving up
 *  on it, so a child that DOES die on signal reports its real failure. */
const GIT_DEADLINE_GRACE_MS = 100;

function exec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Async: run `git` with an argv array, never a shell, and never a sync spawn.
 * Same contract as `exec` above — trimmed stdout, or `null` for any failure —
 * so an async caller reads the same values a sync one would.
 *
 * The deadline is RACED, not delegated to `timeout`. Node's `timeout` option
 * guarantees a kill ATTEMPT, not a settlement: it signals the child and then
 * waits for `close`, so a child that cannot act on the signal never fires the
 * callback and the promise stays pending forever — a request that hangs holding
 * its connection even though the timeout fired. The realistic instance is
 * D-state I/O on a stalled NFS/FUSE mount, which is exactly the wedged-worktree
 * case this budget exists for; `killSignal: "SIGKILL"` narrows the window (it
 * beats a child that merely ignores SIGTERM) but does not close it, since
 * SIGKILL does not touch uninterruptible sleep either. Racing our own timer is
 * what actually bounds the caller, and `unref` keeps a pending timer from
 * holding the process open on the way out.
 *
 * What this does NOT do is reap the child: nothing can until the I/O returns.
 * A caller that retries against a stalled mount still accumulates live children
 * — bound that separately if it ever matters here.
 */
function execAsync(args: string[], cwd: string): Promise<string | null> {
  const ran = execFileAsync("git", args, {
    encoding: "utf-8",
    cwd,
    timeout: GIT_ASYNC_TIMEOUT_MS,
    killSignal: "SIGKILL",
    windowsHide: true,
  })
    .then(({ stdout }) => stdout.trim())
    .catch(() => null);

  const expired = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), GIT_ASYNC_TIMEOUT_MS + GIT_DEADLINE_GRACE_MS).unref();
  });

  return Promise.race([ran, expired]);
}

export function isGitRepo(cwd: string): boolean {
  return exec("git rev-parse --is-inside-work-tree", cwd) === "true";
}

export function getHeadCommit(cwd: string): string | null {
  return exec("git rev-parse --short HEAD", cwd);
}

/**
 * Async twin of `getHeadCommit`, for callers on a request path.
 *
 * The sync export stays as it is — its callers are CLI, where blocking costs
 * nothing. A server is the opposite case: `execSync` holds the whole event
 * loop for the child's entire lifetime, so one file view stalls every other
 * in-flight request and every open SSE stream. Use this one from a handler.
 *
 * Settles within `GIT_ASYNC_TIMEOUT_MS` plus a small grace no matter what the
 * child does — see `execAsync` for why that needs a race rather than a timeout.
 */
export async function getHeadCommitAsync(cwd: string): Promise<string | null> {
  return execAsync(["rev-parse", "--short", "HEAD"], cwd);
}

export function getGitLog(
  cwd: string,
  options?: { since?: string; limit?: number },
): GitLogEntry[] {
  const limit = options?.limit ?? 50;
  const since = options?.since;

  let cmd = `git log --format=%H%n%s%n%aI -n ${limit}`;
  if (since) {
    // Try as ISO date first; if it looks like a SHA, use commit range
    if (/^[a-f0-9]{4,40}$/.test(since)) {
      cmd += ` ${since}..HEAD`;
    } else {
      cmd += ` --since="${since}"`;
    }
  }

  const output = exec(cmd, cwd);
  if (!output) return [];

  const lines = output.split("\n");
  const entries: GitLogEntry[] = [];

  for (let i = 0; i + 2 < lines.length; i += 3) {
    const fullSha = lines[i];
    const message = lines[i + 1];
    const date = lines[i + 2];
    const shortSha = fullSha.slice(0, 7);

    // Get files changed for this commit
    const filesOutput = exec(`git diff-tree --no-commit-id --name-only -r ${fullSha}`, cwd);
    const filesChanged = filesOutput ? filesOutput.split("\n").filter(Boolean) : [];

    entries.push({ sha: shortSha, message, date, filesChanged });
  }

  return entries;
}

export function getFilesChanged(cwd: string, fromCommit: string): string[] {
  const output = exec(`git diff --name-only ${fromCommit} HEAD`, cwd);
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

// ---------------------------------------------------------------------------
// Change-ledger helpers
//
// Everything below feeds `src/utils/change-ledger.ts`. Unlike the legacy shell
// helpers above, these spawn `git` with an argv array (never a shell string)
// and a hard timeout, mirroring `run-report.ts`'s `runGit`. The two `-c` pins
// keep diff prefixes stable (`a/`/`b/`, never mnemonic) so `+++ b/<path>`
// parsing is deterministic. Same posture as `run-report.ts`: a failed or
// timed-out call degrades to `null`/`false`/`[]` and never throws — the ledger
// is evidence, not a gate, and a workspace without git must degrade rather than
// fail a task transition.
// ---------------------------------------------------------------------------

/** Hard ceiling on one ledger git call. A wedged git must fail closed. */
export const CHANGE_LEDGER_GIT_TIMEOUT_MS = 5_000;

/** Ceiling on captured stdout — a large commit diff must not blow the buffer. */
const CHANGE_LEDGER_MAX_BUFFER = 64 * 1024 * 1024;

/** A full or abbreviated hex sha. Every sha is tested before it becomes an argv. */
const SHA_PATTERN = /^[a-f0-9]{4,40}$/;

/**
 * A git revision or range shaped like something git legitimately accepts
 * (`HEAD~2..main`, `abc123^`, `feature/x`). Rejects anything starting with `-`
 * (option injection) and anything a shell or pathspec would read specially.
 * Applied even though argv spawns are not shell-interpolated: a revision that
 * cannot be a revision should never reach git as a positional argument.
 */
const REVISION_PATTERN = /^[\w./@^~-]+(?:\.\.\.?[\w./@^~-]+)?$/;

/** Whether `sha` is a syntactically valid (possibly abbreviated) commit sha. */
export function isValidSha(sha: string): boolean {
  return SHA_PATTERN.test(sha);
}

/** Whether `range` is a single revision or a `a..b`/`a...b` range git accepts. */
export function isValidRevisionRange(range: string): boolean {
  return REVISION_PATTERN.test(range) && !range.startsWith("-");
}

interface GitRun {
  failed: boolean;
  stdout: string;
}

/**
 * One `spawnSync` git call, argv only, with the diff-prefix pins, SIGKILL and a
 * hard timeout. `input` (when supplied) is written to git's stdin — used to
 * pipe a rendered patch into `git patch-id` without a shell. Never throws: any
 * spawn error, timeout or non-zero exit reports `failed`.
 */
function runGitLedger(cwd: string, args: string[], input?: string): GitRun {
  try {
    const proc = spawnSync(
      "git",
      ["-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false", "-C", cwd, ...args],
      {
        encoding: "utf-8",
        timeout: CHANGE_LEDGER_GIT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: CHANGE_LEDGER_MAX_BUFFER,
        ...(input !== undefined ? { input } : {}),
        stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
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

/** Resolve a single revision to its full sha, or null when it does not resolve. */
export function resolveCommit(cwd: string, revision: string): string | null {
  if (!isValidRevisionRange(revision) || revision.includes("..")) return null;
  const res = runGitLedger(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]);
  if (res.failed) return null;
  const sha = res.stdout.trim();
  return SHA_PATTERN.test(sha) ? sha : null;
}

/** Whether `sha` is reachable from HEAD — false after a rebase or squash dropped it. */
export function isAncestor(cwd: string, sha: string): boolean {
  if (!isValidSha(sha)) return false;
  return !runGitLedger(cwd, ["merge-base", "--is-ancestor", sha, "HEAD"]).failed;
}

/**
 * Full shas in `range`, OLDEST FIRST, so a ledger appended in this order reads
 * chronologically. Returns `[]` for an invalid or unresolvable range.
 */
export function listCommits(cwd: string, range: string): string[] {
  if (!isValidRevisionRange(range)) return [];
  const res = runGitLedger(cwd, ["rev-list", "--reverse", range]);
  if (res.failed) return [];
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => SHA_PATTERN.test(line));
}

/** One file of one commit, with its `@@ … @@` hunk headers. */
export interface CommitFileChange {
  path: string;
  additions: number;
  deletions: number;
  hunks: string[];
}

/** What the ledger records about one commit. */
export interface CommitChanges {
  sha: string;
  subject: string;
  author: string;
  authoredAt: string;
  files: CommitFileChange[];
  /** `git patch-id --stable`: identical across rebases and cherry-picks. */
  patchId: string | null;
}

/**
 * Strip a git path token to a repo-relative path: surrounding double quotes
 * (git C-quotes paths with spaces) and a leading `a/`/`b/` prefix are removed.
 * Mirrors `code-snippet.ts`'s (module-private) `normalizeDiffPath` so the two
 * readers of `+++ b/<path>` agree on what a path is.
 */
function normalizeDiffPath(token: string): string {
  let raw = token.trim();
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.slice(1, -1).replace(/\\([\\"])/g, "$1");
  }
  if (raw.startsWith("b/")) return raw.slice(2);
  if (raw.startsWith("a/")) return raw.slice(2);
  return raw;
}

/** Remove git's C-quoting from a `--numstat` path without touching `a/`/`b/`. */
function unquotePath(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\([\\"])/g, "$1");
  }
  return raw;
}

/**
 * Parse `git show --numstat --format=` output. Binary files report `-` for both
 * counts; they are recorded with zero counts rather than dropped.
 */
function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const files = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    // A rename renders as `old => new` or `dir/{old => new}.ts`; keep the new name.
    const rawPath = unquotePath(match[3]);
    const path = rawPath.includes(" => ")
      ? rawPath.replace(/\{[^}]*=> ([^}]*)\}/, "$1").replace(/^.* => /, "")
      : rawPath;
    files.set(path, {
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    });
  }
  return files;
}

/** Parse `git show --unified=0 --format=` output into hunk headers per file. */
function parseHunks(output: string): Map<string, string[]> {
  const hunks = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("diff --git")) {
      current = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const token = line.slice(4).trim();
      current = token === "/dev/null" ? null : normalizeDiffPath(token);
      if (current !== null && !hunks.has(current)) hunks.set(current, []);
      continue;
    }
    if (current !== null && line.startsWith("@@")) hunks.get(current)?.push(line);
  }
  return hunks;
}

/**
 * Everything the ledger snapshots about `sha`: metadata, per-file numstat and
 * `@@` hunk HEADERS (never the patch body), plus the rebase-stable `patchId`.
 * Null when the sha is invalid or does not resolve in `cwd`.
 */
export function getCommitChanges(cwd: string, sha: string): CommitChanges | null {
  if (!isValidSha(sha)) return null;

  const meta = runGitLedger(cwd, ["show", "-s", "--format=%H%n%s%n%an%n%aI", sha]);
  if (meta.failed) return null;
  const [fullSha, subject, author, authoredAt] = meta.stdout.replace(/\n$/, "").split("\n");
  if (!fullSha || !SHA_PATTERN.test(fullSha)) return null;

  const numstatRes = runGitLedger(cwd, ["show", "--numstat", "--format=", fullSha]);
  const numstat = numstatRes.failed ? new Map() : parseNumstat(numstatRes.stdout);
  const hunksRes = runGitLedger(cwd, ["show", "--unified=0", "--format=", fullSha]);
  const hunks = hunksRes.failed ? new Map<string, string[]>() : parseHunks(hunksRes.stdout);
  const files: CommitFileChange[] = [];
  for (const [path, counts] of numstat) {
    files.push({ path, ...counts, hunks: hunks.get(path) ?? [] });
  }

  const patchRes = runGitLedger(cwd, ["show", "--format=", fullSha]);
  let patchId: string | null = null;
  if (!patchRes.failed && patchRes.stdout.trim() !== "") {
    const pidRes = runGitLedger(cwd, ["patch-id", "--stable"], patchRes.stdout);
    if (!pidRes.failed) {
      const first = pidRes.stdout.trim().split(/\s+/)[0] ?? "";
      patchId = SHA_PATTERN.test(first) ? first : null;
    }
  }

  return {
    sha: fullSha,
    subject: subject ?? "",
    author: author ?? "",
    authoredAt: authoredAt ?? "",
    files,
    patchId,
  };
}

/** Uncommitted work in the worktree: staged, unstaged and untracked files. */
export interface WorktreeDiffstat {
  files: Array<{ path: string; additions: number; deletions: number }>;
  untracked: string[];
}

/**
 * What is sitting in the worktree uncommitted, or null when clean (or outside a
 * repo). Untracked paths come from `ls-files --others --exclude-standard`, which
 * lists every FILE individually — an untracked DIRECTORY is never collapsed to a
 * single entry the way `git status --porcelain` reports it.
 */
export function getWorktreeDiffstat(cwd: string): WorktreeDiffstat | null {
  const status = runGitLedger(cwd, ["status", "--porcelain"]);
  if (status.failed || status.stdout.trim() === "") return null;

  const untrackedRes = runGitLedger(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const untracked = untrackedRes.failed
    ? []
    : untrackedRes.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");

  const diffRes = runGitLedger(cwd, ["diff", "--numstat", "HEAD"]);
  const files = diffRes.failed
    ? []
    : [...parseNumstat(diffRes.stdout)].map(([path, counts]) => ({ path, ...counts }));

  if (files.length === 0 && untracked.length === 0) return null;
  return { files, untracked };
}

/** The unified diff of `sha`, optionally restricted to `paths`; null when unreachable. */
export function getCommitPatch(cwd: string, sha: string, paths: string[] = []): string | null {
  if (!isValidSha(sha)) return null;
  const safePaths = paths.filter((p) => /^[\w./@-]+$/.test(p) && !p.startsWith("-"));
  const args = ["show", "--format=", sha, ...(safePaths.length > 0 ? ["--", ...safePaths] : [])];
  const res = runGitLedger(cwd, args);
  return res.failed ? null : res.stdout;
}
