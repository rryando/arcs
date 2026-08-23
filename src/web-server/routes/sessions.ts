/**
 * Session routes — full CRUD over the per-project session index.
 *
 * Sessions are runtime records for agent threads attached to a project. Every
 * record this module mints is ARCS-origin ("arcs"): a thread ARCS drives itself
 * through one-shot runs, `opencode run` for the default opencode runtime and
 * headless `claude -p` for legacy claude-code threads. All mutations go through
 * the locked session-store, so concurrent writers cannot clobber each other.
 *
 * One route reaches outside the store: `POST /sessions/:id/turns` RUNS a turn.
 * The RUNTIME policy — argv shapes and wire format — lives in run-driver.ts
 * adapters; the generic lifecycle (spawn, concurrency slot, durable event log,
 * timeout) stays in claude-runner.ts and run-event-log.ts. Every route here is
 * browser-facing and therefore already behind the global loopback-only
 * `secureLocalRequest` middleware — no per-route auth.
 */

import { randomUUID } from "node:crypto";
import { type FileHandle, open, readFile, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  appendReferenceTurn,
  appendSessionTurn,
  readSessionTurns,
  referenceTurnText,
  type SessionReference,
  sessionTranscriptPath,
} from "../../utils/claude-transcript.js";
import { DagError } from "../../utils/errors.js";
import { readJsonSafe } from "../../utils/json.js";
import {
  beginSessionRun,
  createSession,
  deleteSession,
  deriveSessionPhase,
  getSession,
  listSessions,
  SESSION_LINKED_NODE_TYPES,
  SESSION_RUNTIME_TYPES,
  SESSION_STATUSES,
  type SessionFilters,
  type SessionMeta,
  type SessionPhase,
  sessionRunClaim,
  settleSessionRun,
  updateSession,
  upsertSession,
} from "../../utils/session-store.js";
import { normalizeIdentifier } from "../../utils/slug.js";
import {
  type ClaudeRunnerOptions,
  type ClaudeRunRecord,
  isRunLive,
  liveRunPid,
  resolveTimeoutMs,
  runClaudeJob,
} from "../claude-runner.js";
import { buildPermissionArgv, RUN_INTENTS, type RunIntent } from "../permission-policy.js";
import { buildStagedEnvironment, planStageRefresh, renderReferences } from "../prompt-assembly.js";
import { fail, parseBody, requireProjectDir, respond } from "../respond.js";
import { getRunDriver } from "../run-driver.js";
import {
  foldRunEventLog,
  pruneRunEventLogs,
  RUN_EVENT_LOG_MAX_BYTES,
  runEventLogPath,
} from "../run-event-log.js";
import { isProcessAlive, reconcileSessionPhases } from "../session-reconciler.js";

export const sessionsRoute = new Hono();

/**
 * Payload for POST /sessions — one ARCS-owned thread record.
 *
 * `runtimeType` defaults to "opencode": the runtime the run-driver seam exists
 * for. `runtimeSessionId` is optional and only ever NAMES the record when
 * given; the runtime-native id of an opencode thread is unknowable until its
 * first settled run harvests one, so a minted thread starts without it.
 * Creation spawns nothing — the first POST /turns does.
 */
const createSessionSchema = z.object({
  runtimeType: z.enum(SESSION_RUNTIME_TYPES).default("opencode"),
  runtimeSessionId: z.string().min(1).optional(),
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

/**
 * The `doc` variant — a markdown document section.
 *
 * FROZEN, field for field: this is the only reference shape that existed before
 * the union, so every reference turn already on disk carries exactly these keys
 * and nothing else. Widening or tightening `section`/`source` here would strand
 * those sidecars, so the union adds a tag and touches nothing else. The tag is
 * REQUIRED here, exactly as on the pointer variants: a legacy body carrying no
 * tag never reaches this schema untagged, because `sessionReferenceSchema`'s
 * preprocess fills it in before the union runs. That preprocess is the whole
 * legacy mechanism — a default here would be a dead second one implying the tag
 * is optional at this boundary when it cannot be.
 */
const docReferenceSchema = z.object({
  type: z.literal("doc"),
  section: z.object({
    depth: z.number(),
    text: z.string(),
    id: z.string(),
    startOffset: z.number(),
    endOffset: z.number(),
  }),
  text: z.string(),
  source: z.object({
    kind: z.enum(["overview", "knowledge", "plan"]),
    label: z.string(),
    doc: z.string().optional(),
    id: z.string().optional(),
  }),
});

/** The `file` variant — a line range in a workspace file. `headRev` rides along
 *  so a later diff can tell whether the file moved under the agent. */
const fileReferenceSchema = z.object({
  type: z.literal("file"),
  path: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  excerpt: z.string().optional(),
  headRev: z.string().optional(),
});

/** The `node` variant — a DAG entity, with no text slice of its own. */
const nodeReferenceSchema = z.object({
  type: z.literal("node"),
  kind: z.enum(["task", "plan", "knowledge"]),
  id: z.string().min(1),
});

/**
 * Something the caller is pointing the session at. Each entry is followed by an
 * ARCS-authored reference turn in the session's transcript sidecar (see
 * `appendReference`) once the turn is accepted.
 *
 * A discriminated union on `type`, so an unknown variant is REJECTED (400
 * INVALID_BODY naming the three tags) rather than coerced into the nearest
 * shape. The one accommodation is the preprocess below: a body with no `type`
 * at all can only be a pre-union doc reference — every caller and every stored
 * turn predating the union is exactly that — so the tag is filled in before the
 * union sees it. Nothing else is inferred: an explicitly tagged body is matched
 * on its own tag and fails on its own merits.
 */
const sessionReferenceSchema = z
  .preprocess(
    (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value) && !("type" in value)
        ? { ...value, type: "doc" }
        : value,
    z.discriminatedUnion("type", [docReferenceSchema, fileReferenceSchema, nodeReferenceSchema]),
  )
  .superRefine((reference, ctx) => {
    // A backwards slice would render a nonsense pointer into the prompt. Checked
    // here rather than on the variant because a discriminated-union option must
    // stay a plain object schema.
    if (reference.type === "file" && reference.endLine < reference.startLine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endLine"],
        message: `endLine (${reference.endLine}) must be >= startLine (${reference.startLine})`,
      });
    }
  });

/**
 * Payload for POST /sessions/:id/turns — one turn of a headless conversation.
 *
 * `intent` is a PERMISSION POLICY, not a delivery mode: it selects the tool set
 * and permission mode `buildPermissionArgv` emits (`ask` → read-only + plan,
 * `change` → the edit surface + acceptEdits) and decides nothing else.
 *
 * `threadRef` names an ARCS thread RECORD to continue — never a runtime-native
 * session id, and never a record ARCS does not own (that is refused, not
 * claimed). `refs` are the turn's references: they render into the user-facing
 * prompt AND land on the sidecar. `guards` is validated and then deliberately
 * ignored here; the change-intent preflight that reads it is a separate task,
 * and accepting the key now keeps that task from being a breaking payload
 * change.
 */
const turnSchema = z.object({
  intent: z.enum(RUN_INTENTS),
  message: z.string().min(1),
  refs: z.array(sessionReferenceSchema).optional(),
  threadRef: z.string().min(1).optional(),
  guards: z.record(z.unknown()).optional(),
});

/**
 * Records a delivered reference on the session's transcript sidecar, one turn
 * per `refs` entry on POST /turns.
 *
 * A `doc` reference writes exactly the fields this route has always written —
 * `text`, `ts`, `section`, `source`, in that order — so the serialized line is
 * byte-identical to one written before the union existed: no tag is added to the
 * DOC record.
 *
 * That is NOT "the tag never reaches disk". The pointer kinds have no historical
 * fields, so they ride `ref` whole — discriminator included — and a stored
 * `ref: {type: "file"|"node", ...}` is exactly what makes a pointer turn
 * re-readable as its own variant. The tag is on disk there, correctly and
 * necessarily; it is only the frozen doc record that stays untagged.
 */
async function appendReference(
  projectDir: string,
  sessionId: string,
  reference: SessionReference,
): Promise<void> {
  await appendReferenceTurn(projectDir, sessionId, {
    text: referenceTurnText(reference),
    ts: new Date().toISOString(),
    ...(reference.type === "doc"
      ? { section: reference.section, source: reference.source }
      : { ref: reference }),
  });
}

function sessionDirectory(session: SessionMeta): string | undefined {
  const directory = session.metadata?.directory;
  return typeof directory === "string" && directory ? directory : undefined;
}

/**
 * The worktree a newly minted thread should run in.
 *
 * Guessing is not an option: a turn run in the wrong directory would silently
 * point the agent at the wrong repository. An unregistered project is an error.
 */
async function primaryWorkspacePath(projectDir: string, slug: string): Promise<string> {
  const meta = await readJsonSafe<{ workspacePaths?: string[] }>(resolve(projectDir, "meta.json"));
  const directory = meta?.workspacePaths?.[0];
  if (!directory) {
    throw new DagError(
      "PROJECT_WORKSPACE_UNSET",
      `Project "${slug}" has no registered workspace path, so there is no directory to ` +
        `create a session in — run \`arcs project update-paths ${slug} --add <path>\` first.`,
    );
  }
  return directory;
}

/** A metadata slot read back as a real string, or `undefined`. A hand-edited
 *  index (and a cleared key, written as `""`) can carry anything here. */
function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
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

// ---------------------------------------------------------------------------
// Derived phase (read side)
// ---------------------------------------------------------------------------

/**
 * A session as a reader gets it: the stored record plus its reconciled phase.
 *
 * `phase` is DERIVED per response and never persisted — the store has no such
 * field and cannot be given one. It is the single answer to "is this session
 * live right now"; the raw `status` still travels for the record's own state.
 */
type SessionView = SessionMeta & { phase: SessionPhase };

// The state this module decides from — `sessionState()` and the predicates over
// it — is NOT defined here. It lives in `src/shared/session-vocabulary.ts`, the
// zero-import leaf `web/src/components/SessionStatusBadge.tsx` imports too, so
// an affordance the client offers and the answer this server gives are computed
// by the same function rather than by two copies of it. The reachable
// (status, phase) pairs are enumerated there.

/**
 * Epoch-ms deadline the claimed run will be killed at, when the spawn site
 * persisted one. Validated rather than trusted — a hand-edited index can carry
 * anything under this key.
 */
function runDeadlineAt(session: SessionMeta): number | undefined {
  const value = session.metadata?.runDeadlineAt;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The claimed run's own deadline, standing in for the store's fixed heartbeat
 * TTL.
 *
 * `RUN_HEARTBEAT_TTL_MS` is sized to the runner's 10-minute DEFAULT_TIMEOUT_MS,
 * but `resolveTimeoutMs` honours an explicit `timeoutMs` and
 * `ARCS_CLAUDE_RUN_TIMEOUT_MS`, and nothing refreshes `heartbeatAt` mid-run —
 * so past minute 10 a perfectly healthy 30-minute run derives `idle`, and the
 * reconciler cannot rescue it because it early-returns on any non-`running`
 * derivation and never probes the pid. The spawn site is the only place that
 * knows the timeout, so it persists the resulting deadline on the claim
 * (`metadata.runDeadlineAt`) and it is read back here as that run's TTL:
 *
 *  - inside the deadline the pid decides, exactly as the reconciler would;
 *  - past it the claim is not evidence of anything — the runner has already
 *    SIGTERMed then SIGKILLed the child — so it demotes to `idle`.
 *
 * Only ever consulted for a record that still holds a claim AND carries a
 * deadline; anything else (including every claim written before this field
 * existed) keeps the reconciler's own answer untouched.
 */
function runDeadlinePhase(session: SessionMeta, phase: SessionPhase, now: number): SessionPhase {
  // A terminal status outranks every liveness signal — a session that is over
  // is never reopened here.
  if (phase === "failed" || phase === "ended") return phase;
  const deadlineAt = runDeadlineAt(session);
  if (sessionRunClaim(session) === undefined || deadlineAt === undefined) return phase;
  if (now > deadlineAt) return "idle";
  const pid = session.currentRunPid;
  // No pid to probe (the spawn produced none) — the deadline stands alone.
  if (typeof pid !== "number") return "running";
  return isProcessAlive(pid) ? "running" : "idle";
}

/**
 * Attaches the reconciled phase to each session of ONE response.
 *
 * `reconcileSessionPhases` takes the project's whole index and runs AT MOST one
 * `claude agents --json` probe for it, so this is never one probe per session —
 * and the detail route pays exactly what the list does. At most, because the
 * probe is lazy: a request whose records all answer from their own evidence
 * (terminal, idle, or holding a run claim) spawns no subprocess at all. A record
 * that appeared between the two reads is not in the reconciler's answer and
 * falls back to its own store-derived phase.
 */
async function withPhases(projectDir: string, sessions: SessionMeta[]): Promise<SessionView[]> {
  const now = Date.now();
  const reconciled = new Map(
    (await reconcileSessionPhases(projectDir, { now })).map((view) => [view.sessionId, view.phase]),
  );
  return sessions.map((session) => ({
    ...session,
    phase: runDeadlinePhase(
      session,
      reconciled.get(session.normalizedId) ?? deriveSessionPhase(session, { now }),
      now,
    ),
  }));
}

// ---------------------------------------------------------------------------
// Run claims
// ---------------------------------------------------------------------------

interface RunWriteBackContext {
  /**
   * The turn's permission intent. Persisted onto `metadata.run.mode` — the
   * field survives (three readers) and now carries the only "how was this run
   * shaped" fact there is left to carry, the targeting modes having gone.
   */
  intent: RunIntent;
  writeTarget: SessionMeta;
  /** Id of the run this write-back settles — the claim it is allowed to release. */
  runId: string;
  /**
   * Resolves once the spawn-time claim (including the child's pid) has landed.
   * The write-back MUST await it before settling: settling releases the claim,
   * so a pid write arriving afterwards would resurrect a run that already
   * ended and leave the session reading `running` until its deadline. Both ends
   * belong to the same request, so the ordering is expressed directly rather
   * than hoped for.
   */
  claimed: Promise<void>;
}

/** Existing `metadata.run` as a mergeable object — anything else reads empty. */
function runMetadata(session: SessionMeta): Record<string, unknown> {
  const run = session.metadata?.run;
  if (typeof run !== "object" || run === null || Array.isArray(run)) return {};
  return run as Record<string, unknown>;
}

/**
 * Claude's own words for the two ways a thread's seed decision can be wrong,
 * observed on claude 2.1.223's flag validation (exit 1, before any network
 * call): `--session-id <id>` on an id it already knows, and `--resume <id>` on
 * one it does not.
 *
 * FRAGILE BY CONSTRUCTION, and stated as such rather than hidden: these are a
 * CLI's human-facing stderr strings, not a stable contract, and a claude patch
 * release can reword either without notice. Each branch is therefore pinned by
 * a test driving the literal message, and each is a REPAIR rather than a
 * behaviour: a message that stops matching costs the self-heal, never the run.
 */
const THREAD_SEED_CONFLICT_PATTERN = /already in use/i;
const THREAD_UNKNOWN_PATTERN = /No conversation found with session ID/i;

/** Typed failure the panel can act on, plus the metadata that unwedges it. */
interface ThreadSeedRepair {
  errorCode?: "THREAD_SEED_CONFLICT" | "THREAD_UNKNOWN_TO_CLAUDE";
  metadata: Record<string, unknown>;
}

/**
 * Reads the child's error text as EVIDENCE about the thread's seed decision and
 * repairs the record from it.
 *
 * `metadata.threadInitialized` is persisted at SPAWN — its honest meaning is
 * "ARCS has already handed this uuid to `--session-id`", which the route knows
 * with certainty the moment it builds argv and which survives a server crash
 * where the settle never runs. That alone closes the wedge (a run that times
 * out after claude registered the uuid no longer re-seeds forever). These two
 * branches close the remainder, where the flag and claude disagree:
 *
 *  - "already in use" — claude HAS the id ARCS thought it had not handed over.
 *    The flag was a false negative; set it and the next turn resumes.
 *  - "No conversation found with session ID" — claude does NOT have the id ARCS
 *    resumed. Clearing the flag alone would re-seed the SAME uuid, so a fresh
 *    one is minted with it: keeping the old id would re-issue the identical
 *    doomed `--resume` on every later turn — the exact wedge this repair exists
 *    to prevent.
 */
function repairThreadSeed(record: ClaudeRunRecord): ThreadSeedRepair {
  const error = typeof record.error === "string" ? record.error : "";
  if (error === "") return { metadata: {} };
  if (THREAD_SEED_CONFLICT_PATTERN.test(error)) {
    return { errorCode: "THREAD_SEED_CONFLICT", metadata: { threadInitialized: true } };
  }
  if (THREAD_UNKNOWN_PATTERN.test(error)) {
    return {
      errorCode: "THREAD_UNKNOWN_TO_CLAUDE",
      metadata: {
        threadInitialized: false,
        claudeSessionId: randomUUID(),
      },
    };
  }
  return { metadata: {} };
}

/**
 * The write-back the route registers on runClaudeJob, invoked by the runner
 * after the headless child fully exits — on every outcome (success / error /
 * timeout / killed).
 *
 * Every write target is an ARCS-owned thread, so there is exactly one sidecar
 * discipline: `appendSessionTurn`-owned, never mirrored. The run's own event log
 * folds down first (assistant text plus one turn per tool call, every turn
 * tagged with the run id so a second fold is a no-op) — through the write
 * target's own driver normalizer when it has one, so an opencode log's
 * `{type, sessionID, part}` lines fold instead of being read as claude events.
 * Only for claude-code, and only when that fold produced no assistant text — no
 * log, an empty log, a child that spoke only through the terminal `result`
 * envelope — does the captured reply get appended as an assistant turn on a
 * success outcome; error/timeout outcomes append nothing. A driver-driven run
 * never appends the captured reply: the runner's reader does not speak that
 * wire format, so its fallback "reply" is raw NDJSON, while the durable log the
 * fold just read IS the reply when there was one.
 *
 * When the fold harvested a runtime-native session id onto a thread that has
 * none (an opencode first turn), it is persisted BEFORE the settle releases the
 * claim — the next turn must continue this runtime session, not fork a fresh
 * one. The thread's `lastMessageAt` moves to the settle too, and a non-terminal
 * status is re-stamped active: the thread was just driven.
 *
 * Every path finalizes metadata.run with the settled record (pid/startedAt/
 * mode plus endedAt/outcome/error/replyChars) so the panel shows the true
 * result. Best-effort by contract: the runner swallows any error thrown here,
 * so a failed write-back never surfaces on the accepted 202.
 *
 * The run CLAIM is released here too, by `settleSessionRun` rather than by a
 * hand-assembled `metadata.run` write: releasing the claim and stamping the
 * outcome is one read-modify-write under the store lock, guarded by the run id
 * so a run that has already been superseded never settles a newer one out from
 * under it.
 */
async function writeBackRun(
  projectDir: string,
  ctx: RunWriteBackContext,
  record: ClaudeRunRecord,
): Promise<void> {
  // Never settle a claim that is still being written (see ctx.claimed).
  await ctx.claimed;

  // Fold the run's durable event log down into the sidecar first. Idempotent by
  // its own output — every folded turn carries the run id, and a run already
  // represented there folds to nothing.
  const fold = await foldRunEventLog(projectDir, ctx.writeTarget.normalizedId, ctx.runId, {
    runtimeType: ctx.writeTarget.runtimeType,
  });

  // The harvested runtime session id lands before the settle: from the moment
  // the claim is released the next turn is accepted, and it has to see the id
  // or it mints a fresh runtime thread instead of continuing this one.
  if (
    fold.runtimeSessionId !== undefined &&
    ctx.writeTarget.runtimeSessionId.trim() === "" &&
    ctx.writeTarget.normalizedId !== fold.runtimeSessionId
  ) {
    await updateSession(projectDir, {
      id: ctx.writeTarget.normalizedId,
      runtimeSessionId: fold.runtimeSessionId,
    });
  }

  if (
    !fold.assistantTextFolded &&
    record.outcome === "success" &&
    record.replyText !== undefined &&
    ctx.writeTarget.runtimeType === "claude-code"
  ) {
    // Nothing in the log spoke for this run (no log at all, or only tool
    // turns): the captured reply lands in the sidecar as an assistant turn,
    // minted in the shared negative id space after the user turn and any
    // reference. Tagged with the run id too, so it is covered by the same
    // no-second-fold guard. Error/timeout outcomes append nothing.
    await appendSessionTurn(projectDir, ctx.writeTarget.normalizedId, {
      type: "assistant",
      text: record.replyText,
      run: ctx.runId,
    });
  }

  // Bounded retention: the log that just settled is the newest, so it always
  // survives and the sessions dir stays capped at RUN_EVENT_LOG_RETENTION logs
  // per session however many runs it accumulates.
  await pruneRunEventLogs(projectDir, ctx.writeTarget.normalizedId);

  const repair = repairThreadSeed(record);

  // ONE write: the outcome, everything the runner measured, the seed-decision
  // repair, and the claim release. `endedAt` rides the record so the run is
  // stamped with the moment the CHILD exited, not the moment this write ran.
  //
  // Leaving any of it to a follow-up `updateSession` is what made the repair
  // unsound, because the RUNNER frees its concurrency slot (endRun) BEFORE it
  // fires this write-back: from the moment the claim is released the next turn
  // is accepted, so a repair one write later is both readable in the gap — the
  // record reads settled-and-failed while still carrying the seed state that
  // failed it, and the next turn re-issues the very `--resume` claude just
  // refused — and able to land AFTER that turn claimed the record, clobbering
  // its live metadata.run and re-minting its uuid mid-flight. The `runId` guard
  // is only honest inside the settle's own lock.
  await settleSessionRun(projectDir, ctx.writeTarget.normalizedId, {
    runId: ctx.runId,
    outcome: record.outcome,
    ...(record.error !== undefined && { error: record.error }),
    ...(record.endedAt !== undefined && { endedAt: record.endedAt }),
    // Everything the RUNNER measured, which no claim could have known at spawn:
    // the pid/startedAt the child actually reported, the run's intent, and the
    // stream observations — time-to-first-token and wire-format drift are only
    // readable after the fact if they reach disk.
    run: {
      pid: record.pid,
      startedAt: record.startedAt,
      mode: ctx.intent,
      // Typed, so the panel can act on the failure rather than render opaque
      // CLI text at the user.
      ...(repair.errorCode !== undefined && { errorCode: repair.errorCode }),
      // Reply size and reader drift are CLAUDE READER observations — the
      // built-in reader does not speak a driver runtime's wire format, so its
      // fallback reply length and skip count would only lie about one.
      ...(ctx.writeTarget.runtimeType === "claude-code" &&
        record.replyChars !== undefined && { replyChars: record.replyChars }),
      ...(record.firstTokenAt !== undefined && { firstTokenAt: record.firstTokenAt }),
      ...(ctx.writeTarget.runtimeType === "claude-code" &&
        record.skippedLines !== undefined && { skippedLines: record.skippedLines }),
      ...(record.eventLogLines !== undefined && { eventLogLines: record.eventLogLines }),
      // Whether the log is the WHOLE stream. `eventLogLines` alone cannot say:
      // a log capped on its first chunk reports zero lines, the same number a
      // child that never spoke reports. Anything that later tails this file by
      // offset reads this before it treats the file as complete.
      ...(record.eventLogTruncated !== undefined && {
        eventLogTruncated: record.eventLogTruncated,
      }),
      // A log that could not be written is REPORTED here, never thrown: the run
      // itself already succeeded or failed on its own merits.
      ...(record.eventLogError !== undefined && { eventLogError: record.eventLogError }),
    },
    ...(Object.keys(repair.metadata).length > 0 && { metadata: repair.metadata }),
  });

  // The thread was just driven: its last message is this run's end, and a
  // non-terminal status is re-stamped active. Terminal statuses are never
  // reopened by a run — the same rule the phase derivation enforces.
  const terminal =
    ctx.writeTarget.status === "completed" ||
    ctx.writeTarget.status === "failed" ||
    ctx.writeTarget.status === "disconnected";
  await updateSession(projectDir, {
    id: ctx.writeTarget.normalizedId,
    lastMessageAt: new Date(record.endedAt ?? Date.now()).toISOString(),
    ...(terminal ? {} : { status: "active" as const }),
  });
}

sessionsRoute.get("/api/p/:slug/sessions", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const sessions = await listSessions(
      projectDir,
      parseFilters(c.req.query("status"), c.req.query("runtimeType")),
    );
    return { sessions: await withPhases(projectDir, sessions) };
  }),
);

sessionsRoute.post("/api/p/:slug/sessions", async (c) =>
  respond(
    c,
    async () => {
      const slug = c.req.param("slug");
      const projectDir = requireProjectDir(slug);
      const input = await parseBody(c, createSessionSchema);
      // ARCS-origin only, and the name is minted unless the caller supplies
      // one: provenance is never client-settable, and a thread without a
      // runtime-native id still needs a stable record key from birth. The
      // supplied name keys the RECORD only — it never seeds
      // `runtimeSessionId`, which stays blank until the runtime itself
      // produces one (a harvested opencode session id) or the claude path
      // mints its uuid into metadata at first spawn.
      const threadName = input.runtimeSessionId ?? `arcs-thread-${slug}-${randomUUID()}`;
      // The workspace is resolved NOW so every later turn spawns in the same
      // directory even if the project's registered paths change in between.
      const directory =
        metadataString(input.metadata?.directory) ?? (await primaryWorkspacePath(projectDir, slug));
      return createSession(projectDir, {
        runtimeType: input.runtimeType,
        recordName: threadName,
        origin: "arcs",
        status: input.status,
        startedAt: input.startedAt,
        lastMessageAt: input.lastMessageAt,
        userEmail: input.userEmail,
        metadata: { control: "arcs-owned", directory, ...input.metadata },
      });
    },
    201,
  ),
);

sessionsRoute.get("/api/p/:slug/sessions/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const session = await getSession(projectDir, c.req.param("id"));
    const [view] = await withPhases(projectDir, [session]);
    return view;
  }),
);

sessionsRoute.patch("/api/p/:slug/sessions/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const input = await parseBody(c, updateSessionSchema);
    return updateSession(projectDir, { id: c.req.param("id"), ...input });
  }),
);

// ---------------------------------------------------------------------------
// Turn targeting — which record a turn writes to
// ---------------------------------------------------------------------------

/**
 * The two identities one turn juggles, deliberately kept apart:
 *
 *  - `writeTarget.normalizedId` — the ARCS THREAD id (`arcs-thread-<slug>-<uuid4>`).
 *    A record NAME: it labels the session picker, names the transcript sidecar,
 *    keys the run's concurrency slot, and never appears in argv.
 *  - the runtime-native session id — what the RUNTIME knows the thread by. For
 *    claude-code it is the bare uuid on `metadata.claudeSessionId`
 *    (`--session-id`/`--resume` take a bare RFC-4122 uuid only and exit 1 with
 *    "Invalid session ID. Must be a valid UUID." on anything else); for opencode
 *    it is the session id harvested off the first settled run and persisted onto
 *    `runtimeSessionId` — blank until then.
 */
interface TurnTarget {
  writeTarget: SessionMeta;
  /** Directory the child actually runs in (spawn options.cwd, never argv). */
  dir: string;
}

/**
 * The thread record `threadRef` names, or `undefined` when the index answers
 * that there is no such record.
 *
 * `getSession`'s `ITEM_NOT_FOUND` is NOT evidence of absence: `readSessionIndex`
 * folds an unreadable index into an empty one (`readJsonSafe` swallows every
 * error class), so an EACCES or an EISDIR on a live index arrives wearing the
 * deleted record's code. Minting on that answer would upsert a fresh ARCS
 * thread over a name that already belongs to something else. So a not-found is
 * believed only when a DIRECT read of the index says this record is not listed
 * (or that there is no index at all); anything else is reported as unavailable
 * and the caller retries.
 */
async function readThreadRecord(
  projectDir: string,
  threadRef: string,
): Promise<SessionMeta | undefined> {
  try {
    return await getSession(projectDir, threadRef);
  } catch (err) {
    if (!(err instanceof DagError) || err.code !== "ITEM_NOT_FOUND") throw err;
  }
  if (await sessionIndexAnswered(projectDir, normalizeIdentifier(threadRef))) return undefined;
  throw new DagError(
    "SESSION_INDEX_UNAVAILABLE",
    `cannot tell whether thread "${threadRef}" exists — the session index did not answer for ` +
      `it, and minting a second record over that name would collide with whatever holds the ` +
      `name today. Retry once the index reads.`,
  );
}

/**
 * Mints a fresh ARCS thread for a `threadRef` that names nothing yet. The
 * runtime defaults to "opencode" — the same default POST /sessions applies — so
 * every minted-by-turn thread is drivable by the run-driver seam from birth.
 */
async function mintThread(
  projectDir: string,
  slug: string,
  threadName: string,
): Promise<SessionMeta> {
  const dir = await primaryWorkspacePath(projectDir, slug);
  return upsertSession(projectDir, {
    runtimeType: "opencode",
    recordName: threadName,
    origin: "arcs",
    metadata: { control: "arcs-owned", directory: dir },
  });
}

/**
 * The implicit Ask-AI thread: one ARCS-owned thread per project that the Ask-AI
 * panel chats through, addressed by the virtual id `ask` — no thread picker,
 * no create ceremony. The record's name is `ask-ai`, so its `normalizedId` (and
 * therefore its transcript sidecar and run logs) is stable across processes.
 */
const ASK_THREAD_ALIAS = "ask";
const ASK_THREAD_NAME = "ask-ai";

/**
 * The project's implicit Ask-AI thread, minted on first use.
 *
 * A record already holding the `ask-ai` name but NOT ARCS-owned is refused
 * rather than claimed or silently shadowed: the name would otherwise key two
 * different transcripts depending on which resolution won.
 */
async function resolveAskThread(projectDir: string, slug: string): Promise<SessionMeta> {
  const existing = await readThreadRecord(projectDir, ASK_THREAD_NAME);
  if (existing !== undefined) {
    if (existing.origin !== "arcs") {
      throw new DagError(
        "TURN_THREAD_NOT_OWNED",
        `the name "${ASK_THREAD_NAME}" is held by a non-ARCS record — free or rename it to use Ask AI`,
      );
    }
    return existing;
  }
  return mintThread(projectDir, slug, ASK_THREAD_NAME);
}

/** The turn's target session: the `ask` alias names the implicit thread. */
async function resolveTurnSession(
  projectDir: string,
  slug: string,
  rawId: string,
): Promise<SessionMeta> {
  return rawId === ASK_THREAD_ALIAS
    ? resolveAskThread(projectDir, slug)
    : getSession(projectDir, rawId);
}

/**
 * Resolves the record this turn writes to.
 *
 * Two branches, and only these two:
 *
 *  1. `threadRef` — the caller names an ARCS thread RECORD to continue. It may
 *     name one that does not exist yet (a fresh thread is minted for it), but a
 *     record that exists and is not ARCS-owned is refused rather than claimed.
 *  2. no `threadRef` — the addressed session itself must be an ARCS-owned
 *     thread; it is continued in place.
 *
 * There is no third branch. Turns used to ADOPT an observed session by forking
 * it into a new thread (`--resume <observed> --session-id <fresh>
 * --fork-session`); with the hook bridge gone there are no observed sessions
 * left to adopt, so anything that is not an ARCS thread is refused outright.
 */
async function resolveTurnTarget(
  projectDir: string,
  slug: string,
  session: SessionMeta,
  threadRef: string | undefined,
): Promise<TurnTarget> {
  let writeTarget: SessionMeta;
  if (threadRef !== undefined) {
    const existing = await readThreadRecord(projectDir, threadRef);
    if (existing !== undefined && existing.origin !== "arcs") {
      throw new DagError(
        "TURN_THREAD_NOT_OWNED",
        `cannot continue thread "${existing.normalizedId}": it is not an ARCS-owned thread`,
      );
    }
    writeTarget = existing ?? (await mintThread(projectDir, slug, threadRef));
  } else {
    if (session.origin !== "arcs") {
      throw new DagError(
        "TURN_THREAD_NOT_OWNED",
        `cannot run a turn on "${session.normalizedId}": it is not an ARCS-owned thread — ` +
          `create one with POST /api/p/${slug}/sessions and address turns to it`,
      );
    }
    writeTarget = session;
  }

  const persistedDir = sessionDirectory(writeTarget);
  const dir = persistedDir ?? (await primaryWorkspacePath(projectDir, slug));
  if (persistedDir === undefined) {
    // Pin the workspace on first contact so later turns spawn in the same
    // directory even if the project's registered paths change in between.
    await updateSession(projectDir, { id: writeTarget.normalizedId, metadata: { directory: dir } });
    writeTarget = { ...writeTarget, metadata: { ...writeTarget.metadata, directory: dir } };
  }
  return { writeTarget, dir };
}

/**
 * The turn's user-facing prompt: the message, then its rendered reference block.
 *
 * References ride the PROMPT, never a system tier. The system tier is the
 * STABLE one — byte-identical across turns is what makes the prompt cache pay —
 * while a reference belongs to the turn that sent it and to no other. Staging
 * them would break the cache on every send and leave the pointer in the
 * conversation long after the turn it was meant for.
 */
function turnPrompt(message: string, refs: SessionReference[] | undefined): string {
  const block = renderReferences(refs ?? []);
  return block === "" ? message : `${message}\n\n${block}`;
}

/**
 * Targeting tokens for one legacy claude-code spawn — everything before the
 * permission segment. Exactly two shapes:
 *  - fresh thread seed:  -p <prompt> --session-id <new> --output-format json
 *  - thread resume:      -p <prompt> --resume <own> --output-format json
 *
 * (`--resume <observed> --fork-session` — the adoption fork — is gone with the
 * observed sessions it forked.)
 */
function turnTargetingArgv(prompt: string, seeding: boolean, claudeSessionId: string): string[] {
  const argv = ["-p", prompt];
  argv.push(seeding ? "--session-id" : "--resume", claudeSessionId);
  argv.push("--output-format", "json");
  return argv;
}

/**
 * One turn of a headless conversation. Answers 202 with the run's id, the
 * stream to tail it on, and the record it writes to — the acceptance, not the
 * result: the run proceeds out-of-band in the runner, whose exit-time write-back
 * settles it.
 *
 * WHAT THE CALLER CHOOSES is an INTENT (`ask` | `change`), never a targeting
 * mode. Where the turn lands is derived from the record it is addressed to (see
 * `resolveTurnTarget`): an ARCS thread continues in place.
 *
 * RUNTIME SELECTION is the write target's own `runtimeType`, read through the
 * run-driver registry: a thread whose runtime has a registered adapter (the
 * default, opencode) is driven one-shot through that adapter — its argv, its
 * binary, its wire format; a thread without one (legacy claude-code) keeps the
 * claude path below.
 *
 * ARGV OWNERSHIP, which is the safety property on the claude path: every tool
 * and permission token comes from `buildPermissionArgv` and this route builds
 * none. It keeps only the targeting tokens above, and the permission segment is
 * appended LAST — `--tools` is variadic (it eats following tokens until the next
 * dash-leading one) and `--append-system-prompt` consumes exactly one following
 * token, so a segment placed before `-p` would swallow the prompt or the staged
 * text. The staged environment reaches the child through that segment's
 * `stagedSystemPrompt` slot and nowhere else; a second direct push would emit
 * the flag twice. A driver-driven run carries NO permission segment — those
 * flags are claude's vocabulary, and the adapter's argv is complete on its own.
 *
 * The user turn (and one reference turn per `refs` entry) is appended to the
 * write target's sidecar immediately, so the panel shows the prompt before the
 * run ends, with delivery-first ordering.
 *
 * Staged environment (W2): claude-code only. A spawn that STARTS a conversation
 * always carries it; a spawn that CONTINUES one carries it only on a restage.
 *
 * Concurrency: one live run per write-target. The runner's beginRun is the
 * atomic claim; the read-only isRunLive probe here answers the common
 * overlapping case with a proper 409 before anything is appended or spawned.
 */
sessionsRoute.post("/api/p/:slug/sessions/:id/turns", async (c) =>
  respond(
    c,
    async () => {
      const slug = c.req.param("slug");
      const projectDir = requireProjectDir(slug);
      // `guards` is validated by the schema and deliberately not read here —
      // the change-intent preflight that consumes it is a separate task.
      const { intent, message, refs, threadRef } = await parseBody(c, turnSchema);
      const session = await resolveTurnSession(projectDir, slug, c.req.param("id"));

      const target = await resolveTurnTarget(projectDir, slug, session, threadRef);
      const { writeTarget, dir } = target;

      // One live run per write-target — refuse before appending anything. The
      // CODE is historical (claude was the only drivable runtime when it was
      // minted); both runtimes share it so clients keep one overlap signal.
      if (isRunLive(writeTarget.normalizedId)) {
        throw new DagError(
          "CLAUDE_RUN_IN_PROGRESS",
          `a run for "${writeTarget.normalizedId}" is already in progress`,
        );
      }

      await appendSessionTurn(projectDir, writeTarget.normalizedId, {
        type: "user",
        text: message,
      });
      for (const reference of refs ?? []) {
        await appendReference(projectDir, writeTarget.normalizedId, reference);
      }

      // The run's own ceiling, resolved HERE so the deadline persisted with the
      // claim is the same number the runner arms its kill timer with (it
      // prefers this over its own env/default lookup).
      const runId = randomUUID();
      const timeoutMs = resolveTimeoutMs(undefined, process.env);

      // --- Per-runtime child shape -------------------------------------------
      //
      // A registered driver adapter owns everything runtime-specific about the
      // spawn: argv shape, binary, wire format. What stays here is the generic
      // lifecycle — deadline, claim, durable log, write-back — identical for
      // every runtime.
      const driver = getRunDriver(writeTarget.runtimeType);

      let argv: string[];
      let runnerOptions: ClaudeRunnerOptions | undefined;
      /** Sibling metadata persisted with the deadline below, per runtime. */
      let spawnMetadata: Record<string, unknown> = {};

      if (driver !== undefined) {
        // One-shot driver runtime (opencode): FRESH when no runtime session id
        // has been harvested yet, `-s` continuation once one has. No permission
        // segment and no staged tier — the adapter's argv is complete policy,
        // and the runner must not rewrite it onto its stream-json contract.
        const runtimeSessionId = writeTarget.runtimeSessionId.trim();
        argv = driver.buildArgv({
          message: turnPrompt(message, refs),
          title: metadataString(writeTarget.metadata?.title),
          ...(runtimeSessionId !== "" && { runtimeSessionId }),
        });
        runnerOptions = { binary: driver.binary };
      } else {
        // Legacy claude-code thread — seed-or-resume decision, targeting tokens,
        // staged environment, then the permission segment LAST.
        const meta = writeTarget.metadata;
        const persistedUuid = metadataString(meta?.claudeSessionId);
        // The SEED DECISION. `threadInitialized` means "ARCS has already handed
        // this uuid to --session-id" and is persisted at spawn, so a thread
        // whose first run timed out (or whose server died) resumes on the next
        // turn instead of re-seeding an id claude has already registered.
        const seeding = meta?.threadInitialized !== true || persistedUuid === undefined;
        const claudeSessionId = persistedUuid ?? randomUUID();

        // NOTE: no "--cwd" flag — claude >= 2.x rejects it ("error: unknown
        // option '--cwd'"), settling every headless run as outcome:error. The
        // spawn applies the working directory via options.cwd below instead.
        argv = turnTargetingArgv(turnPrompt(message, refs), seeding, claudeSessionId);

        // Keyed on the WRITE TARGET, never on anything else: the write target
        // is the record the run lands on and the record `metadata.stage` is
        // persisted to, so the fingerprint compared next turn describes the
        // same node the text was built from.
        const stageOpts = { workspaceRoot: dir };
        const refresh = await planStageRefresh(projectDir, slug, writeTarget, stageOpts);
        const staged =
          refresh.staged ??
          (seeding
            ? await buildStagedEnvironment(projectDir, slug, writeTarget, {
                ...stageOpts,
                // The same watermark planStageRefresh stamps with, so this record
                // stays mtime-comparable even though this path never persists it.
                now: refresh.probedAt,
              })
            : undefined);

        // LAST, and the only source of tool/permission tokens. The staged text
        // is handed over as this segment's value slot rather than pushed
        // directly — one flag, one emitter.
        argv.push(
          ...buildPermissionArgv({
            intent,
            ...(staged !== undefined && { stagedSystemPrompt: staged.text }),
          }),
        );

        spawnMetadata = {
          // Minted once here and persisted AT SPAWN, so a crash before the
          // settle still leaves the thread resuming the uuid it was seeded
          // with rather than re-seeding a second one.
          claudeSessionId,
          ...(seeding && { threadInitialized: true }),
          // Written EXACTLY when the refresh asks for it. On the cheap exit
          // nothing was rebuilt, so re-stamping the record would move the very
          // watermark the next turn's freshness decision is made against.
          ...(refresh.persist && refresh.stage ? { stage: refresh.stage } : {}),
        };
      }

      // Persisted next to the claim rather than inside metadata.run, which
      // `beginSessionRun` replaces wholesale: as sibling keys these cannot be
      // clobbered by the claim, nor the claim by them.
      await updateSession(projectDir, {
        id: writeTarget.normalizedId,
        metadata: {
          runDeadlineAt: Date.now() + timeoutMs,
          ...spawnMetadata,
        },
      });
      // Claim the record BEFORE the child exists: from here on, a server that
      // dies mid-run leaves a claim behind rather than an invisible orphan, and
      // the startup sweep (settleOrphanedRunsOnStartup) is what settles it.
      await beginSessionRun(projectDir, writeTarget.normalizedId, { runId });

      // Gate for the write-back: it must not settle (and release) the claim
      // while the pid write below is still in flight.
      let claimComplete: () => void = () => {};
      const claimed = new Promise<void>((resolveClaim) => {
        claimComplete = resolveClaim;
      });

      // Fire-and-forget: the run proceeds out-of-band. The runner invokes the
      // registered write-back after the child fully exits (it resolves on
      // `close`) on every outcome path; write-back failures are swallowed by
      // the runner, so a failed finalize never surfaces on the accepted 202.
      // The trailing catch is defensive — the runner never rejects.
      runClaudeJob(
        {
          argv,
          cwd: dir,
          timeoutMs,
          writeTargetKey: writeTarget.normalizedId,
          // A driver runtime owns its own wire format: its argv reaches the
          // child verbatim, never rewritten onto the claude output contract.
          ...(driver !== undefined && { streamJsonArgv: false }),
          // The SAME runId the claim above persisted as currentRunId — the log's
          // filename and the session record can never name different runs.
          eventLog: { projectDir, sessionId: writeTarget.normalizedId, runId },
          onSettled: (record) =>
            writeBackRun(projectDir, { intent, writeTarget, runId, claimed }, record),
        },
        runnerOptions,
      ).catch(() => {
        // Best-effort — the write-back lives inside the runner's onSettled.
      });

      // runClaudeJob spawns synchronously (nothing is awaited before its
      // beginRun), so the child's pid is readable right here — and the claim it
      // lands on is the one written above, never a later run's. `undefined`
      // means the spawn produced no live run at all and `null` means it
      // produced no pid; neither is something to persist, and the claim then
      // stands on its heartbeat/deadline alone.
      try {
        const pid = liveRunPid(writeTarget.normalizedId);
        if (typeof pid === "number") {
          await beginSessionRun(projectDir, writeTarget.normalizedId, { runId, pid });
        }
      } catch {
        // A claim ARCS could not complete is not a reason to fail an accepted
        // run — the record simply carries no pid for it.
      } finally {
        claimComplete();
      }

      return {
        runId,
        // Keyed on the WRITE TARGET's id, never on the path `:id`: when
        // `threadRef` mints a thread they can differ, and a stream URL built
        // from the path id answers 200 and then emits nothing —
        // indistinguishable from a child that never spoke.
        streamUrl: `/api/p/${slug}/sessions/${writeTarget.normalizedId}/runs/${runId}/stream`,
        writeTargetId: writeTarget.normalizedId,
      };
    },
    202,
  ),
);

sessionsRoute.delete("/api/p/:slug/sessions/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    // Resolve through the index first: the sidecar filename keys on the
    // session's canonical normalizedId, so a non-slugified route id must not
    // re-derive the filename (deleteSession alone would orphan the sidecar).
    const session = await getSession(projectDir, c.req.param("id"));
    await deleteSession(projectDir, session.normalizedId);
    try {
      await unlink(sessionTranscriptPath(projectDir, session.normalizedId));
    } catch {
      // Sidecar may not exist — a failed unlink is a swallowed no-op.
    }
    // Retention only ever prunes at a settle, and a deleted session never
    // settles again — its logs would otherwise sit in the sessions dir forever.
    await pruneRunEventLogs(projectDir, session.normalizedId, 0);
    return { deleted: true };
  }),
);

/**
 * Reads the session's transcript sidecar (mirrored Claude Code lines plus
 * ARCS-authored reference turns) into the read-model the web UI renders.
 * An absent sidecar answers an empty transcript with `mirroredAt: null`; once
 * the sidecar exists, `mirroredAt` is the file mtime so the UI can show how
 * fresh the mirror is.
 */
sessionsRoute.get("/api/p/:slug/sessions/:id/transcript", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    // The ask alias reads WITHOUT minting: an untouched Ask-AI thread is an
    // empty transcript, not a record created by a GET.
    let session: SessionMeta | undefined;
    if (c.req.param("id") === ASK_THREAD_ALIAS) {
      session = await readThreadRecord(projectDir, ASK_THREAD_NAME);
      if (session === undefined) return { turns: [], mirroredAt: null };
    } else {
      session = await getSession(projectDir, c.req.param("id"));
    }

    let mirroredAt: string | null = null;
    try {
      const info = await stat(sessionTranscriptPath(projectDir, session.normalizedId));
      if (info.isFile()) mirroredAt = info.mtime.toISOString();
    } catch {
      // No sidecar yet — empty transcript, nothing mirrored.
    }
    if (mirroredAt === null) return { turns: [], mirroredAt: null };
    return { turns: await readSessionTurns(projectDir, session.normalizedId), mirroredAt };
  }),
);

// ---------------------------------------------------------------------------
// Run event stream — a stateless tail of one run's event log
// ---------------------------------------------------------------------------

/**
 * How often an attached tail re-reads the log.
 *
 * Sized against the DAG stream's 250ms debounce (`watcher.ts`, feeding
 * `routes/events.ts`), which is exactly what makes that channel unusable for
 * tokens and why this is a second channel at all: a quarter second of
 * coalescing is invisible on a graph repaint and jarring on text arriving word
 * by word. This is a different channel with a different budget, so it polls
 * rather than debounces, and it polls an order faster.
 *
 * Polling rather than `fs.watch`: watch semantics vary by platform and
 * filesystem (and still need a poll fallback to be total), and a watcher is
 * per-connection state — the one thing this route may not hold.
 */
const RUN_TAIL_POLL_MS = 100;

/** The framing byte. A line is only a record once THIS terminates it. */
const RUN_LOG_NEWLINE = 0x0a;

/** What the tail can tell about a run without holding anything of its own. */
interface RunTailState {
  /** Nothing will ever be appended to this run's log again. */
  settled: boolean;
  /** `metadata.run.outcome`, when this run still owns the session's run record. */
  outcome?: string;
  /**
   * Whether the log is the WHOLE stream, when this run still owns the record.
   *
   * `undefined` means UNKNOWN, never "complete": a newer run has replaced
   * `metadata.run`, so this run's `eventLogTruncated` is no longer readable and
   * the tail must not manufacture a `false` for it.
   */
  truncated?: boolean;
}

/**
 * Whether the index, read DIRECTLY, answers that THIS SESSION is not in it —
 * the only thing that turns `getSession`'s not-found into "the session is gone".
 *
 * `ITEM_NOT_FOUND` is not by itself evidence of deletion: `readSessionIndex`
 * folds an unreadable index into an EMPTY one (`readJsonSafe` swallows every
 * error class), so an `EACCES`, an `EISDIR` or a malformed index on a live
 * session arrives wearing the deleted session's code.
 *
 * The question asked here is about the SESSION, never about the file. "The
 * index parses" is NOT the same answer: this is a second, later read, so a
 * failure that CLEARS between the two makes the file parse while the session is
 * still listed in it — settling a live run on nothing but a flicker. Only a
 * parse that completes AND does not list `sessionId` answers, plus `ENOENT`,
 * where the record the session would have to be in is not there at all.
 *
 * Deliberate trade: an index that is readable but MALFORMED (`sessions` present
 * and not an array), or that only the store's JSONC-tolerant reader accepts and
 * this plain parse does not, never answers at all — so a tail whose session
 * really was deleted keeps polling for the life of the connection rather than
 * ending. That is the intended direction — absent evidence must not look like
 * evidence of silence — and it is unbounded on purpose. The repair for a broken
 * index is to repair the index; do not "fix" this back into a settle.
 *
 * Re-deriving the index path here (rather than asking the store) is the whole
 * point: the store's own reader is the thing that cannot distinguish these.
 *
 * One agreement with that reader IS mirrored: a listed record whose
 * `runtimeType` is not a member of `SESSION_RUNTIME_TYPES` answers ABSENT.
 * `readSessionIndex` drops such records before any read sees them, so to the
 * store the session genuinely does not exist — counting it as "listed" here
 * would make every `getSession` not-found for it look like an index that
 * cannot answer, wedging the caller in retry until attrition happens to
 * compact the record away.
 */
async function sessionIndexAnswered(projectDir: string, sessionId: string): Promise<boolean> {
  try {
    const raw = await readFile(resolve(projectDir, "sessions", "index.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      sessions?: { normalizedId?: string; runtimeType?: string }[];
    };
    if (!Array.isArray(parsed.sessions)) return false;
    return !parsed.sessions.some(
      (s) =>
        s?.normalizedId === sessionId &&
        (SESSION_RUNTIME_TYPES as readonly string[]).includes(s.runtimeType ?? ""),
    );
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Whether the run is still live, read from the SESSION RECORD rather than from
 * the runner's in-memory `liveRuns` map.
 *
 * The claim is the only liveness signal that survives a restart, and it is what
 * keeps this route stateless: `isRunLive` would answer "no" for every run
 * inherited from a dead server process, closing a stream whose child is still
 * writing. The claim also settles exactly once, under the store lock, in the
 * same write that stamps the outcome — so "claim gone" and "outcome readable"
 * can never disagree.
 */
async function readRunTailState(
  projectDir: string,
  sessionId: string,
  runId: string,
): Promise<RunTailState> {
  let session: SessionMeta;
  try {
    session = await getSession(projectDir, sessionId);
  } catch (err) {
    // Two reads, and only their AGREEMENT settles: `getSession` raised
    // not-found AND a direct read of the index answers that this session is not
    // in it (or that there is no index at all). Everything else — another error
    // class, or an index that cannot answer for this session — keeps the tail
    // polling, because absent evidence must not look like evidence of silence:
    // the `end` frame a transient read failure would emit here is byte-identical
    // to the legitimate superseded-run one, the client contract below is to
    // `close()` on `end`, and so a live run's remaining lines would never reach
    // that consumer at all. Staying open costs one more poll and nothing else.
    if (!(err instanceof DagError) || err.code !== "ITEM_NOT_FOUND") return { settled: false };
    return { settled: await sessionIndexAnswered(projectDir, sessionId) };
  }
  if (sessionRunClaim(session) === runId) return { settled: false };

  const run = runMetadata(session);
  // A newer run owns the record: this one is over (its claim is gone), but its
  // outcome and completeness are no longer on disk to report.
  if (run.runId !== runId) return { settled: true };
  return {
    settled: true,
    ...(typeof run.outcome === "string" && { outcome: run.outcome }),
    // Only ever written as `true` (claude-runner omits it otherwise), so its
    // absence on THIS run's own record means the log is whole.
    truncated: run.eventLogTruncated === true,
  };
}

/** Complete lines read out of the log, and how many bytes they consumed. */
interface RunTailRead {
  lines: string[];
  /** Bytes consumed — always lands just past a newline, or 0. */
  bytes: number;
}

const EMPTY_TAIL_READ: RunTailRead = { lines: [], bytes: 0 };

/**
 * Every COMPLETE line the log holds at or after `byteOffset`.
 *
 * The trailing-partial rule is the whole point of this function. While a run is
 * live the file's last bytes may be a record the child is still writing, and the
 * log also leaves an orphaned fragment behind wherever it lost bytes and refused
 * to extend the open line. Both look identical from here — unterminated bytes at
 * EOF — so neither is ever emitted: consumption stops AT the last newline and
 * `bytes` reports only that much, leaving the fragment to be re-read by the next
 * poll once (and if) it completes. Emitting it would fabricate a record the child
 * never wrote, and a fabricated record is undetectable downstream.
 *
 * Decoding only the consumed region is also what keeps multi-byte UTF-8 intact:
 * `0x0a` cannot appear inside a multi-byte sequence, so a cut at a newline is
 * always a character boundary however the child chunked its writes.
 *
 * Total, like everything else that touches this log: a file that is not there
 * yet (the claim is written BEFORE the child spawns), was pruned, or cannot be
 * read reads as nothing new.
 */
async function readRunLogLines(path: string, byteOffset: number): Promise<RunTailRead> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return EMPTY_TAIL_READ;
  }
  try {
    const { size } = await handle.stat();
    // Bounded by the same ceiling `foldRunEventLog` reads against — the same
    // ceiling, NOT the same handling: the fold refuses an oversized file whole
    // where this clamps to the ceiling and tails what fits. The writer cannot
    // produce such a file (`push` refuses the crossing chunk and reserves the
    // byte `terminate` may add), so the two never disagree on a log this server
    // wrote. The clamp stands for what that leaves: bytes past a ceiling the log
    // never wrote are not tailed as if the log had written them, and this
    // allocation can never exceed the log's own maximum size.
    const end = Math.min(size, RUN_EVENT_LOG_MAX_BYTES);
    // Nothing new. `<` rather than `===` covers the file shrinking under us,
    // which an append-only log cannot do — but reading a negative length could.
    if (end <= byteOffset) return EMPTY_TAIL_READ;

    const buffer = Buffer.allocUnsafe(end - byteOffset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, byteOffset);
    const chunk = buffer.subarray(0, bytesRead);

    const lines: string[] = [];
    let consumed = 0;
    for (;;) {
      const at = chunk.indexOf(RUN_LOG_NEWLINE, consumed);
      if (at === -1) break;
      // Verbatim, terminator excluded: the log is the source of truth and this
      // is a view of it, so nothing here trims, parses or repairs a line.
      lines.push(chunk.toString("utf-8", consumed, at));
      consumed = at + 1;
    }
    return { lines, bytes: consumed };
  } catch {
    return EMPTY_TAIL_READ;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Digits and nothing else — no sign, no exponent, no whitespace, no separators.
 *
 * Leading zeros ARE accepted (`?from=007` is offset 7), because they are the one
 * decoration that cannot change the value in base 10: every shape refused above
 * either names a different number than it reads as, or names none at all.
 */
const RUN_TAIL_OFFSET_PATTERN = /^\d+$/;

/**
 * Where the tail starts, as an ABSOLUTE line offset into the log.
 *
 * The same contract `mirrorOffset` implements for transcript mirroring
 * (`src/utils/claude-transcript.ts`): the value is the index of the next line
 * the client has NOT seen — last seen offset + 1 — so a reconnect at it can
 * neither duplicate nor skip. The log is append-only, so a line's index is fixed
 * forever and the offset means the same thing to every connection.
 *
 * Two sources, and the LARGER wins. `from` is what an explicit reconnect passes;
 * `Last-Event-ID` is what a browser `EventSource` replays automatically on its
 * own reconnect, where the URL (and therefore `from`) is frozen at whatever the
 * first connect used. Both are lower bounds on "lines I already hold", so their
 * max is the only value that satisfies both — honouring `from` alone would make
 * every automatic reconnect re-deliver the whole run.
 *
 * The consequence, which is what a client author actually needs: a request that
 * carries `Last-Event-ID` CANNOT REWIND below it, whatever `?from=` says. That
 * is the right trade rather than a limitation to work around — a browser only
 * replays the header on an automatic reconnect of the same `EventSource`, so a
 * deliberate rewind is a fresh `EventSource` (or a plain GET), neither of which
 * sends the header at all.
 *
 * Garbage is REFUSED rather than clamped: the only clamp available is 0, which
 * silently replays the entire log — precisely the duplicate storm the offset
 * exists to prevent. Refusal is DIGITS ONLY plus a `MAX_SAFE_INTEGER` bound,
 * because `Number()` + `Number.isInteger` is not refusal: it admits `1e3`,
 * `0x2`, whitespace-padded values and results past `MAX_SAFE_INTEGER`. Every
 * one of those is fail-safe in direction — they only move the tail forward —
 * but none of them is the "non-negative integer" this documents, and `1e21`
 * buys an end-frame-only stream indistinguishable from a run that said nothing.
 * A doc stricter than its code is a defect on its own.
 */
function parseRunTailOffset(from: string | undefined, lastEventId: string | undefined): number {
  const parse = (raw: string | undefined, label: string): number => {
    if (raw === undefined || raw === "") return 0;
    if (!RUN_TAIL_OFFSET_PATTERN.test(raw) || Number(raw) > Number.MAX_SAFE_INTEGER) {
      throw new DagError(
        "INVALID_RUN_STREAM_OFFSET",
        `${label} must be a non-negative integer line offset no greater than ` +
          `${Number.MAX_SAFE_INTEGER}, got "${raw}"`,
      );
    }
    return Number(raw);
  };
  return Math.max(parse(from, "from"), parse(lastEventId, "Last-Event-ID"));
}

/**
 * Answers a pre-stream resolution failure as JSON rather than as a stream.
 *
 * `respond` cannot be reused: it wraps the SUCCESS path in the envelope too, and
 * this route's success is an event stream with no envelope at all. The refusals
 * still speak the shared envelope, because a client that asked for a pruned run
 * needs a 404 it can read off `res.status` — not a 200 stream that says nothing
 * and closes, which is what a run whose child was silent looks like.
 */
function runStreamFailure(c: Context, err: unknown): Response {
  if (err instanceof DagError) {
    return c.json(fail(err.code, err.message), err.code.includes("NOT_FOUND") ? 404 : 400);
  }
  console.error("[arcs-web] run stream preflight failed", err);
  return c.json(fail("internal_error", "Unexpected server error"), 500);
}

/**
 * Tails one run's durable event log as SSE, live or after the fact.
 *
 * The log is the source of truth and this is a VIEW of it — a stateless tail,
 * not a subscription. Every frame is derived from `?from=` plus the file, the
 * only state is two numbers on this request's own stack, and nothing keyed on a
 * run or a connection exists anywhere in this module. That is what makes a
 * server restart cost exactly one client reconnect: the new process can answer
 * the same GET with the same bytes, because it never knew anything the file did
 * not already say.
 *
 * Frames, all of them carrying an absolute line offset:
 *  - `line`  `{ offset, line }` — the log's line at `offset`, verbatim.
 *  - `end`   `{ offset, outcome?, truncated? }` — the run has settled and the
 *            log is drained; `offset` is the log's total complete-line count,
 *            i.e. the `from` that would now return nothing.
 *
 * The SSE `id` field is the RESUME cursor rather than the frame's own index
 * (`offset + 1` on a line, `offset` on the end frame), which is what makes an
 * `EventSource` auto-reconnect land exactly where it left off with no client
 * arithmetic. Note that an `EventSource` reconnects on ANY stream end, `end`
 * frame included — the client is expected to `close()` on `end`; the reconnect
 * is harmless (it replays nothing and closes again) but it is the client's job
 * to stop it. The header it replays merges as `max(from, Last-Event-ID)`, so a
 * request carrying it CANNOT REWIND below it — a deliberate rewind is a fresh
 * `EventSource` (or a plain GET), which sends no header at all.
 *
 * Ordering that carries the whole live/settled distinction: the settle is
 * observed BEFORE the read, never after. A run settled at that instant appends
 * nothing later, so the read that follows is guaranteed to see the log whole —
 * the other order loses every line written between the read and the check. A GET
 * issued after settle therefore takes exactly one pass: replay from `from`, one
 * `end` frame, close.
 *
 * `truncated` on the `end` frame is how a consumer tells "I reached the end of
 * the stream" from "I reached a hole the log refused to fill" — a capped log
 * ends on a line boundary and is indistinguishable from a complete one by
 * reading it. It is only readable at settle: while the run is live the flag
 * lives in the writer's memory and reaches disk (as
 * `metadata.run.eventLogTruncated`) only when the write-back stamps the outcome,
 * so a live tail cannot report it and does not pretend to.
 *
 * A read route by construction — it opens nothing, spawns nothing and writes
 * nothing — so it sits behind the loopback check alone, exactly like every other
 * GET here, and the `X-ARCS-Token` mutation gate passes it through on method.
 */
sessionsRoute.get("/api/p/:slug/sessions/:id/runs/:runId/stream", async (c) => {
  const runId = c.req.param("runId");
  let projectDir: string;
  let sessionId: string;
  let logPath: string;
  let fromOffset: number;
  try {
    projectDir = requireProjectDir(c.req.param("slug"));
    const session = await getSession(projectDir, c.req.param("id"));
    sessionId = session.normalizedId;
    fromOffset = parseRunTailOffset(c.req.query("from"), c.req.header("last-event-id"));
    // Keyed on the canonical id, exactly as the writer keys it; the run id
    // reaches a filename through `runEventLogSegment`, which sanitizes it, so a
    // traversal-shaped runId cannot address anything outside the sessions dir.
    logPath = runEventLogPath(projectDir, sessionId, runId);

    let logged = false;
    try {
      logged = (await stat(logPath)).isFile();
    } catch {
      // Not written yet — the claim lands BEFORE the child spawns, so a tail
      // that connects on the 202 legitimately arrives ahead of the file.
    }
    // Neither a log nor a claim: the run never existed under this id, or
    // retention has already pruned it. Refused rather than answered with an
    // empty stream, for the same reason `eventLogTruncated` exists — absent
    // evidence must never look like evidence of silence.
    if (!logged && sessionRunClaim(session) !== runId) {
      throw new DagError(
        "RUN_EVENT_LOG_NOT_FOUND",
        `no event log for run "${runId}" on session "${sessionId}" — it is not the ` +
          `session's live run and its log is not on disk (pruned, or never written)`,
      );
    }
  } catch (err) {
    return runStreamFailure(c, err);
  }

  return streamSSE(c, async (stream) => {
    /** Absolute index of the next line at `byteOffset`. */
    let lineOffset = 0;
    /** Bytes of the log already framed into lines — never inside a record. */
    let byteOffset = 0;

    while (!stream.aborted) {
      const state = await readRunTailState(projectDir, sessionId, runId);
      const { lines, bytes } = await readRunLogLines(logPath, byteOffset);
      byteOffset += bytes;

      for (const line of lines) {
        const offset = lineOffset;
        lineOffset += 1;
        // Counted but not sent: the client already holds it. Counting is what
        // keeps offsets ABSOLUTE — a skipped line still occupies its index.
        if (offset < fromOffset) continue;
        await stream.writeSSE({
          event: "line",
          id: String(offset + 1),
          data: JSON.stringify({ offset, line }),
        });
      }

      if (state.settled) {
        await stream.writeSSE({
          event: "end",
          id: String(lineOffset),
          data: JSON.stringify({
            offset: lineOffset,
            ...(state.outcome !== undefined && { outcome: state.outcome }),
            ...(state.truncated !== undefined && { truncated: state.truncated }),
          }),
        });
        return;
      }

      await stream.sleep(RUN_TAIL_POLL_MS);
    }
  });
});
