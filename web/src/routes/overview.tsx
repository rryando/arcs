/**
 * Project overview — contextual state at a glance: a brief, the current task,
 * recent proposal docs / knowledge, active plans, and items awaiting a decision,
 * all composed client-side from existing cached endpoints.
 * The editable project documents (overview/tasks/dependencies/knowledge.md)
 * survive in a collapsed "documents" panel beneath, alongside the untouched
 * project-metadata and dependsOn panels.
 */

import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ApiError, type KnowledgeMeta, type ProjectSummary, type TaskMeta } from "../api/client";
import {
  useDoc,
  useKnowledge,
  usePlans,
  useProject,
  useProjects,
  useProposalDocs,
  useSaveDoc,
  useTasks,
  useUpdateDependencies,
  useUpdateProject,
} from "../api/hooks";
import { Badge, kindColor, priorityColor, statusColor } from "../components/Badge";
import { Dialog, Field, FormActions, inputClass, TextInput } from "../components/Dialog";
import { MarkdownEditor } from "../components/MarkdownEditor.lazy";
import { MarkdownViewer } from "../components/MarkdownViewer";
import { Panel } from "../components/Panel";
import { useToaster } from "../components/Toaster";
import { useShortcuts } from "../hooks/useShortcuts";
import { cx, relativeTime, truncate } from "../lib/format";

const DOCUMENTS = [
  { id: "overview", label: "overview.md", generated: false },
  { id: "tasks", label: "tasks.md", generated: true },
  { id: "dependencies", label: "dependencies.md", generated: true },
  { id: "knowledge", label: "knowledge.md", generated: true },
] as const;

type DocType = (typeof DOCUMENTS)[number]["id"];

/** `?doc=` from a reference-card click-through; unknown values fall back to the
 *  default tab so a hand-edited URL degrades to "overview" instead of erroring. */
function docFromSearch(search: string): DocType {
  const fromSearch = new URLSearchParams(search).get("doc");
  return DOCUMENTS.some((entry) => entry.id === fromSearch) ? (fromSearch as DocType) : "overview";
}

export function Overview() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const location = useLocation();
  const navigate = useNavigate();
  const [docType, setDocType] = useState<DocType>(() => docFromSearch(location.searchStr));
  const [docsOpen, setDocsOpen] = useState(() =>
    new URLSearchParams(location.searchStr).has("doc"),
  );
  const { data: doc, isLoading } = useDoc(slug, docType);
  const { data: project } = useProject(slug);
  const { data: projectsData } = useProjects();
  const { data: tasksData } = useTasks(slug);
  const { data: plansData } = usePlans(slug);
  const { data: knowledgeData, isLoading: knowledgeLoading } = useKnowledge(slug);
  const { data: proposalDocsData, isLoading: proposalDocsLoading } = useProposalDocs(slug);
  const saveDoc = useSaveDoc(slug, docType);
  const updateProject = useUpdateProject(slug);
  const updateDeps = useUpdateDependencies(slug);
  const { push } = useToaster();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [depInput, setDepInput] = useState("");

  const selectedDoc = DOCUMENTS.find((entry) => entry.id === docType) ?? DOCUMENTS[0];
  const dirty = draft !== null && draft !== doc?.content;

  /** Deep-link helper — the shell's `go` pattern (root.tsx): string-built paths
   *  under the project base, cast through `as never` for the code-based tree. */
  const go = (path: string) => navigate({ to: `/p/$slug${path}`, params: { slug } } as never);

  // --- contextual state, composed client-side from the cached endpoints ---

  /** Topo-ordered tasks (tasks.tsx rank-sort over the server's `order`). */
  const orderedTasks = useMemo(() => {
    const tasks = tasksData?.tasks ?? [];
    const order = tasksData?.order;
    if (!order) return tasks;
    const rank = new Map(order.map((id, i) => [id, i]));
    return [...tasks].sort(
      (a, b) => (rank.get(a.normalizedId) ?? 9e9) - (rank.get(b.normalizedId) ?? 9e9),
    );
  }, [tasksData]);

  /** The task the user is working on now: first in_progress, else the first
   *  not-done task whose dependsOn edges are all satisfied (topo order already
   *  encodes readiness; this re-checks it explicitly). */
  const currentTask = useMemo(() => {
    const byId = new Map(orderedTasks.map((t) => [t.normalizedId, t]));
    const isFinished = (t: TaskMeta) => t.status === "done" || t.status === "cancelled";
    const isReady = (t: TaskMeta) =>
      (t.dependsOn ?? []).every((dep) => byId.get(dep)?.status === "done");
    return (
      orderedTasks.find((t) => t.status === "in_progress") ??
      orderedTasks.find((t) => !isFinished(t) && isReady(t)) ??
      null
    );
  }, [orderedTasks]);

  /** Per-plan task progress (plans.tsx rollup pattern). */
  const taskRollup = useMemo(() => {
    const map = new Map<string, { total: number; done: number }>();
    for (const task of tasksData?.tasks ?? []) {
      if (!task.planId) continue;
      const entry = map.get(task.planId) ?? { total: 0, done: 0 };
      entry.total += 1;
      if (task.status === "done") entry.done += 1;
      map.set(task.planId, entry);
    }
    return map;
  }, [tasksData]);

  const activePlans = useMemo(
    () =>
      (plansData?.plans ?? [])
        .filter((p) => p.status !== "done" && p.status !== "archived")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [plansData],
  );

  const pendingDocs = useMemo(
    () =>
      [...(proposalDocsData?.proposalDocs ?? [])].sort((a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
      ),
    [proposalDocsData],
  );
  const topDocs = useMemo(() => pendingDocs.slice(0, 5), [pendingDocs]);
  const docRemainder = Math.max(0, pendingDocs.length - topDocs.length);

  const topKnowledge = useMemo(
    () =>
      [...(knowledgeData?.entries ?? [])]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 5),
    [knowledgeData],
  );

  const codegraphCount = project?.counts.proposals ?? 0;

  const chooseDoc = (next: DocType) => {
    setEditing(false);
    setDraft(null);
    setDocType(next);
  };

  // `?doc=` from a reference-card click-through must switch the tab even when
  // this route is already mounted — same-page navigation never remounts, so the
  // initializer above cannot cover it. A doc param also expands the collapsed
  // documents panel, or the deep link would land on a shut lid. Manual tab
  // clicks do not touch the URL, so this effect never overrides them (setting
  // state to its current value bails out in React).
  useEffect(() => {
    if (new URLSearchParams(location.searchStr).has("doc")) setDocsOpen(true);
    setEditing(false);
    setDraft(null);
    setDocType(docFromSearch(location.searchStr));
  }, [location.searchStr]);

  const startEdit = () => {
    setDraft(doc?.content ?? "");
    setEditing(true);
  };

  const save = () => {
    if (draft === null) return;
    saveDoc.mutate(draft, {
      onSuccess: () => {
        push("success", `${selectedDoc.label} saved`);
        setEditing(false);
        setDraft(null);
      },
      onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
    });
  };

  // Document shortcuts only while the panel is open — "e" on a collapsed panel
  // would edit an invisible editor.
  useShortcuts(
    docsOpen
      ? [
          {
            keys: "e",
            description: "edit current document",
            group: "documents",
            priority: 10,
            run: () => !editing && startEdit(),
          },
          {
            keys: "ctrl+s",
            description: "save current document",
            group: "documents",
            priority: 10,
            allowInInput: true,
            run: () => editing && save(),
          },
          {
            keys: "escape",
            description: "stop editing",
            group: "documents",
            priority: 10,
            allowInInput: true,
            run: () => {
              if (editing) {
                setEditing(false);
                setDraft(null);
              }
            },
          },
          ...DOCUMENTS.map((entry, index) => ({
            keys: String(index + 1),
            description: `open ${entry.label}`,
            group: "documents",
            priority: 10,
            run: () => chooseDoc(entry.id),
          })),
        ]
      : [],
  );

  const otherProjects = useMemo(
    () =>
      (projectsData?.projects ?? []).filter(
        (entry) => entry.slug !== slug && !(project?.dependsOn ?? []).includes(entry.slug),
      ),
    [projectsData, slug, project],
  );

  const depAction = (ops: { add?: string[]; remove?: string[] }) => {
    updateDeps.mutate(ops, {
      onSuccess: (res) => push("success", `dependsOn → [${res.dependsOn.join(", ")}]`),
      onError: (err) => {
        if (err instanceof ApiError && err.code === "CYCLE_DETECTED") {
          push("error", "rejected: would create a dependency cycle");
        } else {
          push("error", err instanceof Error ? err.message : String(err));
        }
      },
    });
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <Panel title="brief" hint="meta.json description" className="shrink-0">
        <p className="px-3 py-2 text-[12px] leading-snug">
          {project?.description ? (
            project.description
          ) : (
            <span className="text-term-dim">no description yet — edit settings to add one</span>
          )}
        </p>
      </Panel>

      {currentTask && (
        <Panel
          title="current task"
          hint={currentTask.status === "in_progress" ? "in progress now" : "ready — deps satisfied"}
          className="shrink-0"
        >
          <button
            type="button"
            onClick={() => go("/tasks")}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-term-fg/5"
          >
            <Badge color={statusColor(currentTask.status)}>{currentTask.status}</Badge>
            <Badge color={priorityColor(currentTask.priority)}>{currentTask.priority}</Badge>
            <span className="min-w-0 flex-1 truncate font-bold text-term-fg">
              {truncate(currentTask.title, 64)}
            </span>
            <span className="text-[11px] text-term-dim">{currentTask.normalizedId}</span>
          </button>
        </Panel>
      )}

      <Panel title="proposal docs" hint={`${pendingDocs.length} pending`} className="shrink-0">
        {proposalDocsLoading ? (
          <div className="px-3 py-4 text-term-dim">loading…</div>
        ) : topDocs.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11px] text-term-dim">
            <span className="text-term-border-hi">∅</span> no pending proposal docs — drafts start
            with <code className="text-term-amber">arcs proposal-doc create</code>
          </div>
        ) : (
          <div className="divide-y divide-term-border/40">
            {topDocs.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => go(`/proposal-docs/${d.id}`)}
                className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-term-fg/5"
              >
                <span className="min-w-0 flex-1 truncate font-bold text-term-fg">
                  {truncate(d.title, 64)}
                </span>
                <span className="text-[11px] text-term-dim">{relativeTime(d.updatedAt)}</span>
              </button>
            ))}
            {codegraphCount > 0 && (
              <button
                type="button"
                onClick={() => go("/knowledge")}
                className="flex w-full items-center gap-2 border-t border-term-border/40 px-3 py-1 text-left text-[11px] hover:bg-term-fg/5"
              >
                <span className="text-term-amber">
                  ⚑ {codegraphCount} codegraph proposal{codegraphCount === 1 ? "" : "s"}
                </span>
                <span className="flex-1" />
                <span className="text-term-dim">curate in knowledge →</span>
              </button>
            )}
          </div>
        )}
      </Panel>

      <Panel
        title="knowledge"
        hint={`${knowledgeData?.entries.length ?? 0} entries`}
        className="shrink-0"
      >
        {knowledgeLoading ? (
          <div className="px-3 py-4 text-term-dim">loading…</div>
        ) : topKnowledge.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11px] text-term-dim">
            <span className="text-term-border-hi">∅</span> no knowledge entries yet
          </div>
        ) : (
          <div className="divide-y divide-term-border/40">
            {topKnowledge.map((e) => (
              <KnowledgeRow
                key={e.normalizedId}
                entry={e}
                onOpen={() => go(`/knowledge/${e.normalizedId}`)}
              />
            ))}
          </div>
        )}
      </Panel>

      {activePlans.length > 0 && (
        <Panel title="active plans" hint={`${activePlans.length} active`} className="shrink-0">
          <div className="divide-y divide-term-border/40">
            {activePlans.map((p) => {
              const roll = taskRollup.get(p.normalizedId);
              const pct = roll && roll.total > 0 ? Math.round((roll.done / roll.total) * 100) : 0;
              return (
                <button
                  key={p.normalizedId}
                  type="button"
                  onClick={() => go(`/plans/${p.normalizedId}`)}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-term-fg/5"
                >
                  <Badge color={statusColor(p.status)}>{p.status}</Badge>
                  <span className="min-w-0 flex-1 truncate font-bold text-term-fg">
                    {truncate(p.title, 56)}
                  </span>
                  {roll ? (
                    <span className={pct === 100 ? "text-term-green" : "text-term-cyan"}>
                      {roll.done}/{roll.total} <span className="text-term-dim">({pct}%)</span>
                    </span>
                  ) : (
                    <span className="text-term-dim">—</span>
                  )}
                </button>
              );
            })}
          </div>
        </Panel>
      )}

      {(docRemainder > 0 || codegraphCount > 0) && (
        <Panel title="awaiting decision" hint="pending your review" className="shrink-0">
          <div className="divide-y divide-term-border/40">
            {docRemainder > 0 && (
              <button
                type="button"
                onClick={() => go("/proposal-docs")}
                className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-term-fg/5"
              >
                <span className="font-bold text-term-amber">{docRemainder}</span>
                <span className="min-w-0 flex-1 text-term-fg">
                  more proposal docs beyond the top {topDocs.length}
                </span>
                <span className="text-[11px] text-term-dim">proposal docs →</span>
              </button>
            )}
            {codegraphCount > 0 && (
              <button
                type="button"
                onClick={() => go("/knowledge")}
                className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-term-fg/5"
              >
                <span className="font-bold text-term-amber">{codegraphCount}</span>
                <span className="min-w-0 flex-1 text-term-fg">codegraph proposals to curate</span>
                <span className="text-[11px] text-term-dim">knowledge →</span>
              </button>
            )}
          </div>
        </Panel>
      )}

      <Panel
        title="documents"
        hint={
          docsOpen
            ? editing
              ? dirty
                ? `${selectedDoc.label} · modified`
                : "editing"
              : selectedDoc.label
            : `${DOCUMENTS.length} project documents`
        }
        actions={
          <span className="flex items-center gap-2 text-[11px]">
            {docsOpen &&
              (editing ? (
                <>
                  <button
                    type="button"
                    onClick={save}
                    disabled={saveDoc.isPending}
                    className="border border-term-green/60 px-2 py-0.5 font-bold text-term-green hover:bg-term-green hover:text-term-bg disabled:opacity-50"
                  >
                    {saveDoc.isPending ? "…" : "save"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      setDraft(null);
                    }}
                    className="border border-term-border px-2 py-0.5 text-term-dim hover:text-term-fg"
                  >
                    discard
                  </button>
                  <span className="kbd">ctrl+s</span>
                </>
              ) : (
                <button
                  type="button"
                  onClick={startEdit}
                  className="border border-term-border px-2 py-0.5 text-term-dim hover:text-term-green"
                >
                  edit [e]
                </button>
              ))}
            <button
              type="button"
              onClick={() => setDocsOpen((v) => !v)}
              className="border border-term-border px-2 py-0.5 text-term-dim hover:text-term-green"
            >
              {docsOpen ? "collapse" : "expand"}
            </button>
          </span>
        }
        className={cx("shrink-0", docsOpen && "h-96")}
      >
        {docsOpen ? (
          <>
            <div className="flex items-center gap-px border-b border-term-border px-2 py-1 text-[11px]">
              {DOCUMENTS.map((entry, index) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => chooseDoc(entry.id)}
                  className={cx(
                    "border px-2 py-0.5",
                    docType === entry.id
                      ? "border-term-green/60 font-bold text-term-green"
                      : "border-transparent text-term-dim hover:text-term-fg",
                  )}
                >
                  {entry.label} [{index + 1}]
                </button>
              ))}
              {selectedDoc.generated && (
                <span className="ml-2 text-term-amber">
                  generated aggregate — entity updates may overwrite this file
                </span>
              )}
            </div>
            <div className="h-[calc(100%-33px)] overflow-auto p-4">
              {isLoading ? (
                <div className="text-term-dim">loading…</div>
              ) : editing && draft !== null ? (
                <MarkdownEditor
                  value={draft}
                  onChange={setDraft}
                  onSaveShortcut={save}
                  className="h-full min-h-96"
                />
              ) : doc?.exists ? (
                <MarkdownViewer
                  content={doc.content}
                  slug={slug}
                  referenceSource={{ kind: "overview", label: selectedDoc.label, doc: docType }}
                />
              ) : (
                <div className="text-term-dim">
                  no {selectedDoc.label} yet — press <span className="kbd">e</span> to write one
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="px-3 py-1.5 text-[11px] text-term-dim">
            {DOCUMENTS.map((entry) => entry.label).join(" · ")} — expand to browse or edit
          </div>
        )}
      </Panel>

      <Panel
        title="project metadata"
        hint="meta.json + root DAG name/status"
        actions={
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="border border-term-border px-2 py-0.5 text-[11px] text-term-dim hover:text-term-green"
          >
            edit settings
          </button>
        }
        className="shrink-0"
      >
        <div className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 px-3 py-2 text-[11px]">
          <span className="text-term-dim">name</span>
          <span>{project?.name ?? slug}</span>
          <span className="text-term-dim">status</span>
          <span className="text-term-green">{project?.status ?? "—"}</span>
          <span className="text-term-dim">repository</span>
          <span className="text-term-cyan">{project?.repoUrl ?? "—"}</span>
          <span className="text-term-dim">workspace paths</span>
          <span>{project?.workspacePaths.join(" · ") || "—"}</span>
        </div>
      </Panel>

      <Panel title="depends on" hint="root dag edges" className="shrink-0">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          {(project?.dependsOn ?? []).map((dep) => (
            <span
              key={dep}
              className="flex items-center gap-1 border border-term-magenta/40 px-1.5 py-0.5 text-[11px] text-term-magenta"
            >
              {dep}
              <button
                type="button"
                aria-label={`Remove dependency ${dep}`}
                onClick={() => depAction({ remove: [dep] })}
                className="ml-1 text-term-red hover:font-bold"
              >
                ×
              </button>
            </span>
          ))}
          {(project?.dependsOn ?? []).length === 0 && (
            <span className="text-[11px] text-term-dim">no upstream dependencies</span>
          )}

          <span className="flex-1" />
          <input
            type="text"
            value={depInput}
            onChange={(event) => setDepInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && depInput.trim()) {
                depAction({ add: [depInput.trim()] });
                setDepInput("");
              }
            }}
            placeholder={
              otherProjects[0] ? `add e.g. ${otherProjects[0].slug}` : "add dependency slug"
            }
            list="dep-candidates"
            className="w-56 border border-term-border bg-term-inset px-2 py-0.5 text-[11px] text-term-fg outline-none focus:border-term-green/60 placeholder:text-term-dim/50"
          />
          <datalist id="dep-candidates">
            {otherProjects.map((entry) => (
              <option key={entry.slug} value={entry.slug} />
            ))}
          </datalist>
        </div>
      </Panel>

      {settingsOpen && project && (
        <ProjectSettingsDialog
          project={project}
          pending={updateProject.isPending}
          onClose={() => setSettingsOpen(false)}
          onSubmit={(input) =>
            updateProject.mutate(input, {
              onSuccess: () => {
                push("success", "project metadata saved");
                setSettingsOpen(false);
              },
              onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
            })
          }
        />
      )}
    </div>
  );
}

/** One knowledge row — kind badge + title, mirroring the knowledge table's
 *  kindColor rendering. */
function KnowledgeRow({ entry, onOpen }: { entry: KnowledgeMeta; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-term-fg/5"
    >
      <Badge color={kindColor(entry.kind)}>{entry.kind}</Badge>
      <span className="min-w-0 flex-1 truncate font-bold text-term-fg">
        {truncate(entry.title, 64)}
      </span>
      <span className="text-[11px] text-term-dim">{relativeTime(entry.updatedAt)}</span>
    </button>
  );
}

function ProjectSettingsDialog({
  project,
  pending,
  onClose,
  onSubmit,
}: {
  project: ProjectSummary;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [status, setStatus] = useState(project.status);
  const [repoUrl, setRepoUrl] = useState(project.repoUrl ?? "");
  const [workspacePaths, setWorkspacePaths] = useState(project.workspacePaths.join("\n"));

  const submit = () => {
    if (!name.trim() || !status.trim()) return;
    onSubmit({
      name: name.trim(),
      description,
      status: status.trim(),
      repoUrl: repoUrl.trim() || null,
      workspacePaths: workspacePaths
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    });
  };

  return (
    <Dialog title={`project settings — ${project.slug}`} onClose={onClose} width="max-w-2xl">
      <div className="grid grid-cols-2 gap-x-3">
        <Field label="name">
          <TextInput value={name} onChange={setName} autoFocus onEnter={submit} />
        </Field>
        <Field label="status" hint="root DAG + project meta">
          <TextInput value={status} onChange={setStatus} onEnter={submit} />
        </Field>
      </div>
      <Field label="description">
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className={`${inputClass} min-h-20 resize-y`}
        />
      </Field>
      <Field label="repository URL" hint="optional">
        <TextInput
          value={repoUrl}
          onChange={setRepoUrl}
          placeholder="https://github.com/org/repo"
        />
      </Field>
      <Field label="workspace paths" hint="one absolute path per line">
        <textarea
          value={workspacePaths}
          onChange={(event) => setWorkspacePaths(event.target.value)}
          className={`${inputClass} min-h-20 resize-y`}
        />
      </Field>
      <FormActions
        submitLabel="save settings"
        onSubmit={submit}
        onCancel={onClose}
        pending={pending}
      />
    </Dialog>
  );
}
