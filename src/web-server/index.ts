/**
 * Web server entry — starts the HTTP server for the ARCS web UI.
 */

import { spawn } from "node:child_process";
import { serve } from "@hono/node-server";
import { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT } from "../utils/hook-contract.js";
import { createApp } from "./app.js";
import { isLoopbackHost } from "./security.js";

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
  const requestedPort = options.port ?? DEFAULT_WEB_PORT;
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
