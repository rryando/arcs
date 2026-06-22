---
name: writing-knowledge
description: Use when capturing a knowledge entry, before writing its body — to author a substantive per-kind body, not a summary-only stub
---

# Skill: writing-knowledge

## When

You are about to persist a durable insight to the DAG (`arcs knowledge upsert` / `create`) and need the entry to be *actionable*, not a stub.

> CLI Primer: `arcs --commands --json` for discovery. Mutating commands run directly — no token.

## The Floor: Every Entry Needs a Body

A knowledge entry is two things: a `--summary` (the headline) and a `--body` (the substance). The single most common KB failure is the **summary-only stub** — an entry whose summary just restates its title and whose body is empty. It is structurally "healthy" and worthless to the next dispatch.

EVERY non-mechanical entry MUST carry a real `--body` (`--body="…"` inline, or `--body-file=<path>` once it's long enough to fight shell-escaping). The value lives in the body, written to the **anatomy of its kind**.

## Scaffold, Don't Freehand

Before writing, scaffold the section skeleton from the command:

```bash
arcs knowledge template --kind=<kind> --json   # structured sections
arcs knowledge template --kind=<kind>          # plain markdown skeleton
```

This emits one `## <heading>` per section with a deletable hint comment. **Fill EVERY section** — a half-filled skeleton is still a stub.

> **DRY / authoritative source:** `arcs knowledge template` is the AUTHORITATIVE skeleton. The anatomy below only *illustrates* the shape. If the table here ever diverges from the command output, **the command wins** — scaffold from it, not from this file.

## The 8 Kinds at a Glance

| Kind | Section anatomy |
| --- | --- |
| **gotcha** | Symptom · Root cause · Fix or workaround · Trigger |
| **lesson** | Expectation · What happened · Why · Next time |
| **pattern** | When to use · Shape · Example · When not to use |
| **architecture** | Structure · Invariant or constraint · Failure mode |
| **decision** | Decision · Rationale and forces · Alternatives rejected · Consequences |
| **module** | Purpose · Key files and entry points · Responsibilities · Dependencies |
| **feature** | What it does · How it works · Entry points · Edge cases |
| **reference** | Summary · Canonical location · Usage notes |

Pick the kind by what the insight *is*: a bug you hit → `gotcha`; a wrong belief corrected → `lesson`; a reusable shape → `pattern`; a structural why → `architecture`; a single settled call → `decision`; an area of the codebase → `module`/`feature`; a pointer to a canonical source → `reference`.

## Write

```bash
arcs knowledge upsert <slug> "<title>" \
  --kind=<kind> \
  --summary="<one-line headline>" \
  --body="<every section of the kind, filled>" \
  --keywords="<k1,k2>" \
  --source-files="<path[:anchor],…>" \
  --json
```

`upsert` is idempotent by title — create-or-update, no dedup search dance. `--summary` AND `--body` AND `--source-files` together are the floor for a file-specific entry. Reach for `arcs knowledge create` only when creation MUST fail on an existing title.

## Self-Check Before You Commit

> **"Could someone act on this in six months without re-deriving it?"**

If the insight cost you reasoning, a debug session, or a dead end, capture *that* — not just its one-line conclusion. Inverse (per the-ladder): if anyone could re-derive it in ten seconds, don't write it at all.

## Constraints

- Scaffold from `arcs knowledge template` — never freehand the section headings.
- Fill every section; a half-filled skeleton is a stub.
- `--summary` is the headline, `--body` is the value — never ship summary-only.
- Match kind to the nature of the insight; don't force everything into `gotcha`.
- Skip capture entirely for purely mechanical work (renames, config nudges, diagram regens).
