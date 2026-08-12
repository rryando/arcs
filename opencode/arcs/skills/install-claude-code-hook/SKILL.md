---
name: install-claude-code-hook
description: Install the ARCS session-bridge hook into an existing Claude Code workspace
---

# Install Claude Code Hook

## Boundary

Claude Code only. If the current harness is not Claude Code, stop. The hook changes `.claude/settings.local.json`, so obtain explicit confirmation before using `--write`.

## Method

1. Run `arcs hooks status <slug> --json`.
2. If already installed for this slug, report a no-op.
3. Explain the file written, registered events, local token, and that a new Claude Code session is required.
4. If the hook points at another slug, warn that installation will repoint it and confirm that effect.
5. After explicit confirmation, run `arcs hooks install-claude-code <slug> --write --json` once.
6. Report `settingsPath`, events, and next-session requirement.

Do not hand-edit Claude settings. A malformed settings file is a stop condition: surface the CLI error and do not repair, reformat, or delete it. Do not rerun installation for reassurance because it may rotate the token.

Without confirmation, offer the snippet-only command without `--write`.
