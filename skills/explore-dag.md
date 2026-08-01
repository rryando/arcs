---
name: explore-dag
description: Navigate and understand the project DAG
---

> **Canonical source:** `src/cli/arcs-orchestrate.ts` under `### EXPLORE Workflow`.

## When

Need to understand project relationships, find context, inspect plan and knowledge indexes, or traverse dependencies.

## Flow

```mermaid
flowchart TD
    classDef sub fill:#8b5cf6,color:#fff

    A[arcs project list → big picture] --> B{Question answered by DAG?}
    B -->|yes| C[Report from DAG data]
    B -->|no| D[Dispatch graph-explorer: codegraph then bounded source fallback]:::sub
    D --> E{Durable discovery proposed?}
    E -->|yes| F[Gate proposal before orchestrator persistence]
    E -->|no| C
    F --> C
```

## CLI Primer

```bash
arcs <command> --json
```
Discovery: `arcs --commands --json`

## Key Commands

| Operation | Command |
|-----------|---------|
| All projects | `arcs project list --json` |
| Project meta | `arcs project get <slug> --json` |
| Project doc | `arcs project get <slug> --doc=<doc> --json` |
| Plan and knowledge indexes | `arcs plan list <slug> --json` / `arcs knowledge list <slug> --json` |
| Full body | `arcs plan get <slug> <id> --body --json` / `arcs knowledge get <slug> <id> --body --json` |
| Search | `arcs search <slug> "<query>" --json` |

## Traversal Pattern

1. `arcs project list --json` → get all projects + `dependsOn[]`
2. Filter for dependencies of interest
3. `arcs project get <slug> --json` per dependency for meta/docs
4. Build dependency chain

For repository questions, use DAG-first search (`arcs search`, `arcs related`, and indexed bodies). When DAG evidence is insufficient, `graph-explorer` uses codegraph if available, then bounded source fallback. Exploration remains read-only; durable findings are proposals until their owning phase passes.

## Tips

- Start with `arcs project list` for the big picture
- Use `knowledge` docs to quickly understand unfamiliar codebases
- Check `status` to know if a dependency is still actively maintained
- Persist durable discoveries via `arcs knowledge upsert`
