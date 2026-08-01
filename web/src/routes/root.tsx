/**
 * Root layout — sidebar, main outlet, status bar, palette/help overlays,
 * and the global goto shortcuts.
 */

import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { CommandPalette } from "../components/CommandPalette";
import { HelpOverlay } from "../components/HelpOverlay";
import { Sidebar } from "../components/Sidebar";
import { StatusBar } from "../components/StatusBar";
import { useShortcuts } from "../hooks/useShortcuts";

export function RootLayout() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { slug?: string };
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const slug = params.slug;

  const bindings = useMemo(() => {
    const list = [
      {
        keys: "/",
        description: "command palette",
        group: "global",
        run: () => setPaletteOpen(true),
      },
      {
        keys: "ctrl+k",
        description: "command palette",
        group: "global",
        allowInInput: true,
        run: () => setPaletteOpen(true),
      },
      {
        keys: "?",
        description: "shortcut help",
        group: "global",
        run: () => setHelpOpen((v) => !v),
      },
      {
        keys: "g d",
        description: "go to dashboard",
        group: "goto",
        run: () => navigate({ to: "/" }),
      },
      {
        keys: "g s",
        description: "go to search",
        group: "goto",
        run: () => navigate({ to: "/search" }),
      },
    ];
    if (slug) {
      const go = (path: string) => () =>
        navigate({ to: `/p/$slug${path}`, params: { slug } } as never);
      list.push(
        { keys: "g o", description: "go to overview", group: "goto", run: go("") },
        { keys: "g k", description: "go to knowledge", group: "goto", run: go("/knowledge") },
        { keys: "g t", description: "go to tasks", group: "goto", run: go("/tasks") },
        { keys: "g p", description: "go to plans", group: "goto", run: go("/plans") },
        { keys: "g e", description: "go to sessions", group: "goto", run: go("/sessions") },
        { keys: "g g", description: "go to graph", group: "goto", run: go("/graph") },
        { keys: "g r", description: "go to proposals", group: "goto", run: go("/proposals") },
      );
    }
    return list;
  }, [navigate, slug]);

  useShortcuts(bindings);

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
        <StatusBar />
      </div>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
