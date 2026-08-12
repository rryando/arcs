# Optional Codegraph Diff Analysis

Use the cached PR diff from the parent review; never fetch a second diff.

1. Extract changed symbols and files from the cached diff.
2. Query codegraph impact, callers, callees, or exploration only for material boundaries.
3. Check whether callers, public contracts, or high-coupling modules are omitted from tests or migration notes.
4. Return concise evidence-linked risks to the parent review.

Skip this analysis when the index is absent or the diff is local and obvious.
