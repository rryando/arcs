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
 * `SessionStart` additionally answers with `stagedContext`: the same staged
 * environment an ARCS-owned headless run carries on `--append-system-prompt`,
 * so a terminal a human drives knows its project, its workspace and its DAG
 * position without the human setting the stage by hand. See
 * `sessionStartContext` for what differs from the owned path.
 *
 * The response stays ARCS-shaped (`{sessionId, queuedMessages, stagedContext?}`);
 * turning that into Claude Code's `hookSpecificOutput` envelope is the hook
 * script's job, so a change to Claude Code's wire format never reaches the
 * server.
 *
 * Unlike every other route here this one is not browser-facing, so it sits
 * behind `requireHookToken` in addition to the global loopback check.
 */

import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { mirrorSessionTranscript } from "../../utils/claude-transcript.js";
import { HOOK_EVENTS } from "../../utils/hook-contract.js";
import { readJsonSafe } from "../../utils/json.js";
import { readPlanIndex } from "../../utils/plan-store.js";
import {
  drainSessionMessageQueue,
  getSession,
  type SessionMeta,
  updateSession,
  upsertSession,
} from "../../utils/session-store.js";
import { listTasks } from "../../utils/task-store.js";
import { deriveOperatingBrief } from "../../utils/workflow-policy.js";
import { buildStagedEnvironment, stripStageDelimiters } from "../prompt-assembly.js";
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
  /**
   * SessionStart only, and absent when staging failed — the hook script's
   * degradation is silence, so an omitted field and a failed build look the
   * same to it on purpose.
   */
  stagedContext?: string;
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

// ---------------------------------------------------------------------------
// SessionStart staged context
// ---------------------------------------------------------------------------

/**
 * Ceiling on the block a SessionStart mirrors into a terminal, in characters.
 *
 * Deliberately far below `STAGE_SOFT_CAP` (6000): that budget is spent inside a
 * headless `claude -p` process nobody is watching, whereas this text lands at
 * the head of a live session a human is about to type into. Anything wider buys
 * context nobody asked for at the cost of the window they did.
 *
 * Enforced by SELECTION, never by clipping — see `sessionStartContext`.
 * `scripts/claude-code-session-hook.mjs` carries its own, wider refusal bound
 * (`MAX_CONTEXT_CHARS`), pinned against this constant by
 * `test/claude-code-hook-script.test.ts`.
 */
export const SESSION_START_STAGE_CAP = 2500;

/** Width for one value interpolated into the degraded block. */
const DEGRADED_FIELD_WIDTH = 160;

/**
 * Normalizes one untrusted value for an ARCS-authored line: delimiter-stripped,
 * whitespace-collapsed, width-bounded. Mirrors prompt-assembly's `field` (not
 * exported), and applies to EVERY slot below rather than to the values that
 * look risky — a project name and a task title are both agent- or user-authored
 * text arriving in the controller's voice.
 */
function degradedField(value: string, width = DEGRADED_FIELD_WIDTH): string {
  const clean = stripStageDelimiters(value).replace(/\s+/g, " ").trim();
  return clean.length <= width ? clean : `${clean.slice(0, width - 1)}…`;
}

/**
 * The two lines a session with nothing staged for it still deserves.
 *
 * An observed session carries no `linkedNodeId` until a human sets one —
 * discovery never links — so this is the COMMON case at SessionStart, not an
 * edge. It therefore states what is true and useful (which project this
 * workspace is, how to read its DAG, and what the operating brief says the
 * project is currently on) instead of apologising for the missing link.
 *
 * No wrapper, and none needed: nothing here is a quoted body. The two variable
 * values are stripped, collapsed and width-bounded through `degradedField`,
 * exactly as prompt-assembly treats the same task title in its own brief block.
 */
async function degradedStagedContext(projectDir: string, slug: string): Promise<string> {
  const [projectMeta, tasks, planIndex] = await Promise.all([
    readJsonSafe<{ name?: string }>(join(projectDir, "meta.json")),
    listTasks(projectDir),
    readPlanIndex(projectDir),
  ]);
  const operating = deriveOperatingBrief({
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      planId: t.planId,
      priority: t.priority,
      dependsOn: t.dependsOn,
    })),
    plans: planIndex.plans.map((p) => ({ id: p.id, title: p.title, status: p.status })),
  });
  return [
    `This workspace is tracked by ARCS as project ${degradedField(slug)} ` +
      `"${degradedField(projectMeta?.name ?? slug)}" — read its DAG with ` +
      `\`arcs brief ${degradedField(slug)} --lean --json\`. Link this session to a task in the ` +
      "ARCS web UI to stage that task's scope, acceptance and verify command here.",
    `Project current focus: ${degradedField(operating.currentFocus)} · ` +
      `Next action: ${degradedField(operating.nextAction)}`,
  ].join("\n");
}

/**
 * The staged block a SessionStart answers with, or nothing at all.
 *
 * Same builder as an ARCS-owned headless run (`buildStagedEnvironment`), and
 * deliberately NOT the same call:
 *  - no references — those are attached per SEND, and a session that has not
 *    started yet has none;
 *  - no argv, no permission segment — the terminal's user owns their own
 *    permissions and ARCS does not get to narrow them from here;
 *  - a much tighter cap (see SESSION_START_STAGE_CAP);
 *  - STATELESS — no fingerprint, no `metadata.stage`, no restage bookkeeping at
 *    all. The staleness machinery exists to avoid re-injecting an unchanged
 *    block across turns of one conversation; a SessionStart IS turn zero, so
 *    there is nothing to compare against and nothing to persist.
 *
 * The cap is enforced by SELECTION — the whole assembled text, or the whole
 * degraded block — never by clipping the assembled text. A head truncation
 * would keep an untrusted body's opener and sever its closer, putting every
 * later ARCS-authored line (including the one stating the controller's own
 * scope) inside an unterminated untrusted region. `softCap` lets the builder's
 * own ladder degrade gracefully first; the degraded block is the floor for the
 * DAG wide enough that even a fully degraded build does not fit.
 *
 * Any failure returns `undefined`: the hook script's hard rule is that a broken
 * bridge is invisible, so a staging error must reach it as an absent field, not
 * as a 500.
 *
 * ONE builder, but not one wording: prompt-assembly conditions its IDENTITY and
 * LIMITS blocks on the session's PERSISTED origin, and provenance is CREATE-ONLY
 * (see `registerSession`). A first sighting is created `observed`; an event
 * arriving for an ARCS-owned thread refreshes it without demoting it, so an
 * `arcs`-origin session reaching SessionStart keeps its origin and therefore gets
 * the `arcs` variant. Either variant states what is true of THAT session — for
 * the observed one, that ARCS is NOT setting its tools, permissions or lifecycle,
 * which the bullets above are the reason for, since no argv exists to set them
 * with. The untrusted-content half is identical on both origins; only the claim
 * of control moves.
 */
async function sessionStartContext(
  projectDir: string,
  slug: string,
  session: SessionMeta,
  event: HookEvent,
): Promise<string | undefined> {
  try {
    if (session.linkedNodeType && session.linkedNodeId) {
      const staged = await buildStagedEnvironment(projectDir, slug, session, {
        // Claude Code's own cwd: the directory this terminal is actually in,
        // which is a truer workspace root than the project's registered first
        // path when a project spans more than one checkout.
        ...(event.cwd && { workspaceRoot: event.cwd }),
        softCap: SESSION_START_STAGE_CAP,
      });
      if (staged.text.length <= SESSION_START_STAGE_CAP) return staged.text;
    }
    return await degradedStagedContext(projectDir, slug);
  } catch {
    return undefined;
  }
}

async function handleHookEvent(
  projectDir: string,
  slug: string,
  event: HookEvent,
): Promise<HookEventResult> {
  if (event.hook_event_name === "SessionStart") {
    const session = await registerSession(projectDir, event);
    const stagedContext = await sessionStartContext(projectDir, slug, session, event);
    return {
      sessionId: session.normalizedId,
      queuedMessages: [],
      ...(stagedContext !== undefined && { stagedContext }),
    };
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
    const slug = c.req.param("slug");
    // Validates the slug before it is threaded on to the stager, which uses it
    // both as a knowledge-selection key and as an interpolated identity value.
    const projectDir = requireProjectDir(slug);
    return handleHookEvent(projectDir, slug, await parseBody(c, hookEventSchema));
  }),
);
