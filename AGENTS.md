# AGENTS.md

Read [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) before making changes. It covers
where code lives, the rules to preserve, and the workflow.

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
