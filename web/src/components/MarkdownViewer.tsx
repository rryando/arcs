/**
 * Markdown document viewer — GFM rendering with syntax highlighting,
 * heading anchors, and a generated table-of-contents rail.
 */

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { cx } from "../lib/format";
import { createHeadingIdGenerator, extractHeadings } from "../lib/markdown-headings";

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
}: {
  content: string;
  className?: string;
  showToc?: boolean;
}) {
  const headings = useMemo(() => extractHeadings(content), [content]);
  const toc = headings.filter((h) => h.depth >= 2 && h.depth <= 3);
  const nextHeadingId = createHeadingIdGenerator();
  const headingProps = (children: unknown) => ({ id: nextHeadingId(textOfChildren(children)) });

  return (
    <div className={cx("flex gap-6", className)}>
      <div className="md min-w-0 flex-1">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
          components={{
            h1: ({ children }) => <h1 {...headingProps(children)}>{children}</h1>,
            h2: ({ children }) => <h2 {...headingProps(children)}>{children}</h2>,
            h3: ({ children }) => <h3 {...headingProps(children)}>{children}</h3>,
            h4: ({ children }) => <h4 {...headingProps(children)}>{children}</h4>,
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
    </div>
  );
}
