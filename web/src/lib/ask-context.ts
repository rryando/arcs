/**
 * Derive the Ask-AI panel's "currently open" context from the router path.
 *
 * Pure and DOM-free so the mapping is unit-testable in the node test
 * environment: the panel turns the result into the `context` field of an ask
 * turn, and the server renders it as a small advisory block. `id` is present
 * only on detail routes; list/board views report the area alone.
 */

import type { AskContext, AskContextArea } from "../api/client";

export type { AskContext, AskContextArea };

/** Fallback when the path is not a project route (or is unrecognised). */
const DEFAULT_CONTEXT: AskContext = { area: "project" };

/**
 * Map a project-relative pathname to the view it shows. `/p/<slug>` is the
 * overview; `/p/<slug>/<area>` is the area's list/board; adding a second
 * segment (`/p/<slug>/<area>/<id>`) is a detail view and contributes `id`.
 * Anything else falls back to the project dashboard.
 */
export function deriveAskContext(pathname: string, slug: string): AskContext {
  const base = `/p/${slug}`;
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return DEFAULT_CONTEXT;
  const rest = pathname.slice(base.length).replace(/^\/+|\/+$/g, "");
  if (rest === "") return { area: "overview" };

  const slash = rest.indexOf("/");
  const head = slash === -1 ? rest : rest.slice(0, slash);
  const id = slash === -1 ? undefined : rest.slice(slash + 1).split("/")[0];

  switch (head) {
    case "proposal-docs":
      return id !== undefined ? { area: "proposal-docs", id } : { area: "proposal-docs" };
    case "plans":
      return id !== undefined ? { area: "plans", id } : { area: "plans" };
    case "knowledge":
      return id !== undefined ? { area: "knowledge", id } : { area: "knowledge" };
    case "tasks":
      return { area: "tasks" };
    case "graph":
      return { area: "graph" };
    default:
      return { area: "overview" };
  }
}

/** Short display line for the panel's context strip, e.g. `plans · My Plan`.
 *  Falls back to the id when the detail entity's title is not cached. */
export function describeAskContext(context: AskContext): string {
  if (context.id === undefined) return context.area;
  return `${context.area} · ${context.title ?? context.id}`;
}
