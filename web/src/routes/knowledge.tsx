/**
 * Knowledge list — filterable, kind-grouped table with create/delete, plus
 * the codegraph proposal queue (promote-to-knowledge / drop) as a section
 * beneath the knowledge table.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import type { KnowledgeMeta, Proposal } from "../api/client";
import {
  useCreateKnowledge,
  useDeleteKnowledge,
  useDropProposal,
  useKnowledge,
  usePromoteProposal,
  useProposals,
} from "../api/hooks";
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
import { cx, relativeTime, truncate } from "../lib/format";

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
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      <Panel
        title="knowledge"
        hint={`${entries.length}/${data?.entries.length ?? 0} entries`}
        className="shrink-0"
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

      <CodegraphProposalsSection slug={slug} />

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

// ---------------------------------------------------------------------------
// Codegraph proposal queue — the structural-ingestion queue, hosted beneath
// the knowledge table (the standalone proposals tab is gone).
// ---------------------------------------------------------------------------

function CodegraphProposalsSection({ slug }: { slug: string }) {
  const { data, isLoading } = useProposals(slug);
  const dropProposal = useDropProposal(slug);
  const promoteProposal = usePromoteProposal(slug);
  const { push } = useToaster();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [promoteTarget, setPromoteTarget] = useState<Proposal | null>(null);
  const [dropTarget, setDropTarget] = useState<Proposal | null>(null);

  const proposals = data?.proposals ?? [];

  return (
    <>
      <Panel
        title="codegraph proposals"
        hint={
          data?.generatedAt
            ? `${proposals.length} pending · generated ${relativeTime(data.generatedAt)}`
            : `${proposals.length} pending`
        }
        className="shrink-0"
      >
        <div className="border-b border-term-border px-3 py-1.5 text-[11px] text-term-dim">
          structural knowledge proposed by codegraph ingestion — curate before promoting into the
          knowledge base.
        </div>

        {isLoading ? (
          <div className="px-3 py-4 text-term-dim">loading…</div>
        ) : proposals.length === 0 ? (
          <div className="px-3 py-6 text-center text-term-dim">
            <span className="text-term-border-hi">∅</span> queue empty — run{" "}
            <code className="text-term-amber">arcs codegraph-sync</code> to generate proposals
          </div>
        ) : (
          <div className="divide-y divide-term-border/40">
            {proposals.map((p) => {
              const isOpen = expanded === p.id;
              return (
                <div key={p.id} className="px-3 py-1.5">
                  <div className="flex items-center gap-2 text-[12px]">
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : p.id)}
                      className="text-term-green"
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                    <Badge color={kindColor(p.kind)}>{p.kind}</Badge>
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : p.id)}
                      className="min-w-0 flex-1 truncate text-left font-bold text-term-fg hover:text-term-green"
                    >
                      {p.label}
                    </button>
                    <span className="text-[10px] text-term-dim">
                      {p.sourceFiles.length} file{p.sourceFiles.length === 1 ? "" : "s"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPromoteTarget(p)}
                      className="border border-term-green/60 px-2 py-0.5 text-[11px] font-bold text-term-green hover:bg-term-green hover:text-term-bg"
                    >
                      promote to knowledge
                    </button>
                    <button
                      type="button"
                      onClick={() => setDropTarget(p)}
                      className="border border-term-red/50 px-2 py-0.5 text-[11px] text-term-red hover:bg-term-red hover:text-term-bg"
                    >
                      drop proposal
                    </button>
                  </div>

                  {isOpen && (
                    <div className="mt-2 ml-6 flex flex-col gap-2">
                      <div>
                        <div className="mb-0.5 text-[10px] tracking-wide text-term-dim uppercase">
                          structural facts
                        </div>
                        <pre className="max-h-48 overflow-auto border border-term-border bg-term-inset p-2 text-[11px] text-term-fg">
                          {JSON.stringify(p.structuralFacts, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <div className="mb-0.5 text-[10px] tracking-wide text-term-dim uppercase">
                          source files
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {p.sourceFiles.map((f) => (
                            <code
                              key={f.path}
                              className="border border-term-border bg-term-panel px-1 text-[11px] text-term-cyan"
                            >
                              {truncate(f.path, 48)}
                            </code>
                          ))}
                        </div>
                      </div>
                      {p.suggestedDedupCandidates.length > 0 && (
                        <div className="text-[11px] text-term-amber">
                          possible duplicates:{" "}
                          {p.suggestedDedupCandidates.map((d) => truncate(d.id, 32)).join(", ")}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {promoteTarget && (
        <PromoteProposalDialog
          proposal={promoteTarget}
          pending={promoteProposal.isPending}
          onClose={() => setPromoteTarget(null)}
          onSubmit={(input) =>
            promoteProposal.mutate(
              { id: promoteTarget.id, input },
              {
                onSuccess: () => {
                  push("success", `promoted “${promoteTarget.label}” to knowledge`);
                  setPromoteTarget(null);
                },
                onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
              },
            )
          }
        />
      )}

      {dropTarget && (
        <ConfirmDialog
          title="drop proposal"
          message={
            <span>
              drop proposal <span className="font-bold text-term-fg">“{dropTarget.label}”</span>? it
              will be re-proposed on the next codegraph sync unless the graph changes.
            </span>
          }
          confirmLabel="drop"
          onClose={() => setDropTarget(null)}
          onConfirm={() =>
            dropProposal.mutate(dropTarget.id, {
              onSuccess: () => {
                push("success", "proposal dropped");
                setDropTarget(null);
              },
              onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
            })
          }
        />
      )}
    </>
  );
}

function PromoteProposalDialog({
  proposal,
  pending,
  onClose,
  onSubmit,
}: {
  proposal: Proposal;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: Record<string, unknown>) => void;
}) {
  const [title, setTitle] = useState(proposal.label);
  const [keywords, setKeywords] = useState("");
  const [summary, setSummary] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      keywords: keywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
      summary: summary.trim() || undefined,
    });
  };

  return (
    <Dialog title={`promote — ${truncate(proposal.label, 40)}`} onClose={onClose} width="max-w-xl">
      <div className="mb-3 text-[11px] text-term-dim">
        creates a <Badge color={kindColor(proposal.kind)}>{proposal.kind}</Badge> knowledge entry
        from this proposal; the body is generated from the structural facts.
      </div>
      <Field label="title">
        <TextInput value={title} onChange={setTitle} autoFocus onEnter={submit} />
      </Field>
      <Field label="keywords" hint="comma separated">
        <TextInput
          value={keywords}
          onChange={setKeywords}
          onEnter={submit}
          placeholder="codegraph, structure"
        />
      </Field>
      <Field label="summary" hint="optional">
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          className={inputClass}
        />
      </Field>
      <FormActions
        submitLabel="promote to knowledge"
        onSubmit={submit}
        onCancel={onClose}
        pending={pending}
      />
    </Dialog>
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
