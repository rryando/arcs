#!/usr/bin/env node
/**
 * ARCS ↔ Claude Code session-bridge hook.
 *
 * Registered four times in settings.json (SessionStart, UserPromptSubmit,
 * SessionEnd, Stop) and dispatches internally on the `hook_event_name` field
 * Claude Code writes to stdin. Install with `arcs hooks install-claude-code
 * <slug>`, which generates the token and prints the snippet to paste.
 *
 * HARD RULE: this script never blocks the session. Any failure — ARCS not
 * running, token rejected, timeout, malformed JSON — is swallowed, nothing is
 * printed, and the exit code stays 0. Exit code 2 (the "block" signal) is never
 * produced. A broken bridge must be invisible, never an obstacle to the user's
 * actual Claude Code session.
 *
 * Config comes from the environment, assigned inline in the settings.json
 * command string:
 *   ARCS_HOOK_TOKEN  per-project token (required)
 *   ARCS_HOOK_SLUG   ARCS project slug (required)
 *   ARCS_HOOK_URL    ARCS web server URL (default http://127.0.0.1:4173)
 */

const DEFAULT_URL = "http://127.0.0.1:4173";
/** Short by design: a hung ARCS server must not stall prompt submission. */
const TIMEOUT_MS = 1500;
const EVENTS = new Set(["SessionStart", "UserPromptSubmit", "SessionEnd", "Stop"]);

/** Never rejects: an unreadable stdin yields "" and the run turns into a no-op. */
function readStdin() {
  return new Promise((resolveStdin) => {
    let raw = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.destroy();
      resolveStdin(raw);
    };
    const timer = setTimeout(finish, TIMEOUT_MS);

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

/**
 * Labelled and separated so the agent can tell queued out-of-band instructions
 * from the prompt the user just typed.
 */
function formatQueued(messages) {
  const body = messages.map((m, i) => `[${i + 1}] ${String(m).trim()}`).join("\n\n");
  return `Messages queued from the ARCS web UI, delivered at this checkpoint:\n\n${body}`;
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  const event = JSON.parse(raw);
  const eventName = event?.hook_event_name;
  const sessionId = event?.session_id;
  if (!EVENTS.has(eventName) || typeof sessionId !== "string" || !sessionId) return;

  const token = process.env.ARCS_HOOK_TOKEN;
  const slug = process.env.ARCS_HOOK_SLUG;
  if (!token || !slug) return;
  const baseUrl = (process.env.ARCS_HOOK_URL || DEFAULT_URL).replace(/\/+$/, "");

  const response = await fetch(`${baseUrl}/api/hook/${encodeURIComponent(slug)}/event`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      hook_event_name: eventName,
      session_id: sessionId,
      ...(typeof event.cwd === "string" && { cwd: event.cwd }),
      ...(typeof event.source === "string" && { source: event.source }),
      ...(typeof event.reason === "string" && { reason: event.reason }),
      ...(typeof event.transcript_path === "string" && { transcript_path: event.transcript_path }),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return;

  // Only UserPromptSubmit can inject context; the other events are pure
  // notifications and answer with empty stdout.
  if (eventName !== "UserPromptSubmit") return;

  const envelope = await response.json();
  const messages = envelope?.data?.queuedMessages;
  if (!Array.isArray(messages) || messages.length === 0) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: formatQueued(messages),
      },
    }),
  );
}

// Belt and braces around the hard rule: even a bug in this file (or a stray
// async rejection) must not surface as a non-zero exit for the user.
process.on("uncaughtException", () => {
  process.exitCode = 0;
});
process.on("unhandledRejection", () => {
  process.exitCode = 0;
});

// No process.exit(): letting the event loop drain guarantees stdout is flushed
// before the process ends, and the default exit code is already 0.
main()
  .catch(() => {})
  .finally(() => {
    process.exitCode = 0;
  });
