---
name: superpowers-systematic-debugging
description: Debug by reproducing, isolating root cause, fixing the cause, and verifying the fix instead of guessing.
---

# Systematic Debugging

Use this for bugs, failures, confusing behavior, and regressions.

Process:

1. Reproduce or inspect the failing path.
2. Gather evidence from code, logs, tests, and exact error output.
3. Form a minimal hypothesis.
4. Isolate the root cause.
5. Fix the root cause, not the symptom.
6. Add a regression test when practical.
7. Verify with the narrow test and required check command.

Do not make unrelated cleanup changes while debugging.
