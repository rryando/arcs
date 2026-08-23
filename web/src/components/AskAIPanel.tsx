/**
 * Ask AI — the project's single document chat, split-panel.
 *
 * One pane over the transcript GET + headless turn POST, with NO thread
 * boundaries: every send dispatches a one-shot turn via `POST /sessions/ask/
 * turns`, and the server's virtual `ask` id resolves-or-mints the one implicit
 * ARCS-owned thread per project. There is nothing to pick or create — the
 * panel is always ready; the first message brings the thread into existence.
 * INTENT is the only control — what the turn is allowed to do (`ask` inspects,
 * `change` edits). Turns are asynchronous by contract — the panel says the
 * reply appears when the run finishes, never "sent".
 *
 * A dispatched job is WATCHED rather than merely awaited: the 202 names the
 * run (and its real write target), and the panel tails that run's event log
 * over its own SSE channel (`useRunStream`), rendering assistant text as it
 * arrives plus a compact tool ticker. The live block and the run's folded
 * sidecar turns are the same content reaching the panel by two routes, so the
 * turn list is composed once (`composeTurnList`) and holds exactly one of them.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { RunIntent, SessionReference, SessionTurn } from "../api/client";
import { useSendAskTurn, useSessionTranscript } from "../api/hooks";
import { type RunStreamState, runStreamText, useRunStream } from "../api/sse";
import { cx, relativeTime, truncate } from "../lib/format";
import { resolveReference } from "../lib/reference-resolver.js";
import { Badge } from "./Badge";
import { inputClass } from "./Dialog";
import { MAX_LENGTH, WARN_LENGTH } from "./SessionMessageForm";
import { useToaster } from "./Toaster";
import { WorkspaceFileViewer } from "./WorkspaceFileViewer";

/** The server's virtual id for the implicit per-project Ask-AI thread. */
const ASK_THREAD_ALIAS = "ask";

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

/** The option values the intent <select> may emit — exactly `RunIntent`, which
 *  mirrors the server's `RUN_INTENTS` enum. An unknown value falls back to the
 *  read-only `ask` rather than being cast through to the API: the server's zod
 *  enum would 400 it, and failing closed is the right direction for a control
 *  whose only job is to widen what a run may touch. */
const RUN_INTENT_VALUES: readonly RunIntent[] = ["ask", "change"];

const isRunIntent = (value: string): value is RunIntent =>
  (RUN_INTENT_VALUES as readonly string[]).includes(value);

/** A mirror older than this is called out — checkpoints are frequent, so a long
 *  gap usually means the thread moved on (or the run died) without one. */
const MIRROR_STALE_MS = 10 * 60_000;

/** The run the panel is currently tailing. `sessionId` is the run's WRITE
 *  TARGET — the record the log is keyed on and the reply lands in: the implicit
 *  Ask-AI thread's real id, resolved server-side from the `ask` alias. */
interface WatchedRun {
  sessionId: string;
  runId: string;
}

/**
 * Seconds since `startedAt`, re-rendered once a second — the visible answer to
 * "is it stuck or is opencode just booting". One-shot runs have a long silent
 * head (~10s CLI boot + model connect before the first NDJSON line), so the
 * clock is the only honest signal during it. `null` = no run being watched.
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
  connecting: "starting opencode…",
  open: "",
  ended: "done",
  failed: "stream unavailable — the reply still lands in the transcript",
};

export function AskAIPanel() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { open, pendingRef, openWithRef, clearRef, close } = useAskAIPanel();
  const { push } = useToaster();
  const sendTurn = useSendAskTurn(slug);
  const [message, setMessage] = useState("");
  // Intent describes what a turn may do, and defaults to the read-only policy
  // so widening is always a deliberate act.
  const [intent, setIntent] = useState<RunIntent>("ask");
  /** When the watched run was dispatched — the elapsed clock's zero. */
  const [watchedRun, setWatchedRun] = useState<(WatchedRun & { startedAt: number }) | null>(null);

  const transcript = useSessionTranscript(slug, ASK_THREAD_ALIAS, {
    // Mounted only while the panel is open — a closed panel must not poll.
    enabled: open,
  });

  // Tails the accepted run on its real write target (resolved server-side from
  // the alias), so the live block keys the log that is actually being written.
  const runStream = useRunStream(slug, watchedRun?.sessionId ?? null, watchedRun?.runId ?? null);
  const turnItems = useMemo(
    () => composeTurnList(transcript.data?.turns ?? [], runStream),
    [transcript.data?.turns, runStream],
  );

  const mirroredAt = transcript.data?.mirroredAt ?? null;
  const mirrorAge = mirroredAt === null ? null : Date.now() - new Date(mirroredAt).getTime();
  const mirrorStale =
    mirrorAge !== null && Number.isFinite(mirrorAge) && mirrorAge > MIRROR_STALE_MS;

  const text = message.trim();
  const tooLong = text.length > MAX_LENGTH;
  const runPending = sendTurn.isPending;
  const disabled = !text || tooLong || runPending;

  const sendLabel = runPending ? "job running…" : "run";

  const submit = () => {
    if (disabled) return;

    // Accepted as HTTP 202; the turn runs out-of-band and the reply lands in
    // the WRITE TARGET's transcript when it finishes.
    sendTurn.mutate(
      {
        intent,
        message: text,
        // References ride the turn: the server renders them into the prompt
        // AND records them on the write target's sidecar.
        ...(pendingRef && { refs: [pendingRef] }),
      },
      {
        onSuccess: (result) => {
          // Watch the run the 202 named — same key the server built `streamUrl`
          // from, so the live block tails the log that is actually being written.
          setWatchedRun({
            sessionId: result.writeTargetId,
            runId: result.runId,
            startedAt: Date.now(),
          });
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
        <Badge color="purple">opencode</Badge>
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

        {/* ONE control: intent — what the turn is allowed to touch. The
              channel is not a choice; every send is a one-shot opencode run. */}
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

      {/* transcript — checkpoint-mirrored, never live */}
      <section className="flex min-h-0 flex-1 flex-col" aria-label="checkpoint-mirrored transcript">
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
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {transcript.isLoading && turnItems.length === 0 ? (
              <div className="text-[11px] text-term-dim">loading…</div>
            ) : turnItems.length === 0 ? (
              <div className="text-[11px] text-term-dim">
                no turns yet — ask something and the reply appears here
              </div>
            ) : (
              // ONE list, from ONE composition — the live block and the folded
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
 * The header carries a phase + a live elapsed clock, because a one-shot run's
 * first ~10s are structurally silent (opencode CLI boot + model connect emit
 * nothing) and an unexplained blank reads as a hang. Phases, from the stream
 * alone:
 *   connecting            → "starting opencode…"   (SSE not open yet)
 *   open, no text/tools   → "waiting for the model's first token…"
 *   open, tools ticking   → "working"              (tools ARE the progress)
 *   ended                 → outcome + total time
 *
 * Transient by design. This block is what the folded sidecar turns replace, so
 * it is styled as a live edge (a rule down the side) rather than as a turn.
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
          opencode is booting and connecting to the model — the first token usually lands after
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
