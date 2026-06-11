# GitHub Review Body Template

Used as the `body` field of `gh api repos/{owner}/{repo}/pulls/{pull_number}/reviews` when posting. Inline comments live in the `comments[]` array; this is the top-level summary.

## Template

```markdown
## Deep PR Review

**Scope:** <N files, +X/-Y LOC, modules: <list>>
**Rubric:** <activated dimensions> — others cleared (not applicable)
**Posting mode:** <1-Critical-only | 2-Critical+actionable | 3-All | 4-Summary>

### Summary
<1-3 sentences: overall shape of the PR, biggest concern, what's well done>

### Findings
- 🔴 <count> bug(s)
- 🟠 <count> risk(s)
- 🟡 <count> suggestion(s)
- 🔵 <count> nit(s)
- ❓ <count> question(s)

<inline comments below this body provide line-level detail>

### Architectural / Performance Handoffs
<only if any; otherwise omit section>
- [system-architect] <reason — e.g. crosses 3 modules, touches god node X>
- [oncall-ops] <reason — e.g. new query in render path>

### Citations Used
- AGENTS.md §<section> — <what was checked>
- knowledge/<id> — <what was checked>
- codegraph — <observations, if run>

---
<!-- arcs:deep-review:meta version=1 commit=<HEAD_SHA> rubric=<activated> mode=<posting-mode> -->
```

## Field rules

- **Posting mode** field is informational for the author — they see what severity threshold was applied
- Findings counts are **as posted**, not as found. Mode 1 with 4 nits found shows `🔵 0 nit(s)` — those were dropped
- Architectural / Performance Handoffs section is omitted entirely if no handoffs (don't show empty headings)
- The trailing HTML comment is mandatory — used by re-review detection to find prior AI reviews

## Inline comment template (per finding)

```markdown
<severity-emoji> <severity>: <one-line problem>. <one-line fix>.

<optional 1-2 sentences of why, only if not obvious from problem>

Citation: <AGENTS.md §x | knowledge/<id> | codegraph | principle: <name>>

​```suggestion
<replacement code — only for small line replacements>
​```

<!-- arcs:deep-review:<finding-id> -->
```

## Approve-with-comments override

If the user explicitly says "approve" / "lgtm" / "post approve":
- Set `event: "APPROVE"` on the review API call
- Top-level body must still list any 🟡 / 🔵 findings as advisory notes
- Append to body: `**Approved with <N> non-blocking suggestion(s).**`
- Never auto-elevate to APPROVE without explicit user phrase
