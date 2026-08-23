---
name: init-project
description: Initialize a repository as an ARCS project with useful minimal metadata
---

# Initialize Project

## Method

An explicit request to init or track a project authorizes local ARCS initialization. Ask only for missing user-owned identity such as name, description, workspace path, or dependency choice.

1. Check slug conflicts with `arcs project list`.
2. Verify named dependency projects exist.
3. Run `arcs project init` with the requested metadata.
4. Add only requested or clearly useful overview/dependency documentation.
5. Validate the new project and report slug and paths.

Codegraph is optional. When available, initialization may index the workspace and emit structural proposals. When absent, continue without it. If `pending_enrichment` is true, process useful proposals with `enriching-codegraph-proposals`; no broad agent fan-out required.

Raw proposals are not knowledge. Inspect before keep, merge, drop, or promote decisions. Never infer destructive cleanup, deployment, publication, or Git permission from initialization.

If a write fails, stop and report partial state instead of layering more mutations on an uncertain project.
