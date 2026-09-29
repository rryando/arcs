// ---------------------------------------------------------------------------
// Tests for the change ledger (src/utils/change-ledger.ts)
//
// Behavior, not snapshots: entry kinds, tombstone retraction, (taskId, sha)
// dedup, pending supersession, read-time reachability, "no patch body on disk",
// and concurrent-duplicate suppression (the donor's D7 window).
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendChange,
  type ChangeEntry,
  readChanges,
  readRawChanges,
  recordCommits,
  recordPending,
  removeChange,
  summarizeChanges,
} from "../src/utils/change-ledger.js";

const tempDirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const proc = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return (proc.stdout ?? "").trim();
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Ledger Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function commitFile(dir: string, name: string, content: string): string {
  writeFileSync(join(dir, name), content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `add ${name}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function makeEntry(overrides: Partial<ChangeEntry> = {}): ChangeEntry {
  return {
    taskId: "t1",
    kind: "commit",
    sha: SHA_A,
    recordedBy: "record-change",
    at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("change ledger — entry kinds and stored shape", () => {
  it("appends and reads a commit entry, newest first", async () => {
    const projectDir = makeDir("arcs-ledger-");
    await appendChange(
      projectDir,
      makeEntry({
        subject: "do a thing",
        author: "Ada",
        authoredAt: "2024-01-01T00:00:00.000Z",
        patchId: "c".repeat(40),
        files: [{ path: "src/a.ts", additions: 2, deletions: 1, hunks: ["@@ -1 +1,2 @@"] }],
      }),
    );

    const raw = await readRawChanges(projectDir);
    expect(raw).toHaveLength(1);

    const changes = await readChanges(projectDir, { taskId: "t1" });
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("commit");
    expect(changes[0].sha).toBe(SHA_A);
    expect(changes[0].patchId).toBe("c".repeat(40));
    expect(changes[0].files?.[0]).toEqual({
      path: "src/a.ts",
      additions: 2,
      deletions: 1,
      hunks: ["@@ -1 +1,2 @@"],
    });
  });

  it("never stores a patch body — only sha/subject/author/patchId/hunks headers", async () => {
    const projectDir = makeDir("arcs-ledger-");
    await appendChange(
      projectDir,
      makeEntry({
        files: [{ path: "src/a.ts", additions: 1, deletions: 0, hunks: ["@@ -0,0 +1 @@"] }],
      }),
    );
    const ledgerText = readFileSync(join(projectDir, "workflow", "changes.jsonl"), "utf-8");
    const parsed = JSON.parse(ledgerText.trim()) as Record<string, unknown>;

    expect(parsed).not.toHaveProperty("patch");
    expect(parsed).not.toHaveProperty("diff");
    expect(parsed).not.toHaveProperty("body");
    expect(ledgerText).not.toContain("diff --git");
    expect(ledgerText).not.toContain("+const ");
    expect((parsed.files as Array<{ hunks: string[] }>)[0].hunks).toEqual(["@@ -0,0 +1 @@"]);
  });

  it("stamps a pending entry from the worktree and summarizes totals", async () => {
    const projectDir = makeDir("arcs-ledger-");
    await appendChange(
      projectDir,
      makeEntry({
        kind: "pending",
        sha: undefined,
        files: [{ path: "src/wip.ts", additions: 3, deletions: 0, hunks: [] }],
        untracked: ["notes/new.md"],
      }),
    );

    const changes = await readChanges(projectDir, { taskId: "t1" });
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("pending");
    expect(changes[0].untracked).toEqual(["notes/new.md"]);

    expect(summarizeChanges(changes)).toEqual({
      commits: 0,
      pending: 1,
      prs: 0,
      files: 2,
      additions: 3,
      deletions: 0,
    });
  });
});

describe("change ledger — tombstone, dedup and supersession", () => {
  it("a tombstone retracts an earlier commit without rewriting the log", async () => {
    const projectDir = makeDir("arcs-ledger-");
    await appendChange(projectDir, makeEntry({ sha: SHA_A }));
    await removeChange(projectDir, "t1", SHA_A);

    // Raw log is append-only: both lines survive.
    expect(await readRawChanges(projectDir)).toHaveLength(2);
    // Effective view drops the retracted commit and never lists the tombstone.
    const changes = await readChanges(projectDir, { taskId: "t1" });
    expect(changes).toHaveLength(0);
  });

  it("lists a duplicate (taskId, sha) once", async () => {
    const projectDir = makeDir("arcs-ledger-");
    await appendChange(projectDir, makeEntry({ at: "2024-01-01T00:00:00.000Z" }));
    await appendChange(projectDir, makeEntry({ at: "2024-01-02T00:00:00.000Z" }));

    expect(await readRawChanges(projectDir)).toHaveLength(2);
    const changes = await readChanges(projectDir, { taskId: "t1" });
    expect(changes).toHaveLength(1);
  });

  it("hides a pending entry once a later commit lands for the same task", async () => {
    const projectDir = makeDir("arcs-ledger-");
    await appendChange(
      projectDir,
      makeEntry({ kind: "pending", sha: undefined, at: "2024-01-01T00:00:00.000Z" }),
    );
    await appendChange(projectDir, makeEntry({ sha: SHA_A, at: "2024-01-02T00:00:00.000Z" }));

    const changes = await readChanges(projectDir, { taskId: "t1" });
    expect(changes.map((c) => c.kind)).toEqual(["commit"]);
  });

  it("keeps a pending entry that has no later commit", async () => {
    const projectDir = makeDir("arcs-ledger-");
    await appendChange(projectDir, makeEntry({ sha: SHA_A, at: "2024-01-01T00:00:00.000Z" }));
    await appendChange(
      projectDir,
      makeEntry({ kind: "pending", sha: undefined, at: "2024-01-02T00:00:00.000Z" }),
    );

    const changes = await readChanges(projectDir, { taskId: "t1" });
    // newest first
    expect(changes.map((c) => c.kind)).toEqual(["pending", "commit"]);
  });

  it("filters by task and by plan", async () => {
    const projectDir = makeDir("arcs-ledger-");
    await appendChange(projectDir, makeEntry({ taskId: "t1", planId: "p1", sha: SHA_A }));
    await appendChange(projectDir, makeEntry({ taskId: "t2", planId: "p1", sha: SHA_B }));

    expect(await readChanges(projectDir, { taskId: "t1" })).toHaveLength(1);
    expect(await readChanges(projectDir, { planId: "p1" })).toHaveLength(2);
  });
});

describe("change ledger — read-time reachability", () => {
  it("computes reachable on read and never stores it", async () => {
    const projectDir = makeDir("arcs-ledger-");
    const repo = makeDir("arcs-ledger-repo-");
    initRepo(repo);
    const base = commitFile(repo, "a.txt", "one\n");
    const head = commitFile(repo, "b.txt", "two\n");

    await appendChange(projectDir, makeEntry({ sha: head }));

    const reachable = await readChanges(projectDir, { taskId: "t1", cwd: repo });
    expect(reachable[0].reachable).toBe(true);
    expect(base).not.toBe(head);

    // `reachable` is not persisted: the raw line has no such key.
    const rawLine = JSON.parse(
      readFileSync(join(projectDir, "workflow", "changes.jsonl"), "utf-8").trim(),
    ) as Record<string, unknown>;
    expect(rawLine).not.toHaveProperty("reachable");

    // Rewind HEAD so the recorded sha is no longer reachable.
    git(repo, ["reset", "--hard", base]);
    const dangling = await readChanges(projectDir, { taskId: "t1", cwd: repo });
    expect(dangling[0].reachable).toBe(false);
  });

  it("omits reachable entirely when no cwd is given", async () => {
    const projectDir = makeDir("arcs-ledger-");
    await appendChange(projectDir, makeEntry({ sha: SHA_A }));
    const changes = await readChanges(projectDir, { taskId: "t1" });
    expect(changes[0]).not.toHaveProperty("reachable");
  });
});

describe("change ledger — recordCommits", () => {
  it("snapshots shas from git and skips invalid/unreachable ones", async () => {
    const projectDir = makeDir("arcs-ledger-");
    const repo = makeDir("arcs-ledger-repo-");
    initRepo(repo);
    commitFile(repo, "a.txt", "one\n");
    const head = commitFile(repo, "b.txt", "two\n");

    const result = await recordCommits(projectDir, {
      taskId: "t1",
      cwd: repo,
      shas: [head, "not-a-sha", "deadbeef"],
      recordedBy: "done",
    });

    expect(result.recorded).toHaveLength(1);
    expect(result.recorded[0].sha).toBe(head);
    expect(result.recorded[0].files?.some((f) => f.path === "b.txt")).toBe(true);
    expect(result.skipped).toContainEqual({ sha: "not-a-sha", reason: "invalid" });
    expect(result.skipped).toContainEqual({ sha: "deadbeef", reason: "unreachable" });
  });

  it("suppresses duplicate (taskId, sha) lines under concurrency (D7)", async () => {
    const projectDir = makeDir("arcs-ledger-");
    const repo = makeDir("arcs-ledger-repo-");
    initRepo(repo);
    commitFile(repo, "a.txt", "one\n");
    const head = commitFile(repo, "b.txt", "two\n");

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        recordCommits(projectDir, {
          taskId: "t1",
          cwd: repo,
          shas: [head],
          recordedBy: "done",
        }),
      ),
    );

    const totalRecorded = results.reduce((n, r) => n + r.recorded.length, 0);
    expect(totalRecorded).toBe(1);

    const rawLines = readFileSync(join(projectDir, "workflow", "changes.jsonl"), "utf-8")
      .trim()
      .split("\n");
    expect(rawLines).toHaveLength(1);

    const changes = await readChanges(projectDir, { taskId: "t1" });
    expect(changes.filter((c) => c.kind === "commit" && c.sha === head)).toHaveLength(1);
  });

  it("records a pending entry only when the worktree is dirty", async () => {
    const projectDir = makeDir("arcs-ledger-");
    const repo = makeDir("arcs-ledger-repo-");
    initRepo(repo);
    commitFile(repo, "a.txt", "one\n");

    expect(
      await recordPending(projectDir, { taskId: "t1", cwd: repo, recordedBy: "done" }),
    ).toBeUndefined();

    writeFileSync(join(repo, "a.txt"), "one\nchanged\n");
    writeFileSync(join(repo, "untracked.txt"), "new\n");
    const pending = await recordPending(projectDir, {
      taskId: "t1",
      cwd: repo,
      recordedBy: "done",
    });
    expect(pending?.kind).toBe("pending");
    expect(pending?.untracked).toContain("untracked.txt");
    expect(pending?.files?.some((f) => f.path === "a.txt")).toBe(true);
  });
});
