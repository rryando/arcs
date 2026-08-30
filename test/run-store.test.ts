/**
 * Per-run claim store (src/web-server/run-store.ts) — the durable spine of the
 * stateless ask surface.
 *
 * Three contracts under test, all inside isolated temp data dirs:
 *  - CLAIMS: beginRun writes the claim, updateRunPid records the child pid,
 *    settleRun stamps the outcome in the same write that releases the claim,
 *    and the runId key makes every settle idempotent against a newer writer.
 *  - CONCURRENCY: one live run per project — a second beginRun while a claim
 *    is unsettled refuses with RUN_IN_PROGRESS, under the same lock the settle
 *    releases it under.
 *  - THE STARTUP SWEEP: a claim whose pid is dead AND whose deadline has
 *    passed settles `interrupted` (and prunes that segment's run logs); a
 *    live pid or a not-yet-expired deadline both keep the claim standing.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DagError } from "../src/utils/errors.js";
import {
  beginRun,
  getRun,
  isProcessAlive,
  liveRun,
  runsIndexPath,
  settleOrphanedRuns,
  settleOrphanedRunsOnStartup,
  settleRun,
  updateRunPid,
} from "../src/web-server/run-store.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const RUN = "11111111-1111-4111-8111-111111111111";

interface ProjectHarness {
  dataDir: string;
  projectDir: string;
}

/** Seeds a single-project data dir and returns the scaffold's paths. */
async function withProject(run: (h: ProjectHarness) => Promise<void>): Promise<void> {
  await withTempDataDir(async (dataDir) => {
    writeFileSync(
      resolve(dataDir, "meta.json"),
      JSON.stringify({
        version: "1.0",
        projects: [{ id: "demo", name: "Demo", status: "active", dependsOn: [] }],
      }),
      "utf-8",
    );
    const projectDir = resolve(dataDir, "projects", "demo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      resolve(projectDir, "meta.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        description: "test project",
        createdAt: "2026-01-01T00:00:00.000Z",
        workspacePaths: ["/work/demo"],
      }),
      "utf-8",
    );
    await run({ dataDir, projectDir });
  });
}

/** A claim as the ask route writes one. */
function claimInput(overrides: Partial<Parameters<typeof beginRun>[1]> = {}) {
  return {
    runId: RUN,
    deadlineAt: 1_700_000_060_000,
    runtimeType: "pi",
    runner: "pi",
    logSegment: "demo",
    ...overrides,
  };
}

const PRUNE_FILE = (projectDir: string, n: number): string =>
  resolve(projectDir, "sessions", `demo.run-${n}.events.jsonl`);

const eventLogs = (projectDir: string): string[] =>
  readdirSync(resolve(projectDir, "sessions")).filter((name) => name.endsWith(".events.jsonl"));

describe("run-store: claims", () => {
  it("persists the claim with everything the sweep and the stream need", async () => {
    await withProject(async ({ projectDir }) => {
      await beginRun(projectDir, claimInput({ pid: 4242, continueSessionId: "ses_1" }));

      const run = await getRun(projectDir, RUN);
      expect(run).toMatchObject({
        runId: RUN,
        pid: 4242,
        runtimeType: "pi",
        runner: "pi",
        logSegment: "demo",
        continueSessionId: "ses_1",
        startedAt: expect.any(Number),
        deadlineAt: 1_700_000_060_000,
      });
      // No outcome ⇢ the record IS the live claim.
      expect(run?.outcome).toBeUndefined();
      expect(await liveRun(projectDir)).toMatchObject({ runId: RUN });

      // The index file itself is the durable spine — a fresh process reads it.
      const raw = JSON.parse(readFileSync(runsIndexPath(projectDir), "utf-8")) as {
        runs: unknown[];
      };
      expect(raw.runs).toHaveLength(1);
    });
  });

  it("updateRunPid records the child pid after the spawn; settleRun releases the claim in the same write", async () => {
    await withProject(async ({ projectDir }) => {
      await beginRun(projectDir, claimInput());
      await updateRunPid(projectDir, { runId: RUN, pid: 5150 });

      const claimed = await getRun(projectDir, RUN);
      expect(claimed?.pid).toBe(5150);

      await settleRun(projectDir, {
        runId: RUN,
        outcome: "success",
        endedAt: 1_700_000_090_000,
        replyChars: 42,
        runtimeSessionId: "ses_harvested",
      });

      const settled = await getRun(projectDir, RUN);
      expect(settled?.outcome).toBe("success");
      expect(settled?.endedAt).toBe(1_700_000_090_000);
      expect(settled?.replyChars).toBe(42);
      expect(settled?.runtimeSessionId).toBe("ses_harvested");
      // The claim is released: no live run left.
      expect(await liveRun(projectDir)).toBeUndefined();
    });
  });

  it("settleRun is keyed on the run id: a settled run is never re-stamped, and an unknown run settles nothing", async () => {
    await withProject(async ({ projectDir }) => {
      await beginRun(projectDir, claimInput());
      await settleRun(projectDir, { runId: RUN, outcome: "interrupted" });

      // A second settle for the same run — the cancel-race loser — is a no-op.
      await settleRun(projectDir, { runId: RUN, outcome: "error", error: "should not land" });
      const run = await getRun(projectDir, RUN);
      expect(run?.outcome).toBe("interrupted");
      expect(run?.error).toBeUndefined();

      // A run the index never held settles nothing and answers undefined.
      await settleRun(projectDir, { runId: "other-run", outcome: "success" });
      expect(await getRun(projectDir, "other-run")).toBeUndefined();
    });
  });

  it("refuses a second claim while one is live with RUN_IN_PROGRESS, then accepts after the settle", async () => {
    await withProject(async ({ projectDir }) => {
      await beginRun(projectDir, claimInput());

      const overlap = beginRun(projectDir, claimInput({ runId: "second-run" }));
      await expect(overlap).rejects.toBeInstanceOf(DagError);
      await expect(overlap).rejects.toMatchObject({ code: "RUN_IN_PROGRESS" });

      // One live run per PROJECT: even a run keyed under a different segment
      // refuses while the slot is held.
      await expect(
        beginRun(projectDir, claimInput({ runId: "third-run", logSegment: "other" })),
      ).rejects.toMatchObject({ code: "RUN_IN_PROGRESS" });

      await settleRun(projectDir, { runId: RUN, outcome: "success" });
      await expect(
        beginRun(projectDir, claimInput({ runId: "fourth-run" })),
      ).resolves.toMatchObject({ runId: "fourth-run" });
    });
  });

  it("tolerates a hand-edited index: unknown records are dropped, not crashed on", async () => {
    await withProject(async ({ projectDir }) => {
      mkdirSync(resolve(projectDir, "runs"), { recursive: true });
      writeFileSync(
        runsIndexPath(projectDir),
        JSON.stringify({
          runs: [
            { runId: 123, startedAt: "not-a-number" }, // invalid — dropped
            { runId: RUN, startedAt: 1, runtimeType: "pi", deadlineAt: 2, logSegment: "demo" },
            "garbage",
          ],
        }),
        "utf-8",
      );
      expect(await getRun(projectDir, RUN)).toMatchObject({ runId: RUN });
      expect(await liveRun(projectDir)).toMatchObject({ runId: RUN });
    });
  });
});

describe("run-store: startup sweep", () => {
  it("settles a claim whose pid is dead AND whose deadline has passed, as interrupted", async () => {
    await withProject(async ({ projectDir }) => {
      // Seed enough logs that pruning has something to cap: the sweep's settle
      // must prune this segment's older logs exactly like a route write-back.
      mkdirSync(resolve(projectDir, "sessions"), { recursive: true });
      for (let n = 0; n < 7; n += 1) writeFileSync(PRUNE_FILE(projectDir, n), "{}\n", "utf-8");

      await beginRun(projectDir, claimInput({ pid: 999_999, deadlineAt: 1_000 })); // long dead

      const settled = await settleOrphanedRuns(projectDir, { isAlive: () => false, now: 2_000 });
      expect(settled).toHaveLength(1);
      expect(settled[0]?.runId).toBe(RUN);
      expect(settled[0]?.outcome).toBe("interrupted");
      expect(settled[0]?.error).toContain("pid 999999");
      expect(await liveRun(projectDir)).toBeUndefined();

      // Retention ran with the settle: 7 logs pruned to 5.
      expect(eventLogs(projectDir)).toHaveLength(5);
    });
  });

  it("settles a dead-pid claim only once its deadline passes — an unexpired claim stands", async () => {
    await withProject(async ({ projectDir }) => {
      // One live run per project, so two coexisting claims can only exist in a
      // hand-written index (a crash mid-run is exactly that shape).
      mkdirSync(resolve(projectDir, "runs"), { recursive: true });
      writeFileSync(
        runsIndexPath(projectDir),
        JSON.stringify({
          runs: [
            {
              runId: "dead-expired",
              pid: 999_998,
              startedAt: 1_000,
              deadlineAt: 1_000,
              runtimeType: "pi",
              runner: "pi",
              logSegment: "demo",
            },
            {
              runId: "dead-unexpired",
              pid: 999_997,
              startedAt: 1_000,
              deadlineAt: 9_999_999_999,
              runtimeType: "pi",
              runner: "pi",
              logSegment: "demo",
            },
          ],
        }),
        "utf-8",
      );

      const settled = await settleOrphanedRuns(projectDir, { isAlive: () => false, now: 2_000 });
      expect(settled.map((run) => run.runId)).toEqual(["dead-expired"]);
      expect((await getRun(projectDir, "dead-unexpired"))?.outcome).toBeUndefined();
    });
  });

  it("never settles a claim whose process is actually alive, however old its deadline", async () => {
    await withProject(async ({ projectDir }) => {
      // process.pid IS alive, so a claim on it — however old its deadline —
      // must not be settled out from under a live child.
      await beginRun(projectDir, claimInput({ pid: process.pid, deadlineAt: 1 }));
      const settled = await settleOrphanedRuns(projectDir, { now: 2_000 });
      expect(settled).toHaveLength(0);
      expect(await liveRun(projectDir)).toBeDefined();
    });
  });

  it("sweeps every registered project from the startup entry point", async () => {
    await withTempDataDir(async (dataDir) => {
      writeFileSync(
        resolve(dataDir, "meta.json"),
        JSON.stringify({
          version: "1.0",
          projects: [
            { id: "alpha", name: "Alpha", status: "active", dependsOn: [] },
            { id: "beta", name: "Beta", status: "active", dependsOn: [] },
          ],
        }),
        "utf-8",
      );
      for (const slug of ["alpha", "beta"]) {
        const projectDir = resolve(dataDir, "projects", slug);
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(
          resolve(projectDir, "meta.json"),
          JSON.stringify({ id: slug, name: slug, workspacePaths: ["/work/x"] }),
          "utf-8",
        );
        await beginRun(projectDir, {
          runId: `run-${slug}`,
          deadlineAt: 1,
          runtimeType: "pi",
          runner: "pi",
          logSegment: slug,
        });
      }

      const settled = await settleOrphanedRunsOnStartup(dataDir, {
        isAlive: () => false,
        now: 2_000,
      });
      expect(settled.map((run) => run.runId).sort()).toEqual(["run-alpha", "run-beta"]);
    });
  });

  it("never settles on a data dir without readable root meta", async () => {
    await withTempDataDir(async (dataDir) => {
      writeFileSync(resolve(dataDir, "meta.json"), "{ not json", "utf-8");
      await expect(
        settleOrphanedRunsOnStartup(dataDir, { isAlive: () => false, now: 0 }),
      ).resolves.toEqual([]);
    });
  });
});

describe("run-store: isProcessAlive", () => {
  it("answers alive for this process and dead for a pid that cannot exist here", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_483_647)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });
});
