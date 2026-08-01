/**
 * Dashboard — all projects with totals strip and the cross-project DAG.
 */

import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useMemo } from "react";
import type { ProjectSummary } from "../api/client";
import { useProjects, useRootGraph } from "../api/hooks";
import { Badge, statusColor } from "../components/Badge";
import { type Column, DataTable } from "../components/DataTable";
import { Panel } from "../components/Panel";
import { relativeTime } from "../lib/format";

const GraphCanvas = lazy(() =>
  import("../components/GraphCanvas").then((m) => ({ default: m.GraphCanvas })),
);

export function Dashboard() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useProjects();
  const { data: rootGraph } = useRootGraph();

  const projects = useMemo(() => data?.projects ?? [], [data]);

  const totals = useMemo(
    () =>
      projects.reduce(
        (acc, p) => ({
          knowledge: acc.knowledge + p.counts.knowledge,
          tasks: acc.tasks + p.counts.tasks,
          plans: acc.plans + p.counts.plans,
          proposals: acc.proposals + p.counts.proposals,
        }),
        { knowledge: 0, tasks: 0, plans: 0, proposals: 0 },
      ),
    [projects],
  );

  const columns = useMemo<Column<ProjectSummary>[]>(
    () => [
      {
        key: "status",
        title: "",
        className: "w-16",
        sortValue: (p) => p.status,
        render: (p) => <Badge color={statusColor(p.status)}>{p.status}</Badge>,
      },
      {
        key: "name",
        title: "project",
        sortValue: (p) => p.name.toLowerCase(),
        render: (p) => (
          <span>
            <span className="font-bold">{p.name}</span>{" "}
            <span className="text-term-dim">({p.slug})</span>
          </span>
        ),
      },
      {
        key: "knowledge",
        title: "kb",
        className: "w-12 text-right",
        sortValue: (p) => p.counts.knowledge,
        render: (p) => <span className="text-term-green">{p.counts.knowledge}</span>,
      },
      {
        key: "tasks",
        title: "tasks",
        className: "w-12 text-right",
        sortValue: (p) => p.counts.tasks,
        render: (p) => <span className="text-term-cyan">{p.counts.tasks}</span>,
      },
      {
        key: "plans",
        title: "plans",
        className: "w-12 text-right",
        sortValue: (p) => p.counts.plans,
        render: (p) => <span className="text-term-amber">{p.counts.plans}</span>,
      },
      {
        key: "deps",
        title: "depends on",
        render: (p) =>
          p.dependsOn.length > 0 ? (
            <span className="text-term-magenta">{p.dependsOn.join(", ")}</span>
          ) : (
            <span className="text-term-dim">—</span>
          ),
      },
      {
        key: "synced",
        title: "synced",
        className: "w-20 text-right",
        sortValue: (p) => p.lastSyncedAt ?? "",
        render: (p) => <span className="text-term-dim">{relativeTime(p.lastSyncedAt)}</span>,
      },
    ],
    [],
  );

  if (error) {
    return (
      <div className="p-6 text-term-red">
        failed to load projects: {error instanceof Error ? error.message : String(error)}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-stretch gap-3">
        <Panel title="dag totals" className="flex-1">
          <div className="flex items-center gap-6 px-3 py-2 text-[12px]">
            <Total label="projects" value={projects.length} color="text-term-magenta" />
            <Total label="knowledge" value={totals.knowledge} color="text-term-green" />
            <Total label="tasks" value={totals.tasks} color="text-term-cyan" />
            <Total label="plans" value={totals.plans} color="text-term-amber" />
            {totals.proposals > 0 && (
              <Total label="proposals ⚑" value={totals.proposals} color="text-term-red" />
            )}
            <span className="flex-1" />
            <span className="text-term-dim">
              <span className="kbd">enter</span> open project · <span className="kbd">/</span> jump
            </span>
          </div>
        </Panel>
      </div>

      <Panel title="projects" hint={`${projects.length} tracked`} className="min-h-40 flex-1">
        {isLoading ? (
          <div className="px-3 py-4 text-term-dim">loading…</div>
        ) : (
          <DataTable
            columns={columns}
            rows={projects}
            rowKey={(p) => p.slug}
            onOpen={(p) => navigate({ to: "/p/$slug", params: { slug: p.slug } })}
            emptyMessage="no projects — run `arcs init` in a repo"
          />
        )}
      </Panel>

      <Panel title="cross-project dag" hint="click node to open" className="h-64 shrink-0">
        {rootGraph && rootGraph.nodes.length > 0 ? (
          <Suspense fallback={<div className="p-4 text-term-dim">loading graph engine…</div>}>
            <GraphCanvas
              nodes={rootGraph.nodes}
              edges={rootGraph.edges}
              onOpen={(node) => {
                if (node.type === "project" && node.slug) {
                  navigate({ to: "/p/$slug", params: { slug: node.slug } });
                }
              }}
              onSelect={(node) => {
                if (node?.type === "project" && node.slug) {
                  navigate({ to: "/p/$slug", params: { slug: node.slug } });
                }
              }}
            />
          </Suspense>
        ) : (
          <div className="px-3 py-4 text-term-dim">
            {isLoading ? "loading…" : "no project dependencies yet"}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Total({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={`text-lg font-bold ${color}`}>{value}</span>
      <span className="text-term-dim">{label}</span>
    </span>
  );
}
