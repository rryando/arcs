---
name: to-diagram
description: Create or update a helper-managed Mermaid execution diagram
---

# Plan Diagrams

## Contract

Task metadata is the source of truth. The `.diagram.mmd` file is derived data for execution order and status.

Use `manage-diagram.mjs` with supported `flowchart TD` format. Prefer ARCS CLI wrappers:

- `arcs diagram init <slug> <planId>`
- `arcs diagram inspect <slug> <planId>`
- `arcs diagram ready <slug> <planId>`
- `arcs diagram status <slug> <planId> <node> <status>`
- `arcs diagram validate <slug> <planId>`

## Metadata

Each node uses stable `T001`-style IDs and records title, status, skill, work mode, scope, acceptance, verify command, and dependencies. Implementation tasks use `skill: implementation` with `work-mode: bounded|inspect`.

Dependencies come from task `dependsOn`; do not hand-maintain conflicting arrows. New plans begin in backlog. Use standard `done`, `inProgress`, `blocked`, and `backlog` classes.

## Update

- Status-only change: use `arcs diagram status`.
- Scope, task, or dependency change: update task metadata, then regenerate.
- Always validate after every write.

Never make the diagram authoritative over task records. Ask only when a proposed topology change materially changes the approved goal or scope.
