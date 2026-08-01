/**
 * opencode session discovery bridge (Phase 1 — observability only).
 *
 * ARCS never spawns or manages an opencode server; it attaches to an already
 * running `opencode serve` instance as a thin client, subscribes to the
 * cross-instance `/global/event` SSE stream, and mirrors what it sees into the
 * per-project session store. Everything here is best-effort: if opencode is
 * not configured, not running, or speaks a different dialect, the ARCS web
 * server keeps working and the sessions list is simply empty or stale.
 *
 * Verified against opencode 0.0.0-main-202607110203:
 * - `opencode serve` defaults to port 0 (ephemeral), so a port/URL must be
 *   supplied explicitly via env — there is no safe default to guess.
 * - `OPENCODE_SERVER_PASSWORD` is enforced as HTTP Basic auth with the literal
 *   username "opencode"; any other username is rejected with 401.
 * - `/event` is scoped to one instance (`?directory=`); `/global/event` is the
 *   cross-directory stream and wraps each event as `{ directory, project,
 *   payload }`. Frames carry no `event:` field, only `data:`.
 */

import { resolve } from "node:path";
import { readRootMeta } from "../utils/dag.js";
import { DagError } from "../utils/errors.js";
import { readJsonSafe } from "../utils/json.js";
import { getDataDir, getProjectDir } from "../utils/paths.js";
import {
  listSessions,
  type SessionStatus,
  updateSession,
  upsertSession,
} from "../utils/session-store.js";
import { findBestMatch, type WorkspaceProject } from "../utils/workspace-match.js";

const DEFAULT_HOSTNAME = "127.0.0.1";
const BASIC_AUTH_USER = "opencode";
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const SEND_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OpencodeConfig {
  baseUrl: string;
  password?: string;
}

/**
 * Reads bridge configuration from the environment. Returns null (discovery
 * disabled) when no opencode endpoint is configured.
 */
export function readOpencodeConfig(env: NodeJS.ProcessEnv = process.env): OpencodeConfig | null {
  const password = env.OPENCODE_SERVER_PASSWORD?.trim() || undefined;
  const explicitUrl = env.ARCS_OPENCODE_URL?.trim() || env.OPENCODE_URL?.trim();
  if (explicitUrl) {
    return { baseUrl: explicitUrl.replace(/\/+$/, ""), ...(password && { password }) };
  }

  const rawPort = env.OPENCODE_PORT?.trim();
  if (!rawPort) return null;
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  const hostname = env.OPENCODE_HOSTNAME?.trim() || DEFAULT_HOSTNAME;
  return { baseUrl: `http://${hostname}:${port}`, ...(password && { password }) };
}

function requestHeaders(config: OpencodeConfig): Record<string, string> {
  if (!config.password) return {};
  const token = Buffer.from(`${BASIC_AUTH_USER}:${config.password}`).toString("base64");
  return { authorization: `Basic ${token}` };
}

// ---------------------------------------------------------------------------
// Message injection
// ---------------------------------------------------------------------------

export interface OpencodeMessageTarget {
  /** opencode-native session id ("ses_…") — never the ARCS normalized id. */
  runtimeSessionId: string;
  /** Worktree the session belongs to, when known — scopes opencode's lookup. */
  directory?: string;
}

/**
 * Injects a user message into a live opencode session.
 *
 * Unlike the rest of this module (best-effort observability) this is a user
 * mutation, so failures throw a typed DagError the web routes can surface.
 *
 * Verified against opencode 1.0.0 (`GET /doc`) plus a live server:
 * - `POST /session/:sessionID/prompt_async` acks with 204 and runs the turn in
 *   the background. `POST /session/:sessionID/message` takes the same body but
 *   only responds once the assistant has finished its whole turn — minutes, for
 *   a browser request — so async delivery is the one that fits a web form.
 * - the body requires `parts`; a text part is `{ type: "text", text }`.
 * - `?directory=` is optional (an unscoped send still lands) but is passed when
 *   known so the lookup is unambiguous across worktrees.
 */
export async function sendOpencodeMessage(
  config: OpencodeConfig,
  target: OpencodeMessageTarget,
  text: string,
): Promise<void> {
  // SHORTCUT: prompt_async only — upgrade to a `/session/:id/message` fallback
  // when an opencode build that predates prompt_async has to be supported.
  const query = target.directory ? `?directory=${encodeURIComponent(target.directory)}` : "";
  const url = `${config.baseUrl}/session/${encodeURIComponent(target.runtimeSessionId)}/prompt_async${query}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...requestHeaders(config) },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DagError(
      "OPENCODE_UNREACHABLE",
      `Could not reach opencode at ${config.baseUrl}: ${String(err)}`,
    );
  }

  if (res.status === 404) {
    throw new DagError(
      "OPENCODE_SESSION_NOT_FOUND",
      `opencode does not know session "${target.runtimeSessionId}" — it may have ended.`,
    );
  }
  if (!res.ok) {
    throw new DagError(
      "OPENCODE_REQUEST_FAILED",
      `opencode rejected the message (${res.status})${await errorDetail(res)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

export interface CreateOpencodeSessionInput {
  /** Worktree the session runs in — required, see the directory note below. */
  directory: string;
  title?: string;
}

/** Only what ARCS needs to mirror the session; the SSE stream fills in the rest. */
export interface CreatedOpencodeSession {
  runtimeSessionId: string;
  title?: string;
}

/**
 * Creates a live opencode session bound to a worktree.
 *
 * Verified against opencode 0.0.0-main-202607110203 (`GET /doc`, operationId
 * `session.create`) plus a live server:
 * - the route is `POST /session` — NOT `/api/session`. opencode serves its own
 *   web UI from the same port and answers every unknown path with a 200
 *   text/html SPA shell, so a wrong path looks like a success until the body is
 *   read. That is why the id is checked below rather than trusting `res.ok`.
 * - `directory` is a *query* parameter and never a body field. Omitting it does
 *   not fail; opencode silently creates the session in its own working
 *   directory, so the caller must always pass the worktree explicitly.
 * - `title` is the only body field ARCS sets; the response is a full session
 *   object (`{ id, slug, directory, title, time }`).
 * - `DELETE /session/:sessionID` exists, so nothing created here is permanent.
 */
export async function createOpencodeSession(
  config: OpencodeConfig,
  input: CreateOpencodeSessionInput,
): Promise<CreatedOpencodeSession> {
  const url = `${config.baseUrl}/session?directory=${encodeURIComponent(input.directory)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...requestHeaders(config) },
      body: JSON.stringify(input.title ? { title: input.title } : {}),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DagError(
      "OPENCODE_UNREACHABLE",
      `Could not reach opencode at ${config.baseUrl}: ${String(err)}`,
    );
  }

  if (!res.ok) {
    throw new DagError(
      "OPENCODE_REQUEST_FAILED",
      `opencode refused to create a session (${res.status})${await errorDetail(res)}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const info = body as OpencodeSessionInfo | null;
  if (!info?.id) {
    throw new DagError(
      "OPENCODE_REQUEST_FAILED",
      `opencode answered ${config.baseUrl}/session with something other than a session — ` +
        "the create-session endpoint may have moved in this opencode build.",
    );
  }

  return { runtimeSessionId: info.id, ...(info.title && { title: info.title }) };
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.text()).trim();
    return body ? `: ${body.slice(0, 200)}` : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// opencode wire shapes (only the fields the bridge reads)
// ---------------------------------------------------------------------------

interface OpencodeSessionInfo {
  id?: string;
  slug?: string;
  title?: string;
  directory?: string;
  projectID?: string;
  time?: { created?: number; updated?: number };
  project?: { worktree?: string };
}

interface OpencodeEvent {
  type?: string;
  properties?: {
    sessionID?: string;
    info?: OpencodeSessionInfo;
    status?: { type?: string };
  };
}

interface GlobalEventEnvelope {
  directory?: string;
  project?: string;
  payload?: OpencodeEvent;
}

/**
 * Maps an opencode event type to the ARCS session status it implies.
 * Returns null for events that carry no status transition (the record is
 * refreshed but its status is left alone).
 */
export function statusForOpencodeEvent(event: OpencodeEvent): SessionStatus | null {
  switch (event.type) {
    case "session.created":
      return "active";
    case "session.idle":
      return "idle";
    case "session.error":
      return "failed";
    case "session.deleted":
      return "disconnected";
    case "session.status":
      switch (event.properties?.status?.type) {
        case "idle":
          return "idle";
        case "busy":
        case "retry":
          return "active";
        default:
          return null;
      }
    default:
      return null;
  }
}

function isoFromEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value).toISOString();
}

// ---------------------------------------------------------------------------
// Project resolution
// ---------------------------------------------------------------------------

async function loadWorkspaceProjects(): Promise<WorkspaceProject[]> {
  const dataDir = getDataDir();
  const projects: WorkspaceProject[] = [];
  try {
    const rootMeta = await readRootMeta(dataDir);
    for (const node of rootMeta.projects) {
      const meta = await readJsonSafe<{ workspacePaths?: string[] }>(
        resolve(dataDir, "projects", node.id, "meta.json"),
      );
      const paths = Array.isArray(meta?.workspacePaths) ? meta.workspacePaths : [];
      if (paths.length > 0) projects.push({ slug: node.id, workspacePaths: paths });
    }
  } catch {
    // Unreadable DAG root — treat as "no projects" and retry on the next event.
  }
  return projects;
}

// SHORTCUT: directory→slug resolution re-reads the DAG on every cache miss and
// caches positive hits for the lifetime of the connection; upgrade to a
// watcher-invalidated cache when workspace paths start changing mid-session.
const directorySlugCache = new Map<string, string | null>();

async function resolveSlugForDirectory(directory: string | undefined): Promise<string | null> {
  if (!directory) return null;
  const cached = directorySlugCache.get(directory);
  if (cached !== undefined) return cached;

  const match = findBestMatch(directory, await loadWorkspaceProjects());
  const slug = match.kind === "match" ? match.slug : null;
  directorySlugCache.set(directory, slug);
  return slug;
}

// ---------------------------------------------------------------------------
// Bridge state
// ---------------------------------------------------------------------------

/** sessionID -> project slug, so id-only events (idle, error) can be routed. */
const sessionSlugs = new Map<string, string>();

let running = false;
let connected = false;
let controller: AbortController | null = null;
let activeConfig: OpencodeConfig | null = null;
let loop: Promise<void> | null = null;
let warnedUnreachable = false;

export interface OpencodeDiscoveryState {
  enabled: boolean;
  connected: boolean;
  baseUrl: string | null;
}

export function opencodeDiscoveryState(): OpencodeDiscoveryState {
  return { enabled: running, connected, baseUrl: activeConfig?.baseUrl ?? null };
}

// ---------------------------------------------------------------------------
// Session mirroring
// ---------------------------------------------------------------------------

async function recordSession(
  slug: string,
  info: OpencodeSessionInfo,
  status: SessionStatus | null,
): Promise<void> {
  const runtimeSessionId = info.id;
  if (!runtimeSessionId) return;

  const metadata: Record<string, unknown> = {};
  if (info.title) metadata.title = info.title;
  if (info.slug) metadata.sessionSlug = info.slug;
  if (info.directory) metadata.directory = info.directory;
  if (info.projectID) metadata.opencodeProjectId = info.projectID;

  await upsertSession(getProjectDir(slug), {
    runtimeType: "opencode",
    runtimeSessionId,
    ...(status && { status }),
    ...(isoFromEpochMs(info.time?.created) && {
      startedAt: isoFromEpochMs(info.time?.created),
    }),
    ...(isoFromEpochMs(info.time?.updated) && {
      lastMessageAt: isoFromEpochMs(info.time?.updated),
    }),
    ...(Object.keys(metadata).length > 0 && { metadata }),
  });
  sessionSlugs.set(runtimeSessionId, slug);
}

async function applyStatus(sessionId: string, status: SessionStatus): Promise<void> {
  const slug = sessionSlugs.get(sessionId);
  if (!slug) return;
  await updateSession(getProjectDir(slug), { id: sessionId, status });
}

async function handleEnvelope(envelope: GlobalEventEnvelope): Promise<void> {
  const event = envelope.payload;
  if (!event?.type) return;

  if (event.type === "server.instance.disposed" || event.type === "global.disposed") {
    await markAllDisconnected();
    return;
  }
  if (!event.type.startsWith("session.")) return;

  const info = event.properties?.info;
  const status = statusForOpencodeEvent(event);

  if (info?.id) {
    const directory = info.directory ?? info.project?.worktree ?? envelope.directory;
    const slug = await resolveSlugForDirectory(directory);
    if (!slug) return;
    await recordSession(slug, info, status);
    return;
  }

  const sessionId = event.properties?.sessionID;
  if (sessionId && status) await applyStatus(sessionId, status);
}

/** Marks every opencode session ARCS currently tracks as disconnected. */
async function markAllDisconnected(): Promise<void> {
  const entries = [...sessionSlugs.entries()];
  sessionSlugs.clear();
  for (const [sessionId, slug] of entries) {
    try {
      await updateSession(getProjectDir(slug), { id: sessionId, status: "disconnected" });
    } catch {
      // Record already gone — nothing to reconcile.
    }
  }
}

// ---------------------------------------------------------------------------
// Backfill + reconcile
// ---------------------------------------------------------------------------

/**
 * On every (re)connect, take a full snapshot of opencode's sessions and make
 * the ARCS index match it: known sessions are upserted as "idle" (live, no
 * activity observed yet) and sessions opencode no longer knows about are
 * marked "disconnected". Live events correct the status within seconds.
 */
async function backfill(config: OpencodeConfig): Promise<void> {
  let sessions: OpencodeSessionInfo[] = [];
  try {
    const res = await fetch(`${config.baseUrl}/experimental/session`, {
      headers: requestHeaders(config),
      signal: controller?.signal,
    });
    if (!res.ok) return;
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return;
    sessions = body as OpencodeSessionInfo[];
  } catch {
    // Endpoint missing or unreachable — live events alone still populate.
    return;
  }

  const seen = new Set<string>();
  for (const info of sessions) {
    const slug = await resolveSlugForDirectory(info.directory ?? info.project?.worktree);
    if (!slug || !info.id) continue;
    try {
      await recordSession(slug, info, "idle");
      seen.add(info.id);
    } catch {
      // A single malformed session must not abort the whole snapshot.
    }
  }

  await reconcileMissing(seen);
}

async function reconcileMissing(seen: Set<string>): Promise<void> {
  const dataDir = getDataDir();
  let slugs: string[] = [];
  try {
    slugs = (await readRootMeta(dataDir)).projects.map((p) => p.id);
  } catch {
    return;
  }

  for (const slug of slugs) {
    const projectDir = getProjectDir(slug);
    let stale: string[] = [];
    try {
      stale = (await listSessions(projectDir, { runtimeType: "opencode" }))
        .filter((s) => s.status !== "disconnected" && !seen.has(s.runtimeSessionId))
        .map((s) => s.normalizedId);
    } catch {
      continue;
    }
    for (const id of stale) {
      try {
        await updateSession(projectDir, { id, status: "disconnected" });
      } catch {
        // Concurrently removed — nothing to do.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SSE stream
// ---------------------------------------------------------------------------

/** Consumes one `/global/event` stream until it ends or is aborted. */
async function consumeStream(config: OpencodeConfig): Promise<void> {
  const res = await fetch(`${config.baseUrl}/global/event`, {
    headers: { accept: "text/event-stream", ...requestHeaders(config) },
    signal: controller?.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`opencode /global/event responded ${res.status}`);
  }

  connected = true;
  warnedUnreachable = false;
  await backfill(config);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streaming = true;

  while (streaming) {
    const { done, value } = await reader.read();
    if (done) {
      streaming = false;
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      await handleFrame(frame);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

async function handleFrame(frame: string): Promise<void> {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return;

  let envelope: GlobalEventEnvelope;
  try {
    envelope = JSON.parse(data) as GlobalEventEnvelope;
  } catch {
    return;
  }

  try {
    await handleEnvelope(envelope);
  } catch (err) {
    console.warn("[arcs-web] opencode session sync failed", err);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runDiscovery(config: OpencodeConfig): Promise<void> {
  let delay = RECONNECT_MIN_MS;

  while (running) {
    try {
      await consumeStream(config);
      delay = RECONNECT_MIN_MS;
    } catch (err) {
      if (!running || (err instanceof Error && err.name === "AbortError")) break;
      if (!warnedUnreachable) {
        warnedUnreachable = true;
        console.warn(
          `[arcs-web] opencode session discovery could not reach ${config.baseUrl} — ` +
            `sessions will not update until it is available (${String(err)})`,
        );
      }
      delay = Math.min(RECONNECT_MAX_MS, delay * 2);
    }

    connected = false;
    directorySlugCache.clear();
    if (!running) break;
    await markAllDisconnected();
    if (!running || !controller) break;
    await sleep(delay, controller.signal);
  }

  connected = false;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Starts the discovery loop if an opencode endpoint is configured. Idempotent;
 * returns false when discovery is disabled (no configuration present).
 */
export function startOpencodeDiscovery(config = readOpencodeConfig()): boolean {
  if (running) return true;
  if (!config) return false;

  running = true;
  activeConfig = config;
  controller = new AbortController();
  loop = runDiscovery(config).catch((err) => {
    console.warn("[arcs-web] opencode session discovery stopped unexpectedly", err);
  });
  return true;
}

/** Stops the discovery loop (test cleanup / server shutdown). */
export async function stopOpencodeDiscovery(): Promise<void> {
  if (!running) return;
  running = false;
  controller?.abort();
  const pending = loop;
  controller = null;
  activeConfig = null;
  loop = null;
  connected = false;
  warnedUnreachable = false;
  sessionSlugs.clear();
  directorySlugCache.clear();
  await pending?.catch(() => {});
}
