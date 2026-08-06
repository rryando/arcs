/**
 * Pins `scripts/claude-code-session-hook.mjs` to `src/utils/hook-contract.ts`.
 *
 * The hook script is deployed standalone into a user's settings.json and must
 * stay import-free (its hard rule is that a broken bridge is inert, and an
 * import is a way to violate it), so it carries its own copy of the event list
 * and the default server URL. Everything else on the bridge derives from the
 * contract module; this file is what stops that last copy from drifting.
 *
 * The check parses the script SOURCE rather than importing it — importing would
 * execute a program that reads stdin and posts to the network. Both directions
 * are failures: an event the contract declares and the script drops silently
 * stops reaching ARCS, and an event the script sends and the contract lacks is
 * rejected by the route's schema.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_URL, HOOK_EVENTS } from "../src/utils/hook-contract.js";

const SCRIPT_PATH = resolve(import.meta.dirname, "..", "scripts", "claude-code-session-hook.mjs");
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, "utf-8");

/** `const EVENTS = new Set([ ... ])` — captures the array body, newlines included. */
const EVENTS_BLOCK_PATTERN = /const EVENTS = new Set\(\[([^\]]*)\]\)/;
/** `const DEFAULT_URL = "..."` */
const DEFAULT_URL_PATTERN = /const DEFAULT_URL = "([^"]+)"/;
const STRING_LITERAL_PATTERN = /"([^"]*)"/g;

/**
 * Throws rather than returning `[]` when the declaration is missing: a regex
 * that quietly matches nothing would let this whole file pass forever.
 */
function extractScriptEvents(source: string): string[] {
  const block = EVENTS_BLOCK_PATTERN.exec(source);
  if (!block) {
    throw new Error(`No \`const EVENTS = new Set([...])\` declaration found in ${SCRIPT_PATH}`);
  }
  return [...block[1].matchAll(STRING_LITERAL_PATTERN)].map((match) => match[1]);
}

function extractScriptDefaultUrl(source: string): string {
  const match = DEFAULT_URL_PATTERN.exec(source);
  if (!match) {
    throw new Error(`No \`const DEFAULT_URL = "..."\` declaration found in ${SCRIPT_PATH}`);
  }
  return match[1];
}

/** Order is meaningless on both sides (a Set vs. a registration list). */
const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("hook contract parity: extraction is not vacuous", () => {
  it("reads the real hook script", () => {
    expect(SCRIPT_SOURCE.length).toBeGreaterThan(0);
    expect(SCRIPT_SOURCE).toContain("ARCS_HOOK_URL");
  });

  it("pulls a plausible event list out of it", () => {
    const events = extractScriptEvents(SCRIPT_SOURCE);

    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.every((event) => event.trim().length > 0)).toBe(true);
    expect(new Set(events).size).toBe(events.length);
  });

  it("pulls a plausible default URL out of it", () => {
    expect(extractScriptDefaultUrl(SCRIPT_SOURCE)).toMatch(/^https?:\/\/[^\s/]+:\d+$/);
  });
});

describe("hook contract parity: script matches src/utils/hook-contract.ts", () => {
  it("forwards exactly the events the contract declares", () => {
    expect(sorted(extractScriptEvents(SCRIPT_SOURCE))).toEqual(sorted(HOOK_EVENTS));
  });

  it("defaults to the contract's server URL", () => {
    expect(extractScriptDefaultUrl(SCRIPT_SOURCE)).toBe(DEFAULT_SERVER_URL);
  });

  it("documents that same default URL in its env docstring", () => {
    // The docstring is what a user reads before overriding ARCS_HOOK_URL, so a
    // stale one is a support burden even though nothing executes it.
    expect(SCRIPT_SOURCE).toContain(`(default ${DEFAULT_SERVER_URL})`);
  });
});

describe("hook contract parity: divergence is detected in both directions", () => {
  /** A minimal stand-in for the script's two declarations. */
  const scriptWith = (events: readonly string[], url: string): string =>
    `const DEFAULT_URL = "${url}";\nconst EVENTS = new Set(${JSON.stringify(events)});\n`;

  it("round-trips an in-parity source", () => {
    const source = scriptWith(HOOK_EVENTS, DEFAULT_SERVER_URL);

    expect(sorted(extractScriptEvents(source))).toEqual(sorted(HOOK_EVENTS));
    expect(extractScriptDefaultUrl(source)).toBe(DEFAULT_SERVER_URL);
  });

  it("catches a fifth event added to the script but not the contract", () => {
    const events = extractScriptEvents(
      scriptWith([...HOOK_EVENTS, "PreToolUse"], DEFAULT_SERVER_URL),
    );

    expect(sorted(events)).not.toEqual(sorted(HOOK_EVENTS));
  });

  it("catches an event the contract declares but the script dropped", () => {
    const events = extractScriptEvents(scriptWith(HOOK_EVENTS.slice(0, -1), DEFAULT_SERVER_URL));

    expect(sorted(events)).not.toEqual(sorted(HOOK_EVENTS));
  });

  it("catches a default URL that drifted", () => {
    // Derived from the contract rather than hardcoded, so this stays a real
    // negative even if the contract's own port changes to whatever was typed.
    const otherUrl = `${DEFAULT_SERVER_URL}0`;

    expect(extractScriptDefaultUrl(scriptWith(HOOK_EVENTS, otherUrl))).not.toBe(DEFAULT_SERVER_URL);
  });

  it("fails loudly instead of silently when a declaration disappears", () => {
    expect(() => extractScriptEvents("// the script was rewritten")).toThrow(/EVENTS/);
    expect(() => extractScriptDefaultUrl("// the script was rewritten")).toThrow(/DEFAULT_URL/);
  });
});
