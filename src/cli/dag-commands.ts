// ---------------------------------------------------------------------------
// DAG CLI Command Handlers — Thin delegation shell
// ---------------------------------------------------------------------------
// All commands are now in the registry (src/cli/commands/*.ts).
// This file provides backward-compatible exports for tests and the fallback
// router in src/cli/index.ts.
// ---------------------------------------------------------------------------

import { parseArgs } from "./arg-parser.js";
import { type AnyCommandDef, getCommand } from "./command-registry.js";
import { isLeanMode } from "./lean-output.js";
import { render, stripTimestamps } from "./output-envelope.js";
import "./commands/index.js";

function cliError(msg: string): void {
  console.error(msg);
}

function printUsage(): void {
  console.log("Usage: arcs <command> [subcommand] [options]\n");
  console.log("Run 'arcs --commands --json' for a full command list.");
}

// ---------------------------------------------------------------------------
// Dispatcher — delegates all commands to the registry
// ---------------------------------------------------------------------------

/**
 * Dispatches DAG CLI subcommands via the registry. Returns true if handled.
 * Kept as export for backward compatibility with src/cli/index.ts and tests.
 */
export async function handleDagCommand(command: string, args: string[]): Promise<boolean> {
  // Extract global flags
  const rest: string[] = [];
  let json = false;
  let lean = false;

  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--lean") lean = true;
    else if (arg === "--dry-run") {
      /* consumed */
    } else rest.push(arg);
  }

  if (!lean && isLeanMode([])) lean = true;

  // Delegate to registry
  const firstPositional = rest.find((a) => !a.startsWith("-"));
  let registeredCmd: AnyCommandDef | undefined;
  let remaining: string[];

  if (firstPositional) {
    const twoWord = `${command} ${firstPositional}`;
    const cmd = getCommand(twoWord);
    if (cmd) {
      registeredCmd = cmd;
      remaining = [];
      let removed = false;
      for (const a of rest) {
        if (!removed && a === firstPositional) {
          removed = true;
          continue;
        }
        remaining.push(a);
      }
    }
  }
  if (!registeredCmd) {
    const cmd = getCommand(command);
    if (cmd) {
      registeredCmd = cmd;
      remaining = rest;
    }
  }
  if (!registeredCmd) {
    // Known DAG commands without a matching registry entry
    const knownCommands = [
      "task",
      "plan",
      "knowledge",
      "diagram",
      "doc",
      "dependency",
      "paths",
      "loop",
      "project",
    ];
    if (knownCommands.includes(command)) {
      if (rest.includes("--help")) {
        printUsage();
      } else if (firstPositional) {
        cliError(`Error: unknown ${command} subcommand "${firstPositional}"`);
        process.exitCode = 1;
      } else {
        cliError(`Error: missing subcommand for "${command}". Use --help for usage.`);
        process.exitCode = 1;
      }
      return true;
    }
    return false;
  }

  // Re-inject global flags for parseArgs
  const fullArgs = [...remaining!];
  if (json) fullArgs.push("--json");
  if (lean) fullArgs.push("--lean");

  const result = parseArgs(registeredCmd, fullArgs);
  if (!result.ok) {
    // Format error in legacy style for backward compatibility
    const err = result.error as {
      ok: false;
      code: string;
      message: string;
      hint?: string;
      param?: string;
    };
    let errMsg: string;
    if (err.code === "invalid_enum" && err.param) {
      errMsg = `Error: invalid ${err.param} "${(fullArgs.find((a) => a.startsWith(`--${err.param}=`)) || "").split("=")[1] || ""}"`;
      if (err.hint) errMsg += `. ${err.hint}`;
    } else {
      const hint = err.hint ? err.hint.replace(/^Usage:/, "usage:") : undefined;
      errMsg = hint ? `${err.message} — ${hint}` : err.message;
    }
    cliError(errMsg);
    process.exitCode = 1;
    return true;
  }

  if (result.parsed.flags.help) {
    // Let the main router handle --help
    return false;
  }

  const cmdResult = await registeredCmd.handler(result.parsed.params, result.parsed.flags);
  if (cmdResult.ok) {
    const flags = result.parsed.flags;
    if (flags.json) {
      const data = flags.lean ? stripTimestamps(cmdResult.data) : cmdResult.data;
      console.log(JSON.stringify(data));
    } else {
      const data = cmdResult.data;
      if (typeof data === "string") {
        console.log(data);
      } else if (data !== null && data !== undefined) {
        console.log(JSON.stringify(data, null, 2));
      }
    }
    return true;
  }
  // Error — render via envelope for consistent error formatting
  render(cmdResult, { json, lean });
  process.exitCode = 1;
  return true;
}
