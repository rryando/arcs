/**
 * Proposals — codegraph ingestion proposal queue with promote/drop actions.
 */

import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import type { Proposal } from "../api/client";
import { useDropProposal, usePromoteProposal, useProposals } from "../api/hooks";
import { Badge, kindColor } from "../components/Badge";
import {
  ConfirmDialog,
  Dialog,
  Field,
  FormActions,
  inputClass,
  TextInput,
} from "../components/Dialog";
import { Panel } from "../components/Panel";
import { useToaster } from "../components/Toaster";
import { relativeTime, truncate } from "../lib/format";

export function ProposalsView() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { data, isLoading } = useProposals(slug);
  const dropProposal = useDropProposal(slug);
  const promoteProposal = usePromoteProposal(slug);
  const { push } = useToaster();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [promoteTarget, setPromoteTarget] = useState<Proposal | null>(null);
  const [dropTarget, setDropTarget] = useState<Proposal | null>(null);

  const proposals = data?.proposals ?? [];

  return (
    <div className="flex h-full flex-col p-3">
      <Panel
        title="codegraph proposals"
        hint={
          data?.generatedAt
            ? `${proposals.length} pending · generated ${relativeTime(data.generatedAt)}`
            : `${proposals.length} pending`
        }
        className="flex-1"
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
                      promote
                    </button>
                    <button
                      type="button"
                      onClick={() => setDropTarget(p)}
                      className="border border-term-red/50 px-2 py-0.5 text-[11px] text-term-red hover:bg-term-red hover:text-term-bg"
                    >
                      drop
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
        <PromoteDialog
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
    </div>
  );
}

function PromoteDialog({
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
      <FormActions submitLabel="promote" onSubmit={submit} onCancel={onClose} pending={pending} />
    </Dialog>
  );
}
