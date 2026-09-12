---
name: caveman-commit
description: Write a terse Conventional Commit message from an existing diff
---

# Caveman Commit

Assigned specialists read the diff and output a commit message only; never run Git commands for this skill. Main delegates source-bearing diff reads or drafts from supplied change summaries; explicit user-authorized Git bookkeeping remains main work. Skills do not expand role authority.

Format the subject as `type(scope): imperative`, preferably at most 50 characters and never over 72. Use a body only when the reason is not obvious, or for breaking changes, security fixes, migrations, and reverts. Wrap body lines at 72 characters.

Use established project types and scopes. Avoid filler, AI attribution, emoji unless conventional, and a trailing subject period.

Return only the message in a code block.
