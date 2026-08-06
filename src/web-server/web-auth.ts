/**
 * `X-ARCS-Token` gate for mutating API routes.
 *
 * Layered on top of (never instead of) the global loopback-only
 * `secureLocalRequest`: loopback proves the caller is on this machine, the
 * token proves it is a page this server itself served (see web-token.ts).
 *
 * Deny-by-default across `/api/*` rather than an allowlist of known paths: a
 * mutating route added later is gated the moment it is registered, with exactly
 * one exemption — `/api/hook/*`, whose caller is a Claude Code hook subprocess
 * and not the browser, and which carries its own independent bearer token
 * (hook-auth.ts). Reads are untouched: every GET/HEAD/OPTIONS passes straight
 * through, so `/api/events` and the whole read surface behave exactly as before.
 */

import type { MiddlewareHandler } from "hono";
import { fail } from "./respond.js";
import { verifyWebToken } from "./web-token.js";

/** Mirrors the mutation set in security.ts. */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The one prefix that authenticates with its own bearer token instead. */
const HOOK_PREFIX = "/api/hook/";

function needsWebToken(method: string, path: string): boolean {
  return MUTATION_METHODS.has(method.toUpperCase()) && !path.startsWith(HOOK_PREFIX);
}

export const requireWebToken: MiddlewareHandler = async (c, next) => {
  if (
    needsWebToken(c.req.method, c.req.path) &&
    !verifyWebToken(c.req.header("x-arcs-token") ?? "")
  ) {
    // A clean typed refusal, not a throw: respond.ts only maps DagError, and a
    // missing token is an auth answer rather than a DAG failure.
    return c.json(fail("web_unauthorized", "Missing or invalid ARCS web token"), 401);
  }

  await next();
};
