/**
 * TanStack Query hooks for all ARCS web endpoints + mutation helpers
 * with cache invalidation.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { appendTurn, getConversation, historyForSend, newTurnId } from "../lib/ask-store";
import { type AskTurnResult, api, type RunnerId, type SessionReference } from "./client";

export const qk = {
  projects: ["projects"] as const,
  project: (slug: string) => ["project", slug] as const,
  rootGraph: ["rootGraph"] as const,
  flatIndex: ["flatIndex"] as const,
  doc: (slug: string, doc: string) => ["doc", slug, doc] as const,
  knowledge: (slug: string) => ["knowledge", slug] as const,
  knowledgeEntry: (slug: string, id: string) => ["knowledge", slug, id] as const,
  tasks: (slug: string) => ["tasks", slug] as const,
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
  proposalDocs: (slug: string) => ["proposalDocs", slug] as const,
  proposalDoc: (slug: string, id: string) => ["proposalDocs", slug, id] as const,
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
    // The server still emits area: "sessions" for RUN-STORE writes (claims and
    // settles) even though the sessions entity is gone. There is no query cache
    // to invalidate for those anymore — Ask-AI conversations live in
    // localStorage (ask-store) and notify their own subscribers — so the branch
    // stays for the project-summary refresh only.
    case "sessions":
      return [...all, qk.project(slug)];
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
/** The drivable one-shot runtime surface. Cache key is exactly `["runners"]`;
 *  60s staleTime because availability is probed per request and rarely moves. */
export const useRunners = () =>
  useQuery({ queryKey: ["runners"], queryFn: api.runners, staleTime: 60_000 });
export const useDoc = (slug: string, doc: string) =>
  useQuery({ queryKey: qk.doc(slug, doc), queryFn: () => api.doc(slug, doc) });
export const useKnowledge = (slug: string) =>
  useQuery({ queryKey: qk.knowledge(slug), queryFn: () => api.knowledge(slug) });
export const useKnowledgeEntry = (slug: string, id: string) =>
  useQuery({ queryKey: qk.knowledgeEntry(slug, id), queryFn: () => api.knowledgeEntry(slug, id) });
export const useTasks = (slug: string) =>
  useQuery({ queryKey: qk.tasks(slug), queryFn: () => api.tasks(slug) });
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
export const useProposalDocs = (slug: string) =>
  useQuery({ queryKey: qk.proposalDocs(slug), queryFn: () => api.proposalDocs(slug) });
export const useProposalDoc = (slug: string, id: string) =>
  useQuery({ queryKey: qk.proposalDoc(slug, id), queryFn: () => api.proposalDoc(slug, id) });
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

/** What the Ask-AI panel asks a send to do. Everything the server needs from
 *  the local conversation (`history`, `continueSessionId`) is assembled HERE
 *  from ask-store at send time, so the caller never sees the cap logic. */
export interface SendAskInput {
  message: string;
  refs?: SessionReference[];
}

/**
 * The Ask-AI panel's send — one turn of the stateless per-run conversation.
 *
 * Reads the runner's conversation from ask-store, POSTs the turn with the
 * bounded local history tail and the persisted continuation id, and on success
 * (the 202 acceptance) persists the user turn into the store. The caller tails
 * the returned `streamUrl` itself; `CONTINUATION_LOST` surfaces on that
 * stream's `end` frame, so the panel clears the id there, never here.
 */
export function useSendAskTurn(slug: string, runner: RunnerId) {
  return useMutation({
    mutationFn: async (input: SendAskInput): Promise<AskTurnResult> => {
      const conversation = getConversation(slug, runner);
      const history = historyForSend(conversation);
      return api.askTurn(slug, {
        runner,
        message: input.message,
        ...(input.refs?.length && { refs: input.refs }),
        ...(history.length > 0 && { history }),
        ...(conversation.continueSessionId !== undefined && {
          continueSessionId: conversation.continueSessionId,
        }),
      });
    },
    onSuccess: (_result, input) => {
      appendTurn(slug, runner, {
        id: newTurnId(),
        role: "user",
        text: input.message,
        ts: new Date().toISOString(),
        ...(input.refs?.[0] && { ref: input.refs[0] }),
      });
    },
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

export function useSaveProposalDoc(slug: string, id: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (content: string) => api.saveProposalDoc(slug, id, content),
    onSuccess: () => invalidate([qk.proposalDocs(slug), qk.proposalDoc(slug, id)]),
  });
}

/** Promoting turns the doc into a plan: the queue empties, the plan index
 *  grows, and every count that feeds the shell tabs moves with them. */
export function usePromoteProposalDoc(slug: string) {
  const invalidate = useInvalidator();
  return useMutation({
    mutationFn: (id: string) => api.promoteProposalDoc(slug, id),
    onSuccess: () =>
      invalidate([qk.proposalDocs(slug), qk.plans(slug), qk.projects, qk.project(slug)]),
  });
}
