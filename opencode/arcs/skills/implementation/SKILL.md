---
name: implementation
description: Inspect, edit, verify, or execute a ready plan node
---

# Implementation

## Work Modes

`bounded`, `inspect`, and `plan-node` are hints, not lifecycle gates:

- **bounded:** the requested files and behavior are already clear; start directly.
- **inspect:** inspect the smallest repository surface needed to resolve implementation details.
- **plan-node:** check declared dependencies, execute the current ready node within its scope, run relevant verification, and align task and diagram state through the ARCS CLI. Never edit DAG files or diagrams directly, execute a blocked node, or absorb an adjacent outcome.

In any mode, ask only when evidence cannot resolve a change to the goal, material scope, dependency strategy, or risk.

## Method

1. Inspect relevant code and tests.
2. Reuse existing patterns and dependencies.
3. Edit the minimum code needed for a complete result.
4. Add proportionate tests for changed behavior.
5. Verify with targeted checks; use broader checks for broad or high-risk work.
6. If verification fails, fix failures caused by the change and rerun the relevant check.

For `plan-node`, read the current node metadata, confirm every predecessor is done, and use ARCS CLI task and diagram commands to keep completion state aligned. If dependencies are unmet or the node conflicts with its scope, stop with the concrete blocker instead of selecting other work.

Prefer necessity → standard library → platform capability → installed dependency → minimum custom code. Do not simplify away security, accessibility, validation, error handling, or data-loss protection.

Do not commit, push, deploy, or modify unrelated files without an explicit request.

## Return

Report changed files, verification actually run, remaining risk, and blockers.
