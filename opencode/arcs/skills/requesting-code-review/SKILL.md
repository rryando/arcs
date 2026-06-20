---
name: requesting-code-review
description: Use when completing tasks, implementing major features, or before merging to verify work meets requirements
---

# Skill: requesting-code-review

## When

After completing a task, major feature, or before merge. Dispatch `arcs:code-reviewer` subagent.

## Flow

```mermaid
flowchart TD
    A[Work complete] --> B[Get BASE_SHA and HEAD_SHA]
    B --> C[Gather project conventions]
    C --> D[Fill code-reviewer.md template]
    D --> E[Dispatch arcs:code-reviewer subagent]
    E --> F{Review results}
    F -->|CRITICAL| G[Fix immediately]
    F -->|HIGH| H[Fix before proceeding]
    F -->|MEDIUM/LOW| I[Note for later]
    G --> E
    H --> E
```

## Template Placeholders

- `{WHAT_WAS_IMPLEMENTED}` — what you built
- `{PLAN_OR_REQUIREMENTS}` — what it should do
- `{BASE_SHA}` / `{HEAD_SHA}` — commit range
- `{PROJECT_CONVENTIONS}` — CLAUDE.md / linter configs / style guides (gather once per session, reuse across dispatches)

## Feed DAG Conventions to the Reviewer

When gathering conventions, also pull what the DAG already knows so the reviewer checks against settled patterns, not just static config: `arcs knowledge search <slug> "<changed-area keywords>" --lean --json`, filtering for `kind=pattern` and `kind=gotcha`. Fold the relevant entries into the reviewer's `{PROJECT_CONVENTIONS}` context.

## When to Request

**Mandatory:** after major features, before merge to main.
**Already scheduled:** when `subagent-driven-development` drives the loop, its pipeline dispatches this review as stage 2 (code-quality-reviewer applies this template's checklist but returns the SDD JSON envelope) — do not schedule it twice for the same task.
**Optional:** when stuck, before refactoring, after complex bugfix.

## Red Flags

- Never skip because "it's simple"
- Never ignore CRITICAL findings
- Never proceed with unfixed HIGH findings
- Always include project conventions in reviewer context
- CRITICAL/HIGH fixes route to the owning implementer — never fix files outside your own scope

See template at: `requesting-code-review/code-reviewer.md`

Reviewer returns the unified envelope: STATUS → VERDICT (approve | request-changes | comment-only) → FINDINGS by severity (CRITICAL/HIGH/MEDIUM/LOW) with 📍 file:line anchors.

## Capture Recurring Findings

When a finding recurs — the same class of issue flagged more than once, or a convention the codebase keeps violating — propose it as durable knowledge so future reviews and implementers inherit it: `arcs knowledge upsert <slug> "<title>" --kind=<pattern|gotcha> --summary="<the recurring issue and the fix convention>" --keywords="<k1,k2>" --source-files="<path,...>" --json`. Upsert is idempotent by title.
