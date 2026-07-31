/**
 * Static client bundle serving with SPA fallback.
 *
 * The Vite build output lives at dist/web-client (resolved by the caller).
 * If the bundle is missing, the server runs API-only and explains how to
 * build the client.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { fail } from "./respond.js";

const NOT_BUILT_HINT =
  "ARCS web client is not built. Run `npm run build:web` in the arcs repo (or reinstall @rryando/arcs).";

export function registerStaticServing(app: Hono, root: string): void {
  if (!existsSync(join(root, "index.html"))) {
    app.notFound((c) => {
      if (c.req.path.startsWith("/api/")) {
        return c.json(fail("not_found", `No route: ${c.req.method} ${c.req.path}`), 404);
      }
      return c.text(NOT_BUILT_HINT, 404);
    });
    return;
  }

  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();
    return serveStatic({ root })(c, next);
  });

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json(fail("not_found", `No route: ${c.req.method} ${c.req.path}`), 404);
    }
    // SPA fallback — client-side routing takes over.
    return serveStatic({ path: join(root, "index.html") })(c, async () => {}) as Promise<Response>;
  });
}
