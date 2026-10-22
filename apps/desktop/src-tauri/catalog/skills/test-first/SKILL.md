---
name: test-first
description: Build a change test-first — one failing test, the smallest fix, then a cleanup pass.
---

# Test first

Use this for new behavior and for bug fixes. The test is the specification; the
production change is whatever makes it pass.

## Workflow

1. Write down the behavior in one sentence, including the input and the observable
   result. If you cannot, the requirement is not ready.
2. Find the existing test file and harness. Reuse its helpers and naming.
3. Write one test that fails for the right reason. Run it and read the failure:
   - A compile error is not a red test; finish the scaffold first.
   - A test that passes immediately is testing something that already exists.
4. Make the smallest production change that passes. Do not add options, layers or
   abstractions the test does not demand.
5. Run the whole affected suite. If another test fails, decide whether the new
   behavior changed a contract or your change is wrong; fix the cause.
6. Add the next edge case as its own failing test. Cover empty, missing, duplicate,
   boundary and error inputs that the code can actually receive.
7. Refactor with the suite green. Remove duplication you introduced, not unrelated
   code.

## Bug fixes

Reproduce the bug in a failing test first. If the bug needs a live service or UI
you cannot drive, write the closest test at the seam and say what remains manual.

## Report

Name each test added, the command that ran it, and the final pass/fail counts. If
you skipped a step, say which and why.
