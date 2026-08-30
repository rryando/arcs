/**
 * Ask AI — the project's single document chat, split-panel.
 *
 * The stateless ask surface has NO thread record: every send is one turn of a
 * headless run (`POST /api/p/:slug/ask`, 202), the reply arrives on that run's
 * event-log stream, and continuation is the runtime-native session id a settled
 * run harvests. The client owns the conversation — ONE per runner, kept in
 * localStorage (ask-store) with the header's `/api/runners` picker choosing
 * which thread to talk to. A dispatched job is WATCHED rather than merely
 * awaited: the 202 names the run, and the panel tails its log over its own SSE
 * channel (`useRunStream`), rendering assistant text as markdown as it arrives
 * plus a compact tool ticker. On the `end` frame the reply lands in the local
 * transcript and the continuation id (or a CONTINUATION_LOST re-seed) is
 * written back to the store; a settled run's workspace changes surface as a
 * per-run diff-review card on that turn (keep / revert).
 *
 * Layout, top to bottom: title bar with the runner select → workspace files →
 * the per-runner transcript (scrollable, newest at the bottom) → the composer,
 * pinned at the bottom. The send body is exactly
 * `{runner, message, refs, history, continueSessionId}` — the allow-all
 * design carries no mode/scope control, so there is none anywhere in the panel.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, type RunChange, type RunnerId, type SessionReference } from "../api/client";
import { useRunners, useSendAskTurn } from "../api/hooks";
import { type RunStreamState, runStreamText, useRunStream } from "../api/sse";
import {
  type AskStoredTurn,
  appendTurn,
  clearConversation,
  exportConversation,
  newTurnId,
  setContinueSessionId,
  setSelectedRunner,
  setTurnReviewState,
  useLocalTranscript,
  useSelectedRunner,
} from "../lib/ask-store";
import { cx, truncate } from "../lib/format";
import { resolveReference } from "../lib/reference-resolver.js";
import { Badge, type BadgeColor } from "./Badge";
import { ChatMarkdown } from "./ChatMarkdown";
import { inputClass } from "./Dialog";
import { useToaster } from "./Toaster";
import { WorkspaceFileViewer } from "./WorkspaceFileViewer";

/** Past this the message is flagged as risky to deliver, but still sendable. */
export const WARN_LENGTH = 4000;
/** Past this sending is blocked — no runtime takes a prompt this big usefully. */
export const MAX_LENGTH = 20000;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface AskAIPanelContextValue {
  /** Panel open/closed — the shell toggle drives this. */
  open: boolean;
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
  /** Open the panel (no target to pick — there is exactly one thread). */
  openPanel: () => void;
  close: () => void;
  /** Shell-level toggle — opens without selecting, closes when open. */
  toggle: () => void;
  /** Drop a consumed reference (after a successful send with a reference). */
  clearRef: () => void;
}

const AskAIPanelContext = createContext<AskAIPanelContextValue | null>(null);

export function AskAIPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pendingRef, setPendingRef] = useState<SessionReference | null>(null);

  const value = useMemo<AskAIPanelContextValue>(
    () => ({
      open,
      pendingRef,
      openWithRef: (ref) => {
        setPendingRef(ref);
        setOpen(true);
      },
      openPanel: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen((v) => !v),
      clearRef: () => setPendingRef(null),
    }),
    [open, pendingRef],
  );

  return <AskAIPanelContext.Provider value={value}>{children}</AskAIPanelContext.Provider>;
}

export function useAskAIPanel(): AskAIPanelContextValue {
  const ctx = useContext(AskAIPanelContext);
  if (!ctx) throw new Error("useAskAIPanel must be used inside AskAIPanelProvider");
  return ctx;
}
// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/** The drivable runner surface, in the order the picker presents it (the id
 *  strings ARE the transport ids, not display text — display labels come from
 *  `/api/runners`). */
const RUNNER_ORDER: readonly RunnerId[] = ["pi", "opencode", "claude-code", "codex"];

/** Small per-runner accent for the header badge. */
const RUNNER_COLORS: Record<RunnerId, BadgeColor> = {
  pi: "green",
  opencode: "amber",
  "claude-code": "magenta",
  codex: "cyan",
};

/** How long a review card keeps polling the changes route after a run's `end`
 *  frame. The settle stamps the run settled a beat before the diff sidecar
 *  lands, so the first read can be legitimately empty — the write-back gets
 *  this window before the empty answer is taken as "nothing changed". */
const CHANGES_POLL_WINDOW_MS = 20_000;
const CHANGES_POLL_INTERVAL_MS = 2_000;

/** The run the panel is currently tailing. `runner` is the runner that sent
 *  it, captured at dispatch so the reply lands in the RIGHT local conversation
 *  even if the picker moves mid-run. `cancelled` marks a user stop: the
 *  DELETE that settled the run `interrupted` — the end frame records a
 *  cancellation note instead of a normal reply. */
interface WatchedRun {
  runId: string;
  runner: RunnerId;
  cancelled?: boolean;
}

/**
 * Seconds since `startedAt`, re-rendered once a second — the visible answer to
 * "is it stuck or is the runtime just booting". One-shot runs have a long
 * silent head (~10s CLI boot + model connect before the first NDJSON line), so
 * the clock is the only honest signal during it. `null` = no run being watched.
 */
function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  const live = startedAt !== null;
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** What the streamed block's header says, per phase — including WHY nothing
 *  has appeared yet. `ended` carries the outcome instead, so it has no fixed
 *  label here. */
const RUN_STREAM_LABEL: Record<RunStreamState["status"], string> = {
  idle: "",
  connecting: "starting…",
  open: "",
  ended: "done",
  failed: "stream unavailable",
};

export function AskAIPanel() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { pendingRef, openWithRef, clearRef, close } = useAskAIPanel();
  const { push } = useToaster();
  const runnersQuery = useRunners();
  const runner = useSelectedRunner(runnersQuery.data?.runners.map((r) => r.id));
  const runnerLabel = runnersQuery.data?.runners.find((r) => r.id === runner)?.label ?? runner;
  const sendTurn = useSendAskTurn(slug, runner);
  const [message, setMessage] = useState("");
  /** When the watched run was dispatched — the elapsed clock's zero. */
  const [watchedRun, setWatchedRun] = useState<(WatchedRun & { startedAt: number }) | null>(null);

  // The conversation shown is the WATCHED run's runner while one is in flight
  // (its user turn lives there); otherwise the currently selected one.
  const transcriptRunner = watchedRun?.runner ?? runner;
  const turns = useLocalTranscript(slug, transcriptRunner);

  // Tails the accepted run on its run-keyed stream — there is no session to
  // key on; the run id is the whole address.
  const runStream = useRunStream(slug, watchedRun?.runId ?? null);
  const turnItems = useMemo(() => composeTurnList(turns, runStream), [turns, runStream]);

  // Auto-scroll: the transcript follows its newest content while the reader is
  // at (or near) the bottom — a run being tailed scrolls as its streamed block
  // grows, but reading an earlier exchange is never yanked downward. The
  // initial stick state is "at the bottom", so opening the panel lands on the
  // newest turn. Keyed on the newest item's identity so each change scrolls
  // exactly once.
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const lastScrolledRef = useRef<string>("");
  const onTranscriptScroll = () => {
    const el = transcriptRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el || !stickToBottomRef.current) return;
    const last = turnItems[turnItems.length - 1];
    const key = last
      ? last.kind === "turn"
        ? `turn:${last.turn.id}`
        : `stream:${runStreamText(last.stream).length}:${last.stream.tools.length}:${last.stream.status}`
      : "";
    if (key === lastScrolledRef.current) return;
    lastScrolledRef.current = key;
    el.scrollTop = el.scrollHeight;
  }, [turnItems]);

  const text = message.trim();
  const tooLong = text.length > MAX_LENGTH;
  const runLive = sendTurn.isPending || watchedRun !== null;
  const disabled = !text || tooLong || runLive;

  const sendLabel = sendTurn.isPending ? "job running…" : "run";

  // Runner picker options — the server's list, in the fixed presentation
  // order; while the query loads, all four ids render as selectable.
  const runnerOptions = useMemo(() => {
    const known = runnersQuery.data?.runners;
    return RUNNER_ORDER.filter(
      (id) => known === undefined || known.some((info) => info.id === id),
    ).map((id) => {
      const info = known?.find((info) => info.id === id);
      return {
        id,
        label: info?.label ?? id,
        available: info?.available ?? true,
      };
    });
  }, [runnersQuery.data]);

  /** One send — the shared path for the composer submit and an error row's
   *  retry (which re-sends the same message, reference included). On success
   *  the run the 202 named becomes the watched run; on failure an `error` row
   *  is appended to the local transcript so the message survives and can be
   *  retried. `clearComposer` (submit only) also consumes the pending ref. */
  const sendNow = (
    messageText: string,
    ref: SessionReference | undefined,
    clearComposer: boolean,
  ) => {
    sendTurn.mutate(
      { message: messageText, ...(ref !== undefined && { refs: [ref] }) },
      {
        onSuccess: (result) => {
          // Watch the run the 202 named — the stream the server built
          // `streamUrl` from, and the same id the reply persists under.
          setWatchedRun({ runId: result.runId, runner, startedAt: Date.now() });
          push("success", "turn accepted — the reply appears in the transcript when it finishes");
          if (clearComposer) {
            setMessage("");
            if (pendingRef) clearRef(); // the reference was consumed by this turn
          }
        },
        onError: (err) => {
          appendTurn(slug, runner, {
            id: newTurnId(),
            role: "error",
            text: messageText,
            ts: new Date().toISOString(),
          });
          push("error", err instanceof Error ? err.message : String(err));
        },
      },
    );
  };

  const submit = () => {
    if (disabled) return;
    sendNow(text, pendingRef ?? undefined, true);
  };

  const retryTurn = (turn: AskStoredTurn) => {
    if (runLive) return;
    sendNow(turn.text, turn.ref, false);
  };

  /** Stop the watched run: DELETE settles it `interrupted`. Only a SUCCESSFUL
   *  cancel is recorded as one — a 404 means the run already settled on its
   *  own, and its end frame then speaks the truth (a completed run is never
   *  mislabelled a cancellation). */
  const cancelRun = () => {
    const running = watchedRun;
    if (!running) return;
    const runId = running.runId;
    void api
      .cancelRun(slug, runId)
      .then(() => {
        // The DELETE settled the run "interrupted" — make sure the end frame
        // (if it lands before this resolves) is read as a cancellation.
        setWatchedRun((prev) =>
          prev && prev.runId === runId ? { ...prev, cancelled: true } : prev,
        );
      })
      .catch(() => {
        // 404 RUN_NOT_FOUND — the run was already settled by its own
        // write-back or an earlier stop; there is nothing to cancel.
      });
  };

  // Settle handling: the reply lands in the local transcript, and the end
  // frame's continuation handle (or its CONTINUATION_LOST re-seed signal) is
  // written back to the store. Guarded by a ref so StrictMode's double effect
  // and subsequent re-renders never persist the same run twice.
  const endPersistedRef = useRef<{ runId: string | null; text: string | null }>({
    runId: null,
    text: null,
  });
  const {
    status: runStatus,
    runId: runStreamRunId,
    text: runText,
    partial: runPartial,
    tools: runTools,
    runtimeSessionId,
    errorCode,
  } = runStream;
  useEffect(() => {
    if (runStreamRunId === null || watchedRun === null) return;
    const finalText = runText + runPartial;
    const alreadyPersisted =
      endPersistedRef.current.runId === runStreamRunId &&
      endPersistedRef.current.text === finalText;

    // The route refused (404 — the run was pruned or never existed): nothing
    // will ever settle, so close the loop locally and free the watch.
    if (runStatus === "failed") {
      if (alreadyPersisted) return;
      endPersistedRef.current = { runId: runStreamRunId, text: finalText };
      appendTurn(slug, watchedRun.runner, {
        id: newTurnId(),
        role: "error",
        text: "the run's stream became unavailable — its reply never landed",
        ts: new Date().toISOString(),
      });
      setWatchedRun(null);
      return;
    }

    if (runStatus !== "ended" || alreadyPersisted) return;
    endPersistedRef.current = { runId: runStreamRunId, text: finalText };

    if (watchedRun.cancelled) {
      appendTurn(slug, watchedRun.runner, {
        id: newTurnId(),
        role: "error",
        text: "run cancelled — stopped before it finished",
        ts: new Date().toISOString(),
      });
      setWatchedRun(null);
      return;
    }

    // A settled run persists as the assistant turn that replaces the live
    // block. Even a TEXT-LESS run persists when it called tools: it may have
    // changed the workspace, and the diff-review card lives on this turn.
    if (finalText !== "" || runTools.length > 0) {
      appendTurn(slug, watchedRun.runner, {
        id: newTurnId(),
        role: "assistant",
        text: finalText,
        ts: new Date().toISOString(),
        run: runStreamRunId,
        reviewState: "pending",
      });
    }
    if (runtimeSessionId !== undefined) {
      setContinueSessionId(slug, watchedRun.runner, runtimeSessionId);
    }
    if (errorCode === "CONTINUATION_LOST") {
      // The stored id is dead — clear it so the next send re-seeds (its full
      // local transcript still travels as `history`).
      setContinueSessionId(slug, watchedRun.runner, null);
    }
    // The watch's job is done — the transcript shows the SELECTED runner's
    // conversation again and the composer re-enables.
    setWatchedRun(null);
  }, [
    runStatus,
    runStreamRunId,
    runText,
    runPartial,
    runTools,
    runtimeSessionId,
    errorCode,
    watchedRun,
    slug,
  ]);

  /** Clear the CURRENT (displayed) conversation. The confirm is the only
   *  guard — localStorage has no undo. */
  const clearTranscript = () => {
    const hasTurns = turnItems.some((item) => item.kind === "turn");
    if (hasTurns && !window.confirm("clear this conversation? this cannot be undone")) return;
    clearConversation(slug, transcriptRunner);
  };

  /** Export the CURRENT (displayed) conversation as a markdown download. */
  const exportTranscript = () => {
    const markdown = exportConversation(slug, transcriptRunner);
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ask-ai-${slug}-${transcriptRunner}.md`;
    link.click();
    URL.revokeObjectURL(url);
    push("success", "transcript exported as markdown");
  };

  return (
    <aside
      aria-label="ask ai panel"
      className="hidden w-96 shrink-0 flex-col border-l border-term-border bg-term-panel lg:flex"
    >
      {/* title bar + runner picker */}
      <header className="flex items-center gap-2 border-b border-term-border px-2 py-1">
        <span className="text-term-green">▸</span>
        <h2 className="text-[12px] font-bold tracking-wide text-term-fg uppercase">ask ai</h2>
        <select
          value={runner}
          onChange={(e) => setSelectedRunner(e.target.value as RunnerId)}
          disabled={sendTurn.isPending}
          title="which runner this thread talks to — each runner keeps its own conversation"
          className="border border-term-border bg-term-inset px-1 py-0.5 text-[11px] text-term-fg outline-none focus:border-term-green/60 disabled:opacity-50"
        >
          {runnerOptions.map((option) => (
            <option key={option.id} value={option.id} disabled={!option.available}>
              {option.label}
              {option.available ? "" : " (not installed)"}
            </option>
          ))}
        </select>
        <span className="flex-1" />
        <Badge color={RUNNER_COLORS[runner]}>{runnerLabel}</Badge>
        <button
          type="button"
          title="close ask ai panel"
          onClick={close}
          className="text-term-dim hover:text-term-red"
        >
          ✕
        </button>
      </header>

      {/* workspace files — the "point at a file and ask about it" surface. Its
          line-range selection lands in `pendingRef` through `openWithRef`, the
          same slot the ✉ doc flow fills, so the composer below sends it with no
          per-variant branch of its own. */}
      <WorkspaceFileViewer slug={slug} onAttach={openWithRef} />

      {/* transcript — the local per-runner conversation, never a server mirror.
          flex-1 so the composer below pins to the panel's bottom edge. */}
      <section className="flex min-h-0 flex-1 flex-col" aria-label="local transcript">
        <header className="flex items-center gap-2 border-b border-term-border px-2 py-1">
          <h3 className="text-[10px] font-bold tracking-wide text-term-dim uppercase">
            transcript
          </h3>
          <span className="flex-1" />
          <span className="text-[10px] text-term-dim">{runnerLabel}</span>
          <button
            type="button"
            onClick={exportTranscript}
            title="download this conversation as markdown"
            className="text-[10px] text-term-dim hover:text-term-green"
          >
            export
          </button>
          <button
            type="button"
            onClick={clearTranscript}
            title="clear this conversation (cannot be undone)"
            className="text-[10px] text-term-dim hover:text-term-red"
          >
            clear
          </button>
        </header>
        <div
          ref={transcriptRef}
          onScroll={onTranscriptScroll}
          className="min-h-0 flex-1 overflow-y-auto p-2"
        >
          {turnItems.length === 0 ? (
            <div className="text-[11px] text-term-dim">
              no turns yet for {runnerLabel} — ask something and the reply appears here
            </div>
          ) : (
            // ONE list, from ONE composition — the live block and the persisted
            // turns of a run are never both in it (see `composeTurnList`).
            turnItems.map((item) =>
              item.kind === "stream" ? (
                <StreamedRunBlock
                  key="run-stream"
                  stream={item.stream}
                  startedAt={watchedRun?.startedAt ?? Date.now()}
                  onStop={cancelRun}
                />
              ) : (
                <TurnRow
                  key={item.turn.id}
                  turn={item.turn}
                  slug={slug}
                  runner={transcriptRunner}
                  onRetry={retryTurn}
                  retryDisabled={runLive}
                />
              ),
            )
          )}
        </div>
      </section>

      {/* composer + pending reference — pinned at the bottom */}
      <div className="border-t border-term-border p-2">
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

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={sendTurn.isPending}
          placeholder="ask about these documents…"
          rows={3}
          className={cx(inputClass, "resize-y leading-snug disabled:opacity-50")}
        />

        {text.length > WARN_LENGTH && (
          <div className="mt-1 text-[11px] text-term-amber">
            {text.length} characters —{" "}
            {tooLong
              ? `over the ${MAX_LENGTH} character ceiling for one message; trim it before sending`
              : "large messages may be slow to deliver or truncated by the runtime"}
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
          <span className="text-[10px] text-term-dim">
            <span className="kbd">ctrl</span>+<span className="kbd">enter</span> send
          </span>
        </div>
      </div>
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

/** One entry of the panel's turn list: a stored local turn, or THE live
 *  streamed block. */
export type TurnListItem =
  | { kind: "turn"; turn: AskStoredTurn }
  | { kind: "stream"; stream: RunStreamState };

/**
 * The turn list the panel renders, composed once from the two sources that can
 * describe the same run.
 *
 * INVARIANT — the streamed block and the stored turns of the same run are never
 * both in the returned list. A run reaches the panel twice: live, line by line
 * off its event log, and again as the assistant turn the end frame's settle
 * persists into the local conversation. Showing both is the duplicated-text
 * flash; showing neither is text that vanishes.
 *
 * It holds by CONSTRUCTION rather than by timing. The persisted assistant turn
 * carries the run id (`AskStoredTurn.run`), so "this run is in the
 * conversation" is a fact read off the same turn array being rendered — not a
 * timer, not an `ended` flag on the stream, and not a second piece of state
 * that could disagree with the list. The block is therefore dropped in the
 * very commit its stored turn appears in, and kept in every commit before it:
 * the two are mutually exclusive branches of one expression over one input.
 *
 * Deliberately NOT keyed on the stream's status: a run that settles with no
 * assistant output persists no turn at all, and the ended block is then the
 * only evidence the run happened. An `end`-driven swap would blank it.
 */
export function composeTurnList(
  turns: AskStoredTurn[],
  live: RunStreamState | null,
): TurnListItem[] {
  const items: TurnListItem[] = turns.map((turn) => ({ kind: "turn", turn }));
  // `runId === null` is the idle stream — nothing is being tailed.
  if (live === null || live.runId === null) return items;
  if (turns.some((turn) => turn.run === live.runId)) return items;
  items.push({ kind: "stream", stream: live });
  return items;
}

/**
 * The run in flight: its markdown reply as it arrives, and a compact ticker of
 * the tools it is calling — name and target, never a transcript of their
 * arguments. While tailing (connecting/open) a stop button sits beside the
 * header.
 *
 * The header carries a phase + a live elapsed clock, because a one-shot run's
 * first ~10s are structurally silent (CLI boot + model connect emit nothing)
 * and an unexplained blank reads as a hang. Phases, from the stream alone:
 *   connecting            → "starting…"        (SSE not open yet)
 *   open, no text/tools   → "waiting for the model's first token…"
 *   open, tools ticking   → "working"           (tools ARE the progress)
 *   ended                 → outcome + total time
 *
 * Transient by design. This block is what the persisted assistant turn
 * replaces, so it is styled as a live edge (a rule down the side) rather than
 * as a turn.
 */
function StreamedRunBlock({
  stream,
  startedAt,
  onStop,
}: {
  stream: RunStreamState;
  startedAt: number;
  onStop: () => void;
}) {
  const text = runStreamText(stream);
  const elapsed = useElapsed(stream.status === "ended" ? null : startedAt);
  const quietHead = stream.status === "open" && text === "" && stream.tools.length === 0;
  const stoppable = stream.status === "connecting" || stream.status === "open";
  return (
    <div className="mb-2 border-l-2 border-term-cyan/50 pl-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold tracking-wide text-term-cyan uppercase">agent</span>
        <span
          className={cx(
            "text-[10px]",
            stream.status === "failed" ? "text-term-amber" : "text-term-dim",
          )}
        >
          {stream.status === "ended" && stream.outcome
            ? `${stream.outcome} · ${elapsed}s`
            : RUN_STREAM_LABEL[stream.status]}
        </span>
        {stream.status !== "ended" && (
          <span className="text-[10px] tabular-nums text-term-dim">{elapsed}s</span>
        )}
        <span className="flex-1" />
        {stoppable && (
          <button
            type="button"
            onClick={onStop}
            title="stop this run"
            className="text-[12px] leading-none text-term-dim hover:text-term-red"
          >
            ■
          </button>
        )}
      </div>
      {quietHead && (
        <div className="mt-0.5 text-[11px] text-term-dim">
          the runtime is booting and connecting to the model — the first token usually lands after
          ~10s; tool activity appears here the moment it starts
        </div>
      )}
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
      {text !== "" && (
        <div className="mt-1">
          <ChatMarkdown content={text} />
        </div>
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

/** Canned error rows the panel writes itself (a cancellation, a lost stream).
 *  A retry never re-sends these — only a user message that FAILED to send is
 *  retryable. */
const NON_RETRY_ERROR_TEXT = new Set([
  "run cancelled — stopped before it finished",
  "the run's stream became unavailable — its reply never landed",
]);

function TurnRow({
  turn,
  slug,
  runner,
  onRetry,
  retryDisabled,
}: {
  turn: AskStoredTurn;
  slug: string;
  /** The conversation the turn lives in — review-state writes go here. */
  runner: RunnerId;
  onRetry: (turn: AskStoredTurn) => void;
  retryDisabled: boolean;
}) {
  if (turn.ref) return <ReferenceCard turn={turn} slug={slug} />;
  const speaker = turn.role === "user" ? "you" : turn.role === "assistant" ? "agent" : turn.role;
  const retryable = turn.role === "error" && !NON_RETRY_ERROR_TEXT.has(turn.text);
  return (
    <div className="mb-2">
      <div className="flex items-baseline gap-2">
        <span
          className={cx(
            "text-[10px] font-bold tracking-wide uppercase",
            turn.role === "user"
              ? "text-term-green"
              : turn.role === "error"
                ? "text-term-red"
                : "text-term-cyan",
          )}
        >
          {speaker}
        </span>
        <span className="text-[10px] text-term-dim">{turn.ts}</span>
        {retryable && <span className="text-[10px] text-term-red">send failed</span>}
      </div>
      {turn.role === "tool" ? (
        <div className="text-[11px] text-term-dim">[tool: {turn.text}]</div>
      ) : turn.role === "assistant" ? (
        <>
          <ChatMarkdown content={turn.text} />
          {turn.run !== undefined && (
            <RunReviewCard
              slug={slug}
              runner={runner}
              turnId={turn.id}
              runId={turn.run}
              reviewState={turn.reviewState ?? "pending"}
            />
          )}
        </>
      ) : turn.role === "error" ? (
        <div className="mt-0.5 flex flex-col gap-1">
          <div
            className={cx(
              "break-words whitespace-pre-wrap",
              retryable ? "text-[11px] text-term-dim" : "text-[11px] text-term-amber",
            )}
          >
            {turn.text}
          </div>
          {retryable && (
            <div>
              <button
                type="button"
                onClick={() => onRetry(turn)}
                disabled={retryDisabled}
                title="re-send this message"
                className="border border-term-amber/60 px-1.5 py-0.5 text-[10px] font-bold text-term-amber hover:bg-term-amber hover:text-term-bg disabled:opacity-50"
              >
                ↻ retry
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="break-words text-[12px] whitespace-pre-wrap text-term-fg">{turn.text}</div>
      )}
    </div>
  );
}

/** A turn that carried a reference — rendered as a compact click-through card
 *  for doc refs (they carry section + source), a plain preview for the pointer
 *  variants. */
function ReferenceCard({ turn, slug }: { turn: AskStoredTurn; slug: string }) {
  const reference = turn.ref;
  const navigate = useNavigate();
  if (!reference) return null;

  // Click-through to the quoted section's source document: resolve the
  // reference to a full navigable route, then navigate via `href` so the
  // router parses the ?doc= search and #section hash (MarkdownViewer's
  // hash-scroll effect lands on the exact heading once the target mounts).
  // Only the doc variant carries section/source; the pointer variants render
  // as previews with no navigation.
  const openSource = () => {
    if (reference.type !== "doc" && reference.type !== undefined) return;
    const { kind, doc, id } = reference.source;
    if (kind === "overview") {
      if (!doc) return;
      const target = resolveReference({ slug, kind, doc, sectionId: reference.section.id });
      navigate({ href: `${target.path}${target.hash}` });
      return;
    }
    if (!id) return;
    const target = resolveReference({ slug, kind, id, sectionId: reference.section.id });
    navigate({ href: `${target.path}${target.hash}` });
  };

  const isDoc = reference.type === "doc" || reference.type === undefined;
  // Explicit narrowing: the doc variant's tag is optional, so only the pointer
  // variants are matched by tag; everything else is the doc fall-through.
  let headline: string;
  if (reference.type === "file") {
    headline = reference.path;
  } else if (reference.type === "node") {
    headline = reference.id;
  } else {
    headline = reference.source.label;
  }

  return (
    <button
      type="button"
      onClick={openSource}
      title={isDoc ? "open the source document at this section" : "reference attached to this turn"}
      disabled={!isDoc}
      className="mb-2 block w-full cursor-pointer border border-term-cyan/40 bg-term-inset text-left hover:border-term-cyan/80 disabled:cursor-default disabled:hover:border-term-cyan/40"
    >
      <div className="flex items-center gap-2 border-b border-term-border/60 px-2 py-0.5">
        <Badge color="cyan">reference</Badge>
        <span className="truncate text-[10px] text-term-dim">{headline}</span>
        <span className="flex-1" />
        <span className="text-[10px] text-term-dim">
          {isDoc ? reference.source.kind : reference.type}
        </span>
      </div>
      <div className="px-2 py-1 text-[12px] text-term-fg">
        <PendingReferencePreview reference={reference} />
      </div>
      {isDoc && (
        <div className="border-t border-term-border/60 px-2 py-1">
          <div className="text-[10px] font-bold tracking-wide text-term-cyan uppercase">
            § {reference.section.id}
          </div>
          <div className="mt-0.5 line-clamp-3 text-[11px] leading-snug whitespace-pre-wrap text-term-dim">
            {reference.section.text}
          </div>
        </div>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Diff review — the keep/revert half of the allow-all gate
// ---------------------------------------------------------------------------

/** Per-file status badge on a change row. */
const CHANGE_STATUS_COLOR: Record<RunChange["status"], BadgeColor> = {
  added: "green",
  modified: "amber",
  deleted: "red",
};

/**
 * The review card on a settled run's assistant turn.
 *
 * Renders only when the run ACTUALLY changed files (`changes.length > 0`):
 * runs with no changes, runs still settling, and cancelled runs show no card.
 * Pending state offers keep (approve) / revert (reject); acting persists the
 * turn's `reviewState` and the card becomes read-only. On reload the card
 * re-fetches by runId — if the run's changes were pruned server-side, it
 * degrades to just the reviewState note.
 */
function RunReviewCard({
  slug,
  runner,
  turnId,
  runId,
  reviewState,
}: {
  slug: string;
  /** The conversation the turn lives in — review-state writes go here. */
  runner: RunnerId;
  turnId: string;
  runId: string;
  reviewState: "pending" | "approved" | "reverted";
}) {
  const { push } = useToaster();
  const [diffOpen, setDiffOpen] = useState<string | null>(null);
  const pending = reviewState === "pending";

  // The settle stamps the run settled BEFORE the diff sidecar lands, so a
  // single read right after `end` can be legitimately empty — poll within a
  // bounded window until something appears or the window closes.
  const [polling, setPolling] = useState(pending);
  useEffect(() => {
    if (!pending) {
      setPolling(false);
      return;
    }
    const timer = setTimeout(() => setPolling(false), CHANGES_POLL_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const changesQuery = useQuery({
    queryKey: ["askRunChanges", slug, runId],
    queryFn: () => api.runChanges(slug, runId),
    staleTime: 30_000,
    refetchInterval: polling
      ? (query) => {
          const list = query.state.data?.changes;
          return list !== undefined && list.length > 0 ? false : CHANGES_POLL_INTERVAL_MS;
        }
      : false,
  });

  const revertMutation = useMutation({
    mutationFn: () => api.revertRun(slug, runId),
    onSuccess: (result) => {
      setTurnReviewState(slug, runner, turnId, "reverted");
      push(
        "success",
        result.restored.length > 0
          ? `changes reverted — ${result.restored.length} ${
              result.restored.length === 1 ? "file" : "files"
            } restored`
          : "changes reverted",
      );
    },
    onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
  });

  /** Approve = keep: the run's changes stay in the workspace as-is. */
  const approve = () => {
    setTurnReviewState(slug, runner, turnId, "approved");
    push("success", "changes kept — the workspace stays as the run left it");
  };

  const changes = changesQuery.data?.changes ?? [];
  const hasChanges = changes.length > 0;

  if (changesQuery.isLoading && !changesQuery.data) {
    return pending ? <div className="mt-1 text-[10px] text-term-dim">loading changes…</div> : null;
  }

  if (!hasChanges) {
    // Nothing changed, or the run's sidecars were pruned — a settled review
    // degrades to its state note; an unreviewed one renders nothing.
    if (reviewState === "approved") {
      return <div className="mt-1 text-[10px] text-term-dim">changes kept</div>;
    }
    if (reviewState === "reverted") {
      return <div className="mt-1 text-[10px] text-term-dim">changes reverted</div>;
    }
    return null;
  }

  return (
    <div className="mt-1.5 border border-term-border bg-term-inset">
      <div className="flex items-center gap-2 border-b border-term-border/60 px-2 py-0.5">
        <span className="text-[10px] font-bold tracking-wide text-term-cyan uppercase">
          changes
        </span>
        <span className="flex-1" />
        {pending ? (
          <>
            <button
              type="button"
              onClick={approve}
              disabled={revertMutation.isPending}
              title="keep the run's changes in the workspace"
              className="border border-term-green/60 px-1.5 py-0.5 text-[10px] font-bold text-term-green hover:bg-term-green hover:text-term-bg disabled:opacity-50"
            >
              keep
            </button>
            <button
              type="button"
              onClick={() => revertMutation.mutate()}
              disabled={revertMutation.isPending}
              title="restore the workspace to how it was before this run"
              className="border border-term-red/60 px-1.5 py-0.5 text-[10px] font-bold text-term-red hover:bg-term-red hover:text-term-bg disabled:opacity-50"
            >
              {revertMutation.isPending ? "reverting…" : "revert"}
            </button>
          </>
        ) : (
          <Badge color={reviewState === "approved" ? "green" : "amber"}>
            {reviewState === "approved" ? "kept" : "reverted"}
          </Badge>
        )}
      </div>
      {changes.map((change) => (
        <div key={change.path} className="border-b border-term-border/40 last:border-b-0">
          <button
            type="button"
            onClick={() => setDiffOpen((current) => (current === change.path ? null : change.path))}
            title={
              change.diff ? "toggle this file's diff" : "no diff preview is available for this file"
            }
            className="flex w-full items-center gap-2 px-2 py-0.5 text-left hover:bg-term-panel"
          >
            <span className="w-3 text-[10px] text-term-dim">
              {diffOpen === change.path ? "▾" : "▸"}
            </span>
            <Badge color={CHANGE_STATUS_COLOR[change.status]}>{change.status}</Badge>
            <span className="min-w-0 flex-1 truncate text-[11px] text-term-fg" title={change.path}>
              {change.path}
            </span>
            <span className="text-[10px] tabular-nums text-term-dim">
              <span className="text-term-green">+{change.linesAdded}</span>
              <span className="text-term-red"> -{change.linesRemoved}</span>
            </span>
          </button>
          {diffOpen === change.path &&
            (change.diff ? (
              <pre className="overflow-x-auto border-t border-term-border/40 bg-term-panel p-2 text-[10px] leading-snug whitespace-pre-wrap text-term-dim">
                {change.diff}
              </pre>
            ) : (
              <div className="border-t border-term-border/40 px-2 py-1 text-[10px] text-term-dim">
                {change.capped
                  ? "diff too large to preview — the change was applied"
                  : "no diff preview available"}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
