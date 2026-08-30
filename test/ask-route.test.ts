/**
 * POST /api/p/:slug/ask — the stateless, run-keyed Ask-AI turn surface.
 *
 * The runner is faked here (vi.mock on claude-runner), exactly like the deleted
 * sessions-route-run suite did: the route's spawn machinery is not the thing
 * under test, but the argv it hands the runner, the claim it takes, the
 * stream URL it returns and the write-back that settles the claim are. The
 * fake runner records every job, writes the durable event log the real runner
 * would, and fires the route's write-back on settle — so the whole route
 * surface is exercised without a real child.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ClaudeJobInput,
  type ClaudeRunRecord,
  liveRunPid,
  runClaudeJob,
} from "../src/web-server/claude-runner.js";
import { startWebServer, type WebServerHandle } from "../src/web-server/index.js";
import { getRunDriver } from "../src/web-server/run-driver.js";
import { runEventLogPath } from "../src/web-server/run-event-log.js";
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

const WORKSPACE = "/work/demo";

/** A settled record the fake runner reports; tests override for error runs. */
const RUN_RECORD: ClaudeRunRecord = {
  pid: 4242,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  outcome: "success",
  replyText: "reply",
  replyChars: "reply".length,
};

/** A valid `doc` reference, per sessionReferenceSchema. */
const DOC_REFERENCE = {
  section: {
    depth: 1,
    text: "The headless turn appends the user turn before the reference.",
    id: "sec_1",
    startOffset: 120,
    endOffset: 220,
  },
  text: "User turn first, then the reference.",
  source: { kind: "knowledge", label: "session-bridge", doc: "docs/bridge.md", id: "k_1" },
} as const;

let capturedJobs: ClaudeJobInput[] = [];
/** Record the fake runner settles each job with — tests override for errors. */
let runRecord: ClaudeRunRecord = RUN_RECORD;
/**
 * Child stdout the fake runner persists to the run's event log before it
 * settles, exactly as the real runner does mid-stream. Empty means the run
 * left no log at all.
 */
let runStdout = "";
/** When true, the fake runner holds each job's onSettled until release — a
 *  live, unsettled claim to test overlap and cancel against. */
let holdWriteBacks = false;
let releaseHeld: (() => void) | undefined;

beforeEach(() => {
  capturedJobs = [];
  runRecord = RUN_RECORD;
  runStdout = "";
  holdWriteBacks = false;
  releaseHeld = undefined;
  vi.mocked(liveRunPid).mockReturnValue(4242);
  vi.mocked(getRunDriver).mockRestore();
  vi.mocked(runClaudeJob).mockImplementation(async (input) => {
    capturedJobs.push(input);
    // The real runner writes every stdout line to the run's event log verbatim
    // as it arrives; the fake leaves behind just that durable artifact so the
    // route's settle has one to fold.
    if (input.eventLog !== undefined && runStdout !== "") {
      const path = runEventLogPath(
        input.eventLog.projectDir,
        input.eventLog.sessionId,
        input.eventLog.runId,
      );
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, runStdout, "utf-8");
    }
    if (input.onSettled === undefined) return runRecord;
    if (holdWriteBacks) {
      await new Promise<void>((resolveHeld) => {
        releaseHeld = () => {
          resolveHeld();
          void input.onSettled?.(runRecord);
        };
      });
      return runRecord;
    }
    // Simulate the real runner's post-close write-back: once the child exits,
    // onSettled fires with the settled record before the run resolves.
    await input.onSettled(runRecord);
    return runRecord;
  });
});

afterEach(() => {
  vi.mocked(liveRunPid).mockReset();
  vi.mocked(runClaudeJob).mockReset();
  releaseHeld = undefined;
});

interface AskCtx {
  base: string;
  projectDir: string;
}

async function withAskCtx(run: (ctx: AskCtx) => Promise<void>): Promise<void> {
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
    writeFileSync(
      resolve(projectDir, "meta.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        description: "test project",
        createdAt: "2026-01-01T00:00:00.000Z",
        workspacePaths: [WORKSPACE],
      }),
      "utf-8",
    );

    let server: WebServerHandle | null = null;
    try {
      server = await startWebServer({ port: 0, host: "127.0.0.1", watch: false });
      await run({ base: server.url, projectDir });
    } finally {
      await server?.close();
    }
  });
}

interface AskEnvelope {
  ok?: boolean;
  code?: string;
  message?: string;
  runId?: string;
  streamUrl?: string;
  projectSlug?: string;
  cancelled?: string;
}

async function postAsk(
  base: string,
  body: unknown,
): Promise<{ status: number; data: AskEnvelope }> {
  const res = await fetch(`${base}/api/p/demo/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() },
    body: JSON.stringify(body),
  });
  const envelope = (await res.json()) as AskEnvelope & { data?: unknown };
  // Success rides the envelope's `data` slot; a refusal is the envelope itself.
  return { status: res.status, data: (envelope.data ?? envelope) as AskEnvelope };
}

async function deleteRun(
  base: string,
  runId: string,
): Promise<{ status: number; data: AskEnvelope }> {
  const res = await fetch(`${base}/api/p/demo/runs/${runId}`, {
    method: "DELETE",
    // The global mutation gate demands a JSON content type on every mutating
    // method — a body is optional, the header is not.
    headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() },
  });
  const envelope = (await res.json()) as AskEnvelope & { data?: unknown };
  return { status: res.status, data: (envelope.data ?? envelope) as AskEnvelope };
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

describe("POST /api/p/:slug/ask — turn acceptance", () => {
  it("accepts a turn with the default pi runner and answers 202 naming the run", async () => {
    await withAskCtx(async ({ base, projectDir }) => {
      const { status, data } = await postAsk(base, { message: "what is the current task?" });

      expect(status).toBe(202);
      expect(data.runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(data.streamUrl).toBe(`/api/p/demo/runs/${data.runId}/stream`);
      expect(data.projectSlug).toBe("demo");

      const [job] = capturedJobs;
      expect(job?.argv).toEqual(["-p", "--mode", "json", "what is the current task?"]);
      expect(job?.cwd).toBe(WORKSPACE);
      expect(job?.writeTargetKey).toBe("ask:demo");
      expect(job?.streamJsonArgv).toBe(false);
      expect(job?.eventLog).toEqual({ projectDir, sessionId: "demo", runId: data.runId });
      expect(job?.timeoutMs).toBe(600_000);

      // The write-back settled the claim: outcome + reply length stamped.
      await waitFor(
        async () => (await getRun(projectDir, data.runId ?? ""))?.outcome !== undefined,
        "the write-back to settle",
      );
      const run = await getRun(projectDir, data.runId ?? "");
      expect(run?.outcome).toBe("success");
      expect(run?.endedAt).toBe(1_700_000_060_000);
      expect(run?.replyChars).toBe("reply".length);
    });
  });

  it("defaults an unknown runner string to pi, and refuses a driverless runtime with UNKNOWN_RUNNER", async () => {
    await withAskCtx(async ({ base }) => {
      // "codex-cli-experimental" is not a SessionRuntimeType — the picker
      // shipped a stale label. The turn must still land on the default.
      const degraded = await postAsk(base, { runner: "codex-cli-experimental", message: "hi" });
      expect(degraded.status).toBe(202);
      expect(capturedJobs[0]?.argv[0]).toBe("-p"); // pi's first token

      // A runner type the server knows but has no driver for is a real gap.
      vi.mocked(getRunDriver).mockReturnValue(undefined);
      const refused = await postAsk(base, { runner: "pi", message: "hi" });
      expect(refused.status).toBe(400);
      expect(refused.data.ok).toBe(false);
      expect(refused.data.code).toBe("UNKNOWN_RUNNER");
    });
  });

  it("refuses an empty message and an unknown reference variant with INVALID_BODY", async () => {
    await withAskCtx(async ({ base }) => {
      const empty = await postAsk(base, { message: "" });
      expect(empty.status).toBe(400);
      expect(empty.data.code).toBe("INVALID_BODY");

      const badRef = await postAsk(base, {
        message: "hi",
        refs: [{ type: "link", url: "https://example.com" }],
      });
      expect(badRef.status).toBe(400);
      expect(badRef.data.code).toBe("INVALID_BODY");

      const backwards = await postAsk(base, {
        message: "hi",
        refs: [{ type: "file", path: "a.ts", startLine: 5, endLine: 2 }],
      });
      expect(backwards.status).toBe(400);
      expect(backwards.data.code).toBe("INVALID_BODY");
    });
  });

  it("refuses a second turn while the project's claim is live with RUN_IN_PROGRESS (409)", async () => {
    await withAskCtx(async ({ base }) => {
      holdWriteBacks = true;
      const first = await postAsk(base, { message: "one" });
      expect(first.status).toBe(202);

      const overlap = await postAsk(base, { message: "two" });
      expect(overlap.status).toBe(409);
      expect(overlap.data.ok).toBe(false);
      expect(overlap.data.code).toBe("RUN_IN_PROGRESS");

      // The overlapping turn never claimed or spawned anything.
      expect(capturedJobs).toHaveLength(1);

      // Release the held write-back so the run settles cleanly.
      holdWriteBacks = false;
      releaseHeld?.();
    });
  });
});

describe("POST /api/p/:slug/ask — prompt rendering", () => {
  it("renders refs into the prompt, byte-identically to the previous reference block", async () => {
    await withAskCtx(async ({ base }) => {
      const { status } = await postAsk(base, { message: "explain", refs: [DOC_REFERENCE] });
      expect(status).toBe(202);

      const prompt = promptOf(capturedJobs[0] as ClaudeJobInput);
      expect(prompt.startsWith("explain")).toBe(true);
      expect(prompt).toContain("## REFERENCES");
      expect(prompt).toContain(DOC_REFERENCE.text);
      expect(prompt).toContain("<<<ARCS_UNTRUSTED_DOC");
      expect(prompt).toContain("<<<END_ARCS_UNTRUSTED_DOC>>>");
    });
  });

  it("adds no bytes at all when refs is absent", async () => {
    await withAskCtx(async ({ base }) => {
      await postAsk(base, { message: "hello" });
      const prompt = promptOf(capturedJobs[0] as ClaudeJobInput);
      expect(prompt).toBe("hello");
    });
  });

  it("renders the bounded history tail oldest-first, capped at the last 20 turns", async () => {
    await withAskCtx(async ({ base }) => {
      const history = Array.from({ length: 25 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        text: `turn ${i}`,
      }));
      const { status } = await postAsk(base, { message: "continue", history });
      expect(status).toBe(202);

      const prompt = promptOf(capturedJobs[0] as ClaudeJobInput);
      // The block renders oldest-first: turn 5 (the 6th, an assistant turn) is
      // the head survivor, followed by the 7th (a user turn).
      const head = prompt.indexOf("assistant: turn 5\nuser: turn 6");
      expect(head).toBeGreaterThan(-1);
      // The 5 overflow entries were dropped from the head.
      expect(prompt).not.toContain("turn 0");
      expect(prompt).not.toContain("turn 4");
      // The most recent turn survives.
      expect(prompt).toContain("user: turn 24");
    });
  });

  it("drops the overflow HEAD when the rendered history exceeds the char ceiling", async () => {
    await withAskCtx(async ({ base }) => {
      const long = "x".repeat(500);
      const history = Array.from({ length: 20 }, (_, i) => ({
        role: "user" as const,
        text: `${i}:${long}`,
      }));
      await postAsk(base, { message: "continue", history });

      const prompt = promptOf(capturedJobs[0] as ClaudeJobInput);
      // 20 × ~503 chars ≈ 10k > 6000 — the oldest entries pay. The head that
      // survives is the most recent chunk that still fits under the cap.
      expect(prompt).toContain("## Previous conversation (through this session)");
      expect(prompt).toContain("19:x".repeat(1));
      const block = prompt.slice(prompt.indexOf("## Previous conversation"));
      expect(block.length).toBeLessThanOrEqual(6000 + 64); // heading + joiners
    });
  });
});

describe("POST /api/p/:slug/ask — continuation and write-back", () => {
  it("continues a runtime session: pi gets --session-id + --session-dir under a created store dir", async () => {
    await withAskCtx(async ({ base, projectDir }) => {
      const { status } = await postAsk(base, {
        message: "keep going",
        continueSessionId: "ses_0AskRoute00000000000000000",
      });
      expect(status).toBe(202);

      const [job] = capturedJobs;
      const storeDir = resolve(projectDir, "pi-sessions");
      expect(job?.argv).toEqual([
        "-p",
        "--mode",
        "json",
        "--session-id",
        "ses_0AskRoute00000000000000000",
        "--session-dir",
        storeDir,
        "keep going",
      ]);
      expect(existsSync(storeDir)).toBe(true);
    });
  });

  it("continues a claude-code session with --resume and a codex session with exec resume", async () => {
    await withAskCtx(async ({ base }) => {
      await postAsk(base, {
        runner: "claude-code",
        message: "continue",
        continueSessionId: "ses_cc_1",
      });
      expect(capturedJobs[0]?.argv).toEqual([
        "-p",
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
        "--resume",
        "ses_cc_1",
        "continue",
      ]);

      // Let the first run's write-back release the project's claim before the
      // next turn is accepted (one live run per project).
      await new Promise((done) => setTimeout(done, 50));
      await postAsk(base, { runner: "codex", message: "continue", continueSessionId: "ses_cx_1" });
      expect(capturedJobs[1]?.argv).toEqual([
        "exec",
        "resume",
        "ses_cx_1",
        "--json",
        "--sandbox",
        "workspace-write",
        "continue",
      ]);
    });
  });

  it("harvests the runtime session id from the run log and stamps it on the claim", async () => {
    await withAskCtx(async ({ base, projectDir }) => {
      // A pi first turn: the `session` header line is where pi carries its id.
      runStdout = '{"type":"session","id":"ses_pi_harvested"}\n';
      const { status, data } = await postAsk(base, { message: "hi" });
      expect(status).toBe(202);

      await waitFor(
        async () => (await getRun(projectDir, data.runId ?? ""))?.runtimeSessionId !== undefined,
        "the harvested id to land",
      );
      const run = await getRun(projectDir, data.runId ?? "");
      expect(run?.runtimeSessionId).toBe("ses_pi_harvested");
    });
  });

  it("settles a lost continuation with errorCode CONTINUATION_LOST so the client re-seeds", async () => {
    await withAskCtx(async ({ base, projectDir }) => {
      runRecord = {
        ...RUN_RECORD,
        outcome: "error",
        error: "No conversation found with session ID ses_pi_gone",
      };
      const { status, data } = await postAsk(base, {
        message: "continue",
        continueSessionId: "ses_pi_gone",
      });
      expect(status).toBe(202);

      await waitFor(
        async () => (await getRun(projectDir, data.runId ?? ""))?.errorCode === "CONTINUATION_LOST",
        "CONTINUATION_LOST",
      );
      const run = await getRun(projectDir, data.runId ?? "");
      expect(run?.outcome).toBe("error");
      expect(run?.errorCode).toBe("CONTINUATION_LOST");
    });
  });
});

describe("DELETE /api/p/:slug/runs/:runId — cancel", () => {
  it("SIGTERMs the live pid and settles the run interrupted, idempotently", async () => {
    await withAskCtx(async ({ base, projectDir }) => {
      holdWriteBacks = true;
      const { status, data } = await postAsk(base, { message: "long run" });
      expect(status).toBe(202);
      const runId = data.runId as string;

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      try {
        const cancelled = await deleteRun(base, runId);
        expect(cancelled.status).toBe(200);
        expect(cancelled.data.cancelled).toBe(runId);

        expect(killSpy).toHaveBeenCalledWith(4242, "SIGTERM");
        const run = await getRun(projectDir, runId);
        expect(run?.outcome).toBe("interrupted");
        expect(run?.error).toBe("cancelled by user");
        expect(run?.endedAt).toBeTypeOf("number");
      } finally {
        killSpy.mockRestore();
      }

      // Idempotent: a settled run answers 404, and the held write-back settling
      // later must NOT re-stamp a newer outcome over the cancel.
      const again = await deleteRun(base, runId);
      expect(again.status).toBe(404);
      expect(again.data.code).toBe("RUN_NOT_FOUND");

      holdWriteBacks = false;
      releaseHeld?.();
      // The held settle runs through the write-back on the next tick.
      await new Promise((done) => setTimeout(done, 50));
      const run = await getRun(projectDir, runId);
      // The cancel won the race: the runner's own error write-back was a no-op.
      expect(run?.outcome).toBe("interrupted");
    });
  });
});
