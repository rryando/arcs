/**
 * Bottom status bar — connection state, current context, last change event.
 */

import { useParams } from "@tanstack/react-router";
import { useServerEvents } from "../api/sse";
import { relativeTime } from "../lib/format";

export function StatusBar() {
  const { connected, lastEvent } = useServerEvents();
  const params = useParams({ strict: false }) as { slug?: string };

  return (
    <footer className="flex items-center gap-3 border-t border-term-border bg-term-panel px-3 py-1 text-[11px] text-term-dim">
      <span className={connected ? "text-term-green" : "text-term-red"}>
        {connected ? "●" : "○"}
      </span>
      <span className="font-bold text-term-fg">arcs-web</span>
      {params.slug && (
        <span>
          project: <span className="text-term-green">{params.slug}</span>
        </span>
      )}
      <span className="flex-1" />
      {lastEvent && (
        <span>
          Δ {lastEvent.slug ? `${lastEvent.slug}:` : ""}
          {lastEvent.area} · {relativeTime(lastEvent.at)}
        </span>
      )}
      <span>
        <span className="kbd">g</span>+<span className="kbd">d</span> dash ·{" "}
        <span className="kbd">?</span> help
      </span>
    </footer>
  );
}
