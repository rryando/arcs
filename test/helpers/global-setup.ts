/**
 * Vitest globalSetup — runs once in the main test process before any worker
 * is spawned. Workers inherit the env we set here.
 *
 * Why: tests that read or write project DAG data go through `getDataDir()`
 * (`src/utils/paths.ts`), which falls back to `~/.arcs` when `ARCS_DATA_DIR`
 * is unset. A test that forgets the `withTempDataDir` helper would silently
 * pollute the developer's real data directory.
 *
 * What this does:
 *   1. Refuses to run if `ARCS_DATA_DIR` already points at the real `~/.arcs`.
 *   2. Creates one sandbox dir under `os.tmpdir()` and exports it via
 *      `ARCS_DATA_DIR`. `withTempDataDir` still nests on top — it saves and
 *      restores the env var, so per-test overrides remain isolated.
 *   3. Sets `ARCS_SKIP_CODEGRAPH=1` and `ARCS_SKIP_RTK=1` so tests never
 *      shell out to codegraph or rtk.
 *   4. Removes the sandbox on teardown.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

export default function setup(): () => void {
  const explicit = process.env.ARCS_DATA_DIR;
  const realHome = resolve(homedir(), ".arcs");
  if (explicit && resolve(explicit) === realHome) {
    throw new Error(
      `Refusing to run tests with ARCS_DATA_DIR pointing at ${realHome}. ` +
        `Unset ARCS_DATA_DIR or point it at a temp path.`,
    );
  }

  const sandbox = mkdtempSync(resolve(tmpdir(), "arcs-test-sandbox-"));
  writeFileSync(
    resolve(sandbox, "meta.json"),
    JSON.stringify({ version: "1.0", projects: [] }, null, 2),
    "utf-8",
  );

  process.env.ARCS_DATA_DIR = sandbox;
  process.env.ARCS_SKIP_CODEGRAPH = "1";
  process.env.ARCS_SKIP_RTK = "1";

  return () => {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; teardown shouldn't block on it.
    }
  };
}
