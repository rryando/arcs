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
 * The composer can also dispatch a headless `claude -p` turn instead of a
 * native send. That is TWO orthogonal controls, not one list: DELIVERY says
 * which channel carries the message (native — the session's own runtime — or
 * headless), and INTENT says what a headless turn is allowed to do (`ask`
 * inspects, `change` edits). They cannot be folded together: native has no
 * intent because ARCS authors no argv for it, and a headless turn always has
 * one. Headless is asynchronous by contract — the panel says the reply appears
 * when the job finishes, never "sent".
 *
 * Where a headless turn LANDS is not a control at all: the server derives it
 * from the selected record (an ARCS thread continues; an observed session is
 * forked into a new thread), and the 202 names the write target it chose.
 *
 * A dispatched job is WATCHED rather than merely awaited: the 202 names the
 * run, and the panel tails that run's event log over its own SSE channel
 * (`useRunStream`), rendering assistant text as it arrives plus a compact tool
 * ticker. The live block and the run's folded sidecar turns are the same
 * content reaching the panel by two routes, so the turn list is composed once
 * (`composeTurnList`) and holds exactly one of them.
 *
 * opencode is temporarily hidden from the UI (`isVisibleSession`): its sessions
 * are absent from the picker, and a selection still pointing at one (deep link,
 * stale state) gets a "coming soon" placeholder instead of the composer. The
 * per-runtime branches below stay intact for when it comes back.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { RunIntent, SessionReference, SessionRunMeta, SessionTurn } from "../api/client";
import { useSendSessionMessage, useSendSessionTurn, useSessionTranscript } from "../api/hooks";
import { type RunStreamState, runStreamText, useRunStream } from "../api/sse";
import { sessionLabel, useSessionCandidates } from "../hooks/useSessionCandidates";
import { cx, relativeTime, truncate } from "../lib/format";
import { resolveReference } from "../lib/reference-resolver.js";
import { Badge } from "./Badge";
import { inputClass } from "./Dialog";
import { isVisibleSession, MAX_LENGTH, messageDelivery, WARN_LENGTH } from "./SessionMessageForm";
import { useToaster } from "./Toaster";
import { WorkspaceFileViewer } from "./WorkspaceFileViewer";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface SessionPanelContextValue {
  /** Panel open/closed — the shell toggle drives this. */
  open: boolean;
  /** Selected session's normalizedId; null until the user picks one. */
  selectedSessionId: string | null;
  /** Reference awaiting a send.
   *
   *  The FULL union, matching the transport and the server's
   *  `sessionReferenceSchema`. It was narrowed to the doc variant while the ✉
   *  flow was the only producer; the workspace file plane is the second one, so
   *  the slot now holds whatever variant its producer built and the preview
   *  branches on the tag instead of dereferencing doc-only fields. */
  pendingRef: SessionReference | null;
  /** Attach a reference (a doc section, a file slice, a DAG node) and open the
   *  panel. */
  openWithRef: (ref: SessionReference) => void;
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
  const [pendingRef, setPendingRef] = useState<SessionReference | null>(null);

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

/** Composer delivery channel: hand the message to the session's own runtime
 *  (native — injected for opencode, queued for a claude-code terminal) or run a
 *  headless `claude -p` turn against a thread ARCS owns. Headless is async by
 *  contract, so its copy never claims instant delivery. */
type DeliverVia = "native" | "headless";

/** The option values the delivery <select> may emit — exactly the DeliverVia
 *  members. Typed so a future member/value drift fails to compile. */
const DELIVER_VIA_VALUES: readonly DeliverVia[] = ["native", "headless"];

/** Sound narrowing for <select> onChange: unknown values fall back to "native"
 *  instead of being cast through to the API. */
const isDeliverVia = (value: string): value is DeliverVia =>
  (DELIVER_VIA_VALUES as readonly string[]).includes(value);

/** The option values the intent <select> may emit — exactly `RunIntent`, which
 *  mirrors the server's `RUN_INTENTS` enum. An unknown value falls back to the
 *  read-only `ask` rather than being cast through to the API: the server's zod
 *  enum would 400 it, and failing closed is the right direction for a control
 *  whose only job is to widen what a run may touch. */
const RUN_INTENT_VALUES: readonly RunIntent[] = ["ask", "change"];

const isRunIntent = (value: string): value is RunIntent =>
  (RUN_INTENT_VALUES as readonly string[]).includes(value);

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

/** The run the panel is currently tailing. `sessionId` is the run's WRITE
 *  TARGET (the record the log is keyed on and the reply lands in), which is the
 *  selected session for a resume and the ARCS-owned thread for the other
 *  modes — not necessarily the session that was selected when it was sent. */
interface WatchedRun {
  sessionId: string;
  runId: string;
}

/** What a repaired thread-seed failure means for the NEXT turn. Keyed on the
 *  server's `metadata.run.errorCode`, which is only ever written on a failure
 *  the server recognized AND already fixed the record for — so every line here
 *  can promise what happens next rather than describe what went wrong. */
const RUN_ERROR_HINT: Record<NonNullable<SessionRunMeta["errorCode"]>, string> = {
  THREAD_SEED_CONFLICT: "claude already held this thread — repaired; the next turn resumes it",
  THREAD_UNKNOWN_TO_CLAUDE:
    "claude no longer has this thread — repaired; the next turn starts a fresh one",
};

/** What the streamed block's header says, per status. `ended` carries the
 *  outcome instead, so it has no fixed label here. */
const RUN_STREAM_LABEL: Record<RunStreamState["status"], string> = {
  idle: "",
  connecting: "connecting…",
  open: "streaming",
  ended: "done",
  failed: "stream unavailable — the reply still lands in the transcript",
};

export function SessionPanel() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { open, selectedSessionId, pendingRef, openSession, openWithRef, clearRef, close } =
    useSessionPanel();
  const { push } = useToaster();
  const sendMessage = useSendSessionMessage(slug);
  const sendTurn = useSendSessionTurn(slug);
  const [message, setMessage] = useState("");
  const [deliverVia, setDeliverVia] = useState<DeliverVia>("native");
  // Independent of `deliverVia`: intent describes what a HEADLESS turn may do,
  // and defaults to the read-only policy so widening is always a deliberate act.
  const [intent, setIntent] = useState<RunIntent>("ask");
  const [watchedRun, setWatchedRun] = useState<WatchedRun | null>(null);

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

  // Tails the accepted run wherever it landed, INDEPENDENTLY of what is on
  // screen: the tail follows the run's write target, so switching sessions
  // mid-run neither drops the stream nor re-runs it from zero.
  const runStream = useRunStream(slug, watchedRun?.sessionId ?? null, watchedRun?.runId ?? null);
  // ...but it is only RENDERED under the session it belongs to. A run's text
  // under another session's transcript would be a lie about whose reply it is.
  const liveRun = watchedRun?.sessionId === selectedSessionId ? runStream : null;
  const turnItems = useMemo(
    () => composeTurnList(transcript.data?.turns ?? [], liveRun),
    [transcript.data?.turns, liveRun],
  );

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
  // There is deliberately NO attachment gate on headless delivery any more.
  // A turn against an observed session FORKS it — probed on claude 2.1.223, the
  // fork writes a separate transcript and leaves the original untouched — so a
  // live terminal session is safe to drive and the demote-only `isSessionAttached`
  // check (which read `idle` as "probably nothing attached" and was wrong in both
  // directions often enough to matter) has nothing left to protect.
  const runPending = sendTurn.isPending;
  const busy = sendMessage.isPending || runPending;
  const disabled =
    !selectedSession || !delivery || delivery.kind === "unsupported" || !text || tooLong || busy;

  // Native is a black hole on an ARCS-owned record — nothing drains its queue —
  // so the composer falls back to the headless channel rather than queueing into
  // nothing. It falls back to a CHANNEL: `intent` is its own control and keeps
  // whatever it was, defaulting to the read-only `ask`.
  useEffect(() => {
    if (deliverVia === "native" && arcsOwned) setDeliverVia("headless");
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

    // Headless — accepted as HTTP 202; the turn runs out-of-band and the reply
    // lands in the WRITE TARGET's transcript when it finishes.
    sendTurn.mutate(
      {
        id: selectedSession.normalizedId,
        input: {
          intent,
          message: text,
          // References ride the turn: the server renders them into the prompt
          // AND records them on the write target's sidecar.
          ...(pendingRef && { refs: [pendingRef] }),
        },
      },
      {
        onSuccess: (result) => {
          // Follow the run to the record it actually landed on. Under adoption
          // that is a freshly forked thread, not the selected session — reading
          // it off the response is the only way to know which. A turn that
          // continued the selected thread names it back, so this is a no-op.
          openSession(result.writeTargetId);
          // Watch the run the 202 named — same key the server built `streamUrl`
          // from, so the live block tails the log that is actually being written.
          setWatchedRun({ sessionId: result.writeTargetId, runId: result.runId });
          push(
            "success",
            "headless claude turn accepted — the reply appears in the transcript when it finishes",
          );
          setMessage("");
          if (pendingRef) clearRef(); // the reference was consumed by this turn
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

      {/* workspace files — the "point at a file and ask about it" surface. Its
          line-range selection lands in `pendingRef` through `openWithRef`, the
          same slot the ✉ doc flow fills, so the composer below sends it with no
          per-variant branch of its own. */}
      <WorkspaceFileViewer slug={slug} onAttach={openWithRef} />

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
                <PendingReferencePreview reference={pendingRef} />
              </div>
            </div>
          )}

          {/* TWO orthogonal controls. Delivery picks the channel; intent picks
              what a headless turn may touch and is shown only when it applies —
              rendering it beside `native` would imply ARCS constrains a message
              it hands to somebody else's runtime, which it does not. */}
          {selectedSession && (
            <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
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
                title="which channel carries this message"
                className="border border-term-border bg-term-inset px-1.5 py-0.5 text-[11px] text-term-fg outline-none focus:border-term-green/60 disabled:opacity-50"
              >
                <option
                  value="native"
                  disabled={arcsOwned}
                  title={
                    arcsOwned
                      ? "ARCS-owned headless thread — no terminal session drains this queue; use headless"
                      : "delivered by the session's own runtime"
                  }
                >
                  native — {delivery?.kind === "live" ? "live inject" : "queued at checkpoint"}
                </option>
                <option value="headless" title="run a headless claude turn in the workspace">
                  headless — ARCS runs a claude turn
                </option>
              </select>

              {deliverVia === "headless" && (
                <>
                  <label
                    htmlFor="run-intent"
                    className="text-[10px] tracking-wide text-term-dim uppercase"
                  >
                    intent
                  </label>
                  <select
                    id="run-intent"
                    value={intent}
                    onChange={(e) =>
                      setIntent(isRunIntent(e.target.value) ? e.target.value : "ask")
                    }
                    disabled={runPending}
                    title="what this turn is allowed to do in the workspace"
                    className="border border-term-border bg-term-inset px-1.5 py-0.5 text-[11px] text-term-fg outline-none focus:border-term-green/60 disabled:opacity-50"
                  >
                    <option value="ask" title="read-only: Read, Grep, Glob in plan mode">
                      ask — read only
                    </option>
                    <option value="change" title="adds the edit surface; still no shell by default">
                      change — may edit files
                    </option>
                  </select>
                </>
              )}
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
                  {arcsOwned
                    ? "continues this ARCS thread; the reply appears in the transcript when the turn finishes — not live"
                    : "forks this session into a new ARCS thread — the original transcript is left untouched; the reply appears there when the turn finishes"}
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
              {/* A recognized failure the server already repaired the record
                  for: say what the next turn will do instead of leaving the
                  reader to interpret claude's stderr. */}
              {failedRun.errorCode && (
                <span className="mt-0.5 block text-term-amber">
                  {RUN_ERROR_HINT[failedRun.errorCode]}
                </span>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {transcript.isLoading && turnItems.length === 0 ? (
              <div className="text-[11px] text-term-dim">loading…</div>
            ) : turnItems.length === 0 ? (
              <div className="text-[11px] text-term-dim">
                no turns mirrored yet — appears after the session's first checkpoint
              </div>
            ) : (
              // ONE list, from ONE composition — the live block and the folded
              // turns of a run are never both in it (see `composeTurnList`).
              turnItems.map((item) =>
                item.kind === "stream" ? (
                  <StreamedRunBlock key="run-stream" stream={item.stream} />
                ) : (
                  <TurnRow key={item.turn.id} turn={item.turn} slug={slug} />
                ),
              )
            )}
          </div>
        </section>
      )}
    </aside>
  );
}

/**
 * One line of "what is attached to this send", per reference variant.
 *
 * Branches on the tag rather than dereferencing doc-only fields: the doc
 * variant's tag is optional (the server defaults it), so `doc` is the fall-
 * through and each pointer variant is matched explicitly.
 */
function PendingReferencePreview({ reference }: { reference: SessionReference }) {
  if (reference.type === "file") {
    return (
      <>
        <span className="text-term-fg">{reference.path}</span>{" "}
        <span className="text-term-cyan">
          L{reference.startLine}–{reference.endLine}
        </span>
        {reference.headRev && (
          <span className="ml-1 text-term-dim/80" title="head revision when the slice was taken">
            @{reference.headRev}
          </span>
        )}
        {reference.excerpt && (
          <span className="mt-0.5 block text-term-dim/80">{truncate(reference.excerpt, 120)}</span>
        )}
      </>
    );
  }

  if (reference.type === "node") {
    return (
      <>
        <span className="text-term-fg">{reference.id}</span>{" "}
        <span className="text-term-cyan">{reference.kind}</span>
      </>
    );
  }

  return (
    <>
      <span className="text-term-fg">{reference.source.label}</span>{" "}
      <span className="text-term-cyan">§ {reference.section.id}</span>
      <span className="mt-0.5 block text-term-dim/80">{truncate(reference.text, 120)}</span>
    </>
  );
}

// ---------------------------------------------------------------------------
// Turn rendering
// ---------------------------------------------------------------------------

/** One entry of the panel's turn list: a folded sidecar turn, or THE live
 *  streamed block. */
export type TurnListItem =
  | { kind: "turn"; turn: SessionTurn }
  | { kind: "stream"; stream: RunStreamState };

/**
 * The turn list the panel renders, composed once from the two sources that can
 * describe the same run.
 *
 * INVARIANT — the streamed block and the folded turns of the same run are never
 * both in the returned list. A run reaches the panel twice: live, line by line
 * off its event log, and again as sidecar turns the settle folds down. Showing
 * both is the duplicated-text flash; showing neither is text that vanishes
 * while the transcript refetches.
 *
 * It holds by CONSTRUCTION rather than by timing. The server tags every turn it
 * folds with the run id (`SessionTurn.run`), so "this run is in the sidecar" is
 * a fact read off the same transcript array being rendered — not a timer, not
 * an `ended` flag on the stream, and not a second piece of state that could
 * disagree with the list. The block is therefore dropped in the very commit its
 * folded turns appear in, and kept in every commit before it: the two are
 * mutually exclusive branches of one expression over one input.
 *
 * Deliberately NOT keyed on the stream's status: a run that settles with no
 * assistant output folds no turns at all, and the ended block is then the only
 * evidence the run happened. An `end`-driven swap would blank it.
 */
export function composeTurnList(turns: SessionTurn[], live: RunStreamState | null): TurnListItem[] {
  const items: TurnListItem[] = turns.map((turn) => ({ kind: "turn", turn }));
  // `runId === null` is the idle stream — nothing is being tailed.
  if (live === null || live.runId === null) return items;
  if (turns.some((turn) => turn.run === live.runId)) return items;
  items.push({ kind: "stream", stream: live });
  return items;
}

/**
 * The run in flight: its text as it arrives, and a compact ticker of the tools
 * it is calling — name and target, never a transcript of their arguments.
 *
 * Transient by design. This block is what the folded sidecar turns replace, so
 * it is styled as a live edge (a rule down the side) rather than as a turn.
 */
function StreamedRunBlock({ stream }: { stream: RunStreamState }) {
  const text = runStreamText(stream);
  return (
    <div className="mb-2 border-l-2 border-term-cyan/50 pl-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-bold tracking-wide text-term-cyan uppercase">agent</span>
        <span
          className={cx(
            "text-[10px]",
            stream.status === "failed" ? "text-term-amber" : "text-term-dim",
          )}
        >
          {stream.status === "ended" && stream.outcome
            ? stream.outcome
            : RUN_STREAM_LABEL[stream.status]}
        </span>
      </div>
      {stream.tools.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] leading-snug text-term-dim">
          {stream.tools.map((tool) => (
            <span key={tool.id}>
              <span className="text-term-amber">{tool.name}</span>
              {tool.target && <span className="ml-1">{truncate(tool.target, 40)}</span>}
            </span>
          ))}
        </div>
      )}
      {text === "" ? (
        <div className="text-[11px] text-term-dim">waiting for the first token…</div>
      ) : (
        <div className="break-words text-[12px] whitespace-pre-wrap text-term-fg">{text}</div>
      )}
      {/* The log is not the whole stream — a hole, not an ending. Only ever
          knowable at settle, which is why it rides the end frame. */}
      {stream.truncated && (
        <div className="text-[11px] text-term-amber">
          run log truncated — some of this run's output is missing
        </div>
      )}
    </div>
  );
}

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
