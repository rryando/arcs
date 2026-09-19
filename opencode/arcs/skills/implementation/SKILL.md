---
name: implementation
description: Inspect, edit, verify, or execute a ready plan node
---

# Implementation

This technique is for the assigned engineer, not permission for main to inspect or edit code. No nested delegation. Unknown paths are valid bounded discovery within the assigned boundary.

## Work Modes

`bounded`, `inspect`, and `plan-node` are hints, not lifecycle gates:

- **bounded:** files and behavior already clear; start directly.
- **inspect:** smallest repository surface needed to resolve details.
- **plan-node:** check declared dependencies, execute the ready node within its scope, run relevant verification, and return task/diagram evidence to the designated transition owner through ARCS CLI context. Never edit DAG files directly, execute a blocked node, or absorb an adjacent outcome.

In any mode, ask only when evidence cannot resolve a change to goal, material scope, dependency strategy, or risk.

## Method

1. Inspect relevant code and tests.
2. Reuse existing patterns and dependencies.
3. Edit the minimum code needed for a complete result.
4. Add proportionate tests for changed behavior.
5. Verify with targeted checks; broader checks for broad or high-risk work.
6. If verification fails, fix failures caused by the change and rerun the relevant check.
7. Close out through `arcs done <slug> <taskId>`, which captures the completion receipt (commit link and diffstat) deterministically. Do not hand-write a "what changed" summary.

For `plan-node`, read current node metadata, confirm every predecessor is done, and keep task/diagram state aligned through the single designated owner; use ARCS CLI mutations yourself only when explicitly assigned that ownership. If dependencies are unmet or the node conflicts with its scope, stop with the concrete blocker instead of selecting other work.

Prefer necessity → standard library → platform capability → installed dependency → minimum custom code. Do not simplify away security, accessibility, validation, error handling, or data-loss protection.

Do not commit, push, deploy, or modify unrelated files without an explicit request.

## Probabilistic Checks (Jev)

Call `jev_verify` on your reported claims, or `jev_health` before declaring the outcome complete; they are evidence alongside the receipt, not a replacement for it. Route every failing check through `jev_diagnose` before choosing a fix, and fall back explicitly when a tool returns `unavailable`.

## Return

Report claim-linked acceptance evidence, examined versus changed files, actual checks with result/working directory, not-run checks, uncertainty and blockers. Relay the receipt's commit link and diffstat as the change evidence: a hand-typed change summary is not evidence, and the receipt is generated, so never fabricate a sha or diffstat. Return durable create/update knowledge candidates with evidence and stale/conflicting reused IDs to docs; do not persist them yourself.
