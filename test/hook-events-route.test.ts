/**
 * Claude Code hook endpoint tests.
 *
 * Stands in for the hook script: every case is the exact HTTP request
 * `scripts/claude-code-session-hook.mjs` puts on the wire for a given stdin
 * event, so the server contract is verified without a live Claude Code session.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { writeHookToken } from "../src/utils/hook-token-store.js";
import { createPlan } from "../src/utils/plan-store.js";
import {
  createSession,
  deriveSessionPhase,
  enqueueSessionMessage,
  getSession,
  listSessions,
  updateSession,
} from "../src/utils/session-store.js";
import { createTask, deleteTask } from "../src/utils/task-store.js";
import { startWebServer, type WebServerHandle } from "../src/web-server/index.js";
import { SESSION_START_STAGE_CAP } from "../src/web-server/routes/hook-events.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const TOKEN = "test-hook-token-0123456789";

interface Ctx {
  base: string;
  projectDir: string;
}

interface HookEnvelope {
  ok: boolean;
  data?: { sessionId: string; queuedMessages: string[]; stagedContext?: string };
  code?: string;
  message?: string;
}

async function withHookCtx(run: (ctx: Ctx) => Promise<void>): Promise<void> {
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
        workspacePaths: [],
      }),
      "utf-8",
    );
    await writeHookToken(projectDir, TOKEN);

    let server: WebServerHandle | null = null;
    try {
      server = await startWebServer({ port: 0, host: "127.0.0.1", watch: false });
      await run({ base: server.url, projectDir });
    } finally {
      await server?.close();
    }
  });
}

async function postEvent(
  base: string,
  body: unknown,
  options: { token?: string | null; slug?: string } = {},
) {
  const token = options.token === undefined ? TOKEN : options.token;
  const res = await fetch(`${base}/api/hook/${options.slug ?? "demo"}/event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, envelope: (await res.json()) as HookEnvelope };
}

describe("POST /api/hook/:slug/event — token gate", () => {
  it("rejects a request with no Authorization header", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const { status, envelope } = await postEvent(
        base,
        { hook_event_name: "SessionStart", session_id: "cc-1" },
        { token: null },
      );

      expect(status).toBe(401);
      expect(envelope.code).toBe("hook_unauthorized");
      expect(await listSessions(projectDir)).toHaveLength(0);
    });
  });

  it("rejects a wrong token", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const { status } = await postEvent(
        base,
        { hook_event_name: "SessionStart", session_id: "cc-1" },
        { token: "not-the-token-000000000000" },
      );

      expect(status).toBe(401);
      expect(await listSessions(projectDir)).toHaveLength(0);
    });
  });

  it("rejects a non-Bearer scheme", async () => {
    await withHookCtx(async ({ base }) => {
      const res = await fetch(`${base}/api/hook/demo/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${TOKEN}` },
        body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "cc-1" }),
      });
      expect(res.status).toBe(401);
    });
  });

  it("answers 401 (not 404) for an unknown project so slugs cannot be probed", async () => {
    await withHookCtx(async ({ base }) => {
      const { status, envelope } = await postEvent(
        base,
        { hook_event_name: "SessionStart", session_id: "cc-1" },
        { slug: "nosuchproject" },
      );

      expect(status).toBe(401);
      expect(envelope.code).toBe("hook_unauthorized");
    });
  });

  it("still enforces the global loopback guard on top of the token", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const res = await fetch(`${base}/api/hook/demo/event`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          Origin: "https://evil.example.com",
        },
        body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "cc-1" }),
      });

      // Two layers, both mandatory: a valid token does not buy past the
      // cross-site check.
      expect(res.status).toBe(403);
      expect(await listSessions(projectDir)).toHaveLength(0);
    });
  });
});

describe("POST /api/hook/:slug/event — session lifecycle", () => {
  it("registers a claude-code session on SessionStart", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const { status, envelope } = await postEvent(base, {
        hook_event_name: "SessionStart",
        session_id: "3f1a2b4c-0000-4000-8000-000000000001",
        cwd: "/work/demo",
        source: "startup",
      });

      expect(status).toBe(200);
      expect(envelope.data?.queuedMessages).toEqual([]);

      const session = await getSession(projectDir, envelope.data?.sessionId ?? "");
      expect(session.runtimeType).toBe("claude-code");
      expect(session.runtimeSessionId).toBe("3f1a2b4c-0000-4000-8000-000000000001");
      expect(session.status).toBe("active");
      expect(session.metadata).toEqual({ directory: "/work/demo", source: "startup" });
    });
  });

  it("is idempotent across repeated SessionStart events", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const event = { hook_event_name: "SessionStart", session_id: "cc-repeat", cwd: "/work/demo" };
      await postEvent(base, event);
      await postEvent(base, { ...event, source: "resume" });

      expect(await listSessions(projectDir)).toHaveLength(1);
    });
  });

  it("drains the queue on UserPromptSubmit and leaves it empty afterwards", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc-drain",
      });
      await enqueueSessionMessage(projectDir, session.normalizedId, "check T004");
      await enqueueSessionMessage(projectDir, session.normalizedId, "then report back");

      const { status, envelope } = await postEvent(base, {
        hook_event_name: "UserPromptSubmit",
        session_id: "cc-drain",
        prompt: "what next?",
      });

      expect(status).toBe(200);
      expect(envelope.data?.queuedMessages).toEqual(["check T004", "then report back"]);

      const second = await postEvent(base, {
        hook_event_name: "UserPromptSubmit",
        session_id: "cc-drain",
        prompt: "and now?",
      });
      expect(second.envelope.data?.queuedMessages).toEqual([]);
      expect((await getSession(projectDir, session.normalizedId)).messageQueue).toBeUndefined();
    });
  });

  it("registers an unknown session on UserPromptSubmit instead of dropping the checkpoint", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const { status, envelope } = await postEvent(base, {
        hook_event_name: "UserPromptSubmit",
        session_id: "cc-never-started",
        cwd: "/work/demo",
      });

      expect(status).toBe(200);
      expect(envelope.data?.queuedMessages).toEqual([]);

      const session = await getSession(projectDir, "cc-never-started");
      expect(session.runtimeType).toBe("claude-code");
      expect(session.status).toBe("active");
    });
  });

  it("completes the session on SessionEnd", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      await postEvent(base, { hook_event_name: "SessionStart", session_id: "cc-end" });

      const { status } = await postEvent(base, {
        hook_event_name: "SessionEnd",
        session_id: "cc-end",
        reason: "logout",
      });

      expect(status).toBe(200);
      expect((await getSession(projectDir, "cc-end")).status).toBe("completed");
    });
  });

  it("404s a SessionEnd for a session ARCS never saw", async () => {
    await withHookCtx(async ({ base }) => {
      const { status, envelope } = await postEvent(base, {
        hook_event_name: "SessionEnd",
        session_id: "cc-ghost",
        reason: "other",
      });

      expect(status).toBe(404);
      expect(envelope.code).toBe("ITEM_NOT_FOUND");
    });
  });

  it("rejects an unknown hook event name", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const { status, envelope } = await postEvent(base, {
        hook_event_name: "PreToolUse",
        session_id: "cc-1",
      });

      expect(status).toBe(400);
      expect(envelope.code).toBe("INVALID_BODY");
      expect(await listSessions(projectDir)).toHaveLength(0);
    });
  });

  it("ignores unknown extra fields Claude Code may add", async () => {
    await withHookCtx(async ({ base }) => {
      const { status } = await postEvent(base, {
        hook_event_name: "SessionStart",
        session_id: "cc-extra",
        transcript_path: "/tmp/transcript.jsonl",
        permission_mode: "acceptEdits",
      });

      expect(status).toBe(200);
    });
  });

  it("auto-registers an unknown session on Stop and answers an empty queue", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const { status, envelope } = await postEvent(base, {
        hook_event_name: "Stop",
        session_id: "cc-stop-unknown",
        cwd: "/work/demo",
      });

      expect(status).toBe(200);
      expect(envelope.data?.queuedMessages).toEqual([]);

      const session = await getSession(projectDir, "cc-stop-unknown");
      expect(session.runtimeType).toBe("claude-code");
      expect(session.status).toBe("active");
    });
  });

  it("answers an empty queue on Stop without draining queued messages", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc-stop-queued",
      });
      await enqueueSessionMessage(
        projectDir,
        session.normalizedId,
        "keep me until the next prompt",
      );

      const { status, envelope } = await postEvent(base, {
        hook_event_name: "Stop",
        session_id: "cc-stop-queued",
      });

      expect(status).toBe(200);
      expect(envelope.data?.queuedMessages).toEqual([]);

      // Stop never drains: the message survives for the next UserPromptSubmit.
      const stored = await getSession(projectDir, session.normalizedId);
      expect(stored.status).toBe("active");
      expect(stored.messageQueue).toEqual(["keep me until the next prompt"]);
    });
  });

  it("mirrors filtered turns from the transcript on Stop", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const transcriptPath = resolve(projectDir, "cc-stop-transcript.jsonl");
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({ type: "mode", message: { content: "thinking" } }),
          JSON.stringify({
            type: "user",
            isMeta: true,
            message: { content: "<local-command-caveat>wrapper</local-command-caveat>" },
          }),
          JSON.stringify({
            type: "user",
            message: { content: "mirror this prompt" },
            timestamp: "2026-01-01T00:00:00.000Z",
          }),
          JSON.stringify({
            type: "user",
            message: { content: [{ type: "tool_result", content: "echoed output" }] },
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "mirrored answer" },
                { type: "thinking", thinking: "internal monologue" },
              ],
            },
            timestamp: "2026-01-01T00:00:00.002Z",
          }),
        ].join("\n"),
        "utf-8",
      );

      const { status, envelope } = await postEvent(base, {
        hook_event_name: "Stop",
        session_id: "cc-stop-mirror",
        transcript_path: transcriptPath,
      });

      expect(status).toBe(200);
      expect(envelope.data?.queuedMessages).toEqual([]);

      const sidecarPath = join(projectDir, "sessions", "cc-stop-mirror.transcript.jsonl");
      expect(existsSync(sidecarPath)).toBe(true);
      const turns = readFileSync(sidecarPath, "utf-8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      // Noise lines (mode, isMeta, tool_result) are filtered out; the user
      // prompt and the assistant text answer are mirrored with line offsets.
      expect(turns).toEqual([
        { id: 2, type: "user", text: "mirror this prompt", ts: "2026-01-01T00:00:00.000Z" },
        { id: 4, type: "assistant", text: "mirrored answer", ts: "2026-01-01T00:00:00.002Z" },
      ]);
    });
  });

  it("answers 200 on Stop without a transcript_path and creates no sidecar", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const { status, envelope } = await postEvent(base, {
        hook_event_name: "Stop",
        session_id: "cc-stop-plain",
      });

      expect(status).toBe(200);
      expect(envelope.data?.queuedMessages).toEqual([]);
      expect(existsSync(join(projectDir, "sessions", "cc-stop-plain.transcript.jsonl"))).toBe(
        false,
      );
    });
  });

  it("mirrors the transcript on UserPromptSubmit before draining", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const transcriptPath = resolve(projectDir, "cc-prompt-transcript.jsonl");
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "user",
            message: { content: "first prompt" },
            timestamp: "2026-01-01T00:00:00.000Z",
          }),
          JSON.stringify({
            type: "user",
            message: { content: "second prompt" },
            timestamp: "2026-01-01T00:00:00.001Z",
          }),
        ].join("\n"),
        "utf-8",
      );

      const { status } = await postEvent(base, {
        hook_event_name: "UserPromptSubmit",
        session_id: "cc-up-mirror",
        transcript_path: transcriptPath,
        prompt: "what now?",
      });

      expect(status).toBe(200);
      const sidecarPath = join(projectDir, "sessions", "cc-up-mirror.transcript.jsonl");
      const turns = readFileSync(sidecarPath, "utf-8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(turns).toEqual([
        { id: 0, type: "user", text: "first prompt", ts: "2026-01-01T00:00:00.000Z" },
        { id: 1, type: "user", text: "second prompt", ts: "2026-01-01T00:00:00.001Z" },
      ]);
    });
  });

  it("persists transcript_path into metadata on UserPromptSubmit", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      await postEvent(base, { hook_event_name: "SessionStart", session_id: "cc-path-up" });

      const { status } = await postEvent(base, {
        hook_event_name: "UserPromptSubmit",
        session_id: "cc-path-up",
        transcript_path: "/tmp/cc-path-up.jsonl",
      });

      expect(status).toBe(200);
      const session = await getSession(projectDir, "cc-path-up");
      expect(session.metadata?.transcriptPath).toBe("/tmp/cc-path-up.jsonl");
    });
  });

  it("persists transcript_path into metadata on Stop", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      await postEvent(base, { hook_event_name: "SessionStart", session_id: "cc-path-stop" });

      const { status } = await postEvent(base, {
        hook_event_name: "Stop",
        session_id: "cc-path-stop",
        transcript_path: "/tmp/cc-path-stop.jsonl",
      });

      expect(status).toBe(200);
      const session = await getSession(projectDir, "cc-path-stop");
      expect(session.metadata?.transcriptPath).toBe("/tmp/cc-path-stop.jsonl");
    });
  });

  it("persists transcript_path into metadata on SessionEnd", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      await postEvent(base, { hook_event_name: "SessionStart", session_id: "cc-path-end" });

      const { status } = await postEvent(base, {
        hook_event_name: "SessionEnd",
        session_id: "cc-path-end",
        reason: "logout",
        transcript_path: "/tmp/cc-path-end.jsonl",
      });

      expect(status).toBe(200);
      const session = await getSession(projectDir, "cc-path-end");
      expect(session.status).toBe("completed");
      expect(session.metadata?.transcriptPath).toBe("/tmp/cc-path-end.jsonl");
    });
  });

  it("skips mirroring for an arcs-origin session but still persists the path", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const transcriptPath = resolve(projectDir, "cc-owned-transcript.jsonl");
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "user",
            message: { content: "headless prompt" },
            timestamp: "2026-01-01T00:00:00.000Z",
          }),
        ].join("\n"),
        "utf-8",
      );
      // An ARCS-minted thread: its sidecar is written by the run route's own
      // turn appends, so mirroring on top would duplicate the conversation.
      await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc-owned",
        origin: "arcs",
      });

      const { status, envelope } = await postEvent(base, {
        hook_event_name: "UserPromptSubmit",
        session_id: "cc-owned",
        transcript_path: transcriptPath,
      });

      expect(status).toBe(200);
      expect(envelope.data?.queuedMessages).toEqual([]);

      // The persisted origin suppresses transcript mirroring entirely…
      expect(existsSync(join(projectDir, "sessions", "cc-owned.transcript.jsonl"))).toBe(false);
      // …but the path itself is still recorded so later readers can resolve it.
      const session = await getSession(projectDir, "cc-owned");
      expect(session.metadata?.transcriptPath).toBe(transcriptPath);
      // The checkpoint never demotes an ARCS-owned thread to an observation.
      expect(session.origin).toBe("arcs");
    });
  });

  it("registers a hook-announced session as observed, whatever control claims", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const transcriptPath = resolve(projectDir, "cc-sniff-transcript.jsonl");
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "user",
            message: { content: "terminal prompt" },
            timestamp: "2026-01-01T00:00:00.000Z",
          }),
        ].join("\n"),
        "utf-8",
      );

      const { status } = await postEvent(base, {
        hook_event_name: "UserPromptSubmit",
        session_id: "cc-sniff",
        control: "arcs-owned",
        transcript_path: transcriptPath,
      });

      expect(status).toBe(200);
      // Anything reaching this endpoint is a real terminal session, so the
      // marker no longer decides anything: it is persisted, and ignored.
      const session = await getSession(projectDir, "cc-sniff");
      expect(session.origin).toBe("observed");
      expect(session.metadata?.control).toBe("arcs-owned");
      expect(existsSync(join(projectDir, "sessions", "cc-sniff.transcript.jsonl"))).toBe(true);
    });
  });

  it("mirrors exactly as before when no control value is present and persists the path", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const transcriptPath = resolve(projectDir, "cc-plain-transcript.jsonl");
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            type: "user",
            message: { content: "ordinary prompt" },
            timestamp: "2026-01-01T00:00:00.000Z",
          }),
        ].join("\n"),
        "utf-8",
      );

      const { status } = await postEvent(base, {
        hook_event_name: "UserPromptSubmit",
        session_id: "cc-plain",
        transcript_path: transcriptPath,
      });

      expect(status).toBe(200);
      // No control → mirroring still runs, exactly like today…
      expect(existsSync(join(projectDir, "sessions", "cc-plain.transcript.jsonl"))).toBe(true);
      // …and the path is persisted alongside.
      const session = await getSession(projectDir, "cc-plain");
      expect(session.metadata?.transcriptPath).toBe(transcriptPath);
      expect(session.metadata?.control).toBeUndefined();
    });
  });

  it("stamps lastCheckpointAt on UserPromptSubmit, even when the event carries nothing else", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      await postEvent(base, { hook_event_name: "SessionStart", session_id: "cc-beat-up" });
      // A registered session that has never checkpointed reads idle: nothing
      // has reported that the terminal is working.
      expect(deriveSessionPhase(await getSession(projectDir, "cc-beat-up"))).toBe("idle");

      const before = Date.now();
      const { status } = await postEvent(base, {
        hook_event_name: "UserPromptSubmit",
        session_id: "cc-beat-up",
      });

      expect(status).toBe(200);
      const session = await getSession(projectDir, "cc-beat-up");
      const stamped = Date.parse(session.lastCheckpointAt ?? "");
      expect(Number.isNaN(stamped)).toBe(false);
      expect(stamped).toBeGreaterThanOrEqual(before);
      // The checkpoint is the observed session's proof of life.
      expect(deriveSessionPhase(session)).toBe("running");
    });
  });

  it("stamps lastCheckpointAt on Stop and moves it forward at every checkpoint", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      await postEvent(base, {
        hook_event_name: "UserPromptSubmit",
        session_id: "cc-beat-stop",
        transcript_path: "/tmp/cc-beat-stop.jsonl",
      });
      const first = (await getSession(projectDir, "cc-beat-stop")).lastCheckpointAt ?? "";

      const { status } = await postEvent(base, {
        hook_event_name: "Stop",
        session_id: "cc-beat-stop",
      });

      expect(status).toBe(200);
      const session = await getSession(projectDir, "cc-beat-stop");
      expect(Date.parse(session.lastCheckpointAt ?? "")).toBeGreaterThanOrEqual(Date.parse(first));
      // The metadata a previous checkpoint carried survives the stamp.
      expect(session.metadata?.transcriptPath).toBe("/tmp/cc-beat-stop.jsonl");
    });
  });

  it("stamps a checkpoint for a session it has never seen before", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const { status } = await postEvent(base, {
        hook_event_name: "Stop",
        session_id: "cc-beat-unknown",
        cwd: "/work/demo",
      });

      expect(status).toBe(200);
      const session = await getSession(projectDir, "cc-beat-unknown");
      expect(session.lastCheckpointAt).toBeDefined();
      expect(deriveSessionPhase(session)).toBe("running");
    });
  });

  it("leaves a completed session reading ended, whatever its last checkpoint said", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      await postEvent(base, { hook_event_name: "UserPromptSubmit", session_id: "cc-beat-end" });
      await postEvent(base, {
        hook_event_name: "SessionEnd",
        session_id: "cc-beat-end",
        reason: "logout",
      });

      const session = await getSession(projectDir, "cc-beat-end");
      expect(session.lastCheckpointAt).toBeDefined();
      expect(deriveSessionPhase(session)).toBe("ended");
    });
  });

  it("rejects a non-string transcript_path with a 400", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const { status, envelope } = await postEvent(base, {
        hook_event_name: "Stop",
        session_id: "cc-bad-transcript",
        transcript_path: 42,
      });

      expect(status).toBe(400);
      expect(envelope.code).toBe("INVALID_BODY");
      expect(await listSessions(projectDir)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// SessionStart staged context
// ---------------------------------------------------------------------------

/**
 * The delimiter scan REDECLARED rather than imported from prompt-assembly: this
 * is the pattern a downstream consumer (or an attacker) would run over the
 * block, so weakening the module's own export must not weaken the assertion
 * with it.
 */
const DELIMITER_SCAN = /<<<\s*(?:END_)?ARCS_[A-Z0-9_]*[^>]*>>>/gi;

function delimiterTokens(text: string): string[] {
  return [...text.matchAll(DELIMITER_SCAN)].map((match) => match[0]);
}

/**
 * Every genuine delimiter in a staged block, and nothing else: one envelope
 * pair wrapping everything, and every untrusted-body opener closed before the
 * next opener or the envelope close.
 *
 * The load-bearing case is a CLIPPED block. A head truncation through a wrapper
 * keeps the opener and severs the closer, after which every later ARCS-authored
 * line — including LIMITS, which asserts who owns the tool scope — reads as
 * quoted reference data. The 2500-char ceiling makes clipping the common case
 * here, so this runs over the capped output rather than an unclipped fixture.
 */
function expectDelimiterInvariant(text: string): void {
  const tokens = delimiterTokens(text);
  expect(tokens.filter((t) => t === "<<<ARCS_STAGED_ENVIRONMENT>>>")).toHaveLength(1);
  expect(tokens.filter((t) => t === "<<<END_ARCS_STAGED_ENVIRONMENT>>>")).toHaveLength(1);
  expect(tokens.at(0)).toBe("<<<ARCS_STAGED_ENVIRONMENT>>>");
  expect(tokens.at(-1)).toBe("<<<END_ARCS_STAGED_ENVIRONMENT>>>");

  let depth = 0;
  for (const token of tokens.slice(1, -1)) {
    if (token === "<<<END_ARCS_UNTRUSTED_DOC>>>") {
      depth -= 1;
    } else {
      // An opener must be well-formed: both attribute values attribute-safe
      // (so a hostile `source` cannot terminate the tag it sits in), and the
      // governing note ON the tag rather than only in the envelope preamble.
      expect(token).toMatch(
        /^<<<ARCS_UNTRUSTED_DOC name="[^"<>]*" source="[^"<>]*" note="[^"<>]*">>>$/,
      );
      depth += 1;
    }
    // Never negative (a closer without its opener), never nested (a wrapper
    // inside a wrapper would mean a body forged one).
    expect(depth).toBeGreaterThanOrEqual(0);
    expect(depth).toBeLessThanOrEqual(1);
  }
  expect(depth).toBe(0);
}

/** A small, realistic DAG: one in-progress plan owning one in-progress task. */
async function seedDag(
  projectDir: string,
  task: Partial<Parameters<typeof createTask>[1]> = {},
  planContent = "# Ship the bridge\n\nMirror the staged environment into observed sessions.",
): Promise<string> {
  await createPlan(projectDir, {
    id: "bridge",
    title: "Ship the bridge",
    status: "in_progress",
    keywords: ["bridge"],
    content: planContent,
  });
  const created = await createTask(projectDir, {
    title: "Wire the SessionStart mirror",
    status: "in_progress",
    planId: "bridge",
    scope: "scripts/claude-code-session-hook.mjs and the hook-events route",
    acceptance: "SessionStart answers with stagedContext",
    verify: "npx vitest run test/hook-events-route.test.ts",
    skill: "implementation",
    ...task,
  });
  return created.normalizedId;
}

async function linkSession(projectDir: string, sessionId: string, taskId: string): Promise<void> {
  await createSession(projectDir, { runtimeType: "claude-code", runtimeSessionId: sessionId });
  await updateSession(projectDir, {
    id: sessionId,
    linkedNodeType: "task",
    linkedNodeId: taskId,
  });
}

describe("POST /api/hook/:slug/event — SessionStart staged context", () => {
  it("stages the full environment for a task-linked session, default-ON", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const taskId = await seedDag(projectDir);
      await linkSession(projectDir, "cc-linked", taskId);

      // No opt-in flag, no query parameter, no header: the plain event the
      // installed hook already sends is what turns this on.
      const { status, envelope } = await postEvent(base, {
        hook_event_name: "SessionStart",
        session_id: "cc-linked",
        cwd: "/work/demo",
        source: "startup",
      });

      expect(status).toBe(200);
      const staged = envelope.data?.stagedContext ?? "";
      // The same builder the ARCS-owned headless path uses, so the same blocks.
      expect(staged).toContain("## IDENTITY");
      expect(staged).toContain("## WORKSPACE");
      expect(staged).toContain("Workspace root: /work/demo");
      expect(staged).toContain("## DAG POSITION");
      expect(staged).toContain(`Linked node: task ${taskId}`);
      expect(staged).toContain("Acceptance: SessionStart answers with stagedContext");
      expect(staged).toContain("## LIMITS");
      expect(staged.length).toBeLessThanOrEqual(SESSION_START_STAGE_CAP);
      expectDelimiterInvariant(staged);
    });
  });

  it("stages a degraded two-line block for a session with no linked node", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      await seedDag(projectDir);

      // The common case: discovery never links, so an observed terminal has no
      // linked node until a human sets one.
      const { status, envelope } = await postEvent(base, {
        hook_event_name: "SessionStart",
        session_id: "cc-unlinked",
        cwd: "/work/demo",
        source: "startup",
      });

      expect(status).toBe(200);
      const staged = envelope.data?.stagedContext ?? "";
      const lines = staged.split("\n");
      expect(lines).toHaveLength(2);
      // Line 1 — identity and how to read the rest, not an apology.
      expect(lines[0]).toContain('ARCS as project demo "Demo"');
      expect(lines[0]).toContain("arcs brief demo --lean --json");
      // Line 2 — what the project is actually on right now.
      expect(lines[1]).toBe(
        "Project current focus: Wire the SessionStart mirror · " +
          "Next action: Continue task wire-the-sessionstart-mirror",
      );
      // ARCS-authored throughout, so it quotes no body and needs no wrapper.
      expect(delimiterTokens(staged)).toEqual([]);
      expect(staged.length).toBeLessThanOrEqual(SESSION_START_STAGE_CAP);
    });
  });

  it("falls back to the degraded block when even a fully degraded build overflows", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      // Every budgeted field at (or past) its input width, so the soft-cap
      // ladder runs out of rungs before the text fits.
      const taskId = await seedDag(projectDir, {
        title: `Wide ${"w".repeat(400)}`,
        scope: `Scope ${"s".repeat(600)}`,
        acceptance: `Acceptance ${"a".repeat(900)}`,
        verify: `Verify ${"v".repeat(400)}`,
        skill: `Skill ${"k".repeat(200)}`,
      });
      await linkSession(projectDir, "cc-wide", taskId);

      const { status, envelope } = await postEvent(base, {
        hook_event_name: "SessionStart",
        session_id: "cc-wide",
        // A workspace root at its own input width, so nothing un-budgeted is
        // understated either.
        cwd: `/work/${"d".repeat(400)}`,
      });

      expect(status).toBe(200);
      const staged = envelope.data?.stagedContext ?? "";
      expect(staged.length).toBeLessThanOrEqual(SESSION_START_STAGE_CAP);
      // The floor is the whole degraded block, NEVER a head-truncated staged
      // one: clipping the assembled text is what severs a wrapper's closer.
      expect(staged.split("\n")).toHaveLength(2);
      expect(delimiterTokens(staged)).toEqual([]);
      expect(staged).toContain('ARCS as project demo "Demo"');
    });
  });

  it("keeps the delimiter invariant when the cap forces a mid-wrapper clip", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      // An overview paragraph comfortably past the brief block's 800-char
      // budget, so its wrapper is clipped THROUGH rather than dropped whole —
      // the one path a delimiter-balance assertion on an unclipped fixture
      // never exercises.
      const taskId = await seedDag(projectDir, {}, "");
      writeFileSync(
        join(projectDir, "overview.md"),
        `# Demo\n\n${"the project overview says a great deal. ".repeat(40)}`,
        "utf-8",
      );
      await linkSession(projectDir, "cc-clipped", taskId);

      const { status, envelope } = await postEvent(base, {
        hook_event_name: "SessionStart",
        session_id: "cc-clipped",
        cwd: "/work/demo",
      });

      expect(status).toBe(200);
      const staged = envelope.data?.stagedContext ?? "";
      expect(staged.length).toBeLessThanOrEqual(SESSION_START_STAGE_CAP);
      // The clip landed inside a wrapped body…
      expect(staged).toContain("chars truncated]");
      // …and that wrapper is still closed, with the ARCS-authored LIMITS block
      // outside it rather than swallowed into an unterminated untrusted region.
      expectDelimiterInvariant(staged);
      const lastClose = staged.lastIndexOf("<<<END_ARCS_UNTRUSTED_DOC>>>");
      expect(lastClose).toBeGreaterThan(-1);
      expect(staged.indexOf("## LIMITS")).toBeGreaterThan(lastClose);
    });
  });

  it("survives a SessionStart for a session linked to a node that no longer exists", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const taskId = await seedDag(projectDir);
      await linkSession(projectDir, "cc-dangling", taskId);
      // Linkage is validated at write time, so the dangling state only arises
      // the way it does in production: the node is deleted afterwards.
      await deleteTask(projectDir, taskId);

      const { status, envelope } = await postEvent(base, {
        hook_event_name: "SessionStart",
        session_id: "cc-dangling",
      });

      expect(status).toBe(200);
      const staged = envelope.data?.stagedContext ?? "";
      expect(staged).toContain(`Linked node: task ${taskId} — not found in the DAG.`);
      expectDelimiterInvariant(staged);
    });
  });

  it("answers 200 with no stagedContext at all when staging fails", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      // A regular file where the plans directory belongs: the index read falls
      // through to a rebuild, and the rebuild's readdir throws ENOTDIR.
      writeFileSync(join(projectDir, "plans"), "not a directory", "utf-8");

      const { status, envelope } = await postEvent(base, {
        hook_event_name: "SessionStart",
        session_id: "cc-broken-dag",
      });

      // The session is still registered and the hook still gets a clean 200 —
      // its degradation is silence, so an absent field is the only signal.
      expect(status).toBe(200);
      expect(envelope.data?.stagedContext).toBeUndefined();
      expect((await getSession(projectDir, "cc-broken-dag")).runtimeType).toBe("claude-code");
    });
  });

  it("never attaches stagedContext to a checkpoint or a teardown event", async () => {
    await withHookCtx(async ({ base, projectDir }) => {
      const taskId = await seedDag(projectDir);
      await linkSession(projectDir, "cc-other-events", taskId);

      for (const event of [
        { hook_event_name: "UserPromptSubmit", prompt: "what next?" },
        { hook_event_name: "Stop" },
        { hook_event_name: "SessionEnd", reason: "logout" },
      ]) {
        const { status, envelope } = await postEvent(base, {
          ...event,
          session_id: "cc-other-events",
        });

        expect(status).toBe(200);
        // Staging is per SESSION, not per turn: re-sending it at every
        // checkpoint would re-inject the same block on every prompt.
        expect(envelope.data?.stagedContext).toBeUndefined();
      }
    });
  });
});
