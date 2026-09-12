import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type CodeRef, DEFAULT_MAX_LINES } from "./code-snippet.js";
import type { KnowledgeProposal } from "./codegraph.js";
import { resolveWorkspaceRoot } from "./knowledge-store.js";
import { getProjectDir } from "./paths.js";
import {
  annotateDedupCandidates,
  computeGraphFingerprint,
  type Proposal,
  type ProposalsFile,
  readProposals,
  writeProposals,
} from "./proposal-store.js";

// ---------------------------------------------------------------------------
// Deterministic anchor → line-range resolution
//
// A proposal source file may carry only a free-text `anchor` (typically a
// symbol name) and no line range. Resolving that anchor to a range is pure
// text work over the ONE named file — no repo scan, no git, no LLM.
// ---------------------------------------------------------------------------

/** Where an anchor was found and what range it resolves to. */
export interface AnchorRange {
  /** First line of the enclosing range (1-indexed, inclusive). */
  startLine: number;
  /** Last line of the enclosing range (1-indexed, inclusive). */
  endLine: number;
  /** Line of the chosen whole-word match (1-indexed). */
  matchLine: number;
  /** Number of whole-word matches found in the file. */
  matchCount: number;
  /** True when more than one match existed and the first was chosen. */
  firstMatch: boolean;
}

/** Lines of context on each side of the anchor when no enclosing block is found. */
const ANCHOR_WINDOW_RADIUS = 3;

/** Identifier characters used for whole-word boundary checks. */
function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/** Offsets at which each line starts (line i is `starts[i-1]..starts[i]-1`). */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 1-indexed line containing `offset`, via binary search of `starts`. */
function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Nearest enclosing brace-balanced block around `offset`, or null when the
 * match has no enclosing `{`.
 *
 * HEURISTIC: scan backwards to the first `{` that is not matched by a `}`
 * between it and the match; then scan forwards until its depth returns to
 * zero. This is a syntactic approximation — braces inside strings or comments
 * are counted — but it is deterministic, bounded (the caller caps it), and
 * never reads anything but this file. An unbalanced block runs to EOF.
 */
function enclosingBraceBlock(text: string, offset: number): { start: number; end: number } | null {
  let depth = 0;
  let open = -1;
  for (let i = offset; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") {
      depth++;
    } else if (ch === "{") {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open === -1) return null;

  let d = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") d++;
    else if (ch === "}") {
      d--;
      if (d === 0) return { start: open, end: i };
    }
  }
  return { start: open, end: text.length - 1 };
}

/**
 * Resolve a free-text `anchor` to the smallest sensible enclosing range in
 * `content`. Deterministic and pure; documented rules:
 *
 * - WHOLE-WORD match only. The character before and after the match must not
 *   be an identifier character, so `foo` never matches inside `foobar`.
 * - AMBIGUOUS (multiple matches): the FIRST match in file order wins and the
 *   result records that (`firstMatch: true`, plus `matchLine`/`matchCount`).
 *   This is not an error.
 * - NOT FOUND: returns `null`; the caller stores no chunk for that file.
 * - RANGE: expand from the match's own line to its enclosing brace-balanced
 *   block (see {@link enclosingBraceBlock}); when no block encloses it, use a
 *   fixed `±ANCHOR_WINDOW_RADIUS` window around the match line. The range is
 *   clamped in-bounds and capped at `maxLines` (default
 *   {@link DEFAULT_MAX_LINES}), keeping the block head when it already shows
 *   the match, otherwise centering on the match so it is never dropped.
 */
export function resolveAnchorRange(
  content: string,
  anchor: string,
  opts?: { maxLines?: number },
): AnchorRange | null {
  if (!anchor) return null;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;

  const matches: number[] = [];
  let from = 0;
  for (;;) {
    const idx = content.indexOf(anchor, from);
    if (idx === -1) break;
    const before = idx > 0 ? content[idx - 1] : "";
    const afterIdx = idx + anchor.length;
    const after = afterIdx < content.length ? content[afterIdx] : "";
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) matches.push(idx);
    from = idx + 1;
  }
  if (matches.length === 0) return null;

  const starts = lineStartsOf(content);
  const lineCount = starts.length;
  const matchLine = lineAt(starts, matches[0]);

  const block = enclosingBraceBlock(content, matches[0]);
  let startLine = block
    ? lineAt(starts, block.start)
    : Math.max(1, matchLine - ANCHOR_WINDOW_RADIUS);
  let endLine = block
    ? lineAt(starts, block.end)
    : Math.min(lineCount, matchLine + ANCHOR_WINDOW_RADIUS);

  startLine = Math.max(1, Math.min(startLine, lineCount));
  endLine = Math.max(startLine, Math.min(endLine, lineCount));

  if (endLine - startLine + 1 > maxLines) {
    if (matchLine >= startLine && matchLine <= startLine + maxLines - 1) {
      endLine = startLine + maxLines - 1;
    } else {
      let s = Math.max(1, matchLine - Math.floor(maxLines / 2));
      const e = Math.min(lineCount, s + maxLines - 1);
      s = Math.max(1, e - maxLines + 1);
      startLine = s;
      endLine = e;
    }
  }

  return {
    startLine,
    endLine,
    matchLine,
    matchCount: matches.length,
    firstMatch: matches.length > 1,
  };
}

/** Repo-relative, non-escaping path check before a single-file read. */
function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return !path.split("/").some((segment) => segment === "..");
}

/**
 * Resolve `anchor` inside `<workspaceRoot>/<filePath>` to a `CodeRef`. Reads
 * exactly one file and never throws: an unsafe path, a missing/unreadable
 * file, or an anchor with no whole-word match all return `null`.
 *
 * When the match was ambiguous the chosen position is recorded on the returned
 * ref's `anchor` (e.g. `"foo (first match at line 12)"`) so the first-match
 * resolution survives into the persisted chunk.
 */
export async function resolveAnchorRef(
  workspaceRoot: string,
  filePath: string,
  anchor: string,
  opts?: { maxLines?: number },
): Promise<CodeRef | null> {
  if (!isSafeRelativePath(filePath)) return null;

  let content: string;
  try {
    content = await readFile(resolve(workspaceRoot, filePath), "utf-8");
  } catch {
    return null;
  }

  const range = resolveAnchorRange(content, anchor, opts);
  if (!range) return null;

  const ref: CodeRef = { path: filePath, startLine: range.startLine, endLine: range.endLine };
  ref.anchor = range.firstMatch ? `${anchor} (first match at line ${range.matchLine})` : anchor;
  return ref;
}

/** A source file that can carry a resolved line range alongside its anchor. */
interface ResolvableSourceFile {
  path: string;
  anchor?: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Resolve anchor-only source files against the workspace, leaving files that
 * already carry a range (or have no anchor, or cannot be resolved) untouched.
 * Best-effort: `resolveAnchorRef` never throws, so one unresolvable anchor
 * never blocks the write.
 */
async function resolveSourceFileAnchors(
  workspaceRoot: string,
  sourceFiles: ReadonlyArray<{ path: string; anchor?: string }>,
): Promise<ResolvableSourceFile[]> {
  const out: ResolvableSourceFile[] = [];
  for (const file of sourceFiles) {
    if (file.anchor === undefined) {
      out.push({ path: file.path });
      continue;
    }
    const ref = await resolveAnchorRef(workspaceRoot, file.path, file.anchor);
    out.push(
      ref
        ? {
            path: file.path,
            anchor: file.anchor,
            startLine: ref.startLine,
            endLine: ref.endLine,
          }
        : { path: file.path, anchor: file.anchor },
    );
  }
  return out;
}

/**
 * Convert codegraph ingestion output into the proposals file payload
 * and persist it through `proposal-store.writeProposals()`.
 *
 * Replaces the legacy direct-write path that used to populate
 * `knowledge/index.json` and `knowledge/<id>.md` at ingest time. Codegraph
 * proposals now sit in the proposals gate until a skill-aware host enriches
 * them into durable knowledge entries.
 *
 * Merge semantics: if a proposals file already exists, proposals from the
 * existing file with ids NOT present in the new extraction are preserved.
 * This protects backfilled proposals (with empty structuralFacts) and any
 * other pending entries from being clobbered when codegraph re-runs. The new
 * extraction wins on collisions — a fresh extraction produces fresher facts.
 */
export async function writeProposalsFile(
  slug: string,
  proposals: KnowledgeProposal[],
  graphJsonContent: string,
): Promise<{ written: number; fingerprint: string; preserved: number }> {
  // Resolve anchor-only source files to line ranges where the registered
  // workspace makes that possible, so a later promotion can capture chunks for
  // them. Best-effort: with no workspace registered, or an unresolvable anchor,
  // the file is stored verbatim (the pre-existing behaviour). The ranges are
  // additive to the file format — `sourceFiles[].startLine/endLine` — and older
  // proposals that carry neither still read and promote unchanged.
  const workspaceRoot = await resolveWorkspaceRoot(getProjectDir(slug)).catch(() => null);

  // Map ingestion shape → storage shape. The storage `Proposal` adds an
  // initially-empty `suggestedDedupCandidates`; `annotateDedupCandidates`
  // populates it from the existing knowledge index.
  const draft: Proposal[] = [];
  for (const p of proposals) {
    const sourceFiles =
      workspaceRoot !== null
        ? await resolveSourceFileAnchors(workspaceRoot, p.sourceFiles)
        : p.sourceFiles;
    draft.push({
      id: p.id,
      kind: p.kind,
      label: p.label,
      structuralFacts: p.structuralFacts as unknown as Record<string, unknown>,
      sourceFiles,
      suggestedDedupCandidates: [],
    });
  }

  const annotated = await annotateDedupCandidates(slug, draft);

  // Preserve existing proposals not present in the new extraction. This
  // protects the lossy backfill payload (structuralFacts: {}) and any other
  // pending agent-enrichment work from being silently dropped on the next
  // sync. New extraction wins on id collisions.
  const existing = await readProposals(slug);
  const newIds = new Set(annotated.map((p) => p.id));
  const preserved = existing ? existing.proposals.filter((p) => !newIds.has(p.id)) : [];

  const fingerprint = computeGraphFingerprint(graphJsonContent);

  const payload: ProposalsFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    graphFingerprint: fingerprint,
    proposals: [...annotated, ...preserved],
  };

  await writeProposals(slug, payload);

  return { written: proposals.length, fingerprint, preserved: preserved.length };
}
