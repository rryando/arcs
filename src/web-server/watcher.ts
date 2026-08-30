/**
 * Data-directory watcher for the web server.
 *
 * Emits debounced, classified change events over the ARCS data dir so the web
 * UI can live-refresh when the CLI (or another agent) mutates the DAG.
 * Uses recursive fs.watch when available (Node >= 20 on Linux), falling back
 * to per-directory watchers otherwise.
 */

import { existsSync, type FSWatcher, readdirSync, watch } from "node:fs";
import { join } from "node:path";

export interface ChangeEvent {
  type: "changed";
  slug: string | null;
  area:
    | "root"
    | "knowledge"
    | "tasks"
    | "plans"
    | "proposals"
    | "sessions"
    | "docs"
    | "meta"
    | "other";
  path: string;
  at: string;
}

type Listener = (event: ChangeEvent) => void;

const listeners = new Set<Listener>();
const watchers: FSWatcher[] = [];
const watchedDirs = new Set<string>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

let started = false;
let mode: "recursive" | "fallback" | null = null;
let fallbackDataDir: string | null = null;
let fallbackRescanTimer: ReturnType<typeof setTimeout> | null = null;

export function onDataChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Classifies a data-dir-relative path into a change area + project slug.
 * Returns null for paths outside the project DAG (e.g. tokens/, config.json).
 */
export function classifyChange(
  relativePath: string,
): { slug: string | null; area: ChangeEvent["area"] } | null {
  const rel = relativePath.replace(/\\/g, "/");
  if (rel === "meta.json") return { slug: null, area: "root" };

  const match = rel.match(/^projects\/([^/]+)(?:\/(.*))?$/);
  if (!match || !match[1]) return null;
  const slug = match[1];
  const rest = match[2] ?? "";

  if (rest === "knowledge" || rest.startsWith("knowledge/")) return { slug, area: "knowledge" };
  if (rest === "tasks" || rest.startsWith("tasks/") || rest === "tasks.md")
    return { slug, area: "tasks" };
  if (rest === "plans" || rest.startsWith("plans/")) return { slug, area: "plans" };
  if (rest === "proposals" || rest.startsWith("proposals/")) return { slug, area: "proposals" };
  if (rest === "sessions" || rest.startsWith("sessions/")) return { slug, area: "sessions" };
  // The run store is the ask surface's persistence — the client's invalidation
  // path keys on the `sessions` area, so run claims/settles keep triggering it.
  if (rest === "runs" || rest.startsWith("runs/")) return { slug, area: "sessions" };
  if (rest === "meta.json") return { slug, area: "meta" };
  if (rest.endsWith(".md")) return { slug, area: "docs" };
  return { slug, area: "other" };
}

function emit(relativePath: string): void {
  const classified = classifyChange(relativePath);
  if (!classified) return;

  // Debounce per (slug, area) — a store write touches several files at once.
  const key = `${classified.slug ?? "_"}:${classified.area}`;
  const existing = pending.get(key);
  if (existing) clearTimeout(existing);

  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      const event: ChangeEvent = {
        type: "changed",
        slug: classified.slug,
        area: classified.area,
        path: relativePath,
        at: new Date().toISOString(),
      };
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Listener failures must not break the watcher.
        }
      }
    }, 250),
  );
}

function watchDir(absDir: string, relPrefix: string): void {
  if (!existsSync(absDir) || watchedDirs.has(absDir)) return;
  try {
    const watcher = watch(absDir, (eventType, filename) => {
      if (!filename) return;
      emit(relPrefix ? `${relPrefix}/${filename}` : filename);
      if (eventType === "rename" && fallbackDataDir) scheduleFallbackRescan();
    });
    watchedDirs.add(absDir);
    watchers.push(watcher);
  } catch {
    // Best-effort watching; ignore individual directory failures.
  }
}

function scheduleFallbackRescan(): void {
  if (!fallbackDataDir) return;
  if (fallbackRescanTimer) clearTimeout(fallbackRescanTimer);
  fallbackRescanTimer = setTimeout(() => {
    fallbackRescanTimer = null;
    if (fallbackDataDir) startFallbackWatchers(fallbackDataDir);
  }, 100);
}

function startFallbackWatchers(dataDir: string): void {
  fallbackDataDir = dataDir;
  watchDir(dataDir, "");
  const projectsRoot = join(dataDir, "projects");
  watchDir(projectsRoot, "projects");

  let slugs: string[] = [];
  try {
    slugs = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return;
  }

  for (const slug of slugs) {
    const projectAbs = join(projectsRoot, slug);
    watchDir(projectAbs, `projects/${slug}`);
    for (const sub of ["knowledge", "tasks", "plans", "proposals", "sessions"]) {
      watchDir(join(projectAbs, sub), `projects/${slug}/${sub}`);
    }
  }
}

/**
 * Starts watching the data dir. Idempotent — safe to call per app instance.
 */
export function startWatcher(
  dataDir: string,
  options: { forceFallback?: boolean } = {},
): "recursive" | "fallback" {
  if (started) return mode ?? "fallback";
  started = true;

  if (!options.forceFallback) {
    try {
      const watcher = watch(dataDir, { recursive: true }, (_eventType, filename) => {
        if (filename) emit(filename);
      });
      watchers.push(watcher);
      mode = "recursive";
      return mode;
    } catch {
      // Recursive watch unsupported — fall back to per-directory watchers.
    }
  }

  startFallbackWatchers(dataDir);
  mode = "fallback";
  return mode;
}

/**
 * Stops all watchers (test cleanup).
 */
export function stopWatcher(): void {
  for (const watcher of watchers.splice(0)) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
  }
  for (const timeout of pending.values()) clearTimeout(timeout);
  if (fallbackRescanTimer) clearTimeout(fallbackRescanTimer);
  pending.clear();
  watchedDirs.clear();
  started = false;
  mode = null;
  fallbackDataDir = null;
  fallbackRescanTimer = null;
}
