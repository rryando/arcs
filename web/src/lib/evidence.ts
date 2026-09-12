/**
 * Evidence rendering helpers — the pure core behind code chunks and completion
 * receipts.
 *
 * Two things the UI shows are *evidence* captured on the server: a knowledge
 * entry's `codeChunks` (a line range lifted out of a workspace file) and a
 * task/plan completion receipt (a capped unified diff plus its stats). Both are
 * rendered with the syntax-highlighting stack this app already ships —
 * `highlight.js/lib/common` plus the `highlight.js/styles/tokyo-night-dark.css`
 * import in index.css — so nothing here pulls in a new dependency.
 *
 * There is no framework in this module on purpose: these are the unit-testable
 * pieces (see test/web-client-core.test.ts) and the JSX shells only lay them
 * out. Nothing here touches `navigator`/`document`, so importing it in a
 * node-environment test is safe.
 *
 * `highlight.js/lib/common` rather than the full bundle: it registers the
 * common language set only, which is the same set `rehype-highlight` already
 * mounts for markdown. `languageFromPath` therefore maps to ids that exist in
 * that set — `hljs.highlight` throws on an unknown id, and the server's own
 * map uses linguist names (`typescriptreact`) that highlight.js does not know.
 */

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

/**
 * Extension → highlight.js language id. A local map, not an import of
 * `src/utils/code-snippet.ts`: web/src is a separate dependency graph (the
 * browser build must not reach into the server's module tree). An extension
 * that is not here maps to `undefined` and the caller renders plain text —
 * guessing a language is worse than not highlighting.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  diff: "diff",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "c",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  m: "objectivec",
  md: "markdown",
  mjs: "javascript",
  mm: "objectivec",
  mts: "typescript",
  patch: "diff",
  php: "php",
  pl: "perl",
  py: "python",
  r: "r",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

/** Map a workspace path to a highlight.js language id, or `undefined` when the
 *  path has no extension the common bundle knows. */
export function languageFromPath(path: string): string | undefined {
  const cut = path.lastIndexOf(".");
  if (cut <= 0 || cut === path.length - 1) return undefined;
  return LANGUAGE_BY_EXTENSION[path.slice(cut + 1).toLowerCase()];
}

/** Escape text so it can be injected as HTML. Only reached when highlighting
 *  itself fails, which would otherwise let source containing `<` render as
 *  markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sanitize highlight.js output before it is injected as HTML.
 *
 * Guarded rather than unconditional: outside a DOM `dompurify` exports its
 * *factory* (not an instance), which is exactly the shape this module sees when
 * a node-environment test imports it — and with no DOM there is no markup to
 * sanitize. In the browser the instance is always present.
 */
function sanitizeHtml(html: string): string {
  const purify = DOMPurify as unknown as { sanitize?: (dirty: string) => string };
  if (typeof purify.sanitize !== "function") return html;
  return purify.sanitize(html);
}

/**
 * Highlight `code` to sanitized HTML. `language` is used only when
 * highlight.js actually knows it; otherwise the language is auto-detected from
 * the snippet — fine for a captured chunk, which is bounded to a handful of
 * lines. Either way a highlight failure falls back to escaped plain text: the
 * block must always show the source, never lose it.
 */
export function highlightToHtml(code: string, language?: string): string {
  let raw: string;
  try {
    raw =
      language !== undefined && hljs.getLanguage(language) !== undefined
        ? hljs.highlight(code, { language, ignoreIllegals: true }).value
        : hljs.highlightAuto(code).value;
  } catch {
    raw = escapeHtml(code);
  }
  return sanitizeHtml(raw);
}

const SPAN_RE = /<span class="([^"]*)">|<\/span>/g;

/**
 * Split already-highlighted HTML into per-line HTML, re-opening any span that
 * a multi-line token (block comment, template literal) left open across a
 * newline. Every returned line is self-contained enough to be injected on its
 * own, which is what the line-selectable workspace viewer needs: it renders one
 * DOM node per line and cannot carry a span across rows.
 *
 * Input must come from `highlightToHtml` (sanitized, span-only markup).
 */
export function splitHighlightedLines(html: string): string[] {
  const open: string[] = [];
  return html.split("\n").map((line) => {
    // State at the START of the line, before the line's own tags are scanned.
    const prefix = open.map((cls) => `<span class="${cls}">`).join("");
    SPAN_RE.lastIndex = 0;
    let match = SPAN_RE.exec(line);
    while (match !== null) {
      if (match[0] === "</span>") open.pop();
      else open.push(match[1] ?? "");
      match = SPAN_RE.exec(line);
    }
    const suffix = open.map(() => "</span>").join("");
    return prefix + line + suffix;
  });
}

/** Ellipsize the middle of `text`: a deep path keeps its root and its file
 *  name, and the range stays visible at the end. */
export function truncateMiddle(text: string, max = 64): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - 1); // one column goes to the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * Header label for a code block: `path:start-end` for a captured chunk, the
 * bare path when there is no range, `undefined` when there is no path at all.
 * Middle-truncated so a deep path can never push the line numbers out of view.
 */
export function formatCodeLabel(
  chunk: { path?: string; startLine?: number; endLine?: number },
  max = 64,
): string | undefined {
  const path = chunk.path;
  if (path === undefined || path === "") return undefined;
  const label =
    chunk.startLine !== undefined && chunk.endLine !== undefined
      ? `${path}:${chunk.startLine}-${chunk.endLine}`
      : path;
  return truncateMiddle(label, max);
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** Short commit sha, or `""` when the receipt carries none. */
export function shortSha(sha: string | undefined | null, length = 7): string {
  if (!sha) return "";
  return sha.slice(0, length);
}

/** `3 files changed, +12/-4` — the diffstat line a receipt panel shows. */
export function formatDiffstat(stat: {
  filesChanged: number;
  insertions: number;
  deletions: number;
}): string {
  const files = `${stat.filesChanged} file${stat.filesChanged === 1 ? "" : "s"} changed`;
  return `${files}, +${stat.insertions}/-${stat.deletions}`;
}

/** Diffstat for a plan's per-task attribution row, where any of the three
 *  stats may be missing. `undefined` when none of them was recorded. */
export function formatPartialDiffstat(stat: {
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}): string | undefined {
  const { filesChanged, insertions, deletions } = stat;
  if (filesChanged === undefined && insertions === undefined && deletions === undefined) {
    return undefined;
  }
  return formatDiffstat({
    filesChanged: filesChanged ?? 0,
    insertions: insertions ?? 0,
    deletions: deletions ?? 0,
  });
}

/**
 * Build a base→head compare URL from a stored receipt, mirroring the CLI's
 * `compareUrl` (src/cli/commands/plan.ts) — same host vocabulary, same suffix
 * rewriting — because the two must not disagree about what "open the range"
 * means. The receipt's own `url` is the commit link the capture wrote, so the
 * range form is derived from it rather than rebuilt from the remote.
 *
 * Returns null when the stored link does not have a known range shape; the
 * caller then shows the commit URL, which is the CLI's fallback too.
 */
export function receiptRangeUrl(receipt: {
  baseSha?: string;
  headSha?: string;
  url?: string | null;
}): string | null {
  const url = receipt.url;
  const head = receipt.headSha;
  const base = receipt.baseSha;
  if (!url || !head || !base) return null;

  const gitlabSuffix = `/-/commit/${head}`;
  if (url.endsWith(gitlabSuffix)) {
    return `${url.slice(0, -gitlabSuffix.length)}/-/compare/${base}...${head}`;
  }
  const bitbucketSuffix = `/commits/${head}`;
  if (url.endsWith(bitbucketSuffix)) {
    return `${url.slice(0, -bitbucketSuffix.length)}/compare/${head}`;
  }
  const githubSuffix = `/commit/${head}`;
  if (url.endsWith(githubSuffix)) {
    return `${url.slice(0, -githubSuffix.length)}/compare/${base}...${head}`;
  }
  return null;
}

/**
 * The link a receipt should offer: the base→head range when the fetched
 * receipt supports one, else the stored commit URL — the fetched receipt's when
 * there is one, otherwise the pointer's (all that is known before the body
 * arrives). Never invents a URL — no remote, no link.
 */
export function receiptLink(
  report: { url?: string },
  receipt?: { url?: string | null; baseSha?: string; headSha?: string } | null,
): string | undefined {
  if (receipt) return receiptRangeUrl(receipt) ?? receipt.url ?? report.url;
  return report.url;
}
