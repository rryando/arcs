/**
 * Knowledge list — filterable, kind-grouped table with create/delete.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import type { KnowledgeMeta } from "../api/client";
import { useCreateKnowledge, useDeleteKnowledge, useKnowledge } from "../api/hooks";
import { Badge, kindColor } from "../components/Badge";
import { type Column, DataTable } from "../components/DataTable";
import {
  ConfirmDialog,
  Dialog,
  Field,
  FormActions,
  inputClass,
  SelectInput,
  TextInput,
} from "../components/Dialog";
import { Panel } from "../components/Panel";
import { useToaster } from "../components/Toaster";
import { useShortcuts } from "../hooks/useShortcuts";
import { parseFileRefs } from "../lib/file-refs";
import { cx, relativeTime } from "../lib/format";

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

export function KnowledgeList() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  const { data, isLoading } = useKnowledge(slug);
  const createKnowledge = useCreateKnowledge(slug);
  const deleteKnowledge = useDeleteKnowledge(slug);
  const { push } = useToaster();

  const [filter, setFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeMeta | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const entries = useMemo(() => {
    let list = [...(data?.entries ?? [])];
    if (kindFilter) list = list.filter((e) => e.kind === kindFilter);
    const q = filter.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.keywords.some((k) => k.includes(q)) ||
          e.summary.toLowerCase().includes(q),
      );
    }
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return list;
  }, [data, filter, kindFilter]);

  const presentKinds = useMemo(
    () => [...new Set((data?.entries ?? []).map((e) => e.kind))].sort(),
    [data],
  );

  useShortcuts([
    {
      keys: "n",
      description: "new knowledge entry",
      group: "knowledge",
      run: () => setCreateOpen(true),
    },
    {
      keys: "f",
      description: "focus filter",
      group: "knowledge",
      run: () => filterRef.current?.focus(),
    },
  ]);

  const columns = useMemo<Column<KnowledgeMeta>[]>(
    () => [
      {
        key: "kind",
        title: "kind",
        className: "w-28",
        sortValue: (e) => e.kind,
        render: (e) => <Badge color={kindColor(e.kind)}>{e.kind}</Badge>,
      },
      {
        key: "title",
        title: "title",
        sortValue: (e) => e.title.toLowerCase(),
        render: (e) => <span className="font-bold">{e.title}</span>,
      },
      {
        key: "keywords",
        title: "keywords",
        render: (e) => <span className="text-term-dim">{e.keywords.slice(0, 5).join(" · ")}</span>,
      },
      {
        key: "updated",
        title: "updated",
        className: "w-20 text-right",
        sortValue: (e) => e.updatedAt,
        render: (e) => <span className="text-term-dim">{relativeTime(e.updatedAt)}</span>,
      },
    ],
    [],
  );

  return (
    <div className="flex h-full flex-col p-3">
      <Panel
        title="knowledge"
        hint={`${entries.length}/${data?.entries.length ?? 0} entries`}
        actions={
          <div className="flex items-center gap-2">
            <input
              ref={filterRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter… [f]"
              className="w-44 border border-term-border bg-term-inset px-2 py-0.5 text-[11px] text-term-fg outline-none focus:border-term-green/60 placeholder:text-term-dim/50"
            />
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="border border-term-green/60 px-2 py-0.5 text-[11px] font-bold text-term-green hover:bg-term-green hover:text-term-bg"
            >
              + new [n]
            </button>
          </div>
        }
      >
        <div className="flex items-center gap-1 border-b border-term-border px-2 py-1 text-[11px]">
          <FilterChip
            active={kindFilter === null}
            onClick={() => setKindFilter(null)}
            label="all"
          />
          {presentKinds.map((kind) => (
            <FilterChip
              key={kind}
              active={kindFilter === kind}
              onClick={() => setKindFilter(kindFilter === kind ? null : kind)}
              label={kind}
            />
          ))}
        </div>

        {isLoading ? (
          <div className="px-3 py-4 text-term-dim">loading…</div>
        ) : (
          <DataTable
            columns={columns}
            rows={entries}
            rowKey={(e) => e.normalizedId}
            onOpen={(e) =>
              navigate({ to: "/p/$slug/knowledge/$id", params: { slug, id: e.normalizedId } })
            }
            onDelete={(e) => setDeleteTarget(e)}
            emptyMessage={
              filter || kindFilter ? "no entries match the filter" : "no knowledge yet — press n"
            }
          />
        )}
      </Panel>

      {createOpen && (
        <CreateKnowledgeDialog
          onClose={() => setCreateOpen(false)}
          onSubmit={(input) =>
            createKnowledge.mutate(input, {
              onSuccess: (meta) => {
                push("success", `created “${meta.title}”`);
                setCreateOpen(false);
                navigate({ to: "/p/$slug/knowledge/$id", params: { slug, id: meta.normalizedId } });
              },
              onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
            })
          }
          pending={createKnowledge.isPending}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="delete knowledge"
          message={
            <span>
              delete <span className="font-bold text-term-fg">“{deleteTarget.title}”</span>? this
              removes the .md + .meta.json files.
            </span>
          }
          confirmLabel="delete"
          onClose={() => setDeleteTarget(null)}
          onConfirm={() =>
            deleteKnowledge.mutate(deleteTarget.normalizedId, {
              onSuccess: () => {
                push("success", "entry deleted");
                setDeleteTarget(null);
              },
              onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
            })
          }
        />
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "px-1.5 py-0.5 uppercase",
        active ? "bg-term-green font-bold text-term-bg" : "text-term-dim hover:text-term-fg",
      )}
    >
      {label}
    </button>
  );
}

function CreateKnowledgeDialog({
  onClose,
  onSubmit,
  pending,
}: {
  onClose: () => void;
  onSubmit: (input: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("lesson");
  const [keywords, setKeywords] = useState("");
  const [summary, setSummary] = useState("");
  const [audience, setAudience] = useState("");
  const [sourceFiles, setSourceFiles] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    onSubmit({
      id: title.trim(),
      title: title.trim(),
      kind,
      audience: audience || undefined,
      keywords: keywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
      summary: summary.trim() || undefined,
      sourceFiles: parseFileRefs(sourceFiles),
    });
  };

  return (
    <Dialog title="new knowledge entry" onClose={onClose}>
      <Field label="title" hint="also becomes the id (normalized)">
        <TextInput
          value={title}
          onChange={setTitle}
          placeholder="e.g. Bundle deploy requires lint first"
          autoFocus
          onEnter={submit}
        />
      </Field>
      <Field label="kind">
        <SelectInput value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k }))} />
      </Field>
      <Field label="audience" hint="optional">
        <SelectInput
          value={audience}
          onChange={setAudience}
          options={[
            { value: "", label: "— unspecified —" },
            ...AUDIENCES.map((value) => ({ value })),
          ]}
        />
      </Field>
      <Field label="keywords" hint="comma separated">
        <TextInput
          value={keywords}
          onChange={setKeywords}
          placeholder="deploy, bundle, lint"
          onEnter={submit}
        />
      </Field>
      <Field label="summary" hint="optional">
        <TextInput
          value={summary}
          onChange={setSummary}
          placeholder="one-line summary"
          onEnter={submit}
        />
      </Field>
      <Field label="source files" hint="one path or path#anchor per line">
        <textarea
          value={sourceFiles}
          onChange={(event) => setSourceFiles(event.target.value)}
          className={`${inputClass} min-h-16 resize-y`}
          placeholder={"src/module.ts#handler\ntest/module.test.ts"}
        />
      </Field>
      <FormActions submitLabel="create" onSubmit={submit} onCancel={onClose} pending={pending} />
    </Dialog>
  );
}
