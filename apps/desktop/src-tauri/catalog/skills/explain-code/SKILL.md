---
name: explain-code
description: Explain unfamiliar code from entry point to data flow, grounded in the files rather than guesses.
---

# Explain code

Build an explanation from the code itself. Read enough to be accurate, then give
the reader a model they can use to make changes.

## Workflow

1. Find the entry point: a command, route, event handler, exported function or
   test. Confirm it by searching for callers.
2. Trace the main path end to end. At each step note the input shape, the
   transformation, the output shape and where errors go.
3. Map the pieces:
   - boundaries: what crosses a process, network, file or trust boundary
   - state: what is stored, where, and which code owns each field
   - timing: what is synchronous, queued, retried or concurrent
   - configuration: what changes behavior and its default
4. Identify the invariants the code relies on and the tests that pin them.
5. Explain in layers: one paragraph of purpose, a numbered flow, then the details
   that matter for the reader's goal. Link each claim to `path:line`.

## Rules

- Do not invent a reason for a design choice. If the reason is not in the code,
  comments, history or docs, say it is not recorded.
- Distinguish what the code does from what it appears intended to do.
- Call out the surprising part: a workaround, an unusual ordering, a hidden
  constraint.
- Keep the explanation proportional to the question. Offer a deeper trace instead
  of dumping the whole file.

## Report

End with "Where to change X" — the two or three files and functions a reader
would edit for the most likely follow-up.
