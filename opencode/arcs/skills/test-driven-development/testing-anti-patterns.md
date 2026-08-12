# Testing Anti-Patterns

Avoid:

- tests that assert private call order instead of behavior;
- mocks that reproduce the implementation;
- broad snapshots with no meaningful contract;
- sleeps instead of observable conditions;
- one test covering several unrelated behaviors;
- adding tests solely to increase line coverage.

Prefer stable public boundaries, realistic inputs, clear failure messages, and the smallest check that proves the requirement.
