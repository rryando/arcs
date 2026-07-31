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
      color: "#b9dcb9",
      fontSize: "13px",
    },
    ".cm-content": {
      caretColor: "#7ee787",
      padding: "8px 0",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#7ee787" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "#1d3a24" },
    ".cm-activeLine": { backgroundColor: "#7ee78708" },
    ".cm-gutters": { display: "none" },
    "&.cm-focused": { outline: "none" },
    ".cm-header": { color: "#7ee787", fontWeight: "bold" },
    ".cm-strong": { color: "#e5b567", fontWeight: "bold" },
    ".cm-emphasis": { color: "#6fc3df", fontStyle: "italic" },
    ".cm-link": { color: "#6fc3df", textDecoration: "underline" },
    ".cm-monospace": { color: "#e5b567" },
    ".cm-url": { color: "#647c66" },
    ".cm-strikethrough": { textDecoration: "line-through" },
    ".cm-quote": { color: "#647c66" },
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
