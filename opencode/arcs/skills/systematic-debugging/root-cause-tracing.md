# Root-Cause Tracing

Start at the observed failure and trace inputs backward through boundaries until the first incorrect state appears.

At each boundary record:

- expected value;
- actual value;
- producer;
- evidence.

Fix the earliest incorrect assumption you own, not the last place that notices it. Compare with a working path when available.
