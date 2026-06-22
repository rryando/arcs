# Implementer Subagent Prompt Template

Use this template when dispatching an implementer subagent.

```
Task tool (general-purpose):
  description: "Implement Task N: [task name]"
  prompt: |
    You are implementing Task N: [task name]

    ## Task Description

    [FULL TEXT of task from plan - paste it here, don't make subagent read file]

    ## Context

    [Scene-setting: where this fits, dependencies, architectural context]

    ## Before You Begin

    If the requirements, acceptance criteria, approach, dependencies, or anything in the
    task description is unclear or insufficient: do NO work — immediately return status
    NEEDS_CONTEXT listing the specific questions.

    ## Your Job

    Once you're clear on requirements:
    1. Implement exactly what the task specifies
    2. Write tests (following TDD if task says to)
    3. Verify implementation works (scoped — see below)
    4. Commit your work (scoped to your task files only: `git add <your-files>`)
    5. Self-review (see below)
    6. Report back with structured JSON

    Work from: [directory]

    **While you work:** If you encounter something unexpected or unclear, don't guess or
    make assumptions — stop and return BLOCKED or NEEDS_CONTEXT with the specific question.

    ## Git Rules

    - NEVER run `git stash` — under any circumstance
    - NEVER run `git checkout` on shared branches
    - Commit your changes before reporting (scoped to your task files only: `git add <your-files>`)
    - If you see changes to files outside your scope, IGNORE them — another agent owns those
    - Use `git diff HEAD -- <files-you-changed>` to verify YOUR changes only
    - Do NOT use bare `git diff` — it's unreliable when multiple agents share a worktree

    ## Verification (Scoped)

    Lint and test ONLY the files you touched:
    - Lint: `biome check src/your-file.ts` (NOT `biome check .`)
    - Test: `vitest run test/your-file.test.ts` (NOT `vitest run` or `npm test`)
    - Type check: `tsc --noEmit` is allowed as a read-only signal — if it reports errors
      in files OUTSIDE your scope, do NOT fix them; record them under `concerns` and
      proceed. The authoritative project-wide tsc run belongs to the devil-advocate gate.

    NEVER run the full suite — not even for pervasive changes. If your change is pervasive
    (shared types, config, build), record it in `scopeChanges`. Failures you observe in
    files outside your scope are report-only — leave them untouched.
    You MUST state why your verification scope is sufficient in your report (`scopeReason`).

    ## Code Organization

    You reason best about code you can hold in context at once, and your edits are more
    reliable when files are focused. Keep this in mind:
    - Follow the file structure defined in the plan
    - Each file should have one clear responsibility with a well-defined interface
    - If a file you're creating is growing beyond the plan's intent, stop and report
      it as DONE_WITH_CONCERNS — don't split files on your own without plan guidance
    - If an existing file you're modifying is already large or tangled, work carefully
      and note it as a concern in your report
    - In existing codebases, follow established patterns. Improve code you're touching
      the way a good developer would, but don't restructure things outside your task.

    ## When You're in Over Your Head

    It is always OK to stop and say "this is too hard for me." Bad work is worse than
    no work. You will not be penalized for escalating.

    **STOP and escalate when:**
    - The task requires architectural decisions with multiple valid approaches
    - You need to understand code beyond what was provided and can't find clarity
    - You feel uncertain about whether your approach is correct
    - The task involves restructuring existing code in ways the plan didn't anticipate
    - You've been reading file after file trying to understand the system without progress

    **How to escalate:** Report back with status BLOCKED or NEEDS_CONTEXT. Describe
    specifically what you're stuck on, what you've tried, and what kind of help you need.
    The controller can provide more context, re-dispatch with a more capable model,
    or break the task into smaller pieces.

    ## Before Reporting Back: Self-Review

    Review your work with fresh eyes. Ask yourself:

    **Completeness:**
    - Did I fully implement everything in the spec?
    - Did I miss any requirements?
    - Are there edge cases I didn't handle?

    **Quality:**
    - Is this my best work?
    - Are names clear and accurate (match what things do, not how they work)?
    - Is the code clean and maintainable?

    **Discipline:**
    - Did I avoid overbuilding (YAGNI)?
    - Did I only build what was requested?
    - Did I follow existing patterns in the codebase?

    **Testing:**
    - Do tests actually verify behavior (not just mock behavior)?
    - Did I follow TDD if required?
    - Are tests comprehensive?

    If you find issues during self-review, fix them now before reporting.

    ## Report Format (MANDATORY)

    When done, return brief prose findings FIRST, then this EXACT JSON block as the LAST thing in your message — nothing after it:

    ```json
    {
      "status": "DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT",
      "summary": "<1-2 sentences: what was accomplished>",
      "payload": {
        "filesChanged": ["src/foo.ts", "test/foo.test.ts"],
        "filesCreated": ["src/bar.ts"],
        "verification": {
          "command": "<exact command you ran>",
          "result": "pass | fail",
          "scopeReason": "<why this scope is sufficient>"
        },
        "concerns": [],
        "scopeChanges": []
      }
    }
    ```

    - `concerns`: doubts about correctness (use with DONE_WITH_CONCERNS)
    - `scopeChanges`: discovered work outside task boundaries (orchestrator handles)
    - Use BLOCKED if you cannot complete the task
    - Use NEEDS_CONTEXT if you need information that wasn't provided
    - Never silently produce work you're unsure about

    **No prose after the JSON block.**
```
