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
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { DagError } from "../../utils/errors.js";
import { readPlanIndex } from "../../utils/plan-store.js";
import { normalizeIdentifier } from "../../utils/slug.js";
import { renderPromoteDocPrompt } from "../ask-prompt.js";
import { startOneShotRun } from "../one-shot-run.js";
import { parseBody, requireProjectDir, respond } from "../respond.js";
import { getRunDriver } from "../run-driver.js";
import { writeTextLocked } from "../storage.js";

export const proposalDocsRoute = new Hono();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROPOSALS_DIR = "proposals";

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
// GET /api/p/:slug/proposal-docs — pending AND accepted docs + counts
// ---------------------------------------------------------------------------

interface ProposalDocSummary {
  id: string;
  title: string;
  status: "pending" | "accepted";
  path: string;
  updatedAt: string | null;
}

/**
 * One proposals/ file as a list summary. State comes from the filename suffix,
 * the title from the body's first H1, `updatedAt` from the file mtime — the
 * same derivation the detail route uses, so list and detail never disagree.
 */
async function summarizeDoc(
  projectDir: string,
  id: string,
  status: "pending" | "accepted",
  file: string,
): Promise<ProposalDocSummary> {
  const filePath =
    status === "pending"
      ? proposalDocPendingPath(projectDir, id)
      : proposalDocAcceptedPath(projectDir, id);
  const [body, updatedAt] = await Promise.all([
    readFile(filePath, "utf-8").catch(() => ""),
    stat(filePath)
      .then((s) => s.mtime.toISOString())
      .catch(() => null),
  ]);
  return { id, title: deriveTitle(body, id), status, path: `proposals/${file}`, updatedAt };
}

proposalDocsRoute.get("/api/p/:slug/proposal-docs", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const files = (await readdirProposalFiles(projectDir)).sort();
    const pendingFiles = files.filter((f) => f.endsWith(".proposal.md"));
    const acceptedFiles = files.filter((f) => f.endsWith(".accepted.md"));

    // Both states are listed: the tab is the proposal-doc lifecycle, so a
    // promoted doc stays visible (read-only) instead of vanishing into a
    // count. A doc id is only ever in one state (promote renames), but the
    // Map keeps the list duplicate-free if both files somehow exist — pending
    // wins, matching the detail route's pending → accepted fallback.
    const byId = new Map<string, { summary: ProposalDocSummary; index: number }>();
    let index = 0;
    for (const file of pendingFiles) {
      const id = basename(file, ".proposal.md");
      byId.set(id, {
        summary: await summarizeDoc(projectDir, id, "pending", file),
        index: index++,
      });
    }
    for (const file of acceptedFiles) {
      const id = basename(file, ".accepted.md");
      if (byId.has(id)) continue;
      byId.set(id, {
        summary: await summarizeDoc(projectDir, id, "accepted", file),
        index: index++,
      });
    }

    return {
      proposalDocs: [...byId.values()].map((entry) => entry.summary),
      counts: { pending: pendingFiles.length, accepted: acceptedFiles.length },
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
// POST /api/p/:slug/proposal-docs/:id/promote — start a promotion run
// ---------------------------------------------------------------------------

/**
 * Promotion is now performed by a one-shot `pi` run, not by the server. The
 * route keeps only the FAST, DETERMINISTIC preflight the client needs for honest
 * refusals; the rename, plan creation, task breakdown and validation all happen
 * inside the run through the ARCS skills (`arcs-writing-proposals`,
 * `arcs-writing-plans`).
 *
 * Preflight, with the refusal shapes preserved from the direct-implementation
 * era:
 *  - the doc must exist as `.proposal.md` or `.accepted.md` (ENTITY_NOT_FOUND);
 *  - the plan its title derives must not already exist (PLAN_CONFLICT).
 *
 * The one-live-run gate is the shared starter's: a second promote (or an
 * overlapping ask) is refused with RUN_IN_PROGRESS by the run store's atomic
 * claim, so the retired rename lock had nothing left to serialize and is gone.
 */
proposalDocsRoute.post("/api/p/:slug/proposal-docs/:id/promote", async (c) =>
  respond(
    c,
    async () => {
      const slug = c.req.param("slug");
      const projectDir = requireProjectDir(slug);
      const id = c.req.param("id");
      assertDocId(id);

      const pendingPath = proposalDocPendingPath(projectDir, id);
      const acceptedPath = proposalDocAcceptedPath(projectDir, id);

      let body: string;
      if (existsSync(pendingPath)) {
        body = await readFile(pendingPath, "utf-8");
      } else if (existsSync(acceptedPath)) {
        // Crash-recovery re-promote: the doc is already accepted (a prior run
        // renamed it but never finished the plan). Let this run finish the job
        // unless the derived plan already exists.
        body = await readFile(acceptedPath, "utf-8");
      } else {
        throw new DagError(
          "ENTITY_NOT_FOUND",
          `Proposal doc not found: ${id} (tried .proposal.md and .accepted.md)`,
        );
      }

      // The plan id the run will derive from the doc's first heading — the same
      // rule `arcs proposal-doc promote` and `arcs plan create` use.
      const planId = normalizeIdentifier(deriveTitle(body, id));
      const { plans } = await readPlanIndex(projectDir);
      if (plans.some((p) => p.id === planId)) {
        throw new DagError(
          "PLAN_CONFLICT",
          `Plan "${planId}" already exists; proposal doc "${id}" is already promoted.`,
        );
      }

      const driver = getRunDriver("pi");
      if (driver === undefined) {
        throw new DagError("UNKNOWN_RUNNER", `no one-shot driver is registered for runtime "pi"`);
      }

      const started = await startOneShotRun({
        projectDir,
        slug,
        driver,
        buildPrompt: (workspaceDir) =>
          renderPromoteDocPrompt({ slug, docId: id, workspacePath: workspaceDir }),
        writeTargetKey: `promote:${slug}`,
      });

      return { started: true as const, runId: started.runId, runtimeType: "pi" as const };
    },
    202,
  ),
);
