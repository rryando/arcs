/**
 * Web server application factory.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { getDataDir, PACKAGE_ROOT } from "../utils/paths.js";
import { ok } from "./respond.js";
import { collectionsRoute } from "./routes/collections.js";
import { discoveryRoute } from "./routes/discovery.js";
import { eventsRoute } from "./routes/events.js";
import { projectsRoute } from "./routes/projects.js";
import { proposalDocsRoute } from "./routes/proposal-docs.js";
import { sessionsRoute } from "./routes/sessions.js";
import { workspaceRoute } from "./routes/workspace.js";
import { secureLocalRequest } from "./security.js";
import { settleOrphanedRunsOnStartup } from "./session-reconciler.js";
import { registerStaticServing } from "./static.js";
import { startWatcher } from "./watcher.js";
import { requireWebToken } from "./web-auth.js";
import { mintWebToken } from "./web-token.js";

export interface CreateAppOptions {
  /** Override the static client root (default: <package>/dist/web-client). */
  staticRoot?: string;
  /**
   * Disable the startup side effects — the data-dir watcher and the
   * orphaned-run sweep (tests). Default: true.
   */
  watch?: boolean;
}

function packageVersion(): string {
  try {
    const raw = readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf-8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function defaultStaticRoot(): string {
  return resolve(PACKAGE_ROOT, "dist", "web-client");
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const app = new Hono();

  // Minted before a single route is registered: both the mutation gate and the
  // index.html transform read the value this installs.
  mintWebToken();

  app.use("*", secureLocalRequest);
  // Browser-driven mutations need a secret of their own — loopback alone lets
  // any other local process drive them. Deny-by-default.
  app.use("/api/*", requireWebToken);

  app.get("/api/health", (c) =>
    c.json(
      ok({
        name: "arcs-web",
        version: packageVersion(),
        dataDir: getDataDir(),
        time: new Date().toISOString(),
      }),
    ),
  );

  app.route("/", projectsRoute);
  app.route("/", collectionsRoute);
  app.route("/", sessionsRoute);
  // Read-only file plane (two GETs, no writes) — see routes/workspace.ts.
  app.route("/", workspaceRoute);
  app.route("/", discoveryRoute);
  app.route("/", proposalDocsRoute);
  app.route("/", eventsRoute);

  if (options.watch !== false) {
    startWatcher(getDataDir());
    // A run claim persisted by an earlier server process cannot be live in this
    // one unless its child outlived the restart, so any claim whose process is
    // gone settles here as `interrupted` — otherwise the session renders
    // "running" forever with nothing left that could ever settle it. One pass at
    // boot, never a poller; the sweep resolves rather than rejects, and the
    // server must not wait on it.
    void settleOrphanedRunsOnStartup(getDataDir());
  }

  registerStaticServing(app, options.staticRoot ?? defaultStaticRoot());

  return app;
}
