/**
 * Per-run stdout event log (src/web-server/run-event-log.ts).
 *
 * Three contracts under test, all inside isolated temp data dirs:
 *  - the WRITER: every stdout line lands verbatim, one file line per stdout
 *    line, whatever the bytes are (unparsable JSON, unknown event types, CRLF,
 *    blank separators, chunk boundaries that fall mid-line) — and a write that
 *    fails is reported on the stats, never thrown;
 *  - the FOLD: assistant text plus one turn per tool_use, appended through
 *    appendSessionTurn in the ARCS-authored negative id space, tagged with the
 *    run id so a second fold is a no-op;
 *  - RETENTION: a session keeps at most N logs.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { appendSessionTurn, readSessionTurns } from "../src/utils/claude-transcript.js";
import {
  foldRunEventLog,
  openRunEventLog,
  pruneRunEventLogs,
  RUN_EVENT_LOG_MAX_BYTES,
  RUN_EVENT_LOG_RETENTION,
  runEventLogPath,
  runEventLogSegment,
} from "../src/web-server/run-event-log.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const SESSION = "arcs-thread-demo";
const RUN = "11111111-2222-4333-8444-555555555555";

/** A project dir under the isolated data dir, with its sessions/ ready. */
function projectDirIn(dir: string): string {
  const projectDir = resolve(dir, "projects", "demo");
  mkdirSync(resolve(projectDir, "sessions"), { recursive: true });
  return projectDir;
}

const assistantEvent = (...blocks: unknown[]) => ({
  type: "assistant",
  message: { role: "assistant", content: blocks },
});
const textBlock = (text: string) => ({ type: "text", text });
const toolBlock = (name: string) => ({ type: "tool_use", id: "tu_1", name, input: {} });

describe("runEventLogPath — naming", () => {
  it("keys on the canonical normalizedId and the run id, in the sessions dir", () => {
    expect(runEventLogPath("/data/p/demo", SESSION, RUN)).toBe(
      `/data/p/demo/sessions/${SESSION}.run-${RUN}.events.jsonl`,
    );
  });

  it("sanitizes a run id before it reaches a path — no traversal, no separators", () => {
    expect(runEventLogSegment("../../etc/passwd")).toBe("------etc-passwd");
    expect(runEventLogSegment("")).toBe("unknown");
    expect(runEventLogPath("/d", "s", "../../evil")).toBe(
      "/d/sessions/s.run-------evil.events.jsonl",
    );
  });

  it("uses the same normalized id the transcript sidecar does", () => {
    expect(runEventLogPath("/d", "Some Session", RUN)).toBe(
      `/d/sessions/some-session.run-${RUN}.events.jsonl`,
    );
  });
});

describe("openRunEventLog — verbatim capture", () => {
  it("writes every stdout line byte for byte, one file line per stdout line", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });

      // A realistic mix: a known event, a line the reader cannot parse, a blank
      // separator, an event type that did not exist when this shipped.
      const stdout = [
        '{"type":"system","subtype":"init"}',
        "not json at all {",
        "",
        '{"type":"brand_new_event","v":1}',
        '{"type":"result","result":"done"}',
      ].join("\n");
      log.push(`${stdout}\n`);
      const stats = log.close();

      const raw = readFileSync(log.path, "utf-8");
      expect(raw).toBe(`${stdout}\n`);
      expect(raw.split("\n").slice(0, -1)).toEqual(stdout.split("\n"));
      expect(stats.lines).toBe(5);
      expect(stats.bytes).toBe(Buffer.byteLength(`${stdout}\n`));
      expect(stats.error).toBeUndefined();
      expect(stats.truncated).toBe(false);
    });
  });

  it("reassembles lines split across chunk boundaries without moving a byte", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      const whole = '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n';
      // Chunk edges deliberately fall mid-JSON and mid-newline-run.
      log.push(whole.slice(0, 5));
      log.push(whole.slice(5, 30));
      log.push(whole.slice(30));
      const stats = log.close();

      expect(readFileSync(log.path, "utf-8")).toBe(whole);
      expect(stats.lines).toBe(1);
    });
  });

  it("preserves CRLF and blank lines exactly", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      log.push('{"type":"system"}\r\n\r\n{"type":"result"}\r\n');
      log.close();
      expect(readFileSync(log.path, "utf-8")).toBe(
        '{"type":"system"}\r\n\r\n{"type":"result"}\r\n',
      );
    });
  });

  it("terminates a final line the child never terminated, so the file ends on a boundary", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      log.push('{"type":"result","result":"no trailing newline"}');
      log.flush();
      const stats = log.close();

      const raw = readFileSync(log.path, "utf-8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw).toBe('{"type":"result","result":"no trailing newline"}\n');
      expect(stats.lines).toBe(1);
    });
  });

  it("creates the log even for a run that writes nothing at all", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      log.flush();
      const stats = log.close();

      expect(readFileSync(log.path, "utf-8")).toBe("");
      expect(stats.lines).toBe(0);
      expect(stats.error).toBeUndefined();
    });
  });

  it("is line-addressable while the run is still open (offset tailing)", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      log.push('{"n":1}\n{"n":2}\n');
      // Read mid-run: the writer is synchronous, so the bytes are already there
      // — nothing is buffered waiting for a close.
      const afterTwo = readFileSync(log.path, "utf-8").split("\n").slice(0, -1);
      expect(afterTwo).toEqual(['{"n":1}', '{"n":2}']);

      log.push('{"n":3}\n');
      const afterThree = readFileSync(log.path, "utf-8").split("\n").slice(0, -1);
      // Offsets 0..1 are byte-identical to what the earlier tail saw: existing
      // line boundaries never move, only new lines appear past them.
      expect(afterThree.slice(0, 2)).toEqual(afterTwo);
      expect(afterThree[2]).toBe('{"n":3}');
      log.close();
    });
  });

  it("reports an unwritable log on the stats instead of throwing", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = resolve(dir, "projects", "demo");
      mkdirSync(projectDir, { recursive: true });
      // A FILE where the sessions dir should be — mkdir/open both fail.
      writeFileSync(resolve(projectDir, "sessions"), "not a directory", "utf-8");

      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      expect(() => log.push('{"type":"result"}\n')).not.toThrow();
      expect(() => log.flush()).not.toThrow();
      const stats = log.close();

      expect(stats.error).toBeTypeOf("string");
      expect(stats.lines).toBe(0);
    });
  });

  it("stops at the size cap and still ends on a line boundary", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      // One chunk over the cap is refused whole rather than written in half.
      log.push(`${"x".repeat(RUN_EVENT_LOG_MAX_BYTES + 1)}\n`);
      log.push('{"type":"result"}\n');
      log.flush();
      const stats = log.close();

      expect(stats.truncated).toBe(true);
      expect(stats.lines).toBe(0);
      expect(readFileSync(log.path, "utf-8")).toBe("");
    });
  });

  it("is a total no-op without a target", () => {
    const log = openRunEventLog(undefined);
    expect(() => log.push("anything")).not.toThrow();
    log.flush();
    expect(log.close()).toEqual({ lines: 0, bytes: 0, truncated: false });
    expect(log.path).toBe("");
  });
});

describe("foldRunEventLog — fold-down into the sidecar", () => {
  it("appends assistant text plus one turn per tool_use, in stream order", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      writeFileSync(
        runEventLogPath(projectDir, SESSION, RUN),
        `${[
          { type: "system", subtype: "init" },
          assistantEvent(textBlock("Reading the file."), toolBlock("Read"), toolBlock("Grep")),
          { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
          assistantEvent(textBlock("Done.")),
          { type: "result", is_error: false, result: "Done." },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n")}\n`,
        "utf-8",
      );

      const fold = await foldRunEventLog(projectDir, SESSION, RUN);
      expect(fold).toEqual({ appended: 4, alreadyFolded: false, assistantTextFolded: true });

      const turns = await readSessionTurns(projectDir, SESSION);
      expect(turns.map((turn) => [turn.type, turn.text, turn.tool?.name])).toEqual([
        ["assistant", "Reading the file.", undefined],
        ["assistant", "", "Read"],
        ["assistant", "", "Grep"],
        ["assistant", "Done.", undefined],
      ]);
      // ARCS-authored negative id space, monotonic and collision-free.
      expect(turns.map((turn) => turn.id)).toEqual([-1, -2, -3, -4]);
      expect(turns.every((turn) => turn.run === RUN)).toBe(true);
    });
  });

  it("folding the same log twice is a no-op", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      writeFileSync(
        runEventLogPath(projectDir, SESSION, RUN),
        `${JSON.stringify(assistantEvent(textBlock("only once"), toolBlock("Bash")))}\n`,
        "utf-8",
      );

      const first = await foldRunEventLog(projectDir, SESSION, RUN);
      const second = await foldRunEventLog(projectDir, SESSION, RUN);
      const third = await foldRunEventLog(projectDir, SESSION, RUN);

      expect(first.appended).toBe(2);
      expect(second).toEqual({ appended: 0, alreadyFolded: true, assistantTextFolded: true });
      expect(third).toEqual({ appended: 0, alreadyFolded: true, assistantTextFolded: true });
      expect(await readSessionTurns(projectDir, SESSION)).toHaveLength(2);
    });
  });

  it("does not collide with turns already in the sidecar and folds after them", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      await appendSessionTurn(projectDir, SESSION, { type: "user", text: "the prompt" });
      writeFileSync(
        runEventLogPath(projectDir, SESSION, RUN),
        `${JSON.stringify(assistantEvent(textBlock("the reply")))}\n`,
        "utf-8",
      );

      await foldRunEventLog(projectDir, SESSION, RUN);
      const turns = await readSessionTurns(projectDir, SESSION);
      expect(turns.map((turn) => [turn.id, turn.type, turn.text])).toEqual([
        [-1, "user", "the prompt"],
        [-2, "assistant", "the reply"],
      ]);
      // The user turn stays untagged — only folded turns carry a run id.
      expect(turns[0].run).toBeUndefined();
      expect(turns[1].run).toBe(RUN);
    });
  });

  it("a fold of another run's log is unaffected by this run's tag", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const other = "99999999-2222-4333-8444-555555555555";
      writeFileSync(
        runEventLogPath(projectDir, SESSION, RUN),
        `${JSON.stringify(assistantEvent(textBlock("run one")))}\n`,
        "utf-8",
      );
      writeFileSync(
        runEventLogPath(projectDir, SESSION, other),
        `${JSON.stringify(assistantEvent(textBlock("run two")))}\n`,
        "utf-8",
      );

      await foldRunEventLog(projectDir, SESSION, RUN);
      await foldRunEventLog(projectDir, SESSION, other);
      await foldRunEventLog(projectDir, SESSION, RUN);

      const turns = await readSessionTurns(projectDir, SESSION);
      expect(turns.map((turn) => [turn.text, turn.run])).toEqual([
        ["run one", RUN],
        ["run two", other],
      ]);
    });
  });

  it("ignores unparsable lines, deltas and the terminal result — no duplicates", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      writeFileSync(
        runEventLogPath(projectDir, SESSION, RUN),
        [
          "{ not json",
          "[1,2,3]",
          JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } },
          }),
          JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
          }),
          JSON.stringify(assistantEvent(textBlock("hello"))),
          JSON.stringify({ type: "result", is_error: false, result: "hello" }),
          "",
        ].join("\n"),
        "utf-8",
      );

      const fold = await foldRunEventLog(projectDir, SESSION, RUN);
      expect(fold.appended).toBe(1);
      const turns = await readSessionTurns(projectDir, SESSION);
      expect(turns.map((turn) => turn.text)).toEqual(["hello"]);
    });
  });

  it("a missing or empty log folds to nothing and writes no sidecar", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      expect(await foldRunEventLog(projectDir, SESSION, RUN)).toEqual({
        appended: 0,
        alreadyFolded: false,
        assistantTextFolded: false,
      });

      writeFileSync(runEventLogPath(projectDir, SESSION, RUN), "", "utf-8");
      expect((await foldRunEventLog(projectDir, SESSION, RUN)).appended).toBe(0);
      expect(await readSessionTurns(projectDir, SESSION)).toEqual([]);
    });
  });

  it("a tool-only run folds tool turns but reports no assistant text", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      writeFileSync(
        runEventLogPath(projectDir, SESSION, RUN),
        `${JSON.stringify(assistantEvent(toolBlock("Write")))}\n`,
        "utf-8",
      );
      const fold = await foldRunEventLog(projectDir, SESSION, RUN);
      expect(fold).toEqual({ appended: 1, alreadyFolded: false, assistantTextFolded: false });
    });
  });
});

describe("pruneRunEventLogs — bounded retention", () => {
  /** Writes `count` logs for SESSION, oldest first (mtimes one second apart). */
  function seedLogs(projectDir: string, count: number): string[] {
    const names: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const runId = `run-${String(i).padStart(3, "0")}`;
      const path = runEventLogPath(projectDir, SESSION, runId);
      writeFileSync(path, `{"n":${i}}\n`, "utf-8");
      names.push(path.split("/").pop() as string);
    }
    return names;
  }

  it("keeps the newest RUN_EVENT_LOG_RETENTION logs and deletes the rest", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const names = seedLogs(projectDir, RUN_EVENT_LOG_RETENTION + 4);

      const pruned = await pruneRunEventLogs(projectDir, SESSION);
      expect(pruned).toBe(4);

      const left = (await readdir(resolve(projectDir, "sessions"))).sort();
      expect(left).toHaveLength(RUN_EVENT_LOG_RETENTION);
      // Same-millisecond writes tie on mtime, so the name breaks the tie and the
      // newest run ids (written last) are the survivors.
      expect(left).toEqual(names.slice(-RUN_EVENT_LOG_RETENTION).sort());
    });
  });

  it("is a no-op under the retention bound", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      seedLogs(projectDir, RUN_EVENT_LOG_RETENTION);
      expect(await pruneRunEventLogs(projectDir, SESSION)).toBe(0);
      expect(await readdir(resolve(projectDir, "sessions"))).toHaveLength(RUN_EVENT_LOG_RETENTION);
    });
  });

  it("keep: 0 removes every log for the session (deletion path)", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      seedLogs(projectDir, 3);
      expect(await pruneRunEventLogs(projectDir, SESSION, 0)).toBe(3);
      expect(await readdir(resolve(projectDir, "sessions"))).toEqual([]);
    });
  });

  it("never touches another session's logs or the transcript sidecar", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      seedLogs(projectDir, 3);
      writeFileSync(runEventLogPath(projectDir, "other-session", RUN), "{}\n", "utf-8");
      await appendSessionTurn(projectDir, SESSION, { type: "user", text: "keep me" });

      await pruneRunEventLogs(projectDir, SESSION, 0);

      const left = (await readdir(resolve(projectDir, "sessions"))).sort();
      expect(left).toEqual([
        `${SESSION}.transcript.jsonl`,
        `other-session.run-${RUN}.events.jsonl`,
      ]);
    });
  });

  it("never throws on a missing sessions dir", async () => {
    await withTempDataDir(async (dir) => {
      expect(await pruneRunEventLogs(resolve(dir, "projects", "nope"), SESSION)).toBe(0);
    });
  });
});
