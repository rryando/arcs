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
import { SESSION_STATE_ORDER, SESSION_STATUSES, SessionStatusBadge } from "./SessionStatusBadge";

const RUNTIME_LABEL: Record<string, string> = {
  opencode: "opencode",
  "claude-code": "claude code",
};

function metaString(session: SessionMeta, key: string): string {
  const value = session.metadata?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * What the status column shows: the server's derived phase — the only answer to
 * "is this session live right now" — falling back to the record's own status
 * for a session that reached the table without one. The raw status stays
 * readable in the cell's tooltip, so the two are never confused for each other.
 */
function sessionState(session: SessionMeta): string {
  return session.phase ?? session.status;
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

  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionMeta | null>(null);
  const [linkTarget, setLinkTarget] = useState<SessionMeta | null>(null);
  const [messageTarget, setMessageTarget] = useState<SessionMeta | null>(null);

  // The API returns every runtime; the view shows only the ones the UI
  // currently surfaces, so the counts below describe what the user can see.
  const sessions = useMemo(() => (data?.sessions ?? []).filter(isVisibleSession), [data]);

  const rows = useMemo(() => {
    const list = statusFilter ? sessions.filter((s) => s.status === statusFilter) : sessions;
    return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [sessions, statusFilter]);

  // ARCS-owned records are headless run bookkeeping, not sessions a human can
  // reach — counting them as "live" advertises agents nobody is talking to.
  const liveCount = sessions.filter(
    (s) => (s.status === "active" || s.status === "idle") && s.metadata?.control !== "arcs-owned",
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
        sortValue: (s) => SESSION_STATE_ORDER.indexOf(sessionState(s)),
        render: (s) => {
          const queued = s.messageQueue?.length ?? 0;
          return (
            <span
              className="inline-flex items-center gap-1"
              title={`live phase — the record's own status is "${s.status}"`}
            >
              <SessionStatusBadge status={sessionState(s)} />
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
          <StatusChip
            active={statusFilter === null}
            onClick={() => setStatusFilter(null)}
            label="all"
          />
          {SESSION_STATUSES.map((s) => (
            <StatusChip
              key={s}
              active={statusFilter === s}
              onClick={() => setStatusFilter(statusFilter === s ? null : s)}
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

function StatusChip({
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
