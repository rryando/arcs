/**
 * Cytoscape graph canvas — weighted force layout (fcose), type-colored
 * nodes, neighborhood highlight on hover, select/open callbacks.
 */

import cytoscape, { type Core, type ElementDefinition, type LayoutOptions } from "cytoscape";
import fcose from "cytoscape-fcose";
import { useEffect, useMemo, useRef } from "react";
import type { GraphEdgeDto, GraphNodeDto, NodeType } from "../api/client";
import { truncate } from "../lib/format";

cytoscape.use(fcose);

const TYPE_COLORS: Record<NodeType, string> = {
  knowledge: "#7ee787",
  task: "#6fc3df",
  plan: "#e5b567",
  file: "#647c66",
  project: "#c792ea",
};

/** Relations that get direction arrows; symmetric pairs are deduped. */
const DIRECTED_RELATIONS = new Set([
  "task_belongs_to_plan",
  "plan_contains_task",
  "knowledge_touches_file",
  "project_depends_on",
]);

const SYMMETRIC_RELATIONS = new Set(["task_blocks_task", "shares_source_file", "shares_keywords"]);

function edgeKey(e: GraphEdgeDto): string {
  if (SYMMETRIC_RELATIONS.has(e.relation)) {
    const [a, b] = [e.source, e.target].sort();
    return `${a}|${b}|${e.relation}`;
  }
  return `${e.source}|${e.target}|${e.relation}`;
}

export interface GraphFilter {
  types: Set<NodeType>;
  minWeight?: number;
}

export function GraphCanvas({
  nodes,
  edges,
  filter,
  focusId,
  onSelect,
  onOpen,
}: {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  filter?: GraphFilter;
  focusId?: string | null;
  onSelect?: (node: GraphNodeDto | null) => void;
  onOpen?: (node: GraphNodeDto) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const metaRef = useRef(new Map<string, GraphNodeDto>());
  const onSelectRef = useRef(onSelect);
  const onOpenRef = useRef(onOpen);

  useEffect(() => {
    onSelectRef.current = onSelect;
    onOpenRef.current = onOpen;
  }, [onSelect, onOpen]);

  const elements = useMemo<ElementDefinition[]>(() => {
    const visibleTypes = filter?.types;
    const minWeight = filter?.minWeight ?? 0;

    const visibleNodes = nodes.filter((n) => !visibleTypes || visibleTypes.has(n.type));
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    metaRef.current = new Map(visibleNodes.map((n) => [n.id, n]));

    const seenEdges = new Set<string>();
    const els: ElementDefinition[] = [];

    for (const n of visibleNodes) {
      els.push({
        group: "nodes",
        data: {
          id: n.id,
          label: truncate(n.title ?? n.id, 34),
          color: TYPE_COLORS[n.type] ?? "#647c66",
          nodeType: n.type,
        },
      });
    }

    for (const e of edges) {
      if (!visibleIds.has(e.source) || !visibleIds.has(e.target)) continue;
      if (e.weight < minWeight) continue;
      const key = edgeKey(e);
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      els.push({
        group: "edges",
        data: {
          id: `e:${key}`,
          source: e.source,
          target: e.target,
          directed: DIRECTED_RELATIONS.has(e.relation) ? 1 : 0,
          weight: e.weight,
        },
      });
    }
    return els;
  }, [nodes, edges, filter]);

  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      wheelSensitivity: 0.2,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            label: "data(label)",
            color: "#647c66",
            "font-family": "JetBrains Mono Variable, monospace",
            "font-size": 9,
            "text-valign": "bottom",
            "text-margin-y": 3,
            "text-outline-color": "#070a07",
            "text-outline-width": 2,
            width: 13,
            height: 13,
            "border-width": 1,
            "border-color": "#1d2a1d",
          },
        },
        {
          selector: "node[nodeType = 'project']",
          style: { width: 22, height: 22, "font-size": 11, color: "#b9dcb9" },
        },
        {
          selector: "node:selected",
          style: { "border-color": "#7ee787", "border-width": 2, color: "#7ee787" },
        },
        {
          selector: "edge",
          style: {
            width: "mapData(weight, 0, 1, 0.5, 2)",
            "line-color": "#263626",
            "curve-style": "bezier",
            "target-arrow-shape": "none",
            opacity: 0.75,
          },
        },
        {
          selector: "edge[directed = 1]",
          style: {
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#3a5340",
            "arrow-scale": 0.7,
          },
        },
        { selector: ".faded", style: { opacity: 0.12 } },
      ],
      layout: {
        name: "fcose",
        animate: false,
        randomize: true,
        nodeRepulsion: 6500,
        idealEdgeLength: 55,
        gravity: 0.3,
        numIter: 1500,
      } as LayoutOptions,
    });

    cy.on("mouseover", "node", (ev) => {
      const neighborhood = ev.target.neighborhood().add(ev.target);
      cy.elements().not(neighborhood).addClass("faded");
    });
    cy.on("mouseout", "node", () => cy.elements().removeClass("faded"));

    cy.on("tap", (ev) => {
      if (ev.target === cy) {
        onSelectRef.current?.(null);
        return;
      }
      if (ev.target.isNode()) {
        const dto = metaRef.current.get(ev.target.id()) ?? null;
        onSelectRef.current?.(dto);
      }
    });
    cy.on("dbltap", "node", (ev) => {
      const dto = metaRef.current.get(ev.target.id());
      if (dto) onOpenRef.current?.(dto);
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [elements]);

  // Focus a node on request (from palette / selection).
  useEffect(() => {
    if (!focusId || !cyRef.current) return;
    const node = cyRef.current.getElementById(focusId);
    if (node.nonempty()) {
      cyRef.current.center(node);
      cyRef.current.elements().unselect();
      node.select();
    }
  }, [focusId]);

  return (
    <div className="h-full w-full">
      <div
        ref={containerRef}
        className="h-full w-full bg-term-inset"
        role="img"
        aria-label={`Relationship graph with ${nodes.length} nodes and ${edges.length} edges. A text node list is available alongside the graph.`}
      />
      <ul className="sr-only" aria-label="Graph node summary">
        {nodes.map((node) => (
          <li key={node.id}>
            {node.type}: {node.title ?? node.id}
          </li>
        ))}
      </ul>
    </div>
  );
}

export const NODE_TYPE_COLORS = TYPE_COLORS;
