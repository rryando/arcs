/**
 * The wire contract shared by everything on the Claude Code session bridge:
 * the event names the hook is registered under, and the address it posts to.
 *
 * These values are duplicated across process boundaries by necessity — the
 * server validates them, the installer writes them into settings.json, and
 * `scripts/claude-code-session-hook.mjs` runs standalone under Claude Code with
 * no ARCS import available. Every duplicate that CAN import derives from here;
 * the one that cannot (the `.mjs`, which must stay dependency-free so a broken
 * bridge is inert rather than fatal) keeps its own literals and is pinned to
 * this module by `test/hook-contract-parity.test.ts`, which fails on any
 * divergence in either direction.
 */

/**
 * The four Claude Code events the bridge registers for. One script is installed
 * under all of them; it dispatches internally on `hook_event_name`.
 *
 * A readonly tuple so `z.enum()` consumes it directly — the route's validation
 * and the installer's registration can never drift apart. Adding a fifth event
 * here without adding it to the hook script breaks the parity test.
 */
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "SessionEnd", "Stop"] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Loopback only: `arcs web` refuses to bind anything else. */
export const DEFAULT_WEB_HOST = "127.0.0.1";

/** Default `arcs web` port, and therefore the port every hook is installed with. */
export const DEFAULT_WEB_PORT = 4173;

/**
 * Where an installed hook posts when `--url` was not given.
 *
 * Baked into the settings.json command string at install time, so changing it
 * only affects hooks installed afterwards — an already-installed hook keeps
 * posting to the URL it was written with.
 */
export const DEFAULT_SERVER_URL = `http://${DEFAULT_WEB_HOST}:${DEFAULT_WEB_PORT}`;
