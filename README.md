<div align="center">

# ARCS

**Agent Routing & Context System**

[![npm](https://img.shields.io/npm/v/@rryando/arcs?color=cb3837&label=npm&logo=npm)](https://www.npmjs.com/package/@rryando/arcs)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

*Persistent workflow continuity for AI agents — start from context, not a blank slate.*

</div>

---

ARCS gives AI coding agents a queryable project DAG so they never start cold. Instead of scanning a codebase from scratch, an agent calls `arcs brief` and gets back: what to work on, what was decided, and what went wrong last time — in a single ~1 KB JSON envelope.

> **arcs** `/ɑːrks/` — Directed edges in graph theory. Also: **A**gent **R**outing & **C**ontext **S**ystem.

---


## The Problem

Every AI coding session starts fresh. The agent doesn't know:
- What task to pick up next (and which tasks are blocked by incomplete work)
- What was already tried and failed
- What architectural decisions were made
- What the current plan looks like

ARCS solves this with three persistent surfaces:

| Surface | Storage | Purpose |
|---------|---------|---------|
| **Queue** | `tasks/index.json` | Work items with dependency ordering via `dependsOn` |
| **Plan** | `plans/*.md` + `.diagram.mmd` | Multi-step feature work with Mermaid execution maps |
| **Memory** | `knowledge/*.md` | Durable discoveries: lessons, patterns, gotchas, architecture |

---



## Quick Start

**1. First Time Setup: Install / Update**

```bash
npm install -g @rryando/arcs

# setup models
arcs init
```

Registers `arcs` CLI, creates `~/.arcs/`, and runs an interactive TUI wizard that:
- Detects **OpenCode** and/or **Claude Code** on PATH
- Selects which platforms to configure (or both)
- For **OpenCode**: picks heavy / standard / light model tiers from authenticated providers
- For **Claude Code**: picks heavy / standard / light model tiers from the full Claude model list (opus / sonnet / haiku families), pre-filled from `~/.claude/settings.json`
- Deploys agents + skills to the appropriate config directories

**2. Init Existing Project to arcs**

```bash
cd your-project

opencode

send `arch init` on ARCS Orchestrator subagent

and follow thru initiation process
```

<img width="948" height="499" alt="image" src="https://github.com/user-attachments/assets/2795bd80-f1bb-4c34-9a60-9b6ef9d81d04" />


**3. Use it**

```bash
arcs brief              # What should I work on?
arcs next               # Get next unblocked task
arcs done <taskId>      # Mark complete, unblock dependents
arcs remember "..."     # Capture what I learned
```

Or select **ARCS Orchestrator** in OpenCode for full automation.

---

## Prerequisites

| Tool | Required | Notes |
|------|----------|-------|
| [Node.js](https://nodejs.org/) v18+ | Yes | Runtime |
| [OpenCode](https://opencode.ai/) | Recommended | Agent host (orchestrator + sub-agents) |
| [Claude Code](https://claude.ai/code) | Recommended | Alternative agent host — `arcs init` deploys ARCS sub-agents with full model-tier selection |
| [graphify](https://github.com/safishamsi/graphify) | No | Optional AST-based codebase knowledge extraction |

---

## How It Works

### The Core Loop

```
arcs next  →  [agent works]  →  arcs done <id>  →  arcs remember "..."
     │                                │                      │
     │ returns first task             │ completes task,      │ captures durable
     │ whose dependencies             │ unblocks dependents  │ knowledge for
     │ are ALL satisfied              │                      │ future sessions
     ▼                                ▼                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ~/.arcs/projects/{slug}/                      │
│                                                                  │
│  tasks/index.json ──dependsOn──→ topological sort → next task   │
│  knowledge/       ──BM25+graph──→ related context               │
│  plans/           ──diagram.mmd──→ execution map                │
└─────────────────────────────────────────────────────────────────┘
```

Three commands: `arcs next` → work → `arcs done`. The DAG handles ordering.

### Task Dependencies — The Actual DAG

Tasks declare dependencies. ARCS enforces acyclicity and uses topological sort to determine execution order:

```bash
arcs task create myapp "Design database schema" --priority=high
arcs task create myapp "Build REST API" --dependsOn=design-database-schema
arcs task create myapp "Write integration tests" --dependsOn=build-rest-api
arcs task create myapp "Deploy to staging" --dependsOn=build-rest-api,write-integration-tests
```

```mermaid
flowchart TD
    T001["Design database schema"]:::done
    T002["Build REST API"]:::inProgress
    T003["Write integration tests"]:::backlog
    T004["Deploy to staging"]:::blocked

    T001 --> T002
    T002 --> T003
    T002 --> T004
    T003 --> T004

    classDef done fill:#22c55e,color:#fff
    classDef inProgress fill:#f59e0b,color:#fff
    classDef backlog fill:#94a3b8,color:#fff
    classDef blocked fill:#ef4444,color:#fff
```

`arcs next` returns "Write integration tests" (T003) — it's the first task whose dependencies are all done. T004 is blocked because T003 isn't done yet. Priority is a tiebreaker within the same topological level, not the primary sort.

### The Orchestrator

When used with [OpenCode](https://opencode.ai/), ARCS ships a full orchestrator that automates the loop:

```mermaid
flowchart TD
    User(["User Request"])
    T0["arcs brief → T0 envelope"]
    Classify{"Classify Intent"}

    Init["INIT\nScan repo → populate DAG"]
    Brain["BRAINSTORM\nCreate plan → wire dependsOn\n→ generate diagram"]
    Exec["EXECUTE\narcs next → dispatch sub-agent\n→ arcs done → unblock dependents"]
    Sync["SYNC\nAudit DAG → reconcile drift"]

    DAG[("Project DAG\ntasks + plans + knowledge\n+ dependency graph")]

    User --> T0 --> Classify
    Classify -- "new project" --> Init
    Classify -- "plan features" --> Brain
    Classify -- "do work" --> Exec
    Classify -- "update docs" --> Sync
    Init & Brain & Exec & Sync --> DAG
```

The orchestrator:
1. **Orients** — calls `arcs brief` for the T0 routing envelope (~1 KB)
2. **Classifies** — detects intent (INIT / BRAINSTORM / EXECUTE / SYNC / EXPLORE)
3. **Delegates** — dispatches specialist sub-agents in parallel when possible
4. **Consumes** — parses structured sub-agent output (STATUS, CHANGES, VERIFY)
5. **Persists** — writes to DAG: task transitions, knowledge captures, plan updates
6. **Advances** — `arcs done` completes tasks, automatically unblocking dependents

### T0 Routing Envelope (the operating brief)

```bash
$ arcs brief --lean --json
```

```json
{
  "slug": "my-project",
  "name": "My Project",
  "operatingBrief": {
    "currentFocus": "Build REST API",
    "recommendedSurface": "QUEUE",
    "why": "Task in progress: Build REST API",
    "nextAction": "Continue task build-rest-api"
  },
  "openTasksCount": 3,
  "topOpenTasks": [
    { "id": "build-rest-api", "title": "Build REST API", "status": "in_progress" },
    { "id": "write-integration-tests", "title": "Write integration tests", "status": "backlog" }
  ]
}
```

~1 KB. No source files read. The orchestrator uses `recommendedSurface` to pick the workflow branch.

---

## CLI Reference

All commands: `arcs <command> [args] --json`. Output: `{ok, data}` on success, `{ok, code, message}` on error.

### Core Agent Loop

| Command | Purpose |
|---------|---------|
| `arcs brief` | T0 routing envelope — what to focus on |
| `arcs next` | Next dependency-safe task + related knowledge |
| `arcs done <taskId>` | Mark complete, unblock dependents |
| `arcs remember "<text>"` | Capture knowledge (auto-classifies kind) |
| `arcs status` | Progress overview across all surfaces |

### Tasks & Dependencies

| Command | Purpose |
|---------|---------|
| `arcs task create <slug> <title> --dependsOn=id1,id2` | Create task with dependency edges |
| `arcs task update <slug> <id> --dependsOn=id1` | Add/update dependencies |
| `arcs task transition <slug> <id> <status>` | Move through lifecycle |
| `arcs diagram ready <slug> <planId>` | Get unblocked diagram nodes |

### Project Management

| Command | Purpose |
|---------|---------|
| `arcs project init` | Register current directory as a project |
| `arcs project update-doc <slug> <doc> --content="..."` | Update a project doc inline |
| `arcs project list` | List all tracked projects |
| `arcs context [slug]` | Full context assembly (audience-targeted) |
| `arcs search <slug> "<query>"` | BM25 + graph-scored search across DAG |
| `arcs validate <slug>` | Health check — status drift, orphans, staleness |

### Plans & Knowledge

| Command | Purpose |
|---------|---------|
| `arcs plan create <slug> <title>` | Create a plan |
| `arcs knowledge create <slug> <title>` | Create knowledge entry |

### Flags

| Flag | Effect |
|------|--------|
| `--json` | Structured JSON output (always use for agents) |
| `--lean` | Strip timestamps (saves tokens) |
| `--dry-run` | Validate without mutation |
| `--help` | Per-command usage |

Full command discovery: `arcs --commands --json`.

> **Batch op format** — fields at top level, NOT nested under `params`:
> ```json
> {"op":"task-create",    "slug":"<slug>","title":"...","priority":"medium","planId":"..."}
> {"op":"task-transition","slug":"<slug>","taskId":"...","status":"done"}
> {"op":"doc-update",     "slug":"<slug>","doc":"overview","content":"..."}
> {"op":"knowledge-create","slug":"<slug>","title":"...","kind":"lesson","summary":"...","body":"..."}
> ```
> Nested `{op, params:{...}}` format is also accepted (unwrapped automatically).

---

## Graph & Retrieval

ARCS builds a relationship graph across all project entities:

| Edge Type | Weight | Connects |
|-----------|--------|----------|
| `task_belongs_to_plan` | 1.0 | Task → Plan |
| `task_blocks_task` | 0.95 | Task → Task (from `dependsOn`) |
| `shares_source_file` | 0.9 | Any → Any (co-reference) |
| `knowledge_touches_file` | 0.85 | Knowledge → File |
| `plan_contains_task` | 0.8 | Plan → Task |
| `shares_keywords` | 0.5 | Knowledge → Knowledge |

Queries: `arcs search` uses BM25 for text + graph traversal (weighted BFS) for relationship scoring. `arcs next` enriches results with related knowledge from the graph.

---

## Sub-Agents

The orchestrator is **delegation-first** — it never reads code, runs tests, or explores. It dispatches specialist sub-agents with scoped prompts and consumes their structured (non-prose) output:

| Sub-Agent | Role | When |
|-----------|------|------|
| **graph-explorer** | DAG-first knowledge + code exploration + graphify graph traversal | Any "where is X / what depends on Y" query |
| **software-engineer** | Writes code, runs tests | EXECUTE — bounded tasks |
| **system-architect** | Module boundaries, plan creation | BRAINSTORM — design-open |
| **tech-architect** | Deep analysis, trade-offs | Analysis without edits |
| **oncall-ops** | Debugging, log triage, bisect | Bugs, test failures |
| **code-reviewer** | Pre-merge review | PR review, phase gates |
| **devil-advocate** | Adversarial KISS/YAGNI/DRY gate | Phase boundaries (mandatory) |
| **arcs-docs** | DAG health, knowledge curation | SYNC workflow |
| **docs-researcher** | External research, documentation | INIT tech-stack scan |
| **qa-analyst** | Convention audits, compliance | Read-only audits |

All sub-agents return **structured output** (not prose) for token-efficient orchestrator consumption:

```
STATUS: done
CHANGES:
- src/foo.ts — added validation
VERIFY:
- vitest run test/foo.test.ts: pass
KNOWLEDGE: none
```

The orchestrator parses STATUS/VERDICT first, extracts KNOWLEDGE/CAPTURES for DAG persistence, and routes SCOPE_CHANGE to diagram regeneration.

### Skills (loaded per-dispatch)

| Category | Skills |
|----------|--------|
| **Work mode** (pick one) | `quick-dev`, `code-agent`, `test-driven-development`, `brainstorming` |
| **Lifecycle** | `writing-plans`, `executing-plans`, `subagent-driven-development` |
| **Quality** | `requesting-code-review`, `deep-pr-review`, `systematic-debugging` |
| **Tooling** | `to-diagram`, `init-project`, `caveman-commit`, `enriching-graphify-proposals` |

---

## Data Model

```
~/.arcs/
├── meta.json                         # Global registry
└── projects/{slug}/
    ├── meta.json                     # Project metadata + workspace paths
    ├── overview.md                   # Summary + goals
    ├── tasks.md                      # Rendered task queue (human-readable)
    ├── tasks/index.json              # Structured tasks + dependsOn edges
    ├── plans/
    │   ├── {id}.meta.json            # Plan status + keywords
    │   ├── {id}.md                   # Plan body
    │   └── {id}.diagram.mmd          # Mermaid execution map (auto-generated arrows)
    └── knowledge/
        ├── index.json                # Knowledge index
        ├── {id}.meta.json            # Metadata (kind, audience, sourceFiles)
        └── {id}.md                   # Entry body
```

### Knowledge Kinds

8 structured categories: `lesson`, `gotcha`, `pattern`, `architecture`, `module`, `feature`, `reference`, `decision`.

---

## Graphify (Optional)

When [graphify](https://github.com/safishamsi/graphify) is on PATH, ARCS auto-extracts structural knowledge during INIT and SYNC:

| Category | Cap | What |
|----------|-----|------|
| God nodes | 8 | Highest-connectivity modules |
| Clusters | 8 | Directory-based module boundaries |
| Couplings | 5 | Cross-module dependency links |

### Graph-Explorer Integration

The `graph-explorer` sub-agent uses graphify as **Step 5** in its query protocol — after ARCS DAG queries (Steps 1–4) but before any file-system fallback. When `graphify-out/graph.json` exists, the agent can:

- **Query** — BFS/DFS traversal from matching nodes (`graphify query "..."`)
- **Path** — shortest path between two concepts (call chains, dependency paths)
- **Explain** — node neighborhood: all connections, relations, and source locations

This provides fine-grained structural answers (individual call chains, coupling paths, function neighborhoods) that are richer than ARCS knowledge entries without resorting to grep/find.

---

## Development

```bash
git clone https://github.com/rryando/arcs.git
cd arcs && npm install && npm run build
```

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Vitest suite (~833 tests) |
| `npm run typecheck` | Type check without emit |
| `npm run lint` | Biome lint + format |

### Bundle Workflow

```bash
npm run build:opencode-bundle    # Build agent/skill bundle
arcs lint-bundle                 # Validate bundle integrity
arcs deploy-superpowers          # Deploy to ~/.config/opencode/
```

**What `deploy-superpowers` writes to `opencode.json`:**

The bundle merges a small set of keys into your `~/.config/opencode/opencode.json`. Each merge entry has a `mode`:

| Mode | Behavior | Used for |
|------|----------|----------|
| `overwrite` (default) | Always sets the value, even on re-deploy | Plugin registration |
| `if-absent` | Only sets if the key isn't already present | User-preference keys: `model`, `small_model`, `agent.{build,plan,general}.model`, `lsp` |
| `merge` | Deep-merge: adds new keys, never overwrites existing user values | Sub-agent definitions, `permission.external_directory` |

This means: **your config is always respected.** Provider/model routing seeds on first install but never re-stamps. Sub-agent definitions get new fields (prompt paths, descriptions) on re-deploy but your model overrides survive. JSONC comments in `opencode.json` are supported.

---

## License

MIT
