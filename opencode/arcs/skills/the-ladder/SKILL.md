---
name: the-ladder
description: "Use before writing code as a constructive minimalism reflex — triggers: 'minimal solution', 'simplest thing that works', 'do less', 'shortest path', 'reach for stdlib first', 'before writing code'. Auto-layers onto quick-dev / implementation to build the smallest thing that works before reaching for new code or dependencies."
---

# The Ladder

A build-minimal reflex for the assigned engineer, layered under a work mode (`quick-dev`, `implementation`). It governs what gets built, not who reads or edits code: the orchestrator still delegates.

## Rungs

Stop at the first rung that holds; it is a reflex, not a research project.

1. Does this need to exist at all? Speculative need → skip it and say so in one line.
2. Does the standard library already do it? Use it.
3. Does a native platform feature cover it (a DB constraint over app code, a built-in over a dependency)? Use it.
4. Does an installed dependency solve it? Use it; never add a dependency for what a few lines cover.
5. Can it be one line? Make it one line.
6. Only then write the minimum code that works.

## Rules

- No unrequested abstractions, scaffolding for later, or config for a value that never changes. Deletion over addition, boring over clever, shortest working diff.
- Between two equally small options take the one that is correct on edge cases.
- Never simplify away input validation at trust boundaries, error handling that prevents data loss, security, accessibility basics, or anything the user explicitly requested.
- Non-trivial logic leaves one runnable check that fails if it breaks; trivial one-liners need none.
- Mark deliberate simplifications inline as `// SHORTCUT: <ceiling>, upgrade when <trigger>`; a marker without a trigger rots. A durable, non-obvious ceiling is a `gotcha` candidate under KNOWLEDGE for `arcs-docs`.

## Output

Code first, then at most three short lines on what was skipped and when to add it. If the explanation is longer than the code, delete the explanation.
