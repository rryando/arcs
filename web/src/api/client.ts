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

// ---------------------------------------------------------------------------
// Mutation token
// ---------------------------------------------------------------------------

/** Pinned by the server, which injects the tag into the shell it serves
 *  (src/web-server/static.ts). Changing it here alone silently 401s the app. */
const TOKEN_META_NAME = "arcs-web-token";

/** Mirrors MUTATION_METHODS in src/web-server/web-auth.ts. Reads are not gated,
 *  so a GET goes out exactly as it did before the token existed. */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The token this document was served with, read ONCE at module load.
 *
 * One read is enough: the token is minted per server start and the shell is
 * served `no-store`, so a rotated token always arrives with a fresh document —
 * re-reading per request could never see anything a reload would not.
 *
 * Two degradations, both deliberate and silent:
 *  - no `document` at all (this module is imported by node-environment tests) —
 *    guarded, because a throw here would be an import-time crash;
 *  - no meta tag / empty content (server too old, or served by something that
 *    is not this server) — no header goes out and the server answers a clean
 *    401, which is a far more legible failure than a client-side exception.
 */
function readWebToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return (
    document.querySelector(`meta[name="${TOKEN_META_NAME}"]`)?.getAttribute("content") ?? undefined
  );
}

const webToken = readWebToken();

/**
 * The single writing path to the API. Exported so a caller needing custom init
 * (extra headers, an AbortSignal) still goes through the token merge instead of
 * hand-rolling a `fetch` that the server would refuse.
 *
 * Header order is load-bearing. `...init` is spread FIRST and `headers` rebuilt
 * after it, so a caller's own headers can never replace the whole header object
 * and drop the token; inside, `...init?.headers` comes LAST so a caller can
 * still override `Content-Type` (and, if it ever needs to, the token itself).
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      // Absent token => no header at all, never `X-ARCS-Token: undefined`.
      ...(webToken && MUTATION_METHODS.has(method) ? { "X-ARCS-Token": webToken } : {}),
      ...init?.headers,
    },
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
  /** Pending proposal docs in the data dir's proposals/ scan. */
  proposalDocs: number;
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

/** The runtimes the Ask-AI surface can drive one-shot. Mirrors the server's
 *  SESSION_RUNTIME_TYPES: a POST body carrying an unknown string degrades to
 *  "pi" server-side, and a runtime with a registered type but no one-shot
 *  driver is refused with 400 UNKNOWN_RUNNER. */
export type RunnerId = "pi" | "opencode" | "claude-code" | "codex";

/** One entry of GET /api/runners — the drivable one-shot runtime surface,
 *  probed for on-PATH availability at request time. */
export interface RunnerInfo {
  id: RunnerId;
  label: string;
  binary: string;
  available: boolean;
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

/** The `doc` variant — a markdown document section. Its tag is optional because
 *  the server defaults it: a body with no `type` is a doc reference, which is
 *  what every caller sent before the union existed. Mirrors the server's
 *  `docReferenceSchema`.
 *
 *  This is also the ONLY variant the UI can build today (the MarkdownViewer ✉
 *  flow), so a call site that genuinely dereferences `section`/`source` — the
 *  pending-ref preview — names this type directly. Anything that merely
 *  CARRIES a reference to the API must take `SessionReference` instead: a
 *  transport narrower than the transport it wraps silently drops variants the
 *  server already accepts. */
export interface SessionDocReference {
  type?: "doc";
  section: SessionTurnSection;
  text: string;
  source: SessionTurnSource;
}

/** The `file` variant — a line range in a workspace file, sent as a POINTER:
 *  `excerpt` is a short anchor, never the authoritative content. `headRev` is
 *  the revision the slice was taken at, so a later diff can tell whether the
 *  file moved under the agent. Mirrors the server's `fileReferenceSchema`. */
export interface SessionFileReference {
  type: "file";
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  excerpt?: string;
  headRev?: string;
}

/** The `node` variant — a DAG entity, with no text slice of its own. Mirrors
 *  the server's `nodeReferenceSchema`. */
export interface SessionNodeReference {
  type: "node";
  kind: "task" | "plan" | "knowledge";
  id: string;
}

/** Optional reference carried with a send. When present the server follows the
 *  delivery call with an ARCS-authored reference turn in the session's
 *  transcript sidecar. Mirrors the server's `sessionReferenceSchema` — a
 *  discriminated union on `type`; an unknown variant is refused with 400. */
export type SessionReference = SessionDocReference | SessionFileReference | SessionNodeReference;

/** One entry in a workspace tree listing. `path` is root-relative and is
 *  exactly what both workspace routes take back. */
export interface WorkspaceEntry {
  name: string;
  path: string;
  type: "dir" | "file";
}

/** A directory listing under the project's workspace roots. `truncated` means a
 *  server cap (entry count or depth) cut the walk short — the plane never
 *  streams an unbounded tree. */
export interface WorkspaceTree {
  /** Absolute, symlink-resolved workspace root the listing is rooted at. */
  root: string;
  /** Root-relative path of the listed directory; `""` is the root itself. */
  path: string;
  depth: number;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

/** One file's text, byte-capped by the server. `headRev` is the workspace's
 *  head revision at read time (null outside a git worktree) and is what a
 *  `SessionFileReference` built from this response carries. */
export interface WorkspaceFile {
  path: string;
  root: string;
  content: string;
  lineCount: number;
  size: number;
  truncated: boolean;
  headRev: string | null;
}

/** Payload for POST /api/p/:slug/ask — one turn of a stateless headless
 *  conversation. There is no thread record anywhere: the client owns the
 *  transcript (localStorage) and sends a bounded `history` tail plus the
 *  runtime-native `continueSessionId` a previous run's end frame harvested.
 *  Mirrors the server's `askSchema` — `runner` defaults to "pi" server-side.
 *
 *  Optional keys are included in the body ONLY when present. */
export interface AskTurnInput {
  runner?: RunnerId;
  message: string;
  refs?: SessionReference[];
  /** Bounded, oldest-first transcript tail (user/assistant only). */
  history?: { role: "user" | "assistant"; text: string }[];
  /** Runtime-native session id the previous run's end frame carried. */
  continueSessionId?: string;
}

/** Acceptance of one ask turn, returned as HTTP 202 — the run proceeds
 *  out-of-band. The stream to tail is `GET /api/p/{slug}/runs/{runId}/stream`. */
export interface AskTurnResult {
  runId: string;
  /** Server-built stream URL, already keyed on the run id. */
  streamUrl: string;
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

/** A proposal document in the data dir's proposals/ plane. Listings carry
 *  pending docs only — accepted ones surface via their plan — so status is
 *  "pending" in every list row; the detail endpoint's pending → accepted
 *  fallback is where "accepted" appears (read-only). */
export interface ProposalDoc {
  id: string;
  title: string;
  status: "pending" | "accepted";
  /** Data-dir-relative path, e.g. proposals/<id>.proposal.md. */
  path: string;
  updatedAt: string | null;
}

export interface ProposalDocDetail {
  id: string;
  status: "pending" | "accepted";
  path: string;
  title: string;
  body: string;
  updatedAt: string;
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

  runners: () => request<{ runners: RunnerInfo[] }>("/api/runners"),
  /** One turn of a stateless headless conversation, accepted as 202 — the run
   *  settles out-of-band and the reply rides the event log the `streamUrl`
   *  names. `runner` defaults to "pi" server-side; unknown strings degrade to
   *  "pi" there too, so this client always sends the picked id explicitly. */
  askTurn: (slug: string, input: AskTurnInput) =>
    request<AskTurnResult>(`/api/p/${slug}/ask`, {
      method: "POST",
      body: JSON.stringify({
        ...(input.runner !== undefined && { runner: input.runner }),
        message: input.message,
        ...(input.refs?.length && { refs: input.refs }),
        ...(input.history?.length && { history: input.history }),
        ...(input.continueSessionId && { continueSessionId: input.continueSessionId }),
      }),
    }),
  /** Read-only workspace file plane. Both calls are GETs by contract — there is
   *  no write counterpart, and adding one here would need a route that
   *  deliberately does not exist. */
  workspaceTree: (slug: string, path = "", depth?: number) => {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (depth !== undefined) params.set("depth", String(depth));
    const query = params.toString();
    return request<WorkspaceTree>(`/api/p/${slug}/workspace/tree${query ? `?${query}` : ""}`);
  },
  workspaceFile: (slug: string, path: string) =>
    request<WorkspaceFile>(`/api/p/${slug}/workspace/file?path=${encodeURIComponent(path)}`),

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

  proposalDocs: (slug: string) =>
    request<{
      proposalDocs: ProposalDoc[];
      counts: { pending: number; accepted: number };
    }>(`/api/p/${slug}/proposal-docs`),
  proposalDoc: (slug: string, id: string) =>
    request<ProposalDocDetail>(`/api/p/${slug}/proposal-docs/${id}`),
  saveProposalDoc: (slug: string, id: string, content: string) =>
    request<{ id: string; status: "pending"; path: string; updated: boolean }>(
      `/api/p/${slug}/proposal-docs/${id}`,
      { method: "PUT", body: JSON.stringify({ content }) },
    ),
  promoteProposalDoc: (slug: string, id: string) =>
    request<{ promoted: boolean; plan: PlanMeta; docPath: string; recovered?: boolean }>(
      `/api/p/${slug}/proposal-docs/${id}/promote`,
      { method: "POST" },
    ),
};
