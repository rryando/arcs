/**
 * Consent-gated writer for the Claude Code session-bridge hook.
 *
 * `arcs hooks install-claude-code` deliberately never edits agent configuration
 * — it prints a snippet. This module is the opt-in counterpart: when the user
 * explicitly confirms during `arcs project init`, it merges the same hook entry
 * into the workspace's `.claude/settings.local.json` (local-only: the token is a
 * secret and `settings.local.json` is the git-ignored variant).
 *
 * Two rules the merge must never break:
 *   1. A malformed existing file ABORTS the write. Silently coalescing an
 *      unparseable settings file to `{}` would destroy a user's `permissions`
 *      block over a stray comma, so parse errors are surfaced, not swallowed.
 *   2. Replacement is keyed on the absolute hook script path, not the project
 *      slug. A workspace can be reassigned between ARCS projects, so matching on
 *      the script path leaves exactly one current ARCS entry per event instead
 *      of accumulating stale ones. Entries belonging to other tools are kept
 *      untouched, in place.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import color from "picocolors";
import { HOOK_EVENTS, provisionHookCommand } from "../cli/commands/hooks.js";

interface HookCommandEntry {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

interface HookMatcherEntry {
  hooks?: HookCommandEntry[];
  [key: string]: unknown;
}

export interface ClaudeSettings {
  hooks?: Record<string, HookMatcherEntry[]>;
  [key: string]: unknown;
}

export interface ClaudeCodeHookInstallResult {
  settingsPath: string;
  token: string;
  hookScriptPath: string;
  serverUrl: string;
  events: string[];
}

/** The only file this module ever writes — never `~/.claude/settings.json`. */
export function claudeSettingsLocalPath(workspacePath: string): string {
  return join(workspacePath, ".claude", "settings.local.json");
}

/**
 * Returns a copy of `settings` with the ARCS hook entry registered under every
 * hook event, replacing any prior entry that runs the same `hookScriptPath`.
 * Pure — no I/O, so the merge rules are directly testable.
 */
export function mergeHookIntoSettings(
  settings: ClaudeSettings,
  hook: { command: string; hookScriptPath: string },
): ClaudeSettings {
  const hooks: Record<string, HookMatcherEntry[]> = { ...(settings.hooks ?? {}) };

  for (const event of HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];

    const preserved: HookMatcherEntry[] = [];
    for (const entry of existing) {
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) {
        // Not a shape we understand — leave it exactly as found.
        preserved.push(entry);
        continue;
      }
      // Strip only OUR command, at the inner level: a matcher entry may mix an
      // ARCS hook with another tool's, and that other tool must survive.
      const kept = entry.hooks.filter(
        (h) => !(typeof h?.command === "string" && h.command.includes(hook.hookScriptPath)),
      );
      if (kept.length === 0) continue;
      preserved.push({ ...entry, hooks: kept });
    }

    preserved.push({ hooks: [{ type: "command", command: hook.command }] });
    hooks[event] = preserved;
  }

  return { ...settings, hooks };
}

/**
 * Reads the workspace's `.claude/settings.local.json` (if any), merges in a
 * freshly provisioned hook, and writes it back owner-only.
 *
 * Throws when the existing file is present but unparseable — nothing is written
 * in that case, so a hand-edited settings file is never clobbered.
 */
export async function installClaudeCodeHook(options: {
  workspacePath: string;
  projectDir: string;
  slug: string;
  serverUrl?: string;
}): Promise<ClaudeCodeHookInstallResult> {
  const settingsPath = claudeSettingsLocalPath(options.workspacePath);

  let raw: string | undefined;
  try {
    raw = await readFile(settingsPath, "utf-8");
  } catch {
    // Absent file — start from an empty settings object.
  }

  let settings: ClaudeSettings = {};
  if (raw !== undefined && raw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `${settingsPath} exists but is not valid JSON — fix it manually or delete it, ` +
          `then re-run \`arcs hooks install-claude-code ${options.slug}\`. Nothing was written.`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `${settingsPath} is valid JSON but not an object — fix it manually or delete it, ` +
          `then re-run \`arcs hooks install-claude-code ${options.slug}\`. Nothing was written.`,
      );
    }
    settings = parsed as ClaudeSettings;
  }

  const provisioned = await provisionHookCommand({
    projectDir: options.projectDir,
    slug: options.slug,
    serverUrl: options.serverUrl,
  });

  const merged = mergeHookIntoSettings(settings, provisioned);

  await mkdir(dirname(settingsPath), { recursive: true });
  // The merged command embeds `ARCS_HOOK_TOKEN=<value>`, so this file is a
  // SECOND cleartext copy of the hook token — this one in the user's repo
  // rather than under ARCS's own data dir. `mode` covers the fresh create; it
  // does NOT cover a pre-existing file, because this is a direct, non-atomic
  // open(path, "w", mode) that truncates the inode already there and leaves
  // that inode's mode alone. (That create-only caveat is exactly the one that
  // does NOT apply to the token store's temp+rename writer, where every write
  // installs a fresh inode — it bites squarely here.) So the chmod is
  // unconditional, and that is also what repairs a 0644 file left behind by an
  // older install.
  //
  // What this buys, stated honestly: 0o600 is a cross-user control. It does
  // nothing against a process running as THIS user, and it does not hide the
  // token from `ps` — the value is inlined in the hook command string, so every
  // hook fire still exposes it in the process table. Handing the hook a path
  // (`ARCS_HOOK_TOKEN_FILE=<path>`) instead of the value would close that; the
  // mode only closes the on-disk half.
  //
  // The `.claude` DIRECTORY is deliberately left exactly as found. Unlike the
  // hooks dir under ARCS's data dir, which holds nothing but the token, this
  // one holds the user's other Claude Code files, and narrowing it would be a
  // hostile surprise in a directory ARCS does not own.
  await writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await chmod(settingsPath, 0o600);

  return {
    settingsPath,
    token: provisioned.token,
    hookScriptPath: provisioned.hookScriptPath,
    serverUrl: provisioned.serverUrl,
    events: [...HOOK_EVENTS],
  };
}

/**
 * Interactively offers the hook install during `arcs project init`.
 *
 * Mirrors `promptAndInstallCodegraph`: a note explaining the offer, a confirm
 * defaulting to "no", and a manual-fallback hint when declined. Returns the
 * install result only when a write actually happened; returns `null` on
 * decline, cancel, or failure. Never throws — `arcs project init` succeeding
 * matters more than this offer succeeding.
 */
export async function promptAndInstallClaudeCodeHook(options: {
  workspacePath: string;
  projectDir: string;
  slug: string;
  serverUrl?: string;
}): Promise<ClaudeCodeHookInstallResult | null> {
  const settingsPath = claudeSettingsLocalPath(options.workspacePath);

  p.note(
    [
      "The session-bridge hook lets the ARCS web UI see your Claude Code",
      "sessions and queue messages for them (delivered at the next prompt).",
      "",
      `Writes ${color.cyan(settingsPath)} only — never your global config.`,
    ].join("\n"),
    "Optional: Claude Code session bridge",
  );

  const shouldInstall = await p.confirm({
    message: "Install the Claude Code session-bridge hook now?",
    initialValue: false,
  });

  if (p.isCancel(shouldInstall) || !shouldInstall) {
    p.log.info(color.dim(`Install later:  arcs hooks install-claude-code ${options.slug}`));
    return null;
  }

  try {
    const result = await installClaudeCodeHook(options);
    p.log.success(
      [
        `${color.green("✔")} Hook installed → ${color.cyan(result.settingsPath)}`,
        color.dim("Start a NEW Claude Code session to pick it up — running sessions won't."),
      ].join("\n"),
    );
    return result;
  } catch (err) {
    p.log.warn(
      [
        `${color.yellow("⚠")} Could not install the hook: ${err instanceof Error ? err.message : String(err)}`,
        color.dim(`Install manually later:  arcs hooks install-claude-code ${options.slug}`),
      ].join("\n"),
    );
    return null;
  }
}
