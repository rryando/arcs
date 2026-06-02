import { execSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface GraphifyInfo {
  available: boolean;
  version?: string;
  path?: string;
}

export function detectGraphify(): GraphifyInfo {
  try {
    const version = execSync("graphify --version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    const resolvedPath = execSync("which graphify", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    // Extract semver from output (e.g. "graphify 0.8.18" or just "0.8.18")
    const match = version.match(/(\d+\.\d+\.\d+)/);

    return {
      available: true,
      version: match ? match[1] : version,
      path: resolvedPath || undefined,
    };
  } catch {
    return { available: false };
  }
}

export interface ExtractionResult {
  success: true;
  graphJsonPath: string;
}

export interface ExtractionError {
  success: false;
  error: string;
  code?: string;
}

export type ExtractionOutcome = ExtractionResult | ExtractionError;

// --- Knowledge Ingestion ---

/**
 * A graphify-derived knowledge proposal.
 *
 * Carries STRUCTURAL FACTS only — not prose. The calling agent (which has LLM
 * tokens) is responsible for producing the final `title`/`summary`/`keywords`
 * during the proposal-promote step. See plan
 * `2026-06-02-graphify-proposal-gate-implementation-plan` §Proposal Shape.
 *
 * `suggestedDedupCandidates` is intentionally NOT on this type — that's
 * computed by the proposal-store layer when proposals are written to disk,
 * not at ingest time.
 */
export interface KnowledgeProposal {
  /** Stable id, e.g. "graphify-cluster-src-utils". */
  id: string;
  kind: "architecture" | "module" | "gotcha" | "pattern";
  /** Human-friendly label. Agents will write the final title. */
  label: string;
  structuralFacts: ProposalStructuralFacts;
  sourceFiles: Array<{ path: string; anchor?: string }>;
}

export interface ProposalStructuralFacts {
  // --- Cluster proposals ---
  memberCount?: number;
  fileCount?: number;
  /** e.g. { code: 260, document: 0 } */
  fileTypeBreakdown?: Record<string, number>;
  topHubs?: Array<{ label: string; file: string; in: number; out: number }>;
  topFilesByEntityCount?: Array<{ file: string; count: number }>;
  incomingFromOtherClusters?: number;
  outgoingToOtherClusters?: number;

  // --- God-node proposals ---
  nodeFile?: string;
  nodeIn?: number;
  nodeOut?: number;
  topCallers?: Array<{ label: string; file: string }>;
  topCallees?: Array<{ label: string; file: string }>;

  // --- Coupling proposals ---
  couplingA?: { label: string; file: string; degree: number };
  couplingB?: { label: string; file: string; degree: number };
  /** Edge relation types (e.g. ["imports_from", "calls"]). */
  relations?: string[];
}

export interface IngestionResult {
  proposals: KnowledgeProposal[];
  stats: {
    godNodes: number;
    communities: number;
    crossModuleCouplings: number;
    totalProposals: number;
  };
}

// Graphify output format (from `graphify update` or `graphify extract`)
interface RawGraphNode {
  id: string;
  label: string;
  file_type?: string;
  source_file?: string;
  source_location?: string;
  // Clustered graphs may include these:
  type?: string;
  file?: string;
  community?: number;
  degree?: number;
  metadata?: Record<string, unknown>;
}

interface RawGraphLink {
  source: string;
  target: string;
  relation?: string;
  type?: string;
  confidence?: string;
  source_file?: string;
  weight?: number;
}

interface GraphCommunity {
  id: number;
  label: string;
  nodes: string[];
  summary?: string;
}

interface RawGraphJson {
  nodes: RawGraphNode[];
  links?: RawGraphLink[];
  edges?: RawGraphLink[];
  communities?: GraphCommunity[];
}

// Normalized internal node with computed fields
interface GraphNode {
  id: string;
  label: string;
  type: string;
  fileType: string;
  file: string;
  community: number;
  degree: number;
  inDegree: number;
  outDegree: number;
}

interface ParsedGraph {
  nodes: GraphNode[];
  communities: GraphCommunity[];
  links: RawGraphLink[];
}

function parseGraphJson(graphPath: string): ParsedGraph | null {
  try {
    const raw = readFileSync(graphPath, "utf-8");
    const data: RawGraphJson = JSON.parse(raw);
    if (!Array.isArray(data?.nodes) || data.nodes.length === 0) return null;

    // Normalize links (graphify uses "links" key; older format used "edges")
    const links = data.links || data.edges || [];

    // Compute degree (total) plus directional in/out per node
    const degreeMap = new Map<string, number>();
    const inMap = new Map<string, number>();
    const outMap = new Map<string, number>();
    for (const link of links) {
      degreeMap.set(link.source, (degreeMap.get(link.source) || 0) + 1);
      degreeMap.set(link.target, (degreeMap.get(link.target) || 0) + 1);
      outMap.set(link.source, (outMap.get(link.source) || 0) + 1);
      inMap.set(link.target, (inMap.get(link.target) || 0) + 1);
    }

    // Normalize nodes
    const nodes: GraphNode[] = data.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      type: n.type || n.file_type || "unknown",
      fileType: n.file_type || n.type || "unknown",
      file: n.file || n.source_file || "",
      community: n.community ?? -1,
      degree: n.degree ?? degreeMap.get(n.id) ?? 0,
      inDegree: inMap.get(n.id) ?? 0,
      outDegree: outMap.get(n.id) ?? 0,
    }));

    // Use communities if available; otherwise synthesize from source_file grouping
    const communities: GraphCommunity[] = data.communities || [];
    if (communities.length === 0) {
      // Group nodes by directory prefix as pseudo-communities
      const dirGroups = new Map<string, string[]>();
      for (const node of nodes) {
        if (!node.file) continue;
        const dir = node.file.split("/").slice(0, -1).join("/") || ".";
        const list = dirGroups.get(dir) || [];
        list.push(node.id);
        dirGroups.set(dir, list);
      }
      let communityId = 0;
      for (const [dir, nodeIds] of dirGroups) {
        if (nodeIds.length >= 3) {
          communities.push({
            id: communityId++,
            label: dir,
            nodes: nodeIds,
          });
        }
      }
    }

    return { nodes, communities, links };
  } catch {
    return null;
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const frac = idx - lower;
  if (lower + 1 >= sorted.length) return sorted[lower];
  return sorted[lower] + frac * (sorted[lower + 1] - sorted[lower]);
}

export function ingestGraph(graphJsonPath: string, _slug: string): IngestionResult {
  const empty: IngestionResult = {
    proposals: [],
    stats: { godNodes: 0, communities: 0, crossModuleCouplings: 0, totalProposals: 0 },
  };

  const graph = parseGraphJson(graphJsonPath);
  if (!graph || graph.nodes.length === 0) return empty;

  const proposals: KnowledgeProposal[] = [];
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

  // God nodes (degree > 95th percentile — top 5% most connected)
  // Exclude test files — they naturally import many modules but aren't architectural hubs
  const isTestFile = (file: string) =>
    /\.(test|spec)\.[jt]sx?$/.test(file) ||
    file.startsWith("test/") ||
    file.startsWith("tests/") ||
    file.includes("/__tests__/");

  const degrees = graph.nodes.map((n) => n.degree).filter((d) => d > 0);
  const threshold = percentile(degrees, 95);
  const godNodes = graph.nodes
    .filter((n) => n.degree > threshold && n.file && !isTestFile(n.file))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 8); // cap god nodes at 8 to leave room for other kinds

  for (const node of godNodes) {
    // Top callers: nodes with edge → this node, ranked by their own degree.
    const callerDegreeById = new Map<string, number>();
    const calleeDegreeById = new Map<string, number>();
    for (const link of graph.links) {
      if (link.target === node.id && link.source !== node.id) {
        const src = nodeMap.get(link.source);
        if (src) callerDegreeById.set(src.id, src.degree);
      }
      if (link.source === node.id && link.target !== node.id) {
        const tgt = nodeMap.get(link.target);
        if (tgt) calleeDegreeById.set(tgt.id, tgt.degree);
      }
    }

    const topCallers = [...callerDegreeById.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => {
        const n = nodeMap.get(id);
        return n ? { label: n.label, file: n.file } : null;
      })
      .filter((x): x is { label: string; file: string } => x !== null);

    const topCallees = [...calleeDegreeById.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => {
        const n = nodeMap.get(id);
        return n ? { label: n.label, file: n.file } : null;
      })
      .filter((x): x is { label: string; file: string } => x !== null);

    proposals.push({
      id: makeProposalId("graphify-god", `${node.label}-${node.file}`),
      kind: "module",
      label: node.label,
      structuralFacts: {
        nodeFile: node.file,
        nodeIn: node.inDegree,
        nodeOut: node.outDegree,
        topCallers,
        topCallees,
      },
      sourceFiles: [{ path: node.file }],
    });
  }

  // Community clusters (sorted by size desc, top 8). Drop document-only clusters.
  const allCommunities = [...(graph.communities || [])].sort(
    (a, b) => b.nodes.length - a.nodes.length,
  );

  // Build community-membership map for cross-cluster degree calculations.
  const communityIdByNode = new Map<string, number>();
  for (const c of allCommunities) {
    for (const nodeId of c.nodes) communityIdByNode.set(nodeId, c.id);
  }

  const survivingCommunities: GraphCommunity[] = [];
  for (const community of allCommunities) {
    const members = community.nodes.map((id) => nodeMap.get(id)).filter((n): n is GraphNode => !!n);
    if (members.length === 0) continue;
    // Filtering rule: drop the cluster if EVERY member has file_type === "document".
    const hasNonDocument = members.some((m) => m.fileType !== "document");
    if (!hasNonDocument) continue;
    survivingCommunities.push(community);
    if (survivingCommunities.length >= 8) break;
  }

  for (const community of survivingCommunities) {
    const members = community.nodes.map((id) => nodeMap.get(id)).filter((n): n is GraphNode => !!n);

    // memberCount, fileCount, fileTypeBreakdown
    const memberCount = members.length;
    const fileSet = new Set<string>();
    const fileTypeBreakdown: Record<string, number> = {};
    const fileEntityCount = new Map<string, number>();
    for (const m of members) {
      if (m.file) fileSet.add(m.file);
      const ft = m.fileType || "unknown";
      fileTypeBreakdown[ft] = (fileTypeBreakdown[ft] || 0) + 1;
      if (m.file) {
        fileEntityCount.set(m.file, (fileEntityCount.get(m.file) || 0) + 1);
      }
    }

    // topHubs: top 3 by in+out
    const topHubs = [...members]
      .sort((a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree))
      .slice(0, 3)
      .filter((m) => m.inDegree + m.outDegree > 0)
      .map((m) => ({ label: m.label, file: m.file, in: m.inDegree, out: m.outDegree }));

    // topFilesByEntityCount: top 3
    const topFilesByEntityCount = [...fileEntityCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([file, count]) => ({ file, count }));

    // Cross-cluster degree: count links where one endpoint is in this community
    // and the other endpoint is in a DIFFERENT community.
    const memberIds = new Set(community.nodes);
    let incoming = 0;
    let outgoing = 0;
    for (const link of graph.links) {
      const srcInCluster = memberIds.has(link.source);
      const tgtInCluster = memberIds.has(link.target);
      if (srcInCluster === tgtInCluster) continue; // same-side or both-out → ignore
      // Only count edges where the OTHER endpoint belongs to some community
      // (otherwise it's not "another cluster", just stray nodes).
      const otherId = srcInCluster ? link.target : link.source;
      const otherCommunity = communityIdByNode.get(otherId);
      if (otherCommunity === undefined || otherCommunity === community.id) continue;
      if (srcInCluster) outgoing++;
      else incoming++;
    }

    const uniqueFiles = [...fileSet];
    proposals.push({
      id: makeProposalId("graphify-cluster", community.label),
      kind: "architecture",
      label: community.label,
      structuralFacts: {
        memberCount,
        fileCount: uniqueFiles.length,
        fileTypeBreakdown,
        topHubs,
        topFilesByEntityCount,
        incomingFromOtherClusters: incoming,
        outgoingToOtherClusters: outgoing,
      },
      sourceFiles: uniqueFiles.map((p) => ({ path: p })),
    });
  }

  // Cross-module coupling: links between different top-level dirs where at least one is god.
  type CouplingCandidate = {
    a: GraphNode;
    b: GraphNode;
    relations: Set<string>;
    combinedDegree: number;
  };
  const couplingByKey = new Map<string, CouplingCandidate>();
  for (const link of graph.links) {
    const nodeA = nodeMap.get(link.source);
    const nodeB = nodeMap.get(link.target);
    if (!nodeA || !nodeB || !nodeA.file || !nodeB.file) continue;
    if (isTestFile(nodeA.file) || isTestFile(nodeB.file)) continue;
    const dirA = nodeA.file.split("/").slice(0, 2).join("/");
    const dirB = nodeB.file.split("/").slice(0, 2).join("/");
    if (!dirA || !dirB || dirA === dirB) continue;
    if (nodeA.degree <= threshold && nodeB.degree <= threshold) continue;

    const [first, second] =
      nodeA.id < nodeB.id ? ([nodeA, nodeB] as const) : ([nodeB, nodeA] as const);
    const key = `${first.id}|${second.id}`;
    const existing = couplingByKey.get(key);
    if (existing) {
      if (link.relation) existing.relations.add(link.relation);
    } else {
      couplingByKey.set(key, {
        a: first,
        b: second,
        relations: new Set(link.relation ? [link.relation] : []),
        combinedDegree: first.degree + second.degree,
      });
    }
  }

  const couplings = [...couplingByKey.values()]
    .sort((x, y) => y.combinedDegree - x.combinedDegree)
    .slice(0, 5);

  for (const { a, b, relations } of couplings) {
    proposals.push({
      id: makeProposalId("graphify-coupling", `${a.label}-${b.label}`),
      kind: "gotcha",
      label: `${a.label} ↔ ${b.label}`,
      structuralFacts: {
        couplingA: { label: a.label, file: a.file, degree: a.degree },
        couplingB: { label: b.label, file: b.file, degree: b.degree },
        relations: [...relations],
      },
      sourceFiles: [{ path: a.file }, { path: b.file }],
    });
  }

  // Cap at 20
  const capped = proposals.slice(0, 20);

  return {
    proposals: capped,
    stats: {
      godNodes: godNodes.length,
      communities: survivingCommunities.length,
      crossModuleCouplings: capped.filter((p) => p.kind === "gotcha").length,
      totalProposals: capped.length,
    },
  };
}

/**
 * Slugify a label suffix and prefix it. Stable, lowercase, dash-separated.
 * E.g. makeProposalId("graphify-cluster", "src/utils") → "graphify-cluster-src-utils".
 */
function makeProposalId(prefix: string, suffix: string): string {
  const slug = suffix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug ? `${prefix}-${slug}` : prefix;
}

// --- Graph Query ---

export interface QueryResult {
  success: true;
  answer: string;
}

export interface QueryError {
  success: false;
  error: string;
}

export type QueryOutcome = QueryResult | QueryError;

export function queryGraph(question: string, workspacePath: string): QueryOutcome {
  const info = detectGraphify();
  if (!info.available) {
    return { success: false, error: "graphify binary not found" };
  }

  const graphPath = join(resolve(workspacePath), "graphify-out", "graph.json");
  if (!existsSync(graphPath)) {
    return { success: false, error: "graph.json not found" };
  }

  const result = spawnSync("graphify", ["query", question, "--graph", graphPath], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });

  if (result.error) {
    return { success: false, error: result.error.message };
  }

  if (result.status !== 0) {
    return { success: false, error: result.stderr?.trim() || "Query failed" };
  }

  return { success: true, answer: result.stdout.trim() };
}

export function pathBetween(entityA: string, entityB: string, workspacePath: string): QueryOutcome {
  const info = detectGraphify();
  if (!info.available) {
    return { success: false, error: "graphify binary not found" };
  }

  const graphPath = join(resolve(workspacePath), "graphify-out", "graph.json");
  if (!existsSync(graphPath)) {
    return { success: false, error: "graph.json not found" };
  }

  const result = spawnSync("graphify", ["path", entityA, entityB, "--graph", graphPath], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });

  if (result.error) {
    return { success: false, error: result.error.message };
  }

  if (result.status !== 0) {
    return { success: false, error: result.stderr?.trim() || "Path query failed" };
  }

  return { success: true, answer: result.stdout.trim() };
}

export function runExtraction(workspacePath: string): ExtractionOutcome {
  const info = detectGraphify();
  if (!info.available) {
    return {
      success: false,
      error: "graphify binary not found",
      code: "ENOENT",
    };
  }

  const absolutePath = resolve(workspacePath);
  // Use `update --force --no-cluster` for AST-only extraction (no LLM API key needed)
  const result = spawnSync("graphify", ["update", absolutePath, "--force", "--no-cluster"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120_000,
    cwd: absolutePath,
  });

  if (result.error) {
    const errCode = (result.error as NodeJS.ErrnoException).code;
    return {
      success: false,
      error: result.error.message,
      code: errCode === "ETIMEDOUT" ? "ETIMEDOUT" : errCode,
    };
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "Process exited with non-zero status";
    return {
      success: false,
      error: stderr,
      code: `EXIT_${result.status}`,
    };
  }

  const graphJsonPath = join(absolutePath, "graphify-out", "graph.json");

  if (!existsSync(graphJsonPath)) {
    return {
      success: false,
      error: "Extraction completed but graph.json not found",
      code: "ENOENT",
    };
  }

  // Ensure graphify-out/ is in .gitignore so extraction output doesn't pollute the repo
  ensureGitignoreEntry(absolutePath, "graphify-out/");

  return {
    success: true,
    graphJsonPath,
  };
}

/**
 * Append an entry to .gitignore if it's not already present.
 * Creates the file if it doesn't exist.
 */
function ensureGitignoreEntry(workspacePath: string, entry: string): void {
  const gitignorePath = join(workspacePath, ".gitignore");
  try {
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, "utf-8");
      // Check if entry already present (exact line match)
      const lines = content.split("\n").map((l) => l.trim());
      if (lines.includes(entry)) return;
      // Append with newline separator if file doesn't end with one
      const separator = content.endsWith("\n") ? "" : "\n";
      appendFileSync(gitignorePath, `${separator}${entry}\n`, "utf-8");
    } else {
      // Create .gitignore with the entry
      appendFileSync(gitignorePath, `${entry}\n`, "utf-8");
    }
  } catch {
    // Non-fatal — don't fail extraction over .gitignore issues
  }
}
