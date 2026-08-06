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
import { readRootMeta } from "../../utils/dag.js";
import { DEFAULT_SERVER_URL, HOOK_EVENTS, type HookEventName } from "../../utils/hook-contract.js";
import { writeHookToken } from "../../utils/hook-token-store.js";
import { getDataDir, PACKAGE_ROOT } from "../../utils/paths.js";
import { resolveProject } from "../../utils/project-resolver.js";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { failure, success } from "../output-envelope.js";

/**
 * Re-exported from the bridge contract, which is where the event list and the
 * default URL are defined once for the server, this installer, and the parity
 * test that pins the standalone hook script to them. Kept exported here because
 * `utils/claude-code-hook-install.ts` sources them from this module.
 */
export { DEFAULT_SERVER_URL, HOOK_EVENTS };

export type HookEvent = HookEventName;

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

  const scriptPath = hookScriptPath();
  const command = buildHookCommand({
    token,
    slug: options.slug,
    serverUrl,
    hookScriptPath: scriptPath,
  });

  return { token, hookScriptPath: scriptPath, serverUrl, command };
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
  /**
   * The `ARCS_HOOK_URL` values baked into the installed hook commands, in the
   * order first seen. Additive to the pre-existing shape and always an array:
   * an absent, unreadable or unparsable install reports `[]` rather than
   * failing, and a workspace whose entries disagree reports each distinct URL
   * instead of picking a winner.
   *
   * This is the field that makes the bridge's worst failure mode visible — the
   * URL is written into settings.json at install time, so it keeps pointing at
   * whatever port `arcs web` used *then*, no matter what it binds now.
   */
  hookUrls: string[];
  hookScriptPath: string;
}

/** `ARCS_HOOK_SLUG=<slug>` as prefixed onto a settings.json hook `command`. */
const HOOK_SLUG_PATTERN = /ARCS_HOOK_SLUG=(\S+)/;
/** `ARCS_HOOK_URL=<url>` as prefixed onto a settings.json hook `command`. */
const HOOK_URL_PATTERN = /ARCS_HOOK_URL=(\S+)/;

interface WorkspaceHookInspection {
  installed: boolean;
  matchedSlugs: string[];
  hookUrls: string[];
}

/** Fresh (never shared) empty result — every degradation path returns this. */
function noHooks(): WorkspaceHookInspection {
  return { installed: false, matchedSlugs: [], hookUrls: [] };
}

/**
 * Configured workspace paths for a project, in order, mirroring how
 * `resolveProject()` sources them. Returns `[]` when the project has none (or
 * its meta is unreadable) — a status check reports "not installed" rather than
 * guessing at `process.cwd()`, since inspecting whatever directory the CLI
 * happens to run from would be a lie about the project.
 */
async function workspacePathsFor(projectDir: string): Promise<string[]> {
  let meta: { workspacePaths?: unknown };
  try {
    meta = JSON.parse(await readFile(resolve(projectDir, "meta.json"), "utf-8"));
  } catch {
    return [];
  }
  const configured = Array.isArray(meta.workspacePaths) ? meta.workspacePaths : [];
  const paths: string[] = [];
  for (const entry of configured) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    paths.push(entry.startsWith("~") ? resolve(homedir(), entry.slice(2)) : resolve(entry));
  }
  return paths;
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
 * installed would suppress the fix. `matchedSlugs`/`hookUrls` are still
 * populated in that case, which is also how a caller sees a hook wired to a
 * *different* project or a *different* port.
 */
function inspectSettings(
  settings: ClaudeSettings,
  hookScriptPath: string,
): WorkspaceHookInspection {
  const hooks = settings.hooks ?? {};
  const matchedSlugs: string[] = [];
  const hookUrls: string[] = [];
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
        const url = HOOK_URL_PATTERN.exec(h.command)?.[1];
        if (url && !hookUrls.includes(url)) hookUrls.push(url);
      }
    }

    if (found) eventsWithHook++;
  }

  return { installed: eventsWithHook === HOOK_EVENTS.length, matchedSlugs, hookUrls };
}

/**
 * The one read path for an installed hook: locate the workspace's
 * `.claude/settings.local.json`, parse it, and hand it to `inspectSettings()`.
 *
 * Every failure — missing file, empty file, invalid JSON, a JSON array or
 * scalar where an object belongs — degrades to `noHooks()` instead of throwing.
 * That is deliberately the mirror image of `installClaudeCodeHook()`, which
 * aborts on the same malformed input: the writer must never clobber a
 * hand-edited settings file, but a reader risks nothing, and callers here
 * include a server startup path that must not be killable by a stray comma in
 * someone else's config.
 */
async function inspectWorkspaceHooks(
  workspacePath: string,
  hookScriptPath: string,
): Promise<WorkspaceHookInspection> {
  let raw: string;
  try {
    raw = await readFile(claudeSettingsLocalPath(workspacePath), "utf-8");
  } catch {
    return noHooks();
  }
  if (raw.trim().length === 0) return noHooks();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return noHooks();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return noHooks();
  }

  return inspectSettings(parsed as ClaudeSettings, hookScriptPath);
}

/** Absolute path of the standalone hook script a settings entry must run. */
function hookScriptPath(): string {
  return resolve(PACKAGE_ROOT, "scripts", "claude-code-session-hook.mjs");
}

/**
 * Reports whether the session-bridge hook is registered in the project's
 * workspace, without any side effect.
 *
 * Deliberately does not call `provisionHookCommand()`: that rotates the hook
 * token, so a status check built on it would break the very hook it was asked
 * to inspect. Only `hookScriptPath()` is shared with the install path.
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
  const scriptPath = hookScriptPath();

  // First workspace only, matching `resolveProject()` — status answers for the
  // workspace a hook install would have targeted.
  const workspacePath = (await workspacePathsFor(projectDir))[0];
  const { installed, matchedSlugs, hookUrls } = workspacePath
    ? await inspectWorkspaceHooks(workspacePath, scriptPath)
    : noHooks();

  return success({
    installed,
    matchesCurrentSlug: matchedSlugs.includes(slug),
    matchedSlugs,
    hookUrls,
    hookScriptPath: scriptPath,
  } satisfies HookStatus);
}

// ---------------------------------------------------------------------------
// Bound-port vs. baked-URL mismatch (used by `arcs web` at startup)
// ---------------------------------------------------------------------------

export interface BoundAddress {
  host: string;
  port: number;
}

interface HookUrlMismatch {
  slug: string;
  url: string;
}

/** `http://host:port`, bracketing an IPv6 host so the printed URL is valid. */
function boundUrlOf(bound: BoundAddress): string {
  const host =
    bound.host.includes(":") && !bound.host.startsWith("[") ? `[${bound.host}]` : bound.host;
  return `http://${host}:${bound.port}`;
}

/**
 * Port a baked `ARCS_HOOK_URL` actually posts to, or undefined when the value
 * is not a URL we can read. Undefined means "unknown", and unknown must stay
 * silent — a warning we cannot substantiate is worse than none.
 */
function portOfUrl(url: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.port.length > 0) {
    const port = Number(parsed.port);
    return Number.isInteger(port) ? port : undefined;
  }
  if (parsed.protocol === "https:") return 443;
  if (parsed.protocol === "http:") return 80;
  return undefined;
}

/**
 * The single warning block `arcs web` prints when the address it actually bound
 * disagrees with the URL baked into an installed hook — or `null` when there is
 * nothing to say. Plain text: the caller owns the colouring.
 *
 * Why this exists: `ARCS_HOOK_URL` is written into settings.json at install
 * time, so `arcs web --port N` leaves every already-installed hook posting to
 * the old port. The hook exits 0 on a failed POST by design (a broken bridge
 * must be inert, never fatal to the user's Claude Code session), so the bridge
 * dies with no output anywhere and looks exactly like an idle session. This is
 * the only place that difference becomes visible.
 *
 * Compares PORTS, not full origins: `arcs web` refuses anything but loopback,
 * and 127.0.0.1 / localhost / ::1 are the same listener often enough that
 * warning on a host spelling difference would be noise that trains the warning
 * away. The port is the difference that reliably breaks the bridge.
 *
 * Never throws and never blocks — it runs after the server is already
 * listening, and every read inside it degrades to silence: no data dir, no
 * root meta, no project, no workspace, no settings file, malformed settings,
 * or an `ARCS_HOOK_URL` that is not a parsable URL all produce `null`.
 */
export async function hookUrlMismatchWarning(bound: BoundAddress): Promise<string | null> {
  try {
    return await buildHookUrlMismatchWarning(bound);
  } catch {
    return null;
  }
}

async function buildHookUrlMismatchWarning(bound: BoundAddress): Promise<string | null> {
  const dataDir = getDataDir();

  let projects: { id: string }[];
  try {
    projects = (await readRootMeta(dataDir)).projects;
  } catch {
    return null;
  }

  const scriptPath = hookScriptPath();
  const mismatches: HookUrlMismatch[] = [];
  const seen = new Set<string>();

  // Every project is scanned: `arcs web` serves all of them from one listener,
  // so any project's hook can be the one pointing somewhere else. Workspaces
  // that disagree with each other are all reported rather than reconciled.
  for (const project of projects) {
    const projectDir = resolve(dataDir, "projects", project.id);
    for (const workspacePath of await workspacePathsFor(projectDir)) {
      const { hookUrls } = await inspectWorkspaceHooks(workspacePath, scriptPath);
      for (const url of hookUrls) {
        const port = portOfUrl(url);
        if (port === undefined || port === bound.port) continue;
        const key = `${project.id}\x00${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        mismatches.push({ slug: project.id, url });
      }
    }
  }

  if (mismatches.length === 0) return null;

  const boundUrl = boundUrlOf(bound);
  return [
    "⚠ Claude Code session bridge: the installed hook posts to a different port.",
    `    arcs web is listening on   ${boundUrl}`,
    ...mismatches.map((m) => `    installed hook posts to    ${m.url}   (project ${m.slug})`),
    "    Every hook POST will be refused, and the hook exits 0 by design — the",
    "    session bridge will stay silent instead of failing loudly.",
    "    Fix: restart on the hook's port, or re-point the hook:",
    `      arcs hooks install-claude-code ${mismatches[0].slug} --url ${boundUrl} --write`,
  ].join("\n");
}
