---
name: systematic-debugging
description: Diagnose bugs and failing tests from evidence before changing code
---

# Systematic Debugging

## Method

Observe → reproduce → isolate → regression test → fix → verify.

1. **Observe:** read the full error, logs, inputs, and recent relevant changes.
2. **Reproduce:** find the smallest reliable reproduction. Add instrumentation when needed.
3. **Isolate:** trace backward, compare a working path, and test one hypothesis at a time.
4. **Regression test:** encode the failure when practical.
5. **Fix:** change the root cause with the smallest targeted patch.
6. **Verify:** show the reproduction and relevant checks pass.

If three failed fixes do not improve the evidence, stop and question the architecture or assumptions instead of stacking another guess.

Use ARCS knowledge only when a prior gotcha may save time. Capturing a durable discovery is optional, not part of the success condition.

Optional references provide concise techniques for tracing, waiting, and defense in depth. Do not run destructive Git operations unless the user requests them.
