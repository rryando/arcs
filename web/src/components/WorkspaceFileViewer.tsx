/**
 * The read-only workspace surface: browse the repo, open a file, pick a line
 * range, attach it as a `file` session reference.
 *
 * This is the "point at a file and ask about it" half of the product. The
 * viewer produces exactly the server's `fileReferenceSchema` shape — `type`,
 * `path`, `startLine`, `endLine`, `excerpt`, `headRev` — and nothing else; a
 * new reference shape invented here would be rejected at the route and would
 * never render in the staged prompt.
 *
 * The excerpt is a POINTER'S ANCHOR, never the content: the prompt renderer
 * says so in as many words and tells the agent to read the file at that range.
 * It is therefore capped hard here rather than carrying the whole selection.
 *
 * There is no editing affordance and no save button, by design — the plane
 * behind this component has no write route. Changes flow through the agent.
 */

import { useMemo, useState } from "react";
import type { SessionFileReference } from "../api/client";
import { useWorkspaceFile, useWorkspaceTree } from "../api/hooks";
import { cx } from "../lib/format";

/** Ceiling on the anchor text sent with a reference. The server clips again
 *  when rendering the prompt; this keeps the request small in the first place. */
const EXCERPT_MAX_CHARS = 1200;

/** Rendered line ceiling. A capped file response can still be tens of thousands
 *  of lines, and a narrow side panel has no business mounting a DOM node per
 *  line for all of them. Selection line numbers stay true to the file. */
const MAX_RENDERED_LINES = 2000;

function parentDir(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WorkspaceFileViewer({
  slug,
  onAttach,
}: {
  slug: string;
  /** Receives the built `file` reference. The panel's pending-reference slot is
   *  the only caller — an unwired viewer would be dead code. */
  onAttach: (reference: SessionFileReference) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dir, setDir] = useState("");
  const [filePath, setFilePath] = useState<string | null>(null);
  // Click sets the anchor, shift-click sets the focus — the selected range is
  // whichever order they ended up in.
  const [anchor, setAnchor] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);

  const tree = useWorkspaceTree(slug, dir, { enabled: expanded && filePath === null });
  const file = useWorkspaceFile(slug, expanded ? filePath : null);

  const lines = useMemo(() => {
    const content = file.data?.content;
    if (content === undefined) return [];
    const split = content.split("\n");
    // A trailing newline terminates the last line rather than starting a blank
    // one — same rule the server counts by.
    if (split.length > 1 && split[split.length - 1] === "") split.pop();
    return split;
  }, [file.data?.content]);

  const startLine = anchor !== null && focus !== null ? Math.min(anchor, focus) : null;
  const endLine = anchor !== null && focus !== null ? Math.max(anchor, focus) : null;

  const openFile = (path: string) => {
    setFilePath(path);
    setAnchor(null);
    setFocus(null);
  };

  const backToTree = () => {
    setFilePath(null);
    setAnchor(null);
    setFocus(null);
  };

  const selectLine = (line: number, extend: boolean) => {
    if (extend && anchor !== null) {
      setFocus(line);
      return;
    }
    setAnchor(line);
    setFocus(line);
  };

  const attach = () => {
    const data = file.data;
    if (!data || startLine === null || endLine === null) return;
    const excerpt = lines
      .slice(startLine - 1, endLine)
      .join("\n")
      .slice(0, EXCERPT_MAX_CHARS);
    onAttach({
      type: "file",
      path: data.path,
      startLine,
      endLine,
      ...(excerpt !== "" && { excerpt }),
      // Omitted rather than sent as null: the server's field is optional, and a
      // null would fail its string schema.
      ...(data.headRev !== null && { headRev: data.headRev }),
    });
    setAnchor(null);
    setFocus(null);
  };

  return (
    <section className="border-b border-term-border" aria-label="workspace files">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-term-inset"
      >
        <span className="text-term-dim">{expanded ? "▾" : "▸"}</span>
        <span className="text-[10px] font-bold tracking-wide text-term-dim uppercase">
          workspace
        </span>
        <span className="flex-1" />
        <span className="truncate text-[10px] text-term-dim">
          {filePath ?? (dir === "" ? "repo root" : dir)}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-term-border/60 p-2">
          {filePath === null ? (
            <TreePane
              dir={dir}
              onUp={() => setDir(parentDir(dir))}
              onOpenDir={setDir}
              onOpenFile={openFile}
              query={tree}
            />
          ) : (
            <>
              <div className="mb-1 flex items-center gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={backToTree}
                  title="back to the file tree"
                  className="text-term-dim hover:text-term-green"
                >
                  ← files
                </button>
                <span className="flex-1 truncate text-term-fg" title={filePath}>
                  {filePath}
                </span>
                {file.data?.headRev && (
                  <span className="text-[10px] text-term-dim" title="head revision at read time">
                    @{file.data.headRev}
                  </span>
                )}
              </div>

              {file.isLoading && <div className="text-[11px] text-term-dim">loading…</div>}
              {file.error && (
                <div className="text-[11px] text-term-red">{errorText(file.error)}</div>
              )}

              {file.data && (
                <>
                  <div className="max-h-64 overflow-auto border border-term-border bg-term-inset">
                    {lines.slice(0, MAX_RENDERED_LINES).map((text, index) => {
                      const line = index + 1;
                      const selected =
                        startLine !== null &&
                        endLine !== null &&
                        line >= startLine &&
                        line <= endLine;
                      return (
                        <button
                          // Line numbers are the identity here; the text is not
                          // unique and reorders on every edit.
                          key={line}
                          type="button"
                          onClick={(e) => selectLine(line, e.shiftKey)}
                          title="click to select, shift+click to extend the range"
                          className={cx(
                            "flex w-full items-start gap-2 px-1 text-left font-mono text-[11px] leading-snug",
                            selected ? "bg-term-cyan/20" : "hover:bg-term-border/40",
                          )}
                        >
                          <span className="w-8 shrink-0 text-right text-term-dim tabular-nums">
                            {line}
                          </span>
                          <span className="whitespace-pre text-term-fg">{text || " "}</span>
                        </button>
                      );
                    })}
                  </div>

                  {(file.data.truncated || lines.length > MAX_RENDERED_LINES) && (
                    <div className="mt-1 text-[11px] text-term-amber">
                      showing the first {Math.min(lines.length, MAX_RENDERED_LINES)} lines
                      {file.data.truncated ? " — the file is larger than this plane serves" : ""}
                    </div>
                  )}

                  <div className="mt-2 flex items-center gap-2 text-[11px]">
                    <span className="text-term-dim">
                      {startLine === null
                        ? "click a line to select"
                        : `lines ${startLine}–${endLine}`}
                    </span>
                    <span className="flex-1" />
                    <button
                      type="button"
                      disabled={startLine === null}
                      onClick={attach}
                      title="attach this line range to the composer as a file reference"
                      className="border border-term-cyan/60 px-2 py-0.5 font-bold text-term-cyan hover:bg-term-cyan hover:text-term-bg disabled:opacity-50"
                    >
                      attach
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function TreePane({
  dir,
  onUp,
  onOpenDir,
  onOpenFile,
  query,
}: {
  dir: string;
  onUp: () => void;
  onOpenDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  query: ReturnType<typeof useWorkspaceTree>;
}) {
  return (
    <>
      <div className="mb-1 flex items-center gap-2 text-[11px]">
        <button
          type="button"
          disabled={dir === ""}
          onClick={onUp}
          title="parent directory"
          className="text-term-dim hover:text-term-green disabled:opacity-40"
        >
          ↑
        </button>
        <span className="flex-1 truncate text-term-dim" title={dir}>
          {dir === "" ? "repo root" : dir}
        </span>
      </div>

      {query.isLoading && <div className="text-[11px] text-term-dim">loading…</div>}
      {query.error && <div className="text-[11px] text-term-red">{errorText(query.error)}</div>}

      {query.data && (
        <div className="max-h-48 overflow-auto">
          {query.data.entries.length === 0 ? (
            <div className="text-[11px] text-term-dim">empty directory</div>
          ) : (
            query.data.entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() =>
                  entry.type === "dir" ? onOpenDir(entry.path) : onOpenFile(entry.path)
                }
                className="flex w-full items-center gap-2 px-1 py-0.5 text-left text-[11px] hover:bg-term-inset"
              >
                <span className={entry.type === "dir" ? "text-term-cyan" : "text-term-dim"}>
                  {entry.type === "dir" ? "▸" : "·"}
                </span>
                <span className="truncate text-term-fg">{entry.name}</span>
              </button>
            ))
          )}
          {query.data.truncated && (
            <div className="mt-1 text-[11px] text-term-amber">
              listing capped — open a subdirectory to see more
            </div>
          )}
        </div>
      )}
    </>
  );
}
