/**
 * Unit tests for the extracted one-shot run starter — the single path the ask
 * turn and the proposal-doc promote now share.
 *
 * `ask-route.test.ts` and `proposal-doc-promote-run.test.ts` cover the helper
 * through their routes; these pin its own contract directly: the run-id /
 * stream-URL result shape, the claim it takes before spawning, and the
 * RUN_IN_PROGRESS refusal when the project already holds a live claim.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ClaudeJobInput, runClaudeJob } from "../src/web-server/claude-runner.js";
import { startOneShotRun } from "../src/web-server/one-shot-run.js";
import type { RunDriverAdapter } from "../src/web-server/run-driver.js";
import { beginRun, getRun } from "../src/web-server/run-store.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

vi.mock("../src/web-server/claude-runner.js", () => ({
  liveRunPid: vi.fn(() => 111),
  resolveTimeoutMs: vi.fn(() => 600_000),
  runClaudeJob: vi.fn(),
}));

const SLUG = "demo";
const WORKSPACE = "/work/demo";

let capturedJobs: ClaudeJobInput[] = [];

beforeEach(() => {
  capturedJobs = [];
  vi.mocked(runClaudeJob).mockImplementation(async (input) => {
    capturedJobs.push(input);
    const record = {
      pid: 111,
      startedAt: 1,
      endedAt: 2,
      outcome: "success" as const,
    };
    await input.onSettled?.(record);
    return record;
  });
});

afterEach(() => {
  vi.mocked(runClaudeJob).mockReset();
});

/** A driver with no real binary — argv is `[<binary>, <message>]`. */
const driver: RunDriverAdapter = {
  runtimeType: "pi",
  binary: "fakebin",
  buildArgv: (input) => ["-p", input.message],
  foldOutput: () => ({ turns: [], replyText: "", skippedLines: 0 }),
};

function seedProject(dir: string): string {
  const projectDir = resolve(dir, "projects", SLUG);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    resolve(projectDir, "meta.json"),
    JSON.stringify({ id: SLUG, name: "Demo", workspacePaths: [WORKSPACE] }),
    "utf-8",
  );
  return projectDir;
}

const waitFor = async (fn: () => boolean | Promise<boolean>, label: string): Promise<void> => {
  const deadline = Date.now() + 4_000;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 10));
  }
};

describe("startOneShotRun", () => {
  it("claims the slot, spawns through the driver, and returns the run's identity", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = seedProject(dir);

      const started = await startOneShotRun({
        projectDir,
        slug: SLUG,
        driver,
        buildPrompt: () => "hello world",
        writeTargetKey: `promote:${SLUG}`,
      });

      expect(started.runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(started.streamUrl).toBe(`/api/p/${SLUG}/runs/${started.runId}/stream`);
      expect(started.projectSlug).toBe(SLUG);

      const [job] = capturedJobs;
      expect(job?.argv).toEqual(["-p", "hello world"]);
      expect(job?.cwd).toBe(WORKSPACE);
      expect(job?.writeTargetKey).toBe(`promote:${SLUG}`);
      expect(job?.streamJsonArgv).toBe(false);

      await waitFor(
        async () => (await getRun(projectDir, started.runId))?.outcome !== undefined,
        "the write-back to settle",
      );
      const run = await getRun(projectDir, started.runId);
      expect(run?.outcome).toBe("success");
      expect(run?.runner).toBe("fakebin");
      expect(run?.runtimeType).toBe("pi");
    });
  });

  it("refuses with RUN_IN_PROGRESS while the project already holds a live claim", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = seedProject(dir);
      await beginRun(projectDir, {
        runId: "live-run",
        deadlineAt: Date.now() + 600_000,
        runtimeType: "pi",
        runner: "pi",
        logSegment: SLUG,
      });

      await expect(
        startOneShotRun({
          projectDir,
          slug: SLUG,
          driver,
          buildPrompt: () => "nope",
          writeTargetKey: `promote:${SLUG}`,
        }),
      ).rejects.toMatchObject({ code: "RUN_IN_PROGRESS" });

      expect(capturedJobs).toHaveLength(0);
    });
  });
});
