/**
 * Unit + route tests for the one-shot run driver seam (src/web-server/run-driver.ts)
 * and the runners surface (src/web-server/routes/runners.ts).
 *
 * Pure module tests — no real pi/claude/codex spawn. Argv shapes
 * (fresh vs continued), NDJSON normalization into fold turns, session id
 * harvesting, and tolerance for unparsable lines are pinned per driver against
 * fixtures drawn from verified runs (pi 0.84.4, codex-cli 0.150.1, claude
 * 2.1.247). The runners route test drives PATH probed without any real
 * runtime (the probe is a pure PATH scan in routes/runners.ts).
 */

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_RUNTIME_TYPES } from "../src/utils/storage-utils.js";
import { createApp } from "../src/web-server/app.js";
import {
  buildClaudeCodeRunArgv,
  buildCodexRunArgv,
  buildPiRunArgv,
  foldClaudeCodeOutput,
  foldCodexOutput,
  foldPiOutput,
  getRunDriver,
  getRunDriverRuntimeTypes,
} from "../src/web-server/run-driver.js";

const SESSION = "01a05132-f6ff-775e-9845-d89daa6ba192";
const THREAD = "7b5cda0d-0f0b-4588-81a5-cbc0ebe93442";
const CODEX_THREAD = "01a05134-0313-7b13-9a24-6053f326d147";

/** Serializes events as NDJSON. */
function ndjson(...events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// pi — argv builder
// ---------------------------------------------------------------------------

describe("buildPiRunArgv", () => {
  it("builds the fresh-thread shape", () => {
    expect(buildPiRunArgv({ message: "hello world" })).toEqual([
      "-p",
      "--mode",
      "json",
      "hello world",
    ]);
  });

  it("builds the continuation shape with --session-id and no title", () => {
    expect(
      buildPiRunArgv({ message: "follow up", runtimeSessionId: SESSION, title: "ignored" }),
    ).toEqual(["-p", "--mode", "json", "--session-id", SESSION, "follow up"]);
  });

  it("emits --session-dir on continuation when the caller supplies sessionDir", () => {
    expect(
      buildPiRunArgv({
        message: "follow up",
        runtimeSessionId: SESSION,
        sessionDir: "/tmp/pi-store",
      }),
    ).toEqual([
      "-p",
      "--mode",
      "json",
      "--session-id",
      SESSION,
      "--session-dir",
      "/tmp/pi-store",
      "follow up",
    ]);
  });

  it("omits --session-dir on a fresh thread even when sessionDir is present", () => {
    expect(buildPiRunArgv({ message: "hi", sessionDir: "/tmp/pi-store" })).toEqual([
      "-p",
      "--mode",
      "json",
      "hi",
    ]);
  });

  it("keeps a multi-word message as ONE argv element", () => {
    expect(buildPiRunArgv({ message: "one two three four" }).at(-1)).toBe("one two three four");
  });

  it.each(["", "   ", "\n\t"])("throws on a blank message (%j)", (message) => {
    expect(() => buildPiRunArgv({ message })).toThrow(/non-empty message/);
  });

  it("treats a blank-but-present runtimeSessionId as a caller bug, not a fresh thread", () => {
    expect(() => buildPiRunArgv({ message: "hi", runtimeSessionId: "   " })).toThrow(
      /non-blank runtimeSessionId/,
    );
  });
});

// ---------------------------------------------------------------------------
// pi — event normalization
// ---------------------------------------------------------------------------

describe("foldPiOutput", () => {
  it("folds a full stream: id harvest, thinking ignored, deltas coalesced, tool turn", () => {
    const raw = ndjson(
      {
        type: "session",
        version: 3,
        id: SESSION,
        timestamp: "2026-08-30T05:44:49.663Z",
        cwd: "/tmp",
      },
      { type: "agent_start" },
      { type: "turn_start" },
      {
        type: "message_update",
        usage: {},
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "The user just said hi.",
        },
      },
      {
        type: "message_update",
        usage: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hi! How" },
      },
      {
        type: "message_update",
        usage: {},
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 1,
          delta: " can I help you today?",
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "pwd" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "pwd" },
        partialResult: { content: [] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "/tmp\n" }] },
        isError: false,
      },
      {
        type: "message_update",
        usage: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Done." },
      },
      { type: "turn_end", message: {}, toolResults: [] },
      { type: "agent_end", messages: [] },
      { type: "agent_settled" },
    );
    const fold = foldPiOutput(raw);
    expect(fold.turns).toEqual([
      { type: "assistant", text: "Hi! How can I help you today?" },
      { type: "assistant", text: "", tool: { name: "bash" } },
      { type: "assistant", text: "Done." },
    ]);
    expect(fold.replyText).toBe("Hi! How can I help you today?Done.");
    expect(fold.runtimeSessionId).toBe(SESSION);
    expect(fold.error).toBeUndefined();
    expect(fold.skippedLines).toBe(0);
  });

  it("coalesces consecutive text deltas into ONE assistant turn", () => {
    const fold = foldPiOutput(
      ndjson(
        { type: "session", id: SESSION },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "b" } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "c" } },
      ),
    );
    expect(fold.turns).toEqual([{ type: "assistant", text: "abc" }]);
    expect(fold.replyText).toBe("abc");
  });

  it("ignores thinking_delta and deltas that carry no text, without counting drift", () => {
    const fold = foldPiOutput(
      ndjson(
        {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "nope" },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "input_json_delta", contentIndex: 2, delta: "{}" },
        },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1 } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } },
        { type: "message_update", usage: {} },
      ),
    );
    expect(fold.turns).toEqual([]);
    expect(fold.replyText).toBe("");
    expect(fold.skippedLines).toBe(0);
  });

  it("flushes pending text before a tool turn and drops unnamed tool starts without drift", () => {
    const fold = foldPiOutput(
      ndjson(
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "before " } },
        { type: "tool_execution_start", toolCallId: "c2", toolName: "", args: {} },
        {
          type: "tool_execution_start",
          toolCallId: "c1",
          toolName: "edit",
          args: { file: "a.ts" },
        },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "after" } },
      ),
    );
    expect(fold.turns).toEqual([
      { type: "assistant", text: "before " },
      { type: "assistant", text: "", tool: { name: "edit" } },
      { type: "assistant", text: "after" },
    ]);
    expect(fold.skippedLines).toBe(0);
  });

  it("returns no session id when no header line carried one", () => {
    const fold = foldPiOutput(ndjson({ type: "agent_start" }));
    expect(fold.runtimeSessionId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Tolerance — the wire schema is pi's to change
  // -------------------------------------------------------------------------

  it("counts unparsable lines and unknown event types as skipped, still folding the rest", () => {
    const fold = foldPiOutput(
      `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"ok"}}\n` +
        `<<<truncated by a hard kill\n` +
        `{"type":"brand_new_event","extra":1}\n` +
        `[1,2,3]\n` +
        `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "too" } })}\n`,
    );
    expect(fold.turns).toEqual([{ type: "assistant", text: "oktoo" }]);
    expect(fold.skippedLines).toBe(3);
  });

  it("tolerates CRLF terminators and blank separator lines", () => {
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "crlf" },
    });
    const fold = foldPiOutput(`\r\n${line}\r\n\n   \n`);
    expect(fold.turns).toEqual([{ type: "assistant", text: "crlf" }]);
    expect(fold.skippedLines).toBe(0);
  });

  it("folds empty input to an empty result", () => {
    expect(foldPiOutput("")).toEqual({ turns: [], replyText: "", skippedLines: 0 });
  });
});

// ---------------------------------------------------------------------------
// claude-code — argv builder
// ---------------------------------------------------------------------------

describe("buildClaudeCodeRunArgv", () => {
  it("builds the fresh-thread shape with the permission skip", () => {
    expect(buildClaudeCodeRunArgv({ message: "hello world" })).toEqual([
      "-p",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "hello world",
    ]);
  });

  it("builds the continuation shape with --resume", () => {
    expect(buildClaudeCodeRunArgv({ message: "follow up", runtimeSessionId: THREAD })).toEqual([
      "-p",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--resume",
      THREAD,
      "follow up",
    ]);
  });

  it.each(["", "   "])("throws on a blank message (%j)", (message) => {
    expect(() => buildClaudeCodeRunArgv({ message })).toThrow(/non-empty message/);
  });

  it("treats a blank-but-present runtimeSessionId as a caller bug", () => {
    expect(() => buildClaudeCodeRunArgv({ message: "hi", runtimeSessionId: " " })).toThrow(
      /non-blank runtimeSessionId/,
    );
  });
});

// ---------------------------------------------------------------------------
// claude-code — event normalization
// ---------------------------------------------------------------------------

describe("foldClaudeCodeOutput", () => {
  it("folds a full stream: init id harvest, flush-per-message, tool_use turn, result", () => {
    const fold = foldClaudeCodeOutput(
      ndjson(
        {
          type: "system",
          subtype: "init",
          session_id: THREAD,
          cwd: "/tmp",
          model: "claude-sonnet-4-5",
        },
        { type: "user", message: { role: "user", content: "say hi" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Hi!" },
              { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pwd" } },
            ],
          },
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "The cwd is " },
              { type: "text", text: "/tmp." },
            ],
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Done.",
          session_id: THREAD,
        },
      ),
    );
    expect(fold.turns).toEqual([
      { type: "assistant", text: "Hi!" },
      { type: "assistant", text: "", tool: { name: "Bash" } },
      { type: "assistant", text: "The cwd is /tmp." },
    ]);
    // Assistant content wins over the result-string fallback.
    expect(fold.replyText).toBe("Hi!The cwd is /tmp.");
    expect(fold.runtimeSessionId).toBe(THREAD);
    expect(fold.error).toBeUndefined();
    expect(fold.skippedLines).toBe(0);
  });

  it("harvests the session id from any line, first one wins", () => {
    const fold = foldClaudeCodeOutput(
      ndjson(
        { type: "system", subtype: "init", session_id: "ses_first" },
        { type: "result", is_error: false, result: "x", session_id: "ses_second" },
      ),
    );
    expect(fold.runtimeSessionId).toBe("ses_first");
  });

  it("uses the result string as the reply fallback when no assistant content folded", () => {
    const fold = foldClaudeCodeOutput(
      ndjson(
        { type: "system", subtype: "init", session_id: THREAD, cwd: "/tmp" },
        { type: "user", message: { role: "user", content: "hi" } },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Hello from claude.",
          session_id: THREAD,
        },
      ),
    );
    expect(fold.turns).toEqual([]);
    expect(fold.replyText).toBe("Hello from claude.");
    expect(fold.runtimeSessionId).toBe(THREAD);
  });

  it("surfaces a failing result as error, not reply text", () => {
    const fold = foldClaudeCodeOutput(
      ndjson(
        { type: "system", subtype: "init", session_id: THREAD },
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Failed to authenticate",
          session_id: THREAD,
        },
      ),
    );
    expect(fold.error).toBe("Failed to authenticate");
    expect(fold.replyText).toBe("");
    expect(fold.turns).toEqual([]);
  });

  it("recognizes the legacy type-less envelope by shape", () => {
    const fold = foldClaudeCodeOutput(
      ndjson({ is_error: false, result: "legacy ok", session_id: "ses_legacy" }),
    );
    expect(fold.replyText).toBe("legacy ok");
    expect(fold.runtimeSessionId).toBe("ses_legacy");
    expect(fold.skippedLines).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Tolerance — the wire schema is claude's to change
  // -------------------------------------------------------------------------

  it("counts unparsable lines and unknown event types as skipped", () => {
    const fold = foldClaudeCodeOutput(
      `{"type":"system","subtype":"init","session_id":"${THREAD}"}\n` +
        `not json\n` +
        `{"type":"mystery","payload":1}\n` +
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "fine" }] } })}\n`,
    );
    expect(fold.turns).toEqual([{ type: "assistant", text: "fine" }]);
    expect(fold.skippedLines).toBe(2);
  });

  it("tolerates CRLF terminators and blank separator lines", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "crlf" }] },
    });
    const fold = foldClaudeCodeOutput(`\r\n${line}\r\n\n   \n`);
    expect(fold.turns).toEqual([{ type: "assistant", text: "crlf" }]);
    expect(fold.skippedLines).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// codex — argv builder
// ---------------------------------------------------------------------------

describe("buildCodexRunArgv", () => {
  it("builds the fresh-thread shape", () => {
    expect(buildCodexRunArgv({ message: "hello world" })).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "hello world",
    ]);
  });

  it("builds the continuation shape with the resume subcommand", () => {
    expect(buildCodexRunArgv({ message: "follow up", runtimeSessionId: CODEX_THREAD })).toEqual([
      "exec",
      "resume",
      CODEX_THREAD,
      "--json",
      "--sandbox",
      "workspace-write",
      "follow up",
    ]);
  });

  it.each(["", "   "])("throws on a blank message (%j)", (message) => {
    expect(() => buildCodexRunArgv({ message })).toThrow(/non-empty message/);
  });

  it("treats a blank-but-present runtimeSessionId as a caller bug", () => {
    expect(() => buildCodexRunArgv({ message: "hi", runtimeSessionId: "\n" })).toThrow(
      /non-blank runtimeSessionId/,
    );
  });
});

// ---------------------------------------------------------------------------
// codex — event normalization
// ---------------------------------------------------------------------------

describe("foldCodexOutput", () => {
  it("folds the observed 0.150.1 stream: thread id harvest, agent text, one tool turn", () => {
    const fold = foldCodexOutput(
      ndjson(
        { type: "thread.started", thread_id: CODEX_THREAD },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text: "Running the requested command now." },
        },
        {
          type: "item.started",
          item: {
            id: "item_1",
            type: "command_execution",
            command: "/usr/bin/zsh -lc 'echo hi'",
            aggregated_output: "",
            exit_code: null,
            status: "in_progress",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "item_1",
            type: "command_execution",
            command: "/usr/bin/zsh -lc 'echo hi'",
            aggregated_output: "hi\n",
            exit_code: 0,
            status: "completed",
          },
        },
        { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "hi" } },
        { type: "turn.completed", usage: { input_tokens: 34795 } },
      ),
    );
    expect(fold.turns).toEqual([
      { type: "assistant", text: "Running the requested command now." },
      { type: "assistant", text: "", tool: { name: "command_execution" } },
      { type: "assistant", text: "hi" },
    ]);
    expect(fold.replyText).toBe("Running the requested command now.hi");
    expect(fold.runtimeSessionId).toBe(CODEX_THREAD);
    expect(fold.skippedLines).toBe(0);
  });

  it("coalesces consecutive agent_message items into one turn", () => {
    const fold = foldCodexOutput(
      ndjson(
        { type: "item.completed", item: { id: "a", type: "agent_message", text: "one" } },
        { type: "item.completed", item: { id: "b", type: "agent_message", text: " two" } },
      ),
    );
    expect(fold.turns).toEqual([{ type: "assistant", text: "one two" }]);
  });

  it("folds the documented agent_message/tool_execution payload shapes", () => {
    const fold = foldCodexOutput(
      ndjson(
        {
          type: "agent_message",
          payload: { message: { content: [{ type: "text", text: "alt " }] } },
        },
        { type: "tool_execution", payload: { toolName: "shell" } },
        { type: "agent_message", payload: "plain payload" },
      ),
    );
    expect(fold.turns).toEqual([
      { type: "assistant", text: "alt " },
      { type: "assistant", text: "", tool: { name: "shell" } },
      { type: "assistant", text: "plain payload" },
    ]);
    expect(fold.replyText).toBe("alt plain payload");
  });

  it("harvests the thread id from any line, first one wins — even a drifted one", () => {
    const fold = foldCodexOutput(
      ndjson(
        { type: "something_new", thread_id: "ses_drifted" },
        { type: "thread.started", thread_id: "ses_second" },
      ),
    );
    expect(fold.runtimeSessionId).toBe("ses_drifted");
    expect(fold.skippedLines).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Tolerance — EXTRA conservative: unrecognized means skipped, never thrown
  // -------------------------------------------------------------------------

  it("counts unknown events, unknown item types, and unparsable lines as skipped", () => {
    const fold = foldCodexOutput(
      `{"type":"turn.completed"}\r\n` +
        `{"type":"mystery","thread_id":"t1"}\n` +
        `not json\n` +
        `{"type":"item.completed","item":{"id":"i","type":"approval_requested","question":"rm -rf /"}}\n` +
        `[1,2]\n` +
        `${JSON.stringify({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "still folds" } })}\n`,
    );
    expect(fold.turns).toEqual([{ type: "assistant", text: "still folds" }]);
    expect(fold.replyText).toBe("still folds");
    expect(fold.runtimeSessionId).toBe("t1");
    expect(fold.skippedLines).toBe(4);
  });

  it("tolerates CRLF terminators and blank separator lines", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "i", type: "agent_message", text: "crlf" },
    });
    const fold = foldCodexOutput(`\r\n${line}\r\n\n   \n`);
    expect(fold.turns).toEqual([{ type: "assistant", text: "crlf" }]);
    expect(fold.skippedLines).toBe(0);
  });

  it("never throws on garbage input", () => {
    expect(() => foldCodexOutput("")).not.toThrow();
    expect(() => foldCodexOutput("{{{not json")).not.toThrow();
    expect(() => foldCodexOutput('"just a string"\n42\nnull\n')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("run driver registry", () => {
  it("registers all four drivers at module load with their binaries", () => {
    expect(getRunDriver("pi")?.binary).toBe("pi");
    expect(getRunDriver("opencode")?.binary).toBe("opencode");
    expect(getRunDriver("claude-code")?.binary).toBe("claude");
    expect(getRunDriver("codex")?.binary).toBe("codex");
  });

  it("enumerates every registered runtime type", () => {
    expect(getRunDriverRuntimeTypes().sort()).toEqual(
      ["claude-code", "codex", "opencode", "pi"].sort(),
    );
  });

  it("SESSION_RUNTIME_TYPES carries all four runtimes", () => {
    expect(SESSION_RUNTIME_TYPES).toEqual(["claude-code", "opencode", "pi", "codex"]);
  });

  it("drives each adapter through the generic seam input", () => {
    const pi = getRunDriver("pi");
    expect(pi?.buildArgv({ message: "hi" })).toEqual(buildPiRunArgv({ message: "hi" }));
    expect(pi?.foldOutput("")).toEqual({ turns: [], replyText: "", skippedLines: 0 });

    const codex = getRunDriver("codex");
    expect(codex?.buildArgv({ message: "hi", runtimeSessionId: CODEX_THREAD })).toEqual(
      buildCodexRunArgv({ message: "hi", runtimeSessionId: CODEX_THREAD }),
    );
  });
});

// ---------------------------------------------------------------------------
// Runners route — GET /api/runners
// ---------------------------------------------------------------------------

describe("GET /api/runners", () => {
  /** PATH override with executable shims, restored after each test. */
  let shimDir: string | undefined;

  afterEach(() => {
    if (shimDir !== undefined) {
      process.env.PATH = (process.env.PATH ?? "").replace(`${shimDir}:`, "");
      shimDir = undefined;
    }
  });

  /** Puts one executable shim per runtime binary ahead of PATH. */
  const shimRuntimes = () => {
    shimDir = mkdtempSync(join(tmpdir(), "arcs-runners-"));
    for (const binary of ["pi", "opencode", "claude", "codex"]) {
      const path = join(shimDir, binary);
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o755);
    }
    process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
  };

  const fetchRunners = async () => {
    const response = await createApp({ watch: false }).request("/api/runners", {
      headers: { host: "127.0.0.1" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: { runners: unknown[] } };
    expect(body.ok).toBe(true);
    return (
      body.data.runners as Array<{
        id: string;
        label: string;
        binary: string;
        available: boolean;
      }>
    ).sort((a, b) => a.id.localeCompare(b.id));
  };

  it("lists every registered driver with labels, binaries, and PATH availability", async () => {
    // Registration order is insertion order; compare as a set for stability.
    const runners = await fetchRunners();

    expect(runners.map((r) => r.id)).toEqual(["claude-code", "codex", "opencode", "pi"]);
    expect(runners.map((r) => r.label)).toEqual(["claude code", "codex", "opencode", "pi"]);
    expect(runners.map((r) => r.binary)).toEqual(["claude", "codex", "opencode", "pi"]);
    // Every entry answers a real boolean — the UI can toggle on it.
    for (const runner of runners) expect(typeof runner.available).toBe("boolean");
  });

  it("reports the host PATH honestly — shims on PATH are available, missing runtimes are not", async () => {
    // Empty PATH (plus a guaranteed-empty lead) must report nothing available:
    // CI runners install none of pi/opencode/claude/codex, and this assertion
    // must hold on every machine, not just dev boxes.
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent-arcs-probe-dir";
    try {
      const none = await fetchRunners();
      for (const runner of none) expect(runner.available).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }

    // Lead PATH with one shim per runtime: all become available.
    shimRuntimes();
    const all = await fetchRunners();
    for (const runner of all) expect(runner.available).toBe(true);
  });
});
