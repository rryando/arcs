/**
 * Project graph view — cytoscape canvas with type filters, node detail
 * side panel, and open-on-double-click.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import type { GraphNodeDto, NodeType } from "../api/client";
import { useGraph } from "../api/hooks";
import { Badge, kindColor, statusColor, typeColor } from "../components/Badge";
import type { GraphFilter } from "../components/GraphCanvas";
import { Panel } from "../components/Panel";
import { useShortcuts } from "../hooks/useShortcuts";
import { cx, truncate } from "../lib/format";

const GraphCanvas = lazy(() =>
  import("../components/GraphCanvas").then((m) => ({ default: m.GraphCanvas })),
);

const ALL_TYPES: NodeType[] = ["knowledge", "task", "plan", "file"];

export function GraphView() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  const { data, isLoading } = useGraph(slug);

  const [hiddenTypes, setHiddenTypes] = useState<Set<NodeType>>(new Set());
  const [selected, setSelected] = useState<GraphNodeDto | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [nodeFilter, setNodeFilter] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);

  const filter = useMemo<GraphFilter>(() => {
    const types = new Set(ALL_TYPES.filter((t) => !hiddenTypes.has(t)));
    return { types, minWeight: 0 };
  }, [hiddenTypes]);

  const toggleType = (type: NodeType) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const openNode = (node: GraphNodeDto) => {
    const rawId = node.id.slice(node.id.indexOf(":") + 1);
    if (node.type === "knowledge") {
      navigate({ to: "/p/$slug/knowledge/$id", params: { slug, id: rawId } });
    } else if (node.type === "plan") {
      navigate({ to: "/p/$slug/plans/$id", params: { slug, id: rawId } });
    } else if (node.type === "task") {
      navigate({ to: "/p/$slug/tasks", params: { slug } });
    }
  };

  useShortcuts([
    {
      keys: "f",
      description: "focus node filter",
      group: "graph",
      run: () => filterInputRef.current?.focus(),
    },
    {
      keys: "escape",
      description: "clear selection",
      group: "graph",
      run: () => setSelected(null),
    },
  ]);

  const focusMatch = () => {
    const q = nodeFilter.trim().toLowerCase();
    if (!q || !data) return;
    const hit = data.nodes.find(
      (n) => n.type !== "file" && (n.title ?? "").toLowerCase().includes(q),
    );
    if (hit) {
      setFocusId(hit.id);
      setSelected(hit);
    }
  };

  const counts = useMemo(() => {
    const map = new Map<NodeType, number>();
    for (const n of data?.nodes ?? []) map.set(n.type, (map.get(n.type) ?? 0) + 1);
    return map;
  }, [data]);

  const accessibleNodes = useMemo(() => {
    const query = nodeFilter.trim().toLowerCase();
    return (data?.nodes ?? []).filter(
      (node) =>
        !hiddenTypes.has(node.type) &&
        (!query || (node.title ?? node.id).toLowerCase().includes(query)),
    );
  }, [data, hiddenTypes, nodeFilter]);

  return (
    <div className="flex h-full gap-3 p-3">
      <Panel
        title="graph"
        hint={
          data
            ? `${data.nodes.length} nodes · ${data.edges.length} edges · dbl-click to open`
            : "loading…"
        }
        actions={
          <input
            ref={filterInputRef}
            type="text"
            value={nodeFilter}
            onChange={(e) => setNodeFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && focusMatch()}
            placeholder="focus node… [f]"
            className="w-44 border border-term-border bg-term-inset px-2 py-0.5 text-[11px] text-term-fg outline-none focus:border-term-green/60 placeholder:text-term-dim/50"
          />
        }
        className="min-w-0 flex-1"
        bodyClassName="p-0"
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-1 border-b border-term-border px-2 py-1 text-[11px]">
            {ALL_TYPES.map((type) => {
              const hidden = hiddenTypes.has(type);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleType(type)}
                  className={cx(
                    "px-1.5 py-0.5 uppercase",
                    hidden ? "text-term-dim/40 line-through" : "text-term-dim hover:text-term-fg",
                  )}
                >
                  {type}
                  <span className="ml-1 text-[9px] opacity-60">{counts.get(type) ?? 0}</span>
                </button>
              );
            })}
            <span className="flex-1" />
            <span className="text-term-dim">hover highlights neighborhood</span>
          </div>
          <div className="min-h-0 flex-1">
            {isLoading ? (
              <div className="p-4 text-term-dim">building adjacency index…</div>
            ) : data ? (
              <Suspense fallback={<div className="p-4 text-term-dim">loading graph engine…</div>}>
                <GraphCanvas
                  nodes={data.nodes}
                  edges={data.edges}
                  filter={filter}
                  focusId={focusId}
                  onSelect={setSelected}
                  onOpen={openNode}
                />
              </Suspense>
            ) : null}
          </div>
        </div>
      </Panel>

      <Panel title="node" hint={selected ? "selected" : "click a node"} className="w-72 shrink-0">
        <div className="flex h-full min-h-0 flex-col">
          {selected ? (
            <div className="flex flex-col gap-2 p-3 text-[12px]">
              <div className="flex items-center gap-2">
                <Badge color={typeColor(selected.type)}>{selected.type}</Badge>
                {selected.kind && <Badge color={kindColor(selected.kind)}>{selected.kind}</Badge>}
                {selected.status && (
                  <Badge color={statusColor(selected.status)}>{selected.status}</Badge>
                )}
              </div>
              <div className="font-bold text-term-fg">{selected.title ?? selected.id}</div>
              <div className="break-all text-[10px] text-term-dim">{selected.id}</div>
              {(selected.keywords?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1">
                  {selected.keywords?.map((keyword) => (
                    <span key={keyword} className="text-[11px] text-term-dim">
                      #{keyword}
                    </span>
                  ))}
                </div>
              )}
              {selected.type !== "file" && (
                <button
                  type="button"
                  onClick={() => openNode(selected)}
                  className="mt-2 border border-term-green/60 px-2 py-1 font-bold text-term-green hover:bg-term-green hover:text-term-bg"
                >
                  open {selected.type === "task" ? "in tasks" : selected.type} ↵
                </button>
              )}
            </div>
          ) : (
            <div className="p-3 text-[11px] text-term-dim">
              <p>click a node for details, double-click to open the entity.</p>
              <p className="mt-2">
                nodes: <NodeLegend type="knowledge" /> <NodeLegend type="task" />{" "}
                <NodeLegend type="plan" /> <NodeLegend type="file" />
              </p>
            </div>
          )}

          <div className="min-h-0 flex-1 border-t border-term-border">
            <div className="px-2 py-1 text-[10px] tracking-wide text-term-dim uppercase">
              keyboard node list [{accessibleNodes.length}]
            </div>
            <ul className="h-[calc(100%-25px)] overflow-y-auto" aria-label="Graph nodes">
              {accessibleNodes.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    onFocus={() => {
                      setSelected(node);
                      setFocusId(node.id);
                    }}
                    onClick={() => {
                      setSelected(node);
                      setFocusId(node.id);
                      if (node.type !== "file") openNode(node);
                    }}
                    className="flex w-full items-center gap-1 border-t border-term-border/30 px-2 py-0.5 text-left text-[10px] text-term-dim hover:bg-term-fg/5 hover:text-term-fg focus:bg-term-green focus:text-term-bg focus:outline-none"
                  >
                    <span>{node.type.slice(0, 1).toUpperCase()}</span>
                    <span className="truncate">{node.title ?? node.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function NodeLegend({ type }: { type: NodeType }) {
  const colors: Record<NodeType, string> = {
    knowledge: "text-term-green",
    task: "text-term-cyan",
    plan: "text-term-amber",
    file: "text-term-dim",
    project: "text-term-magenta",
  };
  return <span className={cx("mr-1", colors[type])}>●{truncate(type, 4)}</span>;
}
