---
name: enriching-codegraph-proposals
description: Triage pending codegraph proposals into useful project knowledge
---

# Enrich Codegraph Proposals

## When

Use when init or codegraph sync reports `pending_enrichment: true`, or when the user asks to process the proposal queue.

Designated `arcs-docs` owns authorized curation using `writing-knowledge` freshness and deduplication rules. Main routes source-bearing proposal inspection, not reading it locally. No nested delegation; return missing evidence to main for routing.

## Method

1. Run `arcs proposal list <slug>`.
2. Inspect the proposal's structural facts, source files, and likely duplicates.
3. Choose **keep**, **merge**, or **drop**:
   - keep a distinct useful boundary grounded in real code;
   - merge when an existing entry is the right home and the proposal adds evidence;
   - drop tests-only, docs-only, tiny, stale, duplicate, or unsupported noise.
4. For keep or merge, author a human title, concise impact summary, substantive body, and source files.
5. Apply the requested promote/drop operation and continue until the useful queue is handled.

Proposal source files may carry `startLine`/`endLine`, resolved deterministically at ingest where possible; promotion carries those ranges into knowledge `codeChunks`. When you know the region, supply or keep a precise range over a bare free-text anchor.

Source files and structural evidence must support every promoted claim. Never invent responsibilities from names alone. Preserve proposal IDs and give a reason for drops. Cap source files to the most useful anchors when the raw list is large.

Use `--body-file` for long bodies. Stop and report races or missing merge targets instead of silently changing the decision.

## Probabilistic Checks (Jev)

Triage proposals with `jev_rank` and `jev_judge`, and `jev_verify` a claim before promoting it into knowledge. Source files and structural evidence remain the authority.

## Return

Report counts and IDs for kept, merged, dropped, and deferred proposals, plus created or updated knowledge IDs.
