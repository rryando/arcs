/**
 * Unit tests for the one-shot run driver seam (src/web-server/run-driver.ts).
 *
 * Pure module tests — no real spawn, no filesystem. The opencode adapter's
 * contract is pinned here: argv shapes (fresh vs continued), NDJSON event
 * normalization into fold turns, sessionID harvesting, and tolerance for
 * unparsable lines.
 */

import { describe, expect, it } from "vitest";
import { SESSION_RUNTIME_TYPES } from "../src/utils/storage-utils.js";
import {
  buildOpencodeRunArgv,
  foldOpencodeOutput,
  getRunDriver,
  registerRunDriver,
} from "../src/web-server/run-driver.js";

const SESSION = "ses_0TestSessionId0000000000000";

/** Serializes events the way `opencode run --format json` emits them. */
function ndjson(...events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

const stepStart = () => ({ type: "step_start", timestamp: 1, sessionID: SESSION });
const stepFinish = () => ({ type: "step_finish", timestamp: 9, sessionID: SESSION });
const textEvent = (text: string) => ({
  type: "text",
  timestamp: 2,
  sessionID: SESSION,
  part: { id: "prt_1", type: "text", text },
});
const toolUseEvent = (part: Record<string, unknown>) => ({
  type: "tool_use",
  timestamp: 3,
  sessionID: SESSION,
  part,
});
const errorEvent = (error: unknown) => ({
  type: "error",
  timestamp: 4,
  sessionID: SESSION,
  error,
});

// ---------------------------------------------------------------------------
// argv builder — fresh vs continued
// ---------------------------------------------------------------------------

describe("buildOpencodeRunArgv", () => {
  it("builds the fresh-thread shape with a title", () => {
    expect(buildOpencodeRunArgv({ message: "hello world", title: "Fix the login bug" })).toEqual([
      "run",
      "--format",
      "json",
      "--title",
      "Fix the login bug",
      "hello world",
    ]);
  });

  it("omits --title when none is given (opencode falls back to truncated prompt)", () => {
    expect(buildOpencodeRunArgv({ message: "hello" })).toEqual([
      "run",
      "--format",
      "json",
      "hello",
    ]);
  });

  it("builds the continuation shape with -s and no title", () => {
    expect(
      buildOpencodeRunArgv({ message: "follow up", runtimeSessionId: SESSION, title: "ignored" }),
    ).toEqual(["run", "--format", "json", "-s", SESSION, "follow up"]);
  });

  it("keeps a multi-word message as ONE argv element", () => {
    const argv = buildOpencodeRunArgv({ message: "one two three four" });
    expect(argv.at(-1)).toBe("one two three four");
    expect(argv).toHaveLength(4);
  });

  it("passes the message through verbatim, whitespace included", () => {
    const argv = buildOpencodeRunArgv({ message: "  keep  inner  spacing \n" });
    expect(argv.at(-1)).toBe("  keep  inner  spacing \n");
  });

  it.each(["", "   ", "\n\t"])("throws on a blank message (%j)", (message) => {
    expect(() => buildOpencodeRunArgv({ message })).toThrow(/non-empty message/);
  });

  it("treats a blank-but-present runtimeSessionId as a caller bug, not a fresh thread", () => {
    expect(() => buildOpencodeRunArgv({ message: "hi", runtimeSessionId: "   " })).toThrow(
      /non-blank runtimeSessionId/,
    );
  });
});

// ---------------------------------------------------------------------------
// Event normalization
// ---------------------------------------------------------------------------

describe("foldOpencodeOutput", () => {
  it("folds a full stream into turns in stream order", () => {
    const fold = foldOpencodeOutput(
      ndjson(
        stepStart(),
        textEvent("Reading the config first."),
        toolUseEvent({ type: "tool", tool: "read", state: { status: "completed" } }),
        textEvent("Found it. "),
        textEvent("The port is wrong."),
        stepFinish(),
      ),
    );
    expect(fold.turns).toEqual([
      { type: "assistant", text: "Reading the config first." },
      { type: "assistant", text: "", tool: { name: "read" } },
      { type: "assistant", text: "Found it. The port is wrong." },
    ]);
    expect(fold.replyText).toBe("Reading the config first.Found it. The port is wrong.");
    expect(fold.runtimeSessionId).toBe(SESSION);
    expect(fold.error).toBeUndefined();
    expect(fold.skippedLines).toBe(0);
  });

  it("coalesces consecutive text events into one turn", () => {
    const fold = foldOpencodeOutput(ndjson(textEvent("a"), textEvent("b"), textEvent("c")));
    expect(fold.turns).toEqual([{ type: "assistant", text: "abc" }]);
  });

  it("finds the tool name wherever this build puts it", () => {
    const variants = [
      toolUseEvent({ type: "tool", tool: "bash" }),
      toolUseEvent({ type: "tool", name: "edit" }),
      toolUseEvent({ type: "tool", state: { status: "completed", tool: "grep" } }),
      toolUseEvent({ type: "tool", state: { status: "completed", name: "glob" } }),
    ];
    const fold = foldOpencodeOutput(ndjson(...variants));
    expect(fold.turns.map((turn) => turn.tool?.name)).toEqual(["bash", "edit", "grep", "glob"]);
  });

  it("drops an unnamed tool_use without counting drift", () => {
    const fold = foldOpencodeOutput(
      ndjson(textEvent("before"), toolUseEvent({ type: "tool", state: { status: "pending" } })),
    );
    expect(fold.turns).toEqual([{ type: "assistant", text: "before" }]);
    expect(fold.skippedLines).toBe(0);
  });

  it("surfaces the last error event's message without touching the reply", () => {
    const fold = foldOpencodeOutput(
      ndjson(
        errorEvent({ name: "ProviderError", message: "rate limited" }),
        errorEvent({ name: "AbortError", message: "user aborted" }),
        textEvent("partial reply"),
      ),
    );
    expect(fold.error).toBe("user aborted");
    expect(fold.replyText).toBe("partial reply");
  });

  it("reads string error payloads too", () => {
    expect(foldOpencodeOutput(ndjson(errorEvent("boom"))).error).toBe("boom");
  });

  it("leaves reasoning events unfolded but not counted as drift", () => {
    const fold = foldOpencodeOutput(
      ndjson({
        type: "reasoning",
        timestamp: 5,
        sessionID: SESSION,
        part: { type: "reasoning", text: "thinking..." },
      }),
    );
    expect(fold.turns).toEqual([]);
    expect(fold.replyText).toBe("");
    expect(fold.skippedLines).toBe(0);
  });

  it("harvests sessionID from any line, first one wins", () => {
    const fold = foldOpencodeOutput(
      ndjson(
        { type: "step_start", timestamp: 1, sessionID: "ses_first" },
        { type: "text", timestamp: 2, sessionID: "ses_second", part: { type: "text", text: "x" } },
      ),
    );
    expect(fold.runtimeSessionId).toBe("ses_first");
  });

  it("harvests sessionID even from an unknown event type", () => {
    const fold = foldOpencodeOutput(
      ndjson({ type: "something_new", timestamp: 1, sessionID: "ses_drifted" }),
    );
    expect(fold.runtimeSessionId).toBe("ses_drifted");
    expect(fold.skippedLines).toBe(1);
  });

  it("returns no sessionID when no line carried one", () => {
    const fold = foldOpencodeOutput(`${JSON.stringify({ type: "step_start", timestamp: 1 })}\n`);
    expect(fold.runtimeSessionId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Tolerance — the wire schema is opencode's to change
  // -------------------------------------------------------------------------

  it("skips unparsable lines and still folds the rest", () => {
    const fold = foldOpencodeOutput(
      `{"type":"text","timestamp":1,"sessionID":"${SESSION}","part":{"type":"text","text":"ok"}}\n` +
        "<<<truncated by a hard kill\n" +
        `${JSON.stringify(textEvent("still works"))}\n`,
    );
    expect(fold.turns).toEqual([{ type: "assistant", text: "okstill works" }]);
    expect(fold.replyText).toBe("okstill works");
    expect(fold.skippedLines).toBe(1);
  });

  it("counts non-object JSON lines as skipped", () => {
    const fold = foldOpencodeOutput('[1,2,3]\n42\n"str"\n');
    expect(fold.turns).toEqual([]);
    expect(fold.skippedLines).toBe(3);
  });

  it("counts unknown event types as skipped", () => {
    const fold = foldOpencodeOutput(ndjson({ type: "mystery", timestamp: 1 }, textEvent("known")));
    expect(fold.turns).toEqual([{ type: "assistant", text: "known" }]);
    expect(fold.skippedLines).toBe(1);
  });

  it("tolerates CRLF terminators and blank separator lines", () => {
    const fold = foldOpencodeOutput(`\r\n${JSON.stringify(textEvent("crlf"))}\r\n\n   \n`);
    expect(fold.turns).toEqual([{ type: "assistant", text: "crlf" }]);
    expect(fold.skippedLines).toBe(0);
  });

  it("folds empty input to an empty result", () => {
    expect(foldOpencodeOutput("")).toEqual({
      turns: [],
      replyText: "",
      skippedLines: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Registry + enum membership
// ---------------------------------------------------------------------------

describe("run driver registry", () => {
  it("serves the opencode adapter under its runtime type", () => {
    const driver = getRunDriver("opencode");
    expect(driver?.runtimeType).toBe("opencode");
    expect(driver?.binary).toBe("opencode");
    expect(driver?.buildArgv({ message: "hi", title: "t" })).toEqual(
      buildOpencodeRunArgv({ message: "hi", title: "t" }),
    );
    expect(driver?.foldOutput(ndjson(textEvent("wired"))).replyText).toBe("wired");
  });

  it("has no claude-code one-shot driver yet (later, against this same seam)", () => {
    expect(getRunDriver("claude-code")).toBeUndefined();
  });

  it("registers adapters keyed by runtime type", () => {
    // Vitest isolates module state per file, so registering a placeholder
    // claude-code adapter here cannot leak into other suites.
    registerRunDriver({
      runtimeType: "claude-code",
      binary: "claude",
      buildArgv: () => ["-p"],
      foldOutput: () => ({ turns: [], replyText: "", skippedLines: 0 }),
    });
    expect(getRunDriver("claude-code")?.binary).toBe("claude");
  });

  it("SESSION_RUNTIME_TYPES carries both runtimes", () => {
    expect(SESSION_RUNTIME_TYPES).toContain("claude-code");
    expect(SESSION_RUNTIME_TYPES).toContain("opencode");
  });
});
