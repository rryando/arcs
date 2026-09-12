/**
 * One highlighted code chunk.
 *
 * A chunk is evidence captured on the server: a `path:start-end` range plus the
 * text lifted from the file. This component renders it as a titled block — the
 * range in the header, highlight.js tokens from the stack the app already ships
 * (see lib/evidence), a guarded copy button, and optional staleness/kind
 * badges. Line structure is preserved (`whitespace-pre`) and long lines scroll
 * horizontally instead of wrapping, because a wrapped diff or code line stops
 * reading as that line.
 *
 * `stale` is a DISPLAY input only. Whether a captured chunk still matches the
 * file on disk is `isChunkStale(workspaceRoot, chunk)` server-side, and this
 * plane has no workspace root to check against — so a caller that cannot know
 * must omit the prop rather than render a guess (knowledge-detail does).
 */

import { useMemo, useState } from "react";
import { formatCodeLabel, highlightToHtml, truncateMiddle } from "../lib/evidence";
import { cx } from "../lib/format";

export interface CodeBlockProps {
  code: string;
  /** highlight.js language id. When omitted (or unknown to highlight.js) the
   *  language is auto-detected from the snippet. */
  language?: string;
  /** Path of the source file the chunk was lifted from. */
  path?: string;
  /** 1-based inclusive capture range; shown as `path:start-end` when both are
   *  present. */
  startLine?: number;
  endLine?: number;
  /** Header text; overrides the `path:start-end` label (used for a raw diff). */
  label?: string;
  /** Distinct marker for a chunk known to no longer match its file. */
  stale?: boolean;
  /** Extra classes on the block itself (margins, etc.). */
  className?: string;
  /** Applied to the scroll container, e.g. `max-h-96` for a collapsible diff. */
  maxHeightClass?: string;
}

export function CodeBlock({
  code,
  language,
  path,
  startLine,
  endLine,
  label,
  stale = false,
  className,
  maxHeightClass,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => highlightToHtml(code, language), [code, language]);
  const full =
    label ??
    formatCodeLabel({ path, startLine, endLine }, Number.POSITIVE_INFINITY) ??
    language ??
    "code";

  // `navigator.clipboard` needs a secure context and is absent in some embeds;
  // a copy that cannot happen is a silent no-op, never a thrown error (the same
  // guarded pattern MarkdownViewer's heading copies use).
  const copy = async () => {
    try {
      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <figure className={cx("code-evidence border border-term-border bg-term-inset", className)}>
      <figcaption className="flex items-center gap-2 border-b border-term-border bg-term-panel px-2 py-1 text-[11px]">
        <span className="truncate text-term-dim" title={full}>
          {truncateMiddle(full)}
        </span>
        {stale && (
          <span
            className="shrink-0 border border-term-amber/60 px-1 text-[10px] text-term-amber"
            title="the captured range no longer matches the file"
          >
            stale
          </span>
        )}
        <span className="flex-1" />
        {language !== undefined && (
          <span className="shrink-0 text-[10px] text-term-dim">{language}</span>
        )}
        <button
          type="button"
          title="copy this code"
          onClick={() => void copy()}
          className={cx(
            "shrink-0 focus-visible:opacity-100",
            copied ? "text-term-green" : "text-term-dim hover:text-term-green",
          )}
        >
          {copied ? "✓" : "⧉"}
        </button>
      </figcaption>
      <pre
        className={cx(
          "overflow-x-auto p-2 text-[12px] leading-snug whitespace-pre",
          maxHeightClass,
        )}
      >
        <code
          className={cx("hljs", language !== undefined && `language-${language}`)}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: `html` is highlight.js output sanitized by dompurify inside highlightToHtml, and is the only content this element ever holds
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </figure>
  );
}
