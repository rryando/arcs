---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code
---

# Skill: test-driven-development

## When

Implementing any feature, bugfix, or behavior change. No production code without a failing test first.

> **Note:** This skill is loaded DIRECTLY by the orchestrator when test-first is a hard requirement (the decision tree's "test-first valuable" trigger). It is also available as a sub-flow within `code-agent`, which invokes TDD when new non-trivial behavior needs test-first implementation.

## Flow

```mermaid
flowchart TD
    A[Write ONE failing test] --> B{Run test}
    B -->|Fails correctly| C[Write minimal code to pass]
    B -->|Wrong failure| A
    B -->|Passes immediately| D[Test is wrong — fix or delete]
    D --> A
    C --> E{Run test}
    E -->|Your tests pass| F[Refactor — keep green]
    E -->|Fails| C
    F --> G{More behavior needed?}
    G -->|Yes| A
    G -->|No| H[Done — your test files green, scoped VERIFY passes]
```

## Iron Law

Code written before a test? **Delete it.** No "reference", no "adapting". Start fresh from tests.

## RED — Write Failing Test

- One behavior per test, clear name, real code (no mocks unless unavoidable)
- Run: `npm test -- path/to/test.test.ts` — confirm fails for the right reason

## GREEN — Minimal Code

- Simplest code to pass. Nothing beyond what the test requires.
- Run: re-run YOUR test file(s) (`npm test -- path/to/test.test.ts`) — confirm they pass, output pristine. Never the unscoped suite; the devil-advocate completion gate owns full-project verification.

## REFACTOR — Clean Up

- Remove duplication, improve names, extract helpers
- Keep tests green. Don't add behavior.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Need to explore first" | Fine. Throw away exploration, then TDD. |
| "Test hard = design unclear" | Hard to test = hard to use. Listen to the test. |
| "TDD will slow me down" | TDD faster than debugging. |

## When Stuck

| Problem | Solution |
|---------|----------|
| Don't know how to test | Write wished-for API. Assertion first. |
| Test too complicated | Design too complicated. Simplify interface. |
| Must mock everything | Code too coupled. Use dependency injection. |

## Red Flags — Delete and Start Over

Code before test, test passes immediately, can't explain why test failed, rationalizing "just this once".

See `tdd-rationalizations-and-examples.md` for expanded examples and rebuttals.
