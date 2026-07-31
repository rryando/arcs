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
import { secureLocalRequest } from "./security.js";
import { registerStaticServing } from "./static.js";
import { startWatcher } from "./watcher.js";

export interface CreateAppOptions {
  /** Override the static client root (default: <package>/dist/web-client). */
  staticRoot?: string;
  /** Disable the data-dir watcher (tests). Default: true. */
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

  app.use("*", secureLocalRequest);

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
  app.route("/", discoveryRoute);
  app.route("/", eventsRoute);

  if (options.watch !== false) {
    startWatcher(getDataDir());
  }

  registerStaticServing(app, options.staticRoot ?? defaultStaticRoot());

  return app;
}
