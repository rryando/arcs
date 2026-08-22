/**
 * Compose one turn for a KNOWN thread — the ✉ affordance on a sessions-table
 * row. The ask-only counterpart of the panel composer: same transport
 * (`POST /sessions/:id/turns`), fixed read-only intent, no streaming — the
 * reply lands in the thread's transcript, which the session panel renders.
 */

import { useCallback, useState } from "react";
import type { SessionMeta } from "../api/client";
import { useSendSessionTurn } from "../api/hooks";
import { sessionName } from "../hooks/useSessionCandidates";
import { cx, truncate } from "../lib/format";
import { Dialog, inputClass } from "./Dialog";
import { useToaster } from "./Toaster";

/** Past this the message is flagged as risky to deliver, but still sendable. */
export const WARN_LENGTH = 4000;
/** Past this sending is blocked — no runtime takes a prompt this big usefully. */
export const MAX_LENGTH = 20000;

export interface SessionMessageFormProps {
  slug: string;
  /** The thread this turn continues. */
  session: SessionMeta;
  onClose: () => void;
}

export function SessionMessageForm({ slug, session, onClose }: SessionMessageFormProps) {
  const sendTurn = useSendSessionTurn(slug);
  const { push } = useToaster();
  const [message, setMessage] = useState("");
  // Callback ref, not an effect: focus follows the textarea the moment it mounts.
  const focusOnMount = useCallback((node: HTMLTextAreaElement | null) => node?.focus(), []);

  const text = message.trim();
  const tooLong = text.length > MAX_LENGTH;
  const disabled = !text || tooLong || sendTurn.isPending;

  const submit = () => {
    if (disabled) return;
    sendTurn.mutate(
      { id: session.normalizedId, input: { intent: "ask", message: text } },
      {
        onSuccess: () => {
          // "sent" would be a lie: the turn was ACCEPTED, and its reply lands
          // in the thread's transcript when it finishes.
          push(
            "success",
            "turn accepted — the reply appears in the session panel when the turn finishes",
          );
          onClose();
        },
        onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
      },
    );
  };

  return (
    <Dialog
      title={`send message — ${truncate(sessionName(session), 24)}`}
      onClose={onClose}
      width="max-w-2xl"
    >
      <div className="mb-2 flex items-baseline gap-2 text-[11px] text-term-dim">
        <span className="text-term-amber">
          continues this thread — the reply appears in the session panel when the turn finishes
        </span>
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
        disabled={sendTurn.isPending}
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
          {sendTurn.isPending ? "…" : "send"}
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
