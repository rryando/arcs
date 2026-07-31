/**
 * Project documents + settings: browse/edit every top-level markdown file,
 * update project metadata, and manage root DAG dependency edges.
 */

import { useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ApiError, type ProjectSummary } from "../api/client";
import {
  useDoc,
  useProject,
  useProjects,
  useSaveDoc,
  useUpdateDependencies,
  useUpdateProject,
} from "../api/hooks";
import { Dialog, Field, FormActions, inputClass, TextInput } from "../components/Dialog";
import { MarkdownEditor } from "../components/MarkdownEditor.lazy";
import { MarkdownViewer } from "../components/MarkdownViewer";
import { Panel } from "../components/Panel";
import { useToaster } from "../components/Toaster";
import { useShortcuts } from "../hooks/useShortcuts";
import { cx } from "../lib/format";

const DOCUMENTS = [
  { id: "overview", label: "overview.md", generated: false },
  { id: "tasks", label: "tasks.md", generated: true },
  { id: "dependencies", label: "dependencies.md", generated: true },
  { id: "knowledge", label: "knowledge.md", generated: true },
] as const;

type DocType = (typeof DOCUMENTS)[number]["id"];

export function Overview() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [docType, setDocType] = useState<DocType>("overview");
  const { data: doc, isLoading } = useDoc(slug, docType);
  const { data: project } = useProject(slug);
  const { data: projectsData } = useProjects();
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

  const chooseDoc = (next: DocType) => {
    setEditing(false);
    setDraft(null);
    setDocType(next);
  };

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

  useShortcuts([
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
  ]);

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
      <Panel
        title="documents"
        hint={editing ? (dirty ? `${selectedDoc.label} · modified` : "editing") : selectedDoc.label}
        actions={
          editing ? (
            <span className="flex items-center gap-2 text-[11px]">
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
            </span>
          ) : (
            <button
              type="button"
              onClick={startEdit}
              className="border border-term-border px-2 py-0.5 text-[11px] text-term-dim hover:text-term-green"
            >
              edit [e]
            </button>
          )
        }
        className="min-h-96 flex-1"
      >
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
            <MarkdownViewer content={doc.content} />
          ) : (
            <div className="text-term-dim">
              no {selectedDoc.label} yet — press <span className="kbd">e</span> to write one
            </div>
          )}
        </div>
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
