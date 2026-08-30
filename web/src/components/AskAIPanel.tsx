/**
 * Ask AI — the project's single document chat, split-panel.
 *
 * The stateless ask surface has NO thread record: every send is one turn of a
 * headless run (`POST /api/p/:slug/ask`, 202), the reply arrives on that run's
 * event-log stream, and continuation is the runtime-native session id a settled
 * run harvests. The client owns the conversation — ONE per runner, kept in
 * localStorage (ask-store) with the `/api/runners` picker choosing which
 * thread to talk to. A dispatched job is WATCHED rather than merely awaited:
 * the 202 names the run, and the panel tails its log over its own SSE channel
 * (`useRunStream`), rendering assistant text as it arrives plus a compact tool
 * ticker. On the `end` frame the reply lands in the local transcript and the
 * continuation id (or a CONTINUATION_LOST re-seed) is written back to the
 * store.
 *
 * The INTENT control is a remnant of the sessions era — the ask body schema is
 * explicit (`{runner, message, refs, history, continueSessionId}`) and carries
 * no intent. It stays rendered until the visual rework (next wave) replaces it
 * with the runner picker; it is deliberately NOT sent.
 */

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
import type { RunnerId, SessionReference } from "../api/client";
import { useRunners, useSendAskTurn } from "../api/hooks";
import { type RunStreamState, runStreamText, useRunStream } from "../api/sse";
import {
  type AskStoredTurn,
  appendTurn,
  newTurnId,
  setContinueSessionId,
  useLocalTranscript,
  useSelectedRunner,
} from "../lib/ask-store";
import { cx, truncate } from "../lib/format";
import { resolveReference } from "../lib/reference-resolver.js";
import { Badge } from "./Badge";
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

/** The option values the legacy intent <select> may emit. TODO(panel wave):
 *  this select is being replaced by the runner picker — the ask body schema
 *  carries no intent, so these values are UI-only and never sent. */
const RUN_INTENT_VALUES = ["ask", "change"] as const;
type RunIntent = (typeof RUN_INTENT_VALUES)[number];

const isRunIntent = (value: string): value is RunIntent =>
  (RUN_INTENT_VALUES as readonly string[]).includes(value);

/** The run the panel is currently tailing. `runner` is the runner that sent
 *  it, captured at dispatch so the reply lands in the RIGHT local conversation
 *  even if the picker moves mid-run. */
interface WatchedRun {
  runId: string;
  runner: RunnerId;
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
  failed: "stream unavailable — the reply still lands in the transcript",
};

export function AskAIPanel() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { pendingRef, openWithRef, clearRef, close } = useAskAIPanel();
  const { push } = useToaster();
  // The drivable runtime surface — the picker's data (the select it feeds is
  // the panel wave's job; the localStorage selection defaults to "pi" until
  // then).
  const runnersQuery = useRunners();
  const runner = useSelectedRunner(runnersQuery.data?.runners.map((r) => r.id));
  const runnerLabel = runnersQuery.data?.runners.find((r) => r.id === runner)?.label ?? runner;
  const sendTurn = useSendAskTurn(slug, runner);
  const [message, setMessage] = useState("");
  // Intent describes what a turn may do, and is UI-ONLY since the ask body
  // schema carries no intent (see the TODO on RUN_INTENT_VALUES). The state
  // stays so the legacy <select> keeps rendering until the panel wave.
  const [intent, setIntent] = useState<RunIntent>("ask");
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

  const text = message.trim();
  const tooLong = text.length > MAX_LENGTH;
  const runPending = sendTurn.isPending;
  const disabled = !text || tooLong || runPending;

  const sendLabel = runPending ? "job running…" : "run";

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
    runtimeSessionId,
    errorCode,
  } = runStream;
  useEffect(() => {
    if (runStatus !== "ended" || runStreamRunId === null || watchedRun === null) return;
    const finalText = runText + runPartial;
    if (
      endPersistedRef.current.runId === runStreamRunId &&
      endPersistedRef.current.text === finalText
    ) {
      return;
    }
    endPersistedRef.current = { runId: runStreamRunId, text: finalText };
    if (finalText !== "") {
      appendTurn(slug, watchedRun.runner, {
        id: newTurnId(),
        role: "assistant",
        text: finalText,
        ts: new Date().toISOString(),
        run: runStreamRunId,
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
  }, [
    runStatus,
    runStreamRunId,
    runText,
    runPartial,
    runtimeSessionId,
    errorCode,
    watchedRun,
    slug,
  ]);

  const submit = () => {
    if (disabled) return;

    // Accepted as HTTP 202; the turn runs out-of-band and the reply lands in
    // the local conversation when the stream ends.
    sendTurn.mutate(
      {
        message: text,
        // References ride the turn: the server renders them into the prompt.
        ...(pendingRef && { refs: [pendingRef] }),
      },
      {
        onSuccess: (result) => {
          // Watch the run the 202 named — the stream the server built
          // `streamUrl` from, and the same id the reply persists under.
          setWatchedRun({ runId: result.runId, runner, startedAt: Date.now() });
          push("success", "turn accepted — the reply appears in the transcript when it finishes");
          setMessage("");
          if (pendingRef) clearRef(); // the reference was consumed by this turn
        },
        onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
      },
    );
  };

  return (
    <aside
      aria-label="ask ai panel"
      className="hidden w-96 shrink-0 flex-col border-l border-term-border bg-term-panel lg:flex"
    >
      {/* title bar */}
      <header className="flex items-center gap-2 border-b border-term-border px-2 py-1">
        <span className="text-term-green">▸</span>
        <h2 className="text-[12px] font-bold tracking-wide text-term-fg uppercase">ask ai</h2>
        <Badge color="purple">{runnerLabel}</Badge>
        <span className="flex-1" />
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
              <PendingReferencePreview reference={pendingRef} />
            </div>
          </div>
        )}

        {/* TODO(panel wave): this intent control is the sessions-era remnant the
              visual rework replaces with the RUNNER picker. It renders for now
              but its value is NOT in the send payload — the ask body schema is
              explicit ({runner, message, refs, history, continueSessionId}). */}
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
          <label htmlFor="run-intent" className="text-[10px] tracking-wide text-term-dim uppercase">
            intent
          </label>
          <select
            id="run-intent"
            value={intent}
            onChange={(e) => setIntent(isRunIntent(e.target.value) ? e.target.value : "ask")}
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
        </div>

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={runPending}
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

      {/* transcript — the local per-runner conversation, never a server mirror */}
      <section className="flex min-h-0 flex-1 flex-col" aria-label="local transcript">
        <header className="flex items-center gap-2 border-b border-term-border px-2 py-1">
          <h3 className="text-[10px] font-bold tracking-wide text-term-dim uppercase">
            transcript
          </h3>
          <span className="flex-1" />
          <span className="text-[10px] text-term-dim">{runnerLabel}</span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {turnItems.length === 0 ? (
            <div className="text-[11px] text-term-dim">
              no turns yet — ask something and the reply appears here
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
                />
              ) : (
                <TurnRow key={item.turn.id} turn={item.turn} slug={slug} />
              ),
            )
          )}
        </div>
      </section>
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
 * The run in flight: its text as it arrives, and a compact ticker of the tools
 * it is calling — name and target, never a transcript of their arguments.
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
function StreamedRunBlock({ stream, startedAt }: { stream: RunStreamState; startedAt: number }) {
  const text = runStreamText(stream);
  const elapsed = useElapsed(stream.status === "ended" ? null : startedAt);
  const quietHead = stream.status === "open" && text === "" && stream.tools.length === 0;
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
            ? `${stream.outcome} · ${elapsed}s`
            : RUN_STREAM_LABEL[stream.status]}
        </span>
        {stream.status !== "ended" && (
          <span className="text-[10px] tabular-nums text-term-dim">{elapsed}s</span>
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

function TurnRow({ turn, slug }: { turn: AskStoredTurn; slug: string }) {
  if (turn.ref) return <ReferenceCard turn={turn} slug={slug} />;
  const speaker = turn.role === "user" ? "you" : turn.role === "assistant" ? "agent" : turn.role;
  return (
    <div className="mb-2">
      <div className="flex items-baseline gap-2">
        <span
          className={cx(
            "text-[10px] font-bold tracking-wide uppercase",
            turn.role === "user" ? "text-term-green" : "text-term-cyan",
          )}
        >
          {speaker}
        </span>
        <span className="text-[10px] text-term-dim">{turn.ts}</span>
      </div>
      {turn.role === "tool" ? (
        <div className="text-[11px] text-term-dim">[tool: {turn.text}]</div>
      ) : (
        <div
          className={cx(
            "break-words text-[12px] whitespace-pre-wrap",
            turn.role === "error" ? "text-term-amber" : "text-term-fg",
          )}
        >
          {turn.text}
        </div>
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
