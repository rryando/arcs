/**
 * GET /api/p/:slug/sessions/:id/runs/:runId/stream — the offset-idempotent tail
 * of one run's durable event log.
 *
 * No runner is faked here, deliberately: the route never talks to the runner. It
 * reads two things — the per-run NDJSON event log on disk and the session's run
 * claim — so the tests write exactly those and assert what comes back on the
 * wire. That is also the property under test: everything the stream says is
 * derived from the file plus `?from=`, so a fresh server process answers the
 * same GET with the same bytes.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  beginSessionRun,
  createSession,
  getSession,
  settleSessionRun,
  updateSession,
} from "../src/utils/session-store.js";
import { createApp } from "../src/web-server/app.js";
import { startWebServer, type WebServerHandle } from "../src/web-server/index.js";
import { runEventLogPath } from "../src/web-server/run-event-log.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const WORKSPACE = "/work/demo";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
/** The route as Hono registers it — the signature the token gate is walked for. */
const STREAM_PATH = "/api/p/:slug/sessions/:id/runs/:runId/stream";
const MUTATION_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface StreamCtx {
  projectDir: string;
  base: string;
  /** Drops the server and boots a new one on the same data dir. */
  restart(): Promise<string>;
}

async function withStreamCtx(run: (ctx: StreamCtx) => Promise<void>): Promise<void> {
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
      await run({
        projectDir,
        base: server.url,
        restart: async () => {
          await server?.close();
          server = await startWebServer({ port: 0, host: "127.0.0.1", watch: false });
          return server.url;
        },
      });
    } finally {
      await server?.close();
    }
  });
}

/** A stream-json assistant event, as the child writes it to stdout. */
function eventLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

/** Appends raw bytes to the run's event log, exactly as the writer would. */
function appendLog(projectDir: string, sessionId: string, runId: string, raw: string): void {
  const path = runEventLogPath(projectDir, sessionId, runId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, raw, "utf-8");
}

/** Appends whole, newline-terminated lines. */
function appendLines(projectDir: string, sessionId: string, runId: string, lines: string[]): void {
  appendLog(projectDir, sessionId, runId, lines.map((line) => `${line}\n`).join(""));
}

/** A claude-code session holding a live run claim for `runId`. */
async function seedClaimedRun(
  projectDir: string,
  runId = RUN_ID,
  runtimeSessionId = "arcs-thread-demo-1",
): Promise<string> {
  const session = await createSession(projectDir, {
    runtimeType: "claude-code",
    runtimeSessionId,
    metadata: { directory: WORKSPACE },
  });
  await beginSessionRun(projectDir, session.normalizedId, { runId });
  return session.normalizedId;
}

/** Releases the claim and stamps the outcome, as the run write-back does. */
async function settle(
  projectDir: string,
  sessionId: string,
  runId = RUN_ID,
  outcome: "success" | "error" | "timeout" | "interrupted" = "success",
): Promise<void> {
  await settleSessionRun(projectDir, sessionId, { runId, outcome });
}

function streamUrl(base: string, sessionId: string, query = "", runId = RUN_ID): string {
  return `${base}/api/p/demo/sessions/${sessionId}/runs/${runId}/stream${query}`;
}

// ---------------------------------------------------------------------------
// SSE reading
// ---------------------------------------------------------------------------

interface SseFrame {
  event: string;
  id: string | undefined;
  data: Record<string, unknown>;
}

const FRAME_TIMEOUT_MS = 4_000;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function parseFrame(block: string): SseFrame {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  return { event, id, data: JSON.parse(data.join("\n")) as Record<string, unknown> };
}

/**
 * Reads an open SSE response in the background, so a test can assert both what
 * arrived and that NOTHING arrived (`idle`) without ever dropping a chunk to an
 * abandoned `read()`.
 */
function frameReader(res: Response) {
  const body = res.body;
  if (body === null) throw new Error("SSE response carried no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffered = "";
  let ended = false;

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        for (;;) {
          const at = buffered.indexOf("\n\n");
          if (at === -1) break;
          const block = buffered.slice(0, at);
          buffered = buffered.slice(at + 2);
          if (block.trim() !== "") frames.push(parseFrame(block));
        }
      }
    } catch {
      // Cancelled by the test — that is a clean end for this reader.
    }
    ended = true;
  })();

  return {
    frames,
    /** Waits until `done(frames)` holds; fails loudly rather than hanging. */
    async until(label: string, done: (seen: SseFrame[]) => boolean): Promise<SseFrame[]> {
      const deadline = Date.now() + FRAME_TIMEOUT_MS;
      while (!done(frames)) {
        if (ended) throw new Error(`stream ended before ${label}: ${JSON.stringify(frames)}`);
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${label}: ${JSON.stringify(frames)}`);
        }
        await sleep(10);
      }
      return [...frames];
    },
    /** Frames that arrived during `ms` of deliberate waiting. */
    async idle(ms: number): Promise<number> {
      const before = frames.length;
      await sleep(ms);
      return frames.length - before;
    },
    async cancel(): Promise<void> {
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

/** Reads a stream the server closes by itself, to its final frame. */
async function readToEnd(url: string, init: RequestInit = {}): Promise<SseFrame[]> {
  const res = await fetch(url, init);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = frameReader(res);
  try {
    return await reader.until("the end frame", (seen) => seen.some((f) => f.event === "end"));
  } finally {
    await reader.cancel();
  }
}

const lineFrames = (frames: SseFrame[]): SseFrame[] => frames.filter((f) => f.event === "line");
const offsets = (frames: SseFrame[]): unknown[] => lineFrames(frames).map((f) => f.data.offset);
const texts = (frames: SseFrame[]): unknown[] => lineFrames(frames).map((f) => f.data.line);

// ---------------------------------------------------------------------------
// Replay after settle
// ---------------------------------------------------------------------------

describe("GET /api/p/:slug/sessions/:id/runs/:runId/stream — replay after settle", () => {
  it("replays the whole log from line 0 and closes, one frame per line with its absolute offset", async () => {
    await withStreamCtx(async ({ projectDir, base }) => {
      const sessionId = await seedClaimedRun(projectDir);
      const lines = [eventLine("one"), eventLine("two"), eventLine("three")];
      appendLines(projectDir, sessionId, RUN_ID, lines);
      await settle(projectDir, sessionId);

      const frames = await readToEnd(streamUrl(base, sessionId));

      expect(offsets(frames)).toEqual([0, 1, 2]);
      expect(texts(frames)).toEqual(lines);
      // The SSE id is the RESUME cursor, not the frame's own index.
      expect(lineFrames(frames).map((f) => f.id)).toEqual(["1", "2", "3"]);
      expect(frames[frames.length - 1]).toEqual({
        event: "end",
        id: "3",
        data: { offset: 3, outcome: "success", truncated: false },
      });
    });
  });

  it("starts at ?from=N, never re-sending a line the caller already holds", async () => {
    await withStreamCtx(async ({ projectDir, base }) => {
      const sessionId = await seedClaimedRun(projectDir);
      appendLines(projectDir, sessionId, RUN_ID, [
        eventLine("one"),
        eventLine("two"),
        eventLine("three"),
      ]);
      await settle(projectDir, sessionId);

      const frames = await readToEnd(streamUrl(base, sessionId, "?from=2"));

      expect(offsets(frames)).toEqual([2]);
      expect(texts(frames)).toEqual([eventLine("three")]);
      // Offsets stay ABSOLUTE: the skipped lines still occupy indices 0 and 1.
      expect(frames[frames.length - 1]?.data).toEqual({
        offset: 3,
        outcome: "success",
        truncated: false,
      });
    });
  });

  it("answers a from past the end with the end frame alone", async () => {
    await withStreamCtx(async ({ projectDir, base }) => {
      const sessionId = await seedClaimedRun(projectDir);
      appendLines(projectDir, sessionId, RUN_ID, [eventLine("one")]);
      await settle(projectDir, sessionId, RUN_ID, "error");

      const frames = await readToEnd(streamUrl(base, sessionId, "?from=99"));

      expect(lineFrames(frames)).toEqual([]);
      expect(frames).toEqual([
        { event: "end", id: "1", data: { offset: 1, outcome: "error", truncated: false } },
      ]);
    });
  });

  it("reports a truncated log on the end frame, so a consumer knows it reached a hole", async () => {
    await withStreamCtx(async ({ projectDir, base }) => {
      const sessionId = await seedClaimedRun(projectDir);
      appendLines(projectDir, sessionId, RUN_ID, [eventLine("all that fit")]);
      await settle(projectDir, sessionId);
      // What the run write-back merges onto metadata.run when the log hit its
      // cap or lost bytes to a short write.
      const settled = await getSession(projectDir, sessionId);
      const run = settled.metadata?.run as Record<string, unknown>;
      await updateSession(projectDir, {
        id: sessionId,
        metadata: { run: { ...run, eventLogTruncated: true } },
      });

      const frames = await readToEnd(streamUrl(base, sessionId));

      expect(offsets(frames)).toEqual([0]);
      expect(frames[frames.length - 1]?.data).toEqual({
        offset: 1,
        outcome: "success",
        truncated: true,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Live tail
// ---------------------------------------------------------------------------

describe("GET .../runs/:runId/stream — live tail", () => {
  it("streams lines written after the connection opened, then closes when the run settles", async () => {
    await withStreamCtx(async ({ projectDir, base }) => {
      const sessionId = await seedClaimedRun(projectDir);
      appendLines(projectDir, sessionId, RUN_ID, [eventLine("first")]);

      const res = await fetch(streamUrl(base, sessionId));
      expect(res.status).toBe(200);
      const reader = frameReader(res);
      try {
        await reader.until("the first line", (seen) => lineFrames(seen).length === 1);

        appendLines(projectDir, sessionId, RUN_ID, [eventLine("second"), eventLine("third")]);
        await reader.until("the live lines", (seen) => lineFrames(seen).length === 3);
        // Still open: the run holds its claim, so nothing has ended.
        expect(reader.frames.some((f) => f.event === "end")).toBe(false);

        await settle(projectDir, sessionId);
        const frames = await reader.until("the end frame", (seen) =>
          seen.some((f) => f.event === "end"),
        );

        expect(offsets(frames)).toEqual([0, 1, 2]);
        expect(texts(frames)).toEqual([
          eventLine("first"),
          eventLine("second"),
          eventLine("third"),
        ]);
        expect(frames[frames.length - 1]?.data).toEqual({
          offset: 3,
          outcome: "success",
          truncated: false,
        });
      } finally {
        await reader.cancel();
      }
    });
  });

  it("tails a run whose log does not exist yet — the claim precedes the child", async () => {
    await withStreamCtx(async ({ projectDir, base }) => {
      const sessionId = await seedClaimedRun(projectDir);

      const res = await fetch(streamUrl(base, sessionId));
      expect(res.status).toBe(200);
      const reader = frameReader(res);
      try {
        expect(await reader.idle(150)).toBe(0);
        appendLines(projectDir, sessionId, RUN_ID, [eventLine("spoke at last")]);
        const frames = await reader.until(
          "the first line",
          (seen) => lineFrames(seen).length === 1,
        );
        expect(frames[0]?.data).toEqual({ offset: 0, line: eventLine("spoke at last") });
      } finally {
        await reader.cancel();
      }
    });
  });

  it("never emits a trailing partial line, and emits it exactly once when it completes", async () => {
    await withStreamCtx(async ({ projectDir, base }) => {
      const sessionId = await seedClaimedRun(projectDir);
      appendLines(projectDir, sessionId, RUN_ID, [eventLine("one"), eventLine("two")]);
      // The child is mid-write: bytes at EOF with no terminator yet.
      const partial = eventLine("three");
      const head = partial.slice(0, 20);
      appendLog(projectDir, sessionId, RUN_ID, head);

      const res = await fetch(streamUrl(base, sessionId));
      const reader = frameReader(res);
      try {
        await reader.until("the two whole lines", (seen) => lineFrames(seen).length === 2);
        // Several poll cycles: the fragment must stay unsent for all of them.
        expect(await reader.idle(350)).toBe(0);

        appendLog(projectDir, sessionId, RUN_ID, `${partial.slice(20)}\n`);
        await settle(projectDir, sessionId);
        const frames = await reader.until("the end frame", (seen) =>
          seen.some((f) => f.event === "end"),
        );

        expect(offsets(frames)).toEqual([0, 1, 2]);
        // Whole, once, verbatim — not the fragment and not the fragment twice.
        expect(texts(frames)).toEqual([eventLine("one"), eventLine("two"), partial]);
      } finally {
        await reader.cancel();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Offset idempotence
// ---------------------------------------------------------------------------

describe("GET .../runs/:runId/stream — offset idempotence", () => {
  it("reconnecting at the last seen offset neither duplicates nor skips a line", async () => {
    await withStreamCtx(async ({ projectDir, base }) => {
      const sessionId = await seedClaimedRun(projectDir);
      const all = ["one", "two", "three", "four"].map(eventLine);
      appendLines(projectDir, sessionId, RUN_ID, all.slice(0, 2));

      // Connection 1 — a client that dies after two lines.
      const first = frameReader(await fetch(streamUrl(base, sessionId)));
      const seen = await first.until("two lines", (f) => lineFrames(f).length === 2);
      await first.cancel();
      // The resume cursor the client carries: the SSE id of the last frame it saw.
      const resumeAt = seen[seen.length - 1]?.id;
      expect(resumeAt).toBe("2");

      // The run keeps going while nothing is attached, then settles.
      appendLines(projectDir, sessionId, RUN_ID, all.slice(2));
      await settle(projectDir, sessionId);

      // Connection 2 — the reconnect, at the offset the client actually holds.
      const resumed = await readToEnd(streamUrl(base, sessionId, `?from=${resumeAt}`));

      expect(offsets(seen)).toEqual([0, 1]);
      expect(offsets(resumed)).toEqual([2, 3]);
      // The union is the log, once each, in order — no duplicate, no gap.
      expect([...texts(seen), ...texts(resumed)]).toEqual(all);
    });
  });

  it("honours Last-Event-ID, so an EventSource auto-reconnect on a frozen URL does not replay", async () => {
    await withStreamCtx(async ({ projectDir, base }) => {
      const sessionId = await seedClaimedRun(projectDir);
      const all = ["one", "two", "three"].map(eventLine);
      appendLines(projectDir, sessionId, RUN_ID, all);
      await settle(projectDir, sessionId);

      // The browser reopens the ORIGINAL url (from=0) and replays the header.
      const frames = await readToEnd(streamUrl(base, sessionId, "?from=0"), {
        headers: { "Last-Event-ID": "2" },
      });

      expect(offsets(frames)).toEqual([2]);
      expect(texts(frames)).toEqual([all[2]]);
    });
  });

  it("takes the larger of ?from and Last-Event-ID, so neither source can rewind the other", async () => {
    await withStreamCtx(async ({ projectDir, base }) => {
      const sessionId = await seedClaimedRun(projectDir);
      appendLines(projectDir, sessionId, RUN_ID, ["a", "b", "c", "d"].map(eventLine));
      await settle(projectDir, sessionId);

      const frames = await readToEnd(streamUrl(base, sessionId, "?from=3"), {
        headers: { "Last-Event-ID": "1" },
      });

      expect(offsets(frames)).toEqual([3]);
    });
  });

  it("refuses a malformed offset rather than silently replaying from 0", async () => {
    await withStreamCtx(async ({ projectDir, base }) => {
      const sessionId = await seedClaimedRun(projectDir);
      appendLines(projectDir, sessionId, RUN_ID, [eventLine("one")]);
      await settle(projectDir, sessionId);

      for (const query of ["?from=-1", "?from=abc", "?from=1.5"]) {
        const res = await fetch(streamUrl(base, sessionId, query));
        const body = (await res.json()) as { ok: boolean; code: string };
        expect({ query, status: res.status, code: body.code }).toEqual({
          query,
          status: 400,
          code: "INVALID_RUN_STREAM_OFFSET",
        });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Statelessness
// ---------------------------------------------------------------------------

describe("GET .../runs/:runId/stream — holds no per-connection run state", () => {
  it("answers two concurrent tails at different offsets, each with its own slice", async () => {
    await withStreamCtx(async ({ projectDir, base }) => {
      const sessionId = await seedClaimedRun(projectDir);
      const all = ["one", "two", "three"].map(eventLine);
      appendLines(projectDir, sessionId, RUN_ID, all);
      await settle(projectDir, sessionId);

      const [whole, tail] = await Promise.all([
        readToEnd(streamUrl(base, sessionId)),
        readToEnd(streamUrl(base, sessionId, "?from=2")),
      ]);

      expect(offsets(whole)).toEqual([0, 1, 2]);
      expect(offsets(tail)).toEqual([2]);
      // Neither connection consumed anything the other needed: a third identical
      // GET still answers the whole log.
      expect(texts(await readToEnd(streamUrl(base, sessionId)))).toEqual(all);
    });
  });

  it("survives a server restart — a new process answers the same GET with the same frames", async () => {
    await withStreamCtx(async ({ projectDir, base, restart }) => {
      const sessionId = await seedClaimedRun(projectDir);
      appendLines(projectDir, sessionId, RUN_ID, ["one", "two", "three"].map(eventLine));
      await settle(projectDir, sessionId);

      const before = await readToEnd(streamUrl(base, sessionId, "?from=1"));
      const rebooted = await restart();
      const after = await readToEnd(streamUrl(rebooted, sessionId, "?from=1"));

      expect(after).toEqual(before);
      expect(offsets(after)).toEqual([1, 2]);
    });
  });
});

// ---------------------------------------------------------------------------
// Refusals and the token gate
// ---------------------------------------------------------------------------

describe("GET .../runs/:runId/stream — refusals", () => {
  it("404s a run with neither a log nor a claim, as JSON rather than an empty stream", async () => {
    await withStreamCtx(async ({ projectDir, base }) => {
      const sessionId = await seedClaimedRun(projectDir);
      appendLines(projectDir, sessionId, RUN_ID, [eventLine("one")]);
      await settle(projectDir, sessionId);

      const res = await fetch(
        streamUrl(base, sessionId, "", "22222222-2222-4222-8222-222222222222"),
      );
      const body = (await res.json()) as { ok: boolean; code: string };
      expect(res.status).toBe(404);
      expect(body.ok).toBe(false);
      expect(body.code).toBe("RUN_EVENT_LOG_NOT_FOUND");
    });
  });

  it("404s an unknown session and an unknown project", async () => {
    await withStreamCtx(async ({ base }) => {
      const missingSession = await fetch(streamUrl(base, "no-such-session"));
      expect(missingSession.status).toBe(404);
      expect(((await missingSession.json()) as { code: string }).code).toBe("ITEM_NOT_FOUND");

      const missingProject = await fetch(`${base}/api/p/nope/sessions/x/runs/${RUN_ID}/stream`);
      expect(missingProject.status).toBe(404);
      expect(((await missingProject.json()) as { code: string }).code).toBe("PROJECT_NOT_FOUND");
    });
  });

  it("is a READ route: registered GET on the composed router, and open with no X-ARCS-Token", async () => {
    await withStreamCtx(async ({ projectDir, base }) => {
      // The same router the web-token gate walks (test/web-token-gate.test.ts):
      // this route is excluded from the mutation probe by its METHOD, not by an
      // exemption, so it stays covered as a read.
      const app = createApp({ watch: false });
      const registered = app.routes.filter((route) => route.path === STREAM_PATH);
      expect(registered.map((route) => route.method)).toEqual(["GET"]);
      expect(registered.filter((route) => MUTATION_METHODS.includes(route.method))).toEqual([]);

      const sessionId = await seedClaimedRun(projectDir);
      appendLines(projectDir, sessionId, RUN_ID, [eventLine("open to reads")]);
      await settle(projectDir, sessionId);

      // No token header at all — a read must not be gated.
      const frames = await readToEnd(streamUrl(base, sessionId));
      expect(texts(frames)).toEqual([eventLine("open to reads")]);
    });
  });
});
