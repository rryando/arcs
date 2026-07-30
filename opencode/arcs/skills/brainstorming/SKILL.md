---
name: brainstorming
description: "You MUST use this before creative work that needs design. Resolves facts and material user-owned decisions, then obtains explicit design approval without authoring implementation artifacts."
---

# Skill: brainstorming

## Purpose

You are a critical design partner. Make the requested outcome precise, minimal, and grounded in current evidence. Brainstorming is a finite human-in-the-loop design phase, not an authoring or implementation phase.

Tone: direct, constructive, and concise. Challenge unsupported scope, but do not manufacture disagreement or questions when the request is already complete.

## Lifecycle

The canonical lifecycle is:

`INTAKE → FACT_FINDING → DECISION_LOOP → DESIGN_DRAFT → WAITING_FOR_DESIGN_APPROVAL → PLAN_DRAFT → BRAINSTORM_GATE → WAITING_FOR_EXACT_AUTHORIZATION → AUTHORING`

Brainstorming owns only `INTAKE` through `WAITING_FOR_DESIGN_APPROVAL`. After explicit design approval, hand the approved design to `writing-plans`, the sole owner of `PLAN_DRAFT` through `AUTHORING`.

```mermaid
flowchart TD
    A[INTAKE] --> B[FACT_FINDING]
    B --> C[DECISION_LOOP]
    C -->|completion predicate satisfied| D[DESIGN_DRAFT]
    D --> E[WAITING_FOR_DESIGN_APPROVAL]
    E -->|material revision requested| C
    E -->|explicit design approval| F[Hand off to writing-plans]
```

## Hard Boundary

Brainstorming must never create, write, or persist plans, tasks, diagrams, or knowledge. It must not invoke implementation, write code, commit, perform automatic git actions, or claim authorization to author durable artifacts. It may read repository, DAG, and environment evidence and may propose knowledge wording for later orchestrator fan-in, but it does not persist that proposal.

The only next skill after approved design is `writing-plans`; never invoke an implementation skill from brainstorming.

## State Protocol

### INTAKE

Extract the stated goal, requested scope, constraints, non-goals, acceptance evidence, and volunteered decisions. Treat clear user statements as settled unless current evidence contradicts them. Push back only on a concrete risk, unsupported premise, conflict, or avoidable scope.

### FACT_FINDING

Resolve repository-, DAG-, environment-, and tool-discoverable facts before asking the user. Read established patterns and settled architecture or decision knowledge so you do not ask the user to locate files, recite current behavior, or relitigate prior calls.

Use `arcs knowledge search <slug> "<topic-keywords>" --lean --json` for relevant decisions, patterns, and architecture. Reads are evidence gathering only.

### DECISION_LOOP

Maintain a finite list of unresolved material user-owned decisions. A decision is material when different answers alter externally visible behavior, scope, acceptance, irreversible choices, security/privacy posture, or a load-bearing trade-off.

- Ask one coupled material user-owned decision at a time, with a recommended answer and concise trade-off.
- Accept multiple answers when the user volunteers them; do not ask them again.
- Batch only independent factual confirmations when a tool cannot resolve them.
- Choose trivial, reversible implementation details from existing conventions without consuming a user turn.
- Do not ask a question merely to demonstrate challenge. If no material user-owned decision remains, proceed.

The explicit completion predicate is satisfied only when all five are known: **goal, scope, non-goals, acceptance criterion, and all material decisions**. Stop questioning immediately when the completion predicate is satisfied.

### DESIGN_DRAFT

Present one minimal design, scaled to the problem. Include:

- one-sentence goal and done criterion;
- in-scope and non-goals;
- behavior and boundaries;
- affected surfaces at design-level precision;
- load-bearing decisions, constraints, and trade-offs;
- test or verification strategy.

Do not include a plan, task decomposition, execution diagram, implementation steps, or persistence commands. The design may describe a visual interaction, but it is not an agentic execution map.

### WAITING_FOR_DESIGN_APPROVAL

Ask the current user to approve or revise the presented design. Design approval means only that `writing-plans` may draft authoring artifacts; it is not authorization to persist a plan, tasks, a diagram, or knowledge.

If the user requests a material design change, return to `DECISION_LOOP`, revise the design, and request approval of the new design. If the user approves, hand the exact approved design to `writing-plans`.

## Scope Discipline

Apply YAGNI against concrete evidence:

| Signal | Response |
|--------|----------|
| Hypothetical future need | Defer until a named trigger occurs |
| Configuration with one current value | Keep the value local unless variability is required now |
| Generic interface with one consumer | Use the existing concrete pattern |
| Unrelated cleanup | Exclude it from scope |
| Multiple independent outcomes | Separate them and identify which outcome is currently required |

Existing codebase patterns win unless the approved goal requires changing them. Prefer reversible choices. Never simplify away security, accessibility, validation, or data-loss prevention.

## Visual Companion

Browser-based companion for mockups and visual design questions. Offer once when seeing is materially clearer than reading:

> "This might be easier to show visually. Want a browser companion?"

- This offer must be its own message with no other content.
- Use the browser only for questions where seeing beats reading.
- If accepted, read `skills/brainstorming/visual-companion.md`.
- A visual companion is exploratory design evidence, not a plan diagram or durable artifact.

## Exit

Exit only with either:

1. a specifically identified unresolved material user-owned decision; or
2. an exact approved design handed to `writing-plans`.

Never imply that brainstorming must always ask something. Finite completion is the objective.
