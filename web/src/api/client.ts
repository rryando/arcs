/**
 * Typed API client for the ARCS web server.
 * Envelope: { ok: true, data } | { ok: false, code, message }.
 */

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = (await res.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; code: string; message: string }
    | null;
  if (!body || body.ok !== true) {
    const errBody = body as { code?: string; message?: string } | null;
    throw new ApiError(
      errBody?.code ?? "http_error",
      errBody?.message ?? `HTTP ${res.status}`,
      res.status,
    );
  }
  return body.data;
}

// ---------------------------------------------------------------------------
// DTO types (mirror the server)
// ---------------------------------------------------------------------------

export interface ProjectCounts {
  knowledge: number;
  tasks: number;
  plans: number;
  proposals: number;
}

export interface ProjectSummary {
  slug: string;
  name: string;
  description: string;
  status: string;
  repoUrl?: string | null;
  dependsOn: string[];
  workspacePaths: string[];
  createdAt: string | null;
  lastSyncedAt: string | null;
  counts: ProjectCounts;
}

export interface FileRef {
  path: string;
  anchor?: string;
}

export interface KnowledgeMeta {
  id: string;
  normalizedId: string;
  title: string;
  kind: string;
  audience?: string;
  keywords: string[];
  summary: string;
  sourceFiles?: FileRef[];
  file: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMeta {
  id: string;
  normalizedId: string;
  title: string;
  status: string;
  priority: string;
  planId?: string;
  dependsOn?: string[];
  sourceFiles?: FileRef[];
  scope?: string;
  acceptance?: string;
  verify?: string;
  skill?: string;
  workMode?: "bounded" | "inspect";
  createdAt: string;
  updatedAt: string;
}

export type SessionStatus = "active" | "idle" | "completed" | "failed" | "disconnected";
export type SessionRuntimeType = "opencode" | "claude-code";
export type SessionLinkedNodeType = "task" | "plan";

/** Write-back of a headless `claude -p` run, persisted on `metadata.run` when
 *  the child exits — on every outcome path, so a failed run is readable. */
export interface SessionRunMeta {
  mode: string;
  /** Absent only on a record written before the write-back existed. */
  outcome?: "success" | "error" | "timeout";
  /** Failure detail — present on error/timeout outcomes. */
  error?: string;
  /** Epoch milliseconds (the runner writes `Date.now()`), never an ISO string. */
  startedAt?: number;
  endedAt?: number;
  replyChars?: number;
}

/** Session metadata, persisted verbatim by the bridge. Only the keys the UI
 *  reads are named; the index signature keeps everything else addressable. */
export interface SessionMetadata {
  /** Runtime-reported session title, when the runtime reports one. */
  title?: string;
  /** Workspace directory the session runs in. */
  directory?: string;
  /** `"arcs-owned"` marks a headless record ARCS minted itself — no terminal
   *  session is attached to it, so nothing ever drains its message queue. */
  control?: string;
  run?: SessionRunMeta;
  [key: string]: unknown;
}

export interface SessionMeta {
  id: string;
  normalizedId: string;
  runtimeType: SessionRuntimeType;
  runtimeSessionId: string;
  status: SessionStatus;
  startedAt: string;
  lastMessageAt?: string;
  updatedAt: string;
  userEmail?: string;
  /** Always set together with `linkedNodeId` — a half-set link never persists. */
  linkedNodeType?: SessionLinkedNodeType;
  /** Normalized task/plan id — never a diagram node id (T001…). */
  linkedNodeId?: string;
  /** Messages awaiting the session's next checkpoint; the key is absent (never
   *  an empty array) once the session drains it. */
  messageQueue?: string[];
  metadata?: SessionMetadata;
}

export interface SessionUpdateInput {
  status?: SessionStatus;
  lastMessageAt?: string | null;
  userEmail?: string | null;
  metadata?: Record<string, unknown> | null;
  /** `null` on either linkage field unlinks the session entirely. */
  linkedNodeType?: SessionLinkedNodeType | null;
  linkedNodeId?: string | null;
}

/** The MarkdownSection payload a caller sent to a session, preserved verbatim
 *  on the sidecar reference record so the UI can render the section with
 *  click-through back to its source document. Mirrors the server's
 *  ReferenceSection. */
export interface SessionTurnSection {
  /** Heading depth of the referenced section (1-based). */
  depth: number;
  /** The section's rendered markdown, exactly as it was sent to the session. */
  text: string;
  /** Stable id of the section within its document. */
  id: string;
  /** Character offsets of the section within the full document text. */
  startOffset: number;
  endOffset: number;
}

/** Identity of the document a reference was quoted from. */
export interface SessionTurnSource {
  /** Which ARCS store the referenced document lives in. */
  kind: "overview" | "knowledge" | "plan";
  /** Human-readable name of the source document. */
  label: string;
  /** Optional doc identifier (e.g. knowledge entry id, plan id). */
  doc?: string;
  id?: string;
}

/** One normalized transcript turn (mirrored Claude Code lines plus
 *  ARCS-authored reference turns). Mirrors the server's TranscriptTurn. */
export interface SessionTurn {
  /** Absolute 0-based transcript line index for mirrored turns; reference
   *  turns carry a negative id in a disjoint space. */
  id: number;
  type: "user" | "assistant" | "reference";
  text: string;
  ts?: string;
  tool?: { name: string };
  /** Reference turns only. */
  section?: SessionTurnSection;
  /** Reference turns only. */
  source?: SessionTurnSource;
}

/** Read-model for a session's transcript sidecar. */
export interface SessionTranscript {
  turns: SessionTurn[];
  /** mtime of the sidecar file; `null` when nothing has been mirrored yet. */
  mirroredAt: string | null;
}

/** Optional document-section reference carried with a send. When present the
 *  server follows the delivery call with an ARCS-authored reference turn in
 *  the session's transcript sidecar. Mirrors the server's
 *  `sendMessageSchema.reference`. */
export interface SessionMessageReference {
  section: SessionTurnSection;
  text: string;
  source: SessionTurnSource;
}

/** Payload for POST /sessions/:id/run — a headless `claude -p` targeting mode.
 *  `threadId` is the stable-mode thread to reuse; when absent (and the
 *  referenced session is not itself an ARCS-owned thread) one is minted
 *  server-side. Mirrors the server's `runClaudeMessageSchema`. */
export interface RunClaudeSessionInput {
  mode: "resume" | "oneshot" | "stable";
  message: string;
  threadId?: string;
  reference?: SessionMessageReference;
}

/** Acceptance of a headless run, returned as HTTP 202 — the run itself
 *  proceeds out-of-band. Mirrors the server's run route response. */
export interface RunResult {
  session: SessionMeta;
  run: {
    accepted: boolean;
    mode: string;
    threadId?: string;
  };
}

export interface PlanMeta {
  id: string;
  normalizedId: string;
  title: string;
  status: string;
  keywords: string[];
  summary: string;
  sourceFiles?: FileRef[];
  file: string;
  createdAt: string;
  updatedAt: string;
}

export type NodeType = "task" | "plan" | "knowledge" | "file" | "project";

export interface GraphNodeDto {
  id: string;
  type: NodeType;
  title?: string;
  keywords?: string[];
  kind?: string;
  status?: string;
  priority?: string;
  slug?: string;
}

export interface GraphEdgeDto {
  source: string;
  target: string;
  relation: string;
  weight: number;
}

export interface GraphPayload {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  buildTime?: string;
}

export interface SearchResult {
  projectSlug: string;
  entryId: string;
  entryType: "knowledge" | "plan";
  title: string;
  summary: string;
  score: number;
  kind?: string;
  status?: string;
}

export interface FlatEntry {
  type: "project" | "knowledge" | "plan" | "task";
  slug: string;
  id: string;
  title: string;
  keywords: string[];
  hint: string;
}

export interface Proposal {
  id: string;
  kind: string;
  label: string;
  structuralFacts: Record<string, unknown>;
  sourceFiles: FileRef[];
  suggestedDedupCandidates: Array<{ id: string; overlap: string[] }>;
}

export interface ChangeEvent {
  type: "changed";
  slug: string | null;
  area:
    | "root"
    | "knowledge"
    | "tasks"
    | "plans"
    | "proposals"
    | "sessions"
    | "docs"
    | "meta"
    | "other";
  path: string;
  at: string;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  health: () => request<{ name: string; version: string; dataDir: string }>("/api/health"),

  projects: () => request<{ projects: ProjectSummary[] }>("/api/projects"),
  project: (slug: string) => request<ProjectSummary>(`/api/p/${slug}`),
  updateProject: (slug: string, input: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/api/p/${slug}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  rootGraph: () => request<GraphPayload>("/api/graph"),
  flatIndex: () =>
    request<{ entries: FlatEntry[]; projectName: Record<string, string> }>("/api/index"),

  doc: (slug: string, doc: string) =>
    request<{ doc: string; content: string; exists: boolean }>(`/api/p/${slug}/docs/${doc}`),
  saveDoc: (slug: string, doc: string, content: string) =>
    request<{ updated: boolean }>(`/api/p/${slug}/docs/${doc}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  updateDependencies: (slug: string, ops: { add?: string[]; remove?: string[] }) =>
    request<{ slug: string; dependsOn: string[] }>(`/api/projects/${slug}/dependencies`, {
      method: "POST",
      body: JSON.stringify(ops),
    }),

  knowledge: (slug: string) => request<{ entries: KnowledgeMeta[] }>(`/api/p/${slug}/knowledge`),
  knowledgeEntry: (slug: string, id: string) =>
    request<{ meta: KnowledgeMeta; body: string }>(`/api/p/${slug}/knowledge/${id}`),
  createKnowledge: (slug: string, input: Record<string, unknown>) =>
    request<KnowledgeMeta>(`/api/p/${slug}/knowledge`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateKnowledge: (slug: string, id: string, input: Record<string, unknown>) =>
    request<{ meta: KnowledgeMeta; body: string }>(`/api/p/${slug}/knowledge/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteKnowledge: (slug: string, id: string) =>
    request<{ deleted: boolean }>(`/api/p/${slug}/knowledge/${id}`, { method: "DELETE" }),

  tasks: (slug: string) =>
    request<{ tasks: TaskMeta[]; order: string[] | null }>(`/api/p/${slug}/tasks?order=topo`),
  createTask: (slug: string, input: Record<string, unknown>) =>
    request<TaskMeta>(`/api/p/${slug}/tasks`, { method: "POST", body: JSON.stringify(input) }),
  updateTask: (slug: string, id: string, input: Record<string, unknown>) =>
    request<TaskMeta>(`/api/p/${slug}/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteTask: (slug: string, id: string) =>
    request<{ deleted: boolean }>(`/api/p/${slug}/tasks/${id}`, { method: "DELETE" }),

  sessions: (slug: string, opts: { status?: string; runtimeType?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.runtimeType) params.set("runtimeType", opts.runtimeType);
    const query = params.toString();
    return request<{ sessions: SessionMeta[] }>(
      `/api/p/${slug}/sessions${query ? `?${query}` : ""}`,
    );
  },
  session: (slug: string, id: string) => request<SessionMeta>(`/api/p/${slug}/sessions/${id}`),
  /** Read-model of the session's transcript sidecar (mirrored Claude Code
   *  lines plus ARCS-authored reference turns). */
  sessionTranscript: (slug: string, id: string) =>
    request<SessionTranscript>(`/api/p/${slug}/sessions/${id}/transcript`),
  createSession: (slug: string, input: Record<string, unknown>) =>
    request<SessionMeta>(`/api/p/${slug}/sessions`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /** Starts a real opencode session in the project's primary workspace. There is
   *  no claude-code equivalent — those only exist once a user runs `claude`. */
  createOpencodeSession: (slug: string, input: { title?: string } = {}) =>
    request<SessionMeta>(`/api/p/${slug}/sessions/opencode/new`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateSession: (slug: string, id: string, input: SessionUpdateInput) =>
    request<SessionMeta>(`/api/p/${slug}/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteSession: (slug: string, id: string) =>
    request<{ deleted: boolean }>(`/api/p/${slug}/sessions/${id}`, { method: "DELETE" }),
  /** Live-injects a prompt into the runtime behind the session (opencode only).
   *  An optional `reference` (a document section the caller is pointing the
   *  session at) is included in the body ONLY when present — absent, the body
   *  stays byte-identical to `{ message }`. */
  sendSessionMessage: (
    slug: string,
    id: string,
    message: string,
    reference?: SessionMessageReference,
  ) =>
    request<SessionMeta>(`/api/p/${slug}/sessions/${id}/message`, {
      method: "POST",
      body: JSON.stringify(reference === undefined ? { message } : { message, reference }),
    }),
  /** Starts a headless `claude -p` run against the session (claude-code only).
   *  Optional keys are included in the body ONLY when present — absent, the
   *  body stays `{ mode, message }`. Accepted as 202; the run settles
   *  out-of-band and writes back on `session.metadata.run`. */
  runClaudeSession: (slug: string, id: string, input: RunClaudeSessionInput) =>
    request<RunResult>(`/api/p/${slug}/sessions/${id}/run`, {
      method: "POST",
      body: JSON.stringify({
        mode: input.mode,
        message: input.message,
        ...(input.threadId && { threadId: input.threadId }),
        ...(input.reference && { reference: input.reference }),
      }),
    }),

  plans: (slug: string) => request<{ plans: PlanMeta[] }>(`/api/p/${slug}/plans`),
  plan: (slug: string, id: string) =>
    request<{ meta: PlanMeta; body: string; diagram: string | null }>(`/api/p/${slug}/plans/${id}`),
  createPlan: (slug: string, input: Record<string, unknown>) =>
    request<PlanMeta>(`/api/p/${slug}/plans`, { method: "POST", body: JSON.stringify(input) }),
  updatePlan: (slug: string, id: string, input: Record<string, unknown>) =>
    request<{ meta: PlanMeta; body: string; diagram: string | null }>(
      `/api/p/${slug}/plans/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ),
  deletePlan: (slug: string, id: string) =>
    request<{ deleted: boolean }>(`/api/p/${slug}/plans/${id}`, { method: "DELETE" }),

  graph: (slug: string) => request<GraphPayload>(`/api/p/${slug}/graph`),
  search: (q: string, opts: { slug?: string; kind?: string; limit?: number } = {}) => {
    const params = new URLSearchParams({ q });
    if (opts.slug) params.set("slug", opts.slug);
    if (opts.kind) params.set("kind", opts.kind);
    if (opts.limit) params.set("limit", String(opts.limit));
    return request<{ results: SearchResult[]; query: string }>(`/api/search?${params}`);
  },

  proposals: (slug: string) =>
    request<{ proposals: Proposal[]; generatedAt: string | null }>(`/api/p/${slug}/proposals`),
  dropProposal: (slug: string, id: string) =>
    request<{ removed: boolean }>(`/api/p/${slug}/proposals/${id}/drop`, { method: "POST" }),
  promoteProposal: (slug: string, id: string, input: Record<string, unknown>) =>
    request<{ promoted: boolean; entry: KnowledgeMeta }>(`/api/p/${slug}/proposals/${id}/promote`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
