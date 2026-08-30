/**
 * Lightweight markdown for Ask-AI replies — GFM + syntax highlighting, with
 * none of the document-viewer furniture.
 *
 * Deliberately NOT MarkdownViewer: that component is a document viewer (TOC
 * rail, heading anchors/ids, section-copy and ✉ send affordances) and pulls
 * router hash-scrolling in with it. A chat reply is text-shaped and
 * panel-sized: 11–12px type, the tokyo-night `hljs` token colors from the
 * global theme the knowledge pages already import (index.css), and
 * term-token chrome for the rest. Used for the live streamed assistant block
 * AND assistant turns in the transcript; user/tool/error rows stay plain
 * pre-wrap text.
 */

import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { cx } from "../lib/format";

const components: ComponentProps<typeof ReactMarkdown>["components"] = {
  h1: ({ children }) => (
    <h1 className="mt-2 mb-1 text-[13px] font-bold text-term-green">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-2 mb-1 text-[12px] font-bold text-term-green">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-2 mb-1 text-[12px] font-bold text-term-cyan">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-2 mb-1 text-[12px] font-bold text-term-fg">{children}</h4>
  ),
  p: ({ children }) => <p className="my-1">{children}</p>,
  ul: ({ children }) => <ul className="my-1 list-disc pl-4 marker:text-term-dim">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-4 marker:text-term-dim">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-term-cyan underline underline-offset-2 hover:text-term-green"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-bold text-term-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ className, children }) => {
    // Fenced blocks carry the `hljs`/`language-*` classes rehype-highlight
    // added; inline code carries none and renders as a chip. The token colors
    // come from the global highlight.js theme — only size is ours here.
    const isBlock = typeof className === "string" && /(^|\s)(hljs|language-)/.test(className);
    if (isBlock) {
      return <code className={cx(className, "block text-[11px] leading-snug")}>{children}</code>;
    }
    return (
      <code className="border border-term-border bg-term-panel px-1 py-0.5 text-[11px] text-term-amber">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto border border-term-border bg-term-panel p-2 text-[12px] leading-snug">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-term-amber/60 pl-2 text-term-dim">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-term-border" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-term-border bg-term-panel px-1.5 py-0.5 text-left font-bold text-term-green">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-term-border px-1.5 py-0.5 align-top">{children}</td>
  ),
  // GFM task lists — read-only in a transcript.
  input: ({ checked }) => (
    <input
      type="checkbox"
      checked={checked === true}
      readOnly
      className="mr-1 accent-emerald-500"
    />
  ),
};

export function ChatMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cx("break-words text-[12px] leading-snug text-term-fg", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
