---
name: brainstorming
description: Use when material design uncertainty must be resolved before implementation
---

# Brainstorming

## When

Use for material design uncertainty: unclear user-visible behavior, architecture, scope, irreversible choices, or meaningful trade-offs. Skip it for clear, local, reversible work.

## Method

1. Restate the goal, scope, non-goals, and observable done condition.
2. Resolve repository and tool-discoverable facts before asking the user.
3. Ask only about a material user-owned decision that changes behavior, scope, risk, or trade-offs. Batch independent questions when useful.
4. Recommend one minimal design with boundaries, decisions, risks, and verification.
5. Ask the user to approve or revise the design.

Do not manufacture questions. Choose trivial reversible details from project conventions. Challenge scope only with concrete evidence. Keep YAGNI, security, accessibility, validation, and data-loss protections intact.

Design approval means the design is settled. If the user also requested implementation or a plan, continue directly; ask again only when the goal or material scope changes.

## Output

- Goal and done criterion
- In scope and non-goals
- Behavior and boundaries
- Decisions and trade-offs
- Verification strategy
- One approval question

For visual interaction questions, optionally offer the loopback-only companion in `visual-companion.md`.
