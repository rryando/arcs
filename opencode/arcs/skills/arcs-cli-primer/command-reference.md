# ARCS command reference

Use `arcs --commands --json` and `arcs <command> --help` as the live specification. Common surfaces:

| Need | Command |
|---|---|
| project context | `arcs brief <slug>`, `arcs context <slug>` |
| search | `arcs search <slug> <query>`, `arcs knowledge search <slug> <query>` |
| ready work | `arcs next <slug>` |
| tasks/plans | `arcs task list|get|create|update|transition`, `arcs plan list|get|create|update-meta|update-body` |
| knowledge | `arcs knowledge list|get|create|upsert|update-meta|update-body|search` |
| dependencies | `arcs dependency add|remove` |
| diagrams | `arcs diagram init|inspect|ready|validate|status|sort-metadata|show` |
| proposals | `arcs proposal list|promote|drop|backfill` |
| completion | `arcs done <slug> <taskId>`, `arcs report get|list` |
| worktrees | `arcs worktree ensure|validate|list|prune` |
| health | `arcs validate <slug>`, `arcs audit <slug>`, `arcs lint-bundle` |

All command syntax, supported flags, dry-run behavior, and error envelopes come from the live CLI. Capture stderr as well as stdout when diagnosing a failed command.
