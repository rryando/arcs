/**
 * Knowledge detail — full document viewer with meta header; edit mode with
 * split editor/preview and meta fields.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useDeleteKnowledge, useKnowledgeEntry, useUpdateKnowledge } from "../api/hooks";
import { Badge, kindColor } from "../components/Badge";
import { ConfirmDialog, Field, inputClass, SelectInput, TextInput } from "../components/Dialog";
import { MarkdownEditor } from "../components/MarkdownEditor.lazy";
import { MarkdownViewer } from "../components/MarkdownViewer";
import { useToaster } from "../components/Toaster";
import { useShortcuts } from "../hooks/useShortcuts";
import { formatFileRefs, parseFileRefs } from "../lib/file-refs";
import { relativeTime } from "../lib/format";

const KINDS = [
  "lesson",
  "gotcha",
  "pattern",
  "architecture",
  "module",
  "feature",
  "reference",
  "decision",
];
const AUDIENCES = ["orchestrator", "implementer", "designer", "universal"];

export function KnowledgeDetail() {
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };
  const navigate = useNavigate();
  const { data, isLoading, error } = useKnowledgeEntry(slug, id);
  const updateKnowledge = useUpdateKnowledge(slug, id);
  const deleteKnowledge = useDeleteKnowledge(slug);
  const { push } = useToaster();

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [vimMode, setVimMode] = useState(false);

  // Draft state (edit mode)
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("lesson");
  const [keywords, setKeywords] = useState("");
  const [summary, setSummary] = useState("");
  const [audience, setAudience] = useState("");
  const [sourceFiles, setSourceFiles] = useState("");
  const [body, setBody] = useState("");

  const startEdit = () => {
    if (!data) return;
    setTitle(data.meta.title);
    setKind(data.meta.kind);
    setKeywords(data.meta.keywords.join(", "));
    setSummary(data.meta.summary);
    setAudience(data.meta.audience ?? "");
    setSourceFiles(formatFileRefs(data.meta.sourceFiles));
    setBody(data.body);
    setEditing(true);
  };

  const dirty =
    editing &&
    data !== undefined &&
    (title !== data.meta.title ||
      kind !== data.meta.kind ||
      keywords !== data.meta.keywords.join(", ") ||
      summary !== data.meta.summary ||
      audience !== (data.meta.audience ?? "") ||
      sourceFiles !== formatFileRefs(data.meta.sourceFiles) ||
      body !== data.body);

  const save = () => {
    if (!data || !title.trim()) return;
    updateKnowledge.mutate(
      {
        title: title.trim(),
        kind,
        keywords: keywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
        summary,
        audience: audience || null,
        sourceFiles: parseFileRefs(sourceFiles),
        body,
      },
      {
        onSuccess: () => {
          push("success", "entry saved");
          setEditing(false);
        },
        onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
      },
    );
  };

  useShortcuts([
    {
      keys: "e",
      description: "edit entry",
      group: "knowledge",
      run: () => !editing && startEdit(),
    },
    {
      keys: "ctrl+s",
      description: "save entry",
      group: "knowledge",
      allowInInput: true,
      run: () => editing && save(),
    },
    {
      keys: "escape",
      description: "back / stop editing",
      group: "knowledge",
      allowInInput: true,
      run: () => {
        if (editing) setEditing(false);
        else navigate({ to: "/p/$slug/knowledge", params: { slug } });
      },
    },
    {
      keys: "x",
      description: "delete entry",
      group: "knowledge",
      run: () => !editing && setConfirmDelete(true),
    },
  ]);

  if (error) {
    return (
      <div className="p-6 text-term-red">
        entry not found: {error instanceof Error ? error.message : String(error)}
      </div>
    );
  }
  if (isLoading || !data) {
    return <div className="p-6 text-term-dim">loading…</div>;
  }

  const { meta } = data;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-term-border bg-term-panel px-3 py-1.5 text-[11px]">
        {editing ? (
          <button
            type="button"
            onClick={save}
            disabled={updateKnowledge.isPending}
            className="border border-term-green/60 px-2 py-0.5 font-bold text-term-green hover:bg-term-green hover:text-term-bg disabled:opacity-50"
          >
            {updateKnowledge.isPending ? "…" : "save"}
          </button>
        ) : (
          <button
            type="button"
            onClick={startEdit}
            className="border border-term-border px-2 py-0.5 text-term-dim hover:text-term-green"
          >
            edit [e]
          </button>
        )}
        {editing && (
          <>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="border border-term-border px-2 py-0.5 text-term-dim hover:text-term-fg"
            >
              {dirty ? "discard" : "close"}
            </button>
            <button
              type="button"
              onClick={() => setVimMode((v) => !v)}
              className="border border-term-border px-2 py-0.5 text-term-dim hover:text-term-cyan"
              title="toggle vim mode"
            >
              vim: {vimMode ? "on" : "off"}
            </button>
            <span className={dirty ? "text-term-amber" : "text-term-dim"}>
              {dirty ? "● modified" : "saved"}
            </span>
          </>
        )}
        <span className="flex-1" />
        <span className="text-term-dim">
          created {relativeTime(meta.createdAt)} · updated {relativeTime(meta.updatedAt)}
        </span>
      </header>

      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="grid grid-cols-2 gap-2 border-b border-term-border px-3 py-2 lg:grid-cols-5">
            <Field label="title">
              <TextInput value={title} onChange={setTitle} />
            </Field>
            <Field label="kind">
              <SelectInput
                value={kind}
                onChange={setKind}
                options={KINDS.map((k) => ({ value: k }))}
              />
            </Field>
            <Field label="audience">
              <SelectInput
                value={audience}
                onChange={setAudience}
                options={[
                  { value: "", label: "— unspecified —" },
                  ...AUDIENCES.map((value) => ({ value })),
                ]}
              />
            </Field>
            <Field label="keywords">
              <TextInput value={keywords} onChange={setKeywords} />
            </Field>
            <Field label="summary">
              <input
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                className={inputClass}
              />
            </Field>
            <div className="col-span-2 lg:col-span-5">
              <Field label="source files" hint="one path or path#anchor per line">
                <textarea
                  value={sourceFiles}
                  onChange={(event) => setSourceFiles(event.target.value)}
                  className={`${inputClass} min-h-14 resize-y`}
                />
              </Field>
            </div>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
            <MarkdownEditor
              value={body}
              onChange={setBody}
              vimMode={vimMode}
              onSaveShortcut={save}
              className="min-h-0 overflow-auto p-2"
            />
            <div className="hidden min-h-0 overflow-auto border-l border-term-border p-4 lg:block">
              <MarkdownViewer content={body} showToc={false} />
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-4xl px-6 py-4">
            <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-term-border pb-3">
              <Badge color={kindColor(meta.kind)}>{meta.kind}</Badge>
              {meta.audience && <Badge color="blue">{meta.audience}</Badge>}
              <h1 className="text-[15px] font-bold text-term-green">{meta.title}</h1>
              <span className="flex-1" />
              {meta.keywords.map((kw) => (
                <span key={kw} className="text-[11px] text-term-dim">
                  #{kw}
                </span>
              ))}
            </div>
            {meta.summary && (
              <p className="mb-4 text-[12px] text-term-dim italic">{meta.summary}</p>
            )}
            {(meta.sourceFiles?.length ?? 0) > 0 && (
              <div className="mb-4 flex flex-wrap items-center gap-1 text-[11px]">
                <span className="text-term-dim">source:</span>
                {meta.sourceFiles?.map((f) => (
                  <code
                    key={f.path}
                    className="border border-term-border bg-term-panel px-1 text-term-cyan"
                  >
                    {f.path}
                    {f.anchor ? `#${f.anchor}` : ""}
                  </code>
                ))}
              </div>
            )}
            <MarkdownViewer
              content={data.body}
              slug={slug}
              referenceSource={{ kind: "knowledge", label: meta.title, id: meta.normalizedId }}
            />
          </div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="delete knowledge"
          message={
            <span>
              delete <span className="font-bold text-term-fg">“{meta.title}”</span>? this removes
              the .md + .meta.json files.
            </span>
          }
          confirmLabel="delete"
          onClose={() => setConfirmDelete(false)}
          onConfirm={() =>
            deleteKnowledge.mutate(meta.normalizedId, {
              onSuccess: () => {
                push("success", "entry deleted");
                navigate({ to: "/p/$slug/knowledge", params: { slug } });
              },
              onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
            })
          }
        />
      )}
    </div>
  );
}
