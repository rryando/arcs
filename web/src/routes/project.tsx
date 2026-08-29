/**
 * Project shell — header + tab bar + nested outlet.
 *
 * The Ask-AI panel is mounted around the Outlet: `AskAIPanelProvider` owns
 * the panel state, and `AskAIPanel` renders as a right sibling of the outlet
 * (a split pane) only while open — hidden entirely below the lg breakpoint.
 */

import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useProject } from "../api/hooks";
import { AskAIPanel, AskAIPanelProvider, useAskAIPanel } from "../components/AskAIPanel";
import { Badge, statusColor } from "../components/Badge";
import { cx, truncate } from "../lib/format";

const TABS = [
  { path: "", label: "overview", key: "g o" },
  { path: "/proposal-docs", label: "proposal docs", key: "g d", count: "proposalDocs" as const },
  { path: "/plans", label: "plans", key: "g p", count: "plans" as const },
  { path: "/tasks", label: "tasks", key: "g t", count: "tasks" as const },
  { path: "/knowledge", label: "knowledge", key: "g k", count: "knowledge" as const },
  { path: "/sessions", label: "sessions", key: "g e" },
  { path: "/graph", label: "graph", key: "g g" },
];

export function ProjectShell() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { error } = useProject(slug);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  if (error) {
    return (
      <div className="p-6">
        <div className="text-term-red">project “{slug}” not found</div>
        <button
          type="button"
          className="mt-2 text-term-cyan underline"
          onClick={() => navigate({ to: "/" })}
        >
          ← back to dashboard
        </button>
      </div>
    );
  }

  return (
    <AskAIPanelProvider>
      <ShellFrame slug={slug} pathname={pathname} />
    </AskAIPanelProvider>
  );
}

function ShellFrame({ slug, pathname }: { slug: string; pathname: string }) {
  const { open } = useAskAIPanel();
  const { data: project } = useProject(slug);
  const base = `/p/${slug}`;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-term-border bg-term-panel px-3 pt-2">
        <div className="flex items-center gap-3">
          <span className="text-term-green">▸</span>
          <h1 className="text-[15px] font-bold">{project?.name ?? slug}</h1>
          {project && <Badge color={statusColor(project.status)}>{project.status}</Badge>}
          <span className="text-[11px] text-term-dim">{slug}</span>
          <span className="flex-1" />
          {project?.workspacePaths[0] && (
            <span className="text-[11px] text-term-dim">
              {truncate(project.workspacePaths[0], 48)}
            </span>
          )}
          <PanelToggle />
        </div>
        {project?.description && (
          <p className="mt-0.5 pl-5 text-[11px] text-term-dim">
            {truncate(project.description, 140)}
          </p>
        )}

        <nav className="mt-2 flex items-center gap-px">
          {TABS.map((tab) => {
            const to = `${base}${tab.path}`;
            const active =
              tab.path === ""
                ? pathname === base || pathname === `${base}/`
                : pathname.startsWith(to);
            const count = tab.count && project ? project.counts[tab.count] : null;
            return (
              <Link
                key={tab.path}
                to={to as never}
                className={cx(
                  "border border-b-0 px-3 py-1 text-[12px]",
                  active
                    ? "border-term-border bg-term-bg font-bold text-term-green"
                    : "border-transparent text-term-dim hover:text-term-fg",
                )}
              >
                {tab.label}
                {count !== null && count > 0 && (
                  <span className="ml-1 text-[10px] opacity-70">{count}</span>
                )}
                <span className="ml-1.5 hidden text-[9px] opacity-40 xl:inline">{tab.key}</span>
              </Link>
            );
          })}
        </nav>
      </header>

      {/* split pane: outlet + session panel (panel hidden below lg) */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full">
          <div className="min-w-0 flex-1 overflow-hidden">
            <Outlet />
          </div>
          {open && <AskAIPanel />}
        </div>
      </div>
    </div>
  );
}

/** Shell-level toggle for the session panel — only meaningful at lg+. */
function PanelToggle() {
  const { open, toggle } = useAskAIPanel();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={open}
      title={open ? "close ask ai panel" : "open ask ai panel"}
      className={cx(
        "hidden items-center gap-1 border px-2 py-1 text-[12px] lg:inline-flex",
        open
          ? "border-term-green/60 bg-term-green font-bold text-term-bg"
          : "border-term-border text-term-dim hover:text-term-fg",
      )}
    >
      <span>{open ? "▮" : "▤"}</span> ask ai
    </button>
  );
}
