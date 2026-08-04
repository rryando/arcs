/**
 * Persistent split-panel conversation view — "chat but not really".
 *
 * One generic pane over the transcript GET + message POST. Per-runtime
 * differences live only in delivery copy (`messageDelivery()`: live=opencode /
 * queued=claude-code) and the claude-code-only transcript section. The
 * asymmetry is deliberate and never fudged: opencode prompts inject directly
 * (and opencode has no mirror), while claude-code messages queue for the
 * session's next checkpoint and its transcript is checkpoint-mirrored, never
 * live.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import type { SessionMessageReference, SessionTurn } from "../api/client";
import { useSendSessionMessage, useSessionTranscript } from "../api/hooks";
import { sessionLabel, useSessionCandidates } from "../hooks/useSessionCandidates";
import { cx, truncate } from "../lib/format";
import { resolveReference } from "../lib/reference-resolver.js";
import { Badge } from "./Badge";
import { inputClass } from "./Dialog";
import { MAX_LENGTH, messageDelivery, WARN_LENGTH } from "./SessionMessageForm";
import { useToaster } from "./Toaster";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface SessionPanelContextValue {
  /** Panel open/closed — the shell toggle drives this. */
  open: boolean;
  /** Selected session's normalizedId; null until the user picks one. */
  selectedSessionId: string | null;
  /** Document-section reference awaiting a send (set by T005's ✉ flow). */
  pendingRef: SessionMessageReference | null;
  /** Attach a reference (from a doc section) and open the panel. */
  openWithRef: (ref: SessionMessageReference) => void;
  /** Select a session and open the panel. */
  openSession: (id: string) => void;
  close: () => void;
  /** Shell-level toggle — opens without selecting, closes when open. */
  toggle: () => void;
  /** Drop a consumed reference (after a successful send with a reference). */
  clearRef: () => void;
}

const SessionPanelContext = createContext<SessionPanelContextValue | null>(null);

export function SessionPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [pendingRef, setPendingRef] = useState<SessionMessageReference | null>(null);

  const value = useMemo<SessionPanelContextValue>(
    () => ({
      open,
      selectedSessionId,
      pendingRef,
      openWithRef: (ref) => {
        setPendingRef(ref);
        setOpen(true);
      },
      openSession: (id) => {
        setSelectedSessionId(id);
        setOpen(true);
      },
      close: () => setOpen(false),
      toggle: () => setOpen((v) => !v),
      clearRef: () => setPendingRef(null),
    }),
    [open, selectedSessionId, pendingRef],
  );

  return <SessionPanelContext.Provider value={value}>{children}</SessionPanelContext.Provider>;
}

export function useSessionPanel(): SessionPanelContextValue {
  const ctx = useContext(SessionPanelContext);
  if (!ctx) throw new Error("useSessionPanel must be used inside SessionPanelProvider");
  return ctx;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function SessionPanel() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { open, selectedSessionId, pendingRef, openSession, clearRef, close } = useSessionPanel();
  const { push } = useToaster();
  const sendMessage = useSendSessionMessage(slug);
  const [message, setMessage] = useState("");

  // Shared picker list — unfiltered, linked sessions sorted first. The panel
  // itself does not filter to linked sessions (see the "sort by linkage, never
  // filter by it" gotcha).
  const candidates = useSessionCandidates(slug, "");
  const selectedSession = useMemo(
    () => candidates.find((s) => s.normalizedId === selectedSessionId) ?? null,
    [candidates, selectedSessionId],
  );

  const transcript = useSessionTranscript(slug, selectedSessionId, {
    // Mounted only while the panel is open AND a claude-code session is
    // selected — opencode has no mirror, and a closed panel must not poll.
    enabled: open && selectedSessionId !== null && selectedSession?.runtimeType === "claude-code",
  });

  const delivery = selectedSession ? messageDelivery(selectedSession) : null;
  const text = message.trim();
  const tooLong = text.length > MAX_LENGTH;
  const disabled =
    !selectedSession ||
    !delivery ||
    delivery.kind === "unsupported" ||
    !text ||
    tooLong ||
    sendMessage.isPending;

  const submit = () => {
    if (disabled || !selectedSession || !delivery) return;
    sendMessage.mutate(
      {
        id: selectedSession.normalizedId,
        message: text,
        // Attach the pending reference only when present — otherwise the body
        // stays byte-identical to `{ message }`.
        reference: pendingRef ?? undefined,
      },
      {
        onSuccess: () => {
          // Distinct copy per delivery mode: "sent" would be a lie for a queued
          // message that the session has not collected yet.
          push(
            "success",
            delivery.kind === "queued"
              ? "message queued — delivered at the session's next checkpoint"
              : "message sent to session",
          );
          setMessage("");
          if (pendingRef) clearRef(); // the reference was consumed by this send
        },
        onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
      },
    );
  };

  return (
    <aside
      aria-label="session panel"
      className="hidden w-96 shrink-0 flex-col border-l border-term-border bg-term-panel lg:flex"
    >
      {/* title bar */}
      <header className="flex items-center gap-2 border-b border-term-border px-2 py-1">
        <span className="text-term-green">▸</span>
        <h2 className="text-[12px] font-bold tracking-wide text-term-fg uppercase">
          session panel
        </h2>
        {selectedSession && (
          <Badge color={selectedSession.runtimeType === "opencode" ? "blue" : "purple"}>
            {selectedSession.runtimeType}
          </Badge>
        )}
        <span className="flex-1" />
        <button
          type="button"
          title="close session panel"
          onClick={close}
          className="text-term-dim hover:text-term-red"
        >
          ✕
        </button>
      </header>

      {/* runtime copy — the delivery asymmetry, stated outright */}
      {selectedSession ? (
        <div className="flex items-center gap-2 border-b border-term-border px-2 py-1 text-[11px]">
          {selectedSession.runtimeType === "opencode" ? (
            <span className="text-term-green">live runtime — prompts inject directly</span>
          ) : (
            <span className="text-term-amber">
              queued — delivered at the session's next checkpoint
            </span>
          )}
          <span className="flex-1" />
          <span className="text-term-dim">{truncate(selectedSession.runtimeSessionId, 20)}</span>
        </div>
      ) : (
        <div className="border-b border-term-border px-2 py-1 text-[11px] text-term-dim">
          pick a session to compose
        </div>
      )}

      {/* session picker — any runtime */}
      <div className="border-b border-term-border p-2">
        <div className="mb-1 text-[10px] tracking-wide text-term-dim uppercase">session</div>
        <select
          value={selectedSessionId ?? ""}
          onChange={(e) => {
            if (e.target.value) openSession(e.target.value);
          }}
          className={inputClass}
        >
          <option value="" disabled>
            pick a session…
          </option>
          {candidates.map((s) => (
            <option key={s.normalizedId} value={s.normalizedId}>
              {sessionLabel(s)} — {s.runtimeType}
            </option>
          ))}
        </select>
        {candidates.length === 0 && (
          <div className="mt-1 text-[11px] text-term-dim">
            no sessions registered for this project
          </div>
        )}
      </div>

      {/* composer + pending reference */}
      <div className="border-b border-term-border p-2">
        {pendingRef && (
          <div className="mb-2 border border-term-cyan/40 bg-term-inset">
            <div className="flex items-center gap-2 border-b border-term-border/60 px-2 py-0.5">
              <span className="text-[10px] font-bold tracking-wide text-term-cyan uppercase">
                reference
              </span>
              <span className="flex-1" />
              <button
                type="button"
                title="remove reference"
                onClick={clearRef}
                className="text-term-dim hover:text-term-red"
              >
                ✕
              </button>
            </div>
            <div className="px-2 py-1 text-[11px] leading-snug text-term-dim">
              <span className="text-term-fg">{pendingRef.source.label}</span>{" "}
              <span className="text-term-cyan">§ {pendingRef.section.id}</span>
              <span className="mt-0.5 block text-term-dim/80">
                {truncate(pendingRef.text, 120)}
              </span>
            </div>
          </div>
        )}

        {selectedSession && delivery && (
          <div className="mb-1 flex items-baseline gap-2 text-[11px] text-term-dim">
            <span
              className={cx(
                "font-bold",
                delivery.kind === "live" ? "text-term-green" : "text-term-amber",
              )}
            >
              {delivery.kind}
            </span>
            <span>{delivery.hint}</span>
          </div>
        )}

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={!selectedSession}
          placeholder={
            selectedSession ? "message for the agent…" : "pick a session first — no target yet"
          }
          rows={3}
          className={cx(inputClass, "resize-y leading-snug disabled:opacity-50")}
        />

        {text.length > WARN_LENGTH && (
          <div className="mt-1 text-[11px] text-term-amber">
            {text.length} characters —{" "}
            {tooLong
              ? `over the ${MAX_LENGTH} character ceiling for one message; trim it before sending`
              : "large messages may be slow to deliver or truncated by the target session"}
          </div>
        )}

        <div className="mt-2 flex items-center gap-2 text-[12px]">
          <button
            type="button"
            disabled={disabled}
            onClick={submit}
            className="border border-term-green/60 px-2 py-0.5 font-bold text-term-green hover:bg-term-green hover:text-term-bg disabled:opacity-50"
          >
            {sendMessage.isPending ? "…" : delivery?.kind === "queued" ? "queue" : "send"}
          </button>
          <span className="flex-1" />
          {selectedSession && (
            <span className="text-[10px] text-term-dim">
              <span className="kbd">ctrl</span>+<span className="kbd">enter</span> send
            </span>
          )}
        </div>
      </div>

      {/* transcript — claude-code only; opencode has no mirror */}
      {selectedSession?.runtimeType === "claude-code" && (
        <section
          className="flex min-h-0 flex-1 flex-col"
          aria-label="checkpoint-mirrored transcript"
        >
          <header className="flex items-center gap-2 border-b border-term-border px-2 py-1">
            <h3 className="text-[10px] font-bold tracking-wide text-term-dim uppercase">
              transcript
            </h3>
            <span className="flex-1" />
            <span className="text-[10px] text-term-dim">
              checkpoint-mirrored — refreshed at each checkpoint, never live
            </span>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {transcript.isLoading ? (
              <div className="text-[11px] text-term-dim">loading…</div>
            ) : (transcript.data?.turns.length ?? 0) === 0 ? (
              <div className="text-[11px] text-term-dim">
                no turns mirrored yet — appears after the session's first checkpoint
              </div>
            ) : (
              (transcript.data?.turns ?? []).map((t) => <TurnRow key={t.id} turn={t} slug={slug} />)
            )}
          </div>
        </section>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Turn rendering
// ---------------------------------------------------------------------------

function TurnRow({ turn, slug }: { turn: SessionTurn; slug: string }) {
  if (turn.type === "reference") return <ReferenceCard turn={turn} slug={slug} />;
  const speaker = turn.type === "user" ? "you" : "agent";
  return (
    <div className="mb-2">
      <div className="flex items-baseline gap-2">
        <span
          className={cx(
            "text-[10px] font-bold tracking-wide uppercase",
            turn.type === "user" ? "text-term-green" : "text-term-cyan",
          )}
        >
          {speaker}
        </span>
        {turn.ts && <span className="text-[10px] text-term-dim">{turn.ts}</span>}
      </div>
      {turn.tool ? (
        <div className="text-[11px] text-term-dim">[tool: {turn.tool.name}]</div>
      ) : (
        <div className="break-words text-[12px] whitespace-pre-wrap text-term-fg">{turn.text}</div>
      )}
    </div>
  );
}

function ReferenceCard({ turn, slug }: { turn: SessionTurn; slug: string }) {
  const navigate = useNavigate();

  // Click-through to the quoted section's source document: resolve the
  // reference to a full navigable route, then navigate via `href` so the
  // router parses the ?doc= search and #section hash (MarkdownViewer's
  // hash-scroll effect lands on the exact heading once the target mounts).
  const openSource = () => {
    if (!turn.section || !turn.source) return;
    const { kind, doc, id } = turn.source;
    // The server's source shape is loose (optional doc/id per kind), but the
    // resolver's discriminated union pins exactly one identifier per kind —
    // narrow before calling so an impossible state cannot compile.
    if (kind === "overview") {
      if (!doc) return;
      const target = resolveReference({ slug, kind, doc, sectionId: turn.section.id });
      navigate({ href: `${target.path}${target.hash}` });
      return;
    }
    if (!id) return;
    const target = resolveReference({ slug, kind, id, sectionId: turn.section.id });
    navigate({ href: `${target.path}${target.hash}` });
  };

  return (
    <button
      type="button"
      onClick={openSource}
      title="open the source document at this section"
      className="mb-2 block w-full cursor-pointer border border-term-cyan/40 bg-term-inset text-left hover:border-term-cyan/80"
    >
      <div className="flex items-center gap-2 border-b border-term-border/60 px-2 py-0.5">
        <Badge color="cyan">reference</Badge>
        <span className="truncate text-[10px] text-term-dim">
          {turn.source?.label ?? "unknown source"}
        </span>
        <span className="flex-1" />
        <span className="text-[10px] text-term-dim">{turn.source?.kind ?? ""}</span>
      </div>
      <div className="px-2 py-1 text-[12px] text-term-fg">{turn.text}</div>
      {turn.section && (
        <div className="border-t border-term-border/60 px-2 py-1">
          <div className="text-[10px] font-bold tracking-wide text-term-cyan uppercase">
            § {turn.section.id}
          </div>
          <div className="mt-0.5 line-clamp-3 text-[11px] leading-snug whitespace-pre-wrap text-term-dim">
            {turn.section.text}
          </div>
        </div>
      )}
    </button>
  );
}
