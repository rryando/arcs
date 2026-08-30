/**
 * Runners route: the drivable one-shot runtime surface, for the web UI's
 * Ask-AI runtime picker.
 *
 * Lives in its own file ON PURPOSE — the sessions routes file is deleted by
 * another task soon, and this read-only surface must not ride along with it.
 * It enumerates the run-driver registry (run-driver.ts) rather than a
 * maintained list, so a driver registered later shows up automatically, and
 * probes each driver's binary with `which` at request time so the UI can show
 * what is actually installed on this machine. Never throws: a missing binary
 * answers `available: false`.
 */

import { spawnSync } from "node:child_process";
import { Hono } from "hono";
import { ok } from "../respond.js";
import { getRunDriver, getRunDriverRuntimeTypes } from "../run-driver.js";

/**
 * Display labels for the drivable runtimes. Unknown types fall back to their
 * registry id — a future driver still renders rather than erroring.
 */
const RUNNER_LABELS: Record<string, string> = {
  pi: "pi",
  opencode: "opencode",
  "claude-code": "claude code",
  codex: "codex",
};

/**
 * Whether the binary is resolvable on PATH. `which` exits 0 when found,
 * nonzero (1 for "not found", 127 for a missing `which` itself) otherwise;
 * any spawn failure also answers false. Never throws.
 */
function binaryAvailable(binary: string): boolean {
  try {
    return spawnSync("which", [binary], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export const runnersRoute = new Hono();

runnersRoute.get("/api/runners", (c) =>
  c.json(
    ok({
      runners: getRunDriverRuntimeTypes().map((runtimeType) => {
        const driver = getRunDriver(runtimeType);
        const binary = driver?.binary ?? runtimeType;
        return {
          id: runtimeType,
          label: RUNNER_LABELS[runtimeType] ?? runtimeType,
          binary,
          available: binaryAvailable(binary),
        };
      }),
    }),
  ),
);
