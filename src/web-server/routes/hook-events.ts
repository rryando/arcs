/**
 * Claude Code session-bridge endpoint.
 *
 * Claude Code has no live-injection channel: hooks are stateless, fire per
 * event, and hold no persistent connection. So the session drives the bridge —
 * it announces itself at `SessionStart`, picks up whatever the web UI queued at
 * every `UserPromptSubmit` checkpoint, closes out at `SessionEnd`, and reports
 * its transcript at `Stop` (the last checkpoint before teardown).
 *
 * Those checkpoints are also the only liveness signal an observed session ever
 * emits, so each one stamps `lastCheckpointAt` — the field the session's derived
 * phase reads to decide whether a terminal is still working.
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
import { mirrorSessionTranscript } from "../../utils/claude-transcript.js";
import { HOOK_EVENTS } from "../../utils/hook-contract.js";
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
 *
 * The accepted event names come straight from the bridge contract: the server
 * cannot end up rejecting an event the installer registered the hook for.
 */
const hookEventSchema = z.object({
  hook_event_name: z.enum(HOOK_EVENTS),
  session_id: z.string().min(1),
  cwd: z.string().optional(),
  source: z.string().optional(),
  prompt: z.string().optional(),
  reason: z.string().optional(),
  transcript_path: z.string().optional(),
  control: z.string().optional(),
});

type HookEvent = z.infer<typeof hookEventSchema>;

interface HookEventResult {
  sessionId: string;
  /** Always present; empty for every event except a drained UserPromptSubmit. */
  queuedMessages: string[];
}

/**
 * Builds the metadata persisted on the session. Claude Code's `cwd` lands under
 * the `directory` key: that is the metadata key the sessions UI and the opencode
 * bridge already read, so both runtimes render their worktree the same way.
 * `transcript_path` is persisted under `transcriptPath` (the sessions UI reads
 * that key) so headless-run write-backs can resolve the transcript without the
 * client resupplying it, and `control` is persisted verbatim for back-compat
 * with readers that still display it — it no longer decides anything here, the
 * session's persisted `origin` does.
 */
function sessionMetadata(event: HookEvent): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {
    ...(event.cwd && { directory: event.cwd }),
    ...(event.source && { source: event.source }),
    ...(event.control !== undefined && { control: event.control }),
    ...(event.transcript_path !== undefined && { transcriptPath: event.transcript_path }),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Registers (or refreshes) the session behind a hook event.
 *
 * Anything announcing itself through this endpoint is by definition a real
 * terminal session ARCS is watching, so a record created here is `observed` —
 * which is what makes it queueable. Provenance is create-only in the store, so
 * an event arriving for an ARCS-owned thread refreshes it without demoting it.
 */
function registerSession(projectDir: string, event: HookEvent): Promise<SessionMeta> {
  const metadata = sessionMetadata(event);
  return upsertSession(projectDir, {
    runtimeType: "claude-code",
    runtimeSessionId: event.session_id,
    origin: "observed",
    status: "active",
    ...(metadata && { metadata }),
  });
}

/**
 * Records the checkpoint itself, plus whatever it carried.
 *
 * `lastCheckpointAt` is written at EVERY UserPromptSubmit and Stop, even for an
 * event with no metadata at all: it is the only proof of life a session ARCS
 * merely observes ever emits, and the derived phase reads nothing else for such
 * a session. Miss one and a working terminal reads idle.
 *
 * ISO-8601, like every other top-level session timestamp (`metadata.run` keeps
 * epoch ms — the two units never mix). Checkpoint-derived metadata
 * (transcriptPath, directory…) rides the same write, so the transcript path a
 * checkpoint carries is still never dropped.
 */
async function persistCheckpoint(
  projectDir: string,
  session: SessionMeta,
  event: HookEvent,
): Promise<SessionMeta> {
  const metadata = sessionMetadata(event);
  return updateSession(projectDir, {
    id: session.normalizedId,
    lastCheckpointAt: new Date().toISOString(),
    ...(metadata !== undefined && { metadata }),
  });
}

/**
 * Whether a checkpoint's runtime transcript should be mirrored into the
 * session's sidecar.
 *
 * Only sessions ARCS observes qualify. An `arcs`-origin record owns its sidecar
 * through the run route's own turn appends, so mirroring a runtime transcript
 * on top would duplicate the conversation. The rule reads the persisted origin,
 * never `metadata.control`.
 */
function shouldMirrorTranscript(session: SessionMeta): boolean {
  return session.origin === "observed";
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
    const checkpoint = await persistCheckpoint(projectDir, session, event);
    if (event.transcript_path !== undefined && shouldMirrorTranscript(checkpoint)) {
      await mirrorSessionTranscript(projectDir, checkpoint.normalizedId, event.transcript_path);
    }
    const queuedMessages = await drainSessionMessageQueue(projectDir, checkpoint.normalizedId);
    return { sessionId: checkpoint.normalizedId, queuedMessages };
  }

  if (event.hook_event_name === "Stop") {
    // Stop is a checkpoint like UserPromptSubmit, so an unknown session is
    // auto-registered — but the queue is deliberately NOT drained: a message
    // queued for the session must survive to the next UserPromptSubmit, and
    // Stop can arrive before that checkpoint if the turn ends without one.
    const session = await resolveCheckpointSession(projectDir, event);
    const checkpoint = await persistCheckpoint(projectDir, session, event);
    if (event.transcript_path !== undefined && shouldMirrorTranscript(checkpoint)) {
      await mirrorSessionTranscript(projectDir, checkpoint.normalizedId, event.transcript_path);
    }
    return { sessionId: checkpoint.normalizedId, queuedMessages: [] };
  }

  // SessionEnd. Every documented reason (clear|resume|logout|other) is an
  // ordinary teardown — none of them signals a crash, so none maps to "failed".
  const metadata = sessionMetadata(event);
  const session = await updateSession(projectDir, {
    id: event.session_id,
    status: "completed",
    ...(metadata !== undefined && { metadata }),
  });
  if (event.transcript_path !== undefined && shouldMirrorTranscript(session)) {
    await mirrorSessionTranscript(projectDir, session.normalizedId, event.transcript_path);
  }
  return { sessionId: session.normalizedId, queuedMessages: [] };
}

hookEventsRoute.post("/api/hook/:slug/event", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    return handleHookEvent(projectDir, await parseBody(c, hookEventSchema));
  }),
);
