import { execSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

export interface CodegraphInfo {
  available: boolean;
  version?: string;
  path?: string;
}

export function detectCodegraph(): CodegraphInfo {
  try {
    const version = execSync("codegraph --version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    const resolvedPath = execSync("which codegraph", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    // Extract semver from output (e.g. "codegraph 0.9.9" or just "0.9.9")
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

// --- codegraph status shape ---

export interface CodegraphStatus {
  initialized: boolean;
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  nodesByKind: Record<string, number>;
  [key: string]: unknown;
}

export interface ExtractionResult {
  success: true;
  status: CodegraphStatus;
}

export interface ExtractionError {
  success: false;
  error: string;
  code?: string;
}

export type ExtractionOutcome = ExtractionResult | ExtractionError;

// --- Knowledge Ingestion ---

/**
 * A codegraph-derived knowledge proposal.
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
  /** Stable id, e.g. "codegraph-cluster-src-utils". */
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

// --- codegraph CLI JSON shapes ---

interface CgFile {
  path: string;
  language?: string;
  nodeCount?: number;
  size?: number;
}

interface CgNode {
  id: string;
  kind?: string;
  name?: string;
  qualifiedName?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
  docstring?: string;
  isExported?: boolean;
  [key: string]: unknown;
}

interface CgQueryHit {
  node: CgNode;
  score?: number;
}

interface CgRelative {
  name?: string;
  kind?: string;
  filePath?: string;
  startLine?: number;
}

interface CgCallersResult {
  symbol: string;
  callers: CgRelative[];
}

interface CgCalleesResult {
  symbol: string;
  callees: CgRelative[];
}

// --- Shared predicates / helpers ---

/**
 * Test files import/define many symbols but aren't architectural hubs.
 */
const isTestFile = (file: string) =>
  /\.(test|spec)\.[jt]sx?$/.test(file) ||
  file.startsWith("test/") ||
  file.startsWith("tests/") ||
  file.includes("/__tests__/");

/** First N path segments (default 2), e.g. "src/utils/foo.ts" → "src/utils". */
function dirPrefix(file: string, segments = 2): string {
  return file.split("/").slice(0, segments).join("/");
}

/**
 * Run a codegraph CLI subcommand and parse its stdout as JSON.
 *
 * CRITICAL: codegraph prints plain-text "Symbol X not found" notices (with
 * ANSI codes) to stdout/stderr even with --json, and exits 0. There is no JSON
 * payload in that case. Every parse must therefore be guarded — empty or
 * non-JSON stdout → null (no-data), NEVER throw.
 */
function runCgJson<T>(args: string[], timeout = 15_000): T | null {
  try {
    const result = spawnSync("codegraph", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
    });
    if (result.error) return null;
    const out = (result.stdout || "").trim();
    if (!out) return null;
    // Guarded parse — plain-text "not found" notices are not valid JSON.
    try {
      return JSON.parse(out) as T;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function cgStatus(): CodegraphStatus | null {
  const status = runCgJson<CodegraphStatus>(["status", "--json"], 15_000);
  if (!status || typeof status.initialized !== "boolean") return null;
  return status;
}

function cgFiles(): CgFile[] {
  const files = runCgJson<CgFile[]>(["files", "--json"], 15_000);
  return Array.isArray(files) ? files : [];
}

function cgQueryFunctions(term: string, limit: number): CgNode[] {
  const hits = runCgJson<CgQueryHit[]>(
    ["query", term, "--kind", "function", "--limit", String(limit), "--json"],
    15_000,
  );
  if (!Array.isArray(hits)) return [];
  return hits.map((h) => h?.node).filter((n): n is CgNode => !!n && typeof n.id === "string");
}

function cgCallers(name: string, limit: number): CgRelative[] {
  const res = runCgJson<CgCallersResult>(
    ["callers", name, "--limit", String(limit), "--json"],
    15_000,
  );
  return res && Array.isArray(res.callers) ? res.callers : [];
}

function cgCallees(name: string, limit: number): CgRelative[] {
  const res = runCgJson<CgCalleesResult>(
    ["callees", name, "--limit", String(limit), "--json"],
    15_000,
  );
  return res && Array.isArray(res.callees) ? res.callees : [];
}

/**
 * Approximate file "type" buckets from language/extension
 * (code vs document vs other).
 */
function fileTypeOf(file: CgFile): string {
  const ext = extname(file.path).toLowerCase();
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs") {
    return "code";
  }
  if (ext === ".md" || ext === ".mdx") return "document";
  const lang = (file.language || "").toLowerCase();
  if (lang === "typescript" || lang === "javascript") return "code";
  if (lang === "markdown") return "document";
  return lang || "unknown";
}

// --- runIndex ---

export function runIndex(workspacePath: string): ExtractionOutcome {
  const info = detectCodegraph();
  if (!info.available) {
    return {
      success: false,
      error: "codegraph binary not found",
      code: "ENOENT",
    };
  }

  const absolutePath = resolve(workspacePath);
  // `index <path> --force --quiet` is side-effecting and non-interactive.
  // (`init -i` is deprecated.) No --json on this command.
  const result = spawnSync("codegraph", ["index", absolutePath, "--force", "--quiet"], {
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

  // Ensure .codegraph/ is in .gitignore so the index db doesn't pollute the repo.
  ensureGitignoreEntry(absolutePath, ".codegraph/");

  const status = cgStatus();
  if (!status) {
    return {
      success: false,
      error: "Index completed but codegraph status returned no valid JSON",
      code: "ENODATA",
    };
  }
  if (!status.initialized) {
    return {
      success: false,
      error: "Index completed but codegraph reports not initialized",
      code: "ENOINIT",
    };
  }

  return {
    success: true,
    status,
  };
}

// --- ingestGraph (CLI-only) ---

export function ingestGraph(_workspacePath: string, _slug: string): IngestionResult {
  const empty: IngestionResult = {
    proposals: [],
    stats: { godNodes: 0, communities: 0, crossModuleCouplings: 0, totalProposals: 0 },
  };

  const info = detectCodegraph();
  if (!info.available) return empty;

  // (a) status
  const status = cgStatus();
  if (!status?.initialized || status.nodeCount <= 0) return empty;

  // (b) files (minus test files)
  const allFiles = cgFiles();
  const files = allFiles.filter((f) => f?.path && !isTestFile(f.path));
  if (files.length === 0) return empty;

  const proposals: KnowledgeProposal[] = [];

  // ----- (c) PSEUDO-COMMUNITIES: group by first-2 path segments -----
  interface Community {
    prefix: string;
    files: CgFile[];
    memberCount: number; // Σ nodeCount
  }
  const communityMap = new Map<string, CgFile[]>();
  for (const f of files) {
    const prefix = dirPrefix(f.path);
    if (!prefix) continue;
    const list = communityMap.get(prefix) || [];
    list.push(f);
    communityMap.set(prefix, list);
  }

  const communities: Community[] = [];
  for (const [prefix, groupFiles] of communityMap) {
    if (groupFiles.length < 3) continue;
    const memberCount = groupFiles.reduce((sum, f) => sum + (f.nodeCount || 0), 0);
    communities.push({ prefix, files: groupFiles, memberCount });
  }
  // Cap surviving communities at 8 (largest first, by member/node count).
  communities.sort((a, b) => b.memberCount - a.memberCount);
  const survivingCommunities = communities.slice(0, 8);

  for (const community of survivingCommunities) {
    const fileTypeBreakdown: Record<string, number> = {};
    for (const f of community.files) {
      const t = fileTypeOf(f);
      fileTypeBreakdown[t] = (fileTypeBreakdown[t] || 0) + 1;
    }

    const topFilesByEntityCount = [...community.files]
      .sort((a, b) => (b.nodeCount || 0) - (a.nodeCount || 0))
      .slice(0, 3)
      .map((f) => ({ file: f.path, count: f.nodeCount || 0 }));

    // Heuristic: large top-level communities → "architecture", others → "module".
    // "src" / 2-segment prefixes that are big are architectural surfaces.
    const isArchitectural =
      community.files.length >= 8 || community.memberCount >= 100 || community.prefix === "src";

    proposals.push({
      id: makeProposalId("codegraph-cluster", community.prefix),
      kind: isArchitectural ? "architecture" : "module",
      label: community.prefix,
      structuralFacts: {
        memberCount: community.memberCount,
        fileCount: community.files.length,
        fileTypeBreakdown,
        topFilesByEntityCount,
      },
      sourceFiles: community.files.map((f) => ({ path: f.path })),
    });
  }

  // ----- (d) GOD-NODES -----
  // Pre-filter: densest ~30 files by nodeCount.
  const densestFiles = [...files]
    .filter((f) => (f.nodeCount || 0) > 0)
    .sort((a, b) => (b.nodeCount || 0) - (a.nodeCount || 0))
    .slice(0, 30);

  // Collect candidate function nodes via per-file basename query.
  const candidatesById = new Map<string, CgNode>();
  for (const f of densestFiles) {
    if (candidatesById.size >= 40) break;
    const term = basename(f.path, extname(f.path));
    if (!term) continue;
    const hits = cgQueryFunctions(term, 5);
    for (const node of hits) {
      if (candidatesById.size >= 40) break;
      if (!candidatesById.has(node.id)) candidatesById.set(node.id, node);
    }
  }

  // Score each candidate by callers + callees (guarded). Bounded: <=40 × 2 calls.
  interface ScoredNode {
    node: CgNode;
    callers: CgRelative[];
    callees: CgRelative[];
    score: number;
  }
  const scored: ScoredNode[] = [];
  for (const node of candidatesById.values()) {
    const name = node.name;
    if (!name) continue;
    const callers = cgCallers(name, 100);
    const callees = cgCallees(name, 100);
    scored.push({ node, callers, callees, score: callers.length + callees.length });
  }

  const godNodes = scored
    .filter((s) => !!s.node.filePath && !isTestFile(s.node.filePath as string))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  for (const g of godNodes) {
    const nodeFile = g.node.filePath as string;
    const topCallers = g.callers
      .slice(0, 5)
      .map((c) => ({ label: c.name || "", file: c.filePath || "" }));
    const topCallees = g.callees
      .slice(0, 5)
      .map((c) => ({ label: c.name || "", file: c.filePath || "" }));

    proposals.push({
      id: makeProposalId("codegraph-god", `${g.node.name}-${nodeFile}`),
      kind: "module",
      label: g.node.name || nodeFile,
      structuralFacts: {
        nodeFile,
        nodeIn: g.callers.length,
        nodeOut: g.callees.length,
        topCallers,
        topCallees,
      },
      sourceFiles: [{ path: nodeFile }],
    });
  }

  // ----- (e) CROSS-MODULE COUPLING -----
  // From god-node callers+callees, aggregate edges crossing dir prefixes.
  interface CouplingAgg {
    prefixA: string;
    prefixB: string;
    count: number;
    fileA: string;
    fileB: string;
  }
  const couplingByPair = new Map<string, CouplingAgg>();

  for (const g of godNodes) {
    const nodeFile = g.node.filePath as string;
    const nodePrefix = dirPrefix(nodeFile);
    const edges = [...g.callers, ...g.callees];
    for (const edge of edges) {
      const edgeFile = edge.filePath;
      if (!edgeFile || isTestFile(edgeFile)) continue;
      const edgePrefix = dirPrefix(edgeFile);
      if (!nodePrefix || !edgePrefix || nodePrefix === edgePrefix) continue;

      // Canonicalize the pair so (A,B) and (B,A) aggregate together.
      const [pA, pB, fA, fB] =
        nodePrefix < edgePrefix
          ? [nodePrefix, edgePrefix, nodeFile, edgeFile]
          : [edgePrefix, nodePrefix, edgeFile, nodeFile];
      const key = `${pA}|${pB}`;
      const existing = couplingByPair.get(key);
      if (existing) {
        existing.count++;
      } else {
        couplingByPair.set(key, { prefixA: pA, prefixB: pB, count: 1, fileA: fA, fileB: fB });
      }
    }
  }

  const topCouplings = [...couplingByPair.values()].sort((a, b) => b.count - a.count).slice(0, 5);

  for (const c of topCouplings) {
    proposals.push({
      id: makeProposalId("codegraph-coupling", `${c.prefixA}-${c.prefixB}`),
      kind: "gotcha",
      label: `${c.prefixA} ↔ ${c.prefixB}`,
      structuralFacts: {
        couplingA: { label: c.prefixA, file: c.fileA, degree: c.count },
        couplingB: { label: c.prefixB, file: c.fileB, degree: c.count },
        // codegraph exposes no edge-type labels — hard-coded per spike.
        relations: ["calls"],
      },
      sourceFiles: [{ path: c.fileA }, { path: c.fileB }],
    });
  }

  // ----- (f) Cap total at 20 -----
  const capped = proposals.slice(0, 20);

  return {
    proposals: capped,
    stats: {
      godNodes: capped.filter((p) => p.id.startsWith("codegraph-god-")).length,
      communities: capped.filter((p) => p.id.startsWith("codegraph-cluster-")).length,
      crossModuleCouplings: capped.filter((p) => p.id.startsWith("codegraph-coupling-")).length,
      totalProposals: capped.length,
    },
  };
}

/**
 * Slugify a label suffix and prefix it. Stable, lowercase, dash-separated.
 * E.g. makeProposalId("codegraph-cluster", "src/utils") → "codegraph-cluster-src-utils".
 */
function makeProposalId(prefix: string, suffix: string): string {
  const slug = suffix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug ? `${prefix}-${slug}` : prefix;
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
    // Non-fatal — don't fail over .gitignore issues
  }
}
