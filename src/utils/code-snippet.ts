/**
 * Deterministic code-chunk model.
 *
 * A `CodeRef` names a line range in a workspace file; a `CodeChunk` is that
 * range captured at a point in time, with the text lifted from disk and an
 * optional `headRev`/`capturedAt` stamp. Everything here is deterministic work
 * over the filesystem — no network, no LLM, no git shell-outs. Callers own git
 * and pass `headRev` in.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { CodeChunk, CodeRef } from "./storage-utils.js";

export type { CodeChunk, CodeRef } from "./storage-utils.js";

/** Default number of source lines kept in one snippet. */
export const DEFAULT_MAX_LINES = 120;

/** Default snippet size ceiling, in UTF-8 bytes. */
export const DEFAULT_MAX_BYTES = 8192;

/**
 * Parse a `"path:start-end"` ref (for example `"src/x.ts:10-25"`).
 *
 * Exactly one trailing `:start-end` is accepted: both bounds must be plain
 * integers, `start >= 1`, `end >= start`, and the path must be non-empty.
 * Anything else — a missing range, a non-numeric or negative bound, a reversed
 * range, or extra `:` inside the range — returns `null`.
 *
 * A path that itself contains a colon (a Windows drive letter such as
 * `C:\x.ts`) is out of scope and will not parse; this is deliberate, since
 * colons are the range delimiter here.
 */
export function parseCodeRef(raw: string): CodeRef | null {
  const match = /^(.+):(\d+)-(\d+)$/.exec(raw);
  if (!match) return null;
  const [, path, startRaw, endRaw] = match;
  if (!path.trim()) return null;
  const startLine = Number.parseInt(startRaw, 10);
  const endLine = Number.parseInt(endRaw, 10);
  if (startLine < 1 || endLine < startLine) return null;
  return { path, startLine, endLine };
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  json: "json",
  md: "markdown",
  py: "python",
  sh: "shell",
  bash: "shell",
  yml: "yaml",
  yaml: "yaml",
};

/** Map a file path to a language id, or `undefined` for an unknown extension. */
export function languageFromPath(path: string): string | undefined {
  const ext = extname(path).slice(1).toLowerCase();
  return ext ? LANGUAGE_BY_EXTENSION[ext] : undefined;
}

/** True when `candidate` is `root` itself or lives underneath it. */
function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/** Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

/**
 * Build a chunk from file `content`, applying the line/byte caps. Returns
 * `null` when the requested span reaches past EOF. Pure and synchronous so the
 * async reader and the sync staleness check share one definition of a slice.
 */
function sliceChunk(
  ref: CodeRef,
  content: string,
  opts?: { maxLines?: number; maxBytes?: number; headRev?: string },
): CodeChunk | null {
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

  const lines = content.split("\n");
  if (ref.startLine > lines.length || ref.endLine > lines.length) return null;

  const available = ref.endLine - ref.startLine + 1;
  const take = Math.min(available, Math.max(0, maxLines));
  const snippet = truncateToBytes(
    lines.slice(ref.startLine - 1, ref.startLine - 1 + take).join("\n"),
    maxBytes,
  );

  const chunk: CodeChunk = {
    path: ref.path,
    startLine: ref.startLine,
    endLine: ref.endLine,
    snippet,
    capturedAt: new Date().toISOString(),
  };
  const language = languageFromPath(ref.path);
  if (language !== undefined) chunk.language = language;
  if (ref.anchor !== undefined) chunk.anchor = ref.anchor;
  if (opts?.headRev !== undefined) chunk.headRev = opts.headRev;
  return chunk;
}

/**
 * Read `ref.startLine..ref.endLine` (inclusive, 1-indexed) from
 * `<workspaceRoot>/<ref.path>` and return a captured chunk.
 *
 * Fails closed to `null` for a missing/unreadable file, a path that escapes the
 * workspace root, or a span that reaches past EOF. A span wider than `maxLines`
 * (default 120) or `maxBytes` (default 8192) is truncated rather than rejected.
 * `headRev` is copied through only when supplied.
 */
export async function readCodeChunk(
  workspaceRoot: string,
  ref: CodeRef,
  opts?: { maxLines?: number; maxBytes?: number; headRev?: string },
): Promise<CodeChunk | null> {
  const root = resolve(workspaceRoot);
  const target = resolve(root, ref.path);
  if (!isInside(root, target)) return null;

  let content: string;
  try {
    content = await readFile(target, "utf-8");
  } catch {
    return null;
  }
  return sliceChunk(ref, content, opts);
}

/**
 * True when the file behind `chunk` is gone or the current slice no longer
 * matches the captured `snippet`. Synchronous by contract; re-reads with the
 * same default caps used at capture, so a chunk captured under custom caps
 * should be re-checked with the same caps (compare `readCodeChunk` output
 * directly in that case).
 */
export function isChunkStale(workspaceRoot: string, chunk: CodeChunk): boolean {
  const root = resolve(workspaceRoot);
  const target = resolve(root, chunk.path);
  if (!isInside(root, target)) return true;

  let content: string;
  try {
    content = readFileSync(target, "utf-8");
  } catch {
    return true;
  }

  const current = sliceChunk(
    { path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine },
    content,
  );
  return current === null || current.snippet !== chunk.snippet;
}

// ---------------------------------------------------------------------------
// Unified diff → new-file ranges
//
// Derived, deterministic work over a receipt's capped unified diff. No git, no
// LLM: `git diff` text is scanned line-by-line and each hunk's NEW-file range
// is recovered from its `@@ -a,b +c,d @@` header.
// ---------------------------------------------------------------------------

/**
 * Ceiling on chunks derived from one receipt diff. A commit that touches many
 * files must not explode the knowledge entry, so only the largest edited
 * regions are captured (see {@link deriveDiffCodeRanges}).
 */
export const MAX_DERIVED_DIFF_CHUNKS = 10;

/** A 1-indexed inclusive line range in the NEW revision of a file. */
export interface DiffLineRange {
  startLine: number;
  endLine: number;
}

/** Merged new-file ranges for a single path. */
export interface DiffFileRanges {
  /** New-file path (posix, `a/`/`b/` prefix and surrounding quotes stripped). */
  path: string;
  /** Ascending, non-overlapping ranges. */
  ranges: DiffLineRange[];
}

/** A captured span derived from a diff, ready to feed `readCodeChunk`. */
export interface DerivedCodeRange extends DiffLineRange {
  path: string;
}

const DIFF_GIT_HEADER_RE = /^diff --git (.+) (.+)$/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Strip a git path token down to a repo-relative path: surrounding double
 * quotes (git C-quotes paths containing spaces) and a leading `a/`/`b/`
 * prefix are removed.
 */
function normalizeDiffPath(token: string): string {
  let raw = token.trim();
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.slice(1, -1).replace(/\\([\\"])/g, "$1");
  }
  if (raw.startsWith("b/")) return raw.slice(2);
  if (raw.startsWith("a/")) return raw.slice(2);
  return raw;
}

/**
 * New-file range for one hunk header.
 *
 * - `d > 0`: `[c, c + d - 1]` — the added/context lines in the new file.
 * - `d === 0` (pure deletion — git writes this for a file emptied or removed
 *   from `c` down): the deleted lines have no new counterpart, so point at the
 *   surviving line at `c` as a 1-line window. Git writes `+0,0` when
 *   everything from the top is gone, so `c` is clamped to at least 1. A
 *   past-EOF read still fails closed in `readCodeChunk`; callers skip it.
 */
function newFileRange(start: number, count: number): DiffLineRange {
  if (count > 0) {
    const s = Math.max(1, start);
    return { startLine: s, endLine: Math.max(s, start + count - 1) };
  }
  const line = Math.max(1, start);
  return { startLine: line, endLine: line };
}

/**
 * Collapse ranges into the minimum ascending, non-overlapping set.
 *
 * MERGE RULE: two ranges merge when the next one overlaps the current or starts
 * on the line immediately after it (`next.startLine <= current.endLine + 1`).
 * Touching hunks are merged too so two adjacent edited regions produce one
 * chunk instead of two nearly-identical ones. A gap of at least one unedited
 * line keeps them separate.
 */
export function mergeLineRanges(ranges: DiffLineRange[]): DiffLineRange[] {
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const merged: DiffLineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.startLine <= last.endLine + 1) {
      if (range.endLine > last.endLine) last.endLine = range.endLine;
    } else {
      merged.push({ startLine: range.startLine, endLine: range.endLine });
    }
  }
  return merged;
}

/**
 * Parse a unified diff into per-file, merged NEW-file ranges.
 *
 * Rules and limits, all documented so the output is fully deterministic:
 * - The path comes from the `diff --git a/… b/…` header (b-side), falling back
 *   to the `+++ b/…` line when a header is absent.
 * - A `+++ /dev/null` marker marks the file as fully deleted; its hunks are
 *   dropped (there is nothing left to capture). This keeps a deleted receipt
 *   file from being read out of the working tree.
 * - `+++`/`---` lines are only honoured outside a hunk body, so an added source
 *   line that literally reads `+++ /dev/null` is never mistaken for a header.
 * - Ranges are merged per path (see {@link mergeLineRanges}) and the result is
 *   sorted by path, so identical diffs always yield identical output.
 * - A truncated diff (cut by the receipt's line/byte cap) simply stops early;
 *   hunks whose ranges reach past EOF fail closed at capture time.
 */
export function parseDiffFileRanges(diff: string): DiffFileRanges[] {
  const byPath = new Map<string, DiffLineRange[]>();
  let currentPath: string | null = null;
  let deleted = false;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    const header = DIFF_GIT_HEADER_RE.exec(line);
    if (header) {
      currentPath = normalizeDiffPath(header[2]);
      deleted = false;
      inHunk = false;
      continue;
    }

    if (!inHunk) {
      if (line.startsWith("--- ")) continue;
      if (line.startsWith("+++ ")) {
        const target = line.slice(4).trim();
        if (target === "/dev/null") {
          deleted = true;
        } else if (currentPath === null) {
          currentPath = normalizeDiffPath(target);
        }
        continue;
      }
    }

    const hunk = HUNK_HEADER_RE.exec(line);
    if (!hunk) continue;
    inHunk = true;
    if (currentPath === null || deleted) continue;

    const start = Number.parseInt(hunk[1], 10);
    const count = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10);
    const range = newFileRange(start, count);
    const bucket = byPath.get(currentPath);
    if (bucket !== undefined) bucket.push(range);
    else byPath.set(currentPath, [range]);
  }

  return [...byPath.entries()]
    .map(([path, ranges]) => ({ path, ranges: mergeLineRanges(ranges) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Derive the deterministic set of code ranges to capture from a receipt diff.
 *
 * SELECTION RULE: ranges are ranked by size (largest first), then by path
 * (ascending), then by start line, and the first `maxChunks` (default
 * {@link MAX_DERIVED_DIFF_CHUNKS}) are kept. This prefers the biggest edited
 * regions when a diff touches many files and is a total order, so the same
 * diff always selects the same ranges. The kept ranges are returned in stable
 * path/line order. A range wider than `maxLines` (default
 * {@link DEFAULT_MAX_LINES}) is trimmed to its head so the persisted range
 * matches the snippet `readCodeChunk` will store.
 */
export function deriveDiffCodeRanges(
  diff: string,
  opts?: { maxChunks?: number; maxLines?: number },
): DerivedCodeRange[] {
  const maxChunks = opts?.maxChunks ?? MAX_DERIVED_DIFF_CHUNKS;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  if (maxChunks <= 0 || maxLines <= 0) return [];

  const candidates: DerivedCodeRange[] = [];
  for (const file of parseDiffFileRanges(diff)) {
    for (const range of file.ranges) {
      let { startLine, endLine } = range;
      if (endLine - startLine + 1 > maxLines) endLine = startLine + maxLines - 1;
      candidates.push({ path: file.path, startLine, endLine });
    }
  }

  const selected = candidates
    .sort((a, b) => {
      const sizeA = a.endLine - a.startLine + 1;
      const sizeB = b.endLine - b.startLine + 1;
      if (sizeA !== sizeB) return sizeB - sizeA;
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return a.startLine - b.startLine;
    })
    .slice(0, maxChunks);

  return selected.sort((a, b) =>
    a.path !== b.path ? (a.path < b.path ? -1 : 1) : a.startLine - b.startLine,
  );
}
