/**
 * ARCS web server status in pi's footer/status bar.
 *
 * Polls `GET http://127.0.0.1:<port>/api/health` on session start and every
 * 5s, showing an up/down glyph next to the resolved URL. The port is read
 * from the persisted `web-config.json` in the ARCS data dir (mirrors how the
 * ARCS server resolves it: `ARCS_DATA_DIR` env var wins, else `~/.arcs`),
 * falling back to the server default 8745.
 *
 * The status entry is intentionally KEPT (with the ○ down glyph) when the
 * server is unreachable so the user can see that it stopped — it is never
 * cleared, and polling continues.
 *
 * Usage: pi -e web/extensions/arcs-web-status.ts
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Server default, kept in sync with DEFAULT_WEB_PORT in src/web-server/index.ts. */
const DEFAULT_WEB_PORT = 8745;
const WEB_CONFIG_FILE = "web-config.json";
const STATUS_KEY = "arcs-web";
const POLL_INTERVAL_MS = 5_000;
/** Give a hung server a timeout so the status never goes stale. */
const FETCH_TIMEOUT_MS = 3_000;

interface WebConfig {
  port: number;
}

/** ARCS data dir: ARCS_DATA_DIR env var wins, else ~/.arcs (mirrors getDataDir()). */
function arcsDataDir(): string {
  const envDir = process.env.ARCS_DATA_DIR;
  if (envDir) return resolve(envDir);
  return join(homedir(), ".arcs");
}

/**
 * Read the persisted web port. Absent/unreadable/invalid config falls back to
 * the default — same validation the server applies in persistedWebPort().
 */
function resolveWebPort(): number {
  try {
    const raw = JSON.parse(
      readFileSync(join(arcsDataDir(), WEB_CONFIG_FILE), "utf-8"),
    ) as { port?: unknown };
    const port = raw.port;
    return typeof port === "number" &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65535
      ? port
      : DEFAULT_WEB_PORT;
  } catch {
    return DEFAULT_WEB_PORT;
  }
}

/** True when the health endpoint answers with a 2xx AND an ok envelope. */
async function isWebServerUp(url: string): Promise<boolean> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return false;
  const body = (await res.json()) as { ok?: unknown };
  return body.ok === true;
}

/** Open the web UI in the platform default browser, detached from pi. */
function openBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export default function (pi: ExtensionAPI) {
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  /** Guards against overlapping polls: skip when the previous fetch is still in flight. */
  let polling = false;

  const updateStatus = async (ctx: ExtensionContext): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const port = resolveWebPort();
      const up = await isWebServerUp(`http://127.0.0.1:${port}/api/health`);
      // Keep the entry on down (○) — the user wants to see that it stopped.
      ctx.ui.setStatus(STATUS_KEY, `${up ? "●" : "○"} arcs-web 127.0.0.1:${port}`);
    } catch {
      // Unreachable/timeout/parse error → down state; entry stays visible.
      const port = resolveWebPort();
      ctx.ui.setStatus(STATUS_KEY, `○ arcs-web 127.0.0.1:${port}`);
    } finally {
      polling = false;
    }
  };

  // Defer the background timer to session scope (docs: no timers from the
  // factory). session_start fires at startup; session_shutdown tears it down.
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return; // no status bar in print/json mode; nothing to show
    await updateStatus(ctx);
    if (!pollTimer) {
      pollTimer = setInterval(() => void updateStatus(ctx), POLL_INTERVAL_MS);
    }
  });

  pi.on("session_shutdown", async () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  });

  // Optional but useful: /arcs-web opens the UI in the browser.
  pi.registerCommand("arcs-web", {
    description: "Open the ARCS web UI in your browser",
    handler: async (_args, ctx) => {
      const url = `http://127.0.0.1:${resolveWebPort()}`;
      openBrowser(url);
      ctx.ui.notify(`Opening ${url}`, "info");
    },
  });
}