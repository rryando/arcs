/**
 * Tasks view — topologically ordered task table with inline status cycling,
 * create/edit dialogs (including dependsOn edges with cycle validation
 * surfaced from the server), and delete.
 */

import { useParams } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import type { TaskMeta } from "../api/client";
import { useCreateTask, useDeleteTask, usePlans, useTasks, useUpdateTask } from "../api/hooks";
import { Badge, priorityColor } from "../components/Badge";
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
import { LinkedSessions } from "../components/SessionLinkModal";
import { useToaster } from "../components/Toaster";
import { useShortcuts } from "../hooks/useShortcuts";
import { formatFileRefs, parseFileRefs } from "../lib/file-refs";
import { cx, relativeTime, truncate } from "../lib/format";

const STATUSES = ["backlog", "in_progress", "done", "cancelled"];
const PRIORITIES = ["critical", "high", "medium", "low"];
const STATUS_GLYPH: Record<string, string> = {
  backlog: "[ ]",
  in_progress: "[/]",
  done: "[x]",
  cancelled: "[~]",
};

const STATUS_TEXT_CLASS: Record<string, string> = {
  backlog: "text-term-dim",
  planned: "text-term-purple",
  in_progress: "text-term-amber",
  blocked: "text-term-red",
  done: "text-term-green",
  cancelled: "text-term-orange",
  archived: "text-term-lime",
};

function nextStatus(current: string): string {
  const i = STATUSES.indexOf(current);
  return STATUSES[(i + 1) % STATUSES.length] ?? "backlog";
}

export function TasksView() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { data, isLoading } = useTasks(slug);
  const { data: plansData } = usePlans(slug);
  const createTask = useCreateTask(slug);
  const updateTask = useUpdateTask(slug);
  const deleteTask = useDeleteTask(slug);
  const { push } = useToaster();

  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<TaskMeta | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskMeta | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const ordered = useMemo(() => {
    const tasks = data?.tasks ?? [];
    const order = data?.order;
    let list = tasks;
    if (order) {
      const rank = new Map(order.map((id, i) => [id, i]));
      list = [...tasks].sort(
        (a, b) => (rank.get(a.normalizedId) ?? 9e9) - (rank.get(b.normalizedId) ?? 9e9),
      );
    }
    if (statusFilter) list = list.filter((t) => t.status === statusFilter);
    const q = filter.trim().toLowerCase();
    if (q)
      list = list.filter((t) => t.title.toLowerCase().includes(q) || t.normalizedId.includes(q));
    return list;
  }, [data, filter, statusFilter]);

  const onError = (err: unknown) => push("error", err instanceof Error ? err.message : String(err));

  const cycleStatus = (task: TaskMeta) => {
    updateTask.mutate(
      { id: task.normalizedId, input: { status: nextStatus(task.status) } },
      {
        onSuccess: (updated) =>
          push("info", `${STATUS_GLYPH[updated.status]} ${truncate(updated.title, 40)}`),
        onError,
      },
    );
  };

  useShortcuts([
    { keys: "n", description: "new task", group: "tasks", run: () => setCreateOpen(true) },
    {
      keys: "f",
      description: "focus filter",
      group: "tasks",
      run: () => filterRef.current?.focus(),
    },
  ]);

  const planTitle = useMemo(() => {
    const map = new Map((plansData?.plans ?? []).map((p) => [p.normalizedId, p.title]));
    return (planId?: string) => (planId ? truncate(map.get(planId) ?? planId, 24) : "—");
  }, [plansData]);

  const columns = useMemo<Column<TaskMeta>[]>(
    () => [
      {
        key: "status",
        title: "",
        className: "w-14",
        sortValue: (t) => STATUSES.indexOf(t.status),
        render: (t) => (
          <span className={cx("font-bold", STATUS_TEXT_CLASS[t.status] ?? "text-term-dim")}>
            {STATUS_GLYPH[t.status] ?? t.status}
          </span>
        ),
      },
      {
        key: "priority",
        title: "pri",
        className: "w-20",
        sortValue: (t) => PRIORITIES.indexOf(t.priority),
        render: (t) => <Badge color={priorityColor(t.priority)}>{t.priority}</Badge>,
      },
      {
        key: "title",
        title: "task",
        sortValue: (t) => t.title.toLowerCase(),
        render: (t) => (
          <span>
            <span className={t.status === "done" ? "text-term-dim line-through" : "font-bold"}>
              {t.title}
            </span>
            {(t.verify || t.skill || t.workMode) && (
              <span
                className="ml-2 text-term-dim"
                title={[t.verify && `verify: ${t.verify}`, t.skill && `skill: ${t.skill}`]
                  .filter(Boolean)
                  .join("\n")}
              >
                {t.verify ? "⚗" : ""}
                {t.skill ? "⧉" : ""}
                {t.workMode ? ` ${t.workMode}` : ""}
              </span>
            )}
          </span>
        ),
      },
      {
        key: "deps",
        title: "blocked by",
        render: (t) =>
          t.dependsOn?.length ? (
            <span className="text-term-magenta">
              {t.dependsOn.map((d) => truncate(d, 18)).join(", ")}
            </span>
          ) : (
            <span className="text-term-dim">—</span>
          ),
      },
      {
        key: "plan",
        title: "plan",
        render: (t) => <span className="text-term-amber">{planTitle(t.planId)}</span>,
      },
      {
        key: "updated",
        title: "updated",
        className: "w-20 text-right",
        sortValue: (t) => t.updatedAt,
        render: (t) => <span className="text-term-dim">{relativeTime(t.updatedAt)}</span>,
      },
    ],
    [planTitle],
  );

  return (
    <div className="flex h-full flex-col p-3">
      <Panel
        title="tasks"
        hint={`${ordered.length}/${data?.tasks.length ?? 0} · topological order`}
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
          <StatusChip
            active={statusFilter === null}
            onClick={() => setStatusFilter(null)}
            label="all"
          />
          {STATUSES.map((s) => (
            <StatusChip
              key={s}
              active={statusFilter === s}
              onClick={() => setStatusFilter(statusFilter === s ? null : s)}
              label={`${STATUS_GLYPH[s]} ${s}`}
            />
          ))}
          <span className="flex-1" />
          <span className="text-term-dim">
            <span className="kbd">s</span> cycle status · <span className="kbd">e</span> edit ·{" "}
            <span className="kbd">x</span> delete
          </span>
        </div>

        {isLoading ? (
          <div className="px-3 py-4 text-term-dim">loading…</div>
        ) : (
          <DataTable
            columns={columns}
            rows={ordered}
            rowKey={(t) => t.normalizedId}
            onOpen={(t) => setEditTarget(t)}
            onDelete={(t) => setDeleteTarget(t)}
            rowActions={[
              { keys: "s", description: "cycle status", run: cycleStatus },
              { keys: "e", description: "edit task", run: (t) => setEditTarget(t) },
            ]}
            emptyMessage="no tasks — press n"
          />
        )}
      </Panel>

      {createOpen && (
        <TaskFormDialog
          title="new task"
          slug={slug}
          existingTasks={data?.tasks ?? []}
          planOptions={(plansData?.plans ?? []).map((p) => ({
            value: p.normalizedId,
            label: p.title,
          }))}
          pending={createTask.isPending}
          onClose={() => setCreateOpen(false)}
          onSubmit={(input) =>
            createTask.mutate(input, {
              onSuccess: () => {
                push("success", "task created");
                setCreateOpen(false);
              },
              onError,
            })
          }
        />
      )}

      {editTarget && (
        <TaskFormDialog
          title={`edit — ${truncate(editTarget.title, 40)}`}
          slug={slug}
          existingTasks={(data?.tasks ?? []).filter(
            (t) => t.normalizedId !== editTarget.normalizedId,
          )}
          planOptions={(plansData?.plans ?? []).map((p) => ({
            value: p.normalizedId,
            label: p.title,
          }))}
          initial={editTarget}
          pending={updateTask.isPending}
          onClose={() => setEditTarget(null)}
          onSubmit={(input) =>
            updateTask.mutate(
              { id: editTarget.normalizedId, input },
              {
                onSuccess: () => {
                  push("success", "task updated");
                  setEditTarget(null);
                },
                onError,
              },
            )
          }
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="delete task"
          message={
            <span>
              delete <span className="font-bold text-term-fg">“{deleteTarget.title}”</span>?
            </span>
          }
          confirmLabel="delete"
          onClose={() => setDeleteTarget(null)}
          onConfirm={() =>
            deleteTask.mutate(deleteTarget.normalizedId, {
              onSuccess: () => {
                push("success", "task deleted");
                setDeleteTarget(null);
              },
              onError,
            })
          }
        />
      )}
    </div>
  );
}

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

// ---------------------------------------------------------------------------
// Create/edit dialog
// ---------------------------------------------------------------------------

function TaskFormDialog({
  title,
  slug,
  existingTasks,
  planOptions,
  initial,
  pending,
  onClose,
  onSubmit,
}: {
  title: string;
  slug: string;
  existingTasks: TaskMeta[];
  planOptions: Array<{ value: string; label: string }>;
  initial?: TaskMeta;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: Record<string, unknown>) => void;
}) {
  const [taskTitle, setTaskTitle] = useState(initial?.title ?? "");
  const [status, setStatus] = useState(initial?.status ?? "backlog");
  const [priority, setPriority] = useState(initial?.priority ?? "medium");
  const [planId, setPlanId] = useState(initial?.planId ?? "");
  const [dependsOn, setDependsOn] = useState((initial?.dependsOn ?? []).join(", "));
  const [scope, setScope] = useState(initial?.scope ?? "");
  const [acceptance, setAcceptance] = useState(initial?.acceptance ?? "");
  const [verify, setVerify] = useState(initial?.verify ?? "");
  const [skill, setSkill] = useState(initial?.skill ?? "");
  const [workMode, setWorkMode] = useState(initial?.workMode ?? "");
  const [sourceFiles, setSourceFiles] = useState(formatFileRefs(initial?.sourceFiles));

  const submit = () => {
    if (!taskTitle.trim()) return;
    const deps = dependsOn
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    const input: Record<string, unknown> = {
      title: taskTitle.trim(),
      status,
      priority,
      planId: planId || (initial ? null : undefined),
      dependsOn: deps.length > 0 ? deps : initial ? null : undefined,
      scope: scope || (initial ? null : undefined),
      acceptance: acceptance || (initial ? null : undefined),
      verify: verify || (initial ? null : undefined),
      skill: skill || (initial ? null : undefined),
      workMode: workMode || (initial ? null : undefined),
      sourceFiles: parseFileRefs(sourceFiles),
    };
    onSubmit(input);
  };

  const knownIds = new Set(existingTasks.map((t) => t.normalizedId));
  const unknownDeps = dependsOn
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d && !knownIds.has(d));

  return (
    <Dialog title={title} onClose={onClose} width="max-w-2xl">
      <div className="grid grid-cols-2 gap-x-3">
        <div className="col-span-2">
          <Field label="title">
            <TextInput value={taskTitle} onChange={setTaskTitle} autoFocus onEnter={submit} />
          </Field>
        </div>
        <Field label="status">
          <SelectInput
            value={status}
            onChange={setStatus}
            options={STATUSES.map((s) => ({ value: s, label: `${STATUS_GLYPH[s]} ${s}` }))}
          />
        </Field>
        <Field label="priority">
          <SelectInput
            value={priority}
            onChange={setPriority}
            options={PRIORITIES.map((p) => ({ value: p }))}
          />
        </Field>
        <Field label="plan">
          <SelectInput
            value={planId}
            onChange={setPlanId}
            options={[{ value: "", label: "— none —" }, ...planOptions]}
          />
        </Field>
        <Field label="depends on" hint="comma-separated task ids">
          <TextInput
            value={dependsOn}
            onChange={setDependsOn}
            placeholder={existingTasks[0]?.normalizedId ?? "task-id"}
            onEnter={submit}
          />
        </Field>
      </div>
      {unknownDeps.length > 0 && (
        <div className="mb-2 border border-term-amber/40 px-2 py-1 text-[11px] text-term-amber">
          unknown id(s): {unknownDeps.join(", ")} — the server will reject these
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-3">
        <Field label="scope" hint="optional">
          <input
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className={inputClass}
            placeholder="src/web/**"
          />
        </Field>
        <Field label="verify command" hint="optional">
          <input
            value={verify}
            onChange={(e) => setVerify(e.target.value)}
            className={inputClass}
            placeholder="npm test"
          />
        </Field>
        <Field label="acceptance" hint="optional">
          <input
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="skill" hint="optional">
          <input
            value={skill}
            onChange={(e) => setSkill(e.target.value)}
            className={inputClass}
            placeholder="quick-dev"
          />
        </Field>
        <Field label="work mode" hint="optional">
          <SelectInput
            value={workMode}
            onChange={setWorkMode}
            options={[
              { value: "", label: "— unspecified —" },
              { value: "bounded" },
              { value: "inspect" },
            ]}
          />
        </Field>
        <div className="col-span-2">
          <Field label="source files" hint="one path or path#anchor per line">
            <textarea
              value={sourceFiles}
              onChange={(event) => setSourceFiles(event.target.value)}
              className={`${inputClass} min-h-16 resize-y`}
              placeholder={"src/module.ts#handler\ntest/module.test.ts"}
            />
          </Field>
        </div>
      </div>
      {initial && <LinkedSessions slug={slug} nodeType="task" nodeId={initial.normalizedId} />}
      <FormActions
        submitLabel={initial ? "save" : "create"}
        onSubmit={submit}
        onCancel={onClose}
        pending={pending}
      />
    </Dialog>
  );
}
