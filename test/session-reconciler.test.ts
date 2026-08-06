// ---------------------------------------------------------------------------
// Tests for session-reconciler — `claude agents --json` tolerance, phase
// demotion, and the startup sweep that settles runs orphaned by a restart.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginSessionRun,
  createSession,
  getSession,
  updateSession,
} from "../src/utils/session-store.js";
import {
  type AgentsProbe,
  isProcessAlive,
  type LiveAgent,
  listLiveClaudeAgents,
  parseLiveAgents,
  reconcilePhase,
  reconcileSessionPhases,
  settleOrphanedRuns,
  settleOrphanedRunsOnStartup,
} from "../src/web-server/session-reconciler.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const tempDirs: string[] = [];

function makeProjectDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "arcs-session-reconciler-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A pid above every Linux/macOS pid_max — guaranteed not to be a process. */
const DEAD_PID = 2_147_483_646;

const probeReturning =
  (stdout: string): AgentsProbe =>
  async () => ({ ok: true, stdout });
const probeFailing: AgentsProbe = async () => ({ ok: false });

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

// ---------------------------------------------------------------------------

describe("session-reconciler: parseLiveAgents", () => {
  it("parses the documented agent fields from a top-level array", () => {
    const agents = parseLiveAgents(
      JSON.stringify([
        {
          pid: 4242,
          cwd: "/work/demo",
          sessionId: "3f1a2b4c-0000-4000-8000-000000000001",
          name: "demo",
          status: "running",
        },
      ]),
    );

    expect(agents).toEqual([
      {
        pid: 4242,
        cwd: "/work/demo",
        sessionId: "3f1a2b4c-0000-4000-8000-000000000001",
        name: "demo",
        status: "running",
      },
    ]);
  });

  it("accepts a wrapped payload and `state` as the status alias", () => {
    const agents = parseLiveAgents(
      JSON.stringify({ agents: [{ pid: 7, sessionId: "ses-a", state: "background" }] }),
    );

    expect(agents).toEqual([{ pid: 7, sessionId: "ses-a", status: "background" }]);
  });

  it("distinguishes an empty agent list from an unusable answer", () => {
    // [] is a real answer — the probe worked and nothing is live, which is
    // allowed to demote a session. null is "no answer", which never is.
    expect(parseLiveAgents("[]")).toEqual([]);
    expect(parseLiveAgents("")).toBeNull();
    expect(parseLiveAgents("   ")).toBeNull();
    expect(parseLiveAgents("not json at all")).toBeNull();
    expect(parseLiveAgents('{"error":"unknown command"}')).toBeNull();
    expect(parseLiveAgents('"a bare string"')).toBeNull();
  });

  it("drops rows that identify neither a process nor a session and keeps the rest", () => {
    const agents = parseLiveAgents(
      JSON.stringify([
        { name: "no identity at all" },
        null,
        ["not an object"],
        42,
        { sessionId: "ses-keep" },
        { pid: "8123", cwd: "/work/other" },
      ]),
    );

    expect(agents).toEqual([{ sessionId: "ses-keep" }, { pid: 8123, cwd: "/work/other" }]);
  });
});

describe("session-reconciler: listLiveClaudeAgents tolerance", () => {
  it("degrades to null when the binary is missing or the command exits non-zero", async () => {
    expect(await listLiveClaudeAgents({ probe: probeFailing })).toBeNull();
  });

  it("degrades to null when stdout is not usable JSON", async () => {
    expect(
      await listLiveClaudeAgents({ probe: probeReturning("claude: unknown flag") }),
    ).toBeNull();
  });

  it("degrades to null when the probe itself throws", async () => {
    const thrower: AgentsProbe = async () => {
      throw new Error("spawn exploded");
    };
    await expect(listLiveClaudeAgents({ probe: thrower })).resolves.toBeNull();
  });

  it("never throws when it actually shells out to claude", async () => {
    // The real default probe against the real environment: with or without the
    // binary on PATH the only allowed outcomes are agents or null.
    const agents = await listLiveClaudeAgents();
    expect(agents === null || Array.isArray(agents)).toBe(true);
  }, 15_000);
});

describe("session-reconciler: isProcessAlive", () => {
  it("recognizes this process and rejects a pid that cannot exist", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(DEAD_PID)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });
});

describe("session-reconciler: reconcilePhase", () => {
  it("demotes an observed session no live agent reports", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "cc-live" });
    await updateSession(dir, { id: "cc-live", lastCheckpointAt: nowIso() });
    const session = await getSession(dir, "cc-live");

    // Checkpoint-derived phase says running…
    expect(reconcilePhase(session, null)).toBe("running");
    // …and an agent list that does not mention it takes that away.
    expect(reconcilePhase(session, [])).toBe("idle");
    expect(reconcilePhase(session, [{ pid: 1, sessionId: "someone-else" }])).toBe("idle");
  });

  it("keeps a session a live agent reports, matched by raw or normalized id", async () => {
    const dir = makeProjectDir();
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "CC-Mixed-Case",
    });
    await updateSession(dir, { id: "CC-Mixed-Case", lastCheckpointAt: nowIso() });
    const session = await getSession(dir, "CC-Mixed-Case");

    expect(reconcilePhase(session, [{ pid: 9, sessionId: "CC-Mixed-Case" }])).toBe("running");
    expect(reconcilePhase(session, [{ pid: 9, sessionId: "cc-mixed-case" }])).toBe("running");
  });

  it("matches an ARCS thread through its claude-facing uuid", async () => {
    const dir = makeProjectDir();
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "arcs-thread-demo-1",
      origin: "arcs",
      metadata: { claudeSessionId: "3f1a2b4c-0000-4000-8000-000000000009" },
    });
    await updateSession(dir, { id: "arcs-thread-demo-1", lastCheckpointAt: nowIso() });
    const session = await getSession(dir, "arcs-thread-demo-1");

    expect(
      reconcilePhase(session, [{ pid: 5, sessionId: "3f1a2b4c-0000-4000-8000-000000000009" }]),
    ).toBe("running");
  });

  it("degrades to the lastCheckpointAt-derived phase when the probe answered nothing", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "cc-degrade" });
    await updateSession(dir, { id: "cc-degrade", lastCheckpointAt: nowIso(-60 * 60 * 1000) });
    const stale = await getSession(dir, "cc-degrade");

    // An unusable probe never promotes and never demotes: the record's own
    // evidence stands, whichever way it points.
    expect(reconcilePhase(stale, null)).toBe("idle");
    await updateSession(dir, { id: "cc-degrade", lastCheckpointAt: nowIso() });
    expect(reconcilePhase(await getSession(dir, "cc-degrade"), null)).toBe("running");
  });

  it("checks a run claim against its pid, never against the agent list", async () => {
    const dir = makeProjectDir();
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "arcs-oneshot-demo",
      origin: "arcs",
    });
    await beginSessionRun(dir, "arcs-oneshot-demo", { runId: "run-1", pid: process.pid });
    const claimed = await getSession(dir, "arcs-oneshot-demo");

    // A headless `claude -p` child never appears in `claude agents --json`, so
    // an empty agent list must not demote it — only a dead pid may.
    expect(reconcilePhase(claimed, [])).toBe("running");
    expect(reconcilePhase(claimed, null)).toBe("running");
    expect(reconcilePhase(claimed, [], { isAlive: () => false })).toBe("idle");
  });

  it("leaves a claim with no pid on its heartbeat alone", async () => {
    const dir = makeProjectDir();
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "arcs-nopid",
      origin: "arcs",
    });
    await beginSessionRun(dir, "arcs-nopid", { runId: "run-2", pid: null });
    const claimed = await getSession(dir, "arcs-nopid");

    expect(claimed.currentRunPid).toBeUndefined();
    expect(reconcilePhase(claimed, [])).toBe("running");
  });

  it("never promotes a terminal session, whatever the world reports", async () => {
    const dir = makeProjectDir();
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "cc-done",
      status: "completed",
    });
    await updateSession(dir, { id: "cc-done", lastCheckpointAt: nowIso() });
    const session = await getSession(dir, "cc-done");

    expect(reconcilePhase(session, [{ pid: 3, sessionId: "cc-done" }])).toBe("ended");
  });
});

describe("session-reconciler: reconcileSessionPhases", () => {
  it("reports one reconciled phase per session from a single probe", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "cc-a" });
    await updateSession(dir, { id: "cc-a", lastCheckpointAt: nowIso() });
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "cc-b" });
    await updateSession(dir, { id: "cc-b", lastCheckpointAt: nowIso() });
    await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses-old",
      status: "completed",
    });

    let probeCalls = 0;
    const probe: AgentsProbe = async () => {
      probeCalls += 1;
      return { ok: true, stdout: JSON.stringify([{ pid: 11, sessionId: "cc-a" }]) };
    };

    expect(await reconcileSessionPhases(dir, { probe })).toEqual([
      { sessionId: "cc-a", phase: "running" },
      { sessionId: "cc-b", phase: "idle" },
      { sessionId: "ses-old", phase: "ended" },
    ]);
    expect(probeCalls).toBe(1);
  });

  it("never spawns the probe when no record's phase could depend on it", async () => {
    const dir = makeProjectDir();
    // Terminal — answered by the stored status alone.
    await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses-done",
      status: "completed",
    });
    // Idle — a checkpoint older than its TTL, answered by the record alone.
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "cc-stale" });
    await updateSession(dir, { id: "cc-stale", lastCheckpointAt: nowIso(-60 * 60 * 1000) });
    // A run claim — answered by its pid, which `claude agents --json` could not
    // report anyway (it never lists a headless `claude -p` child).
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "arcs-oneshot-demo",
      origin: "arcs",
    });
    await beginSessionRun(dir, "arcs-oneshot-demo", { runId: "run-live", pid: process.pid });
    // …including one whose process is gone: demotion still happens probe-free.
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "arcs-thread-demo-1",
      origin: "arcs",
    });
    await beginSessionRun(dir, "arcs-thread-demo-1", { runId: "run-dead", pid: DEAD_PID });

    let probeCalls = 0;
    const probe: AgentsProbe = async () => {
      probeCalls += 1;
      return { ok: true, stdout: "[]" };
    };

    const phases = new Map(
      (await reconcileSessionPhases(dir, { probe })).map((view) => [view.sessionId, view.phase]),
    );

    // Not one subprocess: every answer here came from the records themselves.
    expect(probeCalls).toBe(0);
    expect(phases.get("ses-done")).toBe("ended");
    expect(phases.get("cc-stale")).toBe("idle");
    expect(phases.get("arcs-oneshot-demo")).toBe("running");
    expect(phases.get("arcs-thread-demo-1")).toBe("idle");
  });

  it("spawns exactly one probe for the whole index, however many records need it", async () => {
    const dir = makeProjectDir();
    // Two records whose phase hangs on the agent list — one probe answers both.
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "cc-live" });
    await updateSession(dir, { id: "cc-live", lastCheckpointAt: nowIso() });
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "cc-closed" });
    await updateSession(dir, { id: "cc-closed", lastCheckpointAt: nowIso() });
    // Alongside records that answer without it.
    await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses-done",
      status: "completed",
    });
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "arcs-oneshot-demo",
      origin: "arcs",
    });
    await beginSessionRun(dir, "arcs-oneshot-demo", { runId: "run-live", pid: process.pid });

    let probeCalls = 0;
    const probe: AgentsProbe = async () => {
      probeCalls += 1;
      return { ok: true, stdout: JSON.stringify([{ pid: 11, sessionId: "cc-live" }]) };
    };

    const phases = new Map(
      (await reconcileSessionPhases(dir, { probe })).map((view) => [view.sessionId, view.phase]),
    );

    expect(probeCalls).toBe(1);
    expect(phases.get("cc-live")).toBe("running");
    expect(phases.get("cc-closed")).toBe("idle");
    expect(phases.get("ses-done")).toBe("ended");
    expect(phases.get("arcs-oneshot-demo")).toBe("running");
  });

  it("writes nothing — reconciliation on read is a view, not a mutation", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "cc-view" });
    await updateSession(dir, { id: "cc-view", lastCheckpointAt: nowIso() });
    const before = await getSession(dir, "cc-view");

    await reconcileSessionPhases(dir, { probe: probeReturning("[]") });

    expect(await getSession(dir, "cc-view")).toEqual(before);
  });
});

describe("session-reconciler: settleOrphanedRuns", () => {
  it("settles a claim whose process is gone as interrupted and clears it", async () => {
    const dir = makeProjectDir();
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "arcs-oneshot-demo",
      origin: "arcs",
    });
    await beginSessionRun(dir, "arcs-oneshot-demo", { runId: "run-gone", pid: DEAD_PID });

    const settled = await settleOrphanedRuns(dir);

    expect(settled).toEqual([{ sessionId: "arcs-oneshot-demo", runId: "run-gone", pid: DEAD_PID }]);
    const session = await getSession(dir, "arcs-oneshot-demo");
    expect(session.currentRunId).toBeUndefined();
    expect(session.currentRunPid).toBeUndefined();
    expect(session.heartbeatAt).toBeUndefined();
    const run = session.metadata?.run as Record<string, unknown>;
    expect(run.outcome).toBe("interrupted");
    expect(run.runId).toBe("run-gone");
    expect(run.pid).toBe(DEAD_PID);
    expect(typeof run.startedAt).toBe("number");
    expect(typeof run.endedAt).toBe("number");
    expect(String(run.error)).toContain(String(DEAD_PID));
  });

  it("leaves a claim whose process is still alive standing", async () => {
    const dir = makeProjectDir();
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "arcs-live",
      origin: "arcs",
    });
    await beginSessionRun(dir, "arcs-live", { runId: "run-live", pid: process.pid });

    expect(await settleOrphanedRuns(dir)).toEqual([]);
    expect((await getSession(dir, "arcs-live")).currentRunId).toBe("run-live");
  });

  it("settles a claim that never recorded a pid", async () => {
    const dir = makeProjectDir();
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "arcs-nopid",
      origin: "arcs",
    });
    await beginSessionRun(dir, "arcs-nopid", { runId: "run-nopid" });

    expect(await settleOrphanedRuns(dir)).toEqual([
      { sessionId: "arcs-nopid", runId: "run-nopid" },
    ]);
    const run = (await getSession(dir, "arcs-nopid")).metadata?.run as Record<string, unknown>;
    expect(run.outcome).toBe("interrupted");
  });

  it("touches nothing when no session holds a claim", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "claude-code", runtimeSessionId: "cc-plain" });
    const before = await getSession(dir, "cc-plain");

    expect(await settleOrphanedRuns(dir)).toEqual([]);
    expect(await getSession(dir, "cc-plain")).toEqual(before);
  });

  it("never throws for a project that has no sessions at all", async () => {
    await expect(settleOrphanedRuns(resolve(makeProjectDir(), "nope"))).resolves.toEqual([]);
  });
});

describe("session-reconciler: startup sweep", () => {
  it("settles every project's orphans so no session is stuck running across a restart", async () => {
    await withTempDataDir(async (dataDir) => {
      writeFileSync(
        resolve(dataDir, "meta.json"),
        JSON.stringify({
          version: "1.0",
          projects: [
            { id: "demo", name: "Demo", status: "active", dependsOn: [] },
            { id: "other", name: "Other", status: "active", dependsOn: [] },
          ],
        }),
        "utf-8",
      );
      const demoDir = resolve(dataDir, "projects", "demo");
      const otherDir = resolve(dataDir, "projects", "other");

      // The previous server process spawned a run and died before it settled.
      await createSession(demoDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "arcs-thread-demo-1",
        origin: "arcs",
      });
      await beginSessionRun(demoDir, "arcs-thread-demo-1", {
        runId: "run-before-restart",
        pid: DEAD_PID,
      });
      await createSession(otherDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "arcs-oneshot-other",
        origin: "arcs",
      });
      await beginSessionRun(otherDir, "arcs-oneshot-other", { runId: "run-other", pid: DEAD_PID });

      // Before the sweep both records still claim a live run.
      const beforeAgents: LiveAgent[] = [];
      expect(reconcilePhase(await getSession(demoDir, "arcs-thread-demo-1"), beforeAgents)).toBe(
        "idle",
      );
      expect((await getSession(demoDir, "arcs-thread-demo-1")).currentRunId).toBe(
        "run-before-restart",
      );

      const settled = await settleOrphanedRunsOnStartup(dataDir);

      expect(settled.map((entry) => entry.sessionId).sort()).toEqual([
        "arcs-oneshot-other",
        "arcs-thread-demo-1",
      ]);
      for (const [dir, id] of [
        [demoDir, "arcs-thread-demo-1"],
        [otherDir, "arcs-oneshot-other"],
      ] as const) {
        const session = await getSession(dir, id);
        expect(session.currentRunId).toBeUndefined();
        expect((session.metadata?.run as Record<string, unknown>).outcome).toBe("interrupted");
        // Nothing is left that could ever read "running" again.
        expect(reconcilePhase(session, null)).toBe("idle");
      }
    });
  });

  it("is idempotent — a second sweep finds nothing left to settle", async () => {
    await withTempDataDir(async (dataDir) => {
      writeFileSync(
        resolve(dataDir, "meta.json"),
        JSON.stringify({
          version: "1.0",
          projects: [{ id: "demo", name: "Demo", status: "active", dependsOn: [] }],
        }),
        "utf-8",
      );
      const demoDir = resolve(dataDir, "projects", "demo");
      await createSession(demoDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "arcs-oneshot-demo",
        origin: "arcs",
      });
      await beginSessionRun(demoDir, "arcs-oneshot-demo", { runId: "run-x", pid: DEAD_PID });

      expect(await settleOrphanedRunsOnStartup(dataDir)).toHaveLength(1);
      expect(await settleOrphanedRunsOnStartup(dataDir)).toEqual([]);
    });
  });

  it("never throws when the data dir has no readable meta.json", async () => {
    await expect(settleOrphanedRunsOnStartup(makeProjectDir())).resolves.toEqual([]);
  });
});
