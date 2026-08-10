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
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_START_STAGE_CAP } from "../src/web-server/routes/hook-events.js";

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
              data: { sessionId: "cc-1" },
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

/** A well-formed SessionStart reply carrying `stagedContext`. */
function stagedBody(stagedContext: unknown): string {
  return JSON.stringify({
    ok: true,
    data: { sessionId: "cc-1", stagedContext },
  });
}

const sessionStartEvent = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: "cc-1", hook_event_name: "SessionStart", ...extra });

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

  it("posts the UserPromptSubmit checkpoint and emits no stdout, whatever the reply carries", async () => {
    stub = await startStub();
    // UserPromptSubmit is a pure checkpoint: the event must still reach the
    // server (it drives lastCheckpointAt and transcript mirroring), but the
    // reply is never read, so even a context-bearing body injects nothing.
    stub.body = stagedBody("a block a checkpoint must never inject");

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
    expect(result.stdout).toBe("");
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].body).toEqual({
      hook_event_name: "UserPromptSubmit",
      session_id: "cc-1",
    });
  });

  it("emits no stdout for a plain UserPromptSubmit", async () => {
    stub = await startStub();
    const result = await runHook(
      JSON.stringify({ session_id: "cc-1", hook_event_name: "UserPromptSubmit", prompt: "hi" }),
      hookEnv(stub.baseUrl),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("never emits context for UserPromptSubmit, SessionEnd or Stop", async () => {
    for (const hookEventName of ["UserPromptSubmit", "SessionEnd", "Stop"]) {
      stub = await startStub();
      stub.body = stagedBody("staged block that must not be echoed");

      const result = await runHook(
        JSON.stringify({ session_id: "cc-1", hook_event_name: hookEventName, reason: "other" }),
        hookEnv(stub.baseUrl),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      await stub.close();
      stub = null;
    }
  });

  it("forwards a Stop event with its transcript_path and prints nothing", async () => {
    stub = await startStub();

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

describe("claude-code-session-hook: SessionStart staged context", () => {
  it("injects the server's stagedContext as SessionStart additionalContext", async () => {
    stub = await startStub();
    const block = "## IDENTITY\nYou are on project demo.\n\n## DAG POSITION\nLinked node: none.";
    stub.body = stagedBody(block);

    const result = await runHook(
      sessionStartEvent({ cwd: "/work/demo", source: "startup" }),
      hookEnv(stub.baseUrl),
    );

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
    // Verbatim: the hook is a transport, so it must not reflow, trim or
    // re-wrap a block whose delimiters are load-bearing.
    expect(output.hookSpecificOutput.additionalContext).toBe(block);
  });

  it("is on by default — no opt-in env var is consulted", async () => {
    stub = await startStub();
    stub.body = stagedBody("staged block");

    // Exactly the three variables the installer writes; nothing else enables it.
    const result = await runHook(sessionStartEvent(), hookEnv(stub.baseUrl));

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe("staged block");
  });

  it("stays silent when the reply carries no stagedContext at all", async () => {
    stub = await startStub();

    const result = await runHook(sessionStartEvent(), hookEnv(stub.baseUrl));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("refuses a non-string or empty stagedContext instead of stringifying it", async () => {
    for (const value of [42, null, { text: "block" }, ["block"], ""]) {
      stub = await startStub();
      stub.body = stagedBody(value);

      const result = await runHook(sessionStartEvent(), hookEnv(stub.baseUrl));

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      await stub.close();
      stub = null;
    }
  });
});

describe("claude-code-session-hook: the client's own context bound", () => {
  const SCRIPT_SOURCE = readFileSync(SCRIPT, "utf-8");
  /** `const MAX_CONTEXT_CHARS = 4000;` — parsed, never imported: the script is
   *  deployed standalone and importing it would run a program that reads stdin
   *  and posts to the network. Same discipline as the hook-contract parity
   *  test; keep the declaration greppable in this exact shape. */
  const MAX_CONTEXT_PATTERN = /const MAX_CONTEXT_CHARS = (\d+);/;

  function scriptMaxContextChars(source: string): number {
    const match = MAX_CONTEXT_PATTERN.exec(source);
    if (!match) {
      throw new Error(`No \`const MAX_CONTEXT_CHARS = <n>;\` declaration found in ${SCRIPT}`);
    }
    return Number(match[1]);
  }

  it("fails loudly instead of silently when the declaration disappears", () => {
    expect(() => scriptMaxContextChars("// the script was rewritten")).toThrow(/MAX_CONTEXT_CHARS/);
  });

  it("leaves head-room above the server's own cap so the two never cross", () => {
    // A server cap raised past the client's bound would make every SessionStart
    // silently drop its block — the worst kind of regression here, because the
    // hard rule guarantees it produces no error to notice.
    expect(scriptMaxContextChars(SCRIPT_SOURCE)).toBeGreaterThanOrEqual(SESSION_START_STAGE_CAP);
  });

  it("drops an oversized stagedContext whole rather than clipping it", async () => {
    stub = await startStub();
    const oversized = `${"x".repeat(scriptMaxContextChars(SCRIPT_SOURCE) + 1)}`;
    stub.body = stagedBody(oversized);

    const result = await runHook(sessionStartEvent(), hookEnv(stub.baseUrl));

    expect(result.code).toBe(0);
    // Not a truncated block: a clip would sever an untrusted body's closing
    // delimiter and hand the model an unterminated region.
    expect(result.stdout).toBe("");
  });

  it("accepts a block sitting exactly on the bound", async () => {
    stub = await startStub();
    const exact = "y".repeat(scriptMaxContextChars(SCRIPT_SOURCE));
    stub.body = stagedBody(exact);

    const result = await runHook(sessionStartEvent(), hookEnv(stub.baseUrl));

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe(exact);
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

/**
 * The same hard rule, on the branch that runs FIRST in a session.
 *
 * SessionStart is the riskiest event to get wrong: it fires before the user has
 * typed anything, so a non-zero exit or a stray stdout write greets them as the
 * very first thing their terminal does. Every failure ARCS can produce is
 * re-exercised here rather than assumed to be shared with UserPromptSubmit.
 */
describe("claude-code-session-hook: SessionStart never blocks the session either", () => {
  it("exits 0 when ARCS is not running at all", async () => {
    // Port 1 is reserved and refuses instantly.
    const result = await runHook(sessionStartEvent(), hookEnv("http://127.0.0.1:1"));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 when the token is rejected", async () => {
    stub = await startStub();
    stub.status = 401;
    stub.body = JSON.stringify({ ok: false, code: "hook_unauthorized", message: "nope" });

    const result = await runHook(sessionStartEvent(), hookEnv(stub.baseUrl));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 when the server hangs past the client timeout", async () => {
    stub = await startStub();
    stub.delayMs = 4000;

    const started = Date.now();
    const result = await runHook(sessionStartEvent(), hookEnv(stub.baseUrl));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    // A slow stage on the server must not stall the terminal's startup.
    expect(Date.now() - started).toBeLessThan(3500);
  }, 15000);

  it("exits 0 when the server answers with unparseable JSON", async () => {
    stub = await startStub();
    stub.body = "<!doctype html><html>not json</html>";

    const result = await runHook(sessionStartEvent(), hookEnv(stub.baseUrl));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 when the server answers 500 with a staged block anyway", async () => {
    stub = await startStub();
    stub.status = 500;
    stub.body = stagedBody("a block from a failed request must never be used");

    const result = await runHook(sessionStartEvent(), hookEnv(stub.baseUrl));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits 0 and stays silent when the hook is not configured", async () => {
    stub = await startStub();
    stub.body = stagedBody("staged block");

    const result = await runHook(sessionStartEvent(), {
      ARCS_HOOK_TOKEN: "",
      ARCS_HOOK_SLUG: "",
      ARCS_HOOK_URL: stub.baseUrl,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(stub.requests).toHaveLength(0);
  });

  it("exits 0 on a SessionStart with no session_id", async () => {
    stub = await startStub();
    stub.body = stagedBody("staged block");

    const result = await runHook(
      JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
      hookEnv(stub.baseUrl),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(stub.requests).toHaveLength(0);
  });
});
