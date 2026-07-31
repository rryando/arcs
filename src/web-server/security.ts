import type { MiddlewareHandler } from "hono";
import { fail } from "./respond.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function hostnameFromHostHeader(value: string): string {
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]"));
  return value.split(":", 1)[0] ?? "";
}

/**
 * Local-server hardening against DNS rebinding and browser CSRF.
 */
export const secureLocalRequest: MiddlewareHandler = async (c, next) => {
  const host = hostnameFromHostHeader(c.req.header("host") ?? "");
  if (!isLoopbackHost(host)) {
    return c.json(fail("forbidden_host", "ARCS web only accepts loopback requests"), 403);
  }

  const origin = c.req.header("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return c.json(fail("forbidden_origin", "Invalid request origin"), 403);
    }
    if (!isLoopbackHost(originHost)) {
      return c.json(fail("forbidden_origin", "Cross-site mutations are not allowed"), 403);
    }
  }

  if (MUTATION_METHODS.has(c.req.method)) {
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return c.json(
        fail("unsupported_media_type", "Mutations require Content-Type: application/json"),
        415,
      );
    }
  }

  await next();
};
