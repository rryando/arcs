/**
 * Unit tests for the web client's pure shortcut-matching core, its API request
 * builder, its session-state vocabulary (the sessions filter, the live counter,
 * the composer's resume gate and the badge they must all agree with about every
 * row) and the zero-import leaf that vocabulary lives in, the server's SSE
 * change classifier, and the dev-only vite plugin that supplies the token in
 * `vite dev`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Plugin, resolveConfig } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyChange } from "../src/web-server/watcher.js";
import {
  filterSessionsByState,
  isSessionAttached,
  isSessionLive,
  type SessionStateSource,
  SessionStatusBadge,
  sessionStateChips,
} from "../web/src/components/SessionStatusBadge.js";
import { formatFileRefs, parseFileRefs } from "../web/src/lib/file-refs.js";
import { extractHeadings, extractSections } from "../web/src/lib/markdown-headings.js";
import { resolveReference } from "../web/src/lib/reference-resolver.js";
import { type Binding, eventToKey, matchBindings } from "../web/src/lib/shortcuts.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

function keyEvent(
  key: string,
  mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {},
) {
  return {
    key,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  };
}

function binding(keys: string): Binding {
  return { keys, description: keys, run: () => {} };
}

describe("eventToKey", () => {
  it("maps plain keys", () => {
    expect(eventToKey(keyEvent("g"))).toBe("g");
    expect(eventToKey(keyEvent("/"))).toBe("/");
    expect(eventToKey(keyEvent("?"))).toBe("?");
  });

  it("maps named keys", () => {
    expect(eventToKey(keyEvent("Enter"))).toBe("enter");
    expect(eventToKey(keyEvent("Escape"))).toBe("escape");
    expect(eventToKey(keyEvent("ArrowDown"))).toBe("down");
    expect(eventToKey(keyEvent(" "))).toBe("space");
    expect(eventToKey(keyEvent("Home"))).toBe("home");
    expect(eventToKey(keyEvent("End"))).toBe("end");
  });

  it("maps modifiers", () => {
    expect(eventToKey(keyEvent("s", { ctrl: true }))).toBe("ctrl+s");
    expect(eventToKey(keyEvent("k", { meta: true }))).toBe("ctrl+k");
    expect(eventToKey(keyEvent("G", { shift: true }))).toBe("shift+g");
  });

  it("returns null for pure modifier presses", () => {
    expect(eventToKey(keyEvent("Control", { ctrl: true }))).toBeNull();
    expect(eventToKey(keyEvent("Shift", { shift: true }))).toBeNull();
  });

  it("does not tag shift on single characters (shift+g is G)", () => {
    expect(eventToKey(keyEvent("G", { shift: true }))).toBe("shift+g");
    expect(eventToKey(keyEvent("g"))).toBe("g");
  });
});

describe("matchBindings", () => {
  const bindings = [
    binding("g k"),
    binding("g d"),
    binding("/"),
    binding("ctrl+s"),
    binding("escape"),
  ];

  it("matches a full sequence", () => {
    const result = matchBindings(bindings, ["g", "k"]);
    expect(result.kind).toBe("matched");
    expect(result.kind === "matched" && result.binding.keys).toBe("g k");
  });

  it("reports partial sequences", () => {
    expect(matchBindings(bindings, ["g"]).kind).toBe("partial");
  });

  it("matches single keys directly", () => {
    expect(matchBindings(bindings, ["/"]).kind).toBe("matched");
    expect(matchBindings(bindings, ["ctrl+s"]).kind).toBe("matched");
  });

  it("reports none for unknown keys", () => {
    expect(matchBindings(bindings, ["z"]).kind).toBe("none");
    expect(matchBindings(bindings, ["g", "z"]).kind).toBe("none");
  });

  it("prefers the highest-priority exact binding", () => {
    const low = { ...binding("/"), description: "global", priority: 0 };
    const high = { ...binding("/"), description: "local", priority: 20 };
    const result = matchBindings([low, high], ["/"]);
    expect(result.kind).toBe("matched");
    expect(result.kind === "matched" && result.binding.description).toBe("local");
  });
});

describe("classifyChange", () => {
  it("classifies collection areas", () => {
    expect(classifyChange("projects/arcs/knowledge/index.json")).toEqual({
      slug: "arcs",
      area: "knowledge",
    });
    expect(classifyChange("projects/arcs/tasks/index.json")).toEqual({
      slug: "arcs",
      area: "tasks",
    });
    expect(classifyChange("projects/arcs/plans/x.meta.json")).toEqual({
      slug: "arcs",
      area: "plans",
    });
    expect(classifyChange("projects/arcs/proposals/codegraph.json")).toEqual({
      slug: "arcs",
      area: "proposals",
    });
    expect(classifyChange("projects/arcs/sessions/b993ef10.transcript.jsonl")).toEqual({
      slug: "arcs",
      area: "sessions",
    });
  });

  it("classifies docs and meta", () => {
    expect(classifyChange("projects/arcs/overview.md")).toEqual({ slug: "arcs", area: "docs" });
    expect(classifyChange("projects/arcs/tasks.md")).toEqual({ slug: "arcs", area: "tasks" });
    expect(classifyChange("projects/arcs/meta.json")).toEqual({ slug: "arcs", area: "meta" });
  });

  it("classifies root meta and ignores tokens", () => {
    expect(classifyChange("meta.json")).toEqual({ slug: null, area: "root" });
    expect(classifyChange("tokens/wp_abc.json")).toBeNull();
    expect(classifyChange("config.json")).toBeNull();
  });
});

describe("file reference editor format", () => {
  it("parses one path per line with optional #anchor", () => {
    expect(parseFileRefs("src/a.ts#handler\nsrc/b.ts\n")).toEqual([
      { path: "src/a.ts", anchor: "handler" },
      { path: "src/b.ts" },
    ]);
  });

  it("formats refs back into stable editable text", () => {
    expect(formatFileRefs([{ path: "src/a.ts", anchor: "handler" }, { path: "src/b.ts" }])).toBe(
      "src/a.ts#handler\nsrc/b.ts",
    );
  });

  it("ignores blank lines and trims values", () => {
    expect(parseFileRefs("  src/a.ts # handler  \n\n src/b.ts ")).toEqual([
      { path: "src/a.ts", anchor: "handler" },
      { path: "src/b.ts" },
    ]);
  });
});

describe("markdown heading anchors", () => {
  it("gives duplicate headings stable unique ids", () => {
    expect(extractHeadings("# Title\n\n## Repeat\n\n## Repeat\n\n### Repeat")).toEqual([
      { depth: 1, text: "Title", id: "title" },
      { depth: 2, text: "Repeat", id: "repeat" },
      { depth: 2, text: "Repeat", id: "repeat-2" },
      { depth: 3, text: "Repeat", id: "repeat-3" },
    ]);
  });

  it("ignores headings inside fenced code blocks", () => {
    expect(extractHeadings("## Visible\n```md\n## Hidden\n```\n## Visible")).toEqual([
      { depth: 2, text: "Visible", id: "visible" },
      { depth: 2, text: "Visible", id: "visible-2" },
    ]);
  });
});

describe("markdown heading sections", () => {
  const slice = (markdown: string) =>
    extractSections(markdown).map((s) => markdown.slice(s.startOffset, s.endOffset).trim());

  it("runs a section to the next same-or-shallower heading, subsections included", () => {
    const md = "# Title\n\nintro\n\n## A\n\na body\n\n### A1\n\nnested\n\n## B\n\nb body\n";
    expect(slice(md)).toEqual([
      "# Title\n\nintro\n\n## A\n\na body\n\n### A1\n\nnested\n\n## B\n\nb body",
      "## A\n\na body\n\n### A1\n\nnested",
      "### A1\n\nnested",
      "## B\n\nb body",
    ]);
  });

  it("keeps ids aligned with extractHeadings", () => {
    const md = "# Title\n\n## Repeat\n\n## Repeat\n";
    expect(extractSections(md).map((s) => ({ depth: s.depth, text: s.text, id: s.id }))).toEqual(
      extractHeadings(md),
    );
  });

  it("excludes preamble text before the first heading", () => {
    const md = "loose intro\n\n## First\n\nbody\n";
    const sections = extractSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.startOffset).toBe(md.indexOf("## First"));
    expect(slice(md)).toEqual(["## First\n\nbody"]);
  });

  it("does not split a section on headings inside fenced code blocks", () => {
    const md = "## Visible\n\n```md\n## Hidden\n```\n\ntail\n";
    expect(slice(md)).toEqual(["## Visible\n\n```md\n## Hidden\n```\n\ntail"]);
  });

  it("treats a document with no headings as having no sections", () => {
    expect(extractSections("just prose\n")).toEqual([]);
  });
});

describe("resolveReference", () => {
  it("resolves overview sources to the project doc tab with a section hash", () => {
    expect(
      resolveReference({
        slug: "arcs",
        kind: "overview",
        doc: "tasks",
        sectionId: "current-state",
      }),
    ).toEqual({ path: "/p/arcs?doc=tasks", hash: "#current-state" });
  });

  it("resolves knowledge sources to the entry detail with a section hash", () => {
    expect(
      resolveReference({
        slug: "arcs",
        kind: "knowledge",
        id: "markdown-section-send",
        sectionId: "implementation",
      }),
    ).toEqual({ path: "/p/arcs/knowledge/markdown-section-send", hash: "#implementation" });
  });

  it("resolves plan sources to the plan detail with a section hash", () => {
    expect(
      resolveReference({ slug: "arcs", kind: "plan", id: "my-plan", sectionId: "tasks" }),
    ).toEqual({ path: "/p/arcs/plans/my-plan", hash: "#tasks" });
  });
});

describe("session state filter vs badge", () => {
  /**
   * The label `SessionStatusBadge` actually renders for a record, read off the
   * element it returns rather than recomputed — so these assertions are about
   * the badge itself, not about a second copy of its logic.
   */
  function badgeLabel(session: SessionStateSource): string {
    const text: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === "string") {
        text.push(node);
      } else if (Array.isArray(node)) {
        for (const child of node) walk(child);
      } else if (node && typeof node === "object" && "props" in node) {
        walk((node as { props: { children?: unknown } }).props.children);
      }
    };
    walk(SessionStatusBadge({ session }));
    // [glyph, label] — the badge's own text is the last leaf.
    return text.at(-1) ?? "";
  }

  // The record the two axes disagree about: stored `active` (its heartbeat
  // lapsed, nothing ever closed it) while the server derives `idle`.
  const lapsed: SessionStateSource = { status: "active", phase: "idle" };
  const live: SessionStateSource = { status: "idle", phase: "running" };
  const over: SessionStateSource = { status: "completed", phase: "ended" };
  // Reached the UI without a phase (the record echoed by `POST /run`).
  const phaseless: SessionStateSource = { status: "disconnected" };
  const sessions = [lapsed, live, over, phaseless];

  it("badges a session by its derived phase, falling back to the stored status", () => {
    expect(badgeLabel(lapsed)).toBe("idle");
    expect(badgeLabel(live)).toBe("running");
    expect(badgeLabel(over)).toBe("ended");
    expect(badgeLabel(phaseless)).toBe("disconnected");
  });

  it("never shows a row under a chip its own badge contradicts", () => {
    for (const chip of sessionStateChips(sessions, null)) {
      for (const session of filterSessionsByState(sessions, chip)) {
        expect(badgeLabel(session)).toBe(chip);
      }
    }
  });

  it("filters the disagreeing record on its phase, never on its stored status", () => {
    expect(filterSessionsByState(sessions, "idle")).toContain(lapsed);
    expect(filterSessionsByState(sessions, "active")).toEqual([]);
    expect(sessionStateChips(sessions, null)).not.toContain("active");
  });

  it("offers a chip for every visible row and no chip that matches nothing", () => {
    const chips = sessionStateChips(sessions, null);
    expect(chips).toEqual(["running", "idle", "ended", "disconnected"]);
    for (const session of sessions) expect(chips).toContain(badgeLabel(session));
    for (const chip of chips)
      expect(filterSessionsByState(sessions, chip).length).toBeGreaterThan(0);
  });

  it("keeps the active chip clickable after its last row leaves the list", () => {
    expect(sessionStateChips([over], "running")).toEqual(["running", "ended"]);
  });

  it("filters nothing out under `all`", () => {
    expect(filterSessionsByState(sessions, null)).toEqual(sessions);
  });

  // The two non-badge controls. Neither takes a badge prop, so giving the badge
  // the record did nothing for them — they are only safe because they take the
  // record themselves, and only proven safe because of these three tests.

  // Stored `active`, but nothing is running it any more: the server derives
  // `ended`. The record the header used to advertise as live.
  const gone: SessionStateSource = { status: "active", phase: "ended" };
  // Stored `idle` while a run is actually in flight — the opposite disagreement.
  const busy: SessionStateSource = { status: "idle", phase: "running" };

  it("counts a session as live off its badge, never off its stored status", () => {
    expect(badgeLabel(gone)).toBe("ended");
    expect(isSessionLive(gone)).toBe(false);

    expect(badgeLabel(busy)).toBe("running");
    expect(isSessionLive(busy)).toBe(true);
  });

  it("offers a headless resume exactly when nothing is driving the session", () => {
    // Hidden by the old `status !== "active"` gate — the session the affordance
    // exists for.
    expect(isSessionAttached(gone)).toBe(false);
    // Offered by it, against a session a terminal is actively driving.
    expect(isSessionAttached(busy)).toBe(true);
  });

  it("keeps `idle` live but unattached — the two sets are not one set", () => {
    // `idle` is the whole reason the counter and the resume gate cannot share a
    // predicate: the record is not over (it belongs in "N live") but nothing
    // holds its runtime thread (a headless resume is exactly what it wants).
    const dormant: SessionStateSource = { status: "active", phase: "idle" };
    expect(badgeLabel(dormant)).toBe("idle");
    expect(isSessionLive(dormant)).toBe(true);
    expect(isSessionAttached(dormant)).toBe(false);

    // Phaseless fallback, both directions: the raw status is still classified,
    // so a record echoed by `POST /run` is neither dropped from the count nor
    // handed a resume it cannot use.
    expect(isSessionLive(phaseless)).toBe(false);
    expect(isSessionAttached(phaseless)).toBe(false);
    expect(isSessionLive({ status: "active" })).toBe(true);
    expect(isSessionAttached({ status: "active" })).toBe(true);
  });
});

/**
 * The block above drives `web/src/components/SessionStatusBadge.tsx`, which
 * imports `src/shared/session-vocabulary.ts` directly by relative path across
 * the workspace boundary. There is no alias and no third package, so that
 * module's being a LEAF — not the directory it sits in — is the entire reason
 * `vite build` does not pull the CLI's transitive graph into the browser
 * bundle. Today only an in-file comment says so.
 *
 * No CI step would notice it stop being one. A stray value import of, say,
 * `src/utils/session-store.js` is a legal src/ import under the root tsconfig,
 * resolves under web's `moduleResolution: "bundler"` with no alias, and runs
 * fine under vitest's Node environment — typecheck, lint and test all stay
 * green. `build:web` runs only from `prepack`, so the break surfaces at release
 * time, or as a silently broken shell nobody loads until a user does. This test
 * is the only guard.
 */
describe("session vocabulary leaf", () => {
  it("keeps src/shared/session-vocabulary.ts a zero-import leaf", () => {
    const source = readFileSync(
      new URL("../src/shared/session-vocabulary.ts", import.meta.url),
      "utf-8",
    );
    // Match against code only. The leaf's own prose argues about imports at
    // length — it contains the literal text "an import (forbidden above)",
    // which the dynamic-import shape below matches verbatim.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    // Non-vacuity first, and on the STRIPPED text as well as the raw read: a
    // regex that matches nothing passes forever, so prove the file was read, is
    // still this module, and survived stripping before trusting its silence.
    expect(source.length).toBeGreaterThan(0);
    for (const declaration of [
      "export interface SessionStateSource",
      "export function sessionState",
      "export function isSessionLive",
      "export function isSessionAttached",
    ]) {
      expect(source).toContain(declaration);
      expect(code).toContain(declaration);
    }

    // Four shapes, because the obvious one misses two: any line OPENING an
    // import (covers `import x from`, `import type {`, a bare `import "./x.js"`
    // and the first line of a wrapped one), a single-line re-export, the
    // closing line of a wrapped re-export, and a dynamic `import(`.
    //
    // `import type` is caught deliberately. A type-only import cannot reach the
    // bundle by itself, but the file's own contract forbids every import
    // outright, and one permitted type import is one `verbatimModuleSyntax`
    // slip away from a value import — the distinction is not worth encoding.
    expect(
      code.match(/^\s*import\b|^\s*export\b.*\bfrom\b|^\s*\}\s*from\b|\bimport\s*\(/m),
    ).toBeNull();
  });
});

describe("api client web token", () => {
  const TOKEN = "a".repeat(64);
  const realFetch = globalThis.fetch;

  interface FetchCall {
    path: string;
    method?: string;
    headers: Record<string, string>;
  }

  /** Stands in for the served document. `querySelector` answers ONLY the exact
   *  selector the server's injected tag matches (name pinned in
   *  src/web-server/static.ts), so a client querying anything else reads null
   *  and the token assertions below fail. */
  function documentWithMeta(content: string | null) {
    return {
      querySelector: (selector: string) =>
        selector === 'meta[name="arcs-web-token"]' && content !== null
          ? { getAttribute: (name: string) => (name === "content" ? content : null) }
          : null,
    };
  }

  /** Loads a FRESH client module — the token is read once at load, so every
   *  case needs its own instance — against the given document, and records
   *  what it hands to `fetch`. `doc: undefined` is the non-browser case. */
  async function loadClient(doc: unknown) {
    vi.resetModules();
    const calls: FetchCall[] = [];
    const g = globalThis as any;
    g.document = doc;
    g.fetch = async (input: any, init: any) => {
      calls.push({
        path: String(input),
        method: init?.method,
        headers: { ...(init?.headers ?? {}) },
      });
      return { status: 200, json: async () => ({ ok: true, data: {} }) } as unknown as Response;
    };
    const { api, request } = await import("../web/src/api/client.js");
    return { api, request, calls };
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as any).document = undefined;
    vi.resetModules();
  });

  it("sends the injected token on mutating requests", async () => {
    const { api, calls } = await loadClient(documentWithMeta(TOKEN));
    await api.deleteTask("arcs", "t1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.headers["X-ARCS-Token"]).toBe(TOKEN);
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
  });

  it("keeps the token when a call site passes its own headers", async () => {
    const { request, calls } = await loadClient(documentWithMeta(TOKEN));
    await request("/api/p/arcs/tasks", {
      method: "POST",
      headers: { "X-Custom": "1" },
      body: "{}",
    });

    // The regression this pins: spreading `...init` after the header literal
    // replaced the whole object and dropped the token for any call site that
    // brought headers of its own.
    expect(calls[0]?.headers["X-ARCS-Token"]).toBe(TOKEN);
    expect(calls[0]?.headers["X-Custom"]).toBe("1");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.method).toBe("POST");
  });

  it("still lets a call site override a default header", async () => {
    const { request, calls } = await loadClient(documentWithMeta(TOKEN));
    await request("/api/p/arcs/tasks", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
    });

    expect(calls[0]?.headers["Content-Type"]).toBe("text/plain");
    expect(calls[0]?.headers["X-ARCS-Token"]).toBe(TOKEN);
  });

  it("leaves reads unchanged — no token on a GET", async () => {
    const { api, calls } = await loadClient(documentWithMeta(TOKEN));
    await api.tasks("arcs");

    expect(calls[0]?.method).toBeUndefined();
    expect(calls[0]?.headers).not.toHaveProperty("X-ARCS-Token");
  });

  it("degrades to no header when the shell carries no meta tag", async () => {
    const { api, calls } = await loadClient(documentWithMeta(null));
    await api.deleteTask("arcs", "t1");

    // No throw at module load, no bogus `X-ARCS-Token: undefined` — the server
    // answers a clean 401 instead.
    expect(calls[0]?.headers).not.toHaveProperty("X-ARCS-Token");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
  });

  it("degrades to no header when there is no document at all", async () => {
    const { api, calls } = await loadClient(undefined);
    await api.deleteTask("arcs", "t1");

    expect(calls[0]?.headers).not.toHaveProperty("X-ARCS-Token");
  });

  it("empty meta content counts as no token", async () => {
    const { api, calls } = await loadClient(documentWithMeta(""));
    await api.deleteTask("arcs", "t1");

    expect(calls[0]?.headers).not.toHaveProperty("X-ARCS-Token");
  });
});

/**
 * The dev-server counterpart of the block above: where the built shell gets its
 * token from `src/web-server/static.ts`, `vite dev` gets it from the
 * `arcs-web-token-dev` plugin in `web/vite.config.ts`.
 *
 * APPROACH — these tests drive vite's own `resolveConfig()` against the real
 * `web/vite.config.ts` rather than importing the config module and reading its
 * plugin array. That is deliberate: `apply: "serve"` is a declaration, and only
 * vite decides what it means. Asserting the field would pin the source text;
 * resolving the config pins the property that actually matters — the plugin is
 * absent from the plugin pipeline of a production build, so a dev-only secret
 * cannot reach a shipped shell. `vite` is already a root devDependency, so this
 * costs no new dependency.
 */
describe("arcs-web-token-dev vite plugin", () => {
  const PLUGIN = "arcs-web-token-dev";
  const webDir = fileURLToPath(new URL("../web", import.meta.url));
  const configFile = join(webDir, "vite.config.ts");

  /** Resolves the real web config exactly as `vite dev` / `vite build` would.
   *  Each call re-evaluates the config module, so the returned plugin is a
   *  fresh instance bound to whatever ARCS_DATA_DIR is set at this moment. */
  async function resolveWebConfig(command: "serve" | "build") {
    return resolveConfig(
      { root: webDir, configFile, logLevel: "silent" },
      command,
      command === "build" ? "production" : "development",
    );
  }

  function pluginNames(plugins: readonly Plugin[]): string[] {
    return plugins.map((plugin) => plugin.name);
  }

  async function tokenPlugin(): Promise<Plugin> {
    const config = await resolveWebConfig("serve");
    const plugin = config.plugins.find((candidate) => candidate.name === PLUGIN);
    if (!plugin) throw new Error(`${PLUGIN} missing from the resolved serve config`);
    return plugin;
  }

  /** Invokes `transformIndexHtml` the way vite's html pipeline does. The hook
   *  may be declared bare or as `{ order, handler }`; normalize both so these
   *  tests pin behaviour rather than declaration shape. */
  async function transformIndexHtml(plugin: Plugin): Promise<unknown> {
    const hook = plugin.transformIndexHtml;
    const handler = typeof hook === "function" ? hook : hook?.handler;
    if (typeof handler !== "function") {
      throw new Error(`${PLUGIN} exposes no transformIndexHtml handler`);
    }
    const invoke = handler as (html: string, ctx: any) => unknown;
    return invoke("<html><head></head><body></body></html>", {
      path: "/index.html",
      filename: join(webDir, "index.html"),
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is in the serve pipeline and out of the production build pipeline", async () => {
    const [serve, build] = await Promise.all([
      resolveWebConfig("serve"),
      resolveWebConfig("build"),
    ]);

    expect(pluginNames(serve.plugins)).toContain(PLUGIN);
    // The security property: a dev-only secret must never be injectable by a
    // shipped shell. `apply: "serve"` is what buys this — drop it and this line
    // fails.
    expect(pluginNames(build.plugins)).not.toContain(PLUGIN);

    // Guards the assertion above against being vacuously true: prove the same
    // config file really was loaded for `build` (a config that failed to load,
    // or a plugin array that silently emptied, would also "not contain" it).
    expect(build.command).toBe("build");
    expect(pluginNames(build.plugins)).toContain("@tailwindcss/vite:scan");
    expect(pluginNames(serve.plugins)).toContain("@tailwindcss/vite:scan");
  });

  it("injects the token from web-token.json as the meta tag the client reads", async () => {
    const token = "b".repeat(64);
    await withTempDataDir(async (dir) => {
      writeFileSync(join(dir, "web-token.json"), JSON.stringify({ token }), "utf-8");

      const result = await transformIndexHtml(await tokenPlugin());

      // The name is load-bearing: it is the one selector the client queries
      // (see "api client web token" above) and the one static.ts emits.
      expect(result).toEqual([
        { tag: "meta", attrs: { name: "arcs-web-token", content: token }, injectTo: "head" },
      ]);
    });
  });

  it("injects nothing and warns at most once when the token file is missing", async () => {
    await withTempDataDir(async () => {
      // withTempDataDir seeds meta.json only — no web-token.json, i.e. the
      // state of a machine where `arcs web` has never run.
      const plugin = await tokenPlugin();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const first = await transformIndexHtml(plugin);
      const second = await transformIndexHtml(plugin);

      // Not fatal: reads still work, mutations 401. But a browser reload must
      // not restate the warning on every request.
      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("web-token.json");
    });
  });

  it("injects nothing and does not throw when the token file is unparsable", async () => {
    await withTempDataDir(async (dir) => {
      writeFileSync(join(dir, "web-token.json"), "{ not json at all", "utf-8");

      const plugin = await tokenPlugin();
      vi.spyOn(console, "warn").mockImplementation(() => {});

      // A truncated or half-written file must degrade like a missing one, not
      // crash the dev server and not inject a bogus token.
      await expect(transformIndexHtml(plugin)).resolves.toBeUndefined();
    });
  });
});
