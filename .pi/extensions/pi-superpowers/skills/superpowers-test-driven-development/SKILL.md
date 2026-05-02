---
name: superpowers-test-driven-development
description: Enforce red-green-refactor implementation with issue-specific regression tests when tests are requested or appropriate.
---

# Test-Driven Development

Use red-green-refactor when implementing behavior with test coverage.

Process:

1. Identify the expected behavior and the smallest failing test.
2. Add or update the test first.
3. Run the specific test and confirm it fails for the expected reason.
4. Implement the minimal production change.
5. Run the specific test until it passes.
6. Run the required project check command.
7. Refactor only after tests pass.

Do not write broad speculative tests. Prefer regression tests tied to the exact issue.
