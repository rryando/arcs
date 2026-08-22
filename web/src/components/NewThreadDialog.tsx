/**
 * Create an ARCS thread — POST /sessions, which mints a record and spawns
 * nothing; the thread's first turn is what drives it.
 *
 * Runtime defaults to opencode (the server's default too). claude-code stays
 * available as the explicit legacy option for threads that must run on it.
 */

import { useState } from "react";
import type { SessionMeta, SessionRuntimeType } from "../api/client";
import { useCreateSession } from "../api/hooks";
import { Dialog, Field, FormActions, SelectInput } from "./Dialog";
import { useToaster } from "./Toaster";

const RUNTIME_OPTIONS = [
  { value: "opencode", label: "opencode — one-shot runs" },
  { value: "claude-code", label: "claude code — legacy" },
];

const isRuntimeType = (value: string): value is SessionRuntimeType =>
  value === "opencode" || value === "claude-code";

export function NewThreadDialog({
  slug,
  onCreated,
  onClose,
}: {
  slug: string;
  /** Called with the minted record — typically opens it in the session panel. */
  onCreated: (session: SessionMeta) => void;
  onClose: () => void;
}) {
  const createSession = useCreateSession(slug);
  const { push } = useToaster();
  const [runtimeType, setRuntimeType] = useState<SessionRuntimeType>("opencode");

  const submit = () => {
    createSession.mutate(
      { runtimeType },
      {
        onSuccess: (created) => {
          push("success", "thread created — send it a turn to start the conversation");
          onCreated(created);
          onClose();
        },
        onError: (err) => push("error", err instanceof Error ? err.message : String(err)),
      },
    );
  };

  return (
    <Dialog title="new thread" onClose={onClose} width="max-w-md">
      <p className="mb-3 text-[11px] leading-snug text-term-dim">
        creates an ARCS-owned thread record for this project — nothing runs until its first turn.
      </p>
      <Field label="runtime">
        <SelectInput
          value={runtimeType}
          onChange={(v) => setRuntimeType(isRuntimeType(v) ? v : "opencode")}
          options={RUNTIME_OPTIONS}
        />
      </Field>
      <FormActions
        submitLabel="create"
        onSubmit={submit}
        onCancel={onClose}
        pending={createSession.isPending}
      />
    </Dialog>
  );
}
