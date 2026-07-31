/**
 * Plan detail — document viewer/editor with a mermaid diagram tab.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { usePlan, useUpdatePlan } from "../api/hooks";
import { Badge, statusColor } from "../components/Badge";
import { Field, inputClass, SelectInput, TextInput } from "../components/Dialog";
import { MarkdownEditor } from "../components/MarkdownEditor.lazy";
import { MarkdownViewer } from "../components/MarkdownViewer";
import { MermaidDiagram } from "../components/MermaidDiagram";
import { useToaster } from "../components/Toaster";
import { useShortcuts } from "../hooks/useShortcuts";
import { formatFileRefs, parseFileRefs } from "../lib/file-refs";
import { cx, relativeTime } from "../lib/format";

const STATUSES = ["proposed", "planned", "in_progress", "blocked", "done", "archived"];

export function PlanDetail() {
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };
  const navigate = useNavigate();
  const { data, isLoading, error } = usePlan(slug, id);
  const updatePlan = useUpdatePlan(slug, id);
  const { push } = useToaster();

  const [tab, setTab] = useState<"document" | "diagram">("document");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("proposed");
  const [keywords, setKeywords] = useState("");
  const [summary, setSummary] = useState("");
  const [sourceFiles, setSourceFiles] = useState("");
  const [body, setBody] = useState("");
  const [diagram, setDiagram] = useState("");

  const startEdit = () => {
    if (!data) return;
    setTitle(data.meta.title);
    setStatus(data.meta.status);
    setKeywords(data.meta.keywords.join(", "));
    setSummary(data.meta.summary);
    setSourceFiles(formatFileRefs(data.meta.sourceFiles));
    setBody(data.body);
    setDiagram(data.diagram ?? "");
    setEditing(true);
  };

  const save = () => {
    if (!data || !title.trim()) return;
    updatePlan.mutate(
      {
        title: title.trim(),
        status,
        keywords: keywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
        summary,
        sourceFiles: parseFileRefs(sourceFiles),
        body,
        diagram: diagram.trim() ? diagram : null,
      },
      {
        onSuccess: () => {
          push("success", "plan saved");
          setEditing(false);
        },
        onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
      },
    );
  };

  useShortcuts([
    { keys: "e", description: "edit plan", group: "plans", run: () => !editing && startEdit() },
    {
      keys: "ctrl+s",
      description: "save plan",
      group: "plans",
      allowInInput: true,
      run: () => editing && save(),
    },
    {
      keys: "escape",
      description: "back / stop editing",
      group: "plans",
      allowInInput: true,
      run: () => {
        if (editing) setEditing(false);
        else navigate({ to: "/p/$slug/plans", params: { slug } });
      },
    },
    {
      keys: "1",
      description: "document tab",
      group: "plans",
      run: () => setTab("document"),
    },
    {
      keys: "2",
      description: "diagram tab",
      group: "plans",
      run: () => (data?.diagram || editing) && setTab("diagram"),
    },
  ]);

  if (error) {
    return <div className="p-6 text-term-red">plan not found</div>;
  }
  if (isLoading || !data) {
    return <div className="p-6 text-term-dim">loading…</div>;
  }

  const { meta } = data;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-term-border bg-term-panel px-3 py-1.5 text-[11px]">
        <div className="flex items-center gap-px">
          {(["document", "diagram"] as const).map((t, i) => (
            <button
              key={t}
              type="button"
              disabled={t === "diagram" && !data.diagram && !editing}
              onClick={() => setTab(t)}
              className={cx(
                "border px-2 py-0.5",
                tab === t
                  ? "border-term-green/60 font-bold text-term-green"
                  : "border-term-border text-term-dim hover:text-term-fg disabled:opacity-40",
              )}
              title={
                t === "diagram" && !data.diagram && !editing
                  ? "press edit first to create a .diagram.mmd"
                  : `press ${i + 1}`
              }
            >
              {t} [{i + 1}]
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {editing ? (
          <>
            <button
              type="button"
              onClick={save}
              disabled={updatePlan.isPending}
              className="border border-term-green/60 px-2 py-0.5 font-bold text-term-green hover:bg-term-green hover:text-term-bg disabled:opacity-50"
            >
              {updatePlan.isPending ? "…" : "save"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="border border-term-border px-2 py-0.5 text-term-dim hover:text-term-fg"
            >
              discard
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={startEdit}
            className="border border-term-border px-2 py-0.5 text-term-dim hover:text-term-green"
          >
            edit [e]
          </button>
        )}
        <span className="text-term-dim">updated {relativeTime(meta.updatedAt)}</span>
      </header>

      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="grid grid-cols-2 gap-2 border-b border-term-border px-3 py-2 md:grid-cols-4">
            <Field label="title">
              <TextInput value={title} onChange={setTitle} />
            </Field>
            <Field label="status">
              <SelectInput
                value={status}
                onChange={setStatus}
                options={STATUSES.map((s) => ({ value: s }))}
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
            <div className="col-span-2 md:col-span-4">
              <Field label="source files" hint="one path or path#anchor per line">
                <textarea
                  value={sourceFiles}
                  onChange={(event) => setSourceFiles(event.target.value)}
                  className={`${inputClass} min-h-14 resize-y`}
                />
              </Field>
            </div>
          </div>
          {tab === "document" ? (
            <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
              <MarkdownEditor
                value={body}
                onChange={setBody}
                onSaveShortcut={save}
                className="min-h-0 overflow-auto p-2"
              />
              <div className="hidden min-h-0 overflow-auto border-l border-term-border p-4 lg:block">
                <MarkdownViewer content={body} showToc={false} />
              </div>
            </div>
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
              <textarea
                value={diagram}
                onChange={(event) => setDiagram(event.target.value)}
                placeholder={"flowchart LR\n  A[Start] --> B[Done]"}
                className="min-h-0 resize-none border-0 bg-term-inset p-3 font-mono text-[12px] text-term-fg outline-none"
              />
              <div className="hidden min-h-0 overflow-auto border-l border-term-border p-4 lg:block">
                {diagram.trim() ? (
                  <MermaidDiagram chart={diagram} />
                ) : (
                  <div className="text-term-dim">enter Mermaid source to preview a diagram</div>
                )}
              </div>
            </div>
          )}
        </div>
      ) : tab === "document" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-4xl px-6 py-4">
            <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-term-border pb-3">
              <Badge color={statusColor(meta.status)}>{meta.status}</Badge>
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
                {meta.sourceFiles?.map((file) => (
                  <code
                    key={`${file.path}:${file.anchor ?? ""}`}
                    className="border border-term-border bg-term-panel px-1 text-term-cyan"
                  >
                    {file.path}
                    {file.anchor ? `#${file.anchor}` : ""}
                  </code>
                ))}
              </div>
            )}
            <MarkdownViewer content={data.body} />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {data.diagram ? (
            <MermaidDiagram chart={data.diagram} />
          ) : (
            <div className="text-term-dim">no diagram for this plan</div>
          )}
        </div>
      )}
    </div>
  );
}
