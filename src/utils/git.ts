import { execFile, execSync } from "node:child_process";
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
