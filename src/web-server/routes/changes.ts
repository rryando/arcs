/**
 * Workspace review surface — the approve/revert half of the allow-all gate.
 *
 * Two routes, one concern: exposing what a settled ask run changed in the
 * workspace and letting the user REJECT it.
 *
 *  - `GET /api/p/:slug/runs/:runId/changes` — the run's settle-time diff
 *    against the spawn-time snapshot: `{ runId, settled, changes }`. Unknown
 *    runs answer 404 RUN_NOT_FOUND (the ask route's code); live runs answer
 *    `settled: false` with no changes; settled runs read the changes manifest
 *    the write-back wrote beside the run's event log. An absent manifest (a
 *    failed/absent snapshot, a run that changed nothing) reads as an empty
 *    list — the panel shows no card.
 *
 *    A client should POLL this route rather than read it once on the end
 *    frame: the settle stamps `settled: true` first and the diff sidecar
 *    lands a beat later (the write-back diffs AFTER the settle, best-effort),
 *    so the first settled read may still be `changes: []` — empty is also
 *    what a no-change run settles to, which is why polling until the list is
 *    non-empty is the readiness signal, and an empty list that stays empty is
 *    the "nothing changed" answer.
 *  - `POST /api/p/:slug/runs/:runId/revert` — restores the workspace to the
 *    snapshot for THIS run's changes and marks the run record reverted so a
 *    second revert is refused (409 RUN_ALREADY_REVERTED). Refuses while the
 *    run is still live (400 RUN_NOT_SETTLED — a claim in flight may still be
 *    writing) and for unknown runs (404 RUN_NOT_FOUND).
 *
 * Revert is strictly scoped: only the paths in this run's own changes
 * manifest, resolved through the snapshot's root — never a bare `git clean`,
 * never a walk, and never a path the snapshot predates. The diff/revert
 * machinery itself lives in run-diff.ts; this module only frames it as HTTP.
 */

import { Hono } from "hono";
import { DagError } from "../../utils/errors.js";
import { requireProjectDir, respond } from "../respond.js";
import { readRunChanges, readRunSnapshot, revertWorkspaceChanges } from "../run-diff.js";
import { getRun, markRunReverted } from "../run-store.js";

export const changesRoute = new Hono();

/**
 * The run's changes, or an empty list. An absent/settled-unreadable manifest
 * IS the empty list: it is what a snapshot that failed, or a run that changed
 * nothing, leaves behind — the panel renders no card either way.
 */
changesRoute.get("/api/p/:slug/runs/:runId/changes", async (c) =>
  respond(c, async () => {
    const slug = c.req.param("slug");
    const projectDir = requireProjectDir(slug);
    const runId = c.req.param("runId");
    const run = await getRun(projectDir, runId);
    if (run === undefined) {
      throw new DagError("RUN_NOT_FOUND", `no run "${runId}" on project "${slug}"`);
    }
    const settled = run.outcome !== undefined;
    const file = settled ? await readRunChanges(projectDir, slug, runId) : undefined;
    return { runId, settled, changes: file?.changes ?? [] };
  }),
);

/**
 * Rejects the run's changes: restores the workspace to the snapshot baseline
 * and stamps the record so one revert is the whole story. `restored` lists
 * the paths actually put back — a modified/deleted file whose baseline bytes
 * were never captured (the non-git blob cap) cannot be rebuilt, so it is
 * skipped rather than reported as restored.
 */
changesRoute.post("/api/p/:slug/runs/:runId/revert", async (c) =>
  respond(c, async () => {
    const slug = c.req.param("slug");
    const projectDir = requireProjectDir(slug);
    const runId = c.req.param("runId");
    const run = await getRun(projectDir, runId);
    if (run === undefined) {
      throw new DagError("RUN_NOT_FOUND", `no run "${runId}" on project "${slug}"`);
    }
    if (run.outcome === undefined) {
      throw new DagError(
        "RUN_NOT_SETTLED",
        `run "${runId}" is still live — only a settled run's changes can be reverted`,
      );
    }
    if (run.revertedAt !== undefined) {
      throw new DagError(
        "RUN_ALREADY_REVERTED",
        `the changes of run "${runId}" were already reverted`,
      );
    }

    // Revert works from the snapshot's OWN root (never re-derived from the
    // meta), so the paths acted on are exactly the ones the run saw — and
    // every one of them passes the snapshot-root containment guard inside
    // revertWorkspaceChanges. A missing/errored snapshot means there was no
    // review surface: nothing to restore, still marked reverted (one revert
    // per run, whatever it found).
    const snapshot = await readRunSnapshot(projectDir, slug, runId);
    const file = await readRunChanges(projectDir, slug, runId);
    const changes = file?.changes ?? [];
    let restored: string[] = [];
    if (snapshot !== undefined && snapshot.error === undefined && changes.length > 0) {
      restored = await revertWorkspaceChanges(snapshot, changes);
    }
    await markRunReverted(projectDir, runId);
    return { reverted: true, restored };
  }),
);
