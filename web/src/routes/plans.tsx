/**
 * Plans list — status-grouped table with create/delete.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { PlanMeta } from "../api/client";
import { useCreatePlan, useDeletePlan, usePlans, useTasks } from "../api/hooks";
import { Badge, statusColor } from "../components/Badge";
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
import { relativeTime } from "../lib/format";

const STATUSES = ["proposed", "planned", "in_progress", "blocked", "done", "archived"];

export function PlansList() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  const { data, isLoading } = usePlans(slug);
  const { data: tasksData } = useTasks(slug);
  const createPlan = useCreatePlan(slug);
  const deletePlan = useDeletePlan(slug);
  const { push } = useToaster();

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PlanMeta | null>(null);

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

  const plans = useMemo(
    () => [...(data?.plans ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [data],
  );

  useShortcuts([
    { keys: "n", description: "new plan", group: "plans", run: () => setCreateOpen(true) },
  ]);

  const columns = useMemo<Column<PlanMeta>[]>(
    () => [
      {
        key: "status",
        title: "status",
        className: "w-28",
        sortValue: (p) => STATUSES.indexOf(p.status),
        render: (p) => <Badge color={statusColor(p.status)}>{p.status}</Badge>,
      },
      {
        key: "title",
        title: "plan",
        sortValue: (p) => p.title.toLowerCase(),
        render: (p) => <span className="font-bold">{p.title}</span>,
      },
      {
        key: "tasks",
        title: "tasks",
        className: "w-24",
        render: (p) => {
          const roll = taskRollup.get(p.normalizedId);
          if (!roll) return <span className="text-term-dim">—</span>;
          const pct = roll.total === 0 ? 0 : Math.round((roll.done / roll.total) * 100);
          return (
            <span className={pct === 100 ? "text-term-green" : "text-term-cyan"}>
              {roll.done}/{roll.total} <span className="text-term-dim">({pct}%)</span>
            </span>
          );
        },
      },
      {
        key: "keywords",
        title: "keywords",
        render: (p) => <span className="text-term-dim">{p.keywords.slice(0, 5).join(" · ")}</span>,
      },
      {
        key: "updated",
        title: "updated",
        className: "w-20 text-right",
        sortValue: (p) => p.updatedAt,
        render: (p) => <span className="text-term-dim">{relativeTime(p.updatedAt)}</span>,
      },
    ],
    [taskRollup],
  );

  return (
    <div className="flex h-full flex-col p-3">
      <Panel
        title="plans"
        hint={`${plans.length} total`}
        actions={
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="border border-term-green/60 px-2 py-0.5 text-[11px] font-bold text-term-green hover:bg-term-green hover:text-term-bg"
          >
            + new [n]
          </button>
        }
      >
        {isLoading ? (
          <div className="px-3 py-4 text-term-dim">loading…</div>
        ) : (
          <DataTable
            columns={columns}
            rows={plans}
            rowKey={(p) => p.normalizedId}
            onOpen={(p) =>
              navigate({ to: "/p/$slug/plans/$id", params: { slug, id: p.normalizedId } })
            }
            onDelete={(p) => setDeleteTarget(p)}
            emptyMessage="no plans — press n"
          />
        )}
      </Panel>

      {createOpen && (
        <CreatePlanDialog
          onClose={() => setCreateOpen(false)}
          pending={createPlan.isPending}
          onSubmit={(input) =>
            createPlan.mutate(input, {
              onSuccess: (meta) => {
                push("success", `plan “${meta.title}” created`);
                setCreateOpen(false);
                navigate({ to: "/p/$slug/plans/$id", params: { slug, id: meta.normalizedId } });
              },
              onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
            })
          }
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="delete plan"
          message={
            <span>
              delete plan <span className="font-bold text-term-fg">“{deleteTarget.title}”</span>?
              tasks keep their planId but it will dangle.
            </span>
          }
          confirmLabel="delete"
          onClose={() => setDeleteTarget(null)}
          onConfirm={() =>
            deletePlan.mutate(deleteTarget.normalizedId, {
              onSuccess: () => {
                push("success", "plan deleted");
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

function CreatePlanDialog({
  onClose,
  onSubmit,
  pending,
}: {
  onClose: () => void;
  onSubmit: (input: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("proposed");
  const [keywords, setKeywords] = useState("");
  const [summary, setSummary] = useState("");
  const [sourceFiles, setSourceFiles] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    onSubmit({
      id: title.trim(),
      title: title.trim(),
      status,
      keywords: keywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
      summary: summary.trim() || undefined,
      sourceFiles: parseFileRefs(sourceFiles),
    });
  };

  return (
    <Dialog title="new plan" onClose={onClose}>
      <Field label="title" hint="also becomes the id (normalized)">
        <TextInput
          value={title}
          onChange={setTitle}
          autoFocus
          onEnter={submit}
          placeholder="e.g. Web UI for ARCS data"
        />
      </Field>
      <Field label="status">
        <SelectInput
          value={status}
          onChange={setStatus}
          options={STATUSES.map((s) => ({ value: s }))}
        />
      </Field>
      <Field label="keywords" hint="comma separated">
        <TextInput
          value={keywords}
          onChange={setKeywords}
          onEnter={submit}
          placeholder="web, ui, kb"
        />
      </Field>
      <Field label="summary" hint="optional">
        <TextInput value={summary} onChange={setSummary} onEnter={submit} />
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
