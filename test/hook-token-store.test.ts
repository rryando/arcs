/**
 * On-disk protection for the per-project hook token.
 *
 * The hook token has no in-memory-only mode the way the web token does: the
 * hook subprocess re-reads this file at every checkpoint, so the file IS the
 * credential and its mode is the whole control. A `stat` on a real install once
 * showed 0644 — `writeJson` renames a temp file into place and never chmods —
 * which is what these assertions exist to keep from coming back.
 *
 * 0o600 is a cross-user control: it stops another UNIX account (and any
 * `ps`-style snooping is a separate concern, handled by never putting the token
 * on an argv). It is NOT a defense against another process running as this same
 * user — that process can read the file whatever the mode is.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hookTokenPath, readHookToken, writeHookToken } from "../src/utils/hook-token-store.js";

/** A bare project dir — the store takes an explicit path, never $ARCS_DATA. */
async function withProjectDir(run: (projectDir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(resolve(tmpdir(), "arcs-hook-token-"));
  try {
    await run(resolve(dir, "projects", "demo"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("hook token store", () => {
  it("writes a fresh token file owner-only", async () => {
    await withProjectDir(async (projectDir) => {
      await writeHookToken(projectDir, "fresh-token-0123456789");

      const path = hookTokenPath(projectDir);
      expect(await readHookToken(projectDir)).toBe("fresh-token-0123456789");
      expect(mode(path)).toBe(0o600);
      // The staged temp file is created inside this directory, so it is born
      // world-readable for the moment before the rename + chmod land. An
      // owner-only directory is what makes that window unreachable.
      expect(mode(dirname(path))).toBe(0o700);
    });
  });

  it("repairs a pre-existing world-readable token file on the next write", async () => {
    await withProjectDir(async (projectDir) => {
      // Exactly what an older build left behind: 0644, written through the
      // generic writeJson path.
      const path = hookTokenPath(projectDir);
      mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
      writeFileSync(
        path,
        JSON.stringify({ token: "stale", createdAt: "2026-01-01T00:00:00.000Z" }),
        { encoding: "utf-8", mode: 0o644 },
      );
      expect(mode(path)).toBe(0o644);

      await writeHookToken(projectDir, "rotated-token-0123456789");

      // `writeJson` stages a temp file and renames it into place, so the
      // destination is a freshly created inode on EVERY write: its mode comes
      // from the umask (0644 here) and the pre-existing file's mode is
      // discarded with the inode it belonged to. A mode passed at open() would
      // in fact have covered this writer, precisely because every write creates
      // the destination inode; the "applies only at create" caveat bites a
      // direct non-atomic open(path,"w",mode) over an existing file, which is
      // not this path. The chmod is unconditional anyway, so the 0600 guarantee
      // survives a future switch away from the atomic writer.
      expect(mode(path)).toBe(0o600);
      expect(mode(dirname(path))).toBe(0o700);
      expect(await readHookToken(projectDir)).toBe("rotated-token-0123456789");
    });
  });
});
