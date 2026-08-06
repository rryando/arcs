import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Mirrors getDataDir() in src/utils/paths.ts: ARCS_DATA_DIR wins, else ~/.arcs.
 * Duplicated rather than imported — vite bundles this config standalone and
 * must not pull the server's module graph in — so the two move together.
 */
function arcsDataDir(): string {
  const envDir = process.env.ARCS_DATA_DIR;
  return envDir ? resolve(envDir) : resolve(homedir(), ".arcs");
}

/**
 * Dev-only injection of the server's mutation token.
 *
 * In a build the shell is served by ARCS itself, which injects
 * `<meta name="arcs-web-token">` on the way out (src/web-server/static.ts).
 * `vite dev` does not go through that path at all: it serves web/index.html
 * from disk at :5173 and only proxies /api to the server, so without this
 * plugin the dev SPA holds no token and every POST/PUT/PATCH/DELETE comes back
 * 401 from the gate in src/web-server/web-auth.ts.
 *
 * This dev server is the one consumer that justifies web-token.json existing on
 * disk at all — it is a separate process from the ARCS server and has no other
 * way to learn the token. Note what that file's 0o600 mode does and does not
 * buy: it keeps the token away from OTHER UNIX USERS. It is no barrier at all
 * to any process running as this user, this plugin included.
 *
 * `apply: "serve"` is what keeps this out of `vite build`: a production shell
 * must only ever carry the token minted by the process actually serving it.
 */
function arcsWebTokenDevPlugin(): Plugin {
  const tokenFile = join(arcsDataDir(), "web-token.json");
  let warned = false;

  return {
    name: "arcs-web-token-dev",
    apply: "serve",
    transformIndexHtml() {
      // Read per request, not once at startup: restarting `arcs web` mints a
      // new token, and a browser reload should pick it up without restarting
      // vite.
      let token: string | undefined;
      try {
        token = (JSON.parse(readFileSync(tokenFile, "utf-8")) as { token?: string }).token;
      } catch {
        token = undefined;
      }

      if (!token) {
        // Missing/unreadable file is not fatal: a dev server that refuses to
        // boot because ARCS has never run is worse than mutations answering
        // 401. Warn once, then stay quiet across reloads.
        if (!warned) {
          warned = true;
          console.warn(
            `[arcs] no web token at ${tokenFile} — reads work, mutations will 401 until \`arcs web\` has run (then reload).`,
          );
        }
        return;
      }

      return [{ tag: "meta", attrs: { name: "arcs-web-token", content: token }, injectTo: "head" }];
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), arcsWebTokenDevPlugin()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4173",
    },
  },
  build: {
    outDir: "../dist/web-client",
    emptyOutDir: true,
  },
});
