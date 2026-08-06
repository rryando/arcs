/**
 * Shared session-candidate list for session pickers inside modals.
 *
 * Linkage is used ONLY as a stable sort key (linked sessions first;
 * Array.sort is stable, so the original order survives ties) — never as a
 * filter. Filtering to linked sessions would produce an empty-picker dead end
 * on every node with zero linked sessions (see the "sort by linkage, never
 * filter by it" gotcha).
 */

import { useMemo } from "react";
import type { SessionLinkedNodeType, SessionMeta } from "../api/client";
import { useSessions } from "../api/hooks";
import { truncate } from "../lib/format";

/** Metadata is persisted verbatim from the runtime, so a declared key can still
 *  arrive as a non-string — read it defensively, never trust the type alone. */
function metaText(session: SessionMeta, key: "title" | "directory"): string {
  const value = session.metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Last path segment of a workspace directory, POSIX or Windows separators. */
function directoryName(directory: string): string {
  const segments = directory.replace(/[/\\]+$/, "").split(/[/\\]/);
  return segments[segments.length - 1] || directory;
}

/**
 * Human-readable name for a session: runtime title, else the workspace
 * directory's basename, else the first 8 characters of the runtime session id.
 * Never "untitled" — every session has at least an id.
 */
export function sessionName(session: SessionMeta): string {
  const directory = metaText(session, "directory");
  const lead = metaText(session, "title") || (directory ? directoryName(directory) : "");
  return lead ? truncate(lead, 48) : session.runtimeSessionId.slice(0, 8);
}

/**
 * `sessionName` plus a short id discriminator, for lists that do not show the
 * session id in a column of their own. Several sessions routinely share one
 * repo directory (and claude-code reports no title at all), so the name alone
 * would render as a wall of identical options.
 */
export function sessionLabel(session: SessionMeta): string {
  const id8 = session.runtimeSessionId.slice(0, 8);
  const name = sessionName(session);
  return name === id8 ? id8 : `${name} · ${id8}`;
}

/**
 * The full session list for `slug`, filtered by the query string and sorted
 * with linked sessions first. Shares `qk.sessions(slug)` with `useSessions`,
 * so callers that already have the list cached pay no extra request.
 */
export function useSessionCandidates(
  slug: string,
  filter: string,
  linkedNodeType?: SessionLinkedNodeType,
  linkedNodeId?: string,
): SessionMeta[] {
  const { data: sessionsData } = useSessions(slug);
  return useMemo<SessionMeta[]>(() => {
    const all = sessionsData?.sessions ?? [];
    const q = filter.trim().toLowerCase();
    // Matched against the raw metadata too, not just the rendered label: the
    // label truncates and shows only a directory's basename, so typing a repo
    // path (or a title the label trimmed away) must still find the session.
    const matched = q
      ? all.filter(
          (s) =>
            sessionLabel(s).toLowerCase().includes(q) ||
            metaText(s, "title").toLowerCase().includes(q) ||
            metaText(s, "directory").toLowerCase().includes(q) ||
            s.runtimeSessionId.toLowerCase().includes(q) ||
            s.runtimeType.includes(q),
        )
      : all;
    if (!linkedNodeType || !linkedNodeId) return matched;
    const linked = (s: SessionMeta) =>
      s.linkedNodeType === linkedNodeType && s.linkedNodeId === linkedNodeId ? 0 : 1;
    return [...matched].sort((a, b) => linked(a) - linked(b));
  }, [sessionsData, filter, linkedNodeType, linkedNodeId]);
}
