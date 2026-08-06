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
 *
 * The composer can also dispatch a headless `claude -p` job instead of a
 * native send (the "deliver via" selector): resume an existing claude-code
 * session, run a fresh one-shot, or run against a persistent ARCS-owned
 * thread. Those modes are asynchronous by contract — the panel says the reply
 * appears when the job finishes, never "sent".
 *
 * opencode is temporarily hidden from the UI (`isVisibleSession`): its sessions
 * are absent from the picker, and a selection still pointing at one (deep link,
 * stale state) gets a "coming soon" placeholder instead of the composer. The
 * per-runtime branches below stay intact for when it comes back.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { SessionDocReference, SessionTurn } from "../api/client";
import { useRunClaudeSession, useSendSessionMessage, useSessionTranscript } from "../api/hooks";
import { sessionLabel, useSessionCandidates } from "../hooks/useSessionCandidates";
import { cx, relativeTime, truncate } from "../lib/format";
import { resolveReference } from "../lib/reference-resolver.js";
import { Badge } from "./Badge";
import { inputClass } from "./Dialog";
import { isVisibleSession, MAX_LENGTH, messageDelivery, WARN_LENGTH } from "./SessionMessageForm";
import { isSessionAttached } from "./SessionStatusBadge";
import { useToaster } from "./Toaster";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface SessionPanelContextValue {
  /** Panel open/closed — the shell toggle drives this. */
  open: boolean;
  /** Selected session's normalizedId; null until the user picks one. */
  selectedSessionId: string | null;
  /** Document-section reference awaiting a send (set by T005's ✉ flow).
   *
   *  Deliberately the DOC variant, not the whole `SessionReference` union: the
   *  pending-ref preview below dereferences `source.label`, `section.id` and
   *  `text`, which only a doc reference has, and the ✉ flow is the only
   *  producer until the file plane lands. The transport (`useSendSessionMessage`
   *  / `api.sendSessionMessage`) takes the full union — this narrowing is a
   *  property of the UI that builds the value, never of the wire. */
  pendingRef: SessionDocReference | null;
  /** Attach a reference (from a doc section) and open the panel. */
  openWithRef: (ref: SessionDocReference) => void;
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
  const [pendingRef, setPendingRef] = useState<SessionDocReference | null>(null);

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

/** Composer delivery path: inject into the running session (native — today's
 *  behavior) or dispatch a headless `claude -p` job (resume / one-shot /
 *  thread). Headless modes are async by contract, so their copy never claims
 *  instant delivery. */
type DeliverVia = "native" | "resume" | "oneshot" | "stable";

/** The option values the deliver-via <select> may emit — must stay exactly the
 *  DeliverVia members (mirrors RunClaudeSessionInput.mode minus "native", which
 *  is the inject path). Typed so a future member/value drift fails to compile. */
const DELIVER_VIA_VALUES: readonly DeliverVia[] = ["native", "resume", "oneshot", "stable"];

/** Sound narrowing for <select> onChange: unknown values fall back to "native"
 *  instead of being cast through to the API (a stray value would otherwise 400
 *  INVALID_BODY on the server's mode enum). */
const isDeliverVia = (value: string): value is DeliverVia =>
  (DELIVER_VIA_VALUES as readonly string[]).includes(value);

/** A mirror older than this is called out — checkpoints are frequent, so a long
 *  gap usually means the session moved on (or died) without one. */
const MIRROR_STALE_MS = 10 * 60_000;

/** `metadata.run` timestamps are epoch milliseconds (the runner writes
 *  `Date.now()`), while `relativeTime` takes an ISO string — convert here so
 *  the panel never renders an invalid date. */
function relativeEpoch(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  return relativeTime(new Date(ms).toISOString());
}

export function SessionPanel() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { open, selectedSessionId, pendingRef, openSession, clearRef, close } = useSessionPanel();
  const { push } = useToaster();
  const sendMessage = useSendSessionMessage(slug);
  const runClaude = useRunClaudeSession(slug);
  const [message, setMessage] = useState("");
  const [deliverVia, setDeliverVia] = useState<DeliverVia>("native");

  // Shared picker list — unfiltered, linked sessions sorted first. The panel
  // itself does not filter to linked sessions (see the "sort by linkage, never
  // filter by it" gotcha); it does drop runtimes the UI hides.
  const allCandidates = useSessionCandidates(slug, "");
  const candidates = useMemo(() => allCandidates.filter(isVisibleSession), [allCandidates]);
  // Resolved against the UNFILTERED list so a deep link (or a stale selection)
  // pointing at a hidden runtime is detectable instead of silently "no session".
  const selected = useMemo(
    () => allCandidates.find((s) => s.normalizedId === selectedSessionId) ?? null,
    [allCandidates, selectedSessionId],
  );
  const hiddenSelection = selected !== null && !isVisibleSession(selected);
  // Everything downstream (delivery copy, composer, transcript) treats a hidden
  // selection as no selection — the placeholder note takes the composer's slot.
  const selectedSession = hiddenSelection ? null : selected;

  const transcript = useSessionTranscript(slug, selectedSessionId, {
    // Mounted only while the panel is open AND a claude-code session is
    // selected — opencode has no mirror, and a closed panel must not poll.
    enabled: open && selectedSessionId !== null && selectedSession?.runtimeType === "claude-code",
  });

  // ARCS-owned records are headless bookkeeping — no terminal session is
  // attached, so a native send would land in a queue nothing ever drains.
  const arcsOwned = selectedSession?.metadata?.control === "arcs-owned";
  const queuedCount = selectedSession?.messageQueue?.length ?? 0;
  const run = selectedSession?.metadata?.run;
  // Absent outcome = a record from before the write-back existed, not a failure.
  const failedRun = run && run.outcome !== undefined && run.outcome !== "success" ? run : null;

  const mirroredAt = transcript.data?.mirroredAt ?? null;
  const mirrorAge = mirroredAt === null ? null : Date.now() - new Date(mirroredAt).getTime();
  const mirrorStale =
    mirrorAge !== null && Number.isFinite(mirrorAge) && mirrorAge > MIRROR_STALE_MS;

  const delivery = selectedSession ? messageDelivery(selectedSession) : null;
  const text = message.trim();
  const tooLong = text.length > MAX_LENGTH;
  // A headless resume takes over the SELECTED session's runtime thread, so it
  // is only offered for a claude-code session no process is currently driving —
  // a live terminal session cannot be resumed headlessly.
  //
  // Gated on the derived state (`isSessionAttached`), never on the persisted
  // `status`, for the same reason the table's filter, chips and live counter
  // are: the two disagree, and here they disagree in both directions. A session
  // stored `active` whose process is gone derives `idle` — "no fresh evidence
  // of attachment", which is the one state this affordance exists for — and a
  // live `running` session stored `idle` would be offered a resume that cannot
  // work.
  //
  // `idle`, not `ended`: `ended` is reachable only from a terminal status
  // (`completed`/`disconnected`), never from a process that went away, so it is
  // not what this gate ever sees on a resumable session — the exhaustive set of
  // (status, phase) pairs is listed beside ATTACHED_STATES in
  // SessionStatusBadge. Both sit outside that set so the predicate answers the
  // same either way, but `idle` is the state to reason about here.
  const resumeEligible =
    selectedSession?.runtimeType === "claude-code" && !isSessionAttached(selectedSession);
  const runPending = runClaude.isPending;
  const busy = sendMessage.isPending || runPending;
  const disabled =
    !selectedSession || !delivery || delivery.kind === "unsupported" || !text || tooLong || busy;

  // Resume is only meaningful against the session it was chosen for; switching
  // sessions (or the session picking up a live process mid-flow) makes it
  // stale, so drop back to native instead of letting a stale disabled option
  // lie in the UI.
  useEffect(() => {
    if (deliverVia === "resume" && !resumeEligible) setDeliverVia("native");
  }, [deliverVia, resumeEligible]);

  // Same rule for the other direction: native is a black hole on an ARCS-owned
  // record, so fall the selection back to a headless one-shot rather than let
  // the composer queue into nothing.
  useEffect(() => {
    if (deliverVia === "native" && arcsOwned) setDeliverVia("oneshot");
  }, [deliverVia, arcsOwned]);

  const sendLabel = runPending
    ? "job running…"
    : sendMessage.isPending
      ? "…"
      : deliverVia === "native"
        ? delivery?.kind === "queued"
          ? "queue"
          : "send"
        : "run";

  const submit = () => {
    if (disabled || !selectedSession || !delivery) return;
    if (deliverVia === "resume" && !resumeEligible) return;
    if (deliverVia === "native" && arcsOwned) return;

    if (deliverVia === "native") {
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
      return;
    }

    // Headless modes — accepted as HTTP 202; the job runs out-of-band and the
    // reply lands in the write-target's transcript when it finishes.
    runClaude.mutate(
      {
        id: selectedSession.normalizedId,
        input: {
          mode: deliverVia,
          message: text,
          // Sidecar-only: the server stores the reference on the appended turn,
          // never feeds it into the headless prompt.
          reference: pendingRef ?? undefined,
        },
      },
      {
        onSuccess: (result) => {
          // Modes 2/3 write to an ARCS-owned record — switch the panel to its
          // transcript so the prompt (and the eventual reply) are visible. The
          // transcript render gate (`runtimeType === "claude-code"`) already
          // passes for these records. Resume targets the selected session
          // itself, so no switch is needed there.
          if (deliverVia !== "resume") openSession(result.session.normalizedId);
          push(
            "success",
            "headless claude job accepted — the reply appears in the transcript when the job finishes",
          );
          setMessage("");
          if (pendingRef) clearRef(); // the reference was consumed by this run
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

      {/* runtime copy — the delivery asymmetry, stated outright. A hidden
          selection reads as "no session" here; the composer slot below carries
          the one note that explains why. */}
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

      {/* session picker — every runtime the UI surfaces */}
      <div className="border-b border-term-border p-2">
        <div className="mb-1 text-[10px] tracking-wide text-term-dim uppercase">session</div>
        <select
          // Falls back to the placeholder option when the selection is hidden
          // or not loaded — a value with no matching <option> renders blank.
          value={selectedSession?.normalizedId ?? ""}
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

      {/* composer + pending reference — a hidden-runtime selection gets a
          placeholder instead of the chat controls, so the panel never shows a
          composer that cannot reach anything. */}
      {hiddenSelection ? (
        <div className="border-b border-term-border p-2 text-[11px] text-term-dim">
          opencode sessions — coming soon
        </div>
      ) : (
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

          {selectedSession && (
            <div className="mb-1 flex items-center gap-2 text-[11px]">
              <label
                htmlFor="deliver-via"
                className="text-[10px] tracking-wide text-term-dim uppercase"
              >
                deliver via
              </label>
              <select
                id="deliver-via"
                value={deliverVia}
                onChange={(e) =>
                  setDeliverVia(isDeliverVia(e.target.value) ? e.target.value : "native")
                }
                disabled={runPending}
                title="how this message reaches the agent"
                className="border border-term-border bg-term-inset px-1.5 py-0.5 text-[11px] text-term-fg outline-none focus:border-term-green/60 disabled:opacity-50"
              >
                <option
                  value="native"
                  disabled={arcsOwned}
                  title={
                    arcsOwned
                      ? "ARCS-owned headless record — no terminal session drains this queue; use thread or one-shot"
                      : "delivered by the session's own runtime"
                  }
                >
                  native — {delivery?.kind === "live" ? "live inject" : "queued at checkpoint"}
                </option>
                <option
                  value="resume"
                  disabled={!resumeEligible}
                  title={
                    resumeEligible
                      ? "headless resume of the selected claude-code session"
                      : "resume needs a claude-code session nothing is currently driving — a session badged running cannot be resumed headlessly"
                  }
                >
                  resume — headless resume of this session
                </option>
                <option value="oneshot">one-shot — fresh headless claude, no memory</option>
                <option value="stable">thread — coherent headless thread</option>
              </select>
            </div>
          )}

          {selectedSession && delivery && (
            <div className="mb-1 flex items-baseline gap-2 text-[11px] text-term-dim">
              {deliverVia === "native" ? (
                <>
                  <span
                    className={cx(
                      "font-bold",
                      delivery.kind === "live" ? "text-term-green" : "text-term-amber",
                    )}
                  >
                    {delivery.kind}
                  </span>
                  <span>{delivery.hint}</span>
                </>
              ) : (
                <span className="text-term-amber">
                  runs a headless claude job in the workspace; the reply appears in the transcript
                  when the job finishes — not live
                </span>
              )}
            </div>
          )}

          {queuedCount > 0 && (
            <div className="mb-1 text-[11px] text-term-amber">
              {queuedCount} queued · waiting for the session's next checkpoint
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
            disabled={!selectedSession || runPending}
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
              {sendLabel}
            </button>
            <span className="flex-1" />
            {selectedSession && (
              <span className="text-[10px] text-term-dim">
                <span className="kbd">ctrl</span>+<span className="kbd">enter</span> send
              </span>
            )}
          </div>
        </div>
      )}

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
            {/* Mirror freshness, not a static claim: the transcript is only as
                current as the last checkpoint, and a stale one is the usual
                reason a reply seems missing. */}
            <span
              title="the transcript is a checkpoint mirror — refreshed at each checkpoint, never live"
              className={cx("text-[10px]", mirrorStale ? "text-term-amber" : "text-term-dim")}
            >
              {mirroredAt === null ? "never mirrored" : `last mirror ${relativeTime(mirroredAt)}`}
            </span>
          </header>
          {failedRun && (
            <div className="border-b border-term-red/40 px-2 py-1 text-[11px] text-term-red">
              run failed — {failedRun.error ?? failedRun.outcome}
              <span className="ml-2 text-term-dim">{relativeEpoch(failedRun.endedAt)}</span>
            </div>
          )}
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
