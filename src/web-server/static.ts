/**
 * Static client bundle serving with SPA fallback.
 *
 * The Vite build output lives at dist/web-client (resolved by the caller).
 * If the bundle is missing, the server runs API-only and explains how to
 * build the client.
 *
 * index.html is never streamed verbatim: it is read and transformed so the SPA
 * boots holding this server's mutation token (see web-token.ts) without a
 * second fetch. There are TWO paths that answer with index.html — the direct
 * request for `/` and the SPA fallback that backs every deep link — and both go
 * through the same transform, because a shell served without the token is a
 * client that cannot write.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";
import { fail } from "./respond.js";
import { currentWebToken } from "./web-token.js";

const NOT_BUILT_HINT =
  "ARCS web client is not built. Run `npm run build:web` in the arcs repo (or reinstall @rryando/arcs).";

/**
 * Client contract: the SPA reads its token from
 * `<meta name="arcs-web-token" content="…">` in the document head and sends it
 * back as the `X-ARCS-Token` header on every mutating request.
 */
const TOKEN_META_NAME = "arcs-web-token";

/** Request paths that resolve to the SPA shell rather than a bundled asset. */
const INDEX_PATHS = new Set(["/", "/index.html"]);

/**
 * Reads the built shell and injects this server's token as a head meta tag.
 *
 * The token is hex, so it needs no HTML escaping, and the source is always the
 * untouched Vite output — the server only ever reads index.html, never writes
 * it back, so the injection cannot accumulate across restarts. `no-store` keeps
 * a rotated token from being served from a stale cache after a restart.
 */
function serveIndexHtml(c: Context, root: string): Response | Promise<Response> {
  let shell: string;
  try {
    shell = readFileSync(join(root, "index.html"), "utf-8");
  } catch {
    // The bundle vanished after startup — same answer as never having built it.
    return c.text(NOT_BUILT_HINT, 404);
  }

  const meta = `<meta name="${TOKEN_META_NAME}" content="${currentWebToken() ?? ""}" />`;
  const injected = shell.includes("</head>")
    ? shell.replace("</head>", `  ${meta}\n  </head>`)
    : `${meta}\n${shell}`;

  return c.html(injected, 200, { "cache-control": "no-store" });
}

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
    // Transform point 1 — the direct shell request.
    if (INDEX_PATHS.has(c.req.path)) return serveIndexHtml(c, root);
    return serveStatic({ root })(c, next);
  });

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json(fail("not_found", `No route: ${c.req.method} ${c.req.path}`), 404);
    }
    // Transform point 2 — SPA fallback, where client-side routing takes over.
    // Deep links land here and need the token just as much as `/` does.
    return serveIndexHtml(c, root);
  });
}
