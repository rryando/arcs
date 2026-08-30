/**
 * Web server entry — starts the HTTP server for the ARCS web UI.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { getDataDir } from "../utils/paths.js";
import { isLoopbackHost } from "./security.js";

/** Loopback only: `arcs web` refuses to bind anything else. */
const DEFAULT_WEB_HOST = "127.0.0.1";

/**
 * Default `arcs web` port.
 *
 * Deliberately uncommon (8745): 4173 is `vite preview`'s default and collides,
 * and the common dev range (3000/5173/8080/…) is crowded. The resolved port
 * is persisted to the data dir on first start (see `persistWebPort`) so the
 * URL stays stable across restarts; `--port` always wins.
 */
const DEFAULT_WEB_PORT = 8745;

/** Data-dir file holding the last resolved web port, next to web-token.json. */
const WEB_CONFIG_FILE = "web-config.json";

function webConfigPath(): string {
  return join(getDataDir(), WEB_CONFIG_FILE);
}

/** The port a previous `arcs web` run resolved to, never a caller's override. */
function persistedWebPort(): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(webConfigPath(), "utf-8")) as { port?: unknown };
    return typeof raw.port === "number" &&
      Number.isInteger(raw.port) &&
      raw.port > 0 &&
      raw.port <= 65535
      ? raw.port
      : undefined;
  } catch {
    // No file yet, or unreadable — the default stands.
    return undefined;
  }
}

/**
 * Remembers the resolved port for the next start. Skipped when the caller
 * passed an explicit port (including 0 for ephemeral), so `--port` overrides
 * never clobber the stable URL. Best-effort: an unwritable data dir costs
 * nothing but the persistence.
 */
function persistWebPort(port: number): void {
  try {
    mkdirSync(dirname(webConfigPath()), { recursive: true });
    writeFileSync(
      webConfigPath(),
      JSON.stringify({ port, updatedAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
  } catch {
    // Best-effort — a failed persist changes nothing about the running server.
  }
}

export interface StartWebServerOptions {
  /** Port to listen on (defaults to `DEFAULT_WEB_PORT`). Pass 0 for an ephemeral port. */
  port?: number;
  /** Interface to bind (defaults to `DEFAULT_WEB_HOST`). */
  host?: string;
  /** Auto-open the browser (default false here; the CLI command defaults true). */
  open?: boolean;
  /** Override the static client root. */
  staticRoot?: string;
  /** Disable the data-dir watcher (tests). */
  watch?: boolean;
}

export interface WebServerHandle {
  url: string;
  port: number;
  host: string;
  close: () => Promise<void>;
}

function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser available — the URL is printed either way.
  }
}

export async function startWebServer(
  options: StartWebServerOptions = {},
): Promise<WebServerHandle> {
  const host = options.host ?? DEFAULT_WEB_HOST;
  // Explicit flag > persisted choice > uncommon default: a stable URL across
  // restarts is the point of persisting, and a caller's `--port` (or 0) always
  // outranks both.
  const requestedPort =
    options.port ?? persistedWebPort() ?? DEFAULT_WEB_PORT;
  if (!isLoopbackHost(host)) {
    throw new Error(
      `ARCS web only binds to loopback addresses; refusing non-loopback host "${host}".`,
    );
  }
  const app = createApp({ staticRoot: options.staticRoot, watch: options.watch });

  return new Promise((resolvePromise, rejectPromise) => {
    try {
      const server = serve({ fetch: app.fetch, port: requestedPort, hostname: host }, (info) => {
        const url = `http://${host}:${info.port}`;
        // Remember only the value the caller did not pin — persisting an
        // ephemeral `--port 0` result would turn a one-off into the new default.
        if (options.port === undefined) persistWebPort(info.port);
        if (options.open) openBrowser(url);
        resolvePromise({
          url,
          port: info.port,
          host,
          close: () =>
            new Promise<void>((res) => {
              server.close(() => res());
            }),
        });
      });
      server.on("error", rejectPromise);
    } catch (err) {
      rejectPromise(err);
    }
  });
}
