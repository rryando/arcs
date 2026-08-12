import { normalizeTaskWorkMetadata, type TaskMeta } from "./task-store.js";

export interface DiagramNode {
  nodeId: string;
  taskId: string;
  title: string;
}

export interface GenerateDiagramResult {
  mmd: string;
  nodes: DiagramNode[];
}

/**
 * Generates a Mermaid .mmd diagram from plan tasks.
 * Node IDs assigned T001+ in stable task.id order (a.id.localeCompare(b.id)).
 * Stable across regeneration regardless of priority changes — node IDs only shift
 * when tasks are added/removed/reordered by id, never by priority drift.
 * Emits --> dependency arrows from dependsOn fields.
 * Populates %% blocked-by: per-node metadata and plan-level %% ready: / %% blocked: comments.
 */
export function generateDiagramFromTasks(planId: string, tasks: TaskMeta[]): GenerateDiagramResult {
  const sorted = [...tasks].sort((a, b) => a.id.localeCompare(b.id));
  const diagramStatuses = sorted.map((task) =>
    task.status === "in_progress"
      ? "inProgress"
      : task.status === "cancelled"
        ? "blocked"
        : task.status,
  );

  const nodes: DiagramNode[] = sorted.map((t, i) => ({
    nodeId: `T${String(i + 1).padStart(3, "0")}`,
    taskId: t.id,
    title: t.title,
  }));

  // Build taskId -> nodeId map for dependency resolution
  const taskIdToNodeId = new Map<string, string>();
  for (const node of nodes) {
    taskIdToNodeId.set(node.taskId, node.nodeId);
  }

  // Build taskId -> status map for ready/blocked computation
  const taskIdToStatus = new Map<string, string>();
  for (const t of sorted) {
    taskIdToStatus.set(t.id, t.status);
  }

  // Compute ready/blocked node IDs
  const readyNodeIds: string[] = [];
  const blockedNodeIds: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const node = nodes[i];
    const deps = t.dependsOn ?? [];
    if (t.status === "backlog" && deps.length === 0) {
      readyNodeIds.push(node.nodeId);
    } else {
      const allDone = deps.every((depId) => taskIdToStatus.get(depId) === "done");
      if (t.status === "backlog" && allDone) {
        readyNodeIds.push(node.nodeId);
      } else if (!allDone) {
        blockedNodeIds.push(node.nodeId);
      }
    }
  }

  const statusLine = nodes.map((n, i) => `${n.nodeId}=${diagramStatuses[i]}`).join(", ");

  const lines: string[] = [
    `%% plan: ${planId}`,
    `%% status: ${statusLine}`,
    `%% ready: ${readyNodeIds.length > 0 ? readyNodeIds.join(", ") : "none"} (no deps or all deps done)`,
  ];
  if (blockedNodeIds.length > 0) {
    lines.push(`%% blocked: ${blockedNodeIds.join(", ")} (waiting on deps)`);
  }
  lines.push(`%% next-action: Start first backlog task`, "");

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const t = normalizeTaskWorkMetadata(sorted[i]);
    const deps = t.dependsOn ?? [];
    const blockedBy = deps
      .map((depId) => taskIdToNodeId.get(depId))
      .filter((n): n is string => n !== undefined);

    lines.push(
      `%% node: ${node.nodeId}`,
      `%% title: ${t.title}`,
      `%% status: ${diagramStatuses[i]}`,
      `%% skill: ${t.skill ?? "implementation"}`,
      `%% work-mode: ${t.workMode ?? "bounded"}`,
      `%% scope: ${t.scope ?? "(TBD)"}`,
    );
    if (t.sourceFiles && t.sourceFiles.length > 0) {
      const filesStr = t.sourceFiles
        .map((f) => (f.anchor ? `${f.path}:${f.anchor}` : f.path))
        .join(", ");
      lines.push(`%% files: ${filesStr}`);
    }
    lines.push(`%% acceptance: ${t.acceptance ?? "(TBD)"}`, `%% verify: ${t.verify ?? "npm test"}`);
    if (blockedBy.length > 0) {
      lines.push(`%% blocked-by: ${blockedBy.join(", ")}`);
    }
    lines.push("");
  }

  lines.push(
    "flowchart TD",
    "    classDef done fill:#22c55e,color:#fff",
    "    classDef inProgress fill:#f59e0b,color:#fff",
    "    classDef blocked fill:#ef4444,color:#fff",
    "    classDef backlog fill:#94a3b8,color:#fff",
    "",
  );

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const t = sorted[i];
    const cls = diagramStatuses[i];
    lines.push(`    ${node.nodeId}["${t.title.replace(/"/g, "'")}"]:::${cls}`);
  }
  lines.push("");

  // Emit dependency arrows: sorted by source nodeId then target nodeId
  const edgeLines: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const targetNode = nodes[i];
    const deps = t.dependsOn ?? [];
    for (const depId of deps) {
      const sourceNodeId = taskIdToNodeId.get(depId);
      if (sourceNodeId) {
        edgeLines.push(`    ${sourceNodeId} --> ${targetNode.nodeId}`);
      }
    }
  }
  edgeLines.sort();
  for (const edge of edgeLines) {
    lines.push(edge);
  }
  if (edgeLines.length > 0) {
    lines.push("");
  }

  return { mmd: `${lines.join("\n")}\n`, nodes };
}
