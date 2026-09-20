/**
 * Builds an adjacency index (graph) from project metadata indexes.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readChanges } from "../utils/change-ledger.js";
import { getProjectDir } from "../utils/paths.js";
import { listTasks, readKnowledgeIndex, readPlanIndex } from "../utils/project-memory.js";
import type { AdjacencyIndex, GraphEdge, GraphNode } from "./graph-types.js";
import { EDGE_WEIGHTS } from "./graph-types.js";

const MAX_FILE_REFS_FOR_PAIRS = 10;

function addNode(nodes: Map<string, GraphNode>, node: GraphNode): void {
  if (!nodes.has(node.id)) {
    nodes.set(node.id, node);
  }
}

function addEdge(edges: Map<string, GraphEdge[]>, edge: GraphEdge): void {
  const list = edges.get(edge.source);
  if (list) {
    list.push(edge);
  } else {
    edges.set(edge.source, [edge]);
  }
}

async function getMtime(filePath: string): Promise<number> {
  try {
    const s = await stat(filePath);
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

export async function buildAdjacencyIndex(slug: string): Promise<AdjacencyIndex> {
  const projectDir = getProjectDir(slug);
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge[]>();
  const fileIndex = new Map<string, string[]>();

  // Helper to register a file reference from a node
  function registerFileRef(nodeId: string, filePath: string): void {
    addNode(nodes, { id: `file:${filePath}`, type: "file", title: filePath });
    const refs = fileIndex.get(filePath);
    if (refs) {
      refs.push(nodeId);
    } else {
      fileIndex.set(filePath, [nodeId]);
    }
  }

  // 1. Knowledge
  let knowledgeEntries: Array<{
    id: string;
    title: string;
    keywords: string[];
    sourceFiles?: Array<{ path: string }>;
  }> = [];
  try {
    const idx = await readKnowledgeIndex(projectDir);
    knowledgeEntries = idx.entries;
  } catch {
    // graceful
  }

  for (const entry of knowledgeEntries) {
    const nodeId = `knowledge:${entry.id}`;
    addNode(nodes, { id: nodeId, type: "knowledge", title: entry.title, keywords: entry.keywords });
    if (entry.sourceFiles) {
      for (const sf of entry.sourceFiles) {
        registerFileRef(nodeId, sf.path);
        addEdge(edges, {
          source: nodeId,
          target: `file:${sf.path}`,
          relation: "knowledge_touches_file",
          weight: EDGE_WEIGHTS.knowledge_touches_file,
        });
      }
    }
  }

  // 2. Plans
  let planEntries: Array<{
    id: string;
    title: string;
    keywords: string[];
    sourceFiles?: Array<{ path: string }>;
  }> = [];
  try {
    const idx = await readPlanIndex(projectDir);
    planEntries = idx.plans;
  } catch {
    // graceful
  }

  for (const plan of planEntries) {
    const nodeId = `plan:${plan.id}`;
    addNode(nodes, { id: nodeId, type: "plan", title: plan.title, keywords: plan.keywords });
    if (plan.sourceFiles) {
      for (const sf of plan.sourceFiles) {
        registerFileRef(nodeId, sf.path);
        addEdge(edges, {
          source: nodeId,
          target: `file:${sf.path}`,
          relation: "knowledge_touches_file",
          weight: EDGE_WEIGHTS.knowledge_touches_file,
        });
      }
    }
  }

  // 3. Tasks
  let taskEntries: Array<{
    id: string;
    title: string;
    planId?: string;
    dependsOn?: string[];
    sourceFiles?: Array<{ path: string }>;
  }> = [];
  try {
    taskEntries = await listTasks(projectDir);
  } catch {
    // graceful
  }

  // The change ledger: files each task ACTUALLY touched per git. Read once and
  // grouped, so a project with no ledger costs one missing-file read. Both
  // `commit` and `pending` entries contribute — a task that closed with
  // uncommitted work still touched those files.
  const changedFilesByTask = new Map<string, Set<string>>();
  try {
    for (const change of await readChanges(projectDir)) {
      if (change.kind !== "commit" && change.kind !== "pending") continue;
      const set = changedFilesByTask.get(change.taskId) ?? new Set<string>();
      for (const file of change.files ?? []) set.add(file.path);
      for (const path of change.untracked ?? []) set.add(path);
      changedFilesByTask.set(change.taskId, set);
    }
  } catch {
    // graceful
  }

  for (const task of taskEntries) {
    const nodeId = `task:${task.id}`;
    addNode(nodes, { id: nodeId, type: "task", title: task.title });
    if (task.planId) {
      const planNodeId = `plan:${task.planId}`;
      addNode(nodes, { id: planNodeId, type: "plan" });
      addEdge(edges, {
        source: nodeId,
        target: planNodeId,
        relation: "task_belongs_to_plan",
        weight: EDGE_WEIGHTS.task_belongs_to_plan,
      });
      addEdge(edges, {
        source: planNodeId,
        target: nodeId,
        relation: "plan_contains_task",
        weight: EDGE_WEIGHTS.plan_contains_task,
      });
    }
    if (task.sourceFiles) {
      for (const sf of task.sourceFiles) {
        registerFileRef(nodeId, sf.path);
        addEdge(edges, {
          source: nodeId,
          target: `file:${sf.path}`,
          relation: "knowledge_touches_file",
          weight: EDGE_WEIGHTS.knowledge_touches_file,
        });
      }
    }
    // Files the ledger says the task changed, skipping ones it already declares.
    const declared = new Set((task.sourceFiles ?? []).map((sf) => sf.path));
    for (const path of changedFilesByTask.get(task.id) ?? []) {
      if (declared.has(path)) continue;
      registerFileRef(nodeId, path);
      addEdge(edges, {
        source: nodeId,
        target: `file:${path}`,
        relation: "task_changed_file",
        weight: EDGE_WEIGHTS.task_changed_file,
      });
    }
    if (task.dependsOn) {
      for (const depId of task.dependsOn) {
        const depNodeId = `task:${depId}`;
        addNode(nodes, { id: depNodeId, type: "task" });
        addEdge(edges, {
          source: depNodeId,
          target: nodeId,
          relation: "task_blocks_task",
          weight: EDGE_WEIGHTS.task_blocks_task,
        });
        addEdge(edges, {
          source: nodeId,
          target: depNodeId,
          relation: "task_blocks_task",
          weight: EDGE_WEIGHTS.task_blocks_task,
        });
      }
    }
  }

  // 5. shares_source_file edges
  fileIndex.forEach((refNodes) => {
    if (refNodes.length < 2) return;
    const capped = refNodes.slice(0, MAX_FILE_REFS_FOR_PAIRS);
    for (let i = 0; i < capped.length; i++) {
      for (let j = i + 1; j < capped.length; j++) {
        addEdge(edges, {
          source: capped[i],
          target: capped[j],
          relation: "shares_source_file",
          weight: EDGE_WEIGHTS.shares_source_file,
        });
        addEdge(edges, {
          source: capped[j],
          target: capped[i],
          relation: "shares_source_file",
          weight: EDGE_WEIGHTS.shares_source_file,
        });
      }
    }
  });

  // 6. shares_keywords edges for knowledge entries
  for (let i = 0; i < knowledgeEntries.length; i++) {
    for (let j = i + 1; j < knowledgeEntries.length; j++) {
      const a = knowledgeEntries[i];
      const b = knowledgeEntries[j];
      const shared = a.keywords.filter((kw) => b.keywords.includes(kw));
      if (shared.length >= 2) {
        const aId = `knowledge:${a.id}`;
        const bId = `knowledge:${b.id}`;
        addEdge(edges, {
          source: aId,
          target: bId,
          relation: "shares_keywords",
          weight: EDGE_WEIGHTS.shares_keywords,
        });
        addEdge(edges, {
          source: bId,
          target: aId,
          relation: "shares_keywords",
          weight: EDGE_WEIGHTS.shares_keywords,
        });
      }
    }
  }

  // 7. sourceHashes
  const sourceHashes: Record<string, number> = {
    knowledge: await getMtime(join(projectDir, "knowledge", "index.json")),
    plans: await getMtime(join(projectDir, "plans", "index.json")),
    tasks: await getMtime(join(projectDir, "tasks", "index.json")),
  };
  // Only tracked once it exists: the cache treats a missing tracked file as
  // stale, and a project with no ledger yet must not rebuild on every read.
  // `appendChange` invalidates the cache explicitly, which covers creation.
  const changesMtime = await getMtime(join(projectDir, "workflow", "changes.jsonl"));
  if (changesMtime > 0) sourceHashes.changes = changesMtime;

  return {
    nodes,
    edges,
    fileIndex,
    buildTime: new Date().toISOString(),
    sourceHashes,
  };
}
