---
name: pr-description
description: Turn a branch's commits and diff into a pull request title and description a reviewer can act on.
---

# Pull request description

Describe the branch against its real base. Do not summarize individual commits in
order; explain the change as one reviewable unit.

## Workflow

1. Find the base branch (`git merge-base HEAD origin/main`, or the branch named by
   the user). Read `git log --oneline base..HEAD` and `git diff --stat base...HEAD`.
2. Read the full diff, plus any files the change depends on.
3. Answer these questions in the description:
   - What user-visible or developer-visible behavior changes?
   - Why is this the right approach, and what alternatives were rejected?
   - What could break, and how is it contained?
   - How was it verified (tests, manual steps, platforms)?
4. List follow-up work explicitly rather than hiding it in the diff.

## Format

```
## Summary
One short paragraph, then at most three bullets.

## Test plan
- [ ] <specific command or manual step>
- [ ] <edge case>

## Risks
<what could regress and the rollback path; omit the section when there is none>

## Follow-ups
<known gaps; omit when there are none>
```

Title: under 70 characters, imperative, naming the area.

## Rules

- A checkbox in the test plan means it was actually run. Mark unrun items `[ ]`
  and say so.
- Mention screenshots or recordings only if the change affects the UI and they
  exist.
- Link issues by number when the user provided them. Never guess one.
