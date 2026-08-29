/**
 * Proposal docs — pending design documents from the data dir's proposals/
 * plane, with edit (PUT) and promote-to-plan. Creation stays CLI/skill-driven;
 * accepted docs are read-only and reachable only via direct navigation.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ProposalDoc } from "../api/client";
import {
  usePromoteProposalDoc,
  useProposalDoc,
  useProposalDocs,
  useSaveProposalDoc,
} from "../api/hooks";
import { Badge, statusColor } from "../components/Badge";
import { type Column, DataTable } from "../components/DataTable";
import { ConfirmDialog } from "../components/Dialog";
import { MarkdownEditor } from "../components/MarkdownEditor.lazy";
import { MarkdownViewer } from "../components/MarkdownViewer";
import { Panel } from "../components/Panel";
import { useToaster } from "../components/Toaster";
import { useShortcuts } from "../hooks/useShortcuts";
import { relativeTime } from "../lib/format";

export function ProposalDocsList() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  const { data, isLoading } = useProposalDocs(slug);

  const docs = useMemo(
    () =>
      [...(data?.proposalDocs ?? [])].sort((a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
      ),
    [data],
  );

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
            emptyMessage="no pending proposal docs — drafts start with arcs proposal-doc create"
          />
        )}
      </Panel>
    </div>
  );
}

export function ProposalDocDetail() {
  const { slug, id } = useParams({ strict: false }) as { slug: string; id: string };
  const navigate = useNavigate();
  const { data, isLoading, error } = useProposalDoc(slug, id);
  const saveDoc = useSaveProposalDoc(slug, id);
  const promoteDoc = usePromoteProposalDoc(slug);
  const { push } = useToaster();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [promoteOpen, setPromoteOpen] = useState(false);

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
        push("success", `promoted to plan “${result.plan.title}”`);
        setPromoteOpen(false);
        navigate({ to: "/p/$slug/plans/$id", params: { slug, id: result.plan.normalizedId } });
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
              promote <span className="font-bold text-term-fg">“{data.title}”</span> to a plan? the
              doc moves to proposals/ as accepted and its body becomes the plan content.
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
