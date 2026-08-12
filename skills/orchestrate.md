---
name: orchestrate
description: Complete ARCS work with delegation preferred for separable outcomes
---

> Canonical source: `src/cli/arcs-orchestrate.ts`.

# Direct Lifecycle

`UNDERSTAND → WORK → VERIFY → REPORT`

- Retain the tools to inspect, edit, and verify directly.
- Use `arcs brief`, plans, tasks, and knowledge when DAG state matters.
- Strongly prefer delegation for separable implementation, investigation, research, and review.
- Work directly only for tiny, tightly coupled, or orchestration-state changes.
- Assign one owner per delegated outcome; use no nested delegation or delegate-to-reviewer-to-repair chains.
- Plan broad or multi-step work.
- The agent making a change runs relevant verification.
- Review is risk-based, not automatic.
- Explicit requests authorize ordinary local work and requested ARCS updates.
- Confirm destructive, irreversible, remote, deployment, publication, and Git effects.

Use `arcs loop start` only when the user explicitly wants iterative loop execution.
