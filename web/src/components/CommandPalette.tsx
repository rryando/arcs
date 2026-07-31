/**
 * Command palette — fzf-fuzzy jump-to-anything over the flat index
 * (projects, knowledge, plans, tasks) plus static navigation commands.
 * Opened with "/" or ctrl+k.
 */

import { useNavigate } from "@tanstack/react-router";
import { Fzf } from "fzf";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FlatEntry } from "../api/client";
import { useFlatIndex } from "../api/hooks";
import { cx } from "../lib/format";
import { Badge, typeColor } from "./Badge";

interface PaletteItem {
  key: string;
  type: FlatEntry["type"] | "action";
  slug?: string;
  id?: string;
  title: string;
  hint: string;
  selector: string;
  go: () => void;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { data } = useFlatIndex();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [
      {
        key: "action:dashboard",
        type: "action",
        title: "go to dashboard",
        hint: "nav",
        selector: "dashboard home projects",
        go: () => navigate({ to: "/" }),
      },
      {
        key: "action:search",
        type: "action",
        title: "go to full search (bm25)",
        hint: "nav",
        selector: "search bm25 find query",
        go: () => navigate({ to: "/search" }),
      },
    ];

    const projectName = data?.projectName ?? {};
    for (const entry of data?.entries ?? []) {
      const pName = projectName[entry.slug] ?? entry.slug;
      list.push({
        key: `${entry.type}:${entry.slug}:${entry.id}`,
        type: entry.type,
        slug: entry.slug,
        id: entry.id,
        title: entry.title,
        hint: entry.type === "project" ? entry.hint : `${pName} · ${entry.hint}`,
        selector: `${entry.title} ${entry.keywords.join(" ")} ${entry.slug} ${pName} ${entry.type}`,
        go: () => {
          if (entry.type === "project") {
            navigate({ to: "/p/$slug", params: { slug: entry.slug } });
          } else if (entry.type === "knowledge") {
            navigate({ to: "/p/$slug/knowledge/$id", params: { slug: entry.slug, id: entry.id } });
          } else if (entry.type === "plan") {
            navigate({ to: "/p/$slug/plans/$id", params: { slug: entry.slug, id: entry.id } });
          } else {
            navigate({ to: "/p/$slug/tasks", params: { slug: entry.slug } });
          }
        },
      });
    }
    return list;
  }, [data, navigate]);

  const fzf = useMemo(
    () =>
      new Fzf(items, {
        selector: (item) => item.selector,
        casing: "smart-case",
      }),
    [items],
  );

  const results = useMemo(() => {
    if (!query.trim())
      return items.slice(0, 30).map((item) => ({ item, positions: new Set<number>() }));
    return fzf.find(query).slice(0, 30);
  }, [fzf, query, items]);

  useEffect(() => inputRef.current?.focus(), []);

  const open = (index: number) => {
    const hit = results[index];
    if (!hit) return;
    onClose();
    hit.item.go();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setSelected((s) => Math.min(results.length - 1, s + 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center pt-[12vh]">
      <button
        type="button"
        aria-label="Close palette"
        className="absolute inset-0 cursor-default bg-black/60"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-2xl border border-term-border-hi bg-term-panel shadow-2xl shadow-black/70">
        <div className="flex items-center gap-2 border-b border-term-border px-3 py-2">
          <span className="text-term-green">▸</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="jump to project, knowledge, plan, task…"
            className="flex-1 bg-transparent text-[13px] text-term-fg outline-none placeholder:text-term-dim/60"
          />
          <span className="kbd">esc</span>
        </div>

        <div className="max-h-[55vh] overflow-y-auto">
          {results.length === 0 && (
            <div className="px-3 py-6 text-center text-term-dim">no matches for “{query}”</div>
          )}
          {results.map(({ item }, i) => (
            <button
              type="button"
              key={item.key}
              onMouseEnter={() => setSelected(i)}
              onClick={() => open(i)}
              className={cx(
                "flex w-full items-center gap-2 px-3 py-1 text-left text-[12px]",
                i === selected ? "bg-term-green text-term-bg" : "text-term-fg",
              )}
            >
              <Badge
                color={typeColor(item.type)}
                className={i === selected ? "border-term-bg/50 text-term-bg" : ""}
              >
                {item.type === "action" ? "go" : item.type}
              </Badge>
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span
                className={cx("text-[10px]", i === selected ? "text-term-bg/70" : "text-term-dim")}
              >
                {item.hint}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 border-t border-term-border px-3 py-1 text-[10px] text-term-dim">
          <span>
            <span className="kbd">↑↓</span> move
          </span>
          <span>
            <span className="kbd">enter</span> open
          </span>
          <span>fzf · {results.length} hits</span>
        </div>
      </div>
    </div>
  );
}
