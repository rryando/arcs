/**
 * SSE route: pushes debounced data-dir change events to connected clients.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type ChangeEvent, onDataChange } from "../watcher.js";

export const eventsRoute = new Hono();

const HEARTBEAT_MS = 25_000;

eventsRoute.get("/api/events", (c) =>
  streamSSE(c, async (stream) => {
    const listener = (event: ChangeEvent) => {
      void stream.writeSSE({ event: "change", data: JSON.stringify(event) }).catch(() => {});
    };
    const unsubscribe = onDataChange(listener);

    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
    }, HEARTBEAT_MS);

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
        resolve();
      });
    });
  }),
);
