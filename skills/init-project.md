---
name: init-project
description: Initialize a project in the ARCS DAG
---

# Initialize Project

An explicit request to track or initialize a project authorizes the local DAG write.

1. Gather missing name, description, workspace path, and dependencies.
2. Check slug and dependency conflicts.
3. Run `arcs project init`.
4. Add requested overview or dependency documentation.
5. Validate and report the project slug.

Codegraph is optional and must not block initialization. If it creates proposals, inspect them before promoting useful knowledge. Do not infer deployment, publication, destructive cleanup, or Git permission.

Main may read metadata and initialize orchestration state, but delegates source-dependent discovery and source-bearing proposals. No mandatory DAG-first retrieval chain. Route authorized knowledge curation to designated `arcs-docs`; do not inspect source or persist knowledge in main.
