// ---------------------------------------------------------------------------
// Command Registry — foundational type system and registry for CLI commands
// ---------------------------------------------------------------------------

export type ParamType = "string" | "number" | "boolean";

export interface ParamDef<TEnum extends readonly string[] = readonly string[]> {
  type: ParamType;
  required?: boolean | ((params: Record<string, unknown>) => boolean);
  positional?: number;
  default?: unknown;
  description: string;
  enum?: TEnum;
}

export type CLIResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string; hint?: string; usage?: string; param?: string };

export interface CommandFlags {
  json: boolean;
  lean: boolean;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Type-level: derive runtime param type from a ParamDef spec
// ---------------------------------------------------------------------------

/**
 * Base runtime value implied by `ParamDef.type`. Narrowed to enum literals
 * when `enum` is present (enum-typed params remain strings at runtime).
 */
type ParamBaseValue<P extends ParamDef> = P extends { enum: infer E extends readonly string[] }
  ? E[number]
  : P extends { type: "string" }
    ? string
    : P extends { type: "number" }
      ? number
      : P extends { type: "boolean" }
        ? boolean
        : never;

/**
 * A param is "always present" at the handler — i.e. not `T | undefined` — iff
 * the parser guarantees it via `required: true`, `default`, or a defaulting
 * coercion (booleans default to `false` when no flag is provided).
 *
 * Note: function-form `required` is conservatively treated as optional in the
 * type, since the runtime check is dynamic. Handlers using conditional-required
 * params should assert as needed.
 */
type ParamIsPresent<P extends ParamDef> = P extends { required: true }
  ? true
  : P extends { default: unknown }
    ? true
    : P extends { type: "boolean" }
      ? true
      : false;

export type ParsedParamValue<P extends ParamDef> =
  ParamIsPresent<P> extends true ? ParamBaseValue<P> : ParamBaseValue<P> | undefined;

/**
 * Mapped type that converts a `Record<string, ParamDef>` spec into the runtime
 * shape produced by the arg parser. Handlers can annotate their `params`
 * argument with `ParsedParams<typeof someSpec>` (with `as const` or `satisfies`)
 * to drop redundant `as string | undefined` casts.
 */
export type ParsedParams<T extends Record<string, ParamDef>> = {
  [K in keyof T]: ParsedParamValue<T[K]>;
};

// ---------------------------------------------------------------------------
// CommandDef — generic over its params spec for handler typing
// ---------------------------------------------------------------------------

export interface CommandDef<T extends Record<string, ParamDef> = Record<string, ParamDef>> {
  path: string;
  description: string;
  params: T;
  mutation?: boolean;
  errorCodes?: string[];
  handler: (params: ParsedParams<T>, flags: CommandFlags) => Promise<CLIResult>;
}

/**
 * Type-erased view of a CommandDef used by the registry's lookup/listing APIs
 * and by the generic dispatcher in `index.ts` / `dag-commands.ts`. The dispatcher
 * receives `Record<string, unknown>` from the parser and calls `handler`
 * uniformly — its handler signature drops type narrowing intentionally so the
 * parser output is structurally compatible.
 */
export interface AnyCommandDef {
  path: string;
  description: string;
  params: Record<string, ParamDef>;
  mutation?: boolean;
  errorCodes?: string[];
  handler: (params: Record<string, unknown>, flags: CommandFlags) => Promise<CLIResult>;
}

export const ERROR_CODES = {
  MISSING_PARAM: "missing_param",
  INVALID_TYPE: "invalid_type",
  INVALID_ENUM: "invalid_enum",
  UNKNOWN_FLAG: "unknown_flag",
  UNKNOWN_COMMAND: "unknown_command",
  PROJECT_NOT_FOUND: "project_not_found",
  ENTITY_NOT_FOUND: "entity_not_found",
  AMBIGUOUS_ARG: "ambiguous_arg",
  CREATE_ERROR: "create_error",
  UPDATE_ERROR: "update_error",
  DELETE_ERROR: "delete_error",
  TRANSITION_ERROR: "transition_error",
} as const;

// ---------------------------------------------------------------------------
// Registry internals
// ---------------------------------------------------------------------------

const commands = new Map<string, AnyCommandDef>();

export function defineCommand<const T extends Record<string, ParamDef>>(def: CommandDef<T>): void {
  if (!def.path || def.path.trim().length === 0) {
    throw new Error("Command path must be non-empty");
  }
  if (commands.has(def.path)) {
    throw new Error(`Duplicate command path: "${def.path}"`);
  }
  commands.set(def.path, def as unknown as AnyCommandDef);
}

export function getCommand(path: string): AnyCommandDef | undefined {
  return commands.get(path);
}

export function listCommands(): AnyCommandDef[] {
  return [...commands.values()];
}

export function suggestCommand(input: string): string | undefined {
  let best: string | undefined;
  let bestDist = 4; // threshold: distance must be <= 3
  for (const path of commands.keys()) {
    const d = levenshtein(input, path);
    if (d < bestDist) {
      bestDist = d;
      best = path;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Levenshtein distance (simple DP implementation)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}
