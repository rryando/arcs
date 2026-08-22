// ---------------------------------------------------------------------------
// Tests for session-store — CRUD, upsert idempotency, filters, validation
// ---------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlan } from "../src/utils/plan-store.js";
import {
  beginSessionRun,
  CHECKPOINT_TTL_MS,
  createSession,
  deleteSession,
  deriveSessionPhase,
  getSession,
  listSessions,
  RUN_HEARTBEAT_TTL_MS,
  readSessionIndex,
  settleSessionRun,
  updateSession,
  upsertSession,
} from "../src/utils/session-store.js";
import { createTask } from "../src/utils/task-store.js";
import { classifyChange } from "../src/web-server/watcher.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const tempDirs: string[] = [];

function makeProjectDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "arcs-session-store-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("session-store: create", () => {
  it("creates a claude-code session with defaults", async () => {
    const dir = makeProjectDir();
    const session = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_044c13d2dffeggKIOZf9LscKxX",
    });

    expect(session.runtimeSessionId).toBe("ses_044c13d2dffeggKIOZf9LscKxX");
    expect(session.normalizedId).toBe("ses-044c13d2dffeggkiozf9lsckxx");
    expect(session.id).toBe(session.normalizedId);
    expect(session.status).toBe("active");
    expect(session.startedAt).toBe(session.updatedAt);
    expect(session.lastMessageAt).toBeUndefined();
  });

  it("writes a flat sessions/index.json", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "ses_one" });

    const raw = readFileSync(resolve(dir, "sessions", "index.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw).sessions).toHaveLength(1);
  });

  it("rejects a duplicate runtime session id", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "ses_one" });
    await expect(
      createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "ses_one" }),
    ).rejects.toThrow("already exists");
  });

  it("rejects an unknown runtime type", async () => {
    const dir = makeProjectDir();
    await expect(
      createSession(dir, {
        runtimeType: "cursor" as never,
        runtimeSessionId: "ses_one",
      }),
    ).rejects.toThrow("Invalid session runtime type");
  });

  it("rejects an unknown status", async () => {
    const dir = makeProjectDir();
    await expect(
      createSession(dir, {
        runtimeType: "claude-code",
        runtimeSessionId: "ses_one",
        status: "zombie" as never,
      }),
    ).rejects.toThrow("Invalid session status");
  });

  it("rejects a runtime session id that normalizes to nothing", async () => {
    const dir = makeProjectDir();
    await expect(
      createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "___" }),
    ).rejects.toThrow("Invalid runtime session id");
  });

  it("keys a thread minted before its runtime id exists on its record name", async () => {
    const dir = makeProjectDir();
    // An ARCS-minted opencode thread: no runtime-native session id exists yet —
    // the first settled run harvests one and writes it back.
    const thread = await createSession(dir, {
      runtimeType: "opencode",
      recordName: "arcs-thread-demo-1",
      origin: "arcs",
    });

    expect(thread.normalizedId).toBe("arcs-thread-demo-1");
    expect(thread.runtimeSessionId).toBe("");
    expect((await getSession(dir, "arcs-thread-demo-1")).id).toBe(thread.id);
  });

  it("rejects a payload with neither a usable runtime id nor a record name", async () => {
    const dir = makeProjectDir();
    await expect(
      createSession(dir, { runtimeType: "opencode", runtimeSessionId: "" }),
    ).rejects.toThrow("Invalid runtime session id");
  });
});

describe("session-store: read", () => {
  it("returns an empty index for a project with no sessions dir", async () => {
    const dir = makeProjectDir();
    expect(await readSessionIndex(dir)).toEqual({ sessions: [] });
    expect(await listSessions(dir)).toEqual([]);
  });

  it("gets a session by raw runtime id or normalized id", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_ABC",
    });

    expect((await getSession(dir, "ses_ABC")).id).toBe(created.id);
    expect((await getSession(dir, created.normalizedId)).id).toBe(created.id);
  });

  it("throws when the session is missing", async () => {
    const dir = makeProjectDir();
    await expect(getSession(dir, "ses_missing")).rejects.toThrow("Could not find session");
  });

  it("filters by status and runtime type", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "ses_a" });
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_b",
      status: "idle",
    });
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "cc_c",
      status: "idle",
    });

    expect(await listSessions(dir, { status: "idle" })).toHaveLength(2);
    expect(await listSessions(dir, { runtimeType: "claude-code" })).toHaveLength(3);
    expect(await listSessions(dir, { status: "idle", runtimeType: "claude-code" })).toHaveLength(2);
  });
});

describe("session-store: upsert", () => {
  it("creates on first sight and updates in place afterwards", async () => {
    const dir = makeProjectDir();
    const first = await upsertSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
      startedAt: "2026-01-01T00:00:00.000Z",
      metadata: { title: "first" },
    });
    const second = await upsertSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
      status: "idle",
      metadata: { directory: "/repo" },
    });

    expect(second.normalizedId).toBe(first.normalizedId);
    expect(second.status).toBe("idle");
    expect(second.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(second.metadata).toEqual({ title: "first", directory: "/repo" });
    expect((await readSessionIndex(dir)).sessions).toHaveLength(1);
  });

  it("keeps the existing status when the upsert omits one", async () => {
    const dir = makeProjectDir();
    await upsertSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
      status: "failed",
    });
    const updated = await upsertSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
      lastMessageAt: "2026-01-02T00:00:00.000Z",
    });

    expect(updated.status).toBe("failed");
    expect(updated.lastMessageAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("never lets a blank-runtime-id upsert clobber a harvested runtime id", async () => {
    const dir = makeProjectDir();
    await createSession(dir, {
      runtimeType: "opencode",
      recordName: "arcs-thread-demo-1",
      origin: "arcs",
    });
    // The first settled run harvested its opencode session id…
    await updateSession(dir, {
      id: "arcs-thread-demo-1",
      runtimeSessionId: "ses_0HarvestedId000000000000",
    });

    // …and a later upsert that does not know one must not erase it.
    const refreshed = await upsertSession(dir, {
      runtimeType: "opencode",
      recordName: "arcs-thread-demo-1",
      metadata: { directory: "/repo" },
    });

    expect(refreshed.runtimeSessionId).toBe("ses_0HarvestedId000000000000");
  });
});

// ---------------------------------------------------------------------------
// Origin — provenance and the capability derived from it
// ---------------------------------------------------------------------------

/** Writes a raw sessions/index.json in the shape a build without `origin` left
 *  on disk, so back-compat is proven against real legacy bytes rather than
 *  against a record this build wrote. */
function writeLegacyIndex(dir: string, sessions: Record<string, unknown>[]): void {
  mkdirSync(resolve(dir, "sessions"), { recursive: true });
  writeFileSync(
    resolve(dir, "sessions", "index.json"),
    `${JSON.stringify({ sessions }, null, 2)}\n`,
    "utf-8",
  );
}

function legacyRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "cc-legacy",
    normalizedId: "cc-legacy",
    runtimeType: "claude-code",
    runtimeSessionId: "cc-legacy",
    status: "active",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function rawSessions(dir: string): Record<string, unknown>[] {
  const raw = readFileSync(resolve(dir, "sessions", "index.json"), "utf-8");
  return (JSON.parse(raw) as { sessions: Record<string, unknown>[] }).sessions;
}

describe("session-store: origin", () => {
  it("defaults a created session to observed and persists it", async () => {
    const dir = makeProjectDir();
    const session = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "cc_observed",
    });

    expect(session.origin).toBe("observed");
    expect(rawSessions(dir)[0].origin).toBe("observed");
  });

  it("mints an arcs-origin record when the caller owns it", async () => {
    const dir = makeProjectDir();
    const thread = await upsertSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "arcs-thread-demo-1",
      origin: "arcs",
      metadata: { control: "arcs-owned" },
    });

    expect(thread.origin).toBe("arcs");
    expect((await getSession(dir, "arcs-thread-demo-1")).origin).toBe("arcs");
  });

  it("never rewrites provenance on a later upsert, in either direction", async () => {
    const dir = makeProjectDir();
    await upsertSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "arcs-thread-demo-2",
      origin: "arcs",
    });
    await upsertSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "cc_terminal",
      origin: "observed",
    });

    // A hook observation of an ARCS thread must not demote it.
    const observedAgain = await upsertSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "arcs-thread-demo-2",
      origin: "observed",
      status: "idle",
    });
    // …and an ARCS run claiming an existing terminal session as its write
    // target must not erase the terminal that is attached to it.
    const claimed = await upsertSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "cc_terminal",
      origin: "arcs",
      metadata: { control: "arcs-owned" },
    });

    expect(observedAgain.origin).toBe("arcs");
    expect(observedAgain.status).toBe("idle");
    expect(claimed.origin).toBe("observed");
    expect(claimed.metadata).toEqual({ control: "arcs-owned" });
  });

  it("reads a legacy arcs-owned record back as origin arcs, with no migration", async () => {
    const dir = makeProjectDir();
    writeLegacyIndex(dir, [
      legacyRecord({ metadata: { control: "arcs-owned", directory: "/repo" } }),
    ]);

    // Nothing ran but a read: no migration script, no rewrite on disk.
    expect((await getSession(dir, "cc-legacy")).origin).toBe("arcs");
    expect((await listSessions(dir))[0].origin).toBe("arcs");
    expect(rawSessions(dir)[0].origin).toBeUndefined();
  });

  it("reads a legacy record without the marker as origin observed", async () => {
    const dir = makeProjectDir();
    writeLegacyIndex(dir, [legacyRecord({ metadata: { directory: "/repo" } })]);

    expect((await getSession(dir, "cc-legacy")).origin).toBe("observed");
  });

  it("persists the derived origin the next time the record is written", async () => {
    const dir = makeProjectDir();
    writeLegacyIndex(dir, [legacyRecord({ metadata: { control: "arcs-owned" } })]);

    await updateSession(dir, { id: "cc-legacy", status: "idle" });

    expect(rawSessions(dir)[0].origin).toBe("arcs");
    // The promotion is stable: re-reading the now-persisted field agrees.
    expect((await getSession(dir, "cc-legacy")).origin).toBe("arcs");
  });

  it("re-derives an unusable persisted origin instead of trusting it", async () => {
    const dir = makeProjectDir();
    writeLegacyIndex(dir, [legacyRecord({ origin: "owner", metadata: { control: "arcs-owned" } })]);

    expect((await getSession(dir, "cc-legacy")).origin).toBe("arcs");
  });
});

describe("session-store: unknown runtime types", () => {
  it("drops an index record whose runtimeType is not a known member", async () => {
    await withTempDataDir(async (dataDir) => {
      const dir = resolve(dataDir, "projects", "demo");
      writeLegacyIndex(dir, [
        legacyRecord({}),
        legacyRecord({
          id: "cc-bogus",
          normalizedId: "cc-bogus",
          runtimeSessionId: "cc-bogus",
          runtimeType: "bogus",
        }),
      ]);

      // A hand-edited index could hold anything — the funnel validates rather
      // than trusts, and drops rather than repairs: there is no correct
      // runtimeType to guess, so the record is invisible to every read path.
      expect((await readSessionIndex(dir)).sessions.map((s) => s.normalizedId)).toEqual([
        "cc-legacy",
      ]);
      expect((await listSessions(dir)).map((s) => s.normalizedId)).toEqual(["cc-legacy"]);
      await expect(getSession(dir, "cc-bogus")).rejects.toThrow("Could not find session");

      // Write-back attrition: the next whole-index write physically removes it.
      await updateSession(dir, { id: "cc-legacy", status: "idle" });
      expect(rawSessions(dir).map((s) => s.normalizedId)).toEqual(["cc-legacy"]);
    });
  });
});

describe("session-store: run claims", () => {
  it("persists the claim, the pid and the heartbeat, and seeds metadata.run", async () => {
    const dir = makeProjectDir();
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "arcs-thread-demo-1",
      origin: "arcs",
    });

    const claimed = await beginSessionRun(dir, "arcs-thread-demo-1", {
      runId: "run-1",
      pid: 4242,
      now: "2026-02-01T00:00:00.000Z",
    });

    expect(claimed.currentRunId).toBe("run-1");
    expect(claimed.currentRunPid).toBe(4242);
    // Top-level session timestamps are ISO…
    expect(claimed.heartbeatAt).toBe("2026-02-01T00:00:00.000Z");
    // …while metadata.run keeps epoch ms, the unit claude-runner writes.
    expect(claimed.metadata?.run).toEqual({
      runId: "run-1",
      pid: 4242,
      startedAt: Date.parse("2026-02-01T00:00:00.000Z"),
    });
    expect(rawSessions(dir)[0].currentRunId).toBe("run-1");
  });

  it("omits the pid when the spawn produced none", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "arcs-nopid" });

    const claimed = await beginSessionRun(dir, "arcs-nopid", { runId: "run-1", pid: null });

    expect(claimed.currentRunPid).toBeUndefined();
    expect((claimed.metadata?.run as Record<string, unknown>).pid).toBeNull();
  });

  it("replaces the previous run object so a live claim never shows a stale outcome", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "arcs-thread" });
    await beginSessionRun(dir, "arcs-thread", { runId: "run-1", pid: 1 });
    await settleSessionRun(dir, "arcs-thread", { outcome: "error", error: "boom" });

    const second = await beginSessionRun(dir, "arcs-thread", { runId: "run-2", pid: 2 });

    const run = second.metadata?.run as Record<string, unknown>;
    expect(run.runId).toBe("run-2");
    expect(run.outcome).toBeUndefined();
    expect(run.error).toBeUndefined();
  });

  it("settles a run: clears the claim, keeps the run's own facts", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "arcs-thread" });
    await beginSessionRun(dir, "arcs-thread", {
      runId: "run-1",
      pid: 4242,
      now: "2026-02-01T00:00:00.000Z",
    });

    const settled = await settleSessionRun(dir, "arcs-thread", {
      runId: "run-1",
      outcome: "interrupted",
      error: "process is gone",
      now: "2026-02-01T00:05:00.000Z",
    });

    expect(settled.currentRunId).toBeUndefined();
    expect(settled.currentRunPid).toBeUndefined();
    // The proof of life goes with the claim it belonged to.
    expect(settled.heartbeatAt).toBeUndefined();
    expect(settled.metadata?.run).toEqual({
      runId: "run-1",
      pid: 4242,
      startedAt: Date.parse("2026-02-01T00:00:00.000Z"),
      endedAt: Date.parse("2026-02-01T00:05:00.000Z"),
      outcome: "interrupted",
      error: "process is gone",
    });
  });

  it("refuses to settle a run that is no longer the current claim", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "arcs-thread" });
    await beginSessionRun(dir, "arcs-thread", { runId: "run-1", pid: 1 });
    await settleSessionRun(dir, "arcs-thread", { runId: "run-1", outcome: "success" });
    const newer = await beginSessionRun(dir, "arcs-thread", { runId: "run-2", pid: 2 });

    // A late settle for the finished run must not clear the newer claim.
    const after = await settleSessionRun(dir, "arcs-thread", {
      runId: "run-1",
      outcome: "timeout",
    });

    expect(after).toEqual(newer);
    expect(after.currentRunId).toBe("run-2");
  });

  it("is a no-op when the record holds no claim at all", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "cc-plain" });
    const before = await getSession(dir, "cc-plain");

    const after = await settleSessionRun(dir, "cc-plain", { outcome: "interrupted" });

    expect(after).toEqual(before);
    expect(after.metadata?.run).toBeUndefined();
  });

  it("throws for a session that does not exist", async () => {
    const dir = makeProjectDir();
    await expect(beginSessionRun(dir, "nope", { runId: "run-1" })).rejects.toThrow(
      'Could not find session "nope"',
    );
    await expect(settleSessionRun(dir, "nope", { outcome: "error" })).rejects.toThrow(
      'Could not find session "nope"',
    );
  });
});

describe("session-store: checkpoints", () => {
  it("sets and clears lastCheckpointAt through updateSession", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "cc-checkpoint" });

    const stamped = await updateSession(dir, {
      id: "cc-checkpoint",
      lastCheckpointAt: "2026-02-01T00:00:00.000Z",
    });
    expect(stamped.lastCheckpointAt).toBe("2026-02-01T00:00:00.000Z");
    expect(rawSessions(dir)[0].lastCheckpointAt).toBe("2026-02-01T00:00:00.000Z");

    expect(
      (await updateSession(dir, { id: "cc-checkpoint", lastCheckpointAt: null })).lastCheckpointAt,
    ).toBeUndefined();
  });

  it("writes a harvested runtime session id through updateSession, verbatim on disk", async () => {
    const dir = makeProjectDir();
    await createSession(dir, {
      runtimeType: "opencode",
      recordName: "arcs-thread-demo-1",
      origin: "arcs",
    });

    const harvested = await updateSession(dir, {
      id: "arcs-thread-demo-1",
      runtimeSessionId: "ses_0HarvestedId000000000000",
    });

    expect(harvested.runtimeSessionId).toBe("ses_0HarvestedId000000000000");
    // The record KEY is untouched — only the runtime-native id moved.
    expect(harvested.normalizedId).toBe("arcs-thread-demo-1");
    expect(rawSessions(dir)[0].runtimeSessionId).toBe("ses_0HarvestedId000000000000");
  });
});

describe("session-store: derived phase", () => {
  const FIXED_NOW = Date.parse("2026-02-01T12:00:00.000Z");
  const agoIso = (ms: number): string => new Date(FIXED_NOW - ms).toISOString();

  async function claimedSession(dir: string, heartbeatAt: string) {
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "arcs-thread",
      origin: "arcs",
    });
    await beginSessionRun(dir, "arcs-thread", { runId: "run-1", pid: 1, now: heartbeatAt });
    return getSession(dir, "arcs-thread");
  }

  it("reads a claimed run with a fresh heartbeat as running", async () => {
    const dir = makeProjectDir();
    const session = await claimedSession(dir, agoIso(30_000));

    expect(deriveSessionPhase(session, { now: FIXED_NOW })).toBe("running");
  });

  it("demotes a claim whose heartbeat went stale to idle, not failed", async () => {
    const dir = makeProjectDir();
    const session = await claimedSession(dir, agoIso(RUN_HEARTBEAT_TTL_MS + 1_000));

    // The run is settled by the reconciler, never guessed at here.
    expect(deriveSessionPhase(session, { now: FIXED_NOW })).toBe("idle");
  });

  it("reads an observed session by its last checkpoint", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "cc-observed" });

    await updateSession(dir, { id: "cc-observed", lastCheckpointAt: agoIso(10_000) });
    expect(deriveSessionPhase(await getSession(dir, "cc-observed"), { now: FIXED_NOW })).toBe(
      "running",
    );

    await updateSession(dir, {
      id: "cc-observed",
      lastCheckpointAt: agoIso(CHECKPOINT_TTL_MS + 1_000),
    });
    expect(deriveSessionPhase(await getSession(dir, "cc-observed"), { now: FIXED_NOW })).toBe(
      "idle",
    );
  });

  it("reads a session with no evidence at all as idle", async () => {
    const dir = makeProjectDir();
    const session = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_new",
    });

    expect(deriveSessionPhase(session, { now: FIXED_NOW })).toBe("idle");
  });

  it("lets a terminal status outrank every liveness signal", async () => {
    const dir = makeProjectDir();
    const session = await claimedSession(dir, agoIso(1_000));

    expect(deriveSessionPhase({ ...session, status: "failed" }, { now: FIXED_NOW })).toBe("failed");
    expect(deriveSessionPhase({ ...session, status: "completed" }, { now: FIXED_NOW })).toBe(
      "ended",
    );
    expect(deriveSessionPhase({ ...session, status: "disconnected" }, { now: FIXED_NOW })).toBe(
      "ended",
    );
  });

  it("does not turn a failed run into a failed session", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "arcs-thread" });
    await beginSessionRun(dir, "arcs-thread", { runId: "run-1", pid: 1 });
    await settleSessionRun(dir, "arcs-thread", { outcome: "error", error: "boom" });

    // Run history is rendered next to the run; the session itself is simply
    // ready for the next one.
    expect(deriveSessionPhase(await getSession(dir, "arcs-thread"))).toBe("idle");
  });

  it("validates the timestamps instead of trusting them", async () => {
    const dir = makeProjectDir();
    writeLegacyIndex(dir, [
      legacyRecord({
        origin: "observed",
        lastCheckpointAt: "not a timestamp",
        currentRunId: 42,
      }),
    ]);

    const session = await getSession(dir, "cc-legacy");
    // A non-string claim is no claim, and an unparsable stamp is no evidence.
    expect(deriveSessionPhase(session, { now: FIXED_NOW })).toBe("idle");
  });

  it("treats a clock-skewed future stamp as fresh", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "cc-skew" });
    await updateSession(dir, { id: "cc-skew", lastCheckpointAt: agoIso(-30_000) });

    expect(deriveSessionPhase(await getSession(dir, "cc-skew"), { now: FIXED_NOW })).toBe(
      "running",
    );
  });

  it("never persists a phase — it exists only as a derivation", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "cc-nophase" });
    await beginSessionRun(dir, "cc-nophase", { runId: "run-1", pid: 1 });
    await updateSession(dir, { id: "cc-nophase", lastCheckpointAt: new Date().toISOString() });

    const raw = readFileSync(resolve(dir, "sessions", "index.json"), "utf-8");
    expect(raw).not.toContain('"phase"');
    expect(Object.keys(rawSessions(dir)[0])).not.toContain("phase");
  });
});

describe("session-store: update and delete", () => {
  it("updates status and merges metadata", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
      metadata: { title: "probe" },
    });

    const updated = await updateSession(dir, {
      id: created.normalizedId,
      status: "disconnected",
      metadata: { directory: "/repo" },
      now: "2026-02-01T00:00:00.000Z",
    });

    expect(updated.status).toBe("disconnected");
    expect(updated.metadata).toEqual({ title: "probe", directory: "/repo" });
    expect(updated.updatedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("clears nullable fields", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
      lastMessageAt: "2026-01-01T00:00:00.000Z",
      userEmail: "dev@example.com",
      metadata: { title: "probe" },
    });

    const updated = await updateSession(dir, {
      id: created.normalizedId,
      lastMessageAt: null,
      userEmail: null,
      metadata: null,
    });

    expect(updated.lastMessageAt).toBeUndefined();
    expect(updated.userEmail).toBeUndefined();
    expect(updated.metadata).toBeUndefined();
  });

  it("rejects an unknown status on update", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
    });
    await expect(
      updateSession(dir, { id: created.normalizedId, status: "zombie" as never }),
    ).rejects.toThrow("Invalid session status");
  });

  it("throws when updating a missing session", async () => {
    const dir = makeProjectDir();
    await expect(updateSession(dir, { id: "ses_missing", status: "idle" })).rejects.toThrow(
      "Could not find session",
    );
  });

  it("deletes a session and leaves the rest intact", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "ses_a" });
    const b = await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "ses_b" });

    await deleteSession(dir, b.normalizedId);

    const remaining = await listSessions(dir);
    expect(remaining.map((s) => s.runtimeSessionId)).toEqual(["ses_a"]);
    await expect(deleteSession(dir, b.normalizedId)).rejects.toThrow("Could not find session");
  });
});

describe("session-store: dag linkage", () => {
  it("links a session to an existing task and stores the normalized id", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, { title: "Wire the bridge" });
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
    });

    const linked = await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeType: "task",
      linkedNodeId: task.normalizedId,
    });

    expect(linked.linkedNodeType).toBe("task");
    expect(linked.linkedNodeId).toBe(task.normalizedId);
  });

  it("links a session to an existing plan", async () => {
    const dir = makeProjectDir();
    const plan = await createPlan(dir, {
      id: "session-bridge",
      title: "Session Bridge",
      status: "planned",
      keywords: ["sessions"],
    });
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
    });

    const linked = await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeType: "plan",
      linkedNodeId: plan.normalizedId,
    });

    expect(linked.linkedNodeType).toBe("plan");
    expect(linked.linkedNodeId).toBe(plan.normalizedId);
  });

  it("rejects linking to a task id that does not exist", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
    });

    await expect(
      updateSession(dir, {
        id: created.normalizedId,
        linkedNodeType: "task",
        linkedNodeId: "no-such-task",
      }),
    ).rejects.toThrow('Could not find task "no-such-task"');
    expect((await getSession(dir, created.normalizedId)).linkedNodeId).toBeUndefined();
  });

  it("rejects linking to a plan id that does not exist", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
    });

    await expect(
      updateSession(dir, {
        id: created.normalizedId,
        linkedNodeType: "plan",
        linkedNodeId: "no-such-plan",
      }),
    ).rejects.toThrow('Could not find plan "no-such-plan"');
  });

  it("rejects an unknown linked node type", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
    });

    await expect(
      updateSession(dir, {
        id: created.normalizedId,
        linkedNodeType: "knowledge" as never,
        linkedNodeId: "whatever",
      }),
    ).rejects.toThrow("Invalid session link");
  });

  it("rejects a half link when nothing is linked yet", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
    });

    await expect(
      updateSession(dir, { id: created.normalizedId, linkedNodeType: "task" }),
    ).rejects.toThrow("must be set together");
    await expect(
      updateSession(dir, { id: created.normalizedId, linkedNodeId: "some-task" }),
    ).rejects.toThrow("must be set together");
  });

  it("retargets an existing link when only the id changes", async () => {
    const dir = makeProjectDir();
    const first = await createTask(dir, { title: "First" });
    const second = await createTask(dir, { title: "Second" });
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
    });

    await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeType: "task",
      linkedNodeId: first.normalizedId,
    });
    const retargeted = await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeId: second.normalizedId,
    });

    expect(retargeted.linkedNodeType).toBe("task");
    expect(retargeted.linkedNodeId).toBe(second.normalizedId);
  });

  it("clears both linkage fields together when either is nulled", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, { title: "Wire the bridge" });
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
    });
    await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeType: "task",
      linkedNodeId: task.normalizedId,
    });

    const unlinked = await updateSession(dir, { id: created.normalizedId, linkedNodeId: null });
    expect(unlinked.linkedNodeType).toBeUndefined();
    expect(unlinked.linkedNodeId).toBeUndefined();

    await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeType: "task",
      linkedNodeId: task.normalizedId,
    });
    const unlinkedByType = await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeType: null,
    });
    expect(unlinkedByType.linkedNodeType).toBeUndefined();
    expect(unlinkedByType.linkedNodeId).toBeUndefined();
  });

  it("never lets a discovery upsert clobber a human-made link", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, { title: "Wire the bridge" });
    const created = await upsertSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
    });
    await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeType: "task",
      linkedNodeId: task.normalizedId,
    });

    const refreshed = await upsertSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "ses_one",
      status: "idle",
      metadata: { directory: "/repo" },
    });

    expect(refreshed.linkedNodeType).toBe("task");
    expect(refreshed.linkedNodeId).toBe(task.normalizedId);
    expect(refreshed.status).toBe("idle");
  });
});

describe("session-store: watcher integration", () => {
  it("classifies session index writes as the sessions area", () => {
    expect(classifyChange("projects/demo/sessions/index.json")).toEqual({
      slug: "demo",
      area: "sessions",
    });
    expect(classifyChange("projects/demo/sessions")).toEqual({ slug: "demo", area: "sessions" });
  });
});
