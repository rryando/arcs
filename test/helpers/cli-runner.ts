// ---------------------------------------------------------------------------
// CLI Runner — test helper that invokes commands through the registry path
// ---------------------------------------------------------------------------

import { parseArgs } from "../../src/cli/arg-parser.js";
import { type CLIResult, getCommand } from "../../src/cli/command-registry.js";
import { invokeCommand } from "../../src/cli/write-gate.js";

// Import command registrations (side-effect imports)
import "../../src/cli/commands/index.js";

/**
 * Run a CLI command through the registry and return the CLIResult directly.
 * Use this in new tests to verify envelope-format behavior.
 */
export async function runCommand(path: string, args: string[] = []): Promise<CLIResult> {
  const cmd = getCommand(path);
  if (!cmd) throw new Error(`Command not found in registry: ${path}`);

  const parsed = parseArgs(cmd, args);
  if (!parsed.ok) return parsed.error;

  // Early return for --help
  if (parsed.parsed.flags.help) {
    return { ok: true, data: { help: true, path: cmd.path, description: cmd.description } };
  }

  // Route through the shared choke point so tests exercise guarded-mode
  // enforcement exactly like the production dispatchers do.
  return invokeCommand(cmd, parsed.parsed.params, parsed.parsed.flags);
}
