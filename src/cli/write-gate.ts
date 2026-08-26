// ---------------------------------------------------------------------------
// Write gate — opt-in guarded mode for mutating commands (ARCS_GUARDED=1)
// ---------------------------------------------------------------------------

import type { CLIResult } from "./command-registry.js";
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
