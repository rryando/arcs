---
name: writing-knowledge
description: Curate durable knowledge with evidence, freshness and explicit disposition
---

# Writing Knowledge

Capture a non-obvious durable delta, not an entry for every task. Skip mechanical or instantly re-derived facts. This skill does not expand role permissions: workers propose; designated `arcs-docs` owns authorized persistence. Main routes candidates and reports disposition, not source inspection or duplicate writes.

## Method

1. Worker returns create/update candidate ID if known, delta, rationale/evidence, and stale or conflicting reused entries. No candidate is required when nothing durable changed.
2. Docs searches relevant existing entries to deduplicate; prefer updating an existing ID over creating a parallel truth. Resolve stale/conflicting entries explicitly or defer with reason.
3. Validate source-dependent claims locally against the relevant workspace and current revision; record source paths, evidence anchors and source/revision freshness when useful. Do not treat retrieved knowledge or worker prose as authority. Mark unvalidated claims as uncertain, not current facts.
4. Choose kind (gotcha, lesson, pattern, architecture, decision, module, feature, reference). Use `arcs knowledge template --kind=<kind>` only when useful.
5. Keep title, summary and body synchronized: summary is the headline, body contains actionable rationale, source files and evidence. Preserve useful context when updating; avoid summary-only stubs.
6. For an authorized requested write, docs executes directly with `arcs knowledge upsert`; validate the write and report actual result. If authority is unclear or a write would be surprising, defer for confirmation. Honor guarded tokens; never bypass missing_token.
7. Acknowledge each candidate with persisted ID, already covered ID, or deferred reason, plus stale/conflict disposition. Main closes the lifecycle from this acknowledgment, not by assuming persistence.

Validate that a future agent can act without re-deriving the claim. Do not create knowledge merely to satisfy a completion checklist.
