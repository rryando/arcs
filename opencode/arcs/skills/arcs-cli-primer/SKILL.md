---
name: arcs-cli-primer
description: Use when an arcs CLI command, flag shape, lifecycle rule, or batch operation is unclear
---

# ARCS CLI Primer

The CLI is authoritative. When a command or flag is uncertain, ask it rather than guessing:

- `arcs --commands --json`
- `arcs <group> --help`
- `arcs <command> --help`
- `arcs batch --list-ops --json`
- `arcs knowledge template --kind=<kind> --json`

Prefer `--json` for agent-readable output. Mutating commands support `--dry-run` when reported by command help. `ARCS_GUARDED=1` requires `--token <value>` for writes; never bypass that gate.

## Core lifecycle

1. Read focus with `arcs brief <slug>` or `arcs context <slug>`.
2. Select dependency-ready work with `arcs next <slug>`.
3. Inspect a task/plan with `arcs task get` or `arcs plan get`.
4. Implement and verify in the assigned scope.
5. Close work with `arcs done <slug> <taskId>`; capture durable discoveries with `arcs remember` or `arcs knowledge upsert`.
6. Validate with `arcs validate <slug> --json` and, for diagrams, `arcs diagram validate <slug> --json`.

Use `arcs related`, `arcs search`, and `arcs knowledge search` for focused retrieval. Use `arcs worktree ensure|validate` for plan-scoped worktrees. Structural codegraph findings remain proposals until explicitly handled with `arcs proposal list|promote|drop`.

Use `--body-file` or `--body-stdin` for long markdown. Set `--audience` on knowledge writes when the command supports it. Do not hand-edit DAG data, diagrams, receipts, or AGENTS.md.
