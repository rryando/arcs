/**
 * Web server application factory.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { getDataDir, PACKAGE_ROOT } from "../utils/paths.js";
import { requireHookToken } from "./hook-auth.js";
import { startOpencodeDiscovery } from "./opencode-client.js";
import { ok } from "./respond.js";
import { collectionsRoute } from "./routes/collections.js";
import { discoveryRoute } from "./routes/discovery.js";
import { eventsRoute } from "./routes/events.js";
import { hookEventsRoute } from "./routes/hook-events.js";
import { projectsRoute } from "./routes/projects.js";
import { sessionsRoute } from "./routes/sessions.js";
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
  // Agent-driven, not browser-driven: the hook endpoint needs a shared secret on
  // top of the loopback check every other route relies on.
  app.use("/api/hook/*", requireHookToken);

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
  app.route("/", hookEventsRoute);
  app.route("/", discoveryRoute);
  app.route("/", eventsRoute);

  if (options.watch !== false) {
    startWatcher(getDataDir());
    // No-op unless an opencode endpoint is configured in the environment.
    startOpencodeDiscovery();
  }

  registerStaticServing(app, options.staticRoot ?? defaultStaticRoot());

  return app;
}
