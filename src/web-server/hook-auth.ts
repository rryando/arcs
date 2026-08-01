/**
 * Bearer-token gate for `/api/hook/*`.
 *
 * Layered on top of (never instead of) the global loopback-only
 * `secureLocalRequest`: loopback proves the caller is on this machine, the
 * token proves it is this project's installed hook script. Browser-facing
 * routes stay token-free — only the hook endpoint carries a shared secret,
 * because only it is called by something that is not the ARCS web UI.
 */

import type { MiddlewareHandler } from "hono";
import { verifyHookToken } from "../utils/hook-token-store.js";
import { fail, requireProjectDir } from "./respond.js";

const BEARER = /^Bearer\s+(\S+)$/i;

/** `/api/hook/:slug/...` → the slug segment, or "" when the shape is wrong. */
function slugFromPath(url: string): string {
  const segments = new URL(url).pathname.split("/");
  return segments[1] === "api" && segments[2] === "hook" ? (segments[3] ?? "") : "";
}

export const requireHookToken: MiddlewareHandler = async (c, next) => {
  const unauthorized = () =>
    c.json(fail("hook_unauthorized", "Missing or invalid ARCS hook token"), 401);

  const match = BEARER.exec((c.req.header("authorization") ?? "").trim());
  if (!match) return unauthorized();

  let projectDir: string;
  try {
    projectDir = requireProjectDir(slugFromPath(c.req.url));
  } catch {
    // Deliberately 401, not 404: an unauthenticated caller must not be able to
    // probe which project slugs exist on this machine.
    return unauthorized();
  }

  if (!(await verifyHookToken(projectDir, match[1]))) return unauthorized();

  await next();
};
