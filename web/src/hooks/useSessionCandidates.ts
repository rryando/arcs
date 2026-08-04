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

export function sessionLabel(session: SessionMeta): string {
  const title = session.metadata?.title;
  if (typeof title === "string" && title) return truncate(title, 48);
  return session.runtimeType;
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
    const matched = q
      ? all.filter(
          (s) =>
            sessionLabel(s).toLowerCase().includes(q) ||
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
