/**
 * Intent → argv permission policy for headless `claude -p` runs.
 *
 * Safety in the session bridge is argv-shaped, and this module is the SINGLE
 * place tool and permission flags are produced: `claude-runner.ts` stays
 * argv-agnostic and no route hand-assembles a more permissive run. Every token
 * emitted here comes from a closed set of module constants — the one
 * caller-supplied token is the staged system prompt, and it is kept
 * unambiguously a value (see asValueToken). Bypass flags are therefore
 * unreachable from HTTP input by construction rather than by convention, and
 * `test/permission-policy.test.ts` drives the builder with hostile
 * HTTP-shaped payloads to keep it that way.
 *
 * Flags verified against claude 2.1.223: `--tools <tools...>` takes a
 * comma-separated built-in tool list, `--permission-mode` accepts "plan" and
 * "acceptEdits", and `--append-system-prompt` appends to (never replaces) the
 * system prompt. `--cwd` is deliberately absent — claude >= 2.x rejects it, and
 * the runner applies the working directory through spawn options.cwd instead.
 */

/** Accepted run intents. Also the source list for route-level zod validation. */
export const RUN_INTENTS = ["ask", "change"] as const;

export type RunIntent = (typeof RUN_INTENTS)[number];

/** `ask`: inspect the workspace, never touch it. */
const ASK_TOOLS = ["Read", "Grep", "Glob"] as const;

/**
 * `change`: the read-only set plus the edit surface. Bash is deliberately NOT
 * here — it is opt-in per run, so a change run cannot shell out by default.
 */
const CHANGE_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "TodoWrite"] as const;

/** Appended last, and only on an explicit `allowBash === true`. */
const BASH_TOOL = "Bash";

const INTENT_TOOLS: Record<RunIntent, readonly string[]> = {
  ask: ASK_TOOLS,
  change: CHANGE_TOOLS,
};

/** `plan` cannot edit; `acceptEdits` auto-accepts edits but not shell commands.
 *  "bypassPermissions" is not reachable from this map — that is the point. */
const INTENT_PERMISSION_MODES: Record<RunIntent, string> = {
  ask: "plan",
  change: "acceptEdits",
};

/**
 * The untrusted slice of a run request. Every field is `unknown` because this
 * is an HTTP body: the builder reads exactly `intent`, `allowBash` and
 * `stagedSystemPrompt` and ignores everything else a caller sends.
 */
export interface PermissionArgvInput {
  /** `"change"` exactly, or the run degrades to the read-only `ask` policy. */
  intent?: unknown;
  /** Bash opt-in. Only the boolean `true` counts — `"true"`, `1` and `[]` do not. */
  allowBash?: unknown;
  /** Staged environment text for `--append-system-prompt`; W2's
   *  buildStagedEnvironment().text fills this slot. Emitted only when it is a
   *  non-empty string. */
  stagedSystemPrompt?: unknown;
  /** Unrecognized request keys are accepted and ignored, never forwarded. */
  [key: string]: unknown;
}

/**
 * Builds the tool/permission argv segment for one run. The caller concatenates
 * it onto the rest of its argv (`-p`, `--resume`, `--output-format`, …); this
 * module owns nothing else.
 */
export function buildPermissionArgv(input: PermissionArgvInput = {}): string[] {
  const fields = asRecord(input);
  const intent = normalizeIntent(fields.intent);

  const tools = [...INTENT_TOOLS[intent]];
  if (fields.allowBash === true) tools.push(BASH_TOOL);

  const argv = ["--tools", tools.join(","), "--permission-mode", INTENT_PERMISSION_MODES[intent]];

  const staged =
    typeof fields.stagedSystemPrompt === "string" ? fields.stagedSystemPrompt.trim() : "";
  if (staged) argv.push("--append-system-prompt", asValueToken(staged));

  return argv;
}

/**
 * Fails closed: anything that is not exactly `"change"` runs read-only. The
 * route's zod enum rejects malformed intents with a 400 first — this is the
 * second line, so a caller that skips validation cannot widen the run.
 */
function normalizeIntent(value: unknown): RunIntent {
  return value === "change" ? "change" : "ask";
}

/**
 * Keeps a caller-supplied value from ever being flag-shaped. Staged text is the
 * only argv token ARCS does not author character-for-character, so a message of
 * exactly `--dangerously-skip-permissions` arrives at claude's option parser in
 * a position where only that parser's rules decide whether it reads as a value
 * or as a flag.
 *
 * This prefix closes no hole that exists today, and an earlier version of this
 * comment was wrong to claim it did. A live probe against claude 2.1.223:
 * `claude --append-system-prompt --output-format json -p "…"` printed plain
 * text where the control printed JSON — meaning the CLI had already swallowed
 * the dash-leading `--output-format` as the VALUE of `--append-system-prompt`
 * instead of reading it as an option. The installed parser is safe unaided.
 *
 * It is kept for version-independence, not as a bug fix. "An option's argument
 * may itself begin with a dash" is an undocumented parser detail that a minor
 * CLI upgrade could reverse with no breaking-change note, and the blast radius
 * if it ever does is a permission flag from HTTP input. A single leading
 * newline keeps every byte of the text while making the token unambiguously a
 * value under either rule.
 */
function asValueToken(text: string): string {
  return text.startsWith("-") ? `\n${text}` : text;
}

/** Tolerates any runtime shape an HTTP body can take (null, array, scalar). */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
