/**
 * TanStack Query hooks for all ARCS web endpoints + mutation helpers
 * with cache invalidation.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type SessionLinkedNodeType,
  type SessionTurnInput,
  type SessionUpdateInput,
} from "./client";

export const qk = {
  projects: ["projects"] as const,
  project: (slug: string) => ["project", slug] as const,
  rootGraph: ["rootGraph"] as const,
  flatIndex: ["flatIndex"] as const,
  doc: (slug: string, doc: string) => ["doc", slug, doc] as const,
  knowledge: (slug: string) => ["knowledge", slug] as const,
  knowledgeEntry: (slug: string, id: string) => ["knowledge", slug, id] as const,
  tasks: (slug: string) => ["tasks", slug] as const,
  sessions: (slug: string) => ["sessions", slug] as const,
  sessionTranscript: (slug: string, id: string) => ["sessions", slug, id, "transcript"] as const,
  plans: (slug: string) => ["plans", slug] as const,
  plan: (slug: string, id: string) => ["plan", slug, id] as const,
  graph: (slug: string) => ["graph", slug] as const,
  /** Nested under a `workspace` area prefix so both leaves invalidate together.
   *  Deliberately NOT under `sessions`: the workspace is the repo on disk, which
   *  no ARCS data-dir change event describes, so borrowing that prefix would
   *  refetch files on every unrelated session write. */
  workspaceTree: (slug: string, path: string) => ["workspace", slug, "tree", path] as const,
  workspaceFile: (slug: string, path: string) => ["workspace", slug, "file", path] as const,
  proposals: (slug: string) => ["proposals", slug] as const,
  search: (q: string, slug?: string, kind?: string) =>
    ["search", q, slug ?? "", kind ?? ""] as const,
};

/** Keys to invalidate when a change event arrives for an area of a project. */
export function keysForArea(slug: string | null, area: string): readonly (readonly unknown[])[] {
  const searchPrefix = ["search"] as const;
  const all = [qk.projects, qk.flatIndex, searchPrefix];
  if (!slug) return [qk.projects, qk.rootGraph, qk.flatIndex, searchPrefix];
  switch (area) {
    case "knowledge":
      return [
        ...all,
        qk.knowledge(slug),
        qk.graph(slug),
        qk.project(slug),
        qk.doc(slug, "knowledge"),
      ];
    case "tasks":
      return [...all, qk.tasks(slug), qk.graph(slug), qk.project(slug), qk.doc(slug, "tasks")];
    case "plans":
      return [...all, qk.plans(slug), qk.graph(slug), qk.project(slug)];
    case "sessions":
      return [...all, qk.sessions(slug), qk.project(slug)];
    case "proposals":
      return [qk.projects, qk.proposals(slug), qk.project(slug)];
    case "docs":
      return [["doc", slug] as const];
    case "meta":
      return [qk.projects, qk.project(slug), qk.flatIndex, qk.rootGraph];
    default:
      return all;
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const useProjects = () => useQuery({ queryKey: qk.projects, queryFn: api.projects });
export const useProject = (slug: string) =>
  useQuery({ queryKey: qk.project(slug), queryFn: () => api.project(slug) });
export const useRootGraph = () => useQuery({ queryKey: qk.rootGraph, queryFn: api.rootGraph });
export const useFlatIndex = () => useQuery({ queryKey: qk.flatIndex, queryFn: api.flatIndex });
export const useDoc = (slug: string, doc: string) =>
  useQuery({ queryKey: qk.doc(slug, doc), queryFn: () => api.doc(slug, doc) });
export const useKnowledge = (slug: string) =>
  useQuery({ queryKey: qk.knowledge(slug), queryFn: () => api.knowledge(slug) });
export const useKnowledgeEntry = (slug: string, id: string) =>
  useQuery({ queryKey: qk.knowledgeEntry(slug, id), queryFn: () => api.knowledgeEntry(slug, id) });
export const useTasks = (slug: string) =>
  useQuery({ queryKey: qk.tasks(slug), queryFn: () => api.tasks(slug) });
export const useSessions = (slug: string) =>
  useQuery({ queryKey: qk.sessions(slug), queryFn: () => api.sessions(slug) });
/**
 * Sessions linked to one task/plan. Shares `qk.sessions(slug)` with
 * `useSessions`, so the existing "sessions" watcher invalidation refreshes it
 * for free and no by-link backend query is needed — session counts per project
 * are small enough to filter client-side.
 */
export const useLinkedSessions = (slug: string, nodeType: SessionLinkedNodeType, nodeId: string) =>
  useQuery({
    queryKey: qk.sessions(slug),
    queryFn: () => api.sessions(slug),
    select: (data) =>
      data.sessions.filter((s) => s.linkedNodeType === nodeType && s.linkedNodeId === nodeId),
  });
/**
 * Transcript read-model for one session. The key nests under
 * `qk.sessions(slug)` on purpose, so the existing "sessions" watcher
 * invalidation (`keysForArea("sessions")` → `["sessions", slug]`)
 * prefix-matches it and refetches it for free — no invalidation changes.
 * `enabled` lets callers gate the fetch on panel open + a selected session;
 * with no override it defaults to a non-null id.
 */
export const useSessionTranscript = (
  slug: string,
  id: string | null,
  options?: { enabled?: boolean },
) =>
  useQuery({
    queryKey: qk.sessionTranscript(slug, id ?? ""),
    queryFn: () => api.sessionTranscript(slug, id ?? ""),
    enabled: options?.enabled ?? id !== null,
  });
export const usePlans = (slug: string) =>
  useQuery({ queryKey: qk.plans(slug), queryFn: () => api.plans(slug) });
export const usePlan = (slug: string, id: string) =>
  useQuery({ queryKey: qk.plan(slug, id), queryFn: () => api.plan(slug, id) });
export const useGraph = (slug: string) =>
  useQuery({ queryKey: qk.graph(slug), queryFn: () => api.graph(slug), staleTime: 30_000 });
/** One directory of the read-only workspace plane. `enabled` gates the fetch on
 *  the browser actually showing the tree — a closed viewer must not walk the
 *  repo on every render. */
export const useWorkspaceTree = (slug: string, path: string, options?: { enabled?: boolean }) =>
  useQuery({
    queryKey: qk.workspaceTree(slug, path),
    queryFn: () => api.workspaceTree(slug, path),
    enabled: options?.enabled ?? true,
    staleTime: 30_000,
  });
/** One file's text. A null path means nothing is open, so the query never fires
 *  (the key would otherwise cache an empty-path request). */
export const useWorkspaceFile = (slug: string, path: string | null) =>
  useQuery({
    queryKey: qk.workspaceFile(slug, path ?? ""),
    queryFn: () => api.workspaceFile(slug, path ?? ""),
    enabled: path !== null && path !== "",
  });
export const useProposals = (slug: string) =>
  useQuery({ queryKey: qk.proposals(slug), queryFn: () => api.proposals(slug) });
export const useSearch = (q: string, slug?: string, kind?: string) =>
  useQuery({
    queryKey: qk.search(q, slug, kind),
    queryFn: () => api.search(q, { slug, kind, limit: 50 }),
    enabled: q.trim().length > 0,
  });

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function useInvalidator() {
  const qc = useQueryClient();
  return (keys: readonly (readonly unknown[])[]) => {
    for (const key of keys) void qc.invalidateQueries({ queryKey: key });
  };
}

export function useSaveDoc(slug: string, doc: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (content: string) => api.saveDoc(slug, doc, content),
    onSuccess: () => invalidate([qk.doc(slug, doc)]),
  });
}

export function useUpdateProject(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.updateProject(slug, input),
    onSuccess: () => invalidate([qk.projects, qk.project(slug), qk.flatIndex, qk.rootGraph]),
  });
}

export function useUpdateDependencies(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (ops: { add?: string[]; remove?: string[] }) => api.updateDependencies(slug, ops),
    onSuccess: () => invalidate([qk.projects, qk.project(slug), qk.rootGraph]),
  });
}

export function useCreateKnowledge(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.createKnowledge(slug, input),
    onSuccess: () => invalidate([qk.knowledge(slug), qk.flatIndex, qk.projects, qk.project(slug)]),
  });
}

export function useUpdateKnowledge(slug: string, id: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.updateKnowledge(slug, id, input),
    onSuccess: () =>
      invalidate([qk.knowledge(slug), qk.knowledgeEntry(slug, id), qk.flatIndex, qk.graph(slug)]),
  });
}

export function useDeleteKnowledge(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (id: string) => api.deleteKnowledge(slug, id),
    onSuccess: () => invalidate([qk.knowledge(slug), qk.flatIndex, qk.projects, qk.project(slug)]),
  });
}

export function useCreateTask(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.createTask(slug, input),
    onSuccess: () => invalidate([qk.tasks(slug), qk.flatIndex, qk.projects, qk.project(slug)]),
  });
}

export function useUpdateTask(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Record<string, unknown> }) =>
      api.updateTask(slug, id, input),
    onSuccess: () => invalidate([qk.tasks(slug), qk.flatIndex, qk.graph(slug)]),
  });
}

export function useDeleteTask(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (id: string) => api.deleteTask(slug, id),
    onSuccess: () => invalidate([qk.tasks(slug), qk.flatIndex, qk.projects, qk.project(slug)]),
  });
}

export function useCreateSession(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.createSession(slug, input),
    onSuccess: () => invalidate([qk.sessions(slug), qk.project(slug)]),
  });
}

export function useUpdateSession(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: SessionUpdateInput }) =>
      api.updateSession(slug, id, input),
    onSuccess: () => invalidate([qk.sessions(slug), qk.project(slug)]),
  });
}

export function useSendSessionTurn(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: SessionTurnInput }) =>
      api.sendSessionTurn(slug, id, input),
    // `qk.sessions(slug)` prefix-matches the nested transcript keys, so a turn
    // that appended user/reference turns refreshes open transcripts too — and
    // the list refetch is what carries a first turn's server-minted
    // `runtimeSessionId` into every picker showing the thread.
    onSuccess: () => invalidate([qk.sessions(slug), qk.project(slug)]),
  });
}

/** The Ask-AI panel's send — one implicit per-project thread, addressed by the
 *  server's virtual `ask` id. Same invalidation shape as `useSendSessionTurn`. */
export function useSendAskTurn(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (input: SessionTurnInput) => api.sendAskTurn(slug, input),
    onSuccess: () => invalidate([qk.sessions(slug), qk.project(slug)]),
  });
}

export function useDeleteSession(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (id: string) => api.deleteSession(slug, id),
    onSuccess: () => invalidate([qk.sessions(slug), qk.project(slug)]),
  });
}

export function useCreatePlan(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.createPlan(slug, input),
    onSuccess: () => invalidate([qk.plans(slug), qk.flatIndex, qk.projects, qk.project(slug)]),
  });
}

export function useUpdatePlan(slug: string, id: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.updatePlan(slug, id, input),
    onSuccess: () => invalidate([qk.plans(slug), qk.plan(slug, id), qk.flatIndex, qk.graph(slug)]),
  });
}

export function useDeletePlan(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (id: string) => api.deletePlan(slug, id),
    onSuccess: () => invalidate([qk.plans(slug), qk.flatIndex, qk.projects, qk.project(slug)]),
  });
}

export function useDropProposal(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (id: string) => api.dropProposal(slug, id),
    onSuccess: () => invalidate([qk.proposals(slug), qk.projects, qk.project(slug)]),
  });
}

export function usePromoteProposal(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Record<string, unknown> }) =>
      api.promoteProposal(slug, id, input),
    onSuccess: () =>
      invalidate([
        qk.proposals(slug),
        qk.knowledge(slug),
        qk.flatIndex,
        qk.projects,
        qk.project(slug),
      ]),
  });
}
