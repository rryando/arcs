/**
 * POST /api/p/:slug/sessions and POST /api/p/:slug/sessions/:id/turns — the
 * ARCS-owned threads and the one-shot runs that drive them.
 *
 * The runner module is faked with a vitest module mock (the route has no
 * injection point of its own): the mock records the exact argv/cwd/writeTargetKey
 * handed to runClaudeJob (plus the runner options, where the opencode driver's
 * binary travels), fires the registered onSettled write-back with a canned run
 * record (simulating the runner's post-close settle), and resolves that record,
 * so the contract under test is what ARCS puts on the wire — runtime selection,
 * argv ownership, write-target selection, sidecar ordering, seed-decision
 * repair — rather than the runner's own lifecycle (covered by
 * test/claude-runner.test.ts).
 *
 * The canned record is also what makes the seed-decision repairs testable: a
 * test that sets `runRecord.error` to claude's literal stderr drives the exact
 * branch a real failure would, with no claude in sight.
 *
 * Every thread here is ARCS-origin ("arcs"): creation mints them, turns
 * continue them. There is no observed-session path anymore — the hook bridge
 * that produced observed sessions is gone, and with it the adoption fork.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionTurns, sessionTranscriptPath } from "../src/utils/claude-transcript.js";
import {
  createSession,
  getSession,
  listSessions,
  type SessionMeta,
  updateSession,
} from "../src/utils/session-store.js";
import { startWebServer, type WebServerHandle } from "../src/web-server/index.js";
import { currentWebToken } from "../src/web-server/web-token.js";

/**
 * Counter for the ONE subprocess a sessions read can still spawn: the
 * reconciler's `claude agents --json`. It is the real `execFile` that is faked
 * here (not the reconciler, which the routes call with no injection point), so
 * the count is the number of processes a request would truly have started.
 * `vi.hoisted` because the mock factory below is hoisted above every import.
 */
const agentsProbe = vi.hoisted(() => ({ spawns: 0, stdout: "[]" }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
  const execFile = (
    file: string,
    args: readonly string[],
    options: unknown,
    callback: ExecFileCallback,
  ): unknown => {
    if (file !== "claude") {
      return (actual.execFile as unknown as (...rest: unknown[]) => unknown)(
        file,
        args,
        options,
        callback,
      );
    }
    agentsProbe.spawns += 1;
    callback(null, agentsProbe.stdout, "");
    return undefined;
  };
  return { ...actual, execFile };
});

vi.mock("../src/web-server/claude-runner.js", () => ({
  isRunLive: vi.fn(() => false),
  // The route reads the freshly spawned child's pid straight after calling
  // runClaudeJob (the real runner spawns synchronously) and persists it on the
  // session's run claim — so the fake runner has to answer with one too.
  liveRunPid: vi.fn(() => 4242),
  resolveTimeoutMs: vi.fn(() => 600_000),
  runClaudeJob: vi.fn(),
  beginRun: vi.fn(),
  endRun: vi.fn(),
}));

import {
  type ClaudeJobInput,
  type ClaudeRunnerOptions,
  type ClaudeRunRecord,
  isRunLive,
  liveRunPid,
  runClaudeJob,
} from "../src/web-server/claude-runner.js";
import {
  foldRunEventLog,
  RUN_EVENT_LOG_RETENTION,
  runEventLogPath,
} from "../src/web-server/run-event-log.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const WORKSPACE = "/work/demo";
/** A bare RFC-4122 v4 uuid — the only shape claude >= 2.x accepts on
 *  `--session-id`/`--resume` (the human-readable ARCS thread id is rejected). */
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** An ARCS thread id: a record NAME, and never a token in argv. */
const ARCS_THREAD_ID =
  /^arcs-thread-demo-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A caller-named thread, so a test has a deterministic write target to poll. */
const THREAD = "arcs-thread-demo-fixed";
/** An opencode-native session id, as a real `opencode run --format json`
 *  harvests one off its stdout. */
const OC_SESSION = "ses_0TestSessionId0000000000000";
const RUN_RECORD: ClaudeRunRecord = {
  pid: 4242,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  outcome: "success",
  replyText: "reply",
};

/** A valid `refs` entry for POST /turns, per sessionReferenceSchema. */
const REFERENCE = {
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

/** Jobs the (fake) runner was asked to spawn, in call order. */
let capturedJobs: ClaudeJobInput[] = [];
/** Runner options each job carried — the driver-driven binary travels here. */
let capturedOptions: (ClaudeRunnerOptions | undefined)[] = [];
/** Record the fake runner settles each job with — tests override for error runs. */
let runRecord: ClaudeRunRecord = RUN_RECORD;
/**
 * Child stdout the fake runner persists to the run's event log before it
 * settles, exactly as the real runner does mid-stream. Empty means the run
 * left no log at all — the captured reply is then the only thing that could
 * reach the sidecar (claude-code only; a driver-driven run appends none).
 */
let runStdout = "";

/** Serializes events as the NDJSON lines a stream emits. */
function ndjson(...events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

// --- claude stream-json shapes -------------------------------------------------

const assistantEvent = (...blocks: unknown[]) => ({
  type: "assistant",
  message: { role: "assistant", content: blocks },
});
const textBlock = (text: string) => ({ type: "text", text });
const toolBlock = (name: string) => ({ type: "tool_use", id: "tu_1", name, input: {} });

// --- opencode `run --format json` shapes ---------------------------------------

const ocText = (text: string, sid: string = OC_SESSION) => ({
  type: "text",
  timestamp: 2,
  sessionID: sid,
  part: { type: "text", text },
});
const ocTool = (name: string, sid: string = OC_SESSION) => ({
  type: "tool_use",
  timestamp: 3,
  sessionID: sid,
  part: { type: "tool", tool: name, state: { status: "completed" } },
});
const ocStepStart = (sid: string = OC_SESSION) => ({
  type: "step_start",
  timestamp: 1,
  sessionID: sid,
});

beforeEach(() => {
  capturedJobs = [];
  capturedOptions = [];
  runRecord = RUN_RECORD;
  runStdout = "";
  agentsProbe.spawns = 0;
  agentsProbe.stdout = "[]";
  vi.mocked(isRunLive).mockReturnValue(false);
  vi.mocked(liveRunPid).mockReturnValue(4242);
  vi.mocked(runClaudeJob).mockImplementation(async (input, options) => {
    capturedJobs.push(input);
    capturedOptions.push(options);
    // The real runner writes every stdout line to the run's event log verbatim
    // as it arrives, before parsing and long before settling; the fake leaves
    // behind just that durable artifact so the route's settle has one to fold.
    if (input.eventLog !== undefined && runStdout !== "") {
      const path = runEventLogPath(
        input.eventLog.projectDir,
        input.eventLog.sessionId,
        input.eventLog.runId,
      );
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, runStdout, "utf-8");
    }
    // Simulate the real runner's post-close write-back (T005 seam): once the
    // child exits, onSettled fires with the settled record before the run
    // resolves.
    if (input.onSettled !== undefined) await input.onSettled(runRecord);
    return runRecord;
  });
});

afterEach(() => {
  vi.mocked(isRunLive).mockReset();
  vi.mocked(liveRunPid).mockReset();
  vi.mocked(runClaudeJob).mockReset();
});

interface RunCtx {
  base: string;
  projectDir: string;
}

async function withRunRouteCtx(run: (ctx: RunCtx) => Promise<void>): Promise<void> {
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

interface TurnEnvelope {
  ok: boolean;
  data?: { runId?: string; streamUrl?: string; writeTargetId?: string };
  code?: string;
  message?: string;
}

/** A session as the read routes answer it — the record plus its derived phase. */
interface SessionView extends SessionMeta {
  phase?: string;
}

async function postCreate(base: string, body: unknown) {
  const res = await fetch(`${base}/api/p/demo/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() ?? "" },
    body: JSON.stringify(body),
  });
  const envelope = (await res.json()) as TurnEnvelope & { data?: SessionMeta };
  return { status: res.status, envelope };
}

async function getSessions(base: string): Promise<SessionView[]> {
  const res = await fetch(`${base}/api/p/demo/sessions`, {
    headers: { "X-ARCS-Token": currentWebToken() ?? "" },
  });
  const envelope = (await res.json()) as { ok: boolean; data?: { sessions: SessionView[] } };
  expect(envelope.ok).toBe(true);
  return envelope.data?.sessions ?? [];
}

async function getSessionView(base: string, id: string): Promise<SessionView> {
  const res = await fetch(`${base}/api/p/demo/sessions/${id}`, {
    headers: { "X-ARCS-Token": currentWebToken() ?? "" },
  });
  const envelope = (await res.json()) as { ok: boolean; data?: SessionView };
  expect(envelope.ok).toBe(true);
  return envelope.data as SessionView;
}

async function postTurn(base: string, id: string, body: unknown) {
  const res = await fetch(`${base}/api/p/demo/sessions/${id}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() ?? "" },
    body: JSON.stringify(body),
  });
  const envelope = (await res.json()) as TurnEnvelope;
  return { status: res.status, envelope };
}

/**
 * An ARCS-owned legacy claude-code thread, as earlier builds minted them: the
 * record name keys the store, and the claude-facing uuid lives on metadata
 * (minted at first spawn).
 */
async function seedThread(
  projectDir: string,
  name: string,
  metadata: Record<string, unknown> = { directory: WORKSPACE },
): Promise<SessionMeta> {
  return createSession(projectDir, {
    runtimeType: "claude-code",
    runtimeSessionId: name,
    origin: "arcs",
    metadata: { control: "arcs-owned", ...metadata },
  });
}

/** An ARCS-owned opencode thread: blank runtimeSessionId until a first run
 *  harvests one. Created through the same store path POST /sessions uses. */
async function seedOpencodeThread(
  projectDir: string,
  name: string,
  metadata: Record<string, unknown> = { directory: WORKSPACE },
): Promise<SessionMeta> {
  return createSession(projectDir, {
    runtimeType: "opencode",
    recordName: name,
    origin: "arcs",
    metadata: { control: "arcs-owned", ...metadata },
  });
}

/** The thread's claude-facing uuid as the store holds it. */
async function claudeUuid(projectDir: string, threadId: string): Promise<string> {
  return (await getSession(projectDir, threadId)).metadata?.claudeSessionId as string;
}

/** Waits until the out-of-band metadata.run registration lands on the session. */
async function expectRunRegistered(projectDir: string, normalizedId: string, mode: string) {
  await vi.waitFor(async () => {
    const stored = await getSession(projectDir, normalizedId);
    expect(stored.metadata?.run).toMatchObject({ pid: 4242, startedAt: 1_700_000_000_000, mode });
  });
}

/**
 * Waits until the run has settled and released its claim, and answers the very
 * snapshot that satisfied it.
 *
 * Callers assert the settle's conclusions on THAT record rather than on a fresh
 * read, because the released claim is the only thing serializing this run
 * against the next one: everything the settle concluded has to be on the record
 * already at the instant the claim goes, or a turn accepted right afterwards
 * reads state the run just disproved. Re-reading would hand a settle that
 * writes its conclusions late a second chance to pass, which is exactly the
 * flake that hid the split write.
 */
async function expectSettled(projectDir: string, normalizedId: string): Promise<SessionMeta> {
  return vi.waitFor(async () => {
    const stored = await getSession(projectDir, normalizedId);
    expect(stored.currentRunId).toBeUndefined();
    return stored;
  });
}

/**
 * The permission segment each intent produces, hardcoded rather than imported.
 *
 * Importing `buildPermissionArgv` here would only prove the module agrees with
 * itself; the point of asserting it from the route's side is that a policy
 * change shows up as a wire change in the test that owns the wire.
 */
const INTENT_ARGV = {
  ask: ["--tools", "Read,Grep,Glob", "--permission-mode", "plan"],
  change: ["--tools", "Read,Grep,Glob,Edit,Write,TodoWrite", "--permission-mode", "acceptEdits"],
} as const;

/**
 * The turn route's argv, in full: the targeting tokens, then the permission
 * segment, then the staged-environment pair when one was injected.
 *
 * The staged text is asserted by SHAPE rather than by value — it is ~3.5 KB of
 * assembled context and pinning it whole would assert prompt-assembly's output
 * from here. `staged` says whether the pair is expected AT ALL, which is the
 * route's own decision: a spawn that starts a conversation always carries the
 * block, a spawn that continues one carries it only on a restage.
 */
function expectTurnArgv(
  job: ClaudeJobInput,
  targeting: string[],
  opts: { intent: keyof typeof INTENT_ARGV; staged: boolean },
): void {
  const base = [...targeting, ...INTENT_ARGV[opts.intent]];
  if (!opts.staged) {
    expect(job.argv).toEqual(base);
    return;
  }
  expect(job.argv.slice(0, base.length)).toEqual(base);
  expect(job.argv).toHaveLength(base.length + 2);
  expect(job.argv[base.length]).toBe("--append-system-prompt");
  expect(job.argv[base.length + 1]).toContain(STAGE_OPEN);
}

/** The envelope the staged environment always opens with (W2). */
const STAGE_OPEN = "<<<ARCS_STAGED_ENVIRONMENT>>>";

// ---------------------------------------------------------------------------
// POST /api/p/:slug/sessions — thread creation
// ---------------------------------------------------------------------------

describe("POST /api/p/:slug/sessions — thread creation", () => {
  it("creates an ARCS-origin opencode thread by default, minting the name, spawning nothing", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const { status, envelope } = await postCreate(base, {});
      expect(status).toBe(201);
      expect(envelope.ok).toBe(true);

      const created = envelope.data as SessionMeta;
      expect(created.runtimeType).toBe("opencode");
      expect(created.origin).toBe("arcs");
      expect(created.normalizedId).toMatch(ARCS_THREAD_ID);
      // No runtime-native id exists yet — the first settled run harvests one.
      expect(created.runtimeSessionId).toBe("");
      expect(created.metadata).toMatchObject({ control: "arcs-owned", directory: WORKSPACE });

      // Creation spawns nothing: the first POST /turns does.
      expect(capturedJobs).toHaveLength(0);

      // And the record round-trips through the store under the minted name.
      const stored = await getSession(projectDir, created.normalizedId);
      expect(stored.runtimeSessionId).toBe("");
      expect(stored.origin).toBe("arcs");
    });
  });

  it("honors an explicit runtimeType and a caller-named record", async () => {
    await withRunRouteCtx(async ({ base }) => {
      const { status, envelope } = await postCreate(base, {
        runtimeType: "claude-code",
        runtimeSessionId: "my-thread",
      });
      expect(status).toBe(201);

      const created = envelope.data as SessionMeta;
      expect(created.normalizedId).toBe("my-thread");
      expect(created.runtimeType).toBe("claude-code");
      expect(created.origin).toBe("arcs");
      // The supplied name keys the RECORD only — it never seeds
      // runtimeSessionId, which stays blank until the runtime produces one.
      expect(created.runtimeSessionId).toBe("");
    });
  });

  it("400s with PROJECT_WORKSPACE_UNSET when the project has no workspace path", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      writeFileSync(
        resolve(projectDir, "meta.json"),
        JSON.stringify({
          id: "demo",
          name: "Demo",
          description: "test project",
          createdAt: "2026-01-01T00:00:00.000Z",
          workspacePaths: [],
        }),
        "utf-8",
      );

      const { status, envelope } = await postCreate(base, {});
      expect(status).toBe(400);
      expect(envelope.code).toBe("PROJECT_WORKSPACE_UNSET");
      expect(capturedJobs).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// POST /turns — opencode threads, driven through the run-driver adapter
// ---------------------------------------------------------------------------

describe("POST /api/p/:slug/sessions/:id/turns — opencode one-shot runs", () => {
  it("drives a fresh thread with `opencode run --format json --title`, answering 202", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedOpencodeThread(projectDir, THREAD, { directory: WORKSPACE, title: "Fix it" });

      const { status, envelope } = await postTurn(base, THREAD, {
        intent: "ask",
        message: "start the thread",
      });

      expect(status).toBe(202);
      expect(envelope.ok).toBe(true);
      const runId = envelope.data?.runId as string;
      expect(envelope.data?.writeTargetId).toBe(THREAD);
      expect(envelope.data?.streamUrl).toBe(`/api/p/demo/sessions/${THREAD}/runs/${runId}/stream`);

      // THE DRIVER'S ARGV, verbatim: one-shot CLI, JSON output, the title from
      // metadata, the prompt as ONE argv element.
      expect(capturedJobs[0].argv).toEqual([
        "run",
        "--format",
        "json",
        "--title",
        "Fix it",
        "start the thread",
      ]);
      // Spawned through the adapter's binary, and the runner's stream-json
      // rewriting is OFF — opencode NDJSON reaches the child verbatim.
      expect(capturedOptions[0]).toEqual({ binary: "opencode" });
      expect(capturedJobs[0].streamJsonArgv).toBe(false);
      expect(capturedJobs[0]).toMatchObject({ cwd: WORKSPACE, writeTargetKey: THREAD });
      // No claude vocabulary anywhere in the argv.
      expect(capturedJobs[0].argv.join(" ")).not.toContain("--tools");
      expect(capturedJobs[0].argv.join(" ")).not.toContain("--permission-mode");

      // Same durable-run machinery as every other runtime: deadline, claim,
      // event log keyed to the SAME run id the 202 named.
      expect(capturedJobs[0].eventLog?.sessionId).toBe(THREAD);
      expect(capturedJobs[0].eventLog?.runId).toBe(runId);
      await expectRunRegistered(projectDir, THREAD, "ask");
    });
  });

  it("persists the harvested sessionID onto the thread, so the next turn continues with -s", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedOpencodeThread(projectDir, THREAD);
      runStdout = ndjson(ocStepStart(), ocText("Reading."), ocText("Done."));

      const first = await postTurn(base, THREAD, { intent: "ask", message: "go" });
      expect(first.status).toBe(202);
      const stored = await expectSettled(projectDir, THREAD);
      expect(stored.runtimeSessionId).toBe(OC_SESSION);

      const second = await postTurn(base, THREAD, { intent: "ask", message: "continue" });
      expect(second.status).toBe(202);
      // CONTINUATION: `-s <harvested id>`, no --title — the thread already has
      // its name, and the message rides as one element.
      expect(capturedJobs[1].argv).toEqual([
        "run",
        "--format",
        "json",
        "-s",
        OC_SESSION,
        "continue",
      ]);
      expect(await getSession(projectDir, THREAD)).toMatchObject({ runtimeSessionId: OC_SESSION });
    });
  });

  it("folds the opencode log into the sidecar via the driver normalizer, and never doubles the reply", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedOpencodeThread(projectDir, THREAD);
      runStdout = ndjson(ocStepStart(), ocText("Looking."), ocTool("read"), ocText("Found it."), {
        type: "step_finish",
        timestamp: 9,
        sessionID: OC_SESSION,
      });

      const { status } = await postTurn(base, THREAD, { intent: "ask", message: "go" });
      expect(status).toBe(202);
      await expectSettled(projectDir, THREAD);
      const runId = ((await getSession(projectDir, THREAD)).metadata?.run as { runId?: string })
        .runId as string;

      const turns = await readSessionTurns(projectDir, THREAD);
      expect(turns.map((t) => [t.id, t.type, t.text, t.tool?.name])).toEqual([
        [-1, "user", "go", undefined],
        [-2, "assistant", "Looking.", undefined],
        [-3, "assistant", "", "read"],
        [-4, "assistant", "Found it.", undefined],
      ]);
      // Every folded turn carries the run id; the request-time user turn does not.
      expect(turns.map((t) => t.run)).toEqual([undefined, runId, runId, runId]);
      // The canned replyText is NOT appended on top of the fold — and a
      // driver-driven run never appends the captured reply at all, because the
      // runner's reader cannot have produced a meaningful one.
      expect(turns.some((t) => t.text === "reply")).toBe(false);

      // Folding the settled log again is a no-op.
      const again = await foldRunEventLog(projectDir, THREAD, runId, { runtimeType: "opencode" });
      expect(again).toEqual({ appended: 0, alreadyFolded: true, assistantTextFolded: true });
    });
  });

  it("an error outcome still folds the partial output the child produced", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedOpencodeThread(projectDir, THREAD);
      runStdout = ndjson(ocText("got this far"));
      runRecord = { ...RUN_RECORD, outcome: "error", error: "model refused" };

      await postTurn(base, THREAD, { intent: "ask", message: "go" });
      await expectSettled(projectDir, THREAD);

      const turns = await readSessionTurns(projectDir, THREAD);
      expect(turns.map((t) => [t.type, t.text])).toEqual([
        ["user", "go"],
        ["assistant", "got this far"],
      ]);
    });
  });

  it("without a log, a successful driver run appends nothing — there is no reply to trust", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedOpencodeThread(projectDir, THREAD);
      runStdout = "";

      await postTurn(base, THREAD, { intent: "ask", message: "go" });
      await expectSettled(projectDir, THREAD);

      const turns = await readSessionTurns(projectDir, THREAD);
      expect(turns.map((t) => [t.type, t.text])).toEqual([["user", "go"]]);
    });
  });

  it("stamps lastMessageAt and re-activates the thread at settle", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedOpencodeThread(projectDir, THREAD);
      runStdout = ndjson(ocText("done"));

      await postTurn(base, THREAD, { intent: "ask", message: "go" });
      const stored = await expectSettled(projectDir, THREAD);

      expect(stored.lastMessageAt).toBeTypeOf("string");
      expect(stored.status).toBe("active");
    });
  });

  it("mints an opencode thread when threadRef names nothing yet", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      const { status, envelope } = await postTurn(base, THREAD, {
        intent: "ask",
        message: "mint me",
        threadRef: "arcs-thread-demo-minted",
      });

      expect(status).toBe(202);
      expect(envelope.data?.writeTargetId).toBe("arcs-thread-demo-minted");

      const minted = await getSession(projectDir, "arcs-thread-demo-minted");
      expect(minted.runtimeType).toBe("opencode");
      expect(minted.origin).toBe("arcs");
      expect(minted.runtimeSessionId).toBe("");
      expect(minted.metadata).toMatchObject({ control: "arcs-owned", directory: WORKSPACE });
      // Driven by the driver from birth.
      expect(capturedOptions[0]).toEqual({ binary: "opencode" });
      expect(capturedJobs[0].argv).toEqual(["run", "--format", "json", "mint me"]);
    });
  });

  it("409s an overlapping run on the same write-target before appending or spawning", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedOpencodeThread(projectDir, THREAD);
      vi.mocked(isRunLive).mockReturnValue(true);

      const { status, envelope } = await postTurn(base, THREAD, {
        intent: "ask",
        message: "busy?",
      });

      expect(status).toBe(409);
      expect(envelope.code).toBe("CLAUDE_RUN_IN_PROGRESS");
      expect(capturedJobs).toHaveLength(0);
      expect(await readSessionTurns(projectDir, THREAD)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// POST /turns — legacy claude-code threads (--session-id seed / --resume)
// ---------------------------------------------------------------------------

describe("POST /api/p/:slug/sessions/:id/turns — fresh thread seed (claude-code)", () => {
  it("seeds the thread with --session-id on first contact and answers 202 naming the run", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      const { status, envelope } = await postTurn(base, THREAD, {
        intent: "ask",
        message: "start the thread",
      });

      expect(status).toBe(202);
      expect(envelope.ok).toBe(true);
      const runId = envelope.data?.runId as string;
      expect(envelope.data?.writeTargetId).toBe(THREAD);
      expect(envelope.data?.streamUrl).toBe(`/api/p/demo/sessions/${THREAD}/runs/${runId}/stream`);

      // The ARCS thread id names the RECORD (picker label + sidecar filename);
      // claude only ever sees the bare uuid minted onto its metadata.
      const uuid = await claudeUuid(projectDir, THREAD);
      expect(uuid).toMatch(BARE_UUID);
      expect(uuid).not.toBe(THREAD);

      expect(capturedJobs).toHaveLength(1);
      expect(capturedJobs[0]).toMatchObject({ cwd: WORKSPACE, writeTargetKey: THREAD });
      expect(capturedOptions[0]).toBeUndefined();
      expectTurnArgv(
        capturedJobs[0],
        ["-p", "start the thread", "--session-id", uuid, "--output-format", "json"],
        { intent: "ask", staged: true },
      );
      // The record NAME is never a token — claude >= 2.x rejects anything that
      // is not a bare uuid on --session-id/--resume.
      expect(capturedJobs[0].argv).not.toContain(THREAD);

      // The seed decision lands at SPAWN, not at settle.
      expect((await getSession(projectDir, THREAD)).metadata?.threadInitialized).toBe(true);
      await expectRunRegistered(projectDir, THREAD, "ask");
    });
  });

  it("keeps the write target an ARCS-owned thread, exactly one record however many turns", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "own it" });
      await postTurn(base, THREAD, { intent: "ask", message: "keep owning it" });

      const thread = await getSession(projectDir, THREAD);
      expect(thread.origin).toBe("arcs");
      expect(thread.metadata).toMatchObject({ control: "arcs-owned", directory: WORKSPACE });
      expect(
        (await listSessions(projectDir)).filter((s) => s.normalizedId === THREAD),
      ).toHaveLength(1);
    });
  });

  it("400s with PROJECT_WORKSPACE_UNSET when neither the thread nor the project pins a directory", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      writeFileSync(
        resolve(projectDir, "meta.json"),
        JSON.stringify({
          id: "demo",
          name: "Demo",
          description: "test project",
          createdAt: "2026-01-01T00:00:00.000Z",
          workspacePaths: [],
        }),
        "utf-8",
      );
      await seedThread(projectDir, THREAD, {});

      const { status, envelope } = await postTurn(base, THREAD, {
        intent: "ask",
        message: "where do I run?",
      });

      expect(status).toBe(400);
      expect(envelope.code).toBe("PROJECT_WORKSPACE_UNSET");
      expect(capturedJobs).toHaveLength(0);
    });
  });
});

describe("POST /api/p/:slug/sessions/:id/turns — thread resume (claude-code)", () => {
  it("continues a seeded thread with --resume ALONE, minting the uuid exactly once", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "one" });
      const uuid = await claudeUuid(projectDir, THREAD);

      const second = await postTurn(base, THREAD, { intent: "ask", message: "two" });
      expect(second.status).toBe(202);
      expect(second.envelope.data?.writeTargetId).toBe(THREAD);

      // claude >= 2.x refuses --session-id alongside --resume unless
      // --fork-session is set, and a re-seed answers "already in use". The
      // continued CONVERSATION already carries the staged block, so a fresh
      // stage is not re-injected either.
      expectTurnArgv(capturedJobs[1], ["-p", "two", "--resume", uuid, "--output-format", "json"], {
        intent: "ask",
        staged: false,
      });
      expect(capturedJobs[1].argv).not.toContain("--session-id");
      expect(capturedJobs[1].argv).not.toContain("--fork-session");

      const third = await postTurn(base, THREAD, { intent: "ask", message: "three" });
      expect(third.status).toBe(202);
      expectTurnArgv(
        capturedJobs[2],
        ["-p", "three", "--resume", uuid, "--output-format", "json"],
        {
          intent: "ask",
          staged: false,
        },
      );
      expect(await claudeUuid(projectDir, THREAD)).toBe(uuid);
    });
  });

  it("accumulates the conversation in one sidecar, user turn then reply, in order", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "start the thread" });
      await postTurn(base, THREAD, { intent: "ask", message: "continue" });

      await vi.waitFor(async () => {
        const turns = await readSessionTurns(projectDir, THREAD);
        expect(turns.map((t) => t.text)).toEqual([
          "start the thread",
          "reply",
          "continue",
          "reply",
        ]);
        expect(turns.map((t) => t.id)).toEqual([-1, -2, -3, -4]);
      });
    });
  });

  it("continues a thread named by threadRef without re-minting anything", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);
      await postTurn(base, THREAD, { intent: "ask", message: "one" });
      const uuid = await claudeUuid(projectDir, THREAD);

      const second = await postTurn(base, THREAD, {
        intent: "ask",
        message: "two",
        threadRef: THREAD,
      });
      expect(second.status).toBe(202);
      expect(second.envelope.data?.writeTargetId).toBe(THREAD);
      expect(capturedJobs[1].argv).toContain("--resume");
      expect(capturedJobs[1].argv).toContain(uuid);
      expect(await claudeUuid(projectDir, THREAD)).toBe(uuid);
    });
  });
});

describe("POST /api/p/:slug/sessions/:id/turns — refusals", () => {
  /** An observed claude-code record — the class adoption used to fork. */
  async function seedObserved(projectDir: string, runtimeSessionId: string): Promise<SessionMeta> {
    return createSession(projectDir, {
      runtimeType: "claude-code",
      runtimeSessionId,
      metadata: { directory: WORKSPACE },
    });
  }

  it("refuses to address a session ARCS does not own — no fork, no spawn, no writes", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const observed = await seedObserved(projectDir, "cc_observed_direct");
      const before = await getSession(projectDir, observed.normalizedId);

      const { status, envelope } = await postTurn(base, observed.normalizedId, {
        intent: "ask",
        message: "adopt me",
      });

      expect(status).toBe(400);
      expect(envelope.code).toBe("TURN_THREAD_NOT_OWNED");
      expect(envelope.message).toContain("not an ARCS-owned thread");
      expect(capturedJobs).toHaveLength(0);
      // Byte-for-byte the record it was, and its sidecar is untouched.
      expect(await getSession(projectDir, observed.normalizedId)).toEqual(before);
      expect(await readSessionTurns(projectDir, observed.normalizedId)).toEqual([]);
    });
  });

  it("refuses a threadRef naming a session ARCS does not own", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const observed = await seedObserved(projectDir, "cc_observed_ref");

      const { status, envelope } = await postTurn(base, observed.normalizedId, {
        intent: "ask",
        message: "claim it",
        threadRef: observed.normalizedId,
      });

      expect(status).toBe(400);
      expect(envelope.code).toBe("TURN_THREAD_NOT_OWNED");
      expect(capturedJobs).toHaveLength(0);
      // Nothing was written onto the observed record — no ARCS metadata, no run.
      const stored = await getSession(projectDir, observed.normalizedId);
      expect(stored.origin).toBe("observed");
      expect(stored.metadata?.claudeSessionId).toBeUndefined();
    });
  });

  it("404s a stale index record whose runtime the store no longer reads", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      // A stale on-disk record from a removed runtime, written directly because
      // the store no longer mints these: readSessionIndex drops any record
      // whose runtimeType is outside SESSION_RUNTIME_TYPES before a read sees
      // it, so the turns path answers as if the record were never listed.
      mkdirSync(resolve(projectDir, "sessions"), { recursive: true });
      writeFileSync(
        resolve(projectDir, "sessions", "index.json"),
        JSON.stringify({
          sessions: [
            {
              id: "ses-stale-runtime",
              normalizedId: "ses-stale-runtime",
              runtimeType: "bogus",
              runtimeSessionId: "ses-stale-runtime",
              status: "active",
              startedAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              metadata: {},
            },
          ],
        }),
        "utf-8",
      );

      const { status, envelope } = await postTurn(base, "ses-stale-runtime", {
        intent: "ask",
        message: "hi",
      });

      expect(status).toBe(404);
      expect(envelope.code).toBe("ITEM_NOT_FOUND");
      expect(capturedJobs).toHaveLength(0);
    });
  });

  it("404s for a session the project does not have", async () => {
    await withRunRouteCtx(async ({ base }) => {
      const { status, envelope } = await postTurn(base, "missing-session", {
        intent: "ask",
        message: "hi",
      });

      expect(status).toBe(404);
      expect(envelope.code).toBe("ITEM_NOT_FOUND");
      expect(capturedJobs).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// POST /turns — argv is owned by the permission policy (claude-code path)
// ---------------------------------------------------------------------------

describe("POST /api/p/:slug/sessions/:id/turns — argv is owned by the permission policy", () => {
  it("emits the policy segment LAST, with the staged text in its slot and nowhere else", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "policy" });

      const argv = capturedJobs[0].argv;
      // Ordering is load-bearing: --tools is variadic and consumes following
      // tokens until the next dash-leading one, and --append-system-prompt
      // consumes exactly one — so the segment cannot precede -p or the
      // targeting tokens.
      expect(argv.indexOf("--tools")).toBeGreaterThan(argv.indexOf("-p"));
      expect(argv.indexOf("--tools")).toBeGreaterThan(argv.indexOf("--session-id"));
      expect(argv.indexOf("--append-system-prompt")).toBe(argv.length - 2);
      // Exactly ONE staged flag: the old direct push alongside the policy
      // segment emitted it twice.
      expect(argv.filter((token) => token === "--append-system-prompt")).toHaveLength(1);
      expect(argv[argv.length - 1]).toContain(STAGE_OPEN);
    });
  });

  it("widens the tool set and the permission mode for intent=change, and nothing else", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "change", message: "edit something" });

      const uuid = await claudeUuid(projectDir, THREAD);
      expectTurnArgv(
        capturedJobs[0],
        ["-p", "edit something", "--session-id", uuid, "--output-format", "json"],
        { intent: "change", staged: true },
      );
      // Bash stays out until a guard opts into it (a separate task owns that).
      expect(capturedJobs[0].argv).not.toContain("Bash");
      await expectRunRegistered(projectDir, THREAD, "change");
    });
  });

  it("accepts guards opaquely — validated, and contributing no token", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      const withGuards = await postTurn(base, THREAD, {
        intent: "ask",
        message: "guarded",
        guards: { allowBash: true, cwd: "/etc", nonsense: ["x"] },
      });
      expect(withGuards.status).toBe(202);

      // Nothing in the payload widened the run: the tool list is the ask set,
      // and no guard value reached argv.
      expectTurnArgv(
        capturedJobs[0],
        [
          "-p",
          "guarded",
          "--session-id",
          await claudeUuid(projectDir, THREAD),
          "--output-format",
          "json",
        ],
        { intent: "ask", staged: true },
      );
      expect(capturedJobs[0].argv).not.toContain("/etc");
    });
  });
});

// ---------------------------------------------------------------------------
// POST /turns — references reach the prompt
// ---------------------------------------------------------------------------

describe("POST /api/p/:slug/sessions/:id/turns — references reach the prompt", () => {
  it("renders refs into the -p prompt, not into the staged system tier", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      const { status } = await postTurn(base, THREAD, {
        intent: "ask",
        message: "point me at the doc",
        refs: [REFERENCE],
      });
      expect(status).toBe(202);

      const argv = capturedJobs[0].argv;
      const prompt = argv[argv.indexOf("-p") + 1];
      expect(prompt.startsWith("point me at the doc")).toBe(true);
      expect(prompt).toContain("## REFERENCES");
      expect(prompt).toContain(REFERENCE.source.label);
      expect(prompt).toContain(REFERENCE.text);
      // The system tier is the STABLE one — a per-turn pointer there would
      // break the prompt cache on every send and outlive its own turn.
      const staged = argv[argv.length - 1];
      expect(staged).toContain(STAGE_OPEN);
      expect(staged).not.toContain(REFERENCE.text);
    });
  });

  it("keeps the sidecar append as it was: user turn first, then one turn per ref", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, {
        intent: "ask",
        message: "point me at the doc",
        refs: [REFERENCE],
      });

      // Delivery-first ordering, in the shared negative id space; the success
      // settle then appends the captured reply after the reference.
      await vi.waitFor(async () => {
        const turns = await readSessionTurns(projectDir, THREAD);
        expect(turns).toHaveLength(3);
        expect(turns[0]).toMatchObject({ id: -1, type: "user", text: "point me at the doc" });
        expect(turns[1]).toMatchObject({
          id: -2,
          type: "reference",
          text: REFERENCE.text,
          section: REFERENCE.section,
          source: REFERENCE.source,
        });
        expect(turns[2]).toMatchObject({ id: -3, type: "assistant", text: "reply" });
      });
    });
  });

  it("writes the doc reference's raw sidecar line untagged, fields in frozen order", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, {
        intent: "ask",
        message: "point me at the doc",
        refs: [REFERENCE],
      });
      await vi.waitFor(async () => {
        expect(await readSessionTurns(projectDir, THREAD)).toHaveLength(3);
      });

      // The RAW line, not its parse: a doc reference on disk must stay
      // byte-identical to one written before the reference union existed — no
      // `type: "doc"` tag, `text`/`ts`/`section`/`source` in exactly this
      // order — or every sidecar written by an older ARCS stops matching the
      // ones written today. Only `ts` is the writer's own wall clock; every
      // other byte is pinned literally.
      const lines = readFileSync(sessionTranscriptPath(projectDir, THREAD), "utf-8").split("\n");
      const refLine = lines[1];
      const ts = (JSON.parse(refLine) as { ts: string }).ts;
      expect(refLine).toBe(
        '{"id":-2,"type":"reference","text":"User turn first, then the reference.",' +
          `"ts":"${ts}",` +
          '"section":{"depth":1,"text":"The headless turn appends the user turn before ' +
          'the reference.","id":"sec_1","startOffset":120,"endOffset":220},' +
          '"source":{"kind":"knowledge","label":"session-bridge","doc":"docs/bridge.md","id":"k_1"}}',
      );
    });
  });

  it("adds no bytes at all when refs is absent", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "plain" });

      const argv = capturedJobs[0].argv;
      expect(argv[argv.indexOf("-p") + 1]).toBe("plain");
      await vi.waitFor(async () => {
        const turns = await readSessionTurns(projectDir, THREAD);
        expect(turns.map((t) => [t.id, t.type, t.text])).toEqual([
          [-1, "user", "plain"],
          [-2, "assistant", "reply"],
        ]);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// POST /turns — the seed decision cannot wedge (claude-code)
// ---------------------------------------------------------------------------

describe("POST /api/p/:slug/sessions/:id/turns — the seed decision cannot wedge", () => {
  /** Claude's literal flag-validation stderr, pinned so a reword fails here. */
  const SEED_CONFLICT = (uuid: string) => `Error: Session ID ${uuid} is already in use.`;
  const NO_CONVERSATION = (uuid: string) => `No conversation found with session ID: ${uuid}`;

  it("a first turn that TIMES OUT still resumes next time — the flag lands at spawn", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);
      // The exact wedge: claude registered the uuid, then the run was killed
      // before anything could be written back. A settle-time flag would leave
      // this thread re-seeding forever into "already in use", with no UI escape.
      runRecord = {
        ...RUN_RECORD,
        outcome: "timeout",
        error: "claude run timed out after 600000ms",
      };

      const first = await postTurn(base, THREAD, { intent: "ask", message: "one" });
      expect(first.status).toBe(202);
      const uuid = await claudeUuid(projectDir, THREAD);
      await expectSettled(projectDir, THREAD);
      expect((await getSession(projectDir, THREAD)).metadata?.threadInitialized).toBe(true);

      runRecord = RUN_RECORD;
      const second = await postTurn(base, THREAD, { intent: "ask", message: "two" });
      expect(second.status).toBe(202);
      // RESUMES the same uuid rather than re-seeding it.
      expectTurnArgv(capturedJobs[1], ["-p", "two", "--resume", uuid, "--output-format", "json"], {
        intent: "ask",
        staged: false,
      });
      expect(await claudeUuid(projectDir, THREAD)).toBe(uuid);
    });
  });

  it("an 'already in use' error SETS the flag, so the next turn resumes", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);
      await postTurn(base, THREAD, { intent: "ask", message: "one" });
      const uuid = await claudeUuid(projectDir, THREAD);
      await expectSettled(projectDir, THREAD);

      // The false-negative state two live records sit in today: claude holds
      // the uuid, the record says it does not. The next turn re-seeds and
      // claude refuses it.
      await updateSession(projectDir, { id: THREAD, metadata: { threadInitialized: false } });
      runRecord = { ...RUN_RECORD, outcome: "error", error: SEED_CONFLICT(uuid) };

      const second = await postTurn(base, THREAD, { intent: "ask", message: "two" });
      expect(second.status).toBe(202);
      expect(capturedJobs[1].argv).toContain("--session-id");

      const repaired = await expectSettled(projectDir, THREAD);
      expect(repaired.metadata?.threadInitialized).toBe(true);
      expect(repaired.metadata?.claudeSessionId).toBe(uuid);
      expect(repaired.metadata?.run).toMatchObject({
        outcome: "error",
        errorCode: "THREAD_SEED_CONFLICT",
      });

      // Self-healed: the third turn resumes instead of re-seeding forever.
      runRecord = RUN_RECORD;
      await postTurn(base, THREAD, { intent: "ask", message: "three" });
      expectTurnArgv(
        capturedJobs[2],
        ["-p", "three", "--resume", uuid, "--output-format", "json"],
        {
          intent: "ask",
          staged: false,
        },
      );
    });
  });

  it("a 'No conversation found' error CLEARS the flag and re-mints the uuid", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);
      await postTurn(base, THREAD, { intent: "ask", message: "one" });
      const uuid = await claudeUuid(projectDir, THREAD);
      await expectSettled(projectDir, THREAD);

      // The opposite disagreement: ARCS resumes an id claude does not have
      // (the transcript was pruned, or the seed never actually landed).
      runRecord = { ...RUN_RECORD, outcome: "error", error: NO_CONVERSATION(uuid) };
      await postTurn(base, THREAD, { intent: "ask", message: "two" });

      // Asserted on the snapshot the released claim was read from: the repair
      // rides the SAME write, so a record that reads settled already carries it.
      const repaired = await expectSettled(projectDir, THREAD);
      expect(repaired.metadata?.threadInitialized).toBe(false);
      const reminted = repaired.metadata?.claudeSessionId as string;
      expect(reminted).toMatch(BARE_UUID);
      // Re-minted, not reused: clearing the flag alone would re-seed the very
      // id claude just refused to find.
      expect(reminted).not.toBe(uuid);
      expect(repaired.metadata?.run).toMatchObject({
        outcome: "error",
        errorCode: "THREAD_UNKNOWN_TO_CLAUDE",
      });

      // A re-seed STARTS a conversation, so the staged block rides it again —
      // the fresh session has no history that already carries one.
      runRecord = RUN_RECORD;
      await postTurn(base, THREAD, { intent: "ask", message: "three" });
      expectTurnArgv(
        capturedJobs[2],
        ["-p", "three", "--session-id", reminted, "--output-format", "json"],
        { intent: "ask", staged: true },
      );
    });
  });

  it("never publishes the released claim ahead of the repair — the settle is ONE write", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);
      await postTurn(base, THREAD, { intent: "ask", message: "one" });
      const uuid = await claudeUuid(projectDir, THREAD);
      await expectSettled(projectDir, THREAD);
      runRecord = { ...RUN_RECORD, outcome: "error", error: NO_CONVERSATION(uuid) };

      // THE STATE THIS TEST EXISTS TO OUTLAW, and why a second write cannot be
      // used to carry the repair: the runner frees its concurrency slot (endRun)
      // BEFORE the write-back runs, so from the instant the claim is released a
      // turn is accepted again. A record readable as "this run failed" while
      // still flagged initialized on the uuid that failed it sends that turn
      // straight back into the same doomed --resume — and the late write then
      // lands on top of the new run's claim, re-minting its uuid mid-flight.
      //
      // Sampled rather than asserted once, because a split write is a WINDOW:
      // one read cannot prove absence of a state that exists only between two
      // writes, so the record is read as fast as the event loop allows across
      // the whole settle. `run.outcome === "error"` is what dates a sample to
      // THIS run — before the second turn claims, metadata.run still carries the
      // first turn's success, and while it is claimed there is no outcome at all.
      const wedged: SessionMeta[] = [];
      let samples = 0;
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          samples += 1;
          const stored = await getSession(projectDir, THREAD);
          const run = stored.metadata?.run as { outcome?: string } | undefined;
          if (
            stored.currentRunId === undefined &&
            run?.outcome === "error" &&
            stored.metadata?.threadInitialized === true
          ) {
            wedged.push(stored);
          }
        }
      })();

      try {
        await postTurn(base, THREAD, { intent: "ask", message: "two" });
        const repaired = await expectSettled(projectDir, THREAD);

        // The sampler was actually reading — otherwise the emptiness below would
        // be vacuous.
        expect(samples).toBeGreaterThan(20);
        expect(wedged).toEqual([]);
        // And the settle did happen, so the emptiness is not "nothing ran".
        expect(repaired.metadata?.threadInitialized).toBe(false);
        expect(repaired.metadata?.claudeSessionId).not.toBe(uuid);
      } finally {
        // Unconditional, and covering the settle wait: if that times out, a
        // loop stopped only on the happy path outlives the test, and the next
        // teardown deletes the data dir under a still-spinning getSession —
        // surfacing as an ITEM_NOT_FOUND blamed on an innocent later test.
        sampling = false;
        await sampler;
      }
    });
  });

  it("leaves the seed decision alone for an error it does not recognize", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);
      runRecord = { ...RUN_RECORD, outcome: "error", error: "model refused" };

      await postTurn(base, THREAD, { intent: "ask", message: "one" });
      await expectSettled(projectDir, THREAD);

      const stored = await getSession(projectDir, THREAD);
      expect(stored.metadata?.threadInitialized).toBe(true);
      expect(stored.metadata?.run).not.toHaveProperty("errorCode");
    });
  });
});

// ---------------------------------------------------------------------------
// POST /turns — guards & validation
// ---------------------------------------------------------------------------

describe("POST /api/p/:slug/sessions/:id/turns — guards & validation", () => {
  it("rejects an empty message, a missing intent and an unknown intent with 400 INVALID_BODY", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      for (const body of [
        { intent: "ask", message: "" },
        { message: "no intent at all" },
        { intent: "native", message: "not an intent" },
        { intent: "bypass", message: "definitely not an intent" },
      ]) {
        const { status, envelope } = await postTurn(base, THREAD, body);
        expect({ body, status, code: envelope.code }).toEqual({
          body,
          status: 400,
          code: "INVALID_BODY",
        });
      }

      expect(capturedJobs).toHaveLength(0);
    });
  });

  it("rejects an unknown reference variant rather than coercing it", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      const { status, envelope } = await postTurn(base, THREAD, {
        intent: "ask",
        message: "bad ref",
        refs: [{ type: "screenshot", data: "…" }],
      });

      expect(status).toBe(400);
      expect(envelope.code).toBe("INVALID_BODY");
      expect(capturedJobs).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// POST /turns — write-back
// ---------------------------------------------------------------------------

describe("POST /api/p/:slug/sessions/:id/turns — write-back", () => {
  async function expectRunFinalized(
    projectDir: string,
    normalizedId: string,
    expected: Record<string, unknown>,
  ): Promise<void> {
    await vi.waitFor(async () => {
      const stored = await getSession(projectDir, normalizedId);
      expect(stored.metadata?.run).toMatchObject(expected);
    });
  }

  it("finalizes metadata.run with the intent as its mode", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      const { status } = await postTurn(base, THREAD, { intent: "change", message: "settle me" });
      expect(status).toBe(202);

      await expectRunFinalized(projectDir, THREAD, {
        pid: 4242,
        startedAt: 1_700_000_000_000,
        mode: "change",
        endedAt: 1_700_000_060_000,
        outcome: "success",
      });
    });
  });

  it("persists the runner's firstTokenAt and skippedLines onto metadata.run", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);
      // The write-back allowlist has to carry these through: time-to-first-token
      // (firstTokenAt - startedAt) and the wire-format drift counter are only
      // measurable after the fact if they reach disk.
      runRecord = { ...RUN_RECORD, firstTokenAt: 1_700_000_002_500, skippedLines: 3 };

      await postTurn(base, THREAD, { intent: "ask", message: "measure me" });

      await expectRunFinalized(projectDir, THREAD, {
        startedAt: 1_700_000_000_000,
        firstTokenAt: 1_700_000_002_500,
        skippedLines: 3,
      });
    });
  });

  it("omits firstTokenAt and skippedLines when the runner did not report them", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "quiet" });

      await expectRunFinalized(projectDir, THREAD, { outcome: "success" });
      const stored = await getSession(projectDir, THREAD);
      expect(stored.metadata?.run).not.toHaveProperty("firstTokenAt");
      expect(stored.metadata?.run).not.toHaveProperty("skippedLines");
    });
  });

  it("appends the captured reply on success, and nothing at all on error or timeout", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "ok" });
      await expectSettled(projectDir, THREAD);

      for (const outcome of ["error", "timeout"] as const) {
        runRecord = {
          ...RUN_RECORD,
          outcome,
          ...(outcome === "error" ? { error: "model refused" } : {}),
        };
        const { status } = await postTurn(base, THREAD, {
          intent: "ask",
          message: `fail as ${outcome}`,
        });
        expect(status).toBe(202);
        await expectSettled(projectDir, THREAD);
      }

      const turns = await readSessionTurns(projectDir, THREAD);
      expect(turns.map((t) => [t.type, t.text])).toEqual([
        ["user", "ok"],
        ["assistant", "reply"],
        ["user", "fail as error"],
        ["user", "fail as timeout"],
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// POST /turns — run claim + derived phase (W1)
// ---------------------------------------------------------------------------

describe("POST /api/p/:slug/sessions/:id/turns — run claim + derived phase (W1)", () => {
  /** A pid above every Linux/macOS pid_max — guaranteed not to be a process. */
  const DEAD_PID = 2_147_483_646;
  /** A pid that IS alive: the phase the route derives probes the claim's pid
   *  with signal 0, so a made-up number would read as a dead run. */
  const LIVE_PID = process.pid;
  /** The runner's default ceiling, which the mocked resolveTimeoutMs returns. */
  const TIMEOUT_MS = 600_000;

  /** Makes the fake runner spawn a run that never settles, so the spawn-time
   *  claim is observable instead of being released microseconds later. */
  function runNeverSettles(): void {
    vi.mocked(runClaudeJob).mockImplementation(async (input) => {
      capturedJobs.push(input);
      capturedOptions.push(undefined);
      return new Promise<ClaudeRunRecord>(() => {});
    });
  }

  it("claims the write-target at spawn with the child's pid, heartbeat and deadline", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runNeverSettles();
      vi.mocked(liveRunPid).mockReturnValue(LIVE_PID);
      await seedThread(projectDir, THREAD);
      const before = Date.now();

      const { status } = await postTurn(base, THREAD, { intent: "ask", message: "claim me" });
      expect(status).toBe(202);

      // The claim is what survives the server process that made it: without a
      // persisted run id + pid, a run interrupted by a restart would leave the
      // session reading running forever with nothing able to settle it.
      const claimed = await getSession(projectDir, THREAD);
      expect(claimed.currentRunId).toEqual(expect.any(String));
      expect(claimed.currentRunPid).toBe(LIVE_PID);
      expect(Date.parse(claimed.heartbeatAt ?? "")).toBeGreaterThanOrEqual(before);
      expect(claimed.metadata?.run).toMatchObject({ runId: claimed.currentRunId, pid: LIVE_PID });
      // The run's own deadline rides the claim (RUN_HEARTBEAT_TTL_MS cannot
      // express a timeout the caller/env chose), and the runner is armed with
      // exactly the same number.
      expect(claimed.metadata?.runDeadlineAt).toBeGreaterThanOrEqual(before + TIMEOUT_MS);
      expect(capturedJobs[0].timeoutMs).toBe(TIMEOUT_MS);
      expect((await getSessionView(base, THREAD)).phase).toBe("running");
    });
  });

  it("releases the claim at settle, keeping firstTokenAt/skippedLines on the run", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);
      runRecord = { ...RUN_RECORD, firstTokenAt: 1_700_000_002_500, skippedLines: 3 };

      const { status } = await postTurn(base, THREAD, { intent: "ask", message: "settle me" });
      expect(status).toBe(202);

      await vi.waitFor(async () => {
        const stored = await getSession(projectDir, THREAD);
        // settleSessionRun drops the claim and its proof of life together — a
        // heartbeat left behind would be evidence for a dead process.
        expect(stored.currentRunId).toBeUndefined();
        expect(stored.currentRunPid).toBeUndefined();
        expect(stored.heartbeatAt).toBeUndefined();
        expect(stored.metadata?.run).toMatchObject({
          runId: expect.any(String),
          mode: "ask",
          pid: 4242,
          startedAt: 1_700_000_000_000,
          endedAt: 1_700_000_060_000,
          outcome: "success",
          firstTokenAt: 1_700_000_002_500,
          skippedLines: 3,
        });
      });

      // A settled record holds no claim, so it reads idle — not running.
      const listed = await getSessions(base);
      expect(listed.find((s) => s.normalizedId === THREAD)?.phase).toBe("idle");
    });
  });

  it("derives idle for a live claim whose pid is gone, running while it is alive", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runNeverSettles();
      await seedThread(projectDir, THREAD);

      // The child died without the runner noticing (a killed pid, not an exit
      // the write-back saw): the claim still stands on disk, and only probing
      // its pid can tell that the run is gone.
      vi.mocked(liveRunPid).mockReturnValue(DEAD_PID);
      const { status } = await postTurn(base, THREAD, { intent: "ask", message: "kill me" });
      expect(status).toBe(202);

      const claimed = await getSession(projectDir, THREAD);
      expect(claimed.currentRunId).toEqual(expect.any(String));
      expect(claimed.currentRunPid).toBe(DEAD_PID);

      const listed = await getSessions(base);
      expect(listed.find((s) => s.normalizedId === THREAD)?.phase).toBe("idle");
      expect((await getSessionView(base, THREAD)).phase).toBe("idle");

      // Same record, same claim, a pid that IS alive — the phase follows the
      // process, never the stored status.
      vi.mocked(liveRunPid).mockReturnValue(process.pid);
      const second = await postTurn(base, THREAD, { intent: "ask", message: "keep me" });
      expect(second.status).toBe(202);
      expect((await getSessionView(base, THREAD)).phase).toBe("running");
    });
  });

  it("derives idle once a long run passes the deadline persisted with its claim", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runNeverSettles();
      vi.mocked(liveRunPid).mockReturnValue(LIVE_PID);
      await seedThread(projectDir, THREAD);

      const { status } = await postTurn(base, THREAD, { intent: "ask", message: "run long" });
      expect(status).toBe(202);
      expect((await getSessionView(base, THREAD)).phase).toBe("running");

      // Past its own deadline the runner has already SIGTERMed then SIGKILLed
      // the child, so the claim is no longer evidence of anything — even with a
      // live pid on the record.
      await updateSession(projectDir, {
        id: THREAD,
        metadata: { runDeadlineAt: Date.now() - 1_000 },
      });
      expect((await getSessionView(base, THREAD)).phase).toBe("idle");
    });
  });

  it("reports a phase for every session in the list, terminal status included", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const quiet = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_phase_idle",
        status: "idle",
      });
      const done = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_phase_done",
        status: "completed",
      });
      const failed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_phase_failed",
        status: "failed",
      });

      const phases = new Map((await getSessions(base)).map((s) => [s.normalizedId, s.phase]));
      expect(phases.get(quiet.normalizedId)).toBe("idle");
      expect(phases.get(done.normalizedId)).toBe("ended");
      expect(phases.get(failed.normalizedId)).toBe("failed");
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/p/:slug/sessions — what one read costs (W1)
// ---------------------------------------------------------------------------

describe("GET /api/p/:slug/sessions — what one read costs (W1)", () => {
  /** Makes the fake runner spawn a run that never settles, so the read below
   *  happens while the write-target still holds its claim. */
  function runNeverSettles(): void {
    vi.mocked(runClaudeJob).mockImplementation(async (input) => {
      capturedJobs.push(input);
      capturedOptions.push(undefined);
      return new Promise<ClaudeRunRecord>(() => {});
    });
  }

  it("spawns nothing when every record answers from its own evidence — run included", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runNeverSettles();
      vi.mocked(liveRunPid).mockReturnValue(process.pid);
      await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_cost_idle",
        status: "idle",
      });
      await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_cost_done",
        status: "completed",
      });
      await seedThread(projectDir, THREAD);

      // A live ARCS run: its claim is checked against the pid, so the agent list
      // has nothing to say about it — and this is exactly the moment the UI
      // polls hardest.
      const { status } = await postTurn(base, THREAD, {
        intent: "ask",
        message: "hold the claim",
      });
      expect(status).toBe(202);
      agentsProbe.spawns = 0;

      const listed = await getSessions(base);
      expect(listed.find((s) => s.normalizedId === THREAD)?.phase).toBe("running");
      expect((await getSessionView(base, "cc_cost_done")).phase).toBe("ended");
      expect((await getSessionView(base, THREAD)).phase).toBe("running");

      // Three reads, zero subprocesses: `claude agents --json` costs ~0.35s of
      // wall clock and answers a question none of these records asked.
      expect(agentsProbe.spawns).toBe(0);
    });
  });

  it("spawns exactly one probe per request when a record's phase hangs on it", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      // Two observed sessions checkpointed just now: both derive running with no
      // claim, which is the one branch that reads the agent list.
      const checkpointed: string[] = [];
      for (const id of ["cc_cost_live", "cc_cost_closed"]) {
        const created = await createSession(projectDir, {
          runtimeType: "claude-code",
          runtimeSessionId: id,
        });
        await updateSession(projectDir, {
          id: created.normalizedId,
          lastCheckpointAt: new Date().toISOString(),
        });
        checkpointed.push(created.normalizedId);
      }
      const [live, closed] = checkpointed;
      const done = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_cost_done_2",
        status: "completed",
      });
      agentsProbe.stdout = JSON.stringify([{ pid: 11, sessionId: "cc_cost_live" }]);
      agentsProbe.spawns = 0;

      const phases = new Map((await getSessions(base)).map((s) => [s.normalizedId, s.phase]));
      // One probe answered the whole index — never one per session.
      expect(agentsProbe.spawns).toBe(1);
      expect(phases.get(live)).toBe("running");
      // The probe worked and did not report it — an answer that DOES demote.
      expect(phases.get(closed)).toBe("idle");
      expect(phases.get(done.normalizedId)).toBe("ended");

      // The detail route pays the same single probe, not a per-session one.
      expect((await getSessionView(base, live)).phase).toBe("running");
      expect(agentsProbe.spawns).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// POST /turns — staged environment (W2, claude-code only)
// ---------------------------------------------------------------------------

describe("POST /api/p/:slug/sessions/:id/turns — staged environment (W2)", () => {
  const TASK_ID = "wire-the-staged-environment";

  /** A one-task DAG for the write target to be linked to. */
  function seedTask(projectDir: string): void {
    mkdirSync(resolve(projectDir, "tasks"), { recursive: true });
    writeFileSync(
      resolve(projectDir, "tasks", "index.json"),
      JSON.stringify({
        tasks: [
          {
            id: TASK_ID,
            normalizedId: TASK_ID,
            title: "Wire the staged environment into the turns route",
            status: "in_progress",
            priority: "high",
            scope: "src/web-server/routes/sessions.ts",
            acceptance: "the turns route stages, injects and persists",
            verify: "npm run typecheck",
            skill: "implementation",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf-8",
    );
  }

  /** The staged text the route appended to a captured job, if it appended one. */
  function stagedText(job: ClaudeJobInput): string | undefined {
    const at = job.argv.indexOf("--append-system-prompt");
    return at === -1 ? undefined : job.argv[at + 1];
  }

  /** The probe watermark as the filesystem reports it. Read back rather than
   *  computed from the Date handed to `utimesSync`: mtimeMs is a float and does
   *  not always round-trip the millisecond it was set from. */
  function taskIndexMtimeMs(projectDir: string): number {
    return statSync(resolve(projectDir, "tasks", "index.json")).mtimeMs;
  }

  /** `metadata.stage` as the store holds it — untyped on disk. */
  async function storedStage(
    projectDir: string,
    id: string,
  ): Promise<{ fingerprint?: string; stagedAt?: number; transport?: string } | undefined> {
    const stored = await getSession(projectDir, id);
    return stored.metadata?.stage as
      | { fingerprint?: string; stagedAt?: number; transport?: string }
      | undefined;
  }

  it("appends the block, stating the write target's DAG position and the spawn cwd", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      seedTask(projectDir);
      // The thread exists and is LINKED before its first turn — the block
      // describes the WRITE TARGET, so that is the record to link.
      await seedThread(projectDir, THREAD);
      await updateSession(projectDir, {
        id: THREAD,
        linkedNodeType: "task",
        linkedNodeId: TASK_ID,
      });

      const { status } = await postTurn(base, THREAD, { intent: "ask", message: "carry on" });
      expect(status).toBe(202);

      const text = stagedText(capturedJobs[0]) ?? "";
      expect(text.startsWith(STAGE_OPEN)).toBe(true);
      expect(text).toContain(`Linked node: task ${TASK_ID}`);
      expect(text).toContain("Acceptance: the turns route stages, injects and persists");
      // The workspace root is the directory the child ACTUALLY runs in.
      expect(text).toContain(`Workspace root: ${WORKSPACE}`);
      expect(capturedJobs[0].cwd).toBe(WORKSPACE);
    });
  });

  it("persists metadata.stage, stamped from the PROBE and not the wall clock", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      seedTask(projectDir);
      // An index mtime ahead of the wall clock — NFS, container skew, an
      // mtime-preserving restore. A Date.now() stamp would sit below it and the
      // cheap exit could never fire again.
      const ahead = new Date(Date.now() + 600_000);
      utimesSync(resolve(projectDir, "tasks", "index.json"), ahead, ahead);
      await seedThread(projectDir, THREAD);

      const { status } = await postTurn(base, THREAD, { intent: "ask", message: "stage me" });
      expect(status).toBe(202);

      const stage = await storedStage(projectDir, THREAD);
      expect(stage?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(stage?.transport).toBe("system");
      expect(stage?.stagedAt).toBe(taskIndexMtimeMs(projectDir));
      expect(stage?.stagedAt).toBeGreaterThan(Date.now());
      // The claim's own sibling keys are untouched by the stage write.
      const stored = await getSession(projectDir, THREAD);
      expect(stored.metadata?.runDeadlineAt).toBeTypeOf("number");
      expect(stored.metadata?.threadInitialized).toBe(true);
    });
  });

  it("writes metadata.stage ONLY when the refresh asks: a fresh stage is neither re-persisted nor re-injected", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      seedTask(projectDir);
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "one" });
      const first = await storedStage(projectDir, THREAD);
      expect(first?.stagedAt).toBeTypeOf("number");
      expect(stagedText(capturedJobs[0])).toContain(STAGE_OPEN);

      // Nothing in the DAG moved, and a resume CONTINUES the conversation that
      // already carries the block: no re-injection, and no re-stamp of the
      // record the next freshness decision is made against.
      await postTurn(base, THREAD, { intent: "ask", message: "two" });
      expect(stagedText(capturedJobs[1])).toBeUndefined();
      expect(await storedStage(projectDir, THREAD)).toEqual(first);

      // A DAG write does move it: the block is rebuilt, re-injected and
      // re-stamped in the same run.
      const later = new Date(Date.now() + 600_000);
      utimesSync(resolve(projectDir, "tasks", "index.json"), later, later);
      await postTurn(base, THREAD, { intent: "ask", message: "three" });
      expect(stagedText(capturedJobs[2])).toContain(STAGE_OPEN);
      const third = await storedStage(projectDir, THREAD);
      expect(third?.stagedAt).toBe(taskIndexMtimeMs(projectDir));
      expect(third?.stagedAt).toBeGreaterThan(first?.stagedAt ?? 0);
      expect(third?.fingerprint).toBe(first?.fingerprint);
    });
  });

  it("an opencode run carries no staged tier — the driver's argv is complete", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      seedTask(projectDir);
      await seedOpencodeThread(projectDir, THREAD);

      const { status } = await postTurn(base, THREAD, { intent: "ask", message: "carry on" });
      expect(status).toBe(202);

      expect(capturedJobs[0].argv).toEqual(["run", "--format", "json", "carry on"]);
      expect(stagedText(capturedJobs[0])).toBeUndefined();
      // No stage stamp either: the fingerprint describes a claude injection
      // that never happened.
      expect(await storedStage(projectDir, THREAD)).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// POST /turns — per-run event log + fold-down (W2, claude parser path)
// ---------------------------------------------------------------------------

describe("POST /api/p/:slug/sessions/:id/turns — per-run event log + fold-down (W2)", () => {
  function eventLogNames(projectDir: string): string[] {
    const dir = resolve(projectDir, "sessions");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".events.jsonl"))
      .sort();
  }

  /** The run id the record itself carries, once the run has settled. */
  async function settledRunId(projectDir: string, normalizedId: string): Promise<string> {
    let runId = "";
    await vi.waitFor(async () => {
      const stored = await getSession(projectDir, normalizedId);
      const run = stored.metadata?.run as { runId?: string; outcome?: string } | undefined;
      expect(run?.outcome).toBeTypeOf("string");
      expect(run?.runId).toBeTypeOf("string");
      runId = run?.runId as string;
    });
    return runId;
  }

  it("logs under the SAME run id it persisted as the claim, and answers with it", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runStdout = ndjson(assistantEvent(textBlock("hello")));
      await seedThread(projectDir, THREAD);

      const { status, envelope } = await postTurn(base, THREAD, { intent: "ask", message: "go" });
      expect(status).toBe(202);

      const runId = await settledRunId(projectDir, THREAD);
      // The id handed to the runner, the id on the record, the id in the
      // filename and the id in the 202 are one value — they cannot drift.
      expect(envelope.data?.runId).toBe(runId);
      expect(capturedJobs[0].eventLog?.runId).toBe(runId);
      expect(capturedJobs[0].eventLog?.sessionId).toBe(THREAD);
      expect(eventLogNames(projectDir)).toEqual([`${THREAD}.run-${runId}.events.jsonl`]);
      expect(existsSync(runEventLogPath(projectDir, THREAD, runId))).toBe(true);
    });
  });

  it("folds assistant text plus one turn per tool_use, and never doubles the reply", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runStdout = ndjson(
        { type: "system", subtype: "init" },
        assistantEvent(textBlock("Looking."), toolBlock("Read")),
        { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
        assistantEvent(textBlock("Done.")),
        { type: "result", is_error: false, result: "Done." },
      );
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "go" });
      const runId = await settledRunId(projectDir, THREAD);

      const turns = await readSessionTurns(projectDir, THREAD);
      expect(turns.map((t) => [t.id, t.type, t.text, t.tool?.name])).toEqual([
        [-1, "user", "go", undefined],
        [-2, "assistant", "Looking.", undefined],
        [-3, "assistant", "", "Read"],
        [-4, "assistant", "Done.", undefined],
      ]);
      // The captured replyText ("reply") is NOT appended on top of the fold.
      expect(turns.some((t) => t.text === "reply")).toBe(false);
      // Every folded turn is tagged with the run; the request-time user turn is not.
      expect(turns.map((t) => t.run)).toEqual([undefined, runId, runId, runId]);
    });
  });

  it("folding the settled log again is a no-op", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runStdout = ndjson(assistantEvent(textBlock("once"), toolBlock("Bash")));
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "go" });
      const runId = await settledRunId(projectDir, THREAD);
      const afterRun = await readSessionTurns(projectDir, THREAD);
      expect(afterRun.map((t) => t.text)).toEqual(["go", "once", ""]);

      // A second settle for the same run (a retry, a restart's sweep) folds
      // nothing: the sidecar already carries the run's own id.
      const again = await foldRunEventLog(projectDir, THREAD, runId);
      expect(again).toEqual({ appended: 0, alreadyFolded: true, assistantTextFolded: true });
      expect(await readSessionTurns(projectDir, THREAD)).toEqual(afterRun);
    });
  });

  it("an error outcome still folds the partial output the child produced", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runStdout = ndjson(assistantEvent(textBlock("got this far")));
      runRecord = { ...RUN_RECORD, outcome: "error", error: "model refused" };
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "go" });
      const runId = await settledRunId(projectDir, THREAD);

      // The log outlives the failure: what the child said is in the sidecar and
      // the raw log is still on disk for inspection.
      const turns = await readSessionTurns(projectDir, THREAD);
      expect(turns.map((t) => [t.type, t.text])).toEqual([
        ["user", "go"],
        ["assistant", "got this far"],
      ]);
      expect(existsSync(runEventLogPath(projectDir, THREAD, runId))).toBe(true);
    });
  });

  it("a timeout outcome keeps its log too", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runStdout = ndjson({ type: "system", subtype: "init" });
      runRecord = { ...RUN_RECORD, outcome: "timeout", error: "timed out" };
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "go" });
      const runId = await settledRunId(projectDir, THREAD);

      expect(existsSync(runEventLogPath(projectDir, THREAD, runId))).toBe(true);
      // Nothing assistant-shaped in the log, and a failed run appends no reply.
      const turns = await readSessionTurns(projectDir, THREAD);
      expect(turns.map((t) => t.type)).toEqual(["user"]);
    });
  });

  it("without a log the captured-reply write-back is unchanged", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runStdout = "";
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "go" });
      await settledRunId(projectDir, THREAD);

      const turns = await readSessionTurns(projectDir, THREAD);
      expect(turns.map((t) => [t.type, t.text])).toEqual([
        ["user", "go"],
        ["assistant", "reply"],
      ]);
      expect(eventLogNames(projectDir)).toEqual([]);
    });
  });

  it("prunes at settle so a session's logs stay bounded", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      await seedThread(projectDir, THREAD);

      const runs = RUN_EVENT_LOG_RETENTION + 3;
      for (let i = 0; i < runs; i += 1) {
        runStdout = ndjson(assistantEvent(textBlock(`turn ${i}`)));
        const { status } = await postTurn(base, THREAD, { intent: "ask", message: `run ${i}` });
        expect(status).toBe(202);
        // The claim is released at settle — and settle is where the prune runs.
        await expectSettled(projectDir, THREAD);
      }

      expect(capturedJobs).toHaveLength(runs);
      expect(eventLogNames(projectDir)).toHaveLength(RUN_EVENT_LOG_RETENTION);
      // The newest run's log is always one of the survivors.
      const newest = capturedJobs[runs - 1].eventLog?.runId as string;
      expect(existsSync(runEventLogPath(projectDir, THREAD, newest))).toBe(true);
      // Every turn still folded exactly once, oldest logs pruned or not.
      const turns = await readSessionTurns(projectDir, THREAD);
      expect(turns.filter((t) => t.text.startsWith("turn "))).toHaveLength(runs);
    });
  });

  it("carries eventLogTruncated onto metadata.run so a capped log is not read as complete", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      // What the runner reports for a child whose first chunk crossed the cap:
      // zero lines on disk — the same count a child that never spoke produces.
      runStdout = "";
      runRecord = { ...RUN_RECORD, eventLogLines: 0, eventLogTruncated: true };
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "go" });
      await settledRunId(projectDir, THREAD);

      const run = (await getSession(projectDir, THREAD)).metadata?.run as Record<string, unknown>;
      expect(run.eventLogLines).toBe(0);
      // Without this the record says "0 lines" and nothing else, and a later
      // offset-based tail would read a capped log as the whole stream.
      expect(run.eventLogTruncated).toBe(true);
    });
  });

  it("omits eventLogTruncated entirely when the log is whole", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runStdout = ndjson(assistantEvent(textBlock("all of it")));
      runRecord = { ...RUN_RECORD, eventLogLines: 1 };
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "go" });
      await settledRunId(projectDir, THREAD);

      const run = (await getSession(projectDir, THREAD)).metadata?.run as Record<string, unknown>;
      expect(run.eventLogLines).toBe(1);
      expect("eventLogTruncated" in run).toBe(false);
    });
  });

  it("DELETE takes the session's event logs with its sidecar", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runStdout = ndjson(assistantEvent(textBlock("bye")));
      await seedThread(projectDir, THREAD);

      await postTurn(base, THREAD, { intent: "ask", message: "go" });
      await settledRunId(projectDir, THREAD);
      expect(eventLogNames(projectDir)).toHaveLength(1);

      const res = await fetch(`${base}/api/p/demo/sessions/${THREAD}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() ?? "" },
      });
      expect(res.status).toBe(200);
      expect(eventLogNames(projectDir)).toEqual([]);
      expect(await readSessionTurns(projectDir, THREAD)).toEqual([]);
    });
  });
});
