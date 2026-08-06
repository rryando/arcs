/**
 * Sessions view — live agent runtime sessions discovered for this project.
 *
 * The table mirrors whatever the session bridge has written into the session
 * store, plus the DAG link a human attached to a session. Sessions whose
 * runtime accepts messages can also be prompted from here. Runtimes the UI does
 * not currently surface are filtered out client-side (`isVisibleSession`) — the
 * API still returns them.
 */

import { useParams } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import type { SessionMeta } from "../api/client";
import { useDeleteSession, usePlans, useSessions, useTasks, useUpdateSession } from "../api/hooks";
import { Badge, typeColor } from "../components/Badge";
import { type Column, DataTable } from "../components/DataTable";
import { ConfirmDialog } from "../components/Dialog";
import { Panel } from "../components/Panel";
import { useToaster } from "../components/Toaster";
import { sessionName } from "../hooks/useSessionCandidates";
import { cx, relativeTime, truncate } from "../lib/format";
import { SessionLinkModal } from "./SessionLinkModal";
import { canSendMessage, isVisibleSession, SessionMessageForm } from "./SessionMessageForm";
import { useSessionPanel } from "./SessionPanel";
import {
  filterSessionsByState,
  SessionStatusBadge,
  sessionState,
  sessionStateChips,
  sessionStateRank,
} from "./SessionStatusBadge";

const RUNTIME_LABEL: Record<string, string> = {
  opencode: "opencode",
  "claude-code": "claude code",
};

/** States that mean "a session a human could talk to right now": the live
 *  phases, plus the raw `active` a record that arrived without a phase is
 *  badged with. */
const LIVE_STATES = new Set(["running", "idle", "active"]);

function metaString(session: SessionMeta, key: string): string {
  const value = session.metadata?.[key];
  return typeof value === "string" ? value : "";
}

export function SessionsView() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { data, isLoading } = useSessions(slug);
  const { data: tasksData } = useTasks(slug);
  const { data: plansData } = usePlans(slug);
  const deleteSession = useDeleteSession(slug);
  const updateSession = useUpdateSession(slug);
  const { push } = useToaster();
  const { openSession } = useSessionPanel();

  const [stateFilter, setStateFilter] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionMeta | null>(null);
  const [linkTarget, setLinkTarget] = useState<SessionMeta | null>(null);
  const [messageTarget, setMessageTarget] = useState<SessionMeta | null>(null);

  // The API returns every runtime; the view shows only the ones the UI
  // currently surfaces, so the counts below describe what the user can see.
  const sessions = useMemo(() => (data?.sessions ?? []).filter(isVisibleSession), [data]);

  /**
   * DECISION: the chips filter on the same `sessionState()` the status column
   * renders — the derived phase — not on the persisted `status` underneath it.
   *
   * The alternative was keeping status chips and relabelling them "record
   * status" so the two axes read as different things. Rejected: it asks the
   * user to hold two vocabularies for one column, and it leaves the `active`
   * chip returning rows badged `running` and hiding rows badged `running`
   * whose stored status happens to be `idle`. A filter that contradicts the
   * badge next to it is broken; a filter whose results move because the derived
   * phase moved is merely live — which the badge already is, since phase is
   * reconciled per response and never persisted.
   *
   * The chips themselves come from the states actually on screen for the same
   * reason (`sessionStateChips`): a fixed phase list would offer chips that
   * match nothing and leave any record that arrived without a phase — badged
   * with its raw status — reachable under no chip at all.
   */
  const rows = useMemo(() => {
    const list = filterSessionsByState(sessions, stateFilter);
    return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [sessions, stateFilter]);

  const stateChips = useMemo(
    () => sessionStateChips(sessions, stateFilter),
    [sessions, stateFilter],
  );

  // Counted off the same derived state the badges show: a record still stored
  // `active` whose process is gone derives `ended`, and advertising it as live
  // is the stale-liveness bug the derived phase exists to kill. ARCS-owned
  // records are headless run bookkeeping, not sessions a human can reach —
  // counting them as "live" advertises agents nobody is talking to.
  const liveCount = sessions.filter(
    (s) => LIVE_STATES.has(sessionState(s)) && s.metadata?.control !== "arcs-owned",
  ).length;

  const linkLabel = useMemo(() => {
    const titles = new Map<string, string>();
    for (const t of tasksData?.tasks ?? []) titles.set(`task:${t.normalizedId}`, t.title);
    for (const p of plansData?.plans ?? []) titles.set(`plan:${p.normalizedId}`, p.title);
    return (session: SessionMeta): string | null => {
      if (!session.linkedNodeType || !session.linkedNodeId) return null;
      const key = `${session.linkedNodeType}:${session.linkedNodeId}`;
      return titles.get(key) ?? session.linkedNodeId;
    };
  }, [tasksData, plansData]);

  const unlink = useCallback(
    (session: SessionMeta) => {
      updateSession.mutate(
        { id: session.normalizedId, input: { linkedNodeType: null, linkedNodeId: null } },
        {
          onSuccess: () => push("success", "session unlinked"),
          onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
        },
      );
    },
    [updateSession, push],
  );

  const columns = useMemo<Column<SessionMeta>[]>(
    () => [
      {
        key: "status",
        title: "status",
        className: "w-36",
        sortValue: (s) => sessionStateRank(sessionState(s)),
        render: (s) => {
          const queued = s.messageQueue?.length ?? 0;
          return (
            <span
              className="inline-flex items-center gap-1"
              // Names which axis the badge is on, so the raw status stays
              // readable without ever being the thing a control acts on.
              title={
                s.phase
                  ? `live phase — the record's own status is "${s.status}"`
                  : `the record's own status — no live phase was sent for this session`
              }
            >
              <SessionStatusBadge session={s} />
              {queued > 0 && (
                <span
                  title={`${queued} message${queued === 1 ? "" : "s"} queued — waiting for the session's next checkpoint`}
                  className="text-term-amber"
                >
                  ✉{queued}
                </span>
              )}
            </span>
          );
        },
      },
      {
        key: "runtime",
        title: "runtime",
        className: "w-32",
        sortValue: (s) => s.runtimeType,
        render: (s) => (
          <span className="inline-flex items-center gap-1">
            <Badge color="blue">{RUNTIME_LABEL[s.runtimeType] ?? s.runtimeType}</Badge>
            <button
              type="button"
              title="view conversation in the session panel"
              onClick={(e) => {
                e.stopPropagation();
                openSession(s.normalizedId);
              }}
              className="text-term-dim hover:text-term-green"
            >
              ▤
            </button>
            {canSendMessage(s) && (
              <button
                type="button"
                title="send message"
                onClick={(e) => {
                  e.stopPropagation();
                  setMessageTarget(s);
                }}
                className="text-term-dim hover:text-term-green"
              >
                ✉
              </button>
            )}
          </span>
        ),
      },
      {
        key: "title",
        title: "session",
        sortValue: (s) => sessionName(s).toLowerCase(),
        // The id column sits right here, so the row shows the bare name — the
        // discriminated `sessionLabel` is for lists without an id of their own.
        render: (s) => (
          <span>
            <span className="font-bold">{sessionName(s)}</span>
            <span className="ml-2 text-term-dim">{truncate(s.runtimeSessionId, 20)}</span>
          </span>
        ),
      },
      {
        key: "directory",
        title: "directory",
        render: (s) => {
          const directory = metaString(s, "directory");
          return directory ? (
            <span className="text-term-amber">{truncate(directory, 36)}</span>
          ) : (
            <span className="text-term-dim">—</span>
          );
        },
      },
      {
        key: "linked",
        title: "linked to",
        className: "w-56",
        sortValue: (s) => linkLabel(s)?.toLowerCase() ?? "￿",
        render: (s) => {
          const label = linkLabel(s);
          if (!label) {
            return (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setLinkTarget(s);
                }}
                className="text-term-dim hover:text-term-green"
              >
                + link
              </button>
            );
          }
          return (
            <span className="inline-flex items-center gap-1">
              <Badge color={typeColor(s.linkedNodeType ?? "task")}>{s.linkedNodeType}</Badge>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setLinkTarget(s);
                }}
                className="hover:text-term-green"
              >
                {truncate(label, 24)}
              </button>
              <button
                type="button"
                title="unlink"
                onClick={(e) => {
                  e.stopPropagation();
                  unlink(s);
                }}
                className="text-term-dim hover:text-term-red"
              >
                ✕
              </button>
            </span>
          );
        },
      },
      {
        key: "started",
        title: "started",
        className: "w-20 text-right",
        sortValue: (s) => s.startedAt,
        render: (s) => <span className="text-term-dim">{relativeTime(s.startedAt)}</span>,
      },
      {
        key: "updated",
        title: "activity",
        className: "w-20 text-right",
        sortValue: (s) => s.lastMessageAt ?? s.updatedAt,
        render: (s) => (
          <span className="text-term-dim">{relativeTime(s.lastMessageAt ?? s.updatedAt)}</span>
        ),
      },
    ],
    [linkLabel, unlink, openSession],
  );

  return (
    <div className="flex h-full flex-col p-3">
      <Panel
        title="sessions"
        hint={`${rows.length}/${sessions.length} · ${liveCount} live`}
        actions={
          <span className="text-[11px] text-term-dim">
            session bridge · <span className="kbd">l</span> link · <span className="kbd">v</span>{" "}
            view · <span className="kbd">m</span> message · <span className="kbd">x</span> forget
          </span>
        }
      >
        <div className="flex items-center gap-1 border-b border-term-border px-2 py-1 text-[11px]">
          <StateChip
            active={stateFilter === null}
            onClick={() => setStateFilter(null)}
            label="all"
          />
          {stateChips.map((s) => (
            <StateChip
              key={s}
              active={stateFilter === s}
              onClick={() => setStateFilter(stateFilter === s ? null : s)}
              label={s}
            />
          ))}
        </div>

        {isLoading ? (
          <div className="px-3 py-4 text-term-dim">loading…</div>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(s) => s.normalizedId}
            onOpen={(s) => setLinkTarget(s)}
            onDelete={(s) => setDeleteTarget(s)}
            rowActions={[
              { keys: "l", description: "link session", run: (s) => setLinkTarget(s) },
              {
                keys: "v",
                description: "view conversation",
                // Every runtime has a conversation view — no canSendMessage gate.
                run: (s) => openSession(s.normalizedId),
              },
              {
                keys: "m",
                description: "send message",
                // Runtimes without a delivery channel simply have no action.
                run: (s) => {
                  if (canSendMessage(s)) setMessageTarget(s);
                },
              },
            ]}
            emptyMessage="no sessions — run `claude` in a linked directory to register one"
          />
        )}
      </Panel>

      {linkTarget && (
        <SessionLinkModal slug={slug} session={linkTarget} onClose={() => setLinkTarget(null)} />
      )}

      {messageTarget && (
        <SessionMessageForm
          slug={slug}
          session={messageTarget}
          onClose={() => setMessageTarget(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="forget session"
          message={
            <span>
              remove the record for{" "}
              <span className="font-bold text-term-fg">“{deleteTarget.runtimeSessionId}”</span>? the
              runtime session itself is not affected.
            </span>
          }
          confirmLabel="forget"
          onClose={() => setDeleteTarget(null)}
          onConfirm={() =>
            deleteSession.mutate(deleteTarget.normalizedId, {
              onSuccess: () => {
                push("success", "session record removed");
                setDeleteTarget(null);
              },
              onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
            })
          }
        />
      )}
    </div>
  );
}

/** One filter chip, labelled with the same state string the badges render. */
function StateChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "px-1.5 py-0.5",
        active ? "bg-term-green font-bold text-term-bg" : "text-term-dim hover:text-term-fg",
      )}
    >
      {label}
    </button>
  );
}
