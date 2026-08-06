/**
 * Per-run stdout event log (src/web-server/run-event-log.ts).
 *
 * Three contracts under test, all inside isolated temp data dirs:
 *  - the WRITER: every stdout line lands verbatim, one file line per stdout
 *    line, whatever the bytes are (unparsable JSON, unknown event types, CRLF,
 *    blank separators, chunk boundaries that fall mid-line) — and every way the
 *    file can end up INCOMPLETE (size cap, short write, open failure) is
 *    reported on the stats, never thrown and never silent;
 *  - the FOLD: assistant text plus one turn per tool_use, appended through
 *    appendSessionTurn in the ARCS-authored negative id space, tagged with the
 *    run id so a second fold is a no-op;
 *  - RETENTION: a session keeps at most N logs.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The one thing a real filesystem will not do on demand: a SHORT write.
 *
 * Every knob is off by default, so every other test in this file (and every
 * other node:fs consumer the module graph pulls in) runs against the real
 * syscall — the mock is a straight passthrough until a test asks otherwise.
 *  - `perWrite`: cap on ONE writeSync, unlimited total (the EINTR shape — the
 *    fd keeps making progress, so a correct writer loses nothing).
 *  - `budget`: total bytes the fd will still accept (the ENOSPC shape — the
 *    write cannot be finished at all).
 *  - `failing`: the fd THROWS instead of returning short, and can be switched
 *    back off mid-test. A budget only ever runs out; a full disk that is then
 *    freed is the interleaving where a writer that gave up on its terminator
 *    starts appending onto an open line again.
 */
const fsControl = vi.hoisted(() => ({ perWrite: 0, budget: -1, failing: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const raw = actual.writeSync as unknown as (...args: unknown[]) => number;
  const writeSync = ((fd: number, buffer: unknown, offset?: number, length?: number): number => {
    if (fsControl.failing) {
      const err = new Error("ENOSPC: no space left on device, write") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      throw err;
    }
    if (!Buffer.isBuffer(buffer) || (fsControl.perWrite <= 0 && fsControl.budget < 0)) {
      return raw(fd, buffer, offset, length);
    }
    const start = offset ?? 0;
    const want = length ?? buffer.length - start;
    let allowed = want;
    if (fsControl.perWrite > 0) allowed = Math.min(allowed, fsControl.perWrite);
    if (fsControl.budget >= 0) {
      allowed = Math.min(allowed, fsControl.budget);
      fsControl.budget -= allowed;
    }
    return allowed <= 0 ? 0 : raw(fd, buffer, start, allowed);
  }) as typeof actual.writeSync;
  return { ...actual, default: actual, writeSync };
});

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

afterEach(() => {
  fsControl.perWrite = 0;
  fsControl.budget = -1;
  fsControl.failing = false;
});

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

  it("refuses only the chunk that crosses the cap and keeps the lines that still fit", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      // One chunk over the cap is refused WHOLE — never written in half. It
      // ends on a record boundary, so the stream resumes at a line start.
      const over = Buffer.alloc(RUN_EVENT_LOG_MAX_BYTES, 0x78);
      over[over.length - 1] = 0x0a;
      log.push(over);
      // The rest of the run is NOT collateral damage: one oversized chunk used
      // to make push() return early forever, so these lines — which fit with
      // 32 MB to spare — left a 0-byte file behind.
      log.push('{"type":"result"}\n');
      log.flush();
      const stats = log.close();

      expect(readFileSync(log.path, "utf-8")).toBe('{"type":"result"}\n');
      expect(stats.lines).toBe(1);
      expect(stats.bytes).toBe(18);
      // And the file still announces that it is not the whole stream.
      expect(stats.truncated).toBe(true);
      expect(stats.error).toBeUndefined();
    });
  });

  it("resyncs to the next line boundary after a refusal — never splices a line the child never wrote", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      log.push('{"n":1}\n');
      // An over-cap chunk that stops MID-record: the child's next chunk opens
      // with the rest of that record.
      log.push(Buffer.alloc(RUN_EVENT_LOG_MAX_BYTES, 0x78));
      log.push('xxxxx"}\n{"n":2}\n');
      log.flush();
      const stats = log.close();

      // The orphaned tail is dropped rather than appended as if it were a line
      // of its own — every line in the file is a whole line the child emitted.
      expect(readFileSync(log.path, "utf-8")).toBe('{"n":1}\n{"n":2}\n');
      expect(stats.lines).toBe(2);
      expect(stats.truncated).toBe(true);
    });
  });

  it("closes an open line the moment a chunk is refused, not only at flush", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      // The file is left mid-line and the continuation is what crosses the cap.
      log.push('{"partial');
      log.push(Buffer.alloc(RUN_EVENT_LOG_MAX_BYTES, 0x78));
      log.push('xx"}\n{"n":2}\n');
      const stats = log.close();

      // The fragment is terminated where it stopped, so the good line that
      // follows starts its own record instead of extending the fragment.
      expect(readFileSync(log.path, "utf-8")).toBe('{"partial\n{"n":2}\n');
      expect(stats.lines).toBe(2);
      expect(stats.truncated).toBe(true);
    });
  });

  it("treats the cap itself as over the line, so no terminator can push the file past it", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      // EXACTLY the cap, unterminated. A `> MAX` boundary accepts this and then
      // flush() adds the newline that makes the file MAX + 1 — one byte more
      // than foldRunEventLog will read, so a maximally full log folded to
      // nothing while reporting itself complete.
      log.push(Buffer.alloc(RUN_EVENT_LOG_MAX_BYTES, 0x78));
      log.flush();
      const stats = log.close();

      expect(stats.truncated).toBe(true);
      expect(stats.bytes).toBeLessThanOrEqual(RUN_EVENT_LOG_MAX_BYTES);
      // The fold's own precondition — it refuses `size > RUN_EVENT_LOG_MAX_BYTES`
      // — can never be violated by the writer that produced the file.
      expect(statSync(log.path).size).toBe(stats.bytes);
      expect(statSync(log.path).size).toBeLessThanOrEqual(RUN_EVENT_LOG_MAX_BYTES);
    });
  });

  it("loops on a short write, so an interrupted syscall costs the log nothing", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      // Every writeSync takes at most 5 bytes and returns short, exactly as an
      // EINTR-interrupted write does. The fd keeps making progress, so a writer
      // that loops on the return value loses nothing at all.
      fsControl.perWrite = 5;
      const stdout = '{"n":1}\n{"n":2}\n{"n":3}\n';
      log.push(stdout);
      log.flush();
      const stats = log.close();

      expect(readFileSync(log.path, "utf-8")).toBe(stdout);
      expect(stats.lines).toBe(3);
      expect(stats.bytes).toBe(stdout.length);
      expect(stats.truncated).toBe(false);
      expect(stats.error).toBeUndefined();
    });
  });

  it("reports a write that cannot finish instead of counting bytes that never landed", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      // ENOSPC shape: the fd takes 10 bytes of the 16-byte chunk and no more,
      // and has nothing left for the terminator either.
      fsControl.budget = 10;
      log.push('{"n":1}\n{"n":2}\n');
      log.flush();
      const stats = log.close();

      // The byte count is the file, not the intent — over-counting here is what
      // would make an offset-based tail read past the end of the data.
      expect(stats.bytes).toBe(10);
      expect(statSync(log.path).size).toBe(stats.bytes);
      expect(readFileSync(log.path, "utf-8")).toBe('{"n":1}\n{"');
      // Only the line that actually completed is counted, and the file says
      // outright that it is missing bytes.
      expect(stats.lines).toBe(1);
      expect(stats.truncated).toBe(true);
    });
  });

  it("a terminator that cannot be written still resyncs, so a recovered fd splices nothing", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      // The only two records the child ever emitted.
      const opened = '{"type":"assistant","text":"hello"}';
      const result = '{"type":"result","ok":true}';

      // The file is left MID-record...
      log.push(opened.slice(0, 31));
      // ...then the fd stops accepting bytes, and the chunk that crosses the cap
      // ends ON a record boundary — so the skip rule is RIGHT to leave resyncing
      // off for it: the stream itself resumes at a line start. What is NOT right
      // is letting terminate() fail silently here, because the FILE does not.
      const over = Buffer.alloc(RUN_EVENT_LOG_MAX_BYTES, 0x78);
      over[over.length - 1] = 0x0a;
      fsControl.failing = true;
      log.push(over);
      fsControl.failing = false;
      // The disk frees up and the child's next whole record arrives. Appending
      // it would join two non-adjacent stream positions on one line.
      log.push(`${result}\n`);
      log.flush();
      const stats = log.close();

      const raw = readFileSync(log.path, "utf-8");
      // Assert on line CONTENTS, not on whether the file parses: a splice is
      // `<prefix of A><whole B>`, which parses only when the prefix is
      // whitespace, so parsing is a weak signal in both directions. Every line
      // must be a record the child emitted, or a prefix of one cut where the
      // bytes stopped — never bytes from two places in the stream.
      const emitted = [opened, result];
      const lines = raw.split("\n").slice(0, -1);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(emitted.some((record) => record.startsWith(line))).toBe(true);
      }
      // The exact record the resync exists to prevent.
      expect(raw).not.toContain(`hel${result}`);
      // The fragment is closed once the fd recovers, and the whole record that
      // followed the gap is DROPPED rather than spliced — `truncated` is what
      // says those bytes are missing.
      expect(raw).toBe(`${opened.slice(0, 31)}\n`);
      expect(stats.lines).toBe(1);
      expect(stats.truncated).toBe(true);
      expect(stats.error).toBeTypeOf("string");
    });
  });

  it("closes the fragment a failed terminator left open before the next record lands on it", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      // The records the child emitted around the gap.
      const opened = '{"type":"assistant","text":"hello"}';
      const fragment = opened.slice(0, 31);
      const dropped = '{"n":9}';
      const eaten = '{"n":8}';
      const kept = '{"n":7}';

      // Same opening as above — mid-record file, dead fd, cap-crossing chunk
      // that ends on a boundary — but this time the chunk after the gap carries
      // the REST of the open record AND a whole record behind it. Resyncing tells
      // the writer where the STREAM resumed; it says nothing about the fragment
      // still open in the FILE, and that record must not land on it.
      log.push(fragment);
      const over = Buffer.alloc(RUN_EVENT_LOG_MAX_BYTES, 0x78);
      over[over.length - 1] = 0x0a;
      fsControl.failing = true;
      log.push(over);
      log.push(`lo"}\n${dropped}\n`);
      // The fd is still dead, so the fragment still cannot be closed — the whole
      // record behind the boundary is dropped rather than spliced onto it.
      expect(readFileSync(log.path, "utf-8")).toBe(fragment);

      fsControl.failing = false;
      // The fd recovers. The writer is still resynced (it refuses to guess that
      // a file it could not close is safe to append to), so this record is spent
      // as the boundary that closes the fragment — the cost of a terminator that
      // failed twice, and `truncated` is what reports it.
      log.push(`${eaten}\n`);
      log.push(`${kept}\n`);
      log.flush();
      const stats = log.close();

      const raw = readFileSync(log.path, "utf-8");
      const emitted = [opened, dropped, eaten, kept];
      for (const line of raw.split("\n").slice(0, -1)) {
        expect(emitted.some((record) => record.startsWith(line))).toBe(true);
      }
      expect(raw).toBe(`${fragment}\n${kept}\n`);
      expect(stats.lines).toBe(2);
      expect(stats.truncated).toBe(true);
    });
  });

  it("a flush terminator that fails reports the file it actually left behind", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      // Every byte the child wrote LANDS; the only write that fails is the
      // terminator flush() adds of its own.
      log.push('{"n":1}\n{"n":2}');
      fsControl.failing = true;
      log.flush();
      fsControl.failing = false;
      const stats = log.close();

      const raw = readFileSync(log.path, "utf-8");
      expect(raw).toBe('{"n":1}\n{"n":2}');
      // The invariant chosen: `truncated: false` promises BOTH "no bytes lost"
      // AND "ends on a line boundary". This file loses nothing but ends mid-line,
      // so it must report `truncated: true` — otherwise `truncated: false` with
      // an `error` set reads as "the log never opened" and an offset tail
      // mis-frames the last record of a file it was told to trust.
      expect(raw.endsWith("\n")).toBe(false);
      expect(stats.truncated).toBe(true);
      expect(stats.error).toBeTypeOf("string");
      // And the stats still describe the file rather than the intent.
      expect(stats.bytes).toBe(statSync(log.path).size);
      expect(stats.lines).toBe(raw.split("\n").length - 1);
    });
  });

  it("keeps a whole record that follows a short write ending on a boundary", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const log = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      // The fd takes exactly the first record of the chunk and refuses the rest,
      // then recovers completely. The lost bytes are the chunk's TAIL, so the
      // stream stands at the chunk's last byte — a newline. The next chunk
      // therefore starts a fresh record and skipping it would cost a whole
      // record for nothing.
      fsControl.budget = 8;
      log.push('{"n":1}\n{"n":2}\n');
      fsControl.budget = -1;
      log.push('{"n":3}\n');
      log.flush();
      const stats = log.close();

      expect(readFileSync(log.path, "utf-8")).toBe('{"n":1}\n{"n":3}\n');
      expect(stats.lines).toBe(2);
      // The hole in the middle is still announced.
      expect(stats.truncated).toBe(true);
    });
  });

  it("a capped log is distinguishable from a child that said nothing", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = projectDirIn(dir);
      const capped = openRunEventLog({ projectDir, sessionId: SESSION, runId: RUN });
      capped.push(Buffer.alloc(RUN_EVENT_LOG_MAX_BYTES, 0x78));
      capped.flush();
      const cappedStats = capped.close();

      const silent = openRunEventLog({ projectDir, sessionId: SESSION, runId: "silent-run" });
      silent.flush();
      const silentStats = silent.close();

      // Both wrote zero lines and zero bytes — `lines` alone cannot tell a
      // runaway child from a mute one. `truncated` is the whole difference.
      expect([cappedStats.lines, silentStats.lines]).toEqual([0, 0]);
      expect([cappedStats.bytes, silentStats.bytes]).toEqual([0, 0]);
      expect(cappedStats.truncated).toBe(true);
      expect(silentStats.truncated).toBe(false);
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
