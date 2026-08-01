/**
 * Session routes — full CRUD over the per-project session index.
 *
 * Sessions are runtime records for agent sessions (opencode, claude-code)
 * attached to a project. All mutations go through the locked session-store,
 * so the opencode discovery bridge and the web UI cannot clobber each other.
 *
 * `POST /sessions/:id/message` is the one route that reaches outside the store:
 * it proxies a prompt into the live runtime (opencode) or queues it for the
 * session to collect itself (claude-code). Every route here is browser-facing
 * and therefore already behind the global loopback-only `secureLocalRequest`
 * middleware — no per-route auth.
 */

import { Hono } from "hono";
import { z } from "zod";
import { DagError } from "../../utils/errors.js";
import {
  createSession,
  deleteSession,
  enqueueSessionMessage,
  getSession,
  listSessions,
  SESSION_LINKED_NODE_TYPES,
  SESSION_RUNTIME_TYPES,
  SESSION_STATUSES,
  type SessionFilters,
  type SessionMeta,
  updateSession,
} from "../../utils/session-store.js";
import { readOpencodeConfig, sendOpencodeMessage } from "../opencode-client.js";
import { parseBody, requireProjectDir, respond } from "../respond.js";

export const sessionsRoute = new Hono();

const createSessionSchema = z.object({
  runtimeType: z.enum(SESSION_RUNTIME_TYPES),
  runtimeSessionId: z.string().min(1),
  status: z.enum(SESSION_STATUSES).optional(),
  startedAt: z.string().optional(),
  lastMessageAt: z.string().optional(),
  userEmail: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSessionSchema = z.object({
  status: z.enum(SESSION_STATUSES).optional(),
  lastMessageAt: z.string().nullable().optional(),
  userEmail: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  /** `null` on either linkage field unlinks the session entirely. */
  linkedNodeType: z.enum(SESSION_LINKED_NODE_TYPES).nullable().optional(),
  linkedNodeId: z.string().nullable().optional(),
});

const sendMessageSchema = z.object({
  message: z.string().min(1),
});

function sessionDirectory(session: SessionMeta): string | undefined {
  const directory = session.metadata?.directory;
  return typeof directory === "string" && directory ? directory : undefined;
}

function parseFilters(status: string | undefined, runtimeType: string | undefined): SessionFilters {
  const filters: SessionFilters = {};
  if (status && (SESSION_STATUSES as readonly string[]).includes(status)) {
    filters.status = status as SessionFilters["status"];
  }
  if (runtimeType && (SESSION_RUNTIME_TYPES as readonly string[]).includes(runtimeType)) {
    filters.runtimeType = runtimeType as SessionFilters["runtimeType"];
  }
  return filters;
}

sessionsRoute.get("/api/p/:slug/sessions", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const sessions = await listSessions(
      projectDir,
      parseFilters(c.req.query("status"), c.req.query("runtimeType")),
    );
    return { sessions };
  }),
);

sessionsRoute.post("/api/p/:slug/sessions", async (c) =>
  respond(
    c,
    async () => {
      const projectDir = requireProjectDir(c.req.param("slug"));
      const input = await parseBody(c, createSessionSchema);
      return createSession(projectDir, input);
    },
    201,
  ),
);

sessionsRoute.get("/api/p/:slug/sessions/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    return getSession(projectDir, c.req.param("id"));
  }),
);

sessionsRoute.patch("/api/p/:slug/sessions/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const input = await parseBody(c, updateSessionSchema);
    return updateSession(projectDir, { id: c.req.param("id"), ...input });
  }),
);

/**
 * Sends a message to the runtime behind a session.
 *
 * Delivery is asymmetric by runtime, and deliberately so: opencode sessions get
 * live injection (the running agent picks the prompt up mid-turn), while Claude
 * Code sessions get queued delivery (the session itself drains the queue at its
 * next hook checkpoint — Claude Code exposes no live channel to inject into).
 * Both answer with the updated session, so the caller can tell them apart by
 * `messageQueue` rather than by branching on `runtimeType` itself.
 */
sessionsRoute.post("/api/p/:slug/sessions/:id/message", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const { message } = await parseBody(c, sendMessageSchema);
    const session = await getSession(projectDir, c.req.param("id"));

    if (session.runtimeType === "claude-code") {
      // Queued, not sent: `lastMessageAt` stays untouched until the session
      // actually drains this at a checkpoint.
      return enqueueSessionMessage(projectDir, session.normalizedId, message);
    }

    const config = readOpencodeConfig();
    if (!config) {
      throw new DagError(
        "OPENCODE_NOT_CONFIGURED",
        "No opencode endpoint configured — set OPENCODE_PORT (or ARCS_OPENCODE_URL) " +
          "so ARCS can reach a running `opencode serve`.",
      );
    }

    await sendOpencodeMessage(
      config,
      {
        runtimeSessionId: session.runtimeSessionId,
        ...(sessionDirectory(session) && { directory: sessionDirectory(session) }),
      },
      message,
    );

    return updateSession(projectDir, {
      id: session.normalizedId,
      lastMessageAt: new Date().toISOString(),
    });
  }),
);

sessionsRoute.delete("/api/p/:slug/sessions/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    await deleteSession(projectDir, c.req.param("id"));
    return { deleted: true };
  }),
);
