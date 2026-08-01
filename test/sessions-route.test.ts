/**
 * Session message-injection route tests.
 *
 * The opencode side is a stub HTTP server: the contract under test is what ARCS
 * puts on the wire (path, auth header, JSON body) and how it maps opencode's
 * answers back into the CLI envelope — verified against a live opencode 1.0.0
 * `/doc` when the route was written.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSession, getSession } from "../src/utils/session-store.js";
import { startWebServer, type WebServerHandle } from "../src/web-server/index.js";
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
  close: () => Promise<void>;
}

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
  const stub = { status: 204 } as { status: number };

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
    headers: { "Content-Type": "application/json" },
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
});
