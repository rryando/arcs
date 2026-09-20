/**
 * Proposal docs — the full design-document lifecycle from the data dir's
 * proposals/ plane: pending drafts (editable, promotable) and accepted docs
 * (read-only, kept visible instead of hidden behind a count). Creation stays
 * CLI/skill-driven; accepted docs are reached through the same detail route.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { ProposalDoc } from "../api/client";
import {
  qk,
  usePromoteProposalDoc,
  useProposalDoc,
  useProposalDocs,
  useSaveProposalDoc,
} from "../api/hooks";
import { useRunStream } from "../api/sse";
import { Badge, statusColor } from "../components/Badge";
import { type Column, DataTable } from "../components/DataTable";
import { ConfirmDialog } from "../components/Dialog";
import { MarkdownEditor } from "../components/MarkdownEditor.lazy";
import { MarkdownViewer } from "../components/MarkdownViewer";
import { Panel } from "../components/Panel";
import { useToaster } from "../components/Toaster";
import { useShortcuts } from "../hooks/useShortcuts";
import { cx, relativeTime } from "../lib/format";

const STATUS_FILTERS = ["pending", "accepted"] as const;

export function ProposalDocsList() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  const { data, isLoading } = useProposalDocs(slug);
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number] | null>(null);

  const docs = useMemo(() => {
    const list = data?.proposalDocs ?? [];
    const filtered = statusFilter ? list.filter((d) => d.status === statusFilter) : list;
    return [...filtered].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }, [data, statusFilter]);

  const columns = useMemo<Column<ProposalDoc>[]>(
    () => [
      {
        key: "status",
        title: "status",
        className: "w-28",
        render: (d) => <Badge color={statusColor(d.status)}>{d.status}</Badge>,
      },
      {
        key: "title",
        title: "proposal",
        sortValue: (d) => d.title.toLowerCase(),
        render: (d) => <span className="font-bold">{d.title}</span>,
      },
      {
        key: "updated",
        title: "updated",
        className: "w-20 text-right",
        sortValue: (d) => d.updatedAt ?? "",
        render: (d) => <span className="text-term-dim">{relativeTime(d.updatedAt)}</span>,
      },
    ],
    [],
  );

  return (
    <div className="flex h-full flex-col p-3">
      <Panel
        title="proposal docs"
        hint={
          data ? `${data.counts.pending} pending · ${data.counts.accepted} accepted` : undefined
        }
      >
        <div className="flex items-center gap-1 border-b border-term-border px-2 py-1 text-[11px]">
          <StatusChip
            active={statusFilter === null}
            onClick={() => setStatusFilter(null)}
            label={`all ${(data?.proposalDocs ?? []).length}`}
          />
          {STATUS_FILTERS.map((s) => (
            <StatusChip
              key={s}
              active={statusFilter === s}
              onClick={() => setStatusFilter(statusFilter === s ? null : s)}
              label={`${s} ${data?.counts[s] ?? 0}`}
            />
          ))}
          <span className="flex-1" />
          <span className="text-term-dim">accepted docs open read-only</span>
        </div>
        {isLoading ? (
          <div className="px-3 py-4 text-term-dim">loading…</div>
        ) : (
          <DataTable
            columns={columns}
            rows={docs}
            rowKey={(d) => d.id}
            onOpen={(d) =>
              navigate({ to: "/p/$slug/proposal-docs/$id", params: { slug, id: d.id } })
            }
            emptyMessage={
              statusFilter
                ? `no ${statusFilter} proposal docs`
                : "no proposal docs yet — drafts start with arcs proposal-doc create"
            }
          />
        )}
      </Panel>
    </div>
  );
}

/** Status filter pill, mirroring the tasks view's chip row. */
function StatusChip({
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
        "px-1.5 py-0.5",
        active ? "bg-term-green font-bold text-term-bg" : "text-term-dim hover:text-term-fg",
      )}
    >
      {label}
    </button>
  );
}

export function ProposalDocDetail() {
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };
  const navigate = useNavigate();
  const { data, isLoading, error } = useProposalDoc(slug, id);
  const saveDoc = useSaveProposalDoc(slug, id);
  const promoteDoc = usePromoteProposalDoc(slug);
  const queryClient = useQueryClient();
  const { push } = useToaster();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [promoteOpen, setPromoteOpen] = useState(false);
  /** The run a promote started, tailed only to learn when it settles. */
  const [promoteRunId, setPromoteRunId] = useState<string | null>(null);
  const promoteRun = useRunStream(slug, promoteRunId);

  // The promotion is no longer synchronous: the server starts a `pi` run that
  // renames the doc and builds the plan + tasks. When that run settles its
  // writes are on disk, so refetch the surfaces that name them.
  useEffect(() => {
    if (promoteRunId === null || promoteRun.status !== "ended") return;
    void queryClient.invalidateQueries({ queryKey: qk.proposalDocs(slug) });
    void queryClient.invalidateQueries({ queryKey: qk.plans(slug) });
    setPromoteRunId(null);
  }, [promoteRunId, promoteRun.status, queryClient, slug]);

  const startEdit = () => {
    if (!data) return;
    setDraft(data.body);
    setEditing(true);
  };

  const save = () => {
    saveDoc.mutate(draft, {
      onSuccess: () => {
        push("success", "proposal doc saved");
        setEditing(false);
      },
      onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
    });
  };

  const promote = () => {
    promoteDoc.mutate(id, {
      onSuccess: (result) => {
        // No plan exists yet — a run was started to produce it. Name the run
        // and refresh once it settles instead of navigating to a plan.
        push(
          "success",
          `promotion run started (${result.runId.slice(0, 8)}) — the plan appears when it finishes`,
        );
        setPromoteOpen(false);
        setPromoteRunId(result.runId);
      },
      onError: (err) => {
        push("error", err instanceof Error ? err.message : String(err));
        setPromoteOpen(false);
      },
    });
  };

  useShortcuts([
    {
      keys: "e",
      description: "edit proposal doc",
      group: "proposal docs",
      run: () => data?.status === "pending" && !editing && startEdit(),
    },
    {
      keys: "ctrl+s",
      description: "save proposal doc",
      group: "proposal docs",
      allowInInput: true,
      run: () => editing && save(),
    },
    {
      keys: "escape",
      description: "back / stop editing",
      group: "proposal docs",
      allowInInput: true,
      run: () => {
        if (editing) setEditing(false);
        else navigate({ to: "/p/$slug/proposal-docs", params: { slug } });
      },
    },
  ]);

  if (error) {
    return <div className="p-6 text-term-red">proposal doc not found</div>;
  }
  if (isLoading || !data) {
    return <div className="p-6 text-term-dim">loading…</div>;
  }

  const accepted = data.status === "accepted";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-term-border bg-term-panel px-3 py-1.5 text-[11px]">
        <Badge color={statusColor(data.status)}>{data.status}</Badge>
        <span className="font-bold text-term-green">{data.title}</span>
        <span className="flex-1" />
        {editing ? (
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
              onClick={() => setEditing(false)}
              className="border border-term-border px-2 py-0.5 text-term-dim hover:text-term-fg"
            >
              cancel
            </button>
          </>
        ) : (
          <>
            {!accepted && (
              <>
                <button
                  type="button"
                  onClick={startEdit}
                  className="border border-term-border px-2 py-0.5 text-term-dim hover:text-term-green"
                >
                  edit [e]
                </button>
                <button
                  type="button"
                  onClick={() => setPromoteOpen(true)}
                  className="border border-term-green/60 px-2 py-0.5 font-bold text-term-green hover:bg-term-green hover:text-term-bg"
                >
                  promote
                </button>
              </>
            )}
            {accepted && <span className="text-term-dim">accepted docs are read-only</span>}
          </>
        )}
        <span className="text-term-dim">updated {relativeTime(data.updatedAt)}</span>
      </header>

      {editing ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            onSaveShortcut={save}
            className="min-h-0 overflow-auto p-2"
          />
          <div className="hidden min-h-0 overflow-auto border-l border-term-border p-4 lg:block">
            <MarkdownViewer content={draft} showToc={false} />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-4xl px-6 py-4">
            <MarkdownViewer content={data.body} slug={slug} />
          </div>
        </div>
      )}

      {promoteOpen && (
        <ConfirmDialog
          title="promote proposal doc"
          message={
            <span>
              promote <span className="font-bold text-term-fg">“{data.title}”</span> to a plan? a pi
              run will accept the doc, create the plan and its tasks, then validate — this page
              refreshes when it finishes.
            </span>
          }
          confirmLabel="promote"
          danger={false}
          onClose={() => setPromoteOpen(false)}
          onConfirm={() => promote()}
        />
      )}
    </div>
  );
}
