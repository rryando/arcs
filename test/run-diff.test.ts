/**
 * Helper units of the workspace review surface (run-diff.ts) plus the
 * sidecar-aware retention (run-event-log.ts) — everything route-level tests
 * lean on but do not assert directly.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDir, writeJson } from "../src/utils/storage-utils.js";
import {
  captureWorkspaceSnapshot,
  computeWorkspaceChanges,
  persistRunSnapshot,
  RUN_DIFF_MAX_LINES,
  readRunChanges,
  readRunSnapshot,
  revertWorkspaceChanges,
  runChangesPath,
  runSnapshotPath,
  writeSettledRunChanges,
} from "../src/web-server/run-diff.js";
import { pruneRunEventLogs, runEventLogPath } from "../src/web-server/run-event-log.js";

/** A fresh throwaway workspace dir, removed by the end of each test. */
function tempWorkspace(): string {
  return mkdtempSync(resolve(tmpdir(), "arcs-snap-"));
}

function git(workspace: string, args: string[]): void {
  const proc = spawnSync(
    "git",
    ["-c", "user.email=test@arcs.test", "-c", "user.name=ARCS Test", ...args],
    { cwd: workspace, encoding: "utf-8" },
  );
  if (proc.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr ?? proc.error}`);
  }
}

describe("snapshot capture", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = tempWorkspace();
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("records a git baseline with head and untracked list, copying no contents", async () => {
    git(workspace, ["init", "-q"]);
    writeFileSync(resolve(workspace, "a.txt"), "a\n", "utf-8");
    writeFileSync(resolve(workspace, "pre.txt"), "untracked\n", "utf-8");
    git(workspace, ["add", "a.txt"]);
    git(workspace, ["commit", "-q", "-m", "seed"]);

    const snapshot = await captureWorkspaceSnapshot(workspace);
    expect(snapshot.mode).toBe("git");
    if (snapshot.mode !== "git") throw new Error("expected git snapshot");
    expect(snapshot.head).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.untracked).toEqual(["pre.txt"]);
    expect(snapshot.error).toBeUndefined();
    expect("files" in snapshot).toBe(false); // deliberately no manifest walk
  });

  it("walks a non-git workspace into a hash manifest, skipping the skip-sets and symlinks", async () => {
    writeFileSync(resolve(workspace, "b.txt"), "bb\n", "utf-8");
    mkdirSync(resolve(workspace, "node_modules"), { recursive: true });
    writeFileSync(resolve(workspace, "node_modules/dep.js"), "x\n", "utf-8");
    mkdirSync(resolve(workspace, ".codegraph"), { recursive: true });
    writeFileSync(resolve(workspace, ".codegraph/index.json"), "{}", "utf-8");
    writeFileSync(resolve(workspace, "linked.txt"), "content\n", "utf-8");
    // A symlink is skipped entirely (never followed outside the root).
    const { symlinkSync } = await import("node:fs");
    symlinkSync(resolve(workspace, "linked.txt"), resolve(workspace, "alias.txt"));

    const snapshot = await captureWorkspaceSnapshot(workspace);
    expect(snapshot.mode).toBe("tree");
    if (snapshot.mode !== "tree") throw new Error("expected tree snapshot");
    expect(Object.keys(snapshot.files).sort()).toEqual(["b.txt", "linked.txt"]);
    expect(snapshot.files["linked.txt"]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Baseline bytes ride along for small files.
    expect(snapshot.blobs["b.txt"]).toBeDefined();
    expect(snapshot.error).toBeUndefined();
  });

  it("stops capturing baseline bytes past the blob cap but keeps later files that fit", async () => {
    writeFileSync(resolve(workspace, "a.txt"), "a\n", "utf-8");
    writeFileSync(resolve(workspace, "big.bin"), Buffer.alloc(64, 0x62));
    writeFileSync(resolve(workspace, "c.txt"), "c\n", "utf-8");

    // tiny cap: big.bin refuses a blob, but the small files still get theirs
    const snapshot = await captureWorkspaceSnapshot(workspace, { blobMaxBytes: 32 });
    expect(snapshot.mode).toBe("tree");
    if (snapshot.mode !== "tree") throw new Error("expected tree snapshot");
    expect(snapshot.blobCapped).toBe(true);
    expect(snapshot.blobs["a.txt"]).toBeDefined();
    expect(snapshot.blobs["big.bin"]).toBeUndefined();
    expect(snapshot.blobs["c.txt"]).toBeDefined();
  });

  it("records an error (not a throw) for a missing workspace", async () => {
    const snapshot = await captureWorkspaceSnapshot(resolve(workspace, "nope"));
    expect(snapshot.error).toBeDefined();
    expect(await computeWorkspaceChanges(snapshot)).toEqual([]);
  });
});

describe("diff budgeting", () => {
  /** A change list larger than RUN_DIFF_MAX_LINES lines with a per-line count. */
  function manyLines(n: number): string {
    return Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
  }

  it("caps one change's diff at RUN_DIFF_MAX_LINES while counting the full diff", async () => {
    const workspace = tempWorkspace();
    try {
      writeFileSync(resolve(workspace, "f.txt"), manyLines(2), "utf-8");
      const snapshot = await captureWorkspaceSnapshot(workspace);
      // The run rewrites the file with many more lines.
      writeFileSync(resolve(workspace, "f.txt"), manyLines(600), "utf-8");
      const changes = await computeWorkspaceChanges(snapshot);
      const change = changes.find((entry) => entry.path === "f.txt");
      expect(change).toBeDefined();
      expect(change?.status).toBe("modified");
      // The WHOLE diff was counted…
      expect(change?.linesAdded).toBe(600);
      expect(change?.linesRemoved).toBe(2);
      // …but only the capped head is rendered.
      expect(change?.diff?.split("\n").length).toBeLessThanOrEqual(RUN_DIFF_MAX_LINES + 1);
      expect(change?.diff?.split("\n").length).toBeGreaterThan(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("sidecar lifecycle", () => {
  let project: string;
  beforeEach(() => {
    project = tempWorkspace();
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("prunes a run's log AND its snapshot/changes sidecars together, keeping the newest runs", async () => {
    const sessionId = "demo";
    const runs = ["run-1", "run-2", "run-3"].map((id) => id.replace("-", ""));
    // Create run files with staggered mtimes so retention ordering is stable.
    for (let i = 0; i < runs.length; i++) {
      const runId = runs[i] ?? "x";
      await ensureDir(dirname(runEventLogPath(project, sessionId, runId)));
      await writeJson(runEventLogPath(project, sessionId, runId), { line: i });
      await writeJson(runSnapshotPath(project, sessionId, runId), { mode: "git", head: "x" });
      await writeJson(runChangesPath(project, sessionId, runId), { changes: [] });
      const stamp = new Date(1_700_000_000_000 + i * 60_000);
      for (const path of [
        runEventLogPath(project, sessionId, runId),
        runSnapshotPath(project, sessionId, runId),
        runChangesPath(project, sessionId, runId),
      ]) {
        const { utimesSync } = await import("node:fs");
        utimesSync(path, stamp, stamp);
      }
    }

    // Keep 2 runs → the oldest run's three files all go (never one of them).
    const pruned = await pruneRunEventLogs(project, sessionId, 2);
    expect(pruned).toBe(3);

    const newest = runs[runs.length - 1] as string;
    const older = runs[0] as string;
    expect(existsSync(runEventLogPath(project, sessionId, older))).toBe(false);
    expect(existsSync(runSnapshotPath(project, sessionId, older))).toBe(false);
    expect(existsSync(runChangesPath(project, sessionId, older))).toBe(false);
    expect(existsSync(runEventLogPath(project, sessionId, newest))).toBe(true);
    expect(existsSync(runSnapshotPath(project, sessionId, newest))).toBe(true);
    expect(existsSync(runChangesPath(project, sessionId, newest))).toBe(true);
  });
});

describe("revert scoping", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = tempWorkspace();
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("refuses a change path that escapes the snapshot root", async () => {
    writeFileSync(resolve(workspace, "keep.txt"), "keep\n", "utf-8");
    const snapshot = await captureWorkspaceSnapshot(workspace);
    const outside = resolve(workspace, "..", "arcs-snap-escape-target.txt");
    writeFileSync(outside, "do not touch\n", "utf-8");
    try {
      // A hand-edited changes manifest smuggling an escaping path.
      const restored = await revertWorkspaceChanges(snapshot, [
        {
          path: "../arcs-snap-escape-target.txt",
          status: "added",
          linesAdded: 1,
          linesRemoved: 0,
          diff: null,
        },
      ]);
      expect(restored).toEqual([]);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("never deletes an untracked path the snapshot already listed", async () => {
    git(workspace, ["init", "-q"]);
    writeFileSync(resolve(workspace, "tracked.txt"), "t\n", "utf-8");
    git(workspace, ["add", "tracked.txt"]);
    git(workspace, ["commit", "-q", "-m", "seed"]);
    writeFileSync(resolve(workspace, "old-untracked.txt"), "pre\n", "utf-8");
    const snapshot = await captureWorkspaceSnapshot(workspace);
    expect(snapshot.mode).toBe("git");
    if (snapshot.mode !== "git") throw new Error("expected git snapshot");
    expect(snapshot.untracked).toContain("old-untracked.txt");

    // A corrupt/hand-edited manifest claims the pre-existing file was added.
    const restored = await revertWorkspaceChanges(snapshot, [
      { path: "old-untracked.txt", status: "added", linesAdded: 1, linesRemoved: 0, diff: null },
    ]);
    expect(restored).toEqual([]);
    expect(existsSync(resolve(workspace, "old-untracked.txt"))).toBe(true);
  });
});

describe("settle-time manifest write", () => {
  let project: string;
  let workspace: string;
  beforeEach(() => {
    project = tempWorkspace();
    workspace = tempWorkspace();
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("writeSettledRunChanges skips a run whose snapshot exists but errored", async () => {
    const runId = "missing-snapshot-run";
    const snapshot = await captureWorkspaceSnapshot(resolve(workspace, "does-not-exist"));
    expect(snapshot.error).toBeDefined();
    await persistRunSnapshot(project, "demo", runId, snapshot);
    await writeSettledRunChanges(project, "demo", runId);
    // No changes manifest was written — GET /changes reads absent as [].
    expect(await readRunChanges(project, "demo", runId)).toBeUndefined();
    expect(await readRunSnapshot(project, "demo", runId)).toBeDefined();
  });
});
