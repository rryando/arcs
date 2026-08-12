---
name: writing-knowledge
description: Capture durable, actionable project knowledge without summary-only stubs
---

# Writing Knowledge

## When

Capture a non-obvious fact that will save future work. Skip mechanical or instantly re-derived information.

## Method

1. Choose the right kind: gotcha, lesson, pattern, architecture, decision, module, feature, or reference.
2. Run `arcs knowledge template --kind=<kind>` when the kind's structure is useful.
3. Write a specific title, useful summary, substantive body, keywords, and source files.
4. Search for an existing entry when duplication is plausible; prefer idempotent `upsert`.

Summary is the headline; body is the reasoning and operational detail; source files anchor the entry to current code. A file-specific entry should include all three.

When the user requested the knowledge write, execute it directly with `arcs knowledge upsert` and report the resulting ID. Otherwise return the proposed entry for confirmation only when the write would be surprising.

Validate that a future agent could act on the entry without re-deriving it.
