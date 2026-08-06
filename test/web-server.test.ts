/**
 * Web server route tests — CRUD round-trips, envelope shape, cycle
 * detection, graph serialization, search, and SSE change events.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectRetrievalIndex } from "../src/retrieval/index-builder.js";
import { startWebServer, type WebServerHandle } from "../src/web-server/index.js";
import { requireProjectDir } from "../src/web-server/respond.js";
import { onDataChange, startWatcher, stopWatcher } from "../src/web-server/watcher.js";
import { currentWebToken } from "../src/web-server/web-token.js";

const SEED_META = JSON.stringify({
  version: "1.0",
  projects: [{ id: "demo", name: "Demo", status: "active", dependsOn: [] }],
});

interface Ctx {
  dir: string;
  server: WebServerHandle;
  base: string;
}

async function setup(): Promise<Ctx> {
  const dir = mkdtempSync(resolve(tmpdir(), "arcs-web-test-"));
  writeFileSync(resolve(dir, "meta.json"), SEED_META, "utf-8");
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

  process.env.ARCS_DATA_DIR = dir;

  const server = await startWebServer({ port: 0, host: "127.0.0.1" });

  return {
    dir,
    server,
    base: `http://127.0.0.1:${server.port}`,
  };
}

let ctx: Ctx | null = null;
let savedDataDir: string | undefined;

afterEach(async () => {
  if (ctx) {
    await ctx.server.close();
    rmSync(ctx.dir, { recursive: true, force: true });
    ctx = null;
  }
  stopWatcher();
  if (savedDataDir === undefined) {
    delete process.env.ARCS_DATA_DIR;
  } else {
    process.env.ARCS_DATA_DIR = savedDataDir;
  }
});

async function boot(): Promise<Ctx> {
  savedDataDir = process.env.ARCS_DATA_DIR;
  ctx = await setup();
  return ctx;
}

/**
 * Stands in for the SPA: mutating routes now require the per-server token the
 * server injects into index.html (see web-token-gate.test.ts), so the happy-path
 * helper always carries it. Cases asserting the pre-token guards (403/415) build
 * their own bare fetch, since those checks run ahead of the token gate.
 */
async function api(base: string, path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() ?? "" },
    ...init,
  });
  const body = (await res.json()) as {
    ok: boolean;
    data?: unknown;
    code?: string;
    message?: string;
  };
  return { status: res.status, body };
}

describe("web server", () => {
  it("rejects non-loopback bind addresses", async () => {
    await expect(
      startWebServer({ host: "0.0.0.0", port: 0, open: false, watch: false }),
    ).rejects.toThrow(/loopback/i);
  });

  it("rejects cross-site mutation origins", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/api/p/demo/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ title: "csrf task" }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("forbidden_origin");
  });

  it("requires JSON content type for mutations", async () => {
    const { base } = await boot();
    const response = await fetch(`${base}/api/p/demo/tasks`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ title: "plain task" }),
    });
    expect(response.status).toBe(415);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("unsupported_media_type");
  });

  it("rejects non-canonical project slugs before path resolution", async () => {
    savedDataDir = process.env.ARCS_DATA_DIR;
    const dir = mkdtempSync(resolve(tmpdir(), "arcs-web-slug-test-"));
    process.env.ARCS_DATA_DIR = dir;
    expect(() => requireProjectDir("../tokens")).toThrow(/invalid project slug/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves health with the temp data dir", async () => {
    const { base } = await boot();
    const { body } = await api(base, "/api/health");
    expect(body.ok).toBe(true);
    expect((body.data as { dataDir: string }).dataDir).toBe(process.env.ARCS_DATA_DIR);
  });

  it("lists projects with counts", async () => {
    const { base } = await boot();
    const { body } = await api(base, "/api/projects");
    expect(body.ok).toBe(true);
    const projects = (
      body.data as { projects: Array<{ slug: string; counts: { knowledge: number } }> }
    ).projects;
    expect(projects).toHaveLength(1);
    expect(projects[0]?.slug).toBe("demo");
    expect(projects[0]?.counts.knowledge).toBe(0);
  });

  it("round-trips a knowledge entry (create → read → patch → delete)", async () => {
    const { base } = await boot();

    const created = await api(base, "/api/p/demo/knowledge", {
      method: "POST",
      body: JSON.stringify({
        id: "round trip",
        title: "Round Trip",
        kind: "lesson",
        keywords: ["test"],
        content: "# Round Trip\n\nbody v1",
      }),
    });
    expect(created.status).toBe(201);

    const read = await api(base, "/api/p/demo/knowledge/round-trip");
    expect(read.body.ok).toBe(true);
    const readData = read.body.data as { meta: { title: string }; body: string };
    expect(readData.meta.title).toBe("Round Trip");
    expect(readData.body).toContain("body v1");

    const patched = await api(base, "/api/p/demo/knowledge/round-trip", {
      method: "PATCH",
      body: JSON.stringify({ summary: "updated summary", body: "# Round Trip\n\nbody v2" }),
    });
    expect(patched.body.ok).toBe(true);
    const patchedData = patched.body.data as { meta: { summary: string }; body: string };
    expect(patchedData.meta.summary).toBe("updated summary");
    expect(patchedData.body).toContain("body v2");

    const deleted = await api(base, "/api/p/demo/knowledge/round-trip", { method: "DELETE" });
    expect(deleted.body.ok).toBe(true);

    const gone = await api(base, "/api/p/demo/knowledge/round-trip");
    expect(gone.status).toBe(404);
    expect(gone.body.ok).toBe(false);
  });

  it("preserves concurrent knowledge metadata patches", async () => {
    const { base } = await boot();
    await api(base, "/api/p/demo/knowledge", {
      method: "POST",
      body: JSON.stringify({
        id: "concurrent knowledge",
        title: "Concurrent Knowledge",
        kind: "lesson",
        keywords: [],
      }),
    });

    await Promise.all([
      api(base, "/api/p/demo/knowledge/concurrent-knowledge", {
        method: "PATCH",
        body: JSON.stringify({ summary: "kept summary" }),
      }),
      api(base, "/api/p/demo/knowledge/concurrent-knowledge", {
        method: "PATCH",
        body: JSON.stringify({ keywords: ["kept-keyword"] }),
      }),
    ]);

    const read = await api(base, "/api/p/demo/knowledge/concurrent-knowledge");
    expect((read.body.data as { meta: Record<string, unknown> }).meta).toMatchObject({
      summary: "kept summary",
      keywords: ["kept-keyword"],
    });
  });

  it("rejects invalid knowledge kind with INVALID_BODY", async () => {
    const { base } = await boot();
    const res = await api(base, "/api/p/demo/knowledge", {
      method: "POST",
      body: JSON.stringify({ id: "x", title: "X", kind: "bogus", keywords: [] }),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_BODY");
  });

  it("detects task dependency cycles through the API", async () => {
    const { base } = await boot();
    await api(base, "/api/p/demo/tasks", { method: "POST", body: JSON.stringify({ title: "a" }) });
    const res = await api(base, "/api/p/demo/tasks/a", {
      method: "PATCH",
      body: JSON.stringify({ dependsOn: ["a"] }),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TASK_DEPENDENCY_CYCLE");
  });

  it("returns tasks in topological order", async () => {
    const { base } = await boot();
    await api(base, "/api/p/demo/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "first" }),
    });
    await api(base, "/api/p/demo/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "second", dependsOn: ["first"] }),
    });
    const res = await api(base, "/api/p/demo/tasks?order=topo");
    const data = res.body.data as { tasks: Array<{ normalizedId: string }>; order: string[] };
    expect(data.order.indexOf("first")).toBeLessThan(data.order.indexOf("second"));
  });

  it("preserves concurrent task creates", async () => {
    const { base } = await boot();
    await Promise.all([
      api(base, "/api/p/demo/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "concurrent one" }),
      }),
      api(base, "/api/p/demo/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "concurrent two" }),
      }),
    ]);

    const result = await api(base, "/api/p/demo/tasks?order=topo");
    const ids = (result.body.data as { tasks: Array<{ normalizedId: string }> }).tasks.map(
      (task) => task.normalizedId,
    );
    expect(ids.sort()).toEqual(["concurrent-one", "concurrent-two"]);
  });

  it("serializes the project graph", async () => {
    const { base } = await boot();
    await api(base, "/api/p/demo/knowledge", {
      method: "POST",
      body: JSON.stringify({ id: "node", title: "Node", kind: "pattern", keywords: ["g"] }),
    });
    const res = await api(base, "/api/p/demo/graph");
    const data = res.body.data as {
      nodes: Array<{ id: string; type: string; kind?: string }>;
      edges: unknown[];
    };
    expect(data.nodes.some((n) => n.id === "knowledge:node" && n.kind === "pattern")).toBe(true);
  });

  it("searches across projects with BM25", async () => {
    const { base } = await boot();
    await api(base, "/api/p/demo/knowledge", {
      method: "POST",
      body: JSON.stringify({
        id: "write gate",
        title: "Write Gate Model",
        kind: "architecture",
        keywords: ["tokens"],
        summary: "guarded writes",
      }),
    });
    const res = await api(base, "/api/search?q=write+gate");
    const data = res.body.data as { results: Array<{ entryId: string }> };
    expect(data.results.some((r) => r.entryId === "write-gate")).toBe(true);
  });

  it("reuses BM25 indexes until their source index files change", async () => {
    const { base, dir } = await boot();
    const projectDir = resolve(dir, "projects", "demo");
    mkdirSync(resolve(projectDir, "knowledge"), { recursive: true });
    mkdirSync(resolve(projectDir, "plans"), { recursive: true });
    writeFileSync(resolve(projectDir, "knowledge", "index.json"), '{"entries":[]}\n', "utf-8");
    writeFileSync(resolve(projectDir, "plans", "index.json"), '{"plans":[]}\n', "utf-8");
    const first = await buildProjectRetrievalIndex("demo");
    const second = await buildProjectRetrievalIndex("demo");
    expect(second).toBe(first);

    await api(base, "/api/p/demo/knowledge", {
      method: "POST",
      body: JSON.stringify({
        id: "cache invalidator",
        title: "Cache Invalidator",
        kind: "lesson",
        keywords: [],
      }),
    });

    const rebuilt = await buildProjectRetrievalIndex("demo");
    expect(rebuilt).not.toBe(first);
  });

  it("round-trips project docs", async () => {
    const { base } = await boot();
    const put = await api(base, "/api/p/demo/docs/overview", {
      method: "PUT",
      body: JSON.stringify({ content: "# Demo Overview\n" }),
    });
    expect(put.body.ok).toBe(true);
    const get = await api(base, "/api/p/demo/docs/overview");
    expect((get.body.data as { content: string }).content).toBe("# Demo Overview\n");
  });

  it("updates project metadata and keeps the root DAG node in sync", async () => {
    const { base, dir } = await boot();
    const result = await api(base, "/api/p/demo", {
      method: "PATCH",
      body: JSON.stringify({
        name: "Demo Renamed",
        description: "updated from web",
        status: "paused",
        repoUrl: "https://example.test/demo",
        workspacePaths: ["/tmp/demo-one", "/tmp/demo-two"],
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);

    const projectMeta = JSON.parse(
      readFileSync(resolve(dir, "projects", "demo", "meta.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(projectMeta).toMatchObject({
      name: "Demo Renamed",
      description: "updated from web",
      status: "paused",
      repoUrl: "https://example.test/demo",
      workspacePaths: ["/tmp/demo-one", "/tmp/demo-two"],
    });

    const rootMeta = JSON.parse(readFileSync(resolve(dir, "meta.json"), "utf-8")) as {
      projects: Array<{ id: string; name: string; status: string }>;
    };
    expect(rootMeta.projects.find((p) => p.id === "demo")).toMatchObject({
      name: "Demo Renamed",
      status: "paused",
    });

    const refreshed = await api(base, "/api/p/demo");
    expect(refreshed.body.data).toMatchObject({
      name: "Demo Renamed",
      status: "paused",
      repoUrl: "https://example.test/demo",
      workspacePaths: ["/tmp/demo-one", "/tmp/demo-two"],
    });
  });

  it("merges concurrent project metadata patches without losing fields", async () => {
    const { base } = await boot();
    const [nameResult, descriptionResult] = await Promise.all([
      api(base, "/api/p/demo", {
        method: "PATCH",
        body: JSON.stringify({ name: "Concurrent Name" }),
      }),
      api(base, "/api/p/demo", {
        method: "PATCH",
        body: JSON.stringify({ description: "concurrent description" }),
      }),
    ]);
    expect(nameResult.body.ok).toBe(true);
    expect(descriptionResult.body.ok).toBe(true);

    const refreshed = await api(base, "/api/p/demo");
    expect(refreshed.body.data).toMatchObject({
      name: "Concurrent Name",
      description: "concurrent description",
    });
  });

  it("creates and clears a plan diagram through plan patch", async () => {
    const { base } = await boot();
    await api(base, "/api/p/demo/plans", {
      method: "POST",
      body: JSON.stringify({
        id: "diagram plan",
        title: "Diagram Plan",
        status: "planned",
        keywords: [],
      }),
    });

    const chart = "flowchart LR\n  A --> B\n";
    const created = await api(base, "/api/p/demo/plans/diagram-plan", {
      method: "PATCH",
      body: JSON.stringify({ diagram: chart }),
    });
    expect(created.status).toBe(200);
    expect((created.body.data as { diagram: string | null }).diagram).toBe(chart);

    const read = await api(base, "/api/p/demo/plans/diagram-plan");
    expect((read.body.data as { diagram: string | null }).diagram).toBe(chart);

    const cleared = await api(base, "/api/p/demo/plans/diagram-plan", {
      method: "PATCH",
      body: JSON.stringify({ diagram: null }),
    });
    expect((cleared.body.data as { diagram: string | null }).diagram).toBeNull();
  });

  it("preserves concurrent plan metadata patches", async () => {
    const { base } = await boot();
    await api(base, "/api/p/demo/plans", {
      method: "POST",
      body: JSON.stringify({
        id: "concurrent plan",
        title: "Concurrent Plan",
        status: "planned",
        keywords: [],
      }),
    });

    await Promise.all([
      api(base, "/api/p/demo/plans/concurrent-plan", {
        method: "PATCH",
        body: JSON.stringify({ summary: "kept plan summary" }),
      }),
      api(base, "/api/p/demo/plans/concurrent-plan", {
        method: "PATCH",
        body: JSON.stringify({ keywords: ["kept-plan-keyword"] }),
      }),
    ]);

    const read = await api(base, "/api/p/demo/plans/concurrent-plan");
    expect((read.body.data as { meta: Record<string, unknown> }).meta).toMatchObject({
      summary: "kept plan summary",
      keywords: ["kept-plan-keyword"],
    });
  });

  it("clears a knowledge audience when patched with null", async () => {
    const { base } = await boot();
    await api(base, "/api/p/demo/knowledge", {
      method: "POST",
      body: JSON.stringify({
        id: "audience entry",
        title: "Audience Entry",
        kind: "lesson",
        audience: "designer",
        keywords: [],
      }),
    });

    const patched = await api(base, "/api/p/demo/knowledge/audience-entry", {
      method: "PATCH",
      body: JSON.stringify({ audience: null }),
    });
    const meta = (patched.body.data as { meta: Record<string, unknown> }).meta;
    expect(meta).not.toHaveProperty("audience");
  });

  it("round-trips task work mode", async () => {
    const { base } = await boot();
    const created = await api(base, "/api/p/demo/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "inspect task", workMode: "inspect" }),
    });
    expect((created.body.data as { workMode?: string }).workMode).toBe("inspect");

    const updated = await api(base, "/api/p/demo/tasks/inspect-task", {
      method: "PATCH",
      body: JSON.stringify({ workMode: "bounded" }),
    });
    expect((updated.body.data as { workMode?: string }).workMode).toBe("bounded");
  });

  it("rejects project dependency cycles", async () => {
    const { base } = await boot();
    // Add a second project so a cycle is possible.
    const metaPath = resolve(ctx!.dir, "meta.json");
    writeFileSync(
      metaPath,
      JSON.stringify({
        version: "1.0",
        projects: [
          { id: "demo", name: "Demo", status: "active", dependsOn: ["beta"] },
          { id: "beta", name: "Beta", status: "active", dependsOn: [] },
        ],
      }),
      "utf-8",
    );
    const res = await api(base, "/api/projects/beta/dependencies", {
      method: "POST",
      body: JSON.stringify({ add: ["demo"] }),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CYCLE_DETECTED");
  });

  it("preserves concurrent dependency additions", async () => {
    const { base, dir } = await boot();
    writeFileSync(
      resolve(dir, "meta.json"),
      JSON.stringify({
        version: "1.0",
        projects: [
          { id: "demo", name: "Demo", status: "active", dependsOn: [] },
          { id: "beta", name: "Beta", status: "active", dependsOn: [] },
          { id: "gamma", name: "Gamma", status: "active", dependsOn: [] },
        ],
      }),
      "utf-8",
    );

    await Promise.all([
      api(base, "/api/projects/demo/dependencies", {
        method: "POST",
        body: JSON.stringify({ add: ["beta"] }),
      }),
      api(base, "/api/projects/demo/dependencies", {
        method: "POST",
        body: JSON.stringify({ add: ["gamma"] }),
      }),
    ]);

    const refreshed = await api(base, "/api/p/demo");
    expect((refreshed.body.data as { dependsOn: string[] }).dependsOn.sort()).toEqual([
      "beta",
      "gamma",
    ]);
  });

  it("emits SSE change events on writes", async () => {
    const { base } = await boot();

    const controller = new AbortController();
    const eventPromise = new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
      void (async () => {
        try {
          const res = await fetch(`${base}/api/events`, { signal: controller.signal });
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const match = buffer.match(/event: change\ndata: (.+)\n/);
            if (match?.[1]) {
              resolvePromise(JSON.parse(match[1]) as Record<string, unknown>);
              return;
            }
          }
          rejectPromise(new Error("stream ended before a change event"));
        } catch (err) {
          rejectPromise(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });

    // Give the SSE connection a beat to register before mutating.
    await new Promise((r) => setTimeout(r, 300));
    await api(base, "/api/p/demo/knowledge", {
      method: "POST",
      body: JSON.stringify({ id: "sse test", title: "SSE Test", kind: "lesson", keywords: [] }),
    });

    const event = (await Promise.race([
      eventPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("SSE timeout")), 5000)),
    ])) as Record<string, unknown>;

    expect(event.type).toBe("changed");
    expect(event.slug).toBe("demo");
    expect(event.area).toBe("knowledge");

    controller.abort();
  }, 10_000);

  it("fallback watching discovers project directories created after startup", async () => {
    savedDataDir = process.env.ARCS_DATA_DIR;
    const dir = mkdtempSync(resolve(tmpdir(), "arcs-web-watcher-test-"));
    mkdirSync(resolve(dir, "projects"), { recursive: true });
    process.env.ARCS_DATA_DIR = dir;
    const mode = (
      startWatcher as unknown as (
        dataDir: string,
        options: { forceFallback: boolean },
      ) => "recursive" | "fallback"
    )(dir, { forceFallback: true });
    expect(mode).toBe("fallback");

    const eventPromise = new Promise<{ slug: string | null; area: string }>((resolveEvent) => {
      const unsubscribe = onDataChange((event) => {
        if (event.slug === "later" && event.area === "knowledge") {
          unsubscribe();
          resolveEvent(event);
        }
      });
    });

    const knowledgeDir = resolve(dir, "projects", "later", "knowledge");
    mkdirSync(knowledgeDir, { recursive: true });
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
    writeFileSync(resolve(knowledgeDir, "index.json"), '{"entries":[]}\n', "utf-8");

    const event = await Promise.race([
      eventPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("fallback watcher timeout")), 3000),
      ),
    ]);
    expect(event).toMatchObject({ slug: "later", area: "knowledge" });
    rmSync(dir, { recursive: true, force: true });
  }, 5000);

  it("promotes and drops proposals", async () => {
    const { base, dir } = await boot();
    const proposalsDir = resolve(dir, "projects", "demo", "proposals");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(proposalsDir, { recursive: true });
    writeFileSync(
      resolve(proposalsDir, "codegraph.json"),
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        graphFingerprint: "abc",
        proposals: [
          {
            id: "prop-one",
            kind: "module",
            label: "Module One",
            structuralFacts: { files: 3 },
            sourceFiles: [{ path: "src/a.ts" }],
            suggestedDedupCandidates: [],
          },
        ],
      }),
      "utf-8",
    );

    const list = await api(base, "/api/p/demo/proposals");
    expect((list.body.data as { proposals: unknown[] }).proposals).toHaveLength(1);

    const promoted = await api(base, "/api/p/demo/proposals/prop-one/promote", {
      method: "POST",
      body: JSON.stringify({ title: "Module One", keywords: ["mod"] }),
    });
    expect(promoted.status).toBe(201);

    const after = await api(base, "/api/p/demo/proposals");
    expect((after.body.data as { proposals: unknown[] }).proposals).toHaveLength(0);

    const entry = await api(base, "/api/p/demo/knowledge/prop-one");
    expect(entry.body.ok).toBe(true);
  });
});
