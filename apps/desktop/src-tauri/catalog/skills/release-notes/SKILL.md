---
name: release-notes
description: Turn merged changes into clear, user-facing release notes grouped by impact.
---

# Release notes

Write for the people who use the product, not for the people who wrote the
commits. Translate implementation into outcomes.

## Workflow

1. Establish the range: `git log --oneline <last-tag>..HEAD` and the merged pull
   requests. Exclude chores, dependency bumps, CI and internal refactors unless
   they change behavior.
2. For each user-visible change, write one line that answers "what can I do now,
   or what works differently?" Use the product's vocabulary, not class names.
3. Group under:
   - **New** — capabilities that did not exist
   - **Improved** — existing behavior that is better
   - **Fixed** — defects corrected
   - **Breaking** — migrations, removed options, changed defaults
4. Put the most consequential change first in each group. Keep lines to one or two
   sentences; link the full detail rather than explaining the implementation.
5. Verify names, flags, shortcuts and version numbers against the code.

## Format

```
## <version> — <date>

### New
- ...

### Improved
- ...

### Fixed
- ...

### Breaking
- ... (<migration step>)
```

Omit empty sections.

## Rules

- No commit hashes in the reader-facing list; keep them in an appendix if the
  project asks for one.
- Do not call a fix "minor" when it changes data or compatibility.
- Never announce a feature that is still behind an off-by-default flag without
  saying so.
