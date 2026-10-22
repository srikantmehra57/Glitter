---
name: refactor
description: Improve code structure without changing behavior, in small verified steps.
---

# Refactor

Refactoring is a sequence of behavior-preserving edits. If you cannot state the
behavior the current tests pin, add that coverage before you move code.

## Workflow

1. Write down the behavior that must not change and the tests that pin it. Run
   them first.
2. Name the specific problem: duplication, unclear responsibility, a tangled
   dependency, a leaky abstraction, or repeated edits for one change.
3. Choose the smallest move that improves that problem:
   - rename to match the domain
   - extract a function or module along a real seam
   - move a dependency behind an existing interface
   - replace a special case with the general path it duplicates
4. Make one move at a time. Keep the suite green after each move. Do not mix a
   refactor with a behavior change, a dependency upgrade or a reformat.
5. If a seam does not exist and creating it would change behavior, stop and
   explain the tradeoff instead of forcing the abstraction.

## Rules

- Do not add an abstraction for a second use that does not exist yet.
- Preserve public exports, file formats, command-line flags and copy unless the
  user asked for a change.
- Keep the diff reviewable: same files, same order, no drive-by formatting.
- Delete code that becomes unused, and check for dynamic imports, Tauri command
  names and string-based tests before removing it.

## Report

State the problem, the moves made, the commands run, and the final suite result.
