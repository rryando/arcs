/**
 * POST /api/p/:slug/proposal-docs/:id/promote — the one-shot RUN hand-off.
 *
 * The endpoint no longer renames the doc or creates the plan itself: it keeps a
 * fast deterministic preflight (doc exists, derived plan id is free) and then
 * starts a `pi` run whose prompt drives the promotion through the ARCS skills.
 *
 * The spawn machinery is faked exactly like `ask-route.test.ts` does — the
 * runner is not the thing under test, but the argv it is handed, the preflight
 * refusals, the 202 envelope and the absence of server-side rename/plan
 * creation are.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlan, readPlanIndex } from "../src/utils/plan-store.js";
import {
  type ClaudeJobInput,
  type ClaudeRunRecord,
  liveRunPid,
  runClaudeJob,
} from "../src/web-server/claude-runner.js";
import { startWebServer, type WebServerHandle } from "../src/web-server/index.js";
import { runEventLogPath } from "../src/web-server/run-event-log.js";
import { getRun } from "../src/web-server/run-store.js";
import { currentWebToken } from "../src/web-server/web-token.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

vi.mock("../src/web-server/claude-runner.js", () => ({
  liveRunPid: vi.fn(() => 5150),
  resolveTimeoutMs: vi.fn(() => 600_000),
  runClaudeJob: vi.fn(),
}));

const SLUG = "demo";
/** A workspace path that need not exist: only its presence in meta.json and in
 *  the built prompt is under test. */
const WORKSPACE = "/work/demo";

const RUN_RECORD: ClaudeRunRecord = {
  pid: 5150,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  outcome: "success",
  replyText: "promoted",
  replyChars: "promoted".length,
};

let capturedJobs: ClaudeJobInput[] = [];
let runRecord: ClaudeRunRecord = RUN_RECORD;
let runStdout = "";

beforeEach(() => {
  capturedJobs = [];
  runRecord = RUN_RECORD;
  runStdout = "";
  vi.mocked(liveRunPid).mockReturnValue(5150);
  vi.mocked(runClaudeJob).mockImplementation(async (input) => {
    capturedJobs.push(input);
    if (input.eventLog !== undefined && runStdout !== "") {
      const path = runEventLogPath(
        input.eventLog.projectDir,
        input.eventLog.sessionId,
        input.eventLog.runId,
      );
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, runStdout, "utf-8");
    }
    await input.onSettled?.(runRecord);
    return runRecord;
  });
});

afterEach(() => {
  vi.mocked(liveRunPid).mockReset();
  vi.mocked(runClaudeJob).mockReset();
});

const DOC_BODY = `# Big Redesign

## Motivation

Do the thing.
`;

interface Ctx {
  base: string;
  projectDir: string;
  proposalsDir: string;
}

async function withPromoteCtx(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  await withTempDataDir(async (dir) => {
    writeFileSync(
      resolve(dir, "meta.json"),
      JSON.stringify({
        version: "1.0",
        projects: [{ id: SLUG, name: "Demo", status: "active", dependsOn: [] }],
      }),
      "utf-8",
    );
    const projectDir = resolve(dir, "projects", SLUG);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      resolve(projectDir, "meta.json"),
      JSON.stringify({
        id: SLUG,
        name: "Demo",
        description: "test project",
        createdAt: "2026-01-01T00:00:00.000Z",
        workspacePaths: [WORKSPACE],
      }),
      "utf-8",
    );
    const proposalsDir = join(projectDir, "proposals");
    mkdirSync(proposalsDir, { recursive: true });

    let server: WebServerHandle | null = null;
    try {
      server = await startWebServer({ port: 0, host: "127.0.0.1", watch: false });
      await run({ base: server.url, projectDir, proposalsDir });
    } finally {
      await server?.close();
    }
  });
}

function seedDoc(proposalsDir: string, fileName: string, body: string): void {
  mkdirSync(proposalsDir, { recursive: true });
  writeFileSync(join(proposalsDir, fileName), body, "utf-8");
}

interface PromoteEnvelope {
  ok?: boolean;
  code?: string;
  message?: string;
  started?: boolean;
  runId?: string;
  runtimeType?: string;
}

async function promote(
  base: string,
  id: string,
): Promise<{ status: number; data: PromoteEnvelope }> {
  const res = await fetch(`${base}/api/p/${SLUG}/proposal-docs/${id}/promote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() },
  });
  const envelope = (await res.json()) as PromoteEnvelope & { data?: PromoteEnvelope };
  return { status: res.status, data: (envelope.data ?? envelope) as PromoteEnvelope };
}

/** The pi driver's argv message slot — the last element of the argv. */
const promptOf = (job: ClaudeJobInput): string => job.argv[job.argv.length - 1] ?? "";

const waitFor = async (fn: () => boolean | Promise<boolean>, label: string): Promise<void> => {
  const deadline = Date.now() + 4_000;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 10));
  }
};

describe("POST /api/p/:slug/proposal-docs/:id/promote — run hand-off", () => {
  it("starts a pi run and returns the started envelope without renaming or creating a plan", async () => {
    await withPromoteCtx(async ({ base, projectDir, proposalsDir }) => {
      seedDoc(proposalsDir, "alpha-plan.proposal.md", DOC_BODY);

      const { status, data } = await promote(base, "alpha-plan");

      expect(status).toBe(202);
      expect(data.started).toBe(true);
      expect(data.runtimeType).toBe("pi");
      expect(data.runId).toMatch(/^[0-9a-f-]{36}$/);

      // The path is the shared one-shot starter: pi argv, workspace cwd, the
      // driver wire contract, and a durable event log keyed on the run.
      const [job] = capturedJobs;
      expect(job?.argv[0]).toBe("-p");
      expect(job?.argv[1]).toBe("--mode");
      expect(job?.argv[2]).toBe("json");
      expect(job?.cwd).toBe(WORKSPACE);
      expect(job?.writeTargetKey).toBe(`promote:${SLUG}`);
      expect(job?.streamJsonArgv).toBe(false);
      expect(job?.eventLog).toEqual({ projectDir, sessionId: SLUG, runId: data.runId });

      // The prompt drives promotion through the ARCS skills and names the doc,
      // the slug and the run's workspace.
      const prompt = promptOf(job as ClaudeJobInput);
      expect(prompt).toContain("alpha-plan");
      expect(prompt).toContain("`demo`");
      expect(prompt).toContain(WORKSPACE);
      expect(prompt).toContain("arcs-writing-proposals");
      expect(prompt).toContain("arcs-writing-plans");
      expect(prompt).toContain("arcs proposal-doc promote demo alpha-plan");
      expect(prompt).toContain("arcs validate demo");

      // The server did NOT rename the doc or mint a plan — that is the run's job.
      expect(existsSync(join(proposalsDir, "alpha-plan.proposal.md"))).toBe(true);
      expect(existsSync(join(proposalsDir, "alpha-plan.accepted.md"))).toBe(false);
      const { plans } = await readPlanIndex(projectDir);
      expect(plans).toHaveLength(0);

      // The claim settled through the shared write-back.
      await waitFor(
        async () => (await getRun(projectDir, data.runId ?? ""))?.outcome !== undefined,
        "the write-back to settle",
      );
      const run = await getRun(projectDir, data.runId ?? "");
      expect(run?.outcome).toBe("success");
      expect(run?.pid).toBe(5150);
    });
  });

  it("refuses a missing doc with ENTITY_NOT_FOUND and starts no run", async () => {
    await withPromoteCtx(async ({ base }) => {
      const { status, data } = await promote(base, "missing-doc");
      expect(status).toBe(404);
      expect(data.ok).toBe(false);
      expect(data.code).toBe("ENTITY_NOT_FOUND");
      expect(capturedJobs).toHaveLength(0);
    });
  });

  it("refuses an already-derived plan with PLAN_CONFLICT and starts no run", async () => {
    await withPromoteCtx(async ({ base, projectDir, proposalsDir }) => {
      seedDoc(proposalsDir, "alpha-plan.proposal.md", DOC_BODY);
      await createPlan(projectDir, {
        id: "big-redesign",
        title: "Big Redesign",
        status: "proposed",
        keywords: [],
      });

      const { status, data } = await promote(base, "alpha-plan");
      // PLAN_CONFLICT is in CONFLICT_CODES, so it maps to HTTP 409.
      expect(status).toBe(409);
      expect(data.code).toBe("PLAN_CONFLICT");
      expect(capturedJobs).toHaveLength(0);

      // The doc stays pending and untouched.
      const pending = await readFile(join(proposalsDir, "alpha-plan.proposal.md"), "utf-8");
      expect(pending).toBe(DOC_BODY);
    });
  });

  it("starts a recovery run from an accepted doc whose plan does not exist yet", async () => {
    await withPromoteCtx(async ({ base, projectDir, proposalsDir }) => {
      seedDoc(proposalsDir, "alpha-plan.accepted.md", DOC_BODY);

      const { status, data } = await promote(base, "alpha-plan");
      expect(status).toBe(202);
      expect(data.started).toBe(true);
      expect(capturedJobs).toHaveLength(1);

      const { plans } = await readPlanIndex(projectDir);
      expect(plans).toHaveLength(0);
    });
  });
});
