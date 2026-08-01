/**
 * Claude Code session-bridge endpoint.
 *
 * Claude Code has no live-injection channel: hooks are stateless, fire per
 * event, and hold no persistent connection. So the session drives the bridge —
 * it announces itself at `SessionStart`, picks up whatever the web UI queued at
 * every `UserPromptSubmit` checkpoint, and closes out at `SessionEnd`.
 *
 * The response stays ARCS-shaped (`{sessionId, queuedMessages}`); turning that
 * into Claude Code's `hookSpecificOutput` envelope is the hook script's job, so
 * a change to Claude Code's wire format never reaches the server.
 *
 * Unlike every other route here this one is not browser-facing, so it sits
 * behind `requireHookToken` in addition to the global loopback check.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  drainSessionMessageQueue,
  getSession,
  type SessionMeta,
  updateSession,
  upsertSession,
} from "../../utils/session-store.js";
import { parseBody, requireProjectDir, respond } from "../respond.js";

export const hookEventsRoute = new Hono();

/**
 * Claude Code's native stdin fields, forwarded verbatim by the hook script.
 * Unknown extra fields are ignored rather than rejected — Claude Code adds
 * fields between releases and a hook must not start failing because of it.
 */
const hookEventSchema = z.object({
  hook_event_name: z.enum(["SessionStart", "UserPromptSubmit", "SessionEnd"]),
  session_id: z.string().min(1),
  cwd: z.string().optional(),
  source: z.string().optional(),
  prompt: z.string().optional(),
  reason: z.string().optional(),
});

type HookEvent = z.infer<typeof hookEventSchema>;

interface HookEventResult {
  sessionId: string;
  /** Always present; empty for every event except a drained UserPromptSubmit. */
  queuedMessages: string[];
}

/**
 * Claude Code's `cwd` lands under the `directory` key: that is the metadata key
 * the sessions UI and the opencode bridge already read, so both runtimes render
 * their worktree the same way.
 */
function sessionMetadata(event: HookEvent): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {
    ...(event.cwd && { directory: event.cwd }),
    ...(event.source && { source: event.source }),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function registerSession(projectDir: string, event: HookEvent): Promise<SessionMeta> {
  const metadata = sessionMetadata(event);
  return upsertSession(projectDir, {
    runtimeType: "claude-code",
    runtimeSessionId: event.session_id,
    status: "active",
    ...(metadata && { metadata }),
  });
}

/**
 * Resolves the session behind a checkpoint, registering it if this is the first
 * event ARCS has seen. `resume`/`compact` can deliver a prompt for a session
 * whose SessionStart never reached us, and dropping the checkpoint would strand
 * every message queued for it.
 */
async function resolveCheckpointSession(
  projectDir: string,
  event: HookEvent,
): Promise<SessionMeta> {
  try {
    return await getSession(projectDir, event.session_id);
  } catch {
    return registerSession(projectDir, event);
  }
}

async function handleHookEvent(projectDir: string, event: HookEvent): Promise<HookEventResult> {
  if (event.hook_event_name === "SessionStart") {
    const session = await registerSession(projectDir, event);
    return { sessionId: session.normalizedId, queuedMessages: [] };
  }

  if (event.hook_event_name === "UserPromptSubmit") {
    const session = await resolveCheckpointSession(projectDir, event);
    const queuedMessages = await drainSessionMessageQueue(projectDir, session.normalizedId);
    return { sessionId: session.normalizedId, queuedMessages };
  }

  // SessionEnd. Every documented reason (clear|resume|logout|other) is an
  // ordinary teardown — none of them signals a crash, so none maps to "failed".
  const session = await updateSession(projectDir, {
    id: event.session_id,
    status: "completed",
  });
  return { sessionId: session.normalizedId, queuedMessages: [] };
}

hookEventsRoute.post("/api/hook/:slug/event", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    return handleHookEvent(projectDir, await parseBody(c, hookEventSchema));
  }),
);
