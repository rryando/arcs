/**
 * Send a message to the runtime behind a session.
 *
 * Delivery is runtime-dependent, so every capability decision goes through
 * `messageDelivery()` — the single place a new runtime (or a new delivery mode,
 * e.g. queued instead of live) gets wired in. Callers gate the affordance on
 * `canSendMessage()` rather than testing `runtimeType` themselves.
 *
 * Callers that already know the target pass `session` and get the compose view
 * straight away. Callers that only have text to send (a document section) omit
 * it and get a session picker first.
 */

import { useCallback, useState } from "react";
import type { SessionLinkedNodeType, SessionMeta } from "../api/client";
import { useCreateOpencodeSession, useSendSessionMessage } from "../api/hooks";
import { sessionLabel, useSessionCandidates } from "../hooks/useSessionCandidates";
import { cx, truncate } from "../lib/format";
import { Dialog, inputClass } from "./Dialog";
import { SessionStatusBadge } from "./SessionStatusBadge";
import { useToaster } from "./Toaster";

/** Past this the message is flagged as risky to deliver, but still sendable. */
export const WARN_LENGTH = 4000;
/** Past this sending is blocked — no runtime takes a prompt this big usefully. */
export const MAX_LENGTH = 20000;

export type MessageDelivery =
  /** The runtime accepts a prompt right now; the agent picks it up mid-run. */
  | { kind: "live"; hint: string }
  /** Stored for the session to collect itself at its next checkpoint. */
  | { kind: "queued"; hint: string }
  /** No channel to this runtime yet — the form explains instead of failing. */
  | { kind: "unsupported"; hint: string };

export function messageDelivery(session: SessionMeta): MessageDelivery {
  if (session.runtimeType === "opencode") {
    return { kind: "live", hint: "delivered to the running opencode session immediately" };
  }
  return {
    kind: "queued",
    hint: "queued for delivery at the session's next checkpoint — not instant",
  };
}

export function canSendMessage(session: SessionMeta): boolean {
  return messageDelivery(session).kind !== "unsupported";
}

export interface SessionMessageFormProps {
  slug: string;
  /** Known target — when omitted the form asks the user to pick one first. */
  session?: SessionMeta;
  /** Pre-fills the textarea, e.g. the source of a document section. */
  initialText?: string;
  /** Only sorts the picker (linked sessions first) — never filters it, so a
   *  node with no linked session still offers every session. */
  linkedNodeType?: SessionLinkedNodeType;
  linkedNodeId?: string;
  onClose: () => void;
}

export function SessionMessageForm({
  slug,
  session,
  initialText,
  linkedNodeType,
  linkedNodeId,
  onClose,
}: SessionMessageFormProps) {
  const sendMessage = useSendSessionMessage(slug);
  const createSession = useCreateOpencodeSession(slug);
  const { push } = useToaster();
  const [picked, setPicked] = useState<SessionMeta | null>(null);
  const [filter, setFilter] = useState("");
  const [message, setMessage] = useState(initialText ?? "");
  // Callback ref, not an effect: the textarea mounts either immediately or the
  // moment a session is picked, and focus should follow it either way.
  const focusOnMount = useCallback((node: HTMLTextAreaElement | null) => node?.focus(), []);

  const target = session ?? picked;
  const candidates = useSessionCandidates(slug, filter, linkedNodeType, linkedNodeId);

  const delivery = target ? messageDelivery(target) : null;
  const text = message.trim();
  const tooLong = text.length > MAX_LENGTH;
  const disabled =
    !target || delivery?.kind === "unsupported" || !text || tooLong || sendMessage.isPending;

  const submit = () => {
    if (disabled || !target || !delivery) return;
    sendMessage.mutate(
      { id: target.normalizedId, message: text },
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
          onClose();
        },
        onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
      },
    );
  };

  // Selecting the new session outright (rather than just refreshing the list)
  // is the point of the affordance: the user wanted somewhere to send a
  // message, so the picker hands straight over to the compose view — with any
  // `initialText` still in the textarea.
  const createAndPick = () => {
    if (createSession.isPending) return;
    createSession.mutate(
      {},
      {
        onSuccess: (created) => {
          setPicked(created);
          push("success", "opencode session created");
        },
        onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
      },
    );
  };

  if (!target || !delivery) {
    return (
      <Dialog title="send message — pick a session" onClose={onClose} width="max-w-2xl">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter sessions…"
          className={inputClass}
        />

        <div className="mt-2 max-h-64 overflow-y-auto border border-term-border">
          {candidates.length === 0 ? (
            <div className="px-2 py-4 text-center text-[12px] text-term-dim">
              <span className="text-term-border-hi">∅</span>{" "}
              {filter.trim() ? "no sessions match" : "no sessions registered for this project"}
            </div>
          ) : (
            candidates.map((s) => (
              <button
                key={s.normalizedId}
                type="button"
                onClick={() => setPicked(s)}
                className="group flex w-full items-center gap-2 border-b border-term-border/40 px-2 py-1 text-left text-[12px] text-term-fg hover:bg-term-fg/5"
              >
                <span className="w-3 text-term-green opacity-0 group-hover:opacity-100">▸</span>
                <SessionStatusBadge status={s.status} />
                <span className="flex-1 truncate">{sessionLabel(s)}</span>
                <span className="text-[11px] text-term-dim">{s.runtimeType}</span>
              </button>
            ))
          )}
        </div>

        {/* Always offered, not just when the list is empty — an empty picker
            must never be a dead end, and a filtered-down one is the same
            problem in miniature. */}
        <div className="mt-2 flex items-baseline gap-2">
          <button
            type="button"
            disabled={createSession.isPending}
            onClick={createAndPick}
            className="shrink-0 border border-term-green/60 px-2 py-0.5 text-[12px] text-term-green hover:bg-term-green hover:text-term-bg disabled:opacity-50"
          >
            {createSession.isPending ? "starting…" : "+ new opencode session"}
          </button>
          <span className="text-[11px] leading-snug text-term-dim">
            starts in the project workspace. Claude Code sessions cannot be created remotely — run{" "}
            <span className="kbd">claude</span> in a linked directory instead.
          </span>
        </div>

        <div className="mt-3 flex items-center gap-2 text-[12px]">
          <button
            type="button"
            onClick={onClose}
            className="border border-term-border px-2 py-0.5 text-term-dim hover:text-term-fg"
          >
            cancel
          </button>
          <span className="flex-1" />
          <span className="text-[11px] text-term-dim">
            {message.trim().length} characters ready to send
          </span>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`send message — ${truncate(target.runtimeSessionId, 24)}`}
      onClose={onClose}
      width="max-w-2xl"
    >
      <div className="mb-2 flex items-baseline gap-2 text-[11px] text-term-dim">
        <span
          className={cx(
            delivery.kind === "live" ? "text-term-green" : "text-term-amber",
            "font-bold",
          )}
        >
          {delivery.kind}
        </span>
        <span>{delivery.hint}</span>
        <span className="flex-1" />
        {!session && (
          <button
            type="button"
            onClick={() => setPicked(null)}
            className="text-term-dim hover:text-term-green"
          >
            ◂ pick another session
          </button>
        )}
      </div>

      <textarea
        ref={focusOnMount}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        disabled={delivery.kind === "unsupported"}
        placeholder="message for the agent…"
        rows={6}
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

      <div className="mt-3 flex items-center gap-2 text-[12px]">
        <button
          type="button"
          disabled={disabled}
          onClick={submit}
          className="border border-term-green/60 px-2 py-0.5 font-bold text-term-green hover:bg-term-green hover:text-term-bg disabled:opacity-50"
        >
          {sendMessage.isPending ? "…" : delivery.kind === "queued" ? "queue" : "send"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="border border-term-border px-2 py-0.5 text-term-dim hover:text-term-fg"
        >
          cancel
        </button>
        <span className="flex-1" />
        <span className="text-[11px] text-term-dim">
          <span className="kbd">ctrl</span>+<span className="kbd">enter</span> send
        </span>
      </div>
    </Dialog>
  );
}
