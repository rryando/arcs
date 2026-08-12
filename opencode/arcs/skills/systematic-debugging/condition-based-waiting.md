# Condition-Based Waiting

Wait for an observable condition, not an arbitrary duration.

Use a bounded poll or event with:

- a clear success condition;
- a timeout;
- useful timeout evidence;
- cleanup for listeners or timers.

Fixed sleeps are acceptable only when time itself is the behavior under test.
