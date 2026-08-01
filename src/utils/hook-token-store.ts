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
import { join } from "node:path";
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

export async function writeHookToken(projectDir: string, token: string): Promise<void> {
  await ensureDir(join(projectDir, "hooks"));
  await writeJson(hookTokenPath(projectDir), { token, createdAt: nowISO() });
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
