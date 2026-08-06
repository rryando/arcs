/**
 * Per-server auth token for the browser-facing mutating API.
 *
 * The loopback + Origin checks in security.ts stop remote and cross-site
 * callers, but they authenticate a NETWORK LOCATION, not a process: every other
 * program on this machine shares localhost, and the mutating routes now spawn
 * `claude` subprocesses. This token proves the caller is a page THIS server
 * served — it is minted fresh at every server start and injected into the
 * served index.html (see static.ts), so the SPA holds it from first paint and
 * no other local process can guess it.
 *
 * Deliberately per-SERVER, not per-project (unlike hook-token-store, which
 * authenticates a per-project hook install): it authenticates the browser tab,
 * and one tab drives every project. Verification always reads the in-memory
 * value, never the file, so a second server started against the same data dir
 * cannot authorize requests to this one — it only replaces the on-disk copy.
 * Exactly one token is live per PROCESS: a second createApp in the same process
 * rotates it and every app then verifies against the newest value. ARCS runs
 * one server per process, so that is a test-only nuance.
 *
 * The file exists for out-of-band consumers (scripts, tests) and is written
 * 0o600: the token is never passed on an argv or in an env var a `ps` can read.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "../utils/paths.js";
import { nowISO } from "../utils/storage-utils.js";

/** Same file shape as src/utils/hook-token-store.ts. */
interface WebTokenFile {
  token: string;
  createdAt: string;
}

const TOKEN_BYTES = 32;

let currentToken: string | undefined;

export function webTokenPath(): string {
  return join(getDataDir(), "web-token.json");
}

/**
 * Mints this server's token, replacing any previous one, and persists it 0o600.
 * Called once from createApp, before any route can be served: the middleware
 * and the index.html transform both read the value it installs.
 */
export function mintWebToken(): string {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const file: WebTokenFile = { token, createdAt: nowISO() };
  const path = webTokenPath();

  mkdirSync(dirname(path), { recursive: true });
  // The `mode` option only applies when writeFileSync CREATES the file, so an
  // existing token file keeps whatever mode it had — chmod unconditionally.
  // A world-readable token file is the exact failure this whole module exists
  // to avoid.
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(path, 0o600);

  currentToken = token;
  return token;
}

/** This server's live token, or undefined before mintWebToken() has run. */
export function currentWebToken(): string | undefined {
  return currentToken;
}

/**
 * Constant-time token comparison. Returns false when no token has been minted
 * yet, so a request that arrives before startup finished cannot be authorized
 * by an empty header.
 */
export function verifyWebToken(candidate: string): boolean {
  if (!currentToken || !candidate) return false;

  const expected = Buffer.from(currentToken, "utf-8");
  const actual = Buffer.from(candidate, "utf-8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
