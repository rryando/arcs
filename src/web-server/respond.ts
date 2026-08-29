/**
 * Shared response envelope + error mapping for the web server.
 * Mirrors the CLI envelope shape: { ok: true, data } | { ok: false, code, message }.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Context } from "hono";
import type { z } from "zod";
import { ZodError } from "zod";
import { DagError } from "../utils/errors.js";
import { getDataDir, getProjectDir } from "../utils/paths.js";
import { normalizeIdentifier } from "../utils/slug.js";

export type Envelope = { ok: true; data: unknown } | { ok: false; code: string; message: string };

export function ok(data: unknown): Envelope {
  return { ok: true, data };
}

export function fail(code: string, message: string): Envelope {
  return { ok: false, code, message };
}

type Status = 200 | 201 | 202 | 400 | 404 | 409 | 500;

/**
 * DagError codes whose semantics are a conflict with current state and must map
 * to HTTP 409 rather than the generic 400. Explicit denylist: the codes are
 * dispatch-mandated guard codes, and there is no shared substring convention to
 * key on (unlike NOT_FOUND).
 */
const CONFLICT_CODES = new Set([
  "CLAUDE_SESSION_ACTIVE",
  "CLAUDE_RUN_IN_PROGRESS",
  "PLAN_CONFLICT",
]);

/**
 * Runs a handler and maps the result to the envelope + HTTP status.
 * DagError codes containing NOT_FOUND map to 404, known conflict codes to 409,
 * other DagErrors to 400, unknown errors to 500.
 */
export async function respond(
  c: Context,
  fn: () => Promise<unknown>,
  successStatus: 200 | 201 | 202 = 200,
): Promise<Response> {
  try {
    return c.json(ok(await fn()), successStatus);
  } catch (err) {
    if (err instanceof DagError) {
      const status: Status = err.code.includes("NOT_FOUND")
        ? 404
        : CONFLICT_CODES.has(err.code)
          ? 409
          : 400;
      return c.json(fail(err.code, err.message), status);
    }
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return c.json(fail("INVALID_BODY", message), 400);
    }
    console.error("[arcs-web] unexpected request failure", err);
    return c.json(fail("internal_error", "Unexpected server error"), 500);
  }
}

/**
 * Returns the project directory, throwing DagError if the project does not exist.
 */
export function assertProjectSlug(slug: string): void {
  if (!slug || normalizeIdentifier(slug) !== slug) {
    throw new DagError("INVALID_PROJECT_SLUG", `Invalid project slug "${slug}"`);
  }
}

export function requireProjectDir(slug: string): string {
  assertProjectSlug(slug);

  const projectsRoot = resolve(getDataDir(), "projects");
  const dir = getProjectDir(slug);
  const relativePath = relative(projectsRoot, dir);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new DagError("INVALID_PROJECT_SLUG", `Invalid project slug "${slug}"`);
  }
  if (!existsSync(join(dir, "meta.json"))) {
    throw new DagError("PROJECT_NOT_FOUND", `Project "${slug}" not found`);
  }
  return dir;
}

/**
 * Parses and validates a JSON request body against a zod schema.
 * Throws ZodError (mapped to 400 INVALID_BODY by respond()).
 */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const raw = await c.req.json();
  return schema.parseAsync(raw);
}
