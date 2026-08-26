import "./commands/index.js"; // Trigger command registrations
import { parseArgs } from "./arg-parser.js";
import { getCommand } from "./command-registry.js";
import { handleDagCommand, KNOWN_DAG_COMMANDS } from "./dag-commands.js";
import {
  formatCommandsDiscovery,
  generateCommandHelp,
  generateCommandsDiscovery,
} from "./help-generator.js";
import { render } from "./output-envelope.js";
import { runSetup } from "./setup.js";
import { invokeCommand } from "./write-gate.js";

// ---------------------------------------------------------------------------
// CLI Subcommand Router
// ---------------------------------------------------------------------------

/**
 * Determine the longest-match command path from raw args.
 * Tries 3-word, 2-word, then 1-word path. This handles commands like
 * `knowledge search bm25` or `proposal-doc create` as registry entries.
 */
function determineCommandPath(args: string[]): { path: string; remaining: string[] } | undefined {
  // Try at most 3 words as the command path (e.g. "knowledge search bm25")
  const maxWords = Math.min(args.length, 3);
  for (let n = maxWords; n >= 1; n--) {
    const path = args.slice(0, n).join(" ");
    if (getCommand(path)) {
      return { path, remaining: args.slice(n) };
    }
  }
  return undefined;
}

/**
 * Entry point for `npx arcs init`, `npx arcs config`.
 * Returns true if a CLI subcommand was handled, false if the caller
 * should proceed with normal exit.
 */
export async function handleCli(args: string[]): Promise<boolean> {
  const command = args[0];

  // --commands discovery
  if (args.includes("--commands")) {
    const json = args.includes("--json");
    const discovery = generateCommandsDiscovery();
    if (json) {
      console.log(JSON.stringify({ ok: true, data: discovery }));
    } else {
      console.log(formatCommandsDiscovery(discovery, false));
    }
    return true;
  }

  // Registry-first routing
  const match = determineCommandPath(args);
  if (match) {
    const registeredCmd = getCommand(match.path)!;
    const result = parseArgs(registeredCmd, match.remaining);
    if (!result.ok) {
      const flags = {
        json: match.remaining.includes("--json"),
        lean: match.remaining.includes("--lean"),
      };
      render(result.error, flags, match.path);
      process.exitCode = 1;
      return true;
    }
    if (result.parsed.flags.help) {
      console.log(generateCommandHelp(registeredCmd));
      return true;
    }
    const cmdResult = await invokeCommand(registeredCmd, result.parsed.params, result.parsed.flags);
    render(cmdResult, result.parsed.flags, match.path);
    if (!cmdResult.ok) process.exitCode = 1;
    return true;
  }

  switch (command) {
    case "init":
      await runSetup("init");
      return true;

    case "config":
      await runSetup("config");
      return true;

    default:
      if (KNOWN_DAG_COMMANDS.includes(command as (typeof KNOWN_DAG_COMMANDS)[number])) {
        return handleDagCommand(command, args.slice(1));
      }
      return false;
  }
}
