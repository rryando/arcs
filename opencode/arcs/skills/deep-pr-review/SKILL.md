---
name: deep-pr-review
description: Review a GitHub PR deeply and post only after explicit user confirmation
---

# Deep PR Review

## Boundary

Remain read-only until the user confirms the exact posting mode and payload. Never auto-approve. Use one GitHub write for the final review.

## Gather Once

Cache repository metadata, PR metadata, and the diff once:

```bash
gh repo view --json name,owner
gh pr view <number> --json number,title,body,author,labels,reviews,state,files,headRefName,baseRefName
gh pr diff <number>
```

Verify the current checkout matches the PR repository. Reuse the cached diff for review and optional `codegraph-diff.md` analysis.

## Review

Check correctness first, then activate only relevant dimensions: security, tests, compatibility, KISS/YAGNI/DRY, architecture, and performance. Cite every finding with a diff location and consequence. Large PRs may use summary mode.

Present findings and ask the user to choose: critical-only, actionable, all, summary-only, or do not post. Show the exact payload before confirmation.

For inline modes, batch summary and comments into one `gh api POST .../reviews` call. For summary-only, use one `gh pr review --comment` call. Do not mix posting methods or post comments one by one.

Recurring knowledge is optional and separately authorized from GitHub posting.

## Return

Report scope, findings by severity, cleared risks, confidence/gaps, and the chosen posting result.
