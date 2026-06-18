---
name: the-ladder
description: "Use before writing code as a constructive minimalism reflex — triggers: 'minimal solution', 'simplest thing that works', 'do less', 'shortest path', 'reach for stdlib first', 'before writing code'. Auto-layers onto quick-dev / code-agent to build the smallest thing that works before reaching for new code or dependencies."
---

# Skill: the-ladder

## When

Loaded alongside a work-mode (quick-dev / code-agent / executing-plans), before writing code. A constructive build-minimal reflex — the complement to the subtractive gates (brainstorming, devil-advocate, code-reviewer).

## The ladder

Before writing code, stop at the FIRST rung that holds — it's a reflex, not a research project. Two rungs work → take the higher one and move on:

1. Does this need to exist at all? Speculative need → skip it, say so in one line. (YAGNI)
2. Does the standard library already do it? Use it.
3. Does a native platform feature cover it? (e.g. a DB constraint over app code, a built-in over a dependency.) Use it.
4. Does an already-installed dependency solve it? Use it — never add a new dependency for what a few lines cover.
5. Can it be one line? Make it one line.
6. Only then: write the minimum code that works.

## Rules

- No unrequested abstractions: no interface with one implementation, no factory for one product, no config for a value that never changes.
- No boilerplate or scaffolding "for later". Deletion over addition. Boring over clever. Fewest files, shortest working diff.
- Two stdlib options the same size? Take the one that's correct on edge cases — minimal means less code, not the flimsier algorithm.
- Complex request → ship the minimal version AND question the rest in the same response ("Did X; Y covers it. Need full X? Say so."). Never stall on a default you can pick.

## When NOT to be minimal (hard carve-outs)

Never simplify away: input validation at trust boundaries, error handling that prevents data loss, security measures, accessibility basics, or anything the user explicitly requested. If the user insists on the full version, build it — no re-arguing.

Minimal code without its check is unfinished: non-trivial logic (a branch, a loop, a parser, a money/security path) leaves behind ONE runnable check — the smallest thing that fails if the logic breaks (an assert-based self-check or one small test). No frameworks, no fixtures unless asked. Trivial one-liners need no test — YAGNI applies to tests too. (This complements, does not replace, the test-driven-development skill when that work-mode is active.)

## Output discipline

Code first, then at most three short lines: what was skipped and when to add it. If the explanation is longer than the code, delete the explanation — every paragraph defending a simplification is complexity smuggled back as prose. Explanation the user explicitly asked for (a report, a walkthrough) is exempt.

## SHORTCUT markers (deliberate-simplification convention)

Mark every deliberate simplification inline so it reads as intent, not ignorance, and stays auditable. ARCS convention — joins the TODO/FIXME family:

```
// SHORTCUT: <ceiling>, upgrade when <trigger>
```

The comment names the known ceiling AND the trigger to revisit. Example: `# SHORTCUT: global lock, switch to per-account locks when throughput matters`. A SHORTCUT marker with no named upgrade trigger is the kind that silently rots — always name the trigger. (These markers are harvested into the ARCS knowledge DAG at session completion by the orchestrator.)

## Boundaries

This skill governs WHAT you build (minimal), not correctness or how you talk. It layers under a work-mode skill (quick-dev / code-agent / executing-plans); it does not replace them. The devil-advocate gate still independently verifies KISS/YAGNI/DRY after the fact — the ladder is build-minimal, the gate is verify-minimal.
