// ---------------------------------------------------------------------------
// Help Generator — per-command help and --commands discovery
// ---------------------------------------------------------------------------

import {
  type AnyCommandDef,
  type CommandDef,
  ERROR_CODES,
  listCommands,
  type ParamDef,
} from "./command-registry.js";

export interface CommandDiscovery {
  commands: Array<{
    path: string;
    description: string;
    params: Record<
      string,
      {
        type: string;
        required: boolean;
        positional?: number;
        default?: unknown;
        description: string;
        enum?: readonly string[];
      }
    >;
    mutation?: boolean;
  }>;
  errorCodes: string[];
}

export function generateCommandHelp(def: CommandDef | AnyCommandDef): string {
  const lines: string[] = [];
  lines.push(`arcs ${def.path} — ${def.description}`);
  lines.push("");

  // Build usage line
  const positionals: [number, string, ParamDef][] = [];
  const requiredFlags: [string, ParamDef][] = [];
  const optionalFlags: [string, ParamDef][] = [];

  for (const [name, p] of Object.entries(def.params)) {
    if (p.positional != null) {
      positionals.push([p.positional, name, p]);
    } else if (p.required) {
      requiredFlags.push([name, p]);
    } else {
      optionalFlags.push([name, p]);
    }
  }
  positionals.sort((a, b) => a[0] - b[0]);

  const usageParts = [`arcs ${def.path}`];
  for (const [, name] of positionals) usageParts.push(`<${name}>`);
  for (const [name, p] of requiredFlags) usageParts.push(`--${name}=${p.type.toUpperCase()}`);
  for (const [name, p] of optionalFlags) usageParts.push(`[--${name}=${p.type.toUpperCase()}]`);
  // --token is a universal flag consumed by invokeCommand, not a declared param
  if (def.mutation) usageParts.push("[--token=TOKEN]");

  lines.push(`Usage: ${usageParts.join(" ")}`);
  lines.push("");
  lines.push("Parameters:");

  const paramLines: [string, string][] = [];
  for (const [, name, p] of positionals) {
    const meta = buildMeta(p);
    paramLines.push([`  <${name}>`, meta]);
  }
  for (const [name, p] of [...requiredFlags, ...optionalFlags]) {
    const meta = buildMeta(p);
    paramLines.push([`  --${name}=${p.type.toUpperCase()}`, meta]);
  }

  const maxCol = Math.max(...paramLines.map(([l]) => l.length));
  for (const [col1, col2] of paramLines) {
    lines.push(`${col1.padEnd(maxCol + 2)}${col2}`);
  }

  lines.push("");
  lines.push("Global flags:");
  lines.push("  --json        Output as JSON");
  lines.push("  --lean        Strip timestamps for token efficiency");
  lines.push("  --dry-run     Validate params without side effects");
  lines.push("  --help        Show this help");

  return lines.join("\n");
}

function buildMeta(p: ParamDef): string {
  const parts = [`(${p.type}`];
  parts.push(p.required ? ", required" : ", optional");
  if (p.default !== undefined) parts.push(`, default: ${JSON.stringify(p.default)}`);
  parts.push(`) ${p.description}`);
  if (p.enum) parts.push(` [${p.enum.join(", ")}]`);
  return parts.join("");
}

export function generateCommandsDiscovery(): CommandDiscovery {
  return {
    commands: listCommands().map((def) => ({
      path: def.path,
      description: def.description,
      params: Object.fromEntries(
        Object.entries(def.params).map(([name, p]) => [
          name,
          {
            type: p.type,
            required: typeof p.required === "function" ? true : (p.required ?? false),
            ...(p.positional != null ? { positional: p.positional } : {}),
            ...(p.default !== undefined ? { default: p.default } : {}),
            description: p.description,
            ...(p.enum ? { enum: p.enum } : {}),
          },
        ]),
      ),
      ...(def.mutation != null ? { mutation: def.mutation } : {}),
      ...(def.errorCodes ? { errorCodes: def.errorCodes } : {}),
    })),
    errorCodes: Object.values(ERROR_CODES),
  };
}

export function formatCommandsDiscovery(discovery: CommandDiscovery, json: boolean): string {
  if (json) return JSON.stringify(discovery, null, 2);
  const lines: string[] = ["Available commands:"];
  const maxPath = Math.max(...discovery.commands.map((c) => c.path.length));
  for (const cmd of discovery.commands) {
    lines.push(`  ${cmd.path.padEnd(maxPath + 2)}${cmd.description}`);
  }
  lines.push("");
  lines.push("Use 'arcs <command> --help' for details.");
  return lines.join("\n");
}
