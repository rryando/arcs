/**
 * Lazy wrapper around MarkdownEditor — CodeMirror is heavy and only needed
 * in edit mode, so it stays out of the main bundle.
 */

import { lazy, Suspense } from "react";

const Inner = lazy(() => import("./MarkdownEditor").then((m) => ({ default: m.MarkdownEditor })));

export function MarkdownEditor(props: {
  value: string;
  onChange: (v: string) => void;
  vimMode?: boolean;
  className?: string;
  onSaveShortcut?: () => void;
}) {
  return (
    <Suspense fallback={<div className="p-3 text-term-dim">loading editor…</div>}>
      <Inner {...props} />
    </Suspense>
  );
}
