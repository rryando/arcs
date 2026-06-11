# Code Quality Reviewer Prompt Template

Use this template when dispatching a code quality reviewer subagent.

**Purpose:** Verify implementation is well-built (clean, tested, maintainable)

**Only dispatch after spec compliance review passes.**

```
Task tool (arcs:code-reviewer):
  Apply the review dimensions/checklist from requesting-code-review/code-reviewer.md.
  Output format: the JSON envelope defined below — NOT the template's envelope+VERDICT format.

  WHAT_WAS_IMPLEMENTED: [from implementer's report]
  PLAN_OR_REQUIREMENTS: Task N from [plan-file]
  BASE_SHA: [commit before task]
  HEAD_SHA: [current commit]
  DESCRIPTION: [task summary]
```

**In addition to standard code quality concerns, the reviewer should check:**
- Does each file have one clear responsibility with a well-defined interface?
- Are units decomposed so they can be understood and tested independently?
- Is the implementation following the file structure from the plan?
- Did this implementation create new files that are already large, or significantly grow existing files? (Don't flag pre-existing file sizes — focus on what this change contributed.)

## Report Format (MANDATORY)

Return brief prose findings FIRST, then this EXACT JSON block as the LAST thing in your message — nothing after it:

```json
{
  "status": "DONE | DONE_WITH_CONCERNS",
  "summary": "<1-2 sentences: quality verdict>",
  "payload": {
    "approved": true,
    "issues": [
      {
        "severity": "critical | important | minor",
        "file": "src/foo.ts",
        "line": 15,
        "finding": "Variable name unclear",
        "suggestion": "Rename `d` to `duration`"
      }
    ]
  }
}
```

- `approved: true` = quality acceptable (minor issues OK)
- `approved: false` = must fix before proceeding (has critical/important issues)
- Severity: `critical` (must fix), `important` (should fix), `minor` (nice to fix)

**No prose after the JSON block.**
