# ARCS lifecycle

ARCS stores project metadata, plans, tasks, knowledge, proposals, diagrams, worktrees, and receipts in the data directory. Use the CLI rather than editing those files directly.

## Work

`arcs brief`/`arcs context` → `arcs next` → implement in the assigned scope → verify → `arcs done` → optionally `arcs remember` or `arcs knowledge upsert`.

Task dependency order is enforced by the DAG. Do not transition blocked work or select a different task merely because it is convenient.

## Knowledge and proposals

Codegraph ingestion creates proposals. Review them with `arcs proposal list`; promote useful findings with `arcs proposal promote` or reject them with `arcs proposal drop`. Knowledge writes should include useful summaries, body content, audience, and source evidence where available.

## Validation

Run `arcs validate <slug> --json` after multi-entity changes. Validate diagrams with `arcs diagram validate <slug> --json`. Plan worktrees must pass `arcs worktree validate <slug>` before completion.

When `ARCS_GUARDED=1`, pass the operator-issued `--token` to mutating commands. Never disable or work around the gate.
