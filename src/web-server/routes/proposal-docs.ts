/**
 * Proposal-doc routes: human-in-the-loop design proposal documents.
 *
 * Docs live in the project data dir under proposals/ (data-dir plane, never
 * the workspace), cohabiting with the codegraph proposal queue's codegraph.json
 * — every scan is extension-scoped (*.proposal.md / *.accepted.md) so the
 * queue file never leaks into listings. Read semantics mirror the
 * `proposal-doc` CLI commands; writes go through the web server's lock-safe
 * storage helpers.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { DagError } from "../../utils/errors.js";
import { withLock } from "../../utils/file-lock.js";
import { createPlan, readPlanIndex } from "../../utils/plan-store.js";
import { normalizeIdentifier } from "../../utils/slug.js";
import { parseBody, requireProjectDir, respond } from "../respond.js";
import { writeTextLocked } from "../storage.js";

export const proposalDocsRoute = new Hono();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROPOSALS_DIR = "proposals";
const PROMOTE_LOCK = ".proposal-doc-promotion";

function proposalDocsDir(projectDir: string): string {
  return resolve(projectDir, PROPOSALS_DIR);
}

function proposalDocPendingPath(projectDir: string, id: string): string {
  return resolve(proposalDocsDir(projectDir), `${id}.proposal.md`);
}

function proposalDocAcceptedPath(projectDir: string, id: string): string {
  return resolve(proposalDocsDir(projectDir), `${id}.accepted.md`);
}

/** Infer the proposal title from the first `# ` heading, falling back to the id. */
function deriveTitle(body: string, fallbackId: string): string {
  const titleLine = body.split("\n").find((line) => line.startsWith("# "));
  return titleLine ? titleLine.replace(/^#\s+/, "").trim() : fallbackId;
}

/**
 * Doc ids are filename stems; they must be slugs so a crafted :id cannot
 * escape proposals/ via path traversal.
 */
function assertDocId(id: string): void {
  if (!id || normalizeIdentifier(id) !== id) {
    throw new DagError("INVALID_DOC_ID", `Invalid proposal doc id "${id}"`);
  }
}

/** Directory scan tolerating a missing proposals/ dir; callers filter by suffix. */
async function readdirProposalFiles(projectDir: string): Promise<string[]> {
  try {
    return await readdir(proposalDocsDir(projectDir));
  } catch {
    return [];
  }
}

/**
 * Pending (*.proposal.md) doc count via the same extension-scoped scan the
 * list route uses. Shared with routes/projects.ts for counts.proposalDocs.
 */
export async function countPendingProposalDocs(projectDir: string): Promise<number> {
  return (await readdirProposalFiles(projectDir)).filter((f) => f.endsWith(".proposal.md")).length;
}

// ---------------------------------------------------------------------------
// GET /api/p/:slug/proposal-docs — pending docs + pending/accepted counts
// ---------------------------------------------------------------------------

interface ProposalDocSummary {
  id: string;
  title: string;
  status: "pending" | "accepted";
  path: string;
  updatedAt: string | null;
}

proposalDocsRoute.get("/api/p/:slug/proposal-docs", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const files = (await readdirProposalFiles(projectDir)).sort();
    const acceptedCount = files.filter((f) => f.endsWith(".accepted.md")).length;

    // Accepted docs are promoted — visible via their plan — so only pending
    // docs are listed; accepted ones surface as a count.
    const proposalDocs: ProposalDocSummary[] = await Promise.all(
      files
        .filter((f) => f.endsWith(".proposal.md"))
        .map(async (file) => {
          const id = basename(file, ".proposal.md");
          const filePath = proposalDocPendingPath(projectDir, id);
          const [body, updatedAt] = await Promise.all([
            readFile(filePath, "utf-8").catch(() => ""),
            stat(filePath)
              .then((s) => s.mtime.toISOString())
              .catch(() => null),
          ]);
          return {
            id,
            title: deriveTitle(body, id),
            status: "pending" as const,
            path: `proposals/${file}`,
            updatedAt,
          };
        }),
    );

    return {
      proposalDocs,
      counts: { pending: proposalDocs.length, accepted: acceptedCount },
    };
  }),
);

// ---------------------------------------------------------------------------
// GET /api/p/:slug/proposal-docs/:id — doc body with pending → accepted fallback
// ---------------------------------------------------------------------------

proposalDocsRoute.get("/api/p/:slug/proposal-docs/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const id = c.req.param("id");
    assertDocId(id);

    // Same .proposal.md → .accepted.md fallback as the CLI get command.
    let filePath = proposalDocPendingPath(projectDir, id);
    let status: "pending" | "accepted" = "pending";
    if (!existsSync(filePath)) {
      filePath = proposalDocAcceptedPath(projectDir, id);
      status = "accepted";
      if (!existsSync(filePath)) {
        throw new DagError(
          "ENTITY_NOT_FOUND",
          `Proposal doc not found: ${id} (tried .proposal.md and .accepted.md)`,
        );
      }
    }

    const [body, stats] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)]);
    return {
      id,
      status,
      path: status === "pending" ? `proposals/${id}.proposal.md` : `proposals/${id}.accepted.md`,
      title: deriveTitle(body, id),
      body,
      updatedAt: stats.mtime.toISOString(),
    };
  }),
);

// ---------------------------------------------------------------------------
// PUT /api/p/:slug/proposal-docs/:id — replace the body of a PENDING doc
// ---------------------------------------------------------------------------

const updateProposalDocSchema = z.object({ content: z.string() });

proposalDocsRoute.put("/api/p/:slug/proposal-docs/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const id = c.req.param("id");
    assertDocId(id);
    const { content } = await parseBody(c, updateProposalDocSchema);

    const pendingPath = proposalDocPendingPath(projectDir, id);
    if (!existsSync(pendingPath) && existsSync(proposalDocAcceptedPath(projectDir, id))) {
      throw new DagError(
        "ENTITY_NOT_FOUND",
        `Proposal doc "${id}" was already promoted; accepted proposal docs are read-only.`,
      );
    }

    // Writes only ever hit the pending path; the proposals dir is created on
    // first save so a brand-new id upserts cleanly.
    await mkdir(proposalDocsDir(projectDir), { recursive: true });
    await writeTextLocked(pendingPath, content);
    return { id, status: "pending" as const, path: `proposals/${id}.proposal.md`, updated: true };
  }),
);

// ---------------------------------------------------------------------------
// POST /api/p/:slug/proposal-docs/:id/promote — rename + plan creation
// ---------------------------------------------------------------------------

proposalDocsRoute.post("/api/p/:slug/proposal-docs/:id/promote", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const id = c.req.param("id");
    assertDocId(id);

    return withLock(join(projectDir, PROMOTE_LOCK), async () => {
      const pendingPath = proposalDocPendingPath(projectDir, id);
      const acceptedPath = proposalDocAcceptedPath(projectDir, id);

      let body: string;
      let recovered = false;
      if (existsSync(pendingPath)) {
        body = await readFile(pendingPath, "utf-8");
      } else if (existsSync(acceptedPath)) {
        // Crash recovery: the rename completed but plan creation never did.
        // Re-run from the accepted body unless its plan already exists.
        const acceptedBody = await readFile(acceptedPath, "utf-8");
        const derivedPlanId = normalizeIdentifier(deriveTitle(acceptedBody, id));
        const { plans } = await readPlanIndex(projectDir);
        if (plans.some((p) => p.id === derivedPlanId)) {
          throw new DagError(
            "PLAN_CONFLICT",
            `Plan "${derivedPlanId}" already exists; proposal doc "${id}" is already promoted.`,
          );
        }
        body = acceptedBody;
        recovered = true;
      } else {
        throw new DagError(
          "ENTITY_NOT_FOUND",
          `Proposal doc not found: ${id} (tried .proposal.md and .accepted.md)`,
        );
      }

      const title = deriveTitle(body, id);
      const planId = normalizeIdentifier(title);

      if (!recovered) {
        // Conflict-check BEFORE the rename so a collision leaves nothing to
        // roll back; createPlan re-checks under its own lock either way.
        const { plans } = await readPlanIndex(projectDir);
        if (plans.some((p) => p.id === planId)) {
          throw new DagError(
            "PLAN_CONFLICT",
            `Plan "${planId}" already exists; promoting "${id}" would collide with it.`,
          );
        }
        await rename(pendingPath, acceptedPath);
      }

      try {
        const plan = await createPlan(projectDir, {
          id: planId,
          title,
          status: "proposed",
          keywords: [],
          content: body,
        });
        return {
          promoted: true,
          plan,
          docPath: `proposals/${id}.accepted.md`,
          ...(recovered && { recovered: true }),
        };
      } catch (error) {
        // Plan creation failed: roll the rename back so the doc stays pending.
        if (!recovered) {
          await rename(acceptedPath, pendingPath).catch(() => {});
        }
        throw error;
      }
    });
  }),
);
