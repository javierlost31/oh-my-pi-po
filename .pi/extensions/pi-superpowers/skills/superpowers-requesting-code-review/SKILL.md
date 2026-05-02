---
name: superpowers-requesting-code-review
description: Review code against the requested behavior, plan, safety rules, and validation output before declaring completion.
---

# Requesting Code Review

Use this before finalizing a change.

Review checklist:

- The change matches the user's requested behavior.
- No unrelated functionality was removed.
- No broad compatibility layers were added unless requested.
- Type safety is preserved.
- Imports are top-level.
- Required validation commands passed.
- Remaining limitations are stated clearly.

Report findings by severity. Critical issues block completion.
