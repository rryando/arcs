/**
 * `scripts/claude-code-session-hook.mjs` behaviour, driven the way Claude Code
 * drives it: spawn the script, write an event to stdin, read stdout/exit code.
 *
 * The load-bearing property is the hard rule — the script must exit 0 and print
 * nothing no matter how badly the ARCS side misbehaves, because a non-zero exit
 * (or exit 2) would degrade the user's real session. Every failure mode ARCS
 * can produce is exercised here against a stub server.
 */

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "claude-code-session-hook.mjs");

interface CapturedRequest {
  method: string;
  url: string;
  authorization?: string;
  contentType?: string;
  body: unknown;
}

interface Stub {
  baseUrl: string;
  requests: CapturedRequest[];
  /** Status the next event answers with. */
  status: number;
  /** Raw response body; `null` sends the default envelope. */
  body: string | null;
  /** Delay before answering, to trip the client-side timeout. */
  delayMs: number;
  queuedMessages: string[];
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => resolveBody(raw));
  });
}

async function startStub(): Promise<Stub> {
  const requests: CapturedRequest[] = [];
  const state = {
    status: 200,
    body: null as string | null,
    delayMs: 0,
    queuedMessages: [] as string[],
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        ...(req.headers.authorization && { authorization: req.headers.authorization }),
        ...(req.headers["content-type"] && { contentType: req.headers["content-type"] }),
        body: raw ? JSON.parse(raw) : null,
      });
      const answer = () => {
        res.writeHead(state.status, { "content-type": "application/json" });
        res.end(
          state.body ??
            JSON.stringify({
              ok: state.status < 400,
              data: { sessionId: "cc-1", queuedMessages: state.queuedMessages },
            }),
        );
      };
      if (state.delayMs > 0) setTimeout(answer, state.delayMs);
      else answer();
    })();
  });

  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    get status() {
      return state.status;
    },
    set status(value: number) {
      state.status = value;
    },
    get body() {
      return state.body;
    },
    set body(value: string | null) {
      state.body = value;
    },
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(value: number) {
      state.delayMs = value;
    },
    get queuedMessages() {
      return state.queuedMessages;
    },
    set queuedMessages(value: string[]) {
      state.queuedMessages = value;
    },
    close: () =>
      new Promise<void>((closed) => {
        server.closeAllConnections?.();
        server.close(() => closed());
      }),
  };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHook(stdin: string, env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += String(c);
    });
    child.stderr.on("data", (c) => {
      stderr += String(c);
    });
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

let stub: Stub | null = null;

afterEach(async () => {
  await stub?.close();
  stub = null;
});

function hookEnv(baseUrl: string) {
  return { ARCS_HOOK_TOKEN: "tok-123", ARCS_HOOK_SLUG: "demo", ARCS_HOOK_URL: baseUrl };
}

describe("claude-code-session-hook: wire format", () => {
  it("posts a SessionStart to the hook endpoint with a bearer token", async () => {
    stub = await startStub();
    const result = await runHook(
      JSON.stringify({
        session_id: "cc-1",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/work/demo",
        hook_event_name: "SessionStart",
        source: "startup",
      }),
      hookEnv(stub.baseUrl),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(stub.requests).toHaveLength(1);

    const request = stub.requests[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/api/hook/demo/event");
    expect(request.authorization).toBe("Bearer tok-123");
    expect(request.contentType).toBe("application/json");
    expect(request.body).toEqual({
      hook_event_name: "SessionStart",
      session_id: "cc-1",
      cwd: "/work/demo",
      source: "startup",
      transcript_path: "/tmp/t.jsonl",
    });
  });

  it("forwards the SessionEnd reason", async () => {
    stub = await startStub();
    const result = await runHook(
      JSON.stringify({ session_id: "cc-1", hook_event_name: "SessionEnd", reason: "logout" }),
      hookEnv(stub.baseUrl),
    );

    expect(result.code).toBe(0);
    expect(stub.requests[0].body).toEqual({
      hook_event_name: "SessionEnd",
      session_id: "cc-1",
      reason: "logout",
    });
  });

  it("injects queued messages as UserPromptSubmit additionalContext", async () => {
    stub = await startStub();
    stub.queuedMessages = ["check T004", "then report back"];

    const result = await runHook(
      JSON.stringify({
        session_id: "cc-1",
        prompt_id: "p-1",
        hook_event_name: "UserPromptSubmit",
        prompt: "what next?",
      }),
      hookEnv(stub.baseUrl),
    );

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(output.hookSpecificOutput.additionalContext).toContain("ARCS web UI");
    expect(output.hookSpecificOutput.additionalContext).toContain("[1] check T004");
    expect(output.hookSpecificOutput.additionalContext).toContain("[2] then report back");
  });

  it("prints nothing when the queue is empty", async () => {
    stub = await startStub();
    const result = await runHook(
      JSON.stringify({ session_id: "cc-1", hook_event_name: "UserPromptSubmit", prompt: "hi" }),
      hookEnv(stub.baseUrl),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("never emits context for events other than UserPromptSubmit", async () => {
    stub = await startStub();
    stub.queuedMessages = ["should not appear"];

    const result = await runHook(
      JSON.stringify({ session_id: "cc-1", hook_event_name: "SessionStart" }),
      hookEnv(stub.baseUrl),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("forwards a Stop event with its transcript_path and prints nothing", async () => {
    stub = await startStub();
    stub.queuedMessages = ["should not appear"];

    const result = await runHook(
      JSON.stringify({
        session_id: "cc-1",
        transcript_path: "/tmp/t.jsonl",
        cwd: "/work/demo",
        hook_event_name: "Stop",
      }),
      hookEnv(stub.baseUrl),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].body).toEqual({
      hook_event_name: "Stop",
      session_id: "cc-1",
      cwd: "/work/demo",
      transcript_path: "/tmp/t.jsonl",
    });
  });

  it("omits transcript_path from a Stop event that lacks it", async () => {
    stub = await startStub();

    const result = await runHook(
      JSON.stringify({ session_id: "cc-1", hook_event_name: "Stop" }),
      hookEnv(stub.baseUrl),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].body).toEqual({
      hook_event_name: "Stop",
      session_id: "cc-1",
    });
  });
});

describe("claude-code-session-hook: never blocks the session", () => {
  it("exits 0 when ARCS is not running at all", async () => {
    // Port 1 is reserved and refuses instantly.
    const result = await runHook(
      JSON.stringify({ session_id: "cc-1", hook_event_name: "UserPromptSubmit", prompt: "hi" }),
      hookEnv("http://127.0.0.1:1"),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 when the token is rejected", async () => {
    stub = await startStub();
    stub.status = 401;
    stub.body = JSON.stringify({ ok: false, code: "hook_unauthorized", message: "nope" });

    const result = await runHook(
      JSON.stringify({ session_id: "cc-1", hook_event_name: "UserPromptSubmit", prompt: "hi" }),
      hookEnv(stub.baseUrl),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 when the server hangs past the client timeout", async () => {
    stub = await startStub();
    stub.delayMs = 4000;

    const started = Date.now();
    const result = await runHook(
      JSON.stringify({ session_id: "cc-1", hook_event_name: "UserPromptSubmit", prompt: "hi" }),
      hookEnv(stub.baseUrl),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    // Aborted client-side rather than waiting the server out.
    expect(Date.now() - started).toBeLessThan(3500);
  }, 15000);

  it("exits 0 when the server answers with unparseable JSON", async () => {
    stub = await startStub();
    stub.body = "<!doctype html><html>not json</html>";

    const result = await runHook(
      JSON.stringify({ session_id: "cc-1", hook_event_name: "UserPromptSubmit", prompt: "hi" }),
      hookEnv(stub.baseUrl),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 on malformed stdin without touching the server", async () => {
    stub = await startStub();
    const result = await runHook("not json at all", hookEnv(stub.baseUrl));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(stub.requests).toHaveLength(0);
  });

  it("exits 0 on empty stdin", async () => {
    stub = await startStub();
    const result = await runHook("", hookEnv(stub.baseUrl));

    expect(result.code).toBe(0);
    expect(stub.requests).toHaveLength(0);
  });

  it("exits 0 and stays silent when the hook is not configured", async () => {
    stub = await startStub();
    const result = await runHook(
      JSON.stringify({ session_id: "cc-1", hook_event_name: "UserPromptSubmit", prompt: "hi" }),
      { ARCS_HOOK_TOKEN: "", ARCS_HOOK_SLUG: "", ARCS_HOOK_URL: stub.baseUrl },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(stub.requests).toHaveLength(0);
  });

  it("ignores events it was not installed for", async () => {
    stub = await startStub();
    const result = await runHook(
      JSON.stringify({ session_id: "cc-1", hook_event_name: "PreToolUse", tool_name: "Bash" }),
      hookEnv(stub.baseUrl),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(stub.requests).toHaveLength(0);
  });
});
