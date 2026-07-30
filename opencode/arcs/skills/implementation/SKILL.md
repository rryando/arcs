---
name: implementation
description: Use for orchestrator-selected bounded or inspect implementation work. Bounded executes a fully specified change directly; inspect resolves limited uncertainty from the repo and DAG before coding.
---

# Skill: implementation

## Work Mode Is Dispatch Authority

The orchestrator selects exactly one work mode in the dispatch: `bounded` or `inspect`. Do not re-route yourself or silently expand scope.

### `bounded`

Use when the task, files, acceptance criteria, and VERIFY command are fully specified.

- Execute directly with no repo exploration and no user questions.
- Read only the dispatched files and context needed to make the change.
- If a material decision or hidden scope appears, stop and return `STATUS: blocked`; do not guess or switch modes.

### `inspect`

Use when the goal is clear but limited implementation details remain.

1. Inspect the repository and DAG first: search relevant knowledge, then inspect the smallest set of patterns, types, callers, and tests that can resolve the decision.
2. Infer the answer when tools or established conventions make it clear.
3. Ask at most one targeted user question, and only for a material decision that is not tool-resolvable.
4. If uncertainty is design-shaping or scope expands, stop and return `STATUS: blocked` rather than improvising.

## Construction Discipline

Before adding code, stop at the first rung that satisfies the requirement:

1. **Necessity** — omit speculative or unrequested work.
2. **Standard library** — use it when it correctly covers the need.
3. **Native platform** — prefer a built-in platform capability.
4. **Installed dependency** — reuse one before adding code or a dependency.
5. **Minimum code** — write only the smallest correct implementation.

Do not introduce abstractions, configuration, scaffolding, or dependencies for hypothetical consumers. Minimal does not mean flimsy: never simplify away security controls, accessibility basics, trust-boundary validation, or error handling that prevents data loss.

Mark every deliberate simplification with its known ceiling and concrete revisit trigger:

```
// SHORTCUT: <ceiling>, upgrade when <trigger>
```

## Implementation And Verification

- Follow existing repository conventions and the dispatch SCOPE.
- Use test-driven-development when the dispatch requires it or when adding non-trivial behavior; structural changes may rely on existing focused contracts.
- Run exactly the dispatch VERIFY command, scoped to touched files. NEVER the full suite, project-wide lint, or full build.
- Fix failures in touched files and re-run VERIFY. Report failures originating outside SCOPE under `BLOCKED_BY`; do not edit those files.
- Never commit unless explicitly asked.

## Knowledge Exit

Knowledge is proposal-only. For a durable, non-obvious pattern or gotcha, return a substantive ready-to-run proposal for orchestrator persistence at fan-in; do not execute `arcs knowledge upsert` yourself. Skip mechanical or easily re-derived observations.

`arcs knowledge template --kind=<kind> --json`; `arcs knowledge upsert <slug> "<title>" --kind=<pattern|gotcha|lesson|architecture|decision> --summary="<summary>" --body="<substantive filled template>" --keywords="<keywords>" --source-files="<path[:anchor]>" --json`

Upsert is idempotent by title.
