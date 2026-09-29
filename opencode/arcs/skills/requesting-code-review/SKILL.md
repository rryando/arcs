---
name: requesting-code-review
description: Use when completing tasks, implementing major features, or before merging to verify work meets requirements
---

# Requesting Code Review

Main dispatches `code-reviewer` for an independent read-only review; specialists never dispatch it themselves. Review is risk-based, not a gate for every task: request it after major features, before merging to main, for material risk or contradictory evidence, or when the user asks.

## Dispatch

Fill `code-reviewer.md` and send it through the normal dispatch contract:

- what was implemented and what it should do (plan, task or acceptance criteria);
- the exact commit range or files — the reviewer examines only what it is given;
- the mode: `review` (correctness, security, maintainability, tests), `audit` (evidence against stated criteria) or `risk` (focused independent scrutiny);
- project conventions from `AGENTS.md`, linter configs and relevant DAG knowledge (`arcs knowledge search <slug> "<changed-area keywords>"` filtered to `pattern` and `gotcha`) — gathered once per session and reused.

Main supplies change summaries and returns from the owning engineer; it does not read the diff itself.

## Follow-up

Read the reviewer's STATUS and RESULT. Route CRITICAL and HIGH findings back to the owning engineer with the finding's `file:line` and consequence; never repair another owner's scope. Note MEDIUM and LOW for later. Do not proceed with unfixed HIGH findings. A recurring finding is a `pattern` or `gotcha` candidate under KNOWLEDGE for `arcs-docs`.
