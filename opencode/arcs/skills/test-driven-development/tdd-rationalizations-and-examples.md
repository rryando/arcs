# TDD Quick Examples

Use this optional reference when the right test boundary is unclear.

- Bug: reproduce the reported failure, then fix it.
- Feature: assert the smallest user-visible behavior before implementation.
- Refactor: existing behavior tests may be sufficient; add a test only for an uncovered contract.
- Mechanical/prose/generated changes: verify the relevant contract instead of inventing a unit test.

If the test passes before implementation, confirm it exercises the new behavior. If testing requires extensive mocking, look for a simpler public boundary.
