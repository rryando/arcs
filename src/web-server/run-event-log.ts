/**
 * Per-run stdout event log — the durable spine of a headless `claude -p` run.
 *
 * Owns `sessions/{normalizedId}.run-{runId}.events.jsonl`: every byte the child
 * writes to stdout lands here VERBATIM, one file line per stdout line, BEFORE
 * anything parses it. That ordering is the whole point — the log is the source
 * of truth and the runner's NDJSON reader is merely its first consumer, so a
 * line the reader cannot parse (drifted wire format, truncated JSON, an event
 * type that did not exist when this shipped) is still on disk, and a process
 * that dies mid-run still leaves behind everything that arrived.
 *
 * Writes are synchronous (`writeSync` against an fd opened with "a") for
 * exactly that reason: an async queue would only ever have *issued* the write
 * before the parse, and a hard kill would lose whatever was still in flight.
 * The chunks are small and few (one per stdout chunk of a single child), so the
 * event-loop cost is a rounding error against a run measured in minutes.
 *
 * The `runId` in the filename is the SAME id the route persists as
 * `currentRunId`, so the log's name and the session record can never disagree
 * about which run produced it.
 *
 * Total by construction, like the reader it feeds: nothing here throws. A log
 * that cannot be opened or written reports itself through `RunEventLogStats`
 * and the run proceeds untouched — a logging failure must never fail a run.
 * Reporting is the whole point: a log that hit its size cap or lost bytes to a
 * short write says so on `truncated`, which rides all the way out to
 * `metadata.run.eventLogTruncated`. A silent fallback here would make an empty
 * log and a capped one look identical to every consumer downstream.
 *
 * At settle the log folds down into the transcript sidecar (assistant text plus
 * one turn per `tool_use`) through `appendSessionTurn` (run-transcript.ts), and
 * older logs for the same segment are pruned so the sessions dir cannot grow
 * without limit.
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendSessionTurn, readSessionTurns } from "../utils/run-transcript.js";
import { normalizeIdentifier } from "../utils/slug.js";
import type { SessionRuntimeType } from "../utils/storage-utils.js";
import { getRunDriver } from "./run-driver.js";

/**
 * Ceiling on one run's log — a runaway child cannot fill the disk.
 *
 * The finished file is never LARGER than this, terminator included: the writer
 * refuses a chunk that would take it TO the cap (`>=`, not `>`), leaving the one
 * byte `flush()` may still need. The off-by-one that leaves matters because
 * `foldRunEventLog` refuses to read anything past this size — a writer allowed
 * to land on exactly the cap and then add a terminator produces a file its own
 * fold silently discards.
 *
 * Reaching it does not close the log: only the crossing chunk is refused, later
 * chunks that still fit are still written, and `RunEventLogStats.truncated`
 * reports that bytes are missing. The file always ends on a line boundary, so an
 * offset-based tail never reads half a record.
 */
export const RUN_EVENT_LOG_MAX_BYTES = 32 * 1024 * 1024;

/**
 * How many event logs a single session keeps. Count-based rather than
 * age-based: a count is a hard bound (N logs per session, at most
 * RUN_EVENT_LOG_MAX_BYTES each), while an age window still admits unbounded
 * growth from a session that runs in a tight loop.
 */
export const RUN_EVENT_LOG_RETENTION = 5;

const LOG_SUFFIX = ".events.jsonl";
const NEWLINE = 0x0a;
/** The only byte the log ever adds of its own: a line terminator. */
const TERMINATOR = Buffer.from("\n", "utf-8");

/** Which run's stdout a log belongs to. */
export interface RunEventLogTarget {
  /** Project data dir — the log lives under its `sessions/`. */
  projectDir: string;
  /** Canonical `normalizedId` of the write-target session. */
  sessionId: string;
  /** The run's id — the SAME one persisted as `currentRunId`. */
  runId: string;
}

/** What a finished log wrote, for the run record's diagnostics. */
export interface RunEventLogStats {
  /** Complete lines appended (the terminator added at flush counts its line). */
  lines: number;
  /** Bytes appended — always exactly the size of the file on disk. */
  bytes: number;
  /**
   * The file is INCOMPLETE: bytes the child wrote are not in it, because a chunk
   * crossed RUN_EVENT_LOG_MAX_BYTES or a write landed short. What IS there is
   * still whole lines in stream order — but this file is no longer the whole
   * stream, so nothing may read it (or tail it by offset) as if it were.
   *
   * Surfaced all the way to `metadata.run.eventLogTruncated`: without it a
   * capped log reports `eventLogLines: 0` and is indistinguishable from a child
   * that said nothing at all.
   *
   * `truncated: false` is the strong claim and holds even when `error` is set:
   * every byte the child wrote is in the file AND the file ends on a line
   * boundary. An error beside it belongs to a failure that cost no bytes — the
   * log never opened (`bytes: 0`, nothing was ever written) or the fd failed to
   * close after everything had landed. Anything that loses bytes or leaves the
   * last line open, a failed terminator write included, sets `truncated`.
   */
  truncated: boolean;
  /** First open/write failure, reported rather than thrown. */
  error?: string;
}

export interface RunEventLogHandle {
  /** Where the log lives; empty string for the no-op handle. */
  readonly path: string;
  /** Appends a raw stdout chunk verbatim. Never throws. */
  push(chunk: Buffer | string): void;
  /** Terminates a final line that arrived without its newline. Never throws. */
  flush(): void;
  /** Closes the fd and reports what was written. Never throws. */
  close(): RunEventLogStats;
}

/**
 * Filename-safe form of a run id. The id reaches a path, so it is sanitized
 * rather than trusted: anything outside `[A-Za-z0-9_-]` (`/`, `.`, `..`) becomes
 * `-` before it can traverse out of the sessions dir.
 */
export function runEventLogSegment(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  return safe === "" ? "unknown" : safe;
}

/**
 * Log path for one run. Keys on the session's canonical `normalizedId` exactly
 * as the transcript sidecar does, so both files for a session sort together and
 * neither can be derived from a raw route id.
 */
export function runEventLogPath(projectDir: string, sessionId: string, runId: string): string {
  const name = `${normalizeIdentifier(sessionId)}.run-${runEventLogSegment(runId)}${LOG_SUFFIX}`;
  return join(projectDir, "sessions", name);
}

/** The handle a run with no log target gets — every method is a no-op. */
const NOOP_HANDLE: RunEventLogHandle = {
  path: "",
  push(): void {},
  flush(): void {},
  close(): RunEventLogStats {
    return { lines: 0, bytes: 0, truncated: false };
  },
};

/**
 * Opens (creating) the run's log and returns a write-through handle.
 *
 * The file is created up front, so a run that produces no stdout at all — a
 * child killed at its deadline before it spoke, an immediate non-zero exit —
 * still leaves the log behind. `undefined` target yields the no-op handle, which
 * is how the runner stays usable without a project dir (tests, and any caller
 * that does not want a log).
 */
export function openRunEventLog(target: RunEventLogTarget | undefined): RunEventLogHandle {
  if (target === undefined) return NOOP_HANDLE;

  const path = runEventLogPath(target.projectDir, target.sessionId, target.runId);
  let fd: number | null = null;
  let lines = 0;
  let bytes = 0;
  let truncated = false;
  let closed = false;
  let endsWithNewline = true;
  /**
   * Bytes were dropped part-way through a record, so the stream now continues
   * INSIDE a line this file does not have. Appending those bytes would splice
   * the tail of a record the log never took onto whatever precedes it and emit
   * a line the child never wrote, so they are dropped until the next newline.
   */
  let resyncing = false;
  let error: string | undefined;

  const note = (err: unknown): void => {
    if (error === undefined) error = String(err);
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
    // "a" — the kernel appends at every write, so nothing here has to track a
    // file position and a concurrent reader (the tail) can never see a hole.
    fd = openSync(path, "a");
  } catch (err) {
    note(err);
  }

  const stats = (): RunEventLogStats => ({
    lines,
    bytes,
    truncated,
    ...(error !== undefined && { error }),
  });

  /**
   * Appends `buf` whole, returning how many of its bytes actually landed.
   *
   * `writeSync` may return SHORT — a signal interrupting the syscall (EINTR), a
   * filesystem that ran out of room mid-buffer (ENOSPC) — and its return value
   * is the only place that ever shows. Discarding it emits half a record while
   * counting a whole one, which breaks "always ends on a line boundary" exactly
   * when the disk is full. So the loop keeps writing while the fd makes
   * progress, and reports precisely how far it got. `n <= 0` ends the loop
   * rather than spinning on an fd that has stopped accepting bytes.
   */
  const writeAll = (handle: number, buf: Buffer): number => {
    let written = 0;
    while (written < buf.length) {
      let n: number;
      try {
        n = writeSync(handle, buf, written, buf.length - written);
      } catch (err) {
        note(err);
        break;
      }
      if (n <= 0) break;
      written += n;
    }
    return written;
  };

  /** Counts what landed: bytes, whole lines, and where the file now ends. */
  const account = (buf: Buffer): void => {
    if (buf.length === 0) return;
    bytes += buf.length;
    // Native indexOf rather than a per-byte loop: a megabyte chunk must not
    // cost a million iterations on the event loop.
    for (let at = buf.indexOf(NEWLINE); at !== -1; at = buf.indexOf(NEWLINE, at + 1)) {
      lines += 1;
    }
    endsWithNewline = buf[buf.length - 1] === NEWLINE;
  };

  /**
   * Closes a line the child left open. The only byte the log adds of its own,
   * and only when the file would otherwise not end on a line boundary — an
   * offset-based tail would mis-frame the last record without it.
   *
   * Runs at flush() AND the instant a chunk is refused or lands short, not just
   * at close: after a gap in the stream the next accepted chunk must start its
   * own line rather than extend the fragment before the gap.
   *
   * The terminator write can itself fail, and failing SILENTLY is how a
   * fabricated line survives every other guard here: the file is left
   * un-line-closed with `resyncing` unset, so an fd that recovers splices the
   * next chunk onto the open fragment. A terminator that does not land therefore
   * sets BOTH flags — `truncated` because the file is no longer line-framed, and
   * `resyncing` because nothing may extend that fragment ever again.
   */
  const terminate = (handle: number): void => {
    if (endsWithNewline || bytes === 0) return;
    if (writeAll(handle, TERMINATOR) !== TERMINATOR.length) {
      truncated = true;
      resyncing = true;
      return;
    }
    account(TERMINATOR);
  };

  return {
    path,
    push(chunk: Buffer | string): void {
      if (fd === null || closed) return;
      let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf-8");
      if (buf.length === 0) return;

      if (resyncing) {
        const at = buf.indexOf(NEWLINE);
        // Still inside the record whose bytes were dropped — all of it belongs
        // to that record, none of it is a line this file may claim to hold.
        if (at === -1) return;
        buf = buf.subarray(at + 1);
        resyncing = false;
        // The stream is back at a record start, but the FILE may not be: a
        // terminator that failed AT the gap left an open fragment behind, and
        // knowing where the stream resumed does nothing about it. Close it here,
        // before any of these bytes can land on it — the two questions are
        // different and only this one keeps the next whole record off the
        // fragment. A no-op whenever the file already ends on a boundary.
        terminate(fd);
        // Still open: the fd will not take even one byte, so stay resynced (a
        // failed terminate re-arms it) and drop this record too. A fabricated
        // line is not detectable downstream; a missing one is.
        if (resyncing) return;
        if (buf.length === 0) return;
      }

      if (bytes + buf.length >= RUN_EVENT_LOG_MAX_BYTES) {
        // The CROSSING chunk is refused whole — never half a record — but the
        // log stays open. Returning early here for the rest of the run turned
        // one oversized chunk into a 0-byte file; now every later chunk that
        // still fits is still kept, and `truncated` is what says the file is no
        // longer the whole stream. `>=` reserves the byte terminate() may add,
        // so the finished file never exceeds the size the fold agrees to read.
        truncated = true;
        // The dropped bytes end mid-record unless the chunk's own last byte was
        // a terminator; only then does the next chunk start a fresh line.
        resyncing = buf[buf.length - 1] !== NEWLINE;
        terminate(fd);
        return;
      }

      const written = writeAll(fd, buf);
      account(buf.subarray(0, written));
      if (written === buf.length) return;
      // A short write: this record is on disk in part only and the stream
      // continues from bytes that are gone. Same treatment as the cap — say the
      // file is incomplete, close the half-written line, and skip to the next
      // boundary instead of splicing the next chunk onto a fragment.
      truncated = true;
      // The lost bytes are `buf[written..]`, so the stream stands exactly where
      // it does after a refusal: at `buf`'s last byte. Same rule as the cap,
      // deliberately — hardcoding a resync here is safe in direction but throws
      // away a whole record that begins at a record boundary, for nothing.
      resyncing = buf[buf.length - 1] !== NEWLINE;
      terminate(fd);
    },
    flush(): void {
      if (fd === null || closed) return;
      terminate(fd);
    },
    close(): RunEventLogStats {
      if (fd !== null && !closed) {
        try {
          closeSync(fd);
        } catch (err) {
          note(err);
        }
      }
      closed = true;
      return stats();
    },
  };
}

// ---------------------------------------------------------------------------
// Fold-down into the transcript sidecar
// ---------------------------------------------------------------------------

export interface RunFoldResult {
  /** Turns this call appended to the sidecar. */
  appended: number;
  /** The sidecar already carried this run's turns — nothing was written. */
  alreadyFolded: boolean;
  /** An assistant TEXT turn for this run is in the sidecar (from either call). */
  assistantTextFolded: boolean;
  /**
   * The runtime-native session id a driver normalizer harvested from the log,
   * when one folded it and any line carried an id. This is what lets a first
   * turn lazily mint the session's `runtimeSessionId` — the caller persists it
   * after the run settles. Absent for the built-in claude parser (claude ids
   * reach the record through metadata, not this fold) and when no line had one.
   */
  runtimeSessionId?: string;
}

const EMPTY_FOLD: RunFoldResult = {
  appended: 0,
  alreadyFolded: false,
  assistantTextFolded: false,
};

/** One turn the fold will append, in stream order. */
interface FoldTurn {
  text: string;
  tool?: { name: string };
}

function isBlock(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turns one stream-json `assistant` event yields, in content-block order.
 *
 * Consecutive text blocks coalesce into one turn; every `tool_use` block gets
 * its own turn (unlike the transcript mirror, which keeps only the first) so a
 * message that fans out to three tools reads as three rows. Only completed
 * `assistant` messages are folded: `stream_event` deltas repeat their text and
 * the terminal `result` repeats the final message, so both would duplicate.
 */
function foldAssistantEvent(event: Record<string, unknown>): FoldTurn[] {
  const message = event.message;
  if (!isBlock(message)) return [];
  const content = message.content;
  if (typeof content === "string") return content === "" ? [] : [{ text: content }];
  if (!Array.isArray(content)) return [];

  const turns: FoldTurn[] = [];
  let text = "";
  const flushText = (): void => {
    if (text === "") return;
    turns.push({ text });
    text = "";
  };
  for (const block of content) {
    if (!isBlock(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
      continue;
    }
    if (block.type === "tool_use" && typeof block.name === "string") {
      flushText();
      turns.push({ text: "", tool: { name: block.name } });
    }
  }
  flushText();
  return turns;
}

/** Every turn the log implies, in the order the child emitted them. */
function foldTurns(raw: string): FoldTurn[] {
  const turns: FoldTurn[] = [];
  for (const line of raw.split("\n")) {
    const text = (line.endsWith("\r") ? line.slice(0, -1) : line).trim();
    if (text === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue; // unparsable lines stay in the log; they just fold to nothing
    }
    if (!isBlock(value) || value.type !== "assistant") continue;
    turns.push(...foldAssistantEvent(value));
  }
  return turns;
}

/**
 * Options for one fold. Everything is optional: absent, the fold behaves
 * exactly as it always has — the built-in claude stream-json parser.
 */
export interface FoldRunEventLogOptions {
  /**
   * The write-target's runtime type. When a one-shot driver adapter is
   * registered for it (run-driver.ts), the log folds through that adapter's
   * normalizer instead of the claude parser — an opencode log's lines are
   * `{type, sessionID, part}` objects no `assistant` event parser can read.
   */
  runtimeType?: SessionRuntimeType;
}

/**
 * Folds a run's event log down into the segment's transcript sidecar: assistant
 * text plus one turn per `tool_use`, appended through `appendSessionTurn` in
 * stream order, each tagged with the run id.
 *
 * Idempotence mechanism: the fold's OWN OUTPUT is the marker. Every appended
 * turn carries `run: <runId>`, and a fold refuses as soon as the sidecar holds
 * any turn tagged with that id. This was chosen over a separate marker (a
 * `foldedAt` on the run record, a `.folded` sentinel file) precisely because a
 * separate marker has a window: a crash between "turns appended" and "marker
 * written" would re-fold and duplicate the whole run on the next settle. Here
 * there is no window — the evidence and the mark are the same bytes. The cost
 * is at-most-once rather than exactly-once under a crash MID-fold (the turns
 * already appended are tagged, so the remainder is never completed), which is
 * the safe direction: a short transcript, never a doubled one.
 *
 * Never throws — a fold that cannot read the log or write the sidecar reports
 * an empty result and the settle continues.
 */
export async function foldRunEventLog(
  projectDir: string,
  sessionId: string,
  runId: string,
  options: FoldRunEventLogOptions = {},
): Promise<RunFoldResult> {
  try {
    const path = runEventLogPath(projectDir, sessionId, runId);
    const info = await stat(path);
    if (!info.isFile() || info.size > RUN_EVENT_LOG_MAX_BYTES) return EMPTY_FOLD;

    // The mark IS the data: any turn already tagged with this run id means a
    // previous fold got there first.
    const existing = await readSessionTurns(projectDir, sessionId);
    const tagged = existing.filter((turn) => turn.run === runId);
    if (tagged.length > 0) {
      return {
        appended: 0,
        alreadyFolded: true,
        assistantTextFolded: tagged.some((turn) => turn.type === "assistant" && turn.text !== ""),
      };
    }

    const raw = await readFile(path, "utf-8");
    const driver =
      options.runtimeType !== undefined ? getRunDriver(options.runtimeType) : undefined;
    let turns: FoldTurn[];
    let runtimeSessionId: string | undefined;
    if (driver !== undefined) {
      const fold = driver.foldOutput(raw);
      turns = fold.turns.map(({ text, tool }) => ({
        text,
        ...(tool !== undefined && { tool }),
      }));
      runtimeSessionId = fold.runtimeSessionId;
    } else {
      turns = foldTurns(raw);
    }
    // A run that spoke no reply content still minted its runtime session id —
    // losing it would fork a fresh thread on the next turn. Report it even when
    // there is nothing to append.
    if (turns.length === 0) {
      return runtimeSessionId === undefined ? EMPTY_FOLD : { ...EMPTY_FOLD, runtimeSessionId };
    }

    let appended = 0;
    let assistantTextFolded = false;
    for (const turn of turns) {
      // Sequential on purpose: `appendSessionTurn` mints its negative id from
      // what is already on disk, so concurrent appends would collide.
      await appendSessionTurn(projectDir, sessionId, {
        type: "assistant",
        text: turn.text,
        run: runId,
        ...(turn.tool !== undefined && { tool: turn.tool }),
      });
      appended += 1;
      if (turn.tool === undefined && turn.text !== "") assistantTextFolded = true;
    }
    return {
      appended,
      alreadyFolded: false,
      assistantTextFolded,
      ...(runtimeSessionId !== undefined && { runtimeSessionId }),
    };
  } catch {
    // Missing log, unreadable sidecar, a full disk — all fold to nothing.
    return EMPTY_FOLD;
  }
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Keeps the newest `keep` event logs for one session and deletes the rest.
 *
 * Called at EVERY settle (after the fold), so the log that just settled is
 * always among the survivors and the sessions dir is bounded at `keep` logs per
 * session no matter how many runs a session accumulates. "Every settle" means
 * the startup orphan sweep too (`settleOrphanedRuns`): a server that dies
 * mid-run never reaches the route's write-back, so without that call site a
 * session whose runs are always interrupted grows one capped log per run
 * forever. `keep: 0` drops them all — what session deletion uses.
 *
 * Never throws; returns how many files it removed.
 */
export async function pruneRunEventLogs(
  projectDir: string,
  sessionId: string,
  keep: number = RUN_EVENT_LOG_RETENTION,
): Promise<number> {
  try {
    const sessionsDir = join(projectDir, "sessions");
    const prefix = `${normalizeIdentifier(sessionId)}.run-`;
    const names = (await readdir(sessionsDir)).filter(
      (name) =>
        name.startsWith(prefix) &&
        name.endsWith(LOG_SUFFIX) &&
        name.length > prefix.length + LOG_SUFFIX.length,
    );
    if (names.length <= keep) return 0;

    const dated = await Promise.all(
      names.map(async (name) => {
        try {
          return { name, mtimeMs: (await stat(join(sessionsDir, name))).mtimeMs };
        } catch {
          // Vanished under us — sort it to the front so it is dropped first.
          return { name, mtimeMs: 0 };
        }
      }),
    );
    // Newest first; the name breaks mtime ties (same-millisecond runs) so the
    // ordering is total and the prune is deterministic.
    dated.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));

    let pruned = 0;
    for (const entry of dated.slice(Math.max(keep, 0))) {
      try {
        await unlink(join(sessionsDir, entry.name));
        pruned += 1;
      } catch {
        // Already gone or locked — retention is best-effort.
      }
    }
    return pruned;
  } catch {
    return 0;
  }
}
