---
name: quick-dev
description: Use when the task is fully bounded with no open decisions — rename, refactor, extract, multi-var/multi-file change, API shape already known, config nudge, copy update, trivial targeted bugfix
---

# Quick Dev

This technique is for the assigned engineer, not permission for main to inspect or edit code. No nested delegation.

## When

The files and behavior are already clear and success criteria are derivable without asking. Not for open design decisions (`tech-architect`) or new behavior and UX changes (`brainstorming`).

## Method

1. Read the knowledge entries named in your dispatch; search once (`arcs knowledge search <slug> "<keywords>"`) only when none were named and the change is not purely mechanical.
2. Apply `the-ladder`: stdlib, platform feature or installed dependency before new code.
3. Execute the change directly — no planning doc, no brainstorming, no TDD ritual.
4. Run the dispatch VERIFY command or the targeted checks for the touched behavior; never the full suite. Report out-of-scope failures without fixing foreign files.

If hidden complexity surfaces, stop, state the issue and return partial so main can reroute to `tech-architect` or `brainstorming`. Do not silently expand scope. Commit only when asked.

## Return

Use the compact typed return. A genuine non-obvious gotcha goes under KNOWLEDGE as a candidate for `arcs-docs`; mechanical changes capture nothing.
