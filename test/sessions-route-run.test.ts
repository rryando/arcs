/**
 * POST /api/p/:slug/sessions/:id/run — headless `claude -p` targeting modes.
 *
 * The runner module is faked with a vitest module mock (the route has no
 * injection point of its own) the same way the opencode tests fake the runtime
 * with a stub server: the mock records the exact argv/cwd/writeTargetKey handed
 * to runClaudeJob, fires the registered onSettled write-back with a canned run
 * record (simulating the runner's post-close settle), and resolves that record,
 * so the contract under test is what ARCS puts on the wire (mode selection,
 * write-targets, guards, sidecar ordering, mode-1 write-back) rather than the
 * runner's own lifecycle (covered by test/claude-runner.test.ts).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionTurns } from "../src/utils/claude-transcript.js";
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
  type ClaudeRunRecord,
  isRunLive,
  liveRunPid,
  runClaudeJob,
} from "../src/web-server/claude-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const WORKSPACE = "/work/demo";
/** A bare RFC-4122 v4 uuid — the only shape claude >= 2.x accepts on
 *  `--session-id`/`--resume` (the human-readable ARCS thread id is rejected). */
const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_RECORD: ClaudeRunRecord = {
  pid: 4242,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  outcome: "success",
  replyText: "reply",
};

/** A valid `reference` body for POST /run, per runClaudeMessageSchema. */
const REFERENCE = {
  section: {
    depth: 1,
    text: "The headless run appends the user turn before the reference.",
    id: "sec_1",
    startOffset: 120,
    endOffset: 220,
  },
  text: "User turn first, then the reference.",
  source: { kind: "knowledge", label: "session-bridge", doc: "docs/bridge.md", id: "k_1" },
} as const;

/** Jobs the (fake) runner was asked to spawn, in call order. */
let capturedJobs: ClaudeJobInput[] = [];
/** Record the fake runner settles each job with — tests override for error runs. */
let runRecord: ClaudeRunRecord = RUN_RECORD;

beforeEach(() => {
  capturedJobs = [];
  runRecord = RUN_RECORD;
  agentsProbe.spawns = 0;
  agentsProbe.stdout = "[]";
  vi.mocked(isRunLive).mockReturnValue(false);
  vi.mocked(liveRunPid).mockReturnValue(4242);
  vi.mocked(runClaudeJob).mockImplementation(async (input) => {
    capturedJobs.push(input);
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

interface RunEnvelope {
  ok: boolean;
  data?: {
    session?: SessionMeta;
    run?: { accepted: boolean; mode: string; threadId?: string };
  };
  code?: string;
  message?: string;
}

/** A session as the read routes answer it — the record plus its derived phase. */
interface SessionView extends SessionMeta {
  phase?: string;
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

async function postRun(base: string, id: string, body: unknown) {
  const res = await fetch(`${base}/api/p/demo/sessions/${id}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() ?? "" },
    body: JSON.stringify(body),
  });
  const envelope = (await res.json()) as RunEnvelope;
  return { status: res.status, envelope };
}

/** Waits until the out-of-band metadata.run registration lands on the session. */
async function expectRunRegistered(projectDir: string, normalizedId: string, mode: string) {
  await vi.waitFor(async () => {
    const stored = await getSession(projectDir, normalizedId);
    expect(stored.metadata?.run).toMatchObject({ pid: 4242, startedAt: 1_700_000_000_000, mode });
  });
}

describe("POST /api/p/:slug/sessions/:id/run — resume", () => {
  it("resumes an idle claude-code session in its own directory, answering 202", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_idle_1",
        status: "idle",
        metadata: { directory: WORKSPACE },
      });

      const { status, envelope } = await postRun(base, session.normalizedId, {
        mode: "resume",
        message: "carry on",
      });

      expect(status).toBe(202);
      expect(envelope.ok).toBe(true);
      expect(envelope.data?.session).toMatchObject({
        normalizedId: session.normalizedId,
        runtimeType: "claude-code",
      });
      expect(envelope.data?.run).toEqual({ accepted: true, mode: "resume" });

      expect(capturedJobs).toHaveLength(1);
      // toMatchObject: the job also carries the route-registered onSettled
      // write-back (T005 seam) alongside argv/cwd/writeTargetKey.
      expect(capturedJobs[0]).toMatchObject({
        argv: ["-p", "carry on", "--resume", "cc_idle_1", "--output-format", "json"],
        cwd: WORKSPACE,
        writeTargetKey: session.normalizedId,
      });

      await expectRunRegistered(projectDir, session.normalizedId, "resume");
      // Mode 1 never appends — the exit-time write-back (T005) owns the sidecar.
      expect(await readSessionTurns(projectDir, session.normalizedId)).toEqual([]);
    });
  });

  it("404s for a session the project does not have", async () => {
    await withRunRouteCtx(async ({ base }) => {
      const { status, envelope } = await postRun(base, "missing-session", {
        mode: "resume",
        message: "hi",
      });

      expect(status).toBe(404);
      expect(envelope.code).toBe("ITEM_NOT_FOUND");
      expect(capturedJobs).toHaveLength(0);
    });
  });

  it("400s when the referenced session is not a claude-code session", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "opencode",
        runtimeSessionId: "ses_live",
      });

      const { status, envelope } = await postRun(base, session.normalizedId, {
        mode: "resume",
        message: "resume me",
      });

      expect(status).toBe(400);
      expect(envelope.code).toBe("CLAUDE_RUN_TARGET_INVALID");
      expect(capturedJobs).toHaveLength(0);
    });
  });

  it("409s when the claude-code session is still active", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_active_1",
        status: "active",
      });

      const { status, envelope } = await postRun(base, session.normalizedId, {
        mode: "resume",
        message: "resume me",
      });

      expect(status).toBe(409);
      expect(envelope.code).toBe("CLAUDE_SESSION_ACTIVE");
      expect(capturedJobs).toHaveLength(0);
    });
  });

  it("falls back to the primary workspace when the session has no directory", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_nodir_1",
        status: "idle",
      });

      const { status } = await postRun(base, session.normalizedId, {
        mode: "resume",
        message: "from the workspace",
      });

      expect(status).toBe(202);
      expect(capturedJobs[0].cwd).toBe(WORKSPACE);
    });
  });
});

describe("POST /api/p/:slug/sessions/:id/run — oneshot", () => {
  it("targets the deterministic arcs-oneshot-<slug> session, recreated idempotently", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_seed_1",
      });

      const first = await postRun(base, seed.normalizedId, {
        mode: "oneshot",
        message: "summarize",
      });
      expect(first.status).toBe(202);
      expect(first.envelope.ok).toBe(true);
      expect(first.envelope.data?.session?.normalizedId).toBe("arcs-oneshot-demo");
      expect(first.envelope.data?.session?.runtimeSessionId).toBe("arcs-oneshot-demo");
      expect(first.envelope.data?.session?.metadata).toMatchObject({
        control: "arcs-owned",
        directory: WORKSPACE,
      });
      expect(first.envelope.data?.run).toEqual({ accepted: true, mode: "oneshot" });

      expect(capturedJobs[0]).toMatchObject({
        argv: ["-p", "summarize", "--output-format", "json"],
        cwd: WORKSPACE,
        writeTargetKey: "arcs-oneshot-demo",
      });
      await expectRunRegistered(projectDir, "arcs-oneshot-demo", "oneshot");

      // A second call re-creates the same deterministic record — never a dup.
      const second = await postRun(base, seed.normalizedId, {
        mode: "oneshot",
        message: "again",
      });
      expect(second.status).toBe(202);
      expect(second.envelope.data?.session?.normalizedId).toBe("arcs-oneshot-demo");
      expect(capturedJobs).toHaveLength(2);
      expect(capturedJobs[1].argv).toEqual(["-p", "again", "--output-format", "json"]);

      const all = await listSessions(projectDir);
      expect(all.filter((s) => s.runtimeSessionId === "arcs-oneshot-demo")).toHaveLength(1);
    });
  });

  it("appends the user turn then the reference to the sidecar (shared negative id space)", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_seed_2",
      });

      const { status, envelope } = await postRun(base, seed.normalizedId, {
        mode: "oneshot",
        message: "point me at the doc",
        reference: REFERENCE,
      });

      expect(status).toBe(202);
      expect(envelope.ok).toBe(true);

      // Delivery-first ordering: the user turn lands before the reference, both
      // in the shared negative id space minted by T002; the success settle then
      // appends the captured reply as the assistant turn after the reference.
      await vi.waitFor(async () => {
        const turns = await readSessionTurns(projectDir, "arcs-oneshot-demo");
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

  it("appends the user turn and the success reply when no reference is supplied", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_seed_3",
      });

      const { status } = await postRun(base, seed.normalizedId, {
        mode: "oneshot",
        message: "plain",
      });
      expect(status).toBe(202);

      await vi.waitFor(async () => {
        const turns = await readSessionTurns(projectDir, "arcs-oneshot-demo");
        expect(turns).toHaveLength(2);
        expect(turns[0]).toMatchObject({ id: -1, type: "user", text: "plain" });
        expect(turns[1]).toMatchObject({ id: -2, type: "assistant", text: "reply" });
      });
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
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_seed_4",
      });

      const { status, envelope } = await postRun(base, seed.normalizedId, {
        mode: "oneshot",
        message: "where do I run?",
      });

      expect(status).toBe(400);
      expect(envelope.code).toBe("PROJECT_WORKSPACE_UNSET");
      expect(capturedJobs).toHaveLength(0);
    });
  });
});

describe("POST /api/p/:slug/sessions/:id/run — stable", () => {
  it("mints arcs-thread-<slug>-<uuid4> once, then resumes it on later spawns", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_seed_5",
      });

      const first = await postRun(base, seed.normalizedId, {
        mode: "stable",
        message: "start the thread",
      });
      expect(first.status).toBe(202);
      expect(first.envelope.ok).toBe(true);

      const threadId = first.envelope.data?.run?.threadId;
      expect(threadId).toMatch(
        /^arcs-thread-demo-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(first.envelope.data?.session?.runtimeSessionId).toBe(threadId);
      expect(first.envelope.data?.session?.metadata).toMatchObject({
        control: "arcs-owned",
        directory: WORKSPACE,
      });
      expect(first.envelope.data?.run).toEqual({ accepted: true, mode: "stable", threadId });

      // The ARCS thread id names the record (picker label + sidecar filename);
      // claude only ever sees the bare uuid minted onto metadata.
      const threadSession = (await listSessions(projectDir)).find(
        (s) => s.runtimeSessionId === threadId,
      );
      expect(threadSession).toBeDefined();
      const claudeSessionId = threadSession?.metadata?.claudeSessionId as string;
      expect(claudeSessionId).toMatch(BARE_UUID);

      // First spawn seeds the thread with --session-id <bare uuid> only.
      expect(capturedJobs[0].argv).toEqual([
        "-p",
        "start the thread",
        "--session-id",
        claudeSessionId,
        "--output-format",
        "json",
      ]);
      expect(capturedJobs[0].writeTargetKey).toBe(threadId);

      // The first successful spawn marks the thread initialized.
      await vi.waitFor(async () => {
        const stored = await getSession(projectDir, threadSession?.normalizedId ?? "");
        expect(stored.metadata?.threadInitialized).toBe(true);
      });

      // A second run against the SAME arcs-owned thread reuses it and resumes.
      const second = await postRun(base, threadSession?.normalizedId ?? "", {
        mode: "stable",
        message: "continue",
      });
      expect(second.status).toBe(202);
      expect(second.envelope.data?.run?.threadId).toBe(threadId);
      // Later spawns continue the same uuid with --resume ALONE: claude >= 2.x
      // refuses --session-id alongside --resume.
      expect(capturedJobs[1].argv).toEqual([
        "-p",
        "continue",
        "--resume",
        claudeSessionId,
        "--output-format",
        "json",
      ]);
      expect(capturedJobs[1].argv).not.toContain("--session-id");

      // The conversation accumulates in the one sidecar, in order: each run's
      // user turn (request-time append) followed by the success assistant reply
      // (T006 write-back), both in the shared negative id space.
      await vi.waitFor(async () => {
        const turns = await readSessionTurns(projectDir, threadSession?.normalizedId ?? "");
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

  it("honors a payload threadId for a non-arcs-owned referenced session", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const external = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_ext_1",
      });

      const { status, envelope } = await postRun(base, external.normalizedId, {
        mode: "stable",
        message: "use this thread",
        threadId: "cc_ext_1",
      });

      expect(status).toBe(202);
      expect(envelope.data?.run?.threadId).toBe("cc_ext_1");

      // The referenced session becomes the ARCS-owned write-target.
      const claimed = await getSession(projectDir, external.normalizedId);
      expect(claimed.metadata).toMatchObject({ control: "arcs-owned", directory: WORKSPACE });

      // A payload threadId names the ARCS thread record only — it gets its own
      // minted claude uuid rather than being passed through as a session id
      // (attaching to an external session's real thread is mode=resume's job).
      const claudeSessionId = claimed.metadata?.claudeSessionId as string;
      expect(claudeSessionId).toMatch(BARE_UUID);
      expect(claudeSessionId).not.toBe("cc_ext_1");
      expect(capturedJobs[0].argv).toEqual([
        "-p",
        "use this thread",
        "--session-id",
        claudeSessionId,
        "--output-format",
        "json",
      ]);
    });
  });

  it("mints the claude uuid once, persists it on metadata, and reuses it on later sends", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_seed_uuid",
      });

      const first = await postRun(base, seed.normalizedId, { mode: "stable", message: "one" });
      expect(first.status).toBe(202);
      const threadId = first.envelope.data?.run?.threadId as string;

      const seeded = await getSession(projectDir, threadId);
      const claudeSessionId = seeded.metadata?.claudeSessionId as string;
      expect(claudeSessionId).toMatch(BARE_UUID);
      // Two independent identities: the ARCS thread id carries its own uuid.
      expect(claudeSessionId).not.toBe(threadId);
      expect(threadId).not.toContain(claudeSessionId);

      await vi.waitFor(async () => {
        const stored = await getSession(projectDir, threadId);
        expect(stored.metadata?.threadInitialized).toBe(true);
      });

      const second = await postRun(base, threadId, { mode: "stable", message: "two" });
      expect(second.status).toBe(202);
      expect(second.envelope.data?.run?.threadId).toBe(threadId);

      // The uuid is minted exactly once: the re-upsert merges shallowly, so the
      // persisted claudeSessionId (and threadInitialized) survive untouched.
      const afterSecond = await getSession(projectDir, threadId);
      expect(afterSecond.metadata?.claudeSessionId).toBe(claudeSessionId);
      expect(afterSecond.metadata?.threadInitialized).toBe(true);
      expect(capturedJobs[1].argv).toEqual([
        "-p",
        "two",
        "--resume",
        claudeSessionId,
        "--output-format",
        "json",
      ]);

      // A third send keeps resuming the same uuid — never re-seeding it
      // (claude answers "already in use" when --session-id names a known id).
      const third = await postRun(base, threadId, { mode: "stable", message: "three" });
      expect(third.status).toBe(202);
      expect(capturedJobs[2].argv).toEqual([
        "-p",
        "three",
        "--resume",
        claudeSessionId,
        "--output-format",
        "json",
      ]);
      const afterThird = await getSession(projectDir, threadId);
      expect(afterThird.metadata?.claudeSessionId).toBe(claudeSessionId);
    });
  });
});

describe("POST /api/p/:slug/sessions/:id/run — guards & validation", () => {
  it("409s an overlapping run on the same write-target before appending or spawning", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_seed_6",
      });
      vi.mocked(isRunLive).mockReturnValue(true);

      const { status, envelope } = await postRun(base, seed.normalizedId, {
        mode: "oneshot",
        message: "busy?",
      });

      expect(status).toBe(409);
      expect(envelope.code).toBe("CLAUDE_RUN_IN_PROGRESS");
      expect(capturedJobs).toHaveLength(0);
      expect(await readSessionTurns(projectDir, "arcs-oneshot-demo")).toEqual([]);
    });
  });

  it("rejects an empty message and an unknown mode with 400 INVALID_BODY", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_seed_7",
      });

      const empty = await postRun(base, seed.normalizedId, { mode: "oneshot", message: "" });
      expect(empty.status).toBe(400);
      expect(empty.envelope.code).toBe("INVALID_BODY");

      const badMode = await postRun(base, seed.normalizedId, {
        mode: "interactive",
        message: "hi",
      });
      expect(badMode.status).toBe(400);
      expect(badMode.envelope.code).toBe("INVALID_BODY");

      expect(capturedJobs).toHaveLength(0);
    });
  });
});

describe("POST /api/p/:slug/sessions/:id/run — mode-1 write-back (T005)", () => {
  /** Writes a Claude Code JSONL transcript with a noise line at index 2, so the
   *  mirrored ids prove they are absolute line indices, not sequential turns. */
  function writeFakeTranscript(projectDir: string): string {
    const transcriptPath = resolve(projectDir, "fake-transcript.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          message: { content: "first prompt" },
          timestamp: "2026-08-04T00:00:00.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "first reply" }] },
          timestamp: "2026-08-04T00:00:01.000Z",
        }),
        JSON.stringify({
          type: "mode",
          message: { mode: "plan" },
          timestamp: "2026-08-04T00:00:02.000Z",
        }),
        JSON.stringify({
          type: "user",
          message: { content: "second prompt" },
          timestamp: "2026-08-04T00:00:03.000Z",
        }),
        "",
      ].join("\n"),
      "utf-8",
    );
    return transcriptPath;
  }

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

  it("resume: mirrors the persisted transcript after the run settles (ids = line indices)", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const transcriptPath = writeFakeTranscript(projectDir);
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_wb_resume_1",
        status: "idle",
        metadata: { directory: WORKSPACE, transcriptPath },
      });

      const { status } = await postRun(base, session.normalizedId, {
        mode: "resume",
        message: "carry on",
      });
      expect(status).toBe(202);

      // The exit-time write-back mirrors transcript lines by absolute index —
      // the noise line at index 2 is skipped, ids stay 0/1/3.
      await vi.waitFor(async () => {
        const turns = await readSessionTurns(projectDir, session.normalizedId);
        expect(turns.map((t) => t.id)).toEqual([0, 1, 3]);
        expect(turns.map((t) => t.text)).toEqual(["first prompt", "first reply", "second prompt"]);
      });

      await expectRunFinalized(projectDir, session.normalizedId, {
        pid: 4242,
        startedAt: 1_700_000_000_000,
        mode: "resume",
        endedAt: 1_700_000_060_000,
        outcome: "success",
      });
    });
  });

  it("resume with an absent transcriptPath is a no-op — no sidecar, run still finalized", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_wb_resume_2",
        status: "idle",
        metadata: { directory: WORKSPACE },
      });

      const { status } = await postRun(base, session.normalizedId, {
        mode: "resume",
        message: "carry on",
      });
      expect(status).toBe(202);

      await expectRunFinalized(projectDir, session.normalizedId, {
        mode: "resume",
        endedAt: 1_700_000_060_000,
        outcome: "success",
      });
      expect(await readSessionTurns(projectDir, session.normalizedId)).toEqual([]);
    });
  });

  it("resume on an error exit still mirrors the partial transcript and finalizes the error", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const transcriptPath = writeFakeTranscript(projectDir);
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_wb_resume_3",
        status: "idle",
        metadata: { directory: WORKSPACE, transcriptPath },
      });

      runRecord = { ...RUN_RECORD, outcome: "error", error: "model refused" };

      const { status } = await postRun(base, session.normalizedId, {
        mode: "resume",
        message: "carry on",
      });
      expect(status).toBe(202);

      // The mirror must run even on error — the runtime transcript may hold
      // partial lines and they still land in the sidecar.
      await vi.waitFor(async () => {
        const turns = await readSessionTurns(projectDir, session.normalizedId);
        expect(turns.map((t) => t.id)).toEqual([0, 1, 3]);
      });
      await expectRunFinalized(projectDir, session.normalizedId, {
        mode: "resume",
        outcome: "error",
        error: "model refused",
        endedAt: 1_700_000_060_000,
      });
    });
  });

  it("persists the runner's firstTokenAt and skippedLines onto metadata.run", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_wb_ttft_1",
        status: "idle",
        metadata: { directory: WORKSPACE },
      });

      // The write-back allowlist has to carry these through: time-to-first-token
      // (firstTokenAt - startedAt) and the wire-format drift counter are only
      // measurable after the fact if they reach disk.
      runRecord = { ...RUN_RECORD, firstTokenAt: 1_700_000_002_500, skippedLines: 3 };

      const { status } = await postRun(base, session.normalizedId, {
        mode: "resume",
        message: "carry on",
      });
      expect(status).toBe(202);

      await expectRunFinalized(projectDir, session.normalizedId, {
        startedAt: 1_700_000_000_000,
        firstTokenAt: 1_700_000_002_500,
        skippedLines: 3,
      });
    });
  });

  it("omits firstTokenAt and skippedLines when the runner did not report them", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_wb_ttft_2",
        status: "idle",
        metadata: { directory: WORKSPACE },
      });

      const { status } = await postRun(base, session.normalizedId, {
        mode: "resume",
        message: "carry on",
      });
      expect(status).toBe(202);

      await expectRunFinalized(projectDir, session.normalizedId, { outcome: "success" });
      const stored = await getSession(projectDir, session.normalizedId);
      expect(stored.metadata?.run).not.toHaveProperty("firstTokenAt");
      expect(stored.metadata?.run).not.toHaveProperty("skippedLines");
    });
  });

  it("repeated write-backs never duplicate — the mirror is offset-idempotent", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const transcriptPath = writeFakeTranscript(projectDir);
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_wb_resume_4",
        status: "idle",
        metadata: { directory: WORKSPACE, transcriptPath },
      });

      const first = await postRun(base, session.normalizedId, { mode: "resume", message: "one" });
      expect(first.status).toBe(202);
      const second = await postRun(base, session.normalizedId, { mode: "resume", message: "two" });
      expect(second.status).toBe(202);

      // Both write-backs mirror the same transcript — the second must no-op.
      await vi.waitFor(async () => {
        const turns = await readSessionTurns(projectDir, session.normalizedId);
        expect(turns.map((t) => t.id)).toEqual([0, 1, 3]);
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const turns = await readSessionTurns(projectDir, session.normalizedId);
      expect(turns.map((t) => t.id)).toEqual([0, 1, 3]);
    });
  });

  it("oneshot never mirrors — user turn plus success assistant reply, metadata.run finalized only", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_wb_oneshot_5",
      });

      const { status } = await postRun(base, seed.normalizedId, {
        mode: "oneshot",
        message: "summarize",
      });
      expect(status).toBe(202);

      await expectRunFinalized(projectDir, "arcs-oneshot-demo", {
        mode: "oneshot",
        endedAt: 1_700_000_060_000,
        outcome: "success",
      });
      // No mirrored lines — the negative-id user turn and the success assistant
      // reply are both appendSessionTurn-owned (T006).
      const turns = await readSessionTurns(projectDir, "arcs-oneshot-demo");
      expect(turns.map((t) => t.id)).toEqual([-1, -2]);
    });
  });

  it("stable never mirrors — user turn plus success assistant reply, metadata.run finalized only", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_wb_stable_6",
      });

      const { status, envelope } = await postRun(base, seed.normalizedId, {
        mode: "stable",
        message: "start the thread",
      });
      expect(status).toBe(202);
      const threadId = envelope.data?.run?.threadId as string;

      await expectRunFinalized(projectDir, threadId, {
        mode: "stable",
        endedAt: 1_700_000_060_000,
        outcome: "success",
      });
      const turns = await readSessionTurns(projectDir, threadId);
      expect(turns.map((t) => t.id)).toEqual([-1, -2]);
    });
  });
});

describe("POST /api/p/:slug/sessions/:id/run — run claim + derived phase (W1)", () => {
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
      return new Promise<ClaudeRunRecord>(() => {});
    });
  }

  it("claims the write-target at spawn with the child's pid, heartbeat and deadline", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runNeverSettles();
      vi.mocked(liveRunPid).mockReturnValue(LIVE_PID);
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_claim_1",
      });
      const before = Date.now();

      const { status } = await postRun(base, seed.normalizedId, {
        mode: "oneshot",
        message: "claim me",
      });
      expect(status).toBe(202);

      // The claim is what survives the server process that made it: without a
      // persisted run id + pid, a run interrupted by a restart would leave the
      // session reading running forever with nothing able to settle it.
      const claimed = await getSession(projectDir, "arcs-oneshot-demo");
      expect(claimed.currentRunId).toEqual(expect.any(String));
      expect(claimed.currentRunPid).toBe(LIVE_PID);
      expect(Date.parse(claimed.heartbeatAt ?? "")).toBeGreaterThanOrEqual(before);
      expect(claimed.metadata?.run).toMatchObject({ runId: claimed.currentRunId, pid: LIVE_PID });
      // The run's own deadline rides the claim (RUN_HEARTBEAT_TTL_MS cannot
      // express a timeout the caller/env chose), and the runner is armed with
      // exactly the same number.
      expect(claimed.metadata?.runDeadlineAt).toBeGreaterThanOrEqual(before + TIMEOUT_MS);
      expect(capturedJobs[0].timeoutMs).toBe(TIMEOUT_MS);
      expect((await getSessionView(base, "arcs-oneshot-demo")).phase).toBe("running");
    });
  });

  it("releases the claim at settle, keeping firstTokenAt/skippedLines on the run", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_claim_2",
      });
      runRecord = { ...RUN_RECORD, firstTokenAt: 1_700_000_002_500, skippedLines: 3 };

      const { status } = await postRun(base, seed.normalizedId, {
        mode: "oneshot",
        message: "settle me",
      });
      expect(status).toBe(202);

      await vi.waitFor(async () => {
        const stored = await getSession(projectDir, "arcs-oneshot-demo");
        // settleSessionRun drops the claim and its proof of life together — a
        // heartbeat left behind would be evidence for a dead process.
        expect(stored.currentRunId).toBeUndefined();
        expect(stored.currentRunPid).toBeUndefined();
        expect(stored.heartbeatAt).toBeUndefined();
        expect(stored.metadata?.run).toMatchObject({
          runId: expect.any(String),
          mode: "oneshot",
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
      expect(listed.find((s) => s.normalizedId === "arcs-oneshot-demo")?.phase).toBe("idle");
    });
  });

  it("derives idle for a live claim whose pid is gone, running while it is alive", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runNeverSettles();
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_claim_3",
      });

      // The child died without the runner noticing (a killed pid, not an exit
      // the write-back saw): the claim still stands on disk, and only probing
      // its pid can tell that the run is gone.
      vi.mocked(liveRunPid).mockReturnValue(DEAD_PID);
      const { status } = await postRun(base, seed.normalizedId, {
        mode: "oneshot",
        message: "kill me",
      });
      expect(status).toBe(202);

      const claimed = await getSession(projectDir, "arcs-oneshot-demo");
      expect(claimed.currentRunId).toEqual(expect.any(String));
      expect(claimed.currentRunPid).toBe(DEAD_PID);

      const listed = await getSessions(base);
      expect(listed.find((s) => s.normalizedId === "arcs-oneshot-demo")?.phase).toBe("idle");
      expect((await getSessionView(base, "arcs-oneshot-demo")).phase).toBe("idle");

      // Same record, same claim, a pid that IS alive — the phase follows the
      // process, never the stored status.
      vi.mocked(liveRunPid).mockReturnValue(process.pid);
      const second = await postRun(base, seed.normalizedId, {
        mode: "oneshot",
        message: "keep me",
      });
      expect(second.status).toBe(202);
      expect((await getSessionView(base, "arcs-oneshot-demo")).phase).toBe("running");
    });
  });

  it("derives idle once a long run passes the deadline persisted with its claim", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runNeverSettles();
      vi.mocked(liveRunPid).mockReturnValue(LIVE_PID);
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_claim_4",
      });

      const { status } = await postRun(base, seed.normalizedId, {
        mode: "oneshot",
        message: "run long",
      });
      expect(status).toBe(202);
      expect((await getSessionView(base, "arcs-oneshot-demo")).phase).toBe("running");

      // Past its own deadline the runner has already SIGTERMed then SIGKILLed
      // the child, so the claim is no longer evidence of anything — even with a
      // live pid on the record.
      await updateSession(projectDir, {
        id: "arcs-oneshot-demo",
        metadata: { runDeadlineAt: Date.now() - 1_000 },
      });
      expect((await getSessionView(base, "arcs-oneshot-demo")).phase).toBe("idle");
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

describe("GET /api/p/:slug/sessions — what one read costs (W1)", () => {
  /** Makes the fake runner spawn a run that never settles, so the read below
   *  happens while the write-target still holds its claim. */
  function runNeverSettles(): void {
    vi.mocked(runClaudeJob).mockImplementation(async (input) => {
      capturedJobs.push(input);
      return new Promise<ClaudeRunRecord>(() => {});
    });
  }

  it("spawns nothing when every record answers from its own evidence — run included", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      runNeverSettles();
      vi.mocked(liveRunPid).mockReturnValue(process.pid);
      const quiet = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_cost_idle",
        status: "idle",
      });
      await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_cost_done",
        status: "completed",
      });

      // A live ARCS run: its claim is checked against the pid, so the agent list
      // has nothing to say about it — and this is exactly the moment the UI
      // polls hardest.
      const { status } = await postRun(base, quiet.normalizedId, {
        mode: "oneshot",
        message: "hold the claim",
      });
      expect(status).toBe(202);
      agentsProbe.spawns = 0;

      const listed = await getSessions(base);
      expect(listed.find((s) => s.normalizedId === "arcs-oneshot-demo")?.phase).toBe("running");
      expect((await getSessionView(base, "cc_cost_done")).phase).toBe("ended");
      expect((await getSessionView(base, "arcs-oneshot-demo")).phase).toBe("running");

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

describe("POST /api/p/:slug/sessions/:id/run — assistant reply write-back (T006)", () => {
  it("oneshot success settles the captured reply as the assistant turn", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_reply_oneshot_success",
      });

      const { status } = await postRun(base, seed.normalizedId, {
        mode: "oneshot",
        message: "reply to me",
      });
      expect(status).toBe(202);

      // Every reply lands in the sidecar: user turn id -1, then the assistant
      // reply minted at id -2 by the T002 shared negative-id helper.
      await vi.waitFor(async () => {
        const turns = await readSessionTurns(projectDir, "arcs-oneshot-demo");
        expect(turns.map((t) => t.id)).toEqual([-1, -2]);
        expect(turns.map((t) => t.type)).toEqual(["user", "assistant"]);
        expect(turns[1]).toMatchObject({ type: "assistant", text: "reply" });
      });
    });
  });

  it("oneshot error and timeout outcomes never append the assistant turn", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_reply_oneshot_fail",
      });

      for (const outcome of ["error", "timeout"] as const) {
        runRecord = {
          ...RUN_RECORD,
          outcome,
          ...(outcome === "error" ? { error: "model refused" } : {}),
        };
        const { status } = await postRun(base, seed.normalizedId, {
          mode: "oneshot",
          message: `fail as ${outcome}`,
        });
        expect(status).toBe(202);
      }

      // Only the two request-time user turns land — failed runs append nothing.
      await vi.waitFor(async () => {
        const turns = await readSessionTurns(projectDir, "arcs-oneshot-demo");
        expect(turns.map((t) => t.id)).toEqual([-1, -2]);
        expect(turns.map((t) => t.type)).toEqual(["user", "user"]);
      });
    });
  });

  it("stable error outcome never appends the assistant turn", async () => {
    await withRunRouteCtx(async ({ base, projectDir }) => {
      const seed = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_reply_stable_fail",
      });

      runRecord = { ...RUN_RECORD, outcome: "error", error: "model refused" };
      const { status, envelope } = await postRun(base, seed.normalizedId, {
        mode: "stable",
        message: "start",
      });
      expect(status).toBe(202);
      const threadId = envelope.data?.run?.threadId as string;

      await vi.waitFor(async () => {
        const turns = await readSessionTurns(projectDir, threadId);
        expect(turns.map((t) => t.id)).toEqual([-1]);
        expect(turns.map((t) => t.type)).toEqual(["user"]);
      });
    });
  });
});
