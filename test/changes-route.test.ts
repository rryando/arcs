/**
 * Workspace review surface — GET /changes + POST /revert.
 *
 * End-to-end through the ask route with the runner faked (vi.mock on
 * claude-runner), exactly like ask-route.test.ts: the POST handler captures
 * the spawn-time snapshot, the fake runner's "run" edits the REAL workspace
 * and settles through the route's own write-back, which diffs the workspace
 * against the snapshot — so the whole capture → diff → review → revert
 * pipeline is exercised with real files and a real git repo, without a real
 * child process.
 *
 * Two workspace modes: a hermetic git repo (git init + `-c` user identity —
 * no global config, no author dates) and a plain temp dir where the diff
 * rides the hash manifest plus the snapshot's baseline bytes.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ClaudeJobInput,
  type ClaudeRunRecord,
  liveRunPid,
  runClaudeJob,
} from "../src/web-server/claude-runner.js";
import { startWebServer, type WebServerHandle } from "../src/web-server/index.js";
import { getRun } from "../src/web-server/run-store.js";
import { currentWebToken } from "../src/web-server/web-token.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

vi.mock("../src/web-server/claude-runner.js", () => ({
  liveRunPid: vi.fn(() => 4242),
  resolveTimeoutMs: vi.fn(() => 600_000),
  runClaudeJob: vi.fn(),
}));

vi.mock("../src/web-server/run-driver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/web-server/run-driver.js")>();
  return { ...actual, getRunDriver: vi.fn(actual.getRunDriver) };
});

const RUN_RECORD: ClaudeRunRecord = {
  pid: 4242,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  outcome: "success",
  replyText: "done",
  replyChars: 4,
};

/** What the fake "run" does to the workspace just before it settles. Settled
 *  via the route's real write-back, which diffs against the snapshot captured
 *  at spawn time. */
let runEdits: (() => void) | undefined;
/** When true, the fake runner holds each job's onSettled until release — a
 *  live, unsettled claim to test the not-settled guards against. */
let holdWriteBacks = false;
let releaseHeld: (() => void) | undefined;
let capturedJobs: ClaudeJobInput[] = [];

beforeEach(() => {
  runEdits = undefined;
  holdWriteBacks = false;
  releaseHeld = undefined;
  capturedJobs = [];
  vi.mocked(liveRunPid).mockReturnValue(4242);
  vi.mocked(runClaudeJob).mockImplementation(async (input) => {
    capturedJobs.push(input);
    if (input.onSettled === undefined) return RUN_RECORD;
    if (holdWriteBacks) {
      await new Promise<void>((resolveHeld) => {
        releaseHeld = () => {
          resolveHeld();
          void input.onSettled?.(RUN_RECORD);
        };
      });
      return RUN_RECORD;
    }
    // The run's own effect on the workspace, applied before the child "exits".
    runEdits?.();
    await input.onSettled(RUN_RECORD);
    return RUN_RECORD;
  });
});

afterEach(() => {
  vi.mocked(liveRunPid).mockReset();
  vi.mocked(runClaudeJob).mockReset();
  releaseHeld = undefined;
});

interface ChangesCtx {
  base: string;
  projectDir: string;
  workspace: string;
}

async function withChangesCtx(run: (ctx: ChangesCtx) => Promise<void>): Promise<void> {
  await withTempDataDir(async (dir) => {
    writeFileSync(
      resolve(dir, "meta.json"),
      JSON.stringify({
        version: "1.0",
        projects: [{ id: "demo", name: "Demo", status: "active", dependsOn: [] }],
      }),
      "utf-8",
    );
    const projectDir = resolve(dir, "projects", "demo");
    mkdirSync(projectDir, { recursive: true });
    const workspace = mkdtempSync(resolve(tmpdir(), "arcs-ws-"));
    try {
      writeFileSync(
        resolve(projectDir, "meta.json"),
        JSON.stringify({
          id: "demo",
          name: "Demo",
          description: "test project",
          createdAt: "2026-01-01T00:00:00.000Z",
          workspacePaths: [workspace],
        }),
        "utf-8",
      );

      let server: WebServerHandle | null = null;
      try {
        server = await startWebServer({ port: 0, host: "127.0.0.1", watch: false });
        await run({ base: server.url, projectDir, workspace });
      } finally {
        await server?.close();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

/** Hermetic git: identity rides every command via `-c`, so no global config
 *  and no author dates are ever consulted. */
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

function seedGitRepo(workspace: string, seed: Record<string, string>): void {
  git(workspace, ["init", "-q"]);
  for (const [name, content] of Object.entries(seed)) {
    writeFileSync(resolve(workspace, name), content, "utf-8");
  }
  git(workspace, ["add", "."]);
  git(workspace, ["commit", "-q", "-m", "seed"]);
}

function workspaceStatus(workspace: string): string {
  const proc = spawnSync("git", ["status", "--porcelain=v1"], {
    cwd: workspace,
    encoding: "utf-8",
  });
  return (proc.stdout ?? "").trim();
}

interface AskEnvelope {
  ok?: boolean;
  code?: string;
  message?: string;
  runId?: string;
}

async function postAsk(base: string, body: unknown): Promise<{ status: number; runId?: string }> {
  const res = await fetch(`${base}/api/p/demo/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() },
    body: JSON.stringify(body),
  });
  const envelope = (await res.json()) as AskEnvelope & { data?: unknown };
  return { status: res.status, runId: ((envelope.data ?? envelope) as AskEnvelope).runId };
}

interface ChangeEntry {
  path: string;
  status: "modified" | "added" | "deleted";
  linesAdded: number;
  linesRemoved: number;
  diff: string | null;
  capped?: boolean;
}

interface ChangesEnvelope {
  runId?: string;
  settled?: boolean;
  changes?: ChangeEntry[];
  reverted?: boolean;
  restored?: string[];
  ok?: boolean;
  code?: string;
  message?: string;
}

async function getChanges(
  base: string,
  runId: string,
): Promise<{ status: number; data: ChangesEnvelope }> {
  const res = await fetch(`${base}/api/p/demo/runs/${runId}/changes`, {
    headers: { "X-ARCS-Token": currentWebToken() },
  });
  const envelope = (await res.json()) as ChangesEnvelope & { data?: unknown };
  return { status: res.status, data: (envelope.data ?? envelope) as ChangesEnvelope };
}

async function postRevert(
  base: string,
  runId: string,
): Promise<{ status: number; data: ChangesEnvelope }> {
  const res = await fetch(`${base}/api/p/demo/runs/${runId}/revert`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() },
  });
  const envelope = (await res.json()) as ChangesEnvelope & { data?: unknown };
  return { status: res.status, data: (envelope.data ?? envelope) as ChangesEnvelope };
}

const waitFor = async (fn: () => boolean | Promise<boolean>, label: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 10));
  }
};

/**
 * Polls GET /changes until the run has settled AND `predicate` holds over the
 * changes list. The settle stamp lands BEFORE the write-back's diff sidecar
 * (the diff is computed after the settle, best-effort), so waiting for the
 * CHANGES is the real readiness signal — and the client panel must poll the
 * same way, since an empty list is also what a no-change run legitimately
 * settles to.
 */
async function waitForChanges(
  base: string,
  runId: string,
  predicate: (changes: ChangeEntry[]) => boolean,
): Promise<ChangesEnvelope> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const { data } = await getChanges(base, runId);
    if (data.settled === true && predicate(data.changes ?? [])) return data;
    if (Date.now() > deadline) throw new Error("timed out waiting for the run's changes");
    await new Promise((done) => setTimeout(done, 25));
  }
}

describe("git workspace — diff + revert through the ask route", () => {
  it("lists exactly the run's three changes with diffs, then revert puts the worktree back", async () => {
    await withChangesCtx(async ({ base, workspace }) => {
      seedGitRepo(workspace, {
        "tracked.txt": "line one\nline two\n",
        "gone.txt": "bye\n",
      });

      runEdits = () => {
        // modify a tracked file, add an untracked one, delete a tracked one
        writeFileSync(resolve(workspace, "tracked.txt"), "line one\nCHANGED\nline two\n", "utf-8");
        writeFileSync(resolve(workspace, "new.txt"), "fresh\n", "utf-8");
        rmSync(resolve(workspace, "gone.txt"));
      };

      const { status, runId } = await postAsk(base, { message: "make changes" });
      expect(status).toBe(202);
      expect(runId).toBeDefined();

      // The diff sidecar lands a beat after the settle stamps (the write-back
      // settles first, then diffs — best-effort), so poll for the CHANGES, not
      // just the settled flag.
      const data = await waitForChanges(base, runId as string, (changes) => changes.length === 3);
      expect(data.runId).toBe(runId);
      expect(data.settled).toBe(true);
      expect(data.changes).toHaveLength(3);

      const byPath = new Map((data.changes ?? []).map((change) => [change.path, change]));
      const modified = byPath.get("tracked.txt");
      expect(modified?.status).toBe("modified");
      // git's native unified diff: a one-line insert — context on either side.
      expect(modified?.diff).toContain("+CHANGED");
      expect(modified?.diff).toContain("line two");
      expect(modified?.linesAdded).toBe(1);
      expect(modified?.linesRemoved).toBe(0);

      const added = byPath.get("new.txt");
      expect(added?.status).toBe("added");
      // Untracked: synthesized whole-file `+N`-numbered lines.
      expect(added?.diff).toContain("+1 fresh");
      expect(added?.linesAdded).toBe(1);

      const deleted = byPath.get("gone.txt");
      expect(deleted?.status).toBe("deleted");
      // Tracked deletion: git's native whole-file `-` diff.
      expect(deleted?.diff).toContain("-bye");
      expect(deleted?.linesRemoved).toBe(1);

      // Approve/reject: revert restores all three.
      const reverted = await postRevert(base, runId as string);
      expect(reverted.status).toBe(200);
      expect(reverted.data.reverted).toBe(true);
      expect([...(reverted.data.restored ?? [])].sort()).toEqual([
        "gone.txt",
        "new.txt",
        "tracked.txt",
      ]);

      expect(readFileSync(resolve(workspace, "tracked.txt"), "utf-8")).toBe("line one\nline two\n");
      expect(readFileSync(resolve(workspace, "gone.txt"), "utf-8")).toBe("bye\n");
      expect(existsSync(resolve(workspace, "new.txt"))).toBe(false);
      // The worktree is clean again — the revert undid the run exactly.
      expect(workspaceStatus(workspace)).toBe("");

      // A second revert is refused — one revert per run.
      const again = await postRevert(base, runId as string);
      expect(again.status).toBe(409);
      expect(again.data.code).toBe("RUN_ALREADY_REVERTED");
    });
  });

  it("a run that changes nothing writes an empty changes list", async () => {
    await withChangesCtx(async ({ base, workspace }) => {
      seedGitRepo(workspace, { "tracked.txt": "untouched\n" });

      const { status, runId } = await postAsk(base, { message: "do nothing" });
      expect(status).toBe(202);

      await waitFor(
        async () => (await getChanges(base, runId as string)).data.settled === true,
        "the no-op run to settle",
      );
      const data = await waitForChanges(base, runId as string, (changes) => changes.length === 0);
      expect(data.settled).toBe(true);
      expect(data.changes).toEqual([]);
    });
  });

  it("a pre-existing untracked file is not the run's change and survives revert", async () => {
    await withChangesCtx(async ({ base, workspace }) => {
      seedGitRepo(workspace, { "tracked.txt": "mine\n" });
      // Already untracked BEFORE the run: the run merely keeps it untracked.
      writeFileSync(resolve(workspace, "pre.txt"), "pre-existing\n", "utf-8");

      runEdits = () => {
        writeFileSync(resolve(workspace, "tracked.txt"), "edited\n", "utf-8");
      };

      const { runId } = await postAsk(base, { message: "edit" });
      const data = await waitForChanges(base, runId as string, (changes) => changes.length === 1);
      expect(data.changes?.map((change) => change.path)).toEqual(["tracked.txt"]);

      await postRevert(base, runId as string);
      // The pre-existing untracked file was NOT deleted by the revert.
      expect(existsSync(resolve(workspace, "pre.txt"))).toBe(true);
      expect(readFileSync(resolve(workspace, "pre.txt"), "utf-8")).toBe("pre-existing\n");
      expect(readFileSync(resolve(workspace, "tracked.txt"), "utf-8")).toBe("mine\n");
    });
  });
});

describe("non-git workspace — manifest diff, baseline-byte revert", () => {
  it("differs modified/added/deleted via the manifest and reverts from the snapshot bytes", async () => {
    await withChangesCtx(async ({ base, workspace }) => {
      // A file beyond the snapshot's 20MB baseline-byte cap: its diff is
      // unavailable (capped) and revert cannot rebuild it.
      const big = Buffer.alloc(21 * 1024 * 1024, 0x61);
      writeFileSync(resolve(workspace, "big.bin"), big);
      writeFileSync(resolve(workspace, "keep.txt"), "one\ntwo\n", "utf-8");
      writeFileSync(resolve(workspace, "drop.txt"), "bye\n", "utf-8");

      runEdits = () => {
        writeFileSync(resolve(workspace, "keep.txt"), "one\nEDITED\ntwo\n", "utf-8");
        writeFileSync(resolve(workspace, "made.txt"), "made\n", "utf-8");
        rmSync(resolve(workspace, "drop.txt"));
        // bump the big file past its recorded size
        writeFileSync(resolve(workspace, "big.bin"), Buffer.concat([big, Buffer.from("x")]));
      };

      const { runId } = await postAsk(base, { message: "edit plain dir" });
      const data = await waitForChanges(base, runId as string, (changes) => changes.length === 4);
      const byPath = new Map((data.changes ?? []).map((change) => [change.path, change]));

      const modified = byPath.get("keep.txt");
      expect(modified?.status).toBe("modified");
      expect(modified?.diff).toContain("-2 two");
      expect(modified?.diff).toContain("+2 EDITED");
      expect(modified?.capped).toBeUndefined();
      expect(modified?.linesAdded).toBe(3);
      expect(modified?.linesRemoved).toBe(2);

      const added = byPath.get("made.txt");
      expect(added?.status).toBe("added");
      expect(added?.diff).toContain("+1 made");
      expect(added?.capped).toBeUndefined();

      const deleted = byPath.get("drop.txt");
      expect(deleted?.status).toBe("deleted");
      expect(deleted?.diff).toContain("-1 bye");
      expect(deleted?.capped).toBeUndefined();

      // Baseline bytes were refused for the oversized file: capped, diff null,
      // and it is skipped by (not reported from) the revert.
      const capped = byPath.get("big.bin");
      expect(capped?.status).toBe("modified");
      expect(capped?.capped).toBe(true);
      expect(capped?.diff).toBeNull();

      const reverted = await postRevert(base, runId as string);
      expect(reverted.status).toBe(200);
      expect(reverted.data.reverted).toBe(true);
      expect([...(reverted.data.restored ?? [])].sort()).toEqual([
        "drop.txt",
        "keep.txt",
        "made.txt",
      ]);

      expect(readFileSync(resolve(workspace, "keep.txt"), "utf-8")).toBe("one\ntwo\n");
      expect(readFileSync(resolve(workspace, "drop.txt"), "utf-8")).toBe("bye\n");
      expect(existsSync(resolve(workspace, "made.txt"))).toBe(false);
      // The big file was beyond the cap — revert leaves the run's edit in place.
      expect(readFileSync(resolve(workspace, "big.bin")).length).toBe(big.length + 1);
    });
  });
});

describe("route guards", () => {
  it("unknown runs answer 404 RUN_NOT_FOUND on both endpoints", async () => {
    await withChangesCtx(async ({ base }) => {
      const missing = await getChanges(base, "no-such-run");
      expect(missing.status).toBe(404);
      expect(missing.data.code).toBe("RUN_NOT_FOUND");

      const revert = await postRevert(base, "no-such-run");
      expect(revert.status).toBe(404);
      expect(revert.data.code).toBe("RUN_NOT_FOUND");
    });
  });

  it("a live run reports settled:false and refuses revert with RUN_NOT_SETTLED", async () => {
    await withChangesCtx(async ({ base, workspace, projectDir }) => {
      seedGitRepo(workspace, { "tracked.txt": "x\n" });
      holdWriteBacks = true;
      const { runId } = await postAsk(base, { message: "slow" });
      expect(runId).toBeDefined();

      // Held write-back: the claim is live (no outcome stamped yet).
      await waitFor(
        async () => (await getRun(projectDir, runId as string)) !== undefined,
        "the claim",
      );

      const { data } = await getChanges(base, runId as string);
      expect(data.settled).toBe(false);
      expect(data.changes).toEqual([]);

      const revert = await postRevert(base, runId as string);
      expect(revert.status).toBe(400);
      expect(revert.data.code).toBe("RUN_NOT_SETTLED");

      holdWriteBacks = false;
      releaseHeld?.();
    });
  });
});
