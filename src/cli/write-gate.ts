// ---------------------------------------------------------------------------
// Write gate — opt-in guarded mode for mutating commands (ARCS_GUARDED=1)
// ---------------------------------------------------------------------------

import type { AnyCommandDef, CLIResult, CommandFlags } from "./command-registry.js";
import { failure } from "./output-envelope.js";

/**
 * Guarded-mode ceremony (opt-in via ARCS_GUARDED=1): mutating commands demand
 * an explicit --token from the orchestrator before writes proceed. By default
 * (no ARCS_GUARDED) writes go through without ceremony.
 *
 * Returns null when the write may proceed; otherwise a failure result the
 * handler must propagate.
 */
export function requireWriteGate(token: string | undefined): CLIResult | null {
  if (process.env.ARCS_GUARDED !== "1") return null;
  if (!token || token.trim().length === 0) {
    return failure(
      "missing_token",
      "Guarded mode is active (ARCS_GUARDED=1): --token is required",
      {
        hint: "Pass the orchestrator-issued token via --token <value>, or unset ARCS_GUARDED.",
      },
    );
  }
  return null;
}

/**
 * Single invocation choke point for registry commands. Mutating commands
 * (declared via `mutation: true`) are gated through requireWriteGate before
 * their handler runs, so guarded mode is enforced uniformly regardless of
 * which dispatcher (index router, DAG shell, test runner) drives the command.
 *
 * All entry points MUST route handler calls through this function.
 */
export async function invokeCommand(
  cmd: AnyCommandDef,
  params: Record<string, unknown>,
  flags: CommandFlags,
): Promise<CLIResult> {
  if (cmd.mutation) {
    const gate = requireWriteGate(flags.token);
    if (gate) return gate;
  }
  return cmd.handler(params, flags);
}
