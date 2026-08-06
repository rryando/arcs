/**
 * Session message-injection route tests.
 *
 * The opencode side is a stub HTTP server: the contract under test is what ARCS
 * puts on the wire (path, auth header, JSON body) and how it maps opencode's
 * answers back into the CLI envelope — verified against a live opencode 1.0.0
 * `/doc` when the route was written.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendReferenceTurn,
  mirrorSessionTranscript,
  readSessionTurns,
  sessionTranscriptPath,
} from "../src/utils/claude-transcript.js";
import {
  createSession,
  getSession,
  listSessions,
  type SessionMeta,
} from "../src/utils/session-store.js";
import { startWebServer, type WebServerHandle } from "../src/web-server/index.js";
import { currentWebToken } from "../src/web-server/web-token.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

interface CapturedRequest {
  method: string;
  url: string;
  authorization?: string;
  contentType?: string;
  body: unknown;
}

interface OpencodeStub {
  baseUrl: string;
  requests: CapturedRequest[];
  /** Status the next `prompt_async` call answers with (default 204). */
  status: number;
  /** Body the next `POST /session` answers with; null replays the SPA-shell trap. */
  createdSession: unknown;
  close: () => Promise<void>;
}

/** Shape of a real `POST /session` response (opencode 0.0.0-main-202607110203). */
const DEFAULT_CREATED_SESSION = {
  id: "ses_created_1",
  slug: "nimble-cactus",
  projectID: "global",
  directory: "/work/demo",
  title: "arcs web session",
  time: { created: 1785560795148, updated: 1785560795148 },
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => resolvePromise(raw));
  });
}

async function startOpencodeStub(): Promise<OpencodeStub> {
  const requests: CapturedRequest[] = [];
  const stub = { status: 204, createdSession: DEFAULT_CREATED_SESSION } as {
    status: number;
    createdSession: unknown;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const url = req.url ?? "";
      requests.push({
        method: req.method ?? "",
        url,
        ...(req.headers.authorization && { authorization: req.headers.authorization }),
        ...(req.headers["content-type"] && { contentType: req.headers["content-type"] }),
        body: raw ? JSON.parse(raw) : null,
      });

      // `POST /session` (create) answers with a session object, unlike
      // `prompt_async` which acks with a bare 204.
      if (req.method === "POST" && url.startsWith("/session?")) {
        if (stub.createdSession === null) {
          // opencode serves its web UI from the same port and answers unknown
          // paths with a 200 text/html SPA shell — the failure mode a wrong
          // create path produces.
          res.writeHead(200, { "content-type": "text/html;charset=UTF-8" });
          res.end("<!doctype html><html><body></body></html>");
          return;
        }
        res.writeHead(stub.status === 204 ? 200 : stub.status, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify(stub.status === 204 ? stub.createdSession : { name: "StubError" }));
        return;
      }

      res.writeHead(stub.status, { "content-type": "application/json" });
      res.end(stub.status === 204 ? undefined : JSON.stringify({ name: "StubError" }));
    })();
  });

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    get status() {
      return stub.status;
    },
    set status(value: number) {
      stub.status = value;
    },
    get createdSession() {
      return stub.createdSession;
    },
    set createdSession(value: unknown) {
      stub.createdSession = value;
    },
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}

interface Ctx {
  base: string;
  projectDir: string;
  opencode: OpencodeStub;
}

const SAVED_ENV = {
  url: process.env.ARCS_OPENCODE_URL,
  legacyUrl: process.env.OPENCODE_URL,
  port: process.env.OPENCODE_PORT,
  password: process.env.OPENCODE_SERVER_PASSWORD,
};

afterEach(() => {
  for (const [key, value] of [
    ["ARCS_OPENCODE_URL", SAVED_ENV.url],
    ["OPENCODE_URL", SAVED_ENV.legacyUrl],
    ["OPENCODE_PORT", SAVED_ENV.port],
    ["OPENCODE_SERVER_PASSWORD", SAVED_ENV.password],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

async function withRouteCtx(run: (ctx: Ctx) => Promise<void>): Promise<void> {
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

    const opencode = await startOpencodeStub();
    process.env.ARCS_OPENCODE_URL = opencode.baseUrl;
    process.env.OPENCODE_SERVER_PASSWORD = "hunter2";
    delete process.env.OPENCODE_PORT;

    let server: WebServerHandle | null = null;
    try {
      server = await startWebServer({ port: 0, host: "127.0.0.1", watch: false });
      await run({ base: server.url, projectDir, opencode });
    } finally {
      await server?.close();
      await opencode.close();
    }
  });
}

async function sendMessage(base: string, id: string, body: unknown) {
  const res = await fetch(`${base}/api/p/demo/sessions/${id}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() ?? "" },
    body: JSON.stringify(body),
  });
  const envelope = (await res.json()) as {
    ok: boolean;
    data?: { lastMessageAt?: string; messageQueue?: string[] };
    code?: string;
    message?: string;
  };
  return { status: res.status, envelope };
}

/** The harness registers the project with no workspace paths; most creation
 *  tests need one, so they opt in explicitly. */
function setWorkspacePaths(projectDir: string, paths: string[]): void {
  const path = resolve(projectDir, "meta.json");
  const meta = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...meta, workspacePaths: paths }), "utf-8");
}

async function createOpencode(base: string, body: unknown = {}) {
  const res = await fetch(`${base}/api/p/demo/sessions/opencode/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() ?? "" },
    body: JSON.stringify(body),
  });
  const envelope = (await res.json()) as {
    ok: boolean;
    data?: SessionMeta;
    code?: string;
    message?: string;
  };
  return { status: res.status, envelope };
}

/** A valid `reference` body for POST /message, per sendMessageSchema. */
const REFERENCE = {
  section: {
    depth: 1,
    text: "The session drains the queue at the next hook checkpoint.",
    id: "sec_1",
    startOffset: 120,
    endOffset: 220,
  },
  text: "Queue drain happens at the next hook checkpoint.",
  source: { kind: "knowledge", label: "session-bridge", doc: "docs/bridge.md", id: "k_1" },
} as const;

describe("POST /api/p/:slug/sessions/opencode/new", () => {
  it("creates a live opencode session in the project workspace and indexes it at once", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      setWorkspacePaths(projectDir, ["/work/demo", "/work/demo-secondary"]);

      const { status, envelope } = await createOpencode(base, { title: "arcs web session" });

      expect(status).toBe(201);
      expect(envelope.ok).toBe(true);
      expect(envelope.data?.runtimeType).toBe("opencode");
      expect(envelope.data?.runtimeSessionId).toBe("ses_created_1");
      expect(envelope.data?.status).toBe("active");
      expect(envelope.data?.metadata).toMatchObject({
        directory: "/work/demo",
        title: "arcs web session",
      });

      expect(opencode.requests).toHaveLength(1);
      const request = opencode.requests[0];
      expect(request.method).toBe("POST");
      // `POST /session` — NOT `/api/session`, and `directory` is a query
      // parameter rather than a body field.
      expect(request.url).toBe("/session?directory=%2Fwork%2Fdemo");
      expect(request.body).toEqual({ title: "arcs web session" });
      expect(request.authorization).toBe(
        `Basic ${Buffer.from("opencode:hunter2").toString("base64")}`,
      );

      // Visible without waiting for the discovery stream to catch up.
      const stored = await getSession(projectDir, envelope.data?.normalizedId ?? "");
      expect(stored.runtimeSessionId).toBe("ses_created_1");
    });
  });

  it("sends an empty body when no title is supplied", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      setWorkspacePaths(projectDir, ["/work/demo"]);

      const { status } = await createOpencode(base);

      expect(status).toBe(201);
      expect(opencode.requests[0].body).toEqual({});
    });
  });

  it("refuses to guess a directory when the project has no workspace path", async () => {
    await withRouteCtx(async ({ base, opencode }) => {
      const { status, envelope } = await createOpencode(base);

      expect(status).toBe(400);
      expect(envelope.code).toBe("PROJECT_WORKSPACE_UNSET");
      expect(envelope.message).toMatch(/project update-paths/);
      // Nothing may reach opencode: an unscoped create lands in opencode's own cwd.
      expect(opencode.requests).toHaveLength(0);
    });
  });

  it("reports a missing opencode configuration instead of a generic failure", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      setWorkspacePaths(projectDir, ["/work/demo"]);
      delete process.env.ARCS_OPENCODE_URL;
      delete process.env.OPENCODE_URL;
      delete process.env.OPENCODE_PORT;

      const { status, envelope } = await createOpencode(base);

      expect(status).toBe(400);
      expect(envelope.code).toBe("OPENCODE_NOT_CONFIGURED");
      expect(opencode.requests).toHaveLength(0);
    });
  });

  it("rejects a 200 that is opencode's SPA shell rather than a session", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      setWorkspacePaths(projectDir, ["/work/demo"]);
      opencode.createdSession = null;

      const { status, envelope } = await createOpencode(base);

      expect(status).toBe(400);
      expect(envelope.code).toBe("OPENCODE_REQUEST_FAILED");
      // A wrong path must not leave a phantom session in the index.
      expect(await listSessions(projectDir)).toHaveLength(0);
    });
  });

  it("surfaces an opencode rejection with its status", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      setWorkspacePaths(projectDir, ["/work/demo"]);
      opencode.status = 400;

      const { status, envelope } = await createOpencode(base);

      expect(status).toBe(400);
      expect(envelope.code).toBe("OPENCODE_REQUEST_FAILED");
      expect(envelope.message).toMatch(/400/);
      expect(await listSessions(projectDir)).toHaveLength(0);
    });
  });
});

describe("POST /api/p/:slug/sessions/:id/message", () => {
  it("injects the message into the live opencode session and bumps lastMessageAt", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      const session = await createSession(projectDir, {
        runtimeType: "opencode",
        runtimeSessionId: "ses_abc123",
        metadata: { directory: "/work/demo" },
      });
      expect(session.lastMessageAt).toBeUndefined();

      const { status, envelope } = await sendMessage(base, session.normalizedId, {
        message: "carry on with T003",
      });

      expect(status).toBe(200);
      expect(envelope.ok).toBe(true);
      expect(envelope.data?.lastMessageAt).toBeTruthy();

      expect(opencode.requests).toHaveLength(1);
      const request = opencode.requests[0];
      expect(request.method).toBe("POST");
      // opencode's own session id, not the ARCS normalized id, plus the
      // worktree scope taken from the discovered session metadata.
      expect(request.url).toBe("/session/ses_abc123/prompt_async?directory=%2Fwork%2Fdemo");
      expect(request.contentType).toBe("application/json");
      expect(request.authorization).toBe(
        `Basic ${Buffer.from("opencode:hunter2").toString("base64")}`,
      );
      expect(request.body).toEqual({ parts: [{ type: "text", text: "carry on with T003" }] });

      const stored = await getSession(projectDir, session.normalizedId);
      expect(stored.lastMessageAt).toBe(envelope.data?.lastMessageAt);
    });
  });

  it("omits the directory scope when the session has none", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      const session = await createSession(projectDir, {
        runtimeType: "opencode",
        runtimeSessionId: "ses_nodir",
      });

      const { status } = await sendMessage(base, session.normalizedId, { message: "hi" });

      expect(status).toBe(200);
      expect(opencode.requests[0].url).toBe("/session/ses_nodir/prompt_async");
    });
  });

  it("queues the message for a claude-code session instead of injecting it", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_local_1",
      });

      const { status, envelope } = await sendMessage(base, session.normalizedId, {
        message: "queue me",
      });

      expect(status).toBe(200);
      expect(envelope.ok).toBe(true);
      expect(envelope.data?.messageQueue).toEqual(["queue me"]);
      // Claude Code has no live channel — nothing may reach the opencode runtime.
      expect(opencode.requests).toHaveLength(0);

      const stored = await getSession(projectDir, session.normalizedId);
      expect(stored.messageQueue).toEqual(["queue me"]);
      // Not delivered yet: the timestamp belongs to the checkpoint that drains it.
      expect(stored.lastMessageAt).toBeUndefined();
    });
  });

  it("appends further messages to a claude-code queue in order", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_local_2",
      });

      await sendMessage(base, session.normalizedId, { message: "first" });
      const { envelope } = await sendMessage(base, session.normalizedId, { message: "second" });

      expect(envelope.data?.messageQueue).toEqual(["first", "second"]);
    });
  });

  it("refuses to queue for an arcs-origin session instead of swallowing the message", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      const thread = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "arcs-thread-demo-1",
        origin: "arcs",
        metadata: { control: "arcs-owned", directory: "/work/demo" },
      });

      const { status, envelope } = await sendMessage(base, thread.normalizedId, {
        message: "into the void",
        reference: REFERENCE,
      });

      expect(status).toBe(400);
      expect(envelope.code).toBe("SESSION_QUEUE_UNSUPPORTED");
      // The refusal has to say what to do instead, or it is just a dead end.
      expect(envelope.message).toMatch(/\/run/);

      // Nothing was accepted anywhere: no queue entry, no timestamp bump, and
      // no reference turn left dangling in the sidecar.
      const stored = await getSession(projectDir, thread.normalizedId);
      expect(stored.messageQueue).toBeUndefined();
      expect(stored.lastMessageAt).toBeUndefined();
      expect(await readSessionTurns(projectDir, thread.normalizedId)).toEqual([]);
      expect(opencode.requests).toHaveLength(0);
    });
  });

  it("refuses a legacy arcs-owned record the same way, with no migration run", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      // A record persisted before `origin` existed: the marker is the only
      // signal it was ARCS-minted, and the read path promotes it.
      mkdirSync(resolve(projectDir, "sessions"), { recursive: true });
      writeFileSync(
        resolve(projectDir, "sessions", "index.json"),
        JSON.stringify({
          sessions: [
            {
              id: "arcs-oneshot-demo",
              normalizedId: "arcs-oneshot-demo",
              runtimeType: "claude-code",
              runtimeSessionId: "arcs-oneshot-demo",
              status: "active",
              startedAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              metadata: { control: "arcs-owned", directory: "/work/demo" },
            },
          ],
        }),
        "utf-8",
      );

      const { status, envelope } = await sendMessage(base, "arcs-oneshot-demo", {
        message: "into the void",
      });

      expect(status).toBe(400);
      expect(envelope.code).toBe("SESSION_QUEUE_UNSUPPORTED");
      expect((await getSession(projectDir, "arcs-oneshot-demo")).messageQueue).toBeUndefined();
    });
  });

  it("reports a missing opencode configuration instead of a generic failure", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "opencode",
        runtimeSessionId: "ses_unconfigured",
      });
      delete process.env.ARCS_OPENCODE_URL;
      delete process.env.OPENCODE_URL;
      delete process.env.OPENCODE_PORT;

      const { status, envelope } = await sendMessage(base, session.normalizedId, {
        message: "anyone home?",
      });

      expect(status).toBe(400);
      expect(envelope.code).toBe("OPENCODE_NOT_CONFIGURED");
    });
  });

  it("maps an opencode 404 to a session-gone error", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      const session = await createSession(projectDir, {
        runtimeType: "opencode",
        runtimeSessionId: "ses_gone",
      });
      opencode.status = 404;

      const { status, envelope } = await sendMessage(base, session.normalizedId, {
        message: "still there?",
      });

      expect(status).toBe(404);
      expect(envelope.code).toBe("OPENCODE_SESSION_NOT_FOUND");

      const stored = await getSession(projectDir, session.normalizedId);
      expect(stored.lastMessageAt).toBeUndefined();
    });
  });

  it("surfaces other opencode rejections with their status", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      const session = await createSession(projectDir, {
        runtimeType: "opencode",
        runtimeSessionId: "ses_bad",
      });
      opencode.status = 400;

      const { status, envelope } = await sendMessage(base, session.normalizedId, {
        message: "malformed for opencode",
      });

      expect(status).toBe(400);
      expect(envelope.code).toBe("OPENCODE_REQUEST_FAILED");
      expect(envelope.message).toMatch(/400/);
    });
  });

  it("rejects an empty message before touching the runtime", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      const session = await createSession(projectDir, {
        runtimeType: "opencode",
        runtimeSessionId: "ses_empty",
      });

      const { status, envelope } = await sendMessage(base, session.normalizedId, { message: "" });

      expect(status).toBe(400);
      expect(envelope.code).toBe("INVALID_BODY");
      expect(opencode.requests).toHaveLength(0);
    });
  });

  it("404s for a session the project does not have", async () => {
    await withRouteCtx(async ({ base, opencode }) => {
      const { status, envelope } = await sendMessage(base, "ses-missing", { message: "hello" });

      expect(status).toBe(404);
      expect(envelope.code).toBe("ITEM_NOT_FOUND");
      expect(opencode.requests).toHaveLength(0);
    });
  });

  it("queues the message for claude-code, then appends the reference turn to the sidecar", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_ref_1",
      });

      const { status, envelope } = await sendMessage(base, session.normalizedId, {
        message: "queue me with a reference",
        reference: REFERENCE,
      });

      expect(status).toBe(200);
      expect(envelope.ok).toBe(true);
      expect(envelope.data?.messageQueue).toEqual(["queue me with a reference"]);

      // The reference lands after the enqueue: it is the sidecar's sole record
      // (id -1, the negative reference space), never clobbering the queue.
      const turns = await readSessionTurns(projectDir, session.normalizedId);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        type: "reference",
        text: REFERENCE.text,
        section: REFERENCE.section,
        source: REFERENCE.source,
      });
      expect(turns[0].id).toBe(-1);
      expect(typeof turns[0].ts).toBe("string");

      // A second reference keeps the order: appends serialize after each
      // delivery, so ids and the queue both grow in call order.
      await sendMessage(base, session.normalizedId, {
        message: "one more",
        reference: { ...REFERENCE, text: "second reference" },
      });
      const after = await readSessionTurns(projectDir, session.normalizedId);
      expect(after.map((t) => t.id)).toEqual([-1, -2]);
      const stored = await getSession(projectDir, session.normalizedId);
      expect(stored.messageQueue).toEqual(["queue me with a reference", "one more"]);
    });
  });

  it("injects into the live opencode session, then appends the reference turn on success", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      const session = await createSession(projectDir, {
        runtimeType: "opencode",
        runtimeSessionId: "ses_ref_1",
        metadata: { directory: "/work/demo" },
      });

      const { status, envelope } = await sendMessage(base, session.normalizedId, {
        message: "carry on with the reference",
        reference: REFERENCE,
      });

      expect(status).toBe(200);
      expect(envelope.ok).toBe(true);
      expect(envelope.data?.lastMessageAt).toBeTruthy();
      expect(opencode.requests).toHaveLength(1);
      expect(opencode.requests[0].body).toEqual({
        parts: [{ type: "text", text: "carry on with the reference" }],
      });

      const turns = await readSessionTurns(projectDir, session.normalizedId);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        type: "reference",
        text: REFERENCE.text,
        section: REFERENCE.section,
        source: REFERENCE.source,
      });
      expect(turns[0].id).toBeLessThan(0);
    });
  });

  it("does not append a dangling reference when delivery fails", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      const session = await createSession(projectDir, {
        runtimeType: "opencode",
        runtimeSessionId: "ses_ref_fail",
      });
      opencode.status = 500;

      const { status, envelope } = await sendMessage(base, session.normalizedId, {
        message: "will fail",
        reference: REFERENCE,
      });

      expect(status).toBe(400);
      expect(envelope.code).toBe("OPENCODE_REQUEST_FAILED");

      // The failed send must not leave a dangling reference behind.
      expect(await readSessionTurns(projectDir, session.normalizedId)).toEqual([]);
      expect(existsSync(sessionTranscriptPath(projectDir, session.normalizedId))).toBe(false);
      const stored = await getSession(projectDir, session.normalizedId);
      expect(stored.lastMessageAt).toBeUndefined();
    });
  });

  it("leaves no sidecar behind when a message is sent without a reference", async () => {
    await withRouteCtx(async ({ base, projectDir, opencode }) => {
      const opencodeSession = await createSession(projectDir, {
        runtimeType: "opencode",
        runtimeSessionId: "ses_noref",
      });
      const ccSession = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_noref",
      });

      const sent = await sendMessage(base, opencodeSession.normalizedId, { message: "plain" });
      expect(sent.status).toBe(200);
      expect(sent.envelope.data?.lastMessageAt).toBeTruthy();
      expect(opencode.requests).toHaveLength(1);

      const queued = await sendMessage(base, ccSession.normalizedId, { message: "queued" });
      expect(queued.status).toBe(200);
      expect(queued.envelope.data?.messageQueue).toEqual(["queued"]);

      expect(existsSync(sessionTranscriptPath(projectDir, opencodeSession.normalizedId))).toBe(
        false,
      );
      expect(existsSync(sessionTranscriptPath(projectDir, ccSession.normalizedId))).toBe(false);
      expect(await readSessionTurns(projectDir, opencodeSession.normalizedId)).toEqual([]);
      expect(await readSessionTurns(projectDir, ccSession.normalizedId)).toEqual([]);
    });
  });
});

describe("GET /api/p/:slug/sessions/:id/transcript", () => {
  it("404s for a session the project does not have", async () => {
    await withRouteCtx(async ({ base }) => {
      const res = await fetch(`${base}/api/p/demo/sessions/ses-missing/transcript`);
      expect(res.status).toBe(404);
      const envelope = (await res.json()) as { ok: boolean; code?: string };
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("ITEM_NOT_FOUND");
    });
  });

  it("answers an empty transcript with mirroredAt null before any mirror exists", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_tr_empty",
      });

      const res = await fetch(`${base}/api/p/demo/sessions/${session.normalizedId}/transcript`);
      expect(res.status).toBe(200);
      const envelope = (await res.json()) as {
        ok: boolean;
        data?: { turns: unknown[]; mirroredAt: string | null };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toEqual({ turns: [], mirroredAt: null });
    });
  });

  it("roundtrips mirrored and reference turns with the sidecar mtime", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_tr_rt",
      });

      // A Claude Code transcript source, then mirror + append a reference.
      const sourcePath = resolve(projectDir, "sessions", "cc_tr_rt.source.jsonl");
      writeFileSync(
        sourcePath,
        [
          JSON.stringify({
            type: "user",
            message: { role: "user", content: "first question" },
            timestamp: "2026-01-01T00:00:00.000Z",
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "first answer" }],
            },
            timestamp: "2026-01-01T00:00:01.000Z",
          }),
          "",
        ].join("\n"),
        "utf-8",
      );
      await mirrorSessionTranscript(projectDir, session.normalizedId, sourcePath);
      await appendReferenceTurn(projectDir, session.normalizedId, { text: "quoted reference" });

      const res = await fetch(`${base}/api/p/demo/sessions/${session.normalizedId}/transcript`);
      expect(res.status).toBe(200);
      const envelope = (await res.json()) as {
        ok: boolean;
        data?: {
          turns: Array<{ id: number; type: string; text: string; ts?: string }>;
          mirroredAt: string | null;
        };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.data?.turns).toEqual([
        {
          id: 0,
          type: "user",
          text: "first question",
          ts: "2026-01-01T00:00:00.000Z",
        },
        {
          id: 1,
          type: "assistant",
          text: "first answer",
          ts: "2026-01-01T00:00:01.000Z",
        },
        expect.objectContaining({ id: -1, type: "reference", text: "quoted reference" }),
      ]);
      expect(typeof envelope.data?.mirroredAt).toBe("string");
    });
  });

  it("returns a reference turn with section and source intact after POST /message", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_ref_rt",
      });

      const sent = await sendMessage(base, session.normalizedId, {
        message: "point me at the doc",
        reference: REFERENCE,
      });
      expect(sent.status).toBe(200);
      expect(sent.envelope.ok).toBe(true);

      const res = await fetch(`${base}/api/p/demo/sessions/${session.normalizedId}/transcript`);
      expect(res.status).toBe(200);
      const envelope = (await res.json()) as {
        ok: boolean;
        data?: {
          turns: Array<{
            id: number;
            type: string;
            text: string;
            ts?: string;
            section?: unknown;
            source?: unknown;
          }>;
          mirroredAt: string | null;
        };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.data?.turns).toEqual([
        expect.objectContaining({
          id: -1,
          type: "reference",
          text: REFERENCE.text,
          section: REFERENCE.section,
          source: REFERENCE.source,
        }),
      ]);
    });
  });
});

describe("DELETE /api/p/:slug/sessions/:id", () => {
  it("removes the transcript sidecar when the session is deleted", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_del_1",
      });
      await appendReferenceTurn(projectDir, session.normalizedId, { text: "about to vanish" });
      const sidecar = sessionTranscriptPath(projectDir, session.normalizedId);
      expect(existsSync(sidecar)).toBe(true);

      const res = await fetch(`${base}/api/p/demo/sessions/${session.normalizedId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() ?? "" },
      });
      expect(res.status).toBe(200);
      const envelope = (await res.json()) as { ok: boolean; data?: { deleted: boolean } };
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toEqual({ deleted: true });

      expect(existsSync(sidecar)).toBe(false);
      await expect(getSession(projectDir, session.normalizedId)).rejects.toThrow();
    });
  });

  it("still deletes a session when no sidecar exists", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_del_2",
      });

      const res = await fetch(`${base}/api/p/demo/sessions/${session.normalizedId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() ?? "" },
      });
      expect(res.status).toBe(200);
      const envelope = (await res.json()) as { ok: boolean; data?: { deleted: boolean } };
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toEqual({ deleted: true });
      await expect(getSession(projectDir, session.normalizedId)).rejects.toThrow();
    });
  });

  it("removes the sidecar by normalizedId when the route id is not slugified", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      // "Delete Me 1" normalizes to "delete-me-1": the route id differs from
      // the normalized sidecar filename key, so the unlink must key on
      // session.normalizedId rather than the raw id.
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "Delete Me 1",
      });
      expect(session.normalizedId).toBe("delete-me-1");
      await appendReferenceTurn(projectDir, session.normalizedId, { text: "about to vanish" });
      const sidecar = sessionTranscriptPath(projectDir, session.normalizedId);
      expect(existsSync(sidecar)).toBe(true);

      const res = await fetch(`${base}/api/p/demo/sessions/${encodeURIComponent("Delete Me 1")}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() ?? "" },
      });
      expect(res.status).toBe(200);
      const envelope = (await res.json()) as { ok: boolean; data?: { deleted: boolean } };
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toEqual({ deleted: true });

      expect(existsSync(sidecar)).toBe(false);
      await expect(getSession(projectDir, "Delete Me 1")).rejects.toThrow();
    });
  });
});
