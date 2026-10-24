# AGENTS.md

Read [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) before making changes. It covers
where code lives, the rules to preserve, and the workflow.

## Design

[docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) is the single source of design
decisions: tokens, the type scale, layout, components, naming and the Settings
information architecture. Follow it for any UI change, and when a change alters
a design decision, update that document in the same commit. Do not invent a new
pattern, size or colour outside it.

To verify a change, run `npm run verify`. It runs every gate in order. Never run
`node --test` and `cargo test` at the same time.

## Composer boundary

Keep a 16px clear buffer above the composer. The composer is the final surface
in the thread column: never render warnings, capability notices, status lines,
worktree details or the terminal beneath it. Put status and worktree details
inside the input frame, the terminal above it, and capabilities in a dismissible
dialog opened from the Agent menu. Preserve this boundary in future changes.

## One installed app on macOS

Keep exactly one Glitter on this Mac: `/Applications/Glitter.app`, always the
latest build. macOS lists every app bundle it finds, so a bundle left in the
build folder shows up as a second Glitter. The app was called Muse Code before
the rename; `/Applications/Muse Code.app` must not come back either.

After every `npm run build`:

1. Quit the running Glitter (and Muse Code, if an old copy is still open).
2. Replace the installed app with the new bundle:
   `ditto "apps/desktop/src-tauri/target/release/bundle/macos/Glitter.app" "/Applications/Glitter.app"`
   (move the old `/Applications` copy to the Trash first, and
   `/Applications/Muse Code.app` too if it is still there).
3. Move the bundle in `apps/desktop/src-tauri/target/release/bundle/macos/` to
   the Trash, and do the same for any under `target/debug/bundle/`.
4. Launch `/Applications/Glitter.app`, never the copy in the build folder.

Move copies to the Trash; do not delete them outright.

## Working guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
