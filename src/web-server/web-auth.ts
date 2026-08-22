/**
 * `X-ARCS-Token` gate for mutating API routes.
 *
 * Layered on top of (never instead of) the global loopback-only
 * `secureLocalRequest`: loopback proves the caller is on this machine, the
 * token proves it is a page this server itself served (see web-token.ts).
 *
 * Deny-by-default across `/api/*` rather than an allowlist of known paths: a
 * mutating route added later is gated the moment it is registered. Reads are
 * untouched: every GET/HEAD/OPTIONS passes straight through, so `/api/events`
 * and the whole read surface behave exactly as before.
 */

import type { MiddlewareHandler } from "hono";
import { fail } from "./respond.js";
import { verifyWebToken } from "./web-token.js";

/** Mirrors the mutation set in security.ts. */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function needsWebToken(method: string): boolean {
  return MUTATION_METHODS.has(method.toUpperCase());
}

export const requireWebToken: MiddlewareHandler = async (c, next) => {
  if (needsWebToken(c.req.method) && !verifyWebToken(c.req.header("x-arcs-token") ?? "")) {
    // A clean typed refusal, not a throw: respond.ts only maps DagError, and a
    // missing token is an auth answer rather than a DAG failure.
    return c.json(fail("web_unauthorized", "Missing or invalid ARCS web token"), 401);
  }

  await next();
};
