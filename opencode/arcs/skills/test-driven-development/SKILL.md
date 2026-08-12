---
name: test-driven-development
description: Use a focused red-green-refactor loop for observable behavior changes
---

# Test-Driven Development

## When

Use when a feature, bug fix, or behavior change benefits from executable proof. Pure prose, metadata, generated output, or mechanical refactors may rely on existing contracts instead of adding a new test.

## Loop

For a behavior change, write one failing test that demonstrates the requirement, run it to confirm the expected failure, add the minimal implementation, rerun until green, then refactor while preserving behavior.

1. **Failing test:** one behavior, clear name, real boundary.
2. **Minimal code:** only what makes the test pass.
3. **Refactor:** remove duplication and improve names without adding behavior.
4. **Verify:** run the relevant test and any proportionate integration check.

If a test passes immediately, verify that it actually covers the new behavior. Avoid mocks that merely confirm implementation details. Use `testing-anti-patterns.md` or `tdd-rationalizations-and-examples.md` only when those details help.
