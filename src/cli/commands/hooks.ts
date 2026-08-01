// ---------------------------------------------------------------------------
// hooks install-claude-code — Provision the Claude Code session-bridge hook
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { writeHookToken } from "../../utils/hook-token-store.js";
import { PACKAGE_ROOT } from "../../utils/paths.js";
import { resolveProject } from "../../utils/project-resolver.js";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { failure, success } from "../output-envelope.js";

/** Matches `arcs web`'s own default — override when that port is taken. */
const DEFAULT_SERVER_URL = "http://127.0.0.1:4173";

/**
 * One script registered under three events; it dispatches internally on the
 * `hook_event_name` field Claude Code puts on stdin.
 */
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "SessionEnd"] as const;

const hooksInstallParams = {
  slug: {
    type: "string",
    positional: 0,
    description: "Project slug or path",
  },
  url: {
    type: "string",
    default: DEFAULT_SERVER_URL,
    description: `ARCS web server URL the hook posts to (default ${DEFAULT_SERVER_URL})`,
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "hooks install-claude-code",
  description: "Provision the Claude Code session-bridge hook (prints the settings.json snippet)",
  params: hooksInstallParams,
  mutation: true,
  handler: handleHooksInstallClaudeCode,
});

// ---------------------------------------------------------------------------

function settingsSnippet(command: string): string {
  return JSON.stringify(
    {
      hooks: Object.fromEntries(
        HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: "command", command }] }]]),
      ),
    },
    null,
    2,
  );
}

/**
 * Generates a fresh hook token and prints the settings.json snippet that uses
 * it. Deliberately does not touch `~/.claude/settings.json` or any
 * `.claude/settings.local.json`: ARCS writes inside `$ARCS_DATA` only, and
 * editing a user's agent configuration behind their back is not consent. The
 * snippet is the deliverable; pasting it is the user's call.
 *
 * Rerunning rotates the token — the previously installed snippet stops working
 * until it is replaced, which is the intended way to revoke a stale hook.
 */
async function handleHooksInstallClaudeCode(
  params: ParsedParams<typeof hooksInstallParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const resolved = await resolveProject(params.slug);
  if (!resolved.ok) return resolved.result;

  const { slug, projectDir } = resolved;
  const serverUrl = params.url.replace(/\/+$/, "");

  try {
    const token = randomUUID();
    await writeHookToken(projectDir, token);

    const hookScriptPath = resolve(PACKAGE_ROOT, "scripts", "claude-code-session-hook.mjs");
    // Env assignments prefixed to the command: a settings.json `command` is just
    // a shell string, which is how the per-project token reaches the script
    // without baking secrets into the script itself.
    const command =
      `ARCS_HOOK_TOKEN=${token} ARCS_HOOK_SLUG=${slug} ` +
      `ARCS_HOOK_URL=${serverUrl} node ${hookScriptPath}`;

    return success({
      project: slug,
      token,
      hookScriptPath,
      serverUrl,
      events: [...HOOK_EVENTS],
      settingsSnippet: settingsSnippet(command),
      notes: [
        "Paste settingsSnippet into ~/.claude/settings.json, .claude/settings.json, " +
          "or .claude/settings.local.json (merge into an existing `hooks` object). " +
          "ARCS never edits those files for you.",
        `serverUrl must match the port \`arcs web\` actually listens on — pass --url if you run it somewhere other than ${DEFAULT_SERVER_URL}.`,
        "The token is a secret: prefer settings.local.json if your .claude directory is committed.",
        "Rerunning this command rotates the token and invalidates the previously installed snippet.",
      ],
    });
  } catch (err) {
    return failure("hook_install_error", err instanceof Error ? err.message : String(err));
  }
}
