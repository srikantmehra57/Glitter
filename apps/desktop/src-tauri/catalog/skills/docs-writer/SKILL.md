---
name: docs-writer
description: Write README and API documentation that matches the code, for a reader who is new to it.
---

# Documentation

Write for the reader who has the code but not the context. Every claim must be
checkable against the repository.

## Workflow

1. Identify the reader and the job: install and run, understand the architecture,
   call an API, migrate, or troubleshoot.
2. Read the code, CLI help, tests and configuration that the document describes.
   Do not document intended behavior that the code does not implement.
3. Draft in this order:
   - what it is and the problem it solves, in two or three sentences
   - prerequisites and the shortest working example
   - the common tasks, each as a numbered procedure with copy-paste commands
   - configuration and defaults, in a table
   - failure modes and how to recover
   - links to deeper references
4. Run every command you document in the environment you describe. Fix the
   example, not the prose, when they disagree.
5. Cut anything the reader does not need for the job. Prefer one clear sentence to
   a paragraph of hedging.

## Rules

- Match the repository's terminology and file paths exactly.
- Use real values in examples; label placeholders such as `<workspace>` clearly.
- Do not claim performance, compatibility or security properties unless a test,
  benchmark or source file backs them.
- Document the current version, then note migration steps separately.
- Keep line length and heading style consistent with the surrounding document.

## Report

List the files changed, the commands you ran to verify the examples, and any
behavior you could not verify.
