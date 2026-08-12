---
name: writing-plans
description: Create and maintain concise ARCS plans, tasks, and execution diagrams
---

# Writing Plans

## When

Use for broad, multi-step, architectural, or explicitly requested plans. A clear explicit plan request authorizes drafting and persisting the plan; do not ask for the same approval twice.

## Plan Shape

Include:

- goal, approved behavior, non-goals, architecture, and acceptance;
- outcome-sized, independently verifiable tasks;
- exact paths, verification commands, dependencies, and expected evidence;
- the smallest dependency graph that reflects real ordering.

Do not split test, implementation, and commit mechanics into separate microtasks. Do not invent future-facing abstractions or unrelated cleanup.

## Persistence

Use current CLI syntax from `arcs --commands --json`:

1. Create or update the plan.
2. Create or update tasks with `dependsOn`, scope, acceptance, verify, skill, and work mode.
3. Generate or update the companion diagram.
4. Validate plan, tasks, and diagram.

The diagram is derived from task metadata, which remains authoritative. Use `to-diagram` when diagram tooling details matter.

During execution, keep tasks and diagrams aligned without reopening approval. Ask only when the goal, material scope, dependency strategy, or destructive/external effect changes.

An optional reviewer may check a risky or complex plan using `plan-document-reviewer-prompt.md`; ordinary plans do not require it.

## Safety

- Never claim persistence before CLI evidence.
- Stop on partial writes and report exact state.
- Do not perform Git actions unless requested.
- Keep verification scoped to each task; broad verification belongs to the final integration task when needed.
