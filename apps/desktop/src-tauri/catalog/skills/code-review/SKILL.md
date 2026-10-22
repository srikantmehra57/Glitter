---
name: code-review
description: Review a diff or pull request for correctness, security and missing tests, and report only actionable findings.
---

# Code review

Review the change as a careful colleague would: find the defects that matter, and
leave style preferences out unless they hide a real problem.

## Workflow

1. Establish the scope. Prefer the working tree diff (`git diff`, `git diff --staged`)
   or the named base (`git diff main...HEAD`). Read the changed files in full, not
   only the hunks.
2. Read the surrounding code until you can explain how the change fits: callers,
   data shapes, error paths, and the tests that already cover the area.
3. Check, in this order:
   - Correctness: off-by-one errors, wrong defaults, unhandled `null`/empty cases,
     races, ordering, retries, partial failure and rollback.
   - Security: untrusted input reaching a shell, SQL, HTML, a path or a URL;
     secrets in logs or source; missing authorization at a trust boundary.
   - Data and compatibility: migrations, persisted formats, API contracts,
     version skew, and behavior for existing users.
   - Tests: does a test fail without the change? Are the edge cases in the change
     also asserted? Flag behavior changes that no test pins.
   - Operations: new failure modes, noisy logs, unbounded loops or memory, and
     anything that makes rollback harder.
4. Run the smallest relevant tests when the repository makes that cheap. Do not
   claim a test passed unless you ran it.

## Report

Group findings by severity. Each finding needs a file and line, what goes wrong,
and a concrete fix. Say plainly when you found nothing in a category.

```
Blocking
- path/to/file.ts:42 — <defect>; <why it matters>; <fix>.

Worth fixing
- ...

Nits (optional)
- ...

Verification: <tests run, or "not run: …">
```

Do not rewrite the patch in the review. Keep the review about the code, not the
author, and say "this fails when…" rather than "you forgot…".
