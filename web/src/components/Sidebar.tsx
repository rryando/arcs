/**
 * Sidebar — project tree with counts and status glyphs.
 */

import { Link, useParams } from "@tanstack/react-router";
import { useProjects } from "../api/hooks";
import { cx } from "../lib/format";

export function Sidebar() {
  const { data } = useProjects();
  const params = useParams({ strict: false }) as { slug?: string };
  const projects = data?.projects ?? [];

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-term-border bg-term-panel">
      <Link to="/" className="flex items-center gap-2 border-b border-term-border px-3 py-2">
        <span className="font-bold text-term-green">ARCS</span>
        <span className="text-term-dim">{"// kb"}</span>
      </Link>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <div className="px-3 pt-1 pb-1 text-[10px] tracking-wide text-term-dim uppercase">
          projects [{projects.length}]
        </div>
        {projects.map((p) => {
          const active = params.slug === p.slug;
          return (
            <Link
              key={p.slug}
              to="/p/$slug"
              params={{ slug: p.slug }}
              className={cx(
                "block px-3 py-1 text-[12px] leading-5",
                active ? "bg-term-green text-term-bg" : "text-term-fg hover:bg-term-fg/5",
              )}
            >
              <span className="flex items-center gap-2">
                <span className={p.status === "active" ? "text-inherit" : "opacity-40"}>
                  {active ? "▸" : "●"}
                </span>
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
              </span>
              <span
                className={cx(
                  "block pl-4 text-[10px]",
                  active ? "text-term-bg/80" : "text-term-dim",
                )}
              >
                k{p.counts.knowledge} t{p.counts.tasks} p{p.counts.plans}
                {p.counts.proposals > 0 ? ` ⚑${p.counts.proposals}` : ""}
              </span>
            </Link>
          );
        })}
        {projects.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-term-dim">no projects in the DAG</div>
        )}
      </div>

      <div className="border-t border-term-border px-3 py-1.5 text-[10px] text-term-dim">
        <span className="kbd">/</span> search · <span className="kbd">?</span> help
      </div>
    </aside>
  );
}
