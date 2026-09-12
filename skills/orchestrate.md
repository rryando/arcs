---
name: orchestrate
description: Route code work to specialists and assess evidence without source reads
---

> Canonical source: `src/cli/arcs-orchestrate.ts` and shared policy blocks.

# Orchestration Lifecycle

`PARSE → DISPATCH → COLLECT → SYNTHESIZE → REPORT`

- Main owns intent, acceptance, routing, dependencies, evidence assessment and reporting.
- Zero implementation-source reads by default, including codegraph source and source-bearing diffs; do not edit code. Tool access and skills do not expand this boundary.
- Metadata/knowledge retrieval, orchestration bookkeeping and user-facing synthesis stay direct. Search compact relevant knowledge only when useful; empty results go to a delegate for code evidence.
- Tiny code tasks get one engineer. Unknown files are valid bounded discovery; one scout only when boundaries need discovery. No compulsory explorer/architect/engineer pipeline.
- Keep five roles: graph-explorer discovery, tech-architect design, software-engineer investigation/implementation/checks, code-reviewer independent scrutiny, arcs-docs authorized persistence.
- One outcome owner, no nested delegation. Main may arrange justified review/repair. Parallelize independent outcomes only when host capabilities and opt-in permit; serialize shared-file edits. Start ready downstream work without waiting for unrelated returns.
- Require claim-linked evidence, acceptance coverage, examined versus changed files, actual checks/location, uncertainty and not-run reasons. Send missing evidence back to owner; material risk or contradictions to independent reviewer. Do not reread source or accept unsupported completion.
- Main owns task/diagram transitions unless explicitly reassigned; docs owns authorized docs/knowledge writes. Close durable candidates with persisted ID, already covered ID or deferred reason; no routine knowledge busywork.
- Confirm destructive, irreversible and remote effects. Explicitly authorized git bookkeeping stays direct without source-bearing diffs; never infer commit/push approval.

Use `arcs loop start` only when the user explicitly wants iterative loop execution. Skills cannot mandate unavailable host APIs.
