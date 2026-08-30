/**
 * Runners route: the drivable one-shot runtime surface, for the web UI's
 * Ask-AI runtime picker.
 *
 * Lives in its own file ON PURPOSE — the sessions routes file is deleted by
 * another task soon, and this read-only surface must not ride along with it.
 * It enumerates the run-driver registry (run-driver.ts) rather than a
 * maintained list, so a driver registered later shows up automatically, and
 * probes each driver's binary on PATH at request time so the UI can show
 * what is actually installed on this machine. Never throws: a missing binary
 * answers `available: false`.
 */

import { statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
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
 * Whether a binary is resolvable on PATH.
 *
 * A PATH scan in pure Node (no `which` subprocess): each PATH entry is checked
 * for an executable file of that name, `statSync`-guarded so a missing or
 * unreadable entry skips silently. `stat.mode & 0o111` mirrors `which`'s
 * executability rule on POSIX; on win32 any existing file counts (spawn would
 * resolve it), which keeps the probe total across platforms. Never throws.
 */
function binaryAvailable(binary: string): boolean {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry.trim() === "") continue;
    try {
      const stat = statSync(resolve(entry, binary));
      if (stat.isFile()) {
        return process.platform === "win32" || (stat.mode & 0o111) !== 0;
      }
    } catch {
      // Not a file here — keep scanning PATH.
    }
  }
  return false;
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
