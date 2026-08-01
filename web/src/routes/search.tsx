/**
 * Full-page BM25 search across all projects.
 */

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useProjects, useSearch } from "../api/hooks";
import { Badge, kindColor, typeColor } from "../components/Badge";
import { Panel } from "../components/Panel";
import { useShortcuts } from "../hooks/useShortcuts";
import { cx, truncate } from "../lib/format";

const KINDS = [
  "lesson",
  "gotcha",
  "pattern",
  "architecture",
  "module",
  "feature",
  "reference",
  "decision",
];

export function SearchPage() {
  const navigate = useNavigate();
  const { data: projectsData } = useProjects();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [slug, setSlug] = useState<string>("");
  const [kind, setKind] = useState<string>("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce the query sent to the server.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input), 200);
    return () => clearTimeout(timer);
  }, [input]);

  const { data, isFetching } = useSearch(query, slug || undefined, kind || undefined);
  const results = useMemo(() => data?.results ?? [], [data]);
  const maxScore = results[0]?.score ?? 1;

  useEffect(() => inputRef.current?.focus(), []);

  const projectName = useMemo(
    () => new Map((projectsData?.projects ?? []).map((p) => [p.slug, p.name])),
    [projectsData],
  );

  const open = (index: number) => {
    const hit = results[index];
    if (!hit) return;
    if (hit.entryType === "knowledge") {
      navigate({
        to: "/p/$slug/knowledge/$id",
        params: { slug: hit.projectSlug, id: hit.entryId },
      });
    } else {
      navigate({ to: "/p/$slug/plans/$id", params: { slug: hit.projectSlug, id: hit.entryId } });
    }
  };

  useShortcuts([
    {
      keys: "j",
      description: "next result",
      group: "search",
      run: () => setSelected((s) => Math.min(results.length - 1, s + 1)),
    },
    {
      keys: "k",
      description: "previous result",
      group: "search",
      run: () => setSelected((s) => Math.max(0, s - 1)),
    },
    { keys: "enter", description: "open result", group: "search", run: () => open(selected) },
    {
      keys: "/",
      description: "focus query",
      group: "search",
      priority: 20,
      run: () => inputRef.current?.focus(),
    },
  ]);

  return (
    <div className="flex h-full flex-col p-3">
      <Panel title="search" hint="bm25 over knowledge + plans · all projects" className="flex-1">
        <div className="flex flex-wrap items-center gap-2 border-b border-term-border px-3 py-2">
          <span className="text-term-green">▸</span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => Math.min(results.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                open(selected);
              }
            }}
            placeholder="search the knowledge base…"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-term-fg outline-none placeholder:text-term-dim/60"
          />
          <select
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSelected(0);
            }}
            className="border border-term-border bg-term-inset px-1 py-0.5 text-[11px] text-term-fg outline-none"
            aria-label="Filter by project"
          >
            <option value="">all projects</option>
            {(projectsData?.projects ?? []).map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setSelected(0);
            }}
            className="border border-term-border bg-term-inset px-1 py-0.5 text-[11px] text-term-fg outline-none"
            aria-label="Filter by kind"
          >
            <option value="">all kinds</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-term-dim">
            {isFetching ? "searching…" : `${results.length} hits`}
          </span>
        </div>

        {query.trim() === "" ? (
          <div className="px-3 py-8 text-center text-term-dim">
            <pre className="text-term-border-hi">
              {
                "┌──────────────────────┐\n│  type to search the  │\n│   knowledge base     │\n└──────────────────────┘"
              }
            </pre>
            <p className="mt-2 text-[11px]">bm25 ranked · title ×3, keywords ×2, summary ×1</p>
          </div>
        ) : results.length === 0 && !isFetching ? (
          <div className="px-3 py-6 text-center text-term-dim">no results for “{query}”</div>
        ) : (
          <div className="divide-y divide-term-border/40">
            {results.map((hit, i) => (
              <button
                type="button"
                key={`${hit.projectSlug}:${hit.entryId}`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => open(i)}
                className={cx(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]",
                  i === selected ? "bg-term-green text-term-bg" : "text-term-fg",
                )}
              >
                <span className={i === selected ? "text-term-bg" : "text-term-green"}>
                  {i === selected ? "▸" : " "}
                </span>
                <Badge
                  color={typeColor(hit.entryType)}
                  className={i === selected ? "border-term-bg/50 text-term-bg" : ""}
                >
                  {hit.entryType}
                </Badge>
                {hit.kind && (
                  <Badge
                    color={kindColor(hit.kind)}
                    className={i === selected ? "border-term-bg/50 text-term-bg" : ""}
                  >
                    {hit.kind}
                  </Badge>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{hit.title}</span>
                  {hit.summary && (
                    <span
                      className={cx(
                        "block truncate text-[11px]",
                        i === selected ? "text-term-bg/80" : "text-term-dim",
                      )}
                    >
                      {truncate(hit.summary, 100)}
                    </span>
                  )}
                </span>
                <span
                  className={cx(
                    "w-32 shrink-0 text-[10px]",
                    i === selected ? "text-term-bg/80" : "text-term-dim",
                  )}
                >
                  {projectName.get(hit.projectSlug) ?? hit.projectSlug}
                </span>
                <span className="h-1.5 w-20 shrink-0 border border-term-border/60 bg-term-inset">
                  <span
                    className={cx(
                      "block h-full",
                      i === selected ? "bg-term-bg/70" : "bg-term-green/60",
                    )}
                    style={{ width: `${Math.max(6, Math.round((hit.score / maxScore) * 100))}%` }}
                  />
                </span>
              </button>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
