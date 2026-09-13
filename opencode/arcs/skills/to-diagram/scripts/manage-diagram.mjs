#!/usr/bin/env node
// manage-diagram.mjs — Deterministic diagram management for .diagram.mmd files
// No external dependencies. Node ESM CLI.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

// --- Label pattern ---
// Node declarations are emitted with a quoted label (ID["label"]:::status) or,
// in legacy diagrams, a bare label (ID[label]:::status). A quoted label may
// embed ']', '[', '-->', ':::status', and backslash-escaped quotes, so the
// label group must be quote-aware to avoid truncating at the first ']'. The
// bare alternative keeps legacy files working. The optional ':::class' suffix
// is always matched separately, so it is never folded into the label text.
const LABEL_SRC = '"(?:[^"\\\\]|\\\\.)*"|[^\\]]+';

// --- Safe file read ---

function safeReadFile(filePath) {
  if (!existsSync(filePath)) {
    process.stderr.write(`Error: File not found: ${filePath}\n`);
    process.exit(1);
  }
  return readFileSync(filePath, "utf-8");
}

// --- Pure helpers ---

function parseNodes(graphLines) {
  const nodes = [];
  const seen = new Set();
  // Match node declarations: ID[label]:::status or ID[label] (no status)
  const nodeRe = new RegExp(`\\b(T\\d{3,})\\[(${LABEL_SRC})\\](?::::(\\w+))?`, "g");
  for (const line of graphLines) {
    for (const match of line.matchAll(nodeRe)) {
      const [, id, label, status] = match;
      if (!seen.has(id)) {
        nodes.push({ id, label, status: status || "backlog" });
        seen.add(id);
      }
    }
  }
  return nodes;
}

function parseEdges(graphLines) {
  const edges = [];
  const edgeRe = new RegExp(
    `\\b(T\\d{3,})(?:\\[${LABEL_SRC}\\](?::::\\w+)?)?\\s*-->\\s*(T\\d{3,})`,
    "g",
  );
  for (const line of graphLines) {
    for (const match of line.matchAll(edgeRe)) {
      edges.push({ from: match[1], to: match[2] });
    }
  }
  return edges;
}

function parseMetadataBlocks(lines) {
  const blocks = {};
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("%%")) continue;

    const content = trimmed.slice(2).trim();
    const fieldMatch = content.match(/^(\S+?):\s*(.*)$/);
    if (!fieldMatch) continue;

    const [, key, value] = fieldMatch;

    if (key === "node") {
      current = value.trim();
      blocks[current] = { node: current };
    } else if (current) {
      blocks[current][key] = value.trim();
    }
  }

  return blocks;
}

function parsePlanLevelComments(lines) {
  const result = {
    planId: null,
    statusComment: null,
    readyComment: null,
    blockedComment: null,
    nextActionComment: null,
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("%%")) continue;
    const content = trimmed.slice(2).trim();

    // Stop at first node metadata block
    if (content.startsWith("node:")) break;

    if (content.startsWith("plan:")) {
      result.planId = content.slice(5).trim();
    } else if (content.startsWith("status:")) {
      result.statusComment = content.slice(7).trim();
    } else if (content.startsWith("ready:")) {
      result.readyComment = content.slice(6).trim();
    } else if (content.startsWith("blocked:")) {
      result.blockedComment = content.slice(8).trim();
    } else if (content.startsWith("next-action:")) {
      result.nextActionComment = content.slice(12).trim();
    }
  }

  return result;
}

function splitSections(content) {
  const lines = content.split("\n");
  const flowchartIdx = lines.findIndex((l) => /^\s*flowchart\s+TD/i.test(l));

  if (flowchartIdx === -1) {
    return { headerLines: lines, graphLines: [], flowchartIdx: -1 };
  }

  return {
    headerLines: lines.slice(0, flowchartIdx),
    graphLines: lines.slice(flowchartIdx),
    flowchartIdx,
  };
}

function computeReady(nodes, edges) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const ready = [];

  for (const node of nodes) {
    if (node.status !== "backlog") continue;
    const incomingDeps = edges.filter((e) => e.to === node.id).map((e) => e.from);
    const allDepsDone = incomingDeps.every((depId) => {
      const dep = nodeMap.get(depId);
      return dep && dep.status === "done";
    });
    if (allDepsDone) ready.push(node.id);
  }

  return ready;
}

function computeBlocked(nodes, edges) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const blocked = [];

  for (const node of nodes) {
    // Explicitly blocked status always counts
    if (node.status === "blocked") {
      blocked.push(node.id);
      continue;
    }
    // Implicitly blocked: backlog node with at least one undone predecessor
    if (node.status !== "backlog") continue;
    const incomingDeps = edges.filter((e) => e.to === node.id).map((e) => e.from);
    if (incomingDeps.length === 0) continue; // No deps = ready, not blocked
    const hasUndone = incomingDeps.some((depId) => {
      const dep = nodeMap.get(depId);
      return dep && dep.status !== "done";
    });
    if (hasUndone) {
      blocked.push(node.id);
    }
  }

  return blocked;
}

function parseReadyNodeIds(readyComment) {
  if (!readyComment) return [];
  const ids = [];
  for (const match of readyComment.matchAll(/T\d{3,}/g)) {
    ids.push(match[0]);
  }
  return ids.sort();
}

function parseStatusComment(statusComment) {
  if (!statusComment) return {};
  const result = {};
  for (const match of statusComment.matchAll(/(T\d{3,})=(\w+)/g)) {
    result[match[1]] = match[2];
  }
  return result;
}

// --- Commands ---

function requirePlanHeader(content) {
  const lines = content.split("\n");
  let found = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("%%")) {
      const c = trimmed.slice(2).trim();
      if (c.startsWith("plan:")) {
        const val = c.slice(5).trim();
        if (val) {
          found = true;
          break;
        }
      }
    }
  }
  if (!found) {
    process.stderr.write("Error: Diagram must have a non-empty plan header.\n");
    process.exit(1);
  }
}

function inspect(filePath) {
  const content = safeReadFile(filePath);
  requirePlanHeader(content);
  const { headerLines, graphLines } = splitSections(content);

  if (graphLines.length === 0) {
    // Check for stateDiagram
    if (content.includes("stateDiagram-v2")) {
      process.stderr.write("Error: stateDiagram-v2 is not supported by this tool.\n");
      process.exit(1);
    }
    process.stderr.write("Error: No flowchart TD found in file.\n");
    process.exit(1);
  }

  const nodes = parseNodes(graphLines);
  const edges = parseEdges(graphLines);
  const metadataBlocks = parseMetadataBlocks(headerLines);
  const planLevel = parsePlanLevelComments(headerLines);

  const result = {
    planId: planLevel.planId,
    nodes,
    edges,
    metadataBlocks,
    statusComment: planLevel.statusComment,
    readyComment: planLevel.readyComment,
    blockedComment: planLevel.blockedComment,
    nextActionComment: planLevel.nextActionComment,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function ready(filePath) {
  const content = safeReadFile(filePath);
  requirePlanHeader(content);
  const { graphLines } = splitSections(content);

  if (graphLines.length === 0) {
    if (content.includes("stateDiagram-v2")) {
      process.stderr.write("Error: stateDiagram-v2 is not supported by this tool.\n");
      process.exit(1);
    }
    process.stderr.write("Error: No flowchart TD found in file.\n");
    process.exit(1);
  }

  const nodes = parseNodes(graphLines);
  const edges = parseEdges(graphLines);
  const readyNodes = computeReady(nodes, edges);

  process.stdout.write(`${JSON.stringify(readyNodes, null, 2)}\n`);
}

function validate(filePath, metadataPath) {
  const content = safeReadFile(filePath);

  // If --metadata provided, do drift validation
  if (metadataPath) {
    return validateWithMetadata(content, metadataPath);
  }
  const errors = [];

  // Check for unsupported diagram type
  if (content.includes("stateDiagram-v2")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          errors: ["Unsupported diagram type: stateDiagram-v2. Only flowchart TD is supported."],
        },
        null,
        2,
      )}\n`,
    );
    process.exit(1);
  }

  const { headerLines, graphLines } = splitSections(content);

  if (graphLines.length === 0) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, errors: ["No flowchart TD found in file."] }, null, 2)}\n`,
    );
    process.exit(1);
  }

  const nodes = parseNodes(graphLines);
  const edges = parseEdges(graphLines);
  const metadataBlocks = parseMetadataBlocks(headerLines);
  const planLevel = parsePlanLevelComments(headerLines);

  // Duplicate node IDs in graph
  const nodeIds = [];
  const nodeRe = new RegExp(`\\b(T\\d{3,})\\[(${LABEL_SRC})\\](?::::(\\w+))?`, "g");
  for (const line of graphLines) {
    for (const match of line.matchAll(nodeRe)) {
      nodeIds.push(match[1]);
    }
  }
  const idCounts = {};
  for (const id of nodeIds) {
    idCounts[id] = (idCounts[id] || 0) + 1;
  }
  for (const [id, count] of Object.entries(idCounts)) {
    if (count > 1) errors.push(`Duplicate node ID in graph: ${id}`);
  }

  // Duplicate metadata blocks
  const metaNodeIds = [];
  for (const line of headerLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("%%")) {
      const content = trimmed.slice(2).trim();
      const m = content.match(/^node:\s*(.+)$/);
      if (m) metaNodeIds.push(m[1].trim());
    }
  }
  const metaCounts = {};
  for (const id of metaNodeIds) {
    metaCounts[id] = (metaCounts[id] || 0) + 1;
  }
  for (const [id, count] of Object.entries(metaCounts)) {
    if (count > 1) errors.push(`Duplicate metadata block for node: ${id}`);
  }

  // Edges referencing missing nodes
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    if (!nodeIdSet.has(edge.from)) errors.push(`Edge references missing node: ${edge.from}`);
    if (!nodeIdSet.has(edge.to)) errors.push(`Edge references missing node: ${edge.to}`);
  }

  // Missing metadata block for graph nodes
  for (const node of nodes) {
    if (!metadataBlocks[node.id]) {
      errors.push(`Missing metadata block for node: ${node.id}`);
    }
  }

  // Missing required metadata fields (verify is optional per SKILL.md)
  const requiredFields = ["node", "title", "status", "skill", "scope", "acceptance"];
  for (const node of nodes) {
    const block = metadataBlocks[node.id];
    if (block) {
      for (const field of requiredFields) {
        if (!block[field]) {
          errors.push(`Missing required field '${field}' in metadata block for ${node.id}`);
        }
      }
    }
  }

  // Metadata blocks not ordered by node ID
  if (metaNodeIds.length > 1) {
    const uniqueMetaIds = [...new Set(metaNodeIds)];
    const sorted = [...uniqueMetaIds].sort();
    if (JSON.stringify(uniqueMetaIds) !== JSON.stringify(sorted)) {
      errors.push("Metadata blocks are not ordered by node ID");
    }
  }

  // Graph node status differs from metadata block status
  for (const node of nodes) {
    const block = metadataBlocks[node.id];
    if (block?.status && block.status !== node.status) {
      errors.push(
        `Status mismatch for ${node.id}: graph says '${node.status}', metadata says '${block.status}'`,
      );
    }
  }

  // Status comment differs from graph node statuses
  if (planLevel.statusComment) {
    const commentStatuses = parseStatusComment(planLevel.statusComment);
    for (const node of nodes) {
      if (commentStatuses[node.id] && commentStatuses[node.id] !== node.status) {
        errors.push(
          `Status comment mismatch for ${node.id}: comment says '${commentStatuses[node.id]}', graph says '${node.status}'`,
        );
      }
    }
  }

  // Ready comment differs from computed ready nodes
  if (planLevel.readyComment) {
    const commentReady = parseReadyNodeIds(planLevel.readyComment);
    // Validate that all ready IDs actually exist in the graph
    for (const id of commentReady) {
      if (!nodeIdSet.has(id)) {
        errors.push(`Ready comment references node '${id}' not found in graph`);
      }
    }
    const computedReady = computeReady(nodes, edges).sort();
    if (JSON.stringify(commentReady) !== JSON.stringify(computedReady)) {
      errors.push(
        `Ready comment mismatch: comment says [${commentReady.join(", ")}], computed is [${computedReady.join(", ")}]`,
      );
    }
  }

  const ok = errors.length === 0;
  process.stdout.write(`${JSON.stringify({ ok, errors }, null, 2)}\n`);
  if (!ok) process.exit(1);
}

function validateWithMetadata(content, metadataPath) {
  const metaRaw = safeReadFile(metadataPath);
  let meta;
  try {
    meta = JSON.parse(metaRaw);
  } catch (e) {
    process.stderr.write(`Error: Failed to parse metadata JSON: ${e.message}\n`);
    process.exit(1);
  }

  const errors = [];
  const { headerLines, graphLines } = splitSections(content);

  if (graphLines.length === 0) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, errors: ["No flowchart TD found in file."] }, null, 2)}\n`,
    );
    process.exit(1);
  }

  const nodes = parseNodes(graphLines);
  const edges = parseEdges(graphLines);
  const planLevel = parsePlanLevelComments(headerLines);
  const metadataBlocks = parseMetadataBlocks(headerLines);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const metaTaskIds = new Set((meta.tasks || []).map((t) => t.id));
  const diagramNodeIds = new Set(nodes.map((n) => n.id));

  // 1. Class status mismatch
  for (const task of meta.tasks || []) {
    const node = nodeMap.get(task.id);
    if (node && node.status !== task.status) {
      errors.push(
        `Class status mismatch for ${task.id}: diagram says '${node.status}', metadata says '${task.status}'`,
      );
    }
  }

  // 2. Phantom node
  for (const node of nodes) {
    if (!metaTaskIds.has(node.id)) {
      errors.push(`Phantom node in diagram: ${node.id}`);
    }
  }

  // 3. Missing node
  for (const task of meta.tasks || []) {
    if (!diagramNodeIds.has(task.id)) {
      errors.push(`Missing node from diagram: ${task.id}`);
    }
  }

  // 4. Topology mismatch
  const metaEdges = new Set();
  for (const task of meta.tasks || []) {
    for (const dep of (task.dependencies || []).sort()) {
      metaEdges.add(`${dep}->${task.id}`);
    }
  }
  const diagramEdges = new Set(edges.map((e) => `${e.from}->${e.to}`));
  const allEdgeKeys = new Set([...metaEdges, ...diagramEdges]);
  let topoMismatch = false;
  for (const key of allEdgeKeys) {
    if (!metaEdges.has(key) || !diagramEdges.has(key)) {
      topoMismatch = true;
      break;
    }
  }
  if (topoMismatch) {
    errors.push("Topology mismatch: diagram edges differ from metadata dependencies");
  }

  // 5. Stale plan-level comments
  if (planLevel.statusComment) {
    const commentStatuses = parseStatusComment(planLevel.statusComment);
    for (const task of meta.tasks || []) {
      if (commentStatuses[task.id] && commentStatuses[task.id] !== task.status) {
        errors.push(
          `Stale plan-level comments: status comment says ${task.id}=${commentStatuses[task.id]}, metadata says ${task.status}`,
        );
        break;
      }
    }
  }

  // 6. Incomplete metadata in node blocks (verify is optional per SKILL.md)
  const requiredFields = ["node", "title", "status", "skill", "scope", "acceptance"];
  for (const task of meta.tasks || []) {
    const block = metadataBlocks[task.id];
    if (!block) {
      errors.push(`Incomplete metadata: missing node block for ${task.id}`);
    } else {
      for (const field of requiredFields) {
        if (!block[field]) {
          errors.push(`Incomplete metadata: missing '${field}' in node block for ${task.id}`);
          break;
        }
      }
    }
  }

  const ok = errors.length === 0;
  process.stdout.write(`${JSON.stringify({ ok, errors }, null, 2)}\n`);
  if (!ok) process.exit(1);
}

// --- Metadata schema validation ---

const VALID_STATUSES = ["done", "inProgress", "blocked", "backlog"];
const REQUIRED_TASK_FIELDS = ["title", "status", "skill", "scope", "acceptance"];

function validateMetadataSchema(meta) {
  if (!meta.planId || typeof meta.planId !== "string" || !meta.planId.trim()) {
    process.stderr.write("Error: Metadata requires a non-empty 'planId' string.\n");
    process.exit(1);
  }
  if (!Array.isArray(meta.tasks)) {
    process.stderr.write("Error: Metadata requires a 'tasks' array.\n");
    process.exit(1);
  }
  for (let i = 0; i < meta.tasks.length; i++) {
    const task = meta.tasks[i];
    for (const field of REQUIRED_TASK_FIELDS) {
      if (!task[field] || typeof task[field] !== "string" || !task[field].trim()) {
        process.stderr.write(
          `Error: Task ${task.id || `[${i}]`} missing required field '${field}'.\n`,
        );
        process.exit(1);
      }
    }
    if (!VALID_STATUSES.includes(task.status)) {
      process.stderr.write(
        `Error: Task ${task.id || `[${i}]`} has invalid status '${task.status}'. Must be one of: ${VALID_STATUSES.join(", ")}\n`,
      );
      process.exit(1);
    }
  }
}

// --- Regenerate command ---

function regenerate(filePath, metadataPath) {
  const metaRaw = safeReadFile(metadataPath);
  let meta;
  try {
    meta = JSON.parse(metaRaw);
  } catch (e) {
    process.stderr.write(`Error: Failed to parse metadata JSON: ${e.message}\n`);
    process.exit(1);
  }

  validateMetadataSchema(meta);

  // Determine existing IDs from previous diagram (if exists)
  const existingIds = new Set();
  if (existsSync(filePath)) {
    const prev = readFileSync(filePath, "utf-8");
    const { graphLines } = splitSections(prev);
    const prevNodes = parseNodes(graphLines);
    for (const n of prevNodes) existingIds.add(n.id);
  }

  // Assign IDs: preserve existing task IDs, assign new sequential ones for tasks without IDs
  const allUsedIds = new Set(existingIds);
  const tasks = meta.tasks.map((t) => {
    if (t.id) {
      allUsedIds.add(t.id);
      return { ...t };
    }
    return { ...t, id: null }; // will assign below
  });

  // Assign IDs to tasks without one
  let nextNum = 1;
  for (const task of tasks) {
    if (!task.id) {
      while (allUsedIds.has(`T${String(nextNum).padStart(3, "0")}`)) nextNum++;
      task.id = `T${String(nextNum).padStart(3, "0")}`;
      allUsedIds.add(task.id);
      nextNum++;
    }
  }

  // Validate dependencies reference existing task IDs
  const taskIdSet = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    for (const dep of task.dependencies || []) {
      if (!taskIdSet.has(dep)) {
        process.stderr.write(`Error: Task dependency references missing task: ${dep}\n`);
        process.exit(1);
      }
    }
  }

  // Sort tasks by ID for determinism
  tasks.sort((a, b) => a.id.localeCompare(b.id));

  // Build plan-level comments
  const statusStr = tasks.map((t) => `${t.id}=${t.status}`).join(", ");

  // Build edges (sorted) for ready/blocked computation
  const edges = [];
  for (const task of tasks) {
    for (const dep of (task.dependencies || []).sort()) {
      edges.push({ from: dep, to: task.id });
    }
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const nodesForCompute = tasks.map((t) => ({ id: t.id, label: t.title, status: t.status }));
  const readyNodes = computeReady(nodesForCompute, edges);
  const blockedNodes = computeBlocked(nodesForCompute, edges);

  const readyStr = readyNodes.length > 0 ? readyNodes.join(", ") : "none";
  const blockedStr = blockedNodes.length > 0 ? blockedNodes.join(", ") : "none";
  const nextAction = readyNodes.length > 0 ? `Start ${readyNodes[0]}` : "No ready tasks";

  // Build output
  const lines = [];
  lines.push(`%% plan: ${meta.planId}`);
  lines.push(`%% status: ${statusStr}`);
  lines.push(`%% ready: ${readyStr}`);
  lines.push(`%% blocked: ${blockedStr}`);
  lines.push(`%% next-action: ${nextAction}`);
  lines.push("");

  // Per-node metadata
  for (const task of tasks) {
    lines.push(`%% node: ${task.id}`);
    lines.push(`%% title: ${task.title}`);
    lines.push(`%% status: ${task.status}`);
    lines.push(`%% skill: ${task.skill}`);
    lines.push(`%% scope: ${task.scope}`);
    if (task.files) lines.push(`%% files: ${task.files}`);
    lines.push(`%% acceptance: ${task.acceptance}`);
    if (task.verify) lines.push(`%% verify: ${task.verify}`);
    const deps = (task.dependencies || []).sort();
    if (deps.length > 0) lines.push(`%% blocked-by: ${deps.join(", ")}`);
    if (task.delegate) lines.push(`%% delegate: ${task.delegate}`);
    lines.push("");
  }

  // Flowchart
  lines.push("flowchart TD");
  lines.push("    classDef done fill:#22c55e,color:#fff");
  lines.push("    classDef inProgress fill:#f59e0b,color:#fff");
  lines.push("    classDef blocked fill:#ef4444,color:#fff");
  lines.push("    classDef backlog fill:#94a3b8,color:#fff");
  lines.push("");

  // Node declarations + edges
  // Declare all nodes first, then edges with bare IDs
  for (const task of tasks) {
    lines.push(`    ${task.id}[${task.title}]:::${task.status}`);
  }

  if (edges.length > 0) {
    lines.push("");
    for (const edge of edges) {
      lines.push(`    ${edge.from} --> ${edge.to}`);
    }
  }

  lines.push("");

  const output = lines.join("\n");
  writeFileSync(filePath, output);

  process.stdout.write(
    `${JSON.stringify(
      { regenerated: true, planId: meta.planId, nodeCount: tasks.length, readyNodes },
      null,
      2,
    )}\n`,
  );
}

function status(filePath, nodeId, newStatus) {
  const validStatuses = ["done", "inProgress", "blocked", "backlog"];
  if (!validStatuses.includes(newStatus)) {
    process.stderr.write(
      `Error: Invalid status '${newStatus}'. Must be one of: ${validStatuses.join(", ")}\n`,
    );
    process.exit(1);
  }

  const content = safeReadFile(filePath);

  if (content.includes("stateDiagram-v2")) {
    process.stderr.write("Error: stateDiagram-v2 is not supported by this tool.\n");
    process.exit(1);
  }

  const { headerLines, graphLines } = splitSections(content);

  if (graphLines.length === 0) {
    process.stderr.write("Error: No flowchart TD found in file.\n");
    process.exit(1);
  }

  // Capture pre-update topology
  const preNodes = parseNodes(graphLines);
  const preEdges = parseEdges(graphLines);
  const preNodeSet = new Set(preNodes.map((n) => n.id));
  const preEdgeSet = new Set(preEdges.map((e) => `${e.from}->${e.to}`));

  if (!preNodeSet.has(nodeId)) {
    process.stderr.write(`Error: Node '${nodeId}' not found in graph.\n`);
    process.exit(1);
  }

  // Update graph lines — change :::status for the target node
  const updatedGraphLines = graphLines.map((line) => {
    // Match node declaration: nodeId[label]:::status — anchored to avoid matching inside labels
    // Uses (?<![\\w]) negative lookbehind instead of \b to prevent matching T001 inside another node's label
    const re = new RegExp(`(?<![\\w])(${nodeId}\\[(?:${LABEL_SRC})\\]):::\\w+`, "g");
    return line.replace(re, `$1:::${newStatus}`);
  });

  // Verify the graph was actually updated (node must have :::class suffix)
  const graphChanged = graphLines.some((line, i) => line !== updatedGraphLines[i]);
  if (!graphChanged) {
    process.stderr.write(
      `Error: Node '${nodeId}' has no :::class suffix in graph declaration. Cannot update status.\n`,
    );
    process.exit(1);
  }

  // Update metadata block status
  const updatedHeaderLines = [];
  let inTargetBlock = false;
  for (const line of headerLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("%%")) {
      const c = trimmed.slice(2).trim();
      const nodeMatch = c.match(/^node:\s*(.+)$/);
      if (nodeMatch) {
        inTargetBlock = nodeMatch[1].trim() === nodeId;
      }
      if (inTargetBlock && c.startsWith("status:")) {
        updatedHeaderLines.push(`%% status: ${newStatus}`);
        continue;
      }
    } else {
      inTargetBlock = false;
    }
    updatedHeaderLines.push(line);
  }

  // Recompute plan-level comments
  const updatedNodes = parseNodes(updatedGraphLines);
  const updatedEdges = parseEdges(updatedGraphLines);
  const readyNodes = computeReady(updatedNodes, updatedEdges);
  const blockedNodes = computeBlocked(updatedNodes, updatedEdges);

  // Build new status comment
  const statusStr = updatedNodes.map((n) => `${n.id}=${n.status}`).join(", ");
  const readyStr = readyNodes.length > 0 ? readyNodes.join(", ") : "none";
  const blockedStr = blockedNodes.length > 0 ? blockedNodes.join(", ") : "none";
  const nextAction = readyNodes.length > 0 ? `Start ${readyNodes[0]}` : "No ready tasks";

  // Replace plan-level comments in header
  const result = [];
  let replacedStatus = false,
    replacedReady = false,
    replacedBlocked = false,
    replacedNext = false;

  const firstNodeIdx = updatedHeaderLines.findIndex((l) => l.trim().startsWith("%% node:"));

  for (let i = 0; i < updatedHeaderLines.length; i++) {
    const line = updatedHeaderLines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("%%")) {
      const c = trimmed.slice(2).trim();
      // Plan-level comments come before first node block
      if (c.startsWith("status:") && !replacedStatus) {
        if (i < firstNodeIdx || firstNodeIdx === -1) {
          result.push(`%% status: ${statusStr}`);
          replacedStatus = true;
          continue;
        }
      }
      if (c.startsWith("ready:") && !replacedReady) {
        result.push(`%% ready: ${readyStr}`);
        replacedReady = true;
        continue;
      }
      if (c.startsWith("blocked:") && !replacedBlocked) {
        // Plan-level blocked
        if (i < firstNodeIdx || firstNodeIdx === -1) {
          result.push(`%% blocked: ${blockedStr}`);
          replacedBlocked = true;
          continue;
        }
      }
      if (c.startsWith("next-action:") && !replacedNext) {
        result.push(`%% next-action: ${nextAction}`);
        replacedNext = true;
        continue;
      }
    }
    result.push(line);
  }

  const finalContent = [...result, ...updatedGraphLines].join("\n");

  // Verify topology unchanged
  const postNodes = parseNodes(updatedGraphLines);
  const postEdges = parseEdges(updatedGraphLines);
  const postNodeSet = new Set(postNodes.map((n) => n.id));
  const postEdgeSet = new Set(postEdges.map((e) => `${e.from}->${e.to}`));

  const nodeSetEqual =
    preNodeSet.size === postNodeSet.size && [...preNodeSet].every((id) => postNodeSet.has(id));
  const edgeSetEqual =
    preEdgeSet.size === postEdgeSet.size && [...preEdgeSet].every((e) => postEdgeSet.has(e));

  if (!nodeSetEqual || !edgeSetEqual) {
    process.stderr.write("Error: Topology changed during status update. Aborting.\n");
    process.exit(1);
  }

  writeFileSync(filePath, finalContent);

  const summary = { updated: true, nodeId, status: newStatus, ready: readyNodes };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function sortMetadata(filePath) {
  const content = safeReadFile(filePath);

  if (content.includes("stateDiagram-v2")) {
    process.stderr.write("Error: stateDiagram-v2 is not supported by this tool.\n");
    process.exit(1);
  }

  const lines = content.split("\n");
  const flowchartIdx = lines.findIndex((l) => /^\s*flowchart\s+TD/i.test(l));

  if (flowchartIdx === -1) {
    process.stderr.write("Error: No flowchart TD found in file.\n");
    process.exit(1);
  }

  const headerLines = lines.slice(0, flowchartIdx);
  const graphLines = lines.slice(flowchartIdx);

  // Separate plan-level comments from node metadata blocks
  const planComments = [];
  const nodeBlocks = []; // array of { id, lines }
  let currentBlock = null;

  for (const line of headerLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("%%")) {
      const c = trimmed.slice(2).trim();
      const nodeMatch = c.match(/^node:\s*(.+)$/);
      if (nodeMatch) {
        if (currentBlock) nodeBlocks.push(currentBlock);
        currentBlock = { id: nodeMatch[1].trim(), lines: [line] };
        continue;
      }
      if (currentBlock) {
        currentBlock.lines.push(line);
        continue;
      }
    } else if (trimmed === "" && currentBlock) {
      // Empty line after a node block — keep as separator
      currentBlock.lines.push(line);
      nodeBlocks.push(currentBlock);
      currentBlock = null;
      continue;
    } else if (currentBlock) {
      // Non-comment line ends the block
      nodeBlocks.push(currentBlock);
      currentBlock = null;
    }

    if (!currentBlock) {
      planComments.push(line);
    }
  }
  if (currentBlock) nodeBlocks.push(currentBlock);

  // Sort node blocks by ID
  nodeBlocks.sort((a, b) => a.id.localeCompare(b.id));

  // Reassemble
  const sortedHeader = [...planComments, ...nodeBlocks.flatMap((block) => block.lines)];

  // Ensure blank line between header and flowchart
  const lastHeaderLine = sortedHeader[sortedHeader.length - 1];
  if (lastHeaderLine && lastHeaderLine.trim() !== "") {
    sortedHeader.push("");
  }

  const finalContent = [...sortedHeader, ...graphLines].join("\n");
  writeFileSync(filePath, finalContent);

  const sortedIds = nodeBlocks.map((b) => b.id);
  process.stdout.write(`${JSON.stringify({ sorted: true, order: sortedIds }, null, 2)}\n`);
}

// --- CLI ---

const [, , command, filePath, ...args] = process.argv;

if (!command || !filePath) {
  process.stderr.write("Usage: manage-diagram.mjs <command> <file> [args...]\n");
  process.stderr.write("Commands: inspect, ready, validate, status, sort-metadata, regenerate\n");
  process.exit(1);
}

switch (command) {
  case "inspect":
    inspect(filePath);
    break;
  case "ready":
    ready(filePath);
    break;
  case "validate": {
    const metaIdx = args.indexOf("--metadata");
    const metaPath = metaIdx !== -1 ? args[metaIdx + 1] : null;
    validate(filePath, metaPath);
    break;
  }
  case "status":
    if (args.length < 2) {
      process.stderr.write("Usage: manage-diagram.mjs status <file> <nodeId> <newStatus>\n");
      process.exit(1);
    }
    status(filePath, args[0], args[1]);
    break;
  case "sort-metadata":
    sortMetadata(filePath);
    break;
  case "regenerate": {
    const metaIdx = args.indexOf("--metadata");
    if (metaIdx === -1 || !args[metaIdx + 1]) {
      process.stderr.write(
        "Usage: manage-diagram.mjs regenerate <file> --metadata <metadata.json>\n",
      );
      process.exit(1);
    }
    regenerate(filePath, args[metaIdx + 1]);
    break;
  }
  default:
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exit(1);
}
