/**
 * Send a message to the runtime behind a session.
 *
 * Delivery is runtime-dependent, so every capability decision goes through
 * `messageDelivery()` — the single place a new runtime (or a new delivery mode,
 * e.g. queued instead of live) gets wired in. Callers gate the affordance on
 * `canSendMessage()` rather than testing `runtimeType` themselves.
 */

import { useEffect, useRef, useState } from "react";
import type { SessionMeta } from "../api/client";
import { useSendSessionMessage } from "../api/hooks";
import { cx, truncate } from "../lib/format";
import { Dialog, inputClass } from "./Dialog";
import { useToaster } from "./Toaster";

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

export function SessionMessageForm({
  slug,
  session,
  onClose,
}: {
  slug: string;
  session: SessionMeta;
  onClose: () => void;
}) {
  const sendMessage = useSendSessionMessage(slug);
  const { push } = useToaster();
  const [message, setMessage] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const delivery = messageDelivery(session);
  const text = message.trim();
  const disabled = delivery.kind === "unsupported" || !text || sendMessage.isPending;

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = () => {
    if (disabled) return;
    sendMessage.mutate(
      { id: session.normalizedId, message: text },
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

  return (
    <Dialog
      title={`send message — ${truncate(session.runtimeSessionId, 24)}`}
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
      </div>

      <textarea
        ref={ref}
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
