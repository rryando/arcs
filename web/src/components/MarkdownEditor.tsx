/**
 * Markdown editor — CodeMirror 6 with markdown highlighting, line wrapping,
 * optional vim mode, and a palette-matched dark theme.
 */

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";
import { cx } from "../lib/format";

const termTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "transparent",
      color: "#f2f2f2",
      fontSize: "13px",
    },
    ".cm-content": {
      caretColor: "#4ade80",
      padding: "8px 0",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#4ade80" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "#474747" },
    ".cm-activeLine": { backgroundColor: "#f2f2f208" },
    ".cm-gutters": { display: "none" },
    "&.cm-focused": { outline: "none" },
    ".cm-header": { color: "#4ade80", fontWeight: "bold" },
    ".cm-strong": { color: "#fbbf24", fontWeight: "bold" },
    ".cm-emphasis": { color: "#22d3ee", fontStyle: "italic" },
    ".cm-link": { color: "#22d3ee", textDecoration: "underline" },
    ".cm-monospace": { color: "#fbbf24" },
    ".cm-url": { color: "#8f8f8f" },
    ".cm-strikethrough": { textDecoration: "line-through" },
    ".cm-quote": { color: "#8f8f8f" },
  },
  { dark: true },
);

export function MarkdownEditor({
  value,
  onChange,
  vimMode = false,
  className,
  onSaveShortcut,
}: {
  value: string;
  onChange: (v: string) => void;
  vimMode?: boolean;
  className?: string;
  onSaveShortcut?: () => void;
}) {
  const extensions = useMemo<Extension[]>(() => {
    const list: Extension[] = [
      markdown({ base: markdownLanguage }),
      EditorView.lineWrapping,
      termTheme,
    ];
    if (vimMode) list.unshift(vim());
    if (onSaveShortcut) {
      list.push(
        EditorView.domEventHandlers({
          keydown: (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "s") {
              event.preventDefault();
              onSaveShortcut();
              return true;
            }
            return false;
          },
        }),
      );
    }
    return list;
  }, [vimMode, onSaveShortcut]);

  return (
    <div className={cx("cm-host", className)}>
      <CodeMirror
        value={value}
        onChange={onChange}
        // Without this the library falls back to its built-in "light" theme,
        // which injects `.cm-editor { background-color: #fff }` ahead of (and
        // therefore winning over) our own `termTheme`. "none" leaves styling
        // entirely to `termTheme` so the editor inherits the dark panel.
        theme="none"
        extensions={extensions}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: true,
          autocompletion: false,
          searchKeymap: false,
        }}
      />
    </div>
  );
}

// Re-export for consumers that construct their own editor state.
export { EditorState };
