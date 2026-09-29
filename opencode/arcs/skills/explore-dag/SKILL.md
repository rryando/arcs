---
name: explore-dag
description: Find project, plan, task, and knowledge context efficiently
---

# Explore the DAG

Start with the narrowest useful command over the plan and knowledge indexes:

- `arcs brief <slug>` for current focus;
- `arcs search <slug> "<query>"` for mixed entities;
- `arcs plan|task|knowledge|doc list/get` for a known surface;
- `arcs related <slug> --task=<id>|--plan=<id>|--knowledge=<id>` for graph neighbors;
- `arcs project list/get` for cross-project context.

Use optional `graph-explorer` only when a code-structure or dependency question needs codegraph or targeted source evidence. Report the answer directly and avoid broad scans.

Main may read metadata and initialize orchestration state, but delegates source-dependent discovery and source-bearing proposals. No mandatory DAG-first retrieval chain. Route authorized knowledge curation to designated `arcs-docs`; do not inspect source or persist knowledge in main.
