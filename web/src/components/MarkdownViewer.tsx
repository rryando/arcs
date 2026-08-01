/**
 * Markdown document viewer — GFM rendering with syntax highlighting,
 * heading anchors, and a generated table-of-contents rail.
 *
 * With a `slug`, every heading also carries a send affordance: it ships the
 * heading's own source section (heading line down to the next same-or-shallower
 * heading) to a live session, so an agent gets the exact markdown, not a
 * re-serialized copy of the rendered DOM.
 */

import { type ReactNode, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { SessionLinkedNodeType } from "../api/client";
import { cx } from "../lib/format";
import {
  createHeadingIdGenerator,
  extractHeadings,
  extractSections,
  type MarkdownSection,
} from "../lib/markdown-headings";
import { SessionMessageForm } from "./SessionMessageForm";

function textOfChildren(children: unknown): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(textOfChildren).join("");
  if (children && typeof children === "object" && "props" in children) {
    return textOfChildren((children as { props: { children?: unknown } }).props.children);
  }
  return "";
}

export function MarkdownViewer({
  content,
  className,
  showToc = true,
  slug,
  linkedNodeType,
  linkedNodeId,
}: {
  content: string;
  className?: string;
  showToc?: boolean;
  /** Enables the per-heading "send section to a session" affordance. */
  slug?: string;
  /** Sorts the session picker (linked sessions first) — never filters it. */
  linkedNodeType?: SessionLinkedNodeType;
  linkedNodeId?: string;
}) {
  const headings = useMemo(() => extractHeadings(content), [content]);
  const sections = useMemo(() => extractSections(content), [content]);
  const sectionById = useMemo(() => new Map(sections.map((s) => [s.id, s])), [sections]);
  const [sendTarget, setSendTarget] = useState<MarkdownSection | null>(null);
  const toc = headings.filter((h) => h.depth >= 2 && h.depth <= 3);
  const nextHeadingId = createHeadingIdGenerator();

  // Ids come from the same generator sequence as `extractSections`, so a
  // rendered heading finds its own source range by id. A heading the scanner
  // does not see (setext form) simply gets no send button.
  const renderHeading = (depth: 1 | 2 | 3 | 4, children: ReactNode) => {
    const id = nextHeadingId(textOfChildren(children));
    const section = slug ? sectionById.get(id) : undefined;
    const body = (
      <>
        {children}
        {section && (
          <button
            type="button"
            title="send this section to a session"
            onClick={() => setSendTarget(section)}
            className="ml-2 align-middle text-[12px] font-normal text-term-dim opacity-0 group-hover:opacity-100 hover:text-term-green focus-visible:opacity-100"
          >
            ✉
          </button>
        )}
      </>
    );
    if (depth === 1)
      return (
        <h1 id={id} className="group">
          {body}
        </h1>
      );
    if (depth === 2)
      return (
        <h2 id={id} className="group">
          {body}
        </h2>
      );
    if (depth === 3)
      return (
        <h3 id={id} className="group">
          {body}
        </h3>
      );
    return (
      <h4 id={id} className="group">
        {body}
      </h4>
    );
  };

  return (
    <div className={cx("flex gap-6", className)}>
      <div className="md min-w-0 flex-1">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
          components={{
            h1: ({ children }) => renderHeading(1, children),
            h2: ({ children }) => renderHeading(2, children),
            h3: ({ children }) => renderHeading(3, children),
            h4: ({ children }) => renderHeading(4, children),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>

      {showToc && toc.length > 2 && (
        <nav className="hidden w-48 shrink-0 lg:block">
          <div className="sticky top-2 border-l border-term-border pl-3">
            <div className="mb-2 text-[10px] tracking-wide text-term-dim uppercase">contents</div>
            {toc.map((h) => (
              <a
                key={h.id}
                href={`#${h.id}`}
                className={cx(
                  "block truncate py-0.5 text-[11px] text-term-dim hover:text-term-green",
                  h.depth === 3 && "pl-3",
                )}
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                {h.text}
              </a>
            ))}
          </div>
        </nav>
      )}

      {slug && sendTarget && (
        <SessionMessageForm
          slug={slug}
          initialText={content.slice(sendTarget.startOffset, sendTarget.endOffset).trim()}
          linkedNodeType={linkedNodeType}
          linkedNodeId={linkedNodeId}
          onClose={() => setSendTarget(null)}
        />
      )}
    </div>
  );
}
