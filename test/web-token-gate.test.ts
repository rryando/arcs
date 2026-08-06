/**
 * X-ARCS-Token gate for mutating API routes.
 *
 * The load-bearing case is the LAST one: it walks the composed Hono router
 * rather than a hand-maintained list of paths, so a mutating route added to any
 * route module later is probed automatically and fails this file if it answers
 * anything but 401 unauthenticated. The rest pin the contract around it — the
 * 0o600 token file, the reads that must stay open, the hook endpoint's separate
 * bearer gate, and the token reaching the SPA on BOTH index.html paths.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { writeHookToken } from "../src/utils/hook-token-store.js";
import { createApp } from "../src/web-server/app.js";
import { startWebServer, type WebServerHandle } from "../src/web-server/index.js";
import { currentWebToken, webTokenPath } from "../src/web-server/web-token.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const HOOK_TOKEN = "test-hook-token-0123456789";
const MUTATION_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

interface Ctx {
  base: string;
  dir: string;
}

/** Seeds a `demo` project, boots a real server, and tears both down. */
async function withServer(
  run: (ctx: Ctx) => Promise<void>,
  options: { staticRoot?: string } = {},
): Promise<void> {
  await withTempDataDir(async (dir) => {
    writeFileSync(
      resolve(dir, "meta.json"),
      JSON.stringify({
        version: "1.0",
        projects: [{ id: "demo", name: "Demo", status: "active", dependsOn: [] }],
      }),
      "utf-8",
    );
    const projectDir = resolve(dir, "projects", "demo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      resolve(projectDir, "meta.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        description: "test project",
        createdAt: "2026-01-01T00:00:00.000Z",
        workspacePaths: [],
      }),
      "utf-8",
    );
    await writeHookToken(projectDir, HOOK_TOKEN);

    let server: WebServerHandle | null = null;
    try {
      server = await startWebServer({
        port: 0,
        host: "127.0.0.1",
        watch: false,
        ...(options.staticRoot !== undefined && { staticRoot: options.staticRoot }),
      });
      await run({ base: server.url, dir });
    } finally {
      await server?.close();
    }
  });
}

/** A mutating request; `token` omitted sends no X-ARCS-Token header at all. */
async function mutate(
  base: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      ...(init.token !== undefined && { "X-ARCS-Token": init.token }),
    },
    body: JSON.stringify(init.body ?? {}),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; code?: string } | null;
  return { status: res.status, code: body?.code };
}

describe("web token gate", () => {
  it("mints a per-server token into a 0o600 file with the hook-token file shape", async () => {
    await withServer(async () => {
      const path = webTokenPath();
      const file = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;

      expect(file.token).toBe(currentWebToken());
      expect(typeof file.token).toBe("string");
      expect(file.token as string).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof file.createdAt).toBe("string");
      expect(Object.keys(file).sort()).toEqual(["createdAt", "token"]);

      // Owner-only: the hook token file used to land world-readable — the
      // mistake this assertion exists to prevent repeating. That file is 0o600
      // now too (hook-token-store.ts chmods it), so this guards a regression
      // rather than describing a live divergence.
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });

  it("rejects a mutation with no token, rejects a wrong token, accepts the real one", async () => {
    await withServer(async ({ base }) => {
      const missing = await mutate(base, "/api/p/demo/knowledge", {
        body: { id: "gated", title: "Gated", kind: "lesson", keywords: [] },
      });
      expect(missing.status).toBe(401);
      expect(missing.code).toBe("web_unauthorized");

      const wrong = await mutate(base, "/api/p/demo/knowledge", {
        token: "f".repeat(64),
        body: { id: "gated", title: "Gated", kind: "lesson", keywords: [] },
      });
      expect(wrong.status).toBe(401);
      expect(wrong.code).toBe("web_unauthorized");

      const allowed = await mutate(base, "/api/p/demo/knowledge", {
        token: currentWebToken(),
        body: { id: "gated", title: "Gated", kind: "lesson", keywords: [] },
      });
      expect(allowed.status).toBe(201);
    });
  });

  it("leaves reads open — GET routes and /api/events need no token", async () => {
    await withServer(async ({ base }) => {
      for (const path of ["/api/health", "/api/projects", "/api/p/demo", "/api/p/demo/tasks"]) {
        const res = await fetch(`${base}${path}`);
        expect({ path, status: res.status }).toEqual({ path, status: 200 });
        await res.text();
      }

      const controller = new AbortController();
      const events = await fetch(`${base}/api/events`, { signal: controller.signal });
      expect(events.status).toBe(200);
      expect(events.headers.get("content-type")).toContain("text/event-stream");
      controller.abort();
    });
  });

  it("keeps /api/hook/* on its own bearer gate, untouched by the web token", async () => {
    await withServer(async ({ base }) => {
      const event = { hook_event_name: "SessionStart", session_id: "cc-1" };

      // The web token must not open the hook endpoint...
      const webTokenOnly = await fetch(`${base}/api/hook/demo/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() ?? "" },
        body: JSON.stringify(event),
      });
      expect(webTokenOnly.status).toBe(401);
      expect(((await webTokenOnly.json()) as { code: string }).code).toBe("hook_unauthorized");

      // ...and the hook bearer alone must still work, with no web token present.
      const bearerOnly = await fetch(`${base}/api/hook/demo/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${HOOK_TOKEN}` },
        body: JSON.stringify(event),
      });
      expect(bearerOnly.status).toBe(200);
      expect(((await bearerOnly.json()) as { ok: boolean }).ok).toBe(true);
    });
  });

  it("injects the token into index.html on BOTH the root and the SPA fallback", async () => {
    const staticRoot = mkdtempSync(resolve(tmpdir(), "arcs-web-static-"));
    writeFileSync(
      resolve(staticRoot, "index.html"),
      "<!doctype html>\n<html>\n  <head>\n    <title>ARCS</title>\n  </head>\n" +
        '  <body><div id="root"></div></body>\n</html>\n',
      "utf-8",
    );

    try {
      await withServer(
        async ({ base }) => {
          const token = currentWebToken();
          expect(token).toBeTruthy();
          const expected = `<meta name="arcs-web-token" content="${token}" />`;

          // Transform point 1: the root shell.
          const root = await fetch(`${base}/`);
          expect(root.status).toBe(200);
          const rootHtml = await root.text();
          expect(rootHtml).toContain(expected);
          expect(rootHtml).toContain("</head>");
          expect(root.headers.get("cache-control")).toBe("no-store");

          // Transform point 2: the SPA fallback every deep link lands on.
          const deep = await fetch(`${base}/p/demo/knowledge/some-entry`);
          expect(deep.status).toBe(200);
          expect(await deep.text()).toContain(expected);
        },
        { staticRoot },
      );
    } finally {
      rmSync(staticRoot, { recursive: true, force: true });
    }
  });

  it("gates every mutating API route the composed router exposes", async () => {
    await withServer(async ({ base }) => {
      // Walk the real router rather than a maintained list: a route module that
      // registers a new mutation is probed here the moment it is added. This
      // second createApp rotates the process token, which is harmless — every
      // probe below is deliberately unauthenticated.
      const app = createApp({ watch: false });
      const mutating = app.routes.filter(
        (route) => MUTATION_METHODS.includes(route.method) && route.path.startsWith("/api/"),
      );

      // Guard against a vacuous pass if `routes` ever stops exposing handlers.
      expect(mutating.length).toBeGreaterThan(0);
      const signatures = mutating.map((route) => `${route.method} ${route.path}`);
      expect(signatures).toContain("POST /api/p/:slug/sessions/:id/run");
      expect(signatures.filter((sig) => sig.startsWith("POST /api/hook/"))).not.toHaveLength(0);

      for (const route of mutating) {
        // `:param` → a concrete segment; the gate runs before the handler, so
        // whether the entity exists is irrelevant to the expected answer.
        const path = route.path.replace(/:[^/]+/g, (param) =>
          param === ":slug" ? "demo" : "probe-target",
        );
        const { status, code } = await mutate(base, path, { method: route.method });

        if (route.path.startsWith("/api/hook/")) {
          // Exempt from the web token by design — its own bearer gate answers.
          expect({ path, status, code }).toEqual({ path, status: 401, code: "hook_unauthorized" });
        } else {
          expect({ path, status, code }).toEqual({ path, status: 401, code: "web_unauthorized" });
        }
      }
    });
  });
});
