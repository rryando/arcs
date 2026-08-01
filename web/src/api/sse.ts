/**
 * SSE subscription: invalidates TanStack Query caches when the server
 * reports data-dir changes (CLI writes, other agents, external edits).
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "./client";
import { keysForArea } from "./hooks";

export interface SseState {
  connected: boolean;
  lastEvent: ChangeEvent | null;
}

export function useServerEvents(): SseState {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<ChangeEvent | null>(null);
  const retryRef = useRef(0);

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      source = new EventSource("/api/events");

      source.onopen = () => {
        retryRef.current = 0;
        setConnected(true);
      };

      source.addEventListener("change", (raw) => {
        try {
          const event = JSON.parse((raw as MessageEvent).data) as ChangeEvent;
          setLastEvent(event);
          for (const key of keysForArea(event.slug, event.area)) {
            void qc.invalidateQueries({ queryKey: key });
          }
        } catch {
          // Malformed event — ignore.
        }
      });

      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (closed) return;
        const delay = Math.min(10_000, 1_000 * 2 ** retryRef.current++);
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [qc]);

  return { connected, lastEvent };
}
