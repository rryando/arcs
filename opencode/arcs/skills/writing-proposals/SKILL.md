---
name: writing-proposals
description: Drive human-in-the-loop proposal documents for big changes, then convert an approved proposal into an ARCS plan and tasks
---

# Writing Proposals

## When

Use when a request is architecture-changing, a large feature, a cross-cutting
refactor, or otherwise too broad to start coding directly. Small, well-scoped
work does not need a proposal — main dispatches one engineer or requested planning.

Trigger points: the user says "proposal", or you judge that material scope,
design trade-offs, or migration strategy need human sign-off before tasks exist.

## Lifecycle

```
request → proposal doc (iterate with user) → approved
        → promote + plan + tasks (writing-plans) → execution (implementation)
        → optional durable knowledge curation (writing-knowledge)
```

The proposal doc is stage one of the DAG: docs → plan → task → execution →
knowledge when useful. Main coordinates handoffs; specialists never delegate. `tech-architect` provides read-only design evidence, designated `arcs-docs` persists authorized proposals/plans/knowledge. This skill does not expand role permissions.

## CLI

All proposal doc operations use the `arcs proposal-doc` command group. Documents
are stored in the ARCS data dir under `projects/<slug>/proposals/` (not the
workspace); workspace `docs/proposals/` files are ignored by tooling (no
migration):

- `arcs proposal-doc create <slug> "<title>"` — scaffold `proposals/<id>.proposal.md` in the project data dir
- `arcs proposal-doc list <slug>` — list pending proposals (both `.proposal.md` files)
- `arcs proposal-doc get <slug> <id>` — view body text of a proposal (pending or accepted)
- `arcs proposal-doc edit <slug> <id> --body="..."` — replace body text
- `arcs proposal-doc promote <slug> <id>` — rename to `.accepted.md`, materialize
  `proposals/<id>.plan.md`, and emit the `arcs plan create` command that consumes
  that generated body

## Stage 1 — Proposal Doc Loop

1. **Understand before drafting.** Main uses delegated code evidence; specialists inspect the bounded source needed for design. Use compact DAG/knowledge context only when relevant. A proposal grounded only in the request
   text is a guess, not a proposal.
2. **Draft** with `arcs proposal-doc create <slug> "<title>"`. This scaffolds
   `proposals/<kebab-id>.proposal.md` under the project's data dir with the required sections:
   - **Goal** — the outcome in one paragraph.
   - **Motivation / non-goals** — why now, what is explicitly out of scope.
   - **Current state** — how it works today, with file/symbol references.
   - **Proposed design** — approach, alternatives considered, trade-offs chosen.
   - **Impact & risks** — blast radius, migration/data concerns, rollout order.
   - **Acceptance criteria** — observable, verifiable end state.
3. **Iterate.** Present the draft to the user, apply feedback, re-present.
   Repeat until the user explicitly approves. Do not proceed on silence,
   partial feedback, or your own judgment of "good enough".
4. **Record the decision.** On approval, use `arcs proposal-doc promote <slug> <id>`
   to mark it accepted. Then note the date and rejected alternatives in the doc's
   Decision section so the rationale survives.

Rules:

- One revision per user turn; never batch speculative changes into the doc.
- If the user's feedback changes goal, scope, or destructive effect, treat it
  as a new proposal round, not an edit.
- Never start implementation inside the proposal loop.

## Stage 2 — Convert to Plan and Tasks

Only after explicit approval — use the promote result:

1. Run `arcs proposal-doc promote <slug> <id>`. This renames `.proposal.md` →
   `.accepted.md`, writes the generated execution-only body to
   `proposals/<id>.plan.md`, and returns a plan command pointing at that body.
2. Load `writing-plans` and run the returned `arcs plan create` command, then
   create the plan's outcome-sized tasks with real `dependsOn` edges. The
   generated body is a source-linked index; it does not create tasks. Task
   granularity follows `writing-plans`; do not mirror proposal sections
   one-to-one.
3. Preserve the approved proposal reference; do not invent a commit task without explicit Git authorization.
4. Generate/validate the companion diagram per `writing-plans`.
5. Hand execution to the normal agent loop (`arcs next` → work → `arcs done`),
   using `implementation` skill conventions and a single task/diagram transition owner. Workers return durable candidates; docs deduplicates authorized knowledge and acknowledges persisted ID, already covered ID or deferred reason.

If implementation reveals the approved design is wrong, stop and reopen the
proposal loop — do not silently redesign mid-execution.

## Safety

- No plan, task, or code creation before explicit user approval of the doc.
- Never claim approval; quote the user's approving message back when handing off.
- Do not perform Git actions unless requested.
