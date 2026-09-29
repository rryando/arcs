---
name: update-docs
description: Keep ARCS project documents and DAG artifacts accurate
---

# Update Documentation

Read the affected project state, make the requested scoped update, then validate it.

- overview: concise current summary and goals (`arcs project update-doc <slug> overview --body-stdin`);
- tasks: execution state and dependencies;
- plans: broad multi-step outcomes and acceptance — use structured plans for feature work that spans several tasks (`arcs plan create <slug> "<title>" --summary="…" --body-stdin --json`; keywords `spec`/`design` start `proposed`, `implementation-plan` starts `planned`);
- knowledge: durable non-obvious context with useful body and source files — the knowledge.md landing page summarizes and points at structured knowledge entries written per `writing-knowledge` (`arcs knowledge upsert … --audience=<audience> --body-stdin --json`);
- diagrams: derived from task metadata.

Use ARCS CLI mutations rather than editing store internals. Apply evidence-backed corrections directly when requested. Ask only when the change alters the goal, material scope, or destructive/external effects. No automatic Git actions.

Role boundary: designated `arcs-docs` owns authorized docs/knowledge persistence; task/diagram transitions have one explicitly designated owner (main by default). Do not duplicate writes or delegate from a specialist. Main obtains source-dependent facts from workers, not source reads. Knowledge candidates need persisted ID, already covered ID or deferred reason, not automatic creation.
