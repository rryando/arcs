import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GIT_ASYNC_TIMEOUT_MS,
  getFilesChanged,
  getGitLog,
  getHeadCommit,
  getHeadCommitAsync,
  isGitRepo,
} from "../src/utils/git.js";

/**
 * Half of the async deadline contract cannot be staged end-to-end: a child that
 * survives SIGKILL means D-state I/O on a stalled mount, which no test can
 * arrange in userland. So `execFile` is swappable for one that NEVER CALLS BACK
 * — the exact shape of the defect — behind a flag that is off for every other
 * test in this file, which keeps using the real binary.
 */
const { hangingSpawn } = vi.hoisted(() => ({ hangingSpawn: { enabled: false } }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = ((...args: unknown[]) =>
    (actual.execFile as unknown as (...a: unknown[]) => unknown)(
      ...args,
    )) as typeof actual.execFile;
  // `promisify` reads this symbol off the real `execFile` to resolve
  // `{ stdout, stderr }`; a replacement missing it would fall back to the plain
  // callback convention, resolve to a bare string, and silently break the
  // destructure in `execAsync` for every non-hanging call.
  const delegate = (
    actual.execFile as unknown as Record<symbol, (...a: unknown[]) => Promise<unknown>>
  )[promisify.custom];
  Object.defineProperty(execFile, promisify.custom, {
    value: (...args: unknown[]) =>
      hangingSpawn.enabled ? new Promise(() => {}) : delegate(...args),
  });
  return { ...actual, execFile };
});

const REPO_ROOT = join(import.meta.dirname, "..");
let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "arcs-git-test-"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("isGitRepo", () => {
  it("returns true for the ARCS repo", () => {
    expect(isGitRepo(REPO_ROOT)).toBe(true);
  });

  it("returns false for a non-git directory", () => {
    expect(isGitRepo(tempDir)).toBe(false);
  });
});

describe("getHeadCommit", () => {
  it("returns a short SHA for the ARCS repo", () => {
    const sha = getHeadCommit(REPO_ROOT);
    expect(sha).toMatch(/^[a-f0-9]{7,}$/);
  });

  it("returns null for a non-git directory", () => {
    expect(getHeadCommit(tempDir)).toBeNull();
  });
});

/**
 * The async twin is the one on a request path, so its deadline is the property
 * under test, not an implementation detail. Both hang cases below stayed PENDING
 * past 6 s against the pre-repair call (`timeout` alone, default SIGTERM): the
 * option guarantees a kill attempt and then waits for `close`, which a child
 * that cannot take the signal never reaches.
 */
describe("getHeadCommitAsync", () => {
  it("agrees with the sync twin on the ARCS repo", async () => {
    await expect(getHeadCommitAsync(REPO_ROOT)).resolves.toBe(getHeadCommit(REPO_ROOT));
  });

  it("resolves null for a non-git directory", async () => {
    await expect(getHeadCommitAsync(tempDir)).resolves.toBeNull();
  });

  // A `git` that traps SIGTERM, plus a background child holding the stdout pipe
  // open so `close` cannot fire on the signal alone. POSIX-only: the shim is a
  // shebang script found through PATH.
  it.skipIf(process.platform === "win32")(
    "settles to null within budget when git ignores SIGTERM",
    async () => {
      const shimDir = mkdtempSync(join(tmpdir(), "arcs-git-shim-"));
      const shim = join(shimDir, "git");
      const pidFile = join(shimDir, "pids");
      writeFileSync(
        shim,
        `#!/bin/sh\ntrap '' TERM\nsleep 60 &\nprintf '%s %s' "$$" "$!" > ${JSON.stringify(pidFile)}\nwait\n`,
      );
      chmodSync(shim, 0o755);

      const priorPath = process.env.PATH;
      process.env.PATH = `${shimDir}${delimiter}${priorPath ?? ""}`;
      try {
        const started = Date.now();
        const result = await getHeadCommitAsync(shimDir);
        const elapsed = Date.now() - started;
        expect(result).toBeNull();
        expect(elapsed).toBeLessThan(GIT_ASYNC_TIMEOUT_MS * 2);
      } finally {
        process.env.PATH = priorPath;
        // Neither the shim nor its background child is reaped by the deadline —
        // settling is all the caller gets — so the test owns their teardown.
        for (const pid of readFileSync(pidFile, "utf-8").trim().split(/\s+/)) {
          try {
            process.kill(Number(pid), "SIGKILL");
          } catch {
            /* already gone */
          }
        }
        rmSync(shimDir, { recursive: true, force: true });
      }
    },
    GIT_ASYNC_TIMEOUT_MS * 4,
  );

  // The unreachable half: a child whose callback never fires at all, which is
  // what D-state I/O looks like from here. No `killSignal` rescues this — only
  // the raced deadline does.
  it(
    "settles to null when the child never calls back",
    async () => {
      hangingSpawn.enabled = true;
      try {
        const started = Date.now();
        const result = await getHeadCommitAsync(REPO_ROOT);
        const elapsed = Date.now() - started;
        expect(result).toBeNull();
        expect(elapsed).toBeGreaterThanOrEqual(GIT_ASYNC_TIMEOUT_MS);
        expect(elapsed).toBeLessThan(GIT_ASYNC_TIMEOUT_MS * 2);
      } finally {
        hangingSpawn.enabled = false;
      }
    },
    GIT_ASYNC_TIMEOUT_MS * 4,
  );
});

describe("getGitLog", () => {
  it("returns non-empty array for the ARCS repo", () => {
    const entries = getGitLog(REPO_ROOT);
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries[0];
    expect(entry).toHaveProperty("sha");
    expect(entry).toHaveProperty("message");
    expect(entry).toHaveProperty("date");
    expect(entry).toHaveProperty("filesChanged");
    expect(entry.sha).toMatch(/^[a-f0-9]{7,}$/);
    expect(typeof entry.message).toBe("string");
    expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Array.isArray(entry.filesChanged)).toBe(true);
  });

  it("respects limit option", () => {
    const entries = getGitLog(REPO_ROOT, { limit: 3 });
    expect(entries.length).toBeLessThanOrEqual(3);
  });

  it("filters by since date", () => {
    const all = getGitLog(REPO_ROOT, { limit: 50 });
    // Use a date that should exclude some commits
    const recentDate = all.length > 5 ? all[4].date : all[0].date;
    const filtered = getGitLog(REPO_ROOT, { since: recentDate });
    expect(filtered.length).toBeLessThanOrEqual(all.length);
  });

  it("returns empty array for a non-git directory", () => {
    expect(getGitLog(tempDir)).toEqual([]);
  });
});

describe("getFilesChanged", () => {
  it("returns array of file paths for HEAD~1", () => {
    const files = getFilesChanged(REPO_ROOT, "HEAD~1");
    expect(Array.isArray(files)).toBe(true);
    // Should have at least one file changed in the last commit
    expect(files.length).toBeGreaterThan(0);
    // Paths should be relative (no leading /)
    for (const f of files) {
      expect(f).not.toMatch(/^\//);
    }
  });

  it("returns empty array for a non-git directory", () => {
    expect(getFilesChanged(tempDir, "HEAD~1")).toEqual([]);
  });
});
