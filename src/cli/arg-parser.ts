// ---------------------------------------------------------------------------
// Schema-driven argument parser for ARCS CLI commands
// ---------------------------------------------------------------------------

import {
  type AnyCommandDef,
  type CLIResult,
  type CommandDef,
  ERROR_CODES,
} from "./command-registry.js";

export interface ParsedArgs {
  params: Record<string, unknown>;
  flags: { json: boolean; lean: boolean; dryRun: boolean; help: boolean };
}

export type ParseResult = { ok: true; parsed: ParsedArgs } | { ok: false; error: CLIResult };

const _GLOBAL_FLAGS = new Set(["--json", "--lean", "--dry-run", "--help"]);

export function parseArgs(def: CommandDef | AnyCommandDef, rawArgs: string[]): ParseResult {
  const flags = { json: false, lean: false, dryRun: false, help: false };
  const params: Record<string, unknown> = {};
  const positionals: string[] = [];

  // First pass: extract global flags, collect remaining args
  const remaining: string[] = [];
  for (const arg of rawArgs) {
    if (arg === "--json") flags.json = true;
    else if (arg === "--lean") flags.lean = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--help") flags.help = true;
    else remaining.push(arg);
  }

  if (flags.help) return { ok: true, parsed: { params, flags } };

  // Second pass: parse named flags and positionals
  const paramNames = Object.keys(def.params);
  let i = 0;
  while (i < remaining.length) {
    const arg = remaining[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      const name = eqIdx >= 0 ? arg.slice(2, eqIdx) : arg.slice(2);
      if (!(name in def.params)) {
        const suggestion = suggestParam(name, paramNames);
        const hint = suggestion ? `Did you mean --${suggestion}?` : undefined;
        return {
          ok: false,
          error: {
            ok: false,
            code: ERROR_CODES.UNKNOWN_FLAG,
            message: `Unknown flag: --${name}`,
            hint,
            param: name,
          },
        };
      }
      if (eqIdx >= 0) {
        params[name] = arg.slice(eqIdx + 1);
      } else {
        const paramDef = def.params[name];
        if (paramDef.type === "boolean") {
          params[name] = true;
        } else if (i + 1 < remaining.length && !remaining[i + 1].startsWith("--")) {
          i++;
          params[name] = remaining[i];
        } else {
          params[name] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
    i++;
  }

  // Assign positionals to params and detect ambiguity
  const flagParams = new Set(Object.keys(params));
  const positionalParams = new Set<string>();
  for (const [name, paramDef] of Object.entries(def.params)) {
    if (paramDef.positional !== undefined && positionals[paramDef.positional] !== undefined) {
      positionalParams.add(name);
      if (!(name in params)) {
        params[name] = positionals[paramDef.positional];
      }
    }
  }

  // Conflict detection: param set by both positional and flag
  for (const name of positionalParams) {
    if (flagParams.has(name)) {
      return {
        ok: false,
        error: {
          ok: false,
          code: ERROR_CODES.AMBIGUOUS_ARG,
          message: `Ambiguous: '${name}' provided as both positional arg and --${name} flag. Use one style.`,
          param: name,
        },
      };
    }
  }

  // Type coercion
  for (const [name, paramDef] of Object.entries(def.params)) {
    if (!(name in params)) continue;
    const val = params[name];
    if (paramDef.type === "number" && typeof val === "string") {
      const n = Number(val);
      if (Number.isNaN(n)) {
        return {
          ok: false,
          error: {
            ok: false,
            code: ERROR_CODES.INVALID_TYPE,
            message: `--${name} must be a number`,
            param: name,
          },
        };
      }
      params[name] = n;
    } else if (paramDef.type === "boolean" && typeof val === "string") {
      params[name] = val !== "false";
    }
  }

  // Enum validation
  for (const [name, paramDef] of Object.entries(def.params)) {
    if (paramDef.enum && name in params) {
      if (!paramDef.enum.includes(params[name] as string)) {
        return {
          ok: false,
          error: {
            ok: false,
            code: ERROR_CODES.INVALID_ENUM,
            message: `Invalid value for --${name}`,
            hint: `Valid values: ${paramDef.enum.join(", ")}`,
            param: name,
          },
        };
      }
    }
  }

  // Defaults
  for (const [name, paramDef] of Object.entries(def.params)) {
    if (!(name in params) && paramDef.default !== undefined) {
      params[name] = paramDef.default;
    }
  }

  // Required check
  for (const [name, paramDef] of Object.entries(def.params)) {
    const isRequired =
      typeof paramDef.required === "function" ? paramDef.required(params) : paramDef.required;
    if (isRequired && !(name in params)) {
      return {
        ok: false,
        error: {
          ok: false,
          code: ERROR_CODES.MISSING_PARAM,
          message: `--${name} is required`,
          hint: generateUsage(def),
          param: name,
        },
      };
    }
  }

  return { ok: true, parsed: { params, flags } };
}

export function generateUsage(def: CommandDef | AnyCommandDef): string {
  const parts = [`Usage: arcs ${def.path}`];
  const sorted = Object.entries(def.params).sort(([, a], [, b]) => {
    if (a.positional !== undefined && b.positional !== undefined)
      return a.positional - b.positional;
    if (a.positional !== undefined) return -1;
    if (b.positional !== undefined) return 1;
    return 0;
  });
  for (const [name, paramDef] of sorted) {
    const upper = name.toUpperCase();
    if (paramDef.positional !== undefined && paramDef.required) {
      parts.push(`<${name}>`);
    } else if (paramDef.required) {
      parts.push(`--${name}=${upper}`);
    } else if (paramDef.positional === undefined) {
      parts.push(`[--${name}=${upper}]`);
    }
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Levenshtein + suggestion helper
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

function suggestParam(input: string, names: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = 3;
  for (const name of names) {
    const d = levenshtein(input, name);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}
