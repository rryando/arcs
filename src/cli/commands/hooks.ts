// ---------------------------------------------------------------------------
// hooks install-claude-code / status — Claude Code session-bridge hook
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type ClaudeSettings,
  claudeSettingsLocalPath,
  installClaudeCodeHook,
} from "../../utils/claude-code-hook-install.js";
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
export const DEFAULT_SERVER_URL = "http://127.0.0.1:4173";

/**
 * One script registered under three events; it dispatches internally on the
 * `hook_event_name` field Claude Code puts on stdin.
 */
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "SessionEnd"] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface ProvisionedHook {
  token: string;
  hookScriptPath: string;
  serverUrl: string;
  command: string;
}

/**
 * Rotates the project's hook token and builds the `command` string a
 * settings.json hook entry must run.
 *
 * Shared by this command (which prints the snippet for manual pasting) and by
 * `utils/claude-code-hook-install.ts` (which writes it into a workspace's
 * `.claude/settings.local.json` after an explicit confirm). One source of truth
 * for the command string: a drift between the two would produce hooks that
 * authenticate against a token nobody stored.
 */
export async function provisionHookCommand(options: {
  projectDir: string;
  slug: string;
  serverUrl?: string;
}): Promise<ProvisionedHook> {
  const serverUrl = (options.serverUrl ?? DEFAULT_SERVER_URL).replace(/\/+$/, "");
  const token = randomUUID();
  await writeHookToken(options.projectDir, token);

  const hookScriptPath = resolve(PACKAGE_ROOT, "scripts", "claude-code-session-hook.mjs");
  const command = buildHookCommand({ token, slug: options.slug, serverUrl, hookScriptPath });

  return { token, hookScriptPath, serverUrl, command };
}

/**
 * The literal `command` string a settings.json hook entry runs.
 *
 * Env assignments are prefixed to the command: a settings.json `command` is just
 * a shell string, which is how the per-project token reaches the script without
 * baking secrets into the script itself.
 *
 * Split out from `provisionHookCommand()` so the `--write` path can render the
 * snippet for a hook `installClaudeCodeHook()` already provisioned, without
 * provisioning a second time (which would rotate the token and leave the
 * printed snippet authenticating against a token nobody stored).
 */
function buildHookCommand(hook: {
  token: string;
  slug: string;
  serverUrl: string;
  hookScriptPath: string;
}): string {
  return (
    `ARCS_HOOK_TOKEN=${hook.token} ARCS_HOOK_SLUG=${hook.slug} ` +
    `ARCS_HOOK_URL=${hook.serverUrl} node ${hook.hookScriptPath}`
  );
}

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
  write: {
    type: "boolean",
    default: false,
    description:
      "Merge the hook into the workspace's .claude/settings.local.json instead of only printing the snippet",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "hooks install-claude-code",
  description:
    "Provision the Claude Code session-bridge hook (prints the settings.json snippet; --write installs it)",
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
 * it. Without `--write` it deliberately does not touch `~/.claude/settings.json`
 * or any `.claude/settings.local.json`: ARCS writes inside `$ARCS_DATA` only,
 * and editing a user's agent configuration behind their back is not consent.
 * The snippet is the deliverable; pasting it is the user's call.
 *
 * `--write` is that consent, given explicitly on the command line: it delegates
 * to `installClaudeCodeHook()`, the same merge the `arcs project init` prompt
 * uses, which aborts rather than clobber a malformed settings file.
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

  const { slug, projectDir, workspacePath } = resolved;

  try {
    if (params.write) {
      // No workspace path means no legitimate write target. Falling back to
      // `process.cwd()` would drop agent config into whatever directory the CLI
      // ran from, so refuse and leave the user with the snippet path instead.
      if (!workspacePath) {
        return failure(
          "no_workspace_paths",
          `Project "${slug}" has no workspace path configured — rerun without --write and paste the snippet yourself.`,
        );
      }

      const installed = await installClaudeCodeHook({
        workspacePath,
        projectDir,
        slug,
        serverUrl: params.url,
      });

      return success({
        project: slug,
        token: installed.token,
        hookScriptPath: installed.hookScriptPath,
        serverUrl: installed.serverUrl,
        events: installed.events,
        settingsPath: installed.settingsPath,
        settingsSnippet: settingsSnippet(
          buildHookCommand({
            token: installed.token,
            slug,
            serverUrl: installed.serverUrl,
            hookScriptPath: installed.hookScriptPath,
          }),
        ),
        notes: [
          `Hook merged into ${installed.settingsPath} — no other file was touched.`,
          "Start a NEW Claude Code session to pick it up — sessions already running won't.",
          `serverUrl must match the port \`arcs web\` actually listens on — pass --url if you run it somewhere other than ${DEFAULT_SERVER_URL}.`,
          "The token is a secret: settings.local.json is the git-ignored variant, keep it that way.",
          "Rerunning this command rotates the token and replaces the entry it wrote.",
        ],
      });
    }

    const { token, hookScriptPath, serverUrl, command } = await provisionHookCommand({
      projectDir,
      slug,
      serverUrl: params.url,
    });

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

// ---------------------------------------------------------------------------
// hooks status
// ---------------------------------------------------------------------------

const hooksStatusParams = {
  slug: {
    type: "string",
    required: true,
    positional: 0,
    description: "Project slug or path",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "hooks status",
  description: "Report whether the Claude Code session-bridge hook is installed for a workspace",
  params: hooksStatusParams,
  mutation: false,
  handler: handleHooksStatus,
});

export interface HookStatus {
  installed: boolean;
  matchesCurrentSlug: boolean;
  matchedSlugs: string[];
  hookScriptPath: string;
}

/** `ARCS_HOOK_SLUG=<slug>` as prefixed onto a settings.json hook `command`. */
const HOOK_SLUG_PATTERN = /ARCS_HOOK_SLUG=(\S+)/;

/**
 * First configured workspace path for a project, mirroring how
 * `resolveProject()` sources it. Returns undefined when the project has none
 * (or its meta is unreadable) — a status check reports "not installed" rather
 * than guessing at `process.cwd()`, since inspecting whatever directory the CLI
 * happens to run from would be a lie about the project.
 */
async function firstWorkspacePath(projectDir: string): Promise<string | undefined> {
  let meta: { workspacePaths?: unknown };
  try {
    meta = JSON.parse(await readFile(resolve(projectDir, "meta.json"), "utf-8"));
  } catch {
    return undefined;
  }
  const paths = Array.isArray(meta.workspacePaths) ? (meta.workspacePaths as string[]) : [];
  const first = paths[0];
  if (typeof first !== "string" || first.length === 0) return undefined;
  return first.startsWith("~") ? resolve(homedir(), first.slice(2)) : resolve(first);
}

/**
 * Read-only inspection of a workspace's `.claude/settings.local.json`.
 *
 * Matches entries the same way `mergeHookIntoSettings()` replaces them — on the
 * absolute `hookScriptPath` appearing in the `command` string — so status and
 * install can never disagree about what "installed" means.
 *
 * `installed` requires every hook event to be registered: a partial
 * registration is a broken bridge that should be repaired, so reporting it as
 * installed would suppress the fix. `matchedSlugs` is still populated in that
 * case, which is also how a caller sees a hook wired to a *different* project.
 */
function inspectSettings(
  settings: ClaudeSettings,
  hookScriptPath: string,
): { installed: boolean; matchedSlugs: string[] } {
  const hooks = settings.hooks ?? {};
  const matchedSlugs: string[] = [];
  let eventsWithHook = 0;

  for (const event of HOOK_EVENTS) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    let found = false;

    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (typeof h?.command !== "string" || !h.command.includes(hookScriptPath)) continue;
        found = true;
        const slug = HOOK_SLUG_PATTERN.exec(h.command)?.[1];
        if (slug && !matchedSlugs.includes(slug)) matchedSlugs.push(slug);
      }
    }

    if (found) eventsWithHook++;
  }

  return { installed: eventsWithHook === HOOK_EVENTS.length, matchedSlugs };
}

/**
 * Reports whether the session-bridge hook is registered in the project's
 * workspace, without any side effect.
 *
 * Deliberately does not call `provisionHookCommand()`: that rotates the hook
 * token, so a status check built on it would break the very hook it was asked
 * to inspect. The script path is recomputed here instead — the one line shared
 * with the install path.
 *
 * A malformed or non-object settings file reports `installed: false` rather
 * than throwing: unlike the install path (which must abort before writing so a
 * hand-edited file is never clobbered), nothing is at risk from a read.
 */
async function handleHooksStatus(
  params: ParsedParams<typeof hooksStatusParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const resolved = await resolveProject(params.slug);
  if (!resolved.ok) return resolved.result;

  const { slug, projectDir } = resolved;
  const hookScriptPath = resolve(PACKAGE_ROOT, "scripts", "claude-code-session-hook.mjs");
  const notInstalled: HookStatus = {
    installed: false,
    matchesCurrentSlug: false,
    matchedSlugs: [],
    hookScriptPath,
  };

  const workspacePath = await firstWorkspacePath(projectDir);
  if (!workspacePath) return success(notInstalled);

  let raw: string;
  try {
    raw = await readFile(claudeSettingsLocalPath(workspacePath), "utf-8");
  } catch {
    return success(notInstalled);
  }
  if (raw.trim().length === 0) return success(notInstalled);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return success(notInstalled);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return success(notInstalled);
  }

  const { installed, matchedSlugs } = inspectSettings(parsed as ClaudeSettings, hookScriptPath);

  return success({
    installed,
    matchesCurrentSlug: matchedSlugs.includes(slug),
    matchedSlugs,
    hookScriptPath,
  } satisfies HookStatus);
}
