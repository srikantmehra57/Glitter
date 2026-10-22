---
name: debug
description: Find the root cause of a bug with evidence before changing code, then prove the fix.
---

# Debug

A bug is a difference between what the code does and what someone expects. Find
the smallest reproducible case, then follow the data until the cause is obvious.

## Workflow

1. Restate the symptom as an observable fact: input, expected result, actual
   result, and how often it happens. Separate it from any theory about the cause.
2. Reproduce it. Run the failing command or test with the smallest input that
   still fails. If it does not reproduce, gather the environment that differs
   (version, platform, config, data) before changing anything.
3. Locate the path. Trace from the entry point to the wrong result. Read the code
   and add temporary logging or use a debugger; do not guess from names.
4. Form one hypothesis at a time and make a prediction: "if this is the cause,
   then X will happen when I change Y." Test the prediction. Keep a short list of
   what was ruled out.
5. Fix the cause, not the symptom. Add a regression test that fails before the fix
   and passes after it.
6. Check adjacent paths with the same mistake, but do not widen the fix beyond the
   defect without telling the user.

## Report

```
Symptom: ...
Trigger: <smallest reproduction>
Root cause: path/to/file.ts:42 — <mechanism>
Fix: <what changed and why>
Regression test: <name and command>
Ruled out: <theories tested and rejected>
```

Remove temporary logging and debug artifacts before finishing.
