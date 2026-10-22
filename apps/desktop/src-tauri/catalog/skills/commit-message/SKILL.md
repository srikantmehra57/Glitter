---
name: commit-message
description: Write a concise Conventional Commits message from staged changes, with a body only when it adds information.
---

# Commit message

Write the message for the change that is staged now. Do not describe work that is
not in the diff.

## Workflow

1. Read `git status` and `git diff --staged`. If nothing is staged, say so and
   stop; do not stage files on your own.
2. Identify the one behavior the change delivers. If the diff contains several
   unrelated changes, propose splitting the commit and name the groups.
3. Choose the type:
   - `feat` — a new capability users can observe
   - `fix` — a defect corrected
   - `refactor` — behavior unchanged, structure improved
   - `perf` — measured speed or memory improvement
   - `test` — tests only
   - `docs` — documentation only
   - `build` / `ci` / `chore` — tooling and maintenance
4. Use an imperative subject under 72 characters. Name the area when it helps:
   `fix(composer): keep drafts when switching threads`.
5. Add a body only when the reason is not obvious from the subject: what was
   wrong, why this approach, and what it costs. Wrap at 72 columns. Put breaking
   changes and issue references at the end.

## Rules

- Subject: no trailing period, no "this commit", no summary of files touched.
- Body: explain *why*, not *what*. The diff already says what.
- Never invent a test result, an issue number or a co-author.
- Output only the message in a code block, then one line naming the staged files.
