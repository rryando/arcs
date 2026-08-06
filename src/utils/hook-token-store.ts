/**
 * Per-project auth token for the Claude Code session-bridge hook endpoint.
 *
 * Loopback-only is not enough on its own: every process on the machine shares
 * localhost, so any local program could otherwise register sessions or drain a
 * project's message queue. The token proves the caller is the hook script that
 * `arcs hooks install-claude-code` provisioned for this project.
 *
 * Intentionally not a CRUD store — one token per project, rotated by rerunning
 * the install command. No index, no markdown mirror, no lock (a rotation races
 * only with itself, and the loser simply has to rerun install).
 */

import { timingSafeEqual } from "node:crypto";
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonSafe } from "./json.js";
import { ensureDir, nowISO, writeJson } from "./storage-utils.js";

interface HookTokenFile {
  token: string;
  createdAt: string;
}

export function hookTokenPath(projectDir: string): string {
  return join(projectDir, "hooks", "claude-code-token.json");
}

export async function readHookToken(projectDir: string): Promise<string | undefined> {
  const file = await readJsonSafe<HookTokenFile>(hookTokenPath(projectDir));
  return typeof file?.token === "string" && file.token ? file.token : undefined;
}

/**
 * Rotates the on-disk token, owner-only.
 *
 * Unlike the web token there is no in-memory copy to verify against — the hook
 * subprocess re-reads this file at every checkpoint, so the FILE is the
 * credential and its mode is the whole control. `writeJson` stages a temp file
 * and renames it into place with no mode argument, so the token lands 0644
 * (world-readable) on a default umask — and it lands that way on EVERY write,
 * not just the first: the rename swaps in the freshly created temp inode, whose
 * mode came from the umask, and the previous file's mode is discarded with the
 * inode it belonged to. (A mode passed at open() would in fact have covered this
 * writer, precisely because every write creates the destination inode; the
 * "applies only at create" caveat bites a direct non-atomic open(path,"w",mode)
 * over an existing file, which is not this path.) The chmod is nonetheless
 * unconditional rather than conditional on the mode read back, so the 0600
 * guarantee survives a future switch away from the atomic writer.
 *
 * The directory is narrowed too: the staged temp file is a fresh inode born
 * under the umask, so it is briefly world-readable between write and rename.
 * 0o700 on the enclosing directory — which holds nothing but this token —
 * denies another account the traversal needed to reach that window at all.
 *
 * What this buys, stated honestly: 0o600 is a cross-user control. It keeps
 * other UNIX accounts out; it is NOT a defense against a process running as
 * THIS user, which can read the file at any mode. Nor is this the token's only
 * copy — `arcs hooks install-claude-code --write` embeds the same value in the
 * workspace's .claude/settings.local.json, which is still written under the
 * plain umask. So this is a floor on ARCS's own copy, not a guarantee about the
 * secret.
 *
 * A chmod failure propagates and fails the install command. That is
 * deliberate — the caller (`arcs hooks install-claude-code`) has not printed
 * the snippet yet, so the run fails closed and the user reruns to rotate,
 * rather than silently installing a token this process could not protect. The
 * hook's own read path (readHookToken/verifyHookToken) is untouched by this and
 * still never throws.
 */
export async function writeHookToken(projectDir: string, token: string): Promise<void> {
  const path = hookTokenPath(projectDir);
  await ensureDir(dirname(path));
  await chmod(dirname(path), 0o700);
  await writeJson(path, { token, createdAt: nowISO() });
  await chmod(path, 0o600);
}

/**
 * Constant-time token comparison. Returns false when the project has no token
 * provisioned yet, so an uninstalled project cannot be driven by an empty
 * `Authorization` header.
 */
export async function verifyHookToken(projectDir: string, candidate: string): Promise<boolean> {
  const token = await readHookToken(projectDir);
  if (!token || !candidate) return false;

  const expected = Buffer.from(token, "utf-8");
  const actual = Buffer.from(candidate, "utf-8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
