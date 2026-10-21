# Improvement plan

This plan comes from a comparison of Muse Code Desktop with the Codex app,
Claude Code (desktop and CLI) and ZCode on 2026-10-11. It also draws on a
walkthrough of the browser preview (`npm run dev:ui`). It lists the gaps in
functionality, UX and UI, ordered by impact, and gives each one a concrete
proposal that fits this codebase.

Read [AGENT_GUIDE.md](AGENT_GUIDE.md) and [DECISIONS.md](DECISIONS.md) before you
pick up an item. Every proposal below has to respect the existing rules:

- **The CLI is the source of truth.** Agent features that the protocol doesn't
  expose need CLI support first. Workspace features (git, files, snapshots) can
  live in the app.
- **The renderer is untrusted.** Anything that touches files, processes or git
  needs a native command that takes a workspace grant, never a raw path.
- **The browser preview keeps working.** A new bridge call needs a mock answer
  in `bridge.ts`.
- **New dependencies need a decision.** That means an entry in `DECISIONS.md`
  and a row in `THIRD_PARTY_NOTICES.md`.
- **Terminology follows [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).** New concepts,
  such as a PTY pane, need a term added there first.

## Progress

Status is tracked here, per phase from [Suggested order](#suggested-order).
States: `todo`, `next`, `in progress`, `done` (verified with `npm run verify`),
`blocked` (needs CLI/protocol or a decision).

| Phase | Scope | Status | Items |
|---|---|---|---|
| 1a | Sidebar and threads | done | A2, A3, A4, A5 |
| 1b | Timeline, approvals, composer | done | B3, C6, F1, F2, H1, H2, H8 |
| 1c | Settings and UI polish | done | G3, H3, H5, H6, H7 (H4 lands with E1) |
| 2 | Review foundation | done | C1, C2, C3, C7, C9 |
| 3 | Safe parallel work | done | B1, B2, C4, A1 |
| 4 | Commands and navigation | done | E1, E3, E4, E5 (H4 with E1) |
| 5 | Workspace tools and git | in progress | D2, C8, C5, D1 done; G1 blocked on the CLI |
| — | Unscheduled items | done | G2, A6, E6, D3, E2 |
| — | Gaps in finished items | done | A1 Handoff, C8 Pull, D2 prose links, C5 persistence, E4 remapping |
| 6 | Longer-term | in progress | L4, L5 done; L1, L2, L3, L6 blocked |

Per-item log (newest first):

- **L5 done. L4 was already in the app.** Markdown export sits beside the JSON
  exports in the thread menu and the command palette, share-safe or raw. It
  runs `muse export` and renders export schema 1: messages, thought text the
  host recorded in the clear, tool calls, approvals and run outcomes that did
  not simply complete. Encrypted reasoning is left out, a schema other than 1
  is refused, and a log over 64 MiB is refused; the JSON export remains the
  full document. The header says the Markdown file is not the full export.
  L4 (per-turn cost on the turn line, per-thread estimate in the context
  meter) was already implemented and is now recorded here. `npm run verify`
  passes: 551 Node tests, 173 UI tests and 142 native tests, other gates
  unchanged. Not verified in the desktop app: the save dialog and a live
  `muse export`. Still blocked: G1 (the CLI has no MCP add or remove), L1,
  L2, L3 and L6.

- **Phase 5 — D1 done.** The owner decided the trust question: the terminal is
  built, and "Disable shell" turns it off. A Terminal pane sits below the
  composer (⌘J, the header button, or the palette). `terminal.rs` runs the
  user's login shell on a PTY in the folder the open thread works in; output
  streams as events and keystrokes are written back. The shell ends when the
  pane closes, when the folder in view changes, when its grant or worktree is
  revoked, and at shutdown. The decision entry records what this costs the
  trust model and the limits that still hold. New dependencies: `portable-pty`,
  `@xterm/xterm` and `@xterm/addon-fit`, all MIT, with notices added; the
  renderer loads as a lazy chunk. The composer's `!` chip now reads "Shell
  command" so "Terminal" has one meaning. `npm run verify` passes: 543 Node
  tests, 147 UI tests and 136 native tests, other gates unchanged. The native
  test drives a real shell on a PTY (output, working directory, resize, exit
  code, cleanup by grant, the cap) on Unix only. Not verified: the pane itself
  in the desktop app, since the browser preview has no PTY and shows only the
  "needs the desktop app" state; and anything on Windows. Not built: tabs, a
  shell that outlives the pane, links in output.

- **E4 remapping done.** The 19 mod-key shortcuts are rebindable under Settings
  → Keyboard shortcuts. `lib/shortcuts.ts` holds the defaults; the key handler,
  the labels in menus, tooltips and the palette, and the native menu all read
  from it, and Settings stores only overrides. Conflicts and reserved chords
  are refused in the UI and again when saved overrides are loaded. Rebinding a
  shortcut that has a native menu item rebuilds the menu through
  `set_menu_shortcuts`, which accepts only known menu ids and a closed
  accelerator grammar. Text entry, approval keys, Esc, ⌘1–9, Ctrl+Tab and ⌘G
  stay fixed. `npm run verify` passes: 543 Node tests, 145 UI tests and 135
  native tests, with the other gates unchanged. Not verified: the rebuilt
  native menu at runtime, which tests cannot construct. Swapping two shortcuts
  takes two steps, since a chord in use cannot be assigned.

- **Gaps in finished items closed.**
  - **A1 Handoff.** A worktree thread has Apply to Local below the composer.
    After a confirm, `git_worktree_handoff` applies the worktree's commits and
    uncommitted edits to the workspace folder as uncommitted changes, all or
    nothing, and leaves the worktree and its branch alone. It refuses while a
    turn is running. The result is reported on the thread.
  - **C8 Pull.** Changes has Pull: fast-forward only, refused when the branch
    has diverged or has no upstream, and disabled while a turn runs.
  - **D2 prose links.** Inline code that names a file in the workspace index
    (optionally with `:line`) opens that file in the viewer. Only indexed paths
    are linked, so ordinary code is never turned into a link. Paths in plain
    prose without backticks, and fenced blocks, are not linked.
  - **C5 persistence.** Pending line comments are saved in session memory and
    removed with their thread.
  - Also from this pass: CI now runs on Node 24, and the Node test script names
    its files with a glob. Node 20 could not start the DOM tests and Node 24
    could not resolve `node --test tests`. Neither change has had a green CI
    run yet: the GitHub repository stopped resolving on 2026-10-12 before the
    second fix could be pushed.
  - `npm run verify` passes: versions, typecheck, 543 Node tests, 144 UI tests,
    a11y, 292/292 contrast pairs, audit (0 vulnerabilities), bridge+UI builds
    and 134 native tests. Native tests run a real fast-forward pull, a diverged
    pull and a handoff with committed, unstaged, new and non-UTF-8 files
    against fixture repositories. Not checked in the browser preview or the
    real app.

- **Unscheduled items done — G2, A6, E6, D3, E2.** These were in the summary
  table but in no phase.
  - **G2.** Preferences save as they change. Host-construction settings wait
    for "Save & restart connection" and are the only thing Cancel discards.
    Notifications moved to a new General category. The regression tests that
    pinned the batch-save model were rewritten to pin this one.
  - **A6.** Thread rows show `+added −removed` for uncommitted files the thread
    edited. Only threads working in the folder in view are counted, since the
    git snapshot describes that folder alone; a worktree thread shows its
    counts while it is the open thread. Counts are cached per transcript and
    snapshot inside the memoized row selector.
  - **E6.** View → Zoom In / Zoom Out / Actual Size with a native
    `set_interface_zoom` command, stepped through fixed levels and saved in
    session memory. The browser preview keeps the browser's own zoom.
  - **D3.** "Open file" uses the editor chosen under Settings → General. The
    native side maps a closed list of ids to programs. JetBrains is offered as
    IntelliJ IDEA only.
  - **E2.** Custom commands are defined under Settings → General and listed in
    the slash menu after skills. `$ARGUMENTS` marks where the caret lands; the
    template is inserted as text rather than expanded at send.
  - `npm run verify` passes: versions, typecheck, 540 Node tests, 143 UI tests,
    a11y, 292/292 contrast pairs, audit (0 vulnerabilities), bridge+UI builds
    and 132 native tests. Not verified in the real app: window zoom, the zoom
    menu accelerators, and opening a file in each editor.

- **Phase 5 — D2, C8 and C5 done; D1 and G1 blocked.**
  - **D2.** The dock has a Files tab: a tree built from the existing file
    index (`lib/fileTree.ts`), a fuzzy filter, a Changed only toggle and git
    status badges. `read_workspace_file` is the native read: relative path,
    canonical containment in the grant, regular files only, no `.git`, 256 KB
    cap, binary detection. The viewer is read-only with Add to chat, Copy path
    and Open in default app. Read and edit steps, message file references and
    palette file results open it; a worktree thread reads its own checkout.
    Paths written in message prose are not links yet. The preview has a demo
    index and demo contents.
  - **C8.** The branch chip is a menu (recent branches, create from current),
    with a confirm when the tree is dirty and a lock while a turn runs.
    Changes has Stage all, Push, Commit and push and Create pull request, each
    confirmed where it reaches the network. Push uses the user's git
    credentials with prompts disabled; pull requests use `gh`, and the pane
    shows the PR and a one-word check status with a manual refresh. A created
    PR also leaves a notice on the open thread. Draft message sends the
    `/commit` request in the open thread and fills the commit box with the
    reply's subject line; it refuses rather than replace a composer draft.
    Pull is not built.
  - **C5.** Diff lines have a comment button. Comments are held per thread in
    memory, listed under the diff, and sent as one prompt in file and line
    order with the hunk lines around each. A running Muse turn is steered;
    ACP threads wait until the turn ends. The composer draft is set aside and
    restored. Comments are not persisted across a relaunch.
  - **G1 blocked on the CLI.** `muse mcp --help` (rechecked 2026-10-21, Muse
    Code 1.4.11) offers only `login` and `logout`. There is no add or remove to
    wrap, and the plan rules out inventing a second configuration format.
  - **D1 blocked on a decision.** A PTY takes its input from the renderer, so
    it gives the renderer arbitrary command execution, which the current trust
    model does not allow. It also needs two shipped dependencies (a PTY crate
    and a terminal renderer), a DESIGN_SYSTEM term, and an answer on whether
    `disableShell` turns it off. None of that is recorded yet.
  - `npm run verify` passes: versions, typecheck, 536 Node tests, 137 UI tests,
    a11y, 292/292 contrast pairs, audit (0 vulnerabilities), bridge+UI builds
    and 131 native tests. Native tests cover the file read's bounds and
    confinement, branch switching and name validation, and a real push to a
    local bare remote. Not verified: push over the network with a credential
    helper or SSH agent, and any `gh` call (only the check-status parsing is
    tested). Browser preview checks are against demo data.

- **Phase 4 done — E1, E3, E4, E5 (and H4).**
  - **E1.** Built-in slash commands run through one `runBuiltinCommand` in
    `lib/commands.ts`, shared with the palette and shortcuts. `/new`,
    `/compact`, `/fork`, `/rename`, `/model`, `/effort`, `/permissions`,
    `/init`, `/status`, `/mcp`, `/skills` and `/export` act without a model
    turn and leave the rest of the draft alone; `/review` drafts a prompt for
    the review scope in view. Commands that could do nothing (no thread, ACP,
    preview) are left out. Order is built-ins, skills with their argument hint,
    then macros nothing else is named after, so each name appears once (H4). A
    skill named `review` replaces the built-in; other built-ins keep their
    name. The list holds up to 50 entries and scrolls.
  - **E3.** The palette has Recent, Actions, Threads, Files and Settings
    sections with icons; ordering is pure (`lib/palette.ts`). Recent commands
    persist in session memory (five, commands only). Files come from the
    workspace index and only appear for a search; choosing one adds it to the
    chat, since the file viewer is D2. A search covers threads in every
    workspace.
  - **E4.** ⌘1–9, ⌘⇧] / ⌘⇧[, Ctrl+Tab, ⌘⇧I / ⌘⇧E / ⌘⇧M and ⌘/ are in. One
    table (`lib/shortcuts.ts`) feeds Settings → Shortcuts, which is the sheet
    ⌘/ opens. Find, Search Threads, Next / Previous Thread and Keyboard
    Shortcuts are native menu items; the rest are JS handlers that run in the
    shell and the preview, like ⌘⌥A. A focused approval card takes Enter and
    Esc; focus on a button or the feedback field keeps those keys. Remapping is
    not built.
  - **E5.** ⌘F opens a find bar over the open thread; thread search moved to
    ⌘⇧F. Matches come from the transcript model (user and agent messages), so
    virtualized runs are found and scrolled into view before the message is
    marked. Occurrences are painted with the CSS Custom Highlight API where the
    webview has it; without it the current message is still outlined.
    Collapsed tool arguments and output are not searched.
  - `npm run verify` passes: versions, typecheck, 529 Node tests, 131 UI tests,
    a11y (49 components), 292/292 contrast pairs, audit (0 vulnerabilities),
    bridge+UI builds and 127 native tests. Not verified: the new native menu
    accelerators at runtime (menus cannot be built off the main thread in
    tests; the key names were checked against the menu library's parser), and
    highlight painting in the packaged webview. Browser preview checks are
    against demo data. **Next: phase 5, starting with D2.**

- **Phase 3 done — A1.** A new Muse thread can choose Local or Worktree below
  the composer, with an optional base branch or commit. `git_worktree_create`
  makes a linked worktree on a new `muse/` branch in the app data directory and
  mints a derived grant for its root; the session starts there, and snapshots,
  Changes, review scopes, the file index and opened files follow the thread.
  The thread stays under its workspace in the sidebar with a branch marker.
  Forks share their source's worktree. Deleting the last thread in a worktree
  confirms with the branch name, then `git_worktree_remove` discards the
  worktree and revokes the grant; the branch is kept when it holds commits no
  other ref has. Subfolder grants, non-repositories, unborn HEADs, nested
  worktrees and invalid bases are refused, and removal accepts only grants
  rooted in the worktree store. Removing a workspace revokes its worktree
  grants, removes clean worktrees and leaves ones with uncommitted changes on
  disk. A failed session start removes its new worktree. After a relaunch,
  worktree threads are listed through their own grants. `npm run verify`
  passes: versions, typecheck, 521 Node tests, 122 UI tests, a11y (47
  components), 292/292 contrast pairs, audit (0 vulnerabilities), bridge+UI
  builds and 127 native tests. Native tests run real `git worktree` commands
  against fixture repositories. Browser preview checks the Local / Worktree
  menu, the base field, creating a worktree thread, its sidebar marker and the
  delete confirmation against demo data; it creates nothing on disk and is not
  a packaged-app or live-Muse check. Not built: Handoff back to Local, and A6
  change counts. **Next: phase 4, starting with E1 slash commands.**

- **Phase 3 — C4 done.** Diff offers Last turn, Staged, Unstaged and Branch
  alongside All changes. Native grant-scoped reads separate HEAD/index/worktree
  edits, include bounded new-file previews for Unstaged, and compare fixed
  committed revisions from the chosen base's common ancestor for Branch. Last
  turn uses the latest finished run's private before/after trees; it remains
  reviewable after Undo and later file edits, including in non-git folders.
  Missing/unavailable states never fall back to another turn or scope. File
  selection, reopening closed tabs, binary/mode-only explanations and copy/export
  stay available; discard controls remain in All changes so their hunk indices
  match the native operation. Workspace/grant/thread/scope/base changes and Git
  mutations fence late replies. Reads preserve the index and keep nested grants
  and cross-boundary renames inside their authorized subtree. `npm run verify`
  passes: versions, typecheck, 516 Node tests, 119 UI tests, a11y (47 components),
  292/292 contrast pairs, audit (0 vulnerabilities), bridge+UI builds and 122
  native tests. The native shell fixture checks ownership and immutable Last
  turn reads through the actual command wrapper. Browser preview checks scope
  switching, binary files, branch comparison/failure and split Last turn review
  after Undo against demo data; it is not a packaged-app/live-Muse check.
  **Next: A1 worktrees.**

- **Phase 3 — B2 done.** Muse Edit and rewind forks through the preceding
  canonical turn and sends the revision with its attachments. The source
  transcript and unsent composer draft remain intact. First-message edits start
  an empty session labeled Edited from because the pinned SDK has no empty
  fork cut; partial history and unconfirmed boundaries never guess that cut.
  Fork responses retain canonical history that can stream before row creation,
  and partial early streams preserve its order without regressing newer item
  contents. Reset files too confirms and restores only the edited turn’s B1
  snapshot after the fork exists; conflicts keep the fork draft and send nothing.
  Cancel, navigation, grant replacement, duplicate clicks and failed sends keep
  drafts. Create retries reuse their request key; another completed edit creates
  a fresh fork. ACP keeps Edit and resend. `npm run verify` passes end to end:
  versions, typecheck, 508 Node tests, 112 UI tests, a11y (47 components),
  292/292 contrast pairs, audit (0 vulnerabilities), bridge+UI builds and 115
  native tests. Browser preview checks first-message reset/cancel, a later
  message’s history cut, provenance and both source drafts against demo data;
  this is not a live-Muse or packaged-app check. **Next: C4 review scopes**, then
  A1 worktrees.

- **Phase 3 started — B1 done.** Native capture occurs before submit and
  before terminal events reach the renderer, with private Git objects and an
  independent index. Undo and Reapply check all affected file contents and modes;
  a conflict restores nothing and names its paths. Created/deleted/binary files,
  user edits predating the turn, staged edits, non-git folders, nested grants,
  relaunch, interrupted-restore recovery, overlapping runs and shell commands
  have coverage, along with changed ignore rules, CRLF and file-encoding
  attributes. History remains intact. Retry keys retain their original
  baseline, queued/external starts never receive a late baseline, and running
  markers remain while a deleted thread or stopping engine can still write.
  Snapshots expire after seven days, with capped capture and retained records;
  thread deletion releases private refs and collects objects. Snapshot reads
  cannot race a restore and hide Reapply, and native repository fixtures have
  unique paths even when test tags repeat. `npm run verify` is green end to end:
  versions (6 manifests), typecheck, 496 Node tests, 105 UI tests, a11y (47
  components), 292/292 contrast pairs, audit (0 vulnerabilities), bridge+UI
  builds and 115 native tests. The native-shell fixture exercises capture,
  grant/session ownership, Undo and Reapply through the actual command wrappers.
  Browser preview verifies Undo → Reapply → Undo and the retained composer draft
  against mock data; this is not a packaged-app/live-Muse validation. **Next: B2**,
  followed by C4 and A1.

- **Phase 2 done** — C1, C2, C3, C7 and C9 implemented and the final
  `npm run verify` gate is green end to end: check:versions (6 manifests),
  typecheck, 489 Node tests, 102 UI tests, a11y (47 components), 292/292
  contrast pairs, `npm audit` 0 vulnerabilities, bridge+UI builds (lazy
  `core-*` + per-language grammar chunks stay out of the main bundle), and
  100 native tests. Verified in the browser preview against the mock bridge
  (dark/light unified+split diffs, Markdown blocks, multi-file approval
  previews, 430–1440px) — not a packaged app.
  - **C1.** The dock is a resizable pane inside the thread layout: a left-edge
    separator (pointer + arrow keys, Shift for 96px steps, Home/End for the
    bounds) clamps between 300px and the smaller of 60% of the window or the
    space that leaves the thread 336px; the saved preference persists in
    session memory. An expand control gives Changes the main area while the
    composer stays visible, and at ≤1000px (or expanded) a Thread/Changes
    toggle replaces the old fixed overlay. Resize restores the body's prior
    cursor/selection styles, and the toggle lands on the changes/diff tab.
  - **C3.** `git_snapshot` appends bounded synthetic `new file` diffs for
    untracked text files (256 KiB per file, 200 preview *attempts*, within the
    1.5 MB diff cap; oversized files are refused by stat before reading),
    flags binary/oversized/symlink/unavailable files with an honest
    `previewSkipped` reason, keeps executable mode 100755, and never writes
    the index. Quoted diff paths parse to real filenames via the `+++` header
    (with `---`/`rename to`/`diff --git` fallbacks). Nested grants are scoped
    by `rev-parse --show-prefix` plus `--relative` diffs, so nothing outside
    the grant leaks — including per-file discards. Skipped files open as their
    own tab showing only their own reason; copy/export use the verbatim patch.
  - **C7.** Completed edit-kind items and window focus schedule one debounced
    (750 ms) `refreshGit`; a read or write in flight queues one follow-up owed
    to that workspace/grant, and explicit reads, workspace switches and
    `turnCompleted` cancel pending timers. In-flight mutations are counted so
    a read started mid-write can never land after the write's snapshot. The
    file watcher is deferred to step 2 pending a dependency decision.
  - **C9.** Non-repository folders return `repository: false` snapshots and get
    an "Initialize repository" action (confirm first — re-verified against the
    captured workspace/grant before `git init` runs, no commits), distinct
    from real git errors. The exact two-column porcelain status fix means
    unstaged files no longer render as staged.
  - **C2 done.** Hunk headers drive old/new line numbers, del/add runs pair
    into word-level marks (token LCS, bounded) and a Unified/Split layout
    (effective when the pane is ≥640px wide, with a widen hint below), and the
    same renderer backs approval previews. Native diff reads pin
    `-U3 --no-color --no-ext-diff --no-textconv` so user gitconfig cannot move
    hunk indices; raw patch slices preserve multi-LF file separators exactly
    on copy/export. For syntax colouring, highlight.js@11.12.0 (BSD-3-Clause,
    notice + full license in THIRD_PARTY_NOTICES) feeds a lazy isolated
    `newInstance()` engine per root language; the strict span adapter accepts
    only the highlighter's own `<span class>`/escaped-text grammar and
    requires decoded text to equal the source, so no foreign markup or class
    names reach React. Tokens map to four theme-aware `--syntax-*` variables;
    unknown languages, sources over 64Ki UTF-16 code units (4096 per line),
    >5000 spans and any failure render plain — source is never logged or
    persisted. Highlighting is debounced 120ms with a bounded result LRU,
    per-hunk isolation across `@@` boundaries and per-side isolation in split
    view; word-change marks compose over token colours without losing text or
    surrogate pairs. Covered by the final gate above — 489 Node / 102 UI
    tests including cache-collision, prototype-name, hunk-isolation and
    cap-eviction regressions.

- **Phase 1c done** (`npm run verify` green: 448 node tests, 64 UI tests in
  10 Vitest files, a11y, contrast, audit, builds, 84 native). Checked the Settings
  navigation at 1440×900 and 1200×700, remembered-tab reopening, Changes rows
  and top-bar labels in the browser preview.
  - **G3.** The last Settings category persists in session memory, with a Models
    fallback for older saves. Explicit links override it without resetting
    unsaved edits. Navigation fits at desktop size; shorter windows retain a
    visible scrollbar, and opening a category brings it into view.
  - **H3.** Contributor variants include “· Contributor” in their model names;
    selection still uses the original provider/model key and retains the data
    use disclosure.
  - **H5, H6.** Archive empty states and slash hints use the body typeface.
    Changes rows put the filename above a dimmed directory and expose the full
    path through accessible labels. Staging uses checked controls; focused and
    selected rows expose Discard. Existing native mutation behavior is unchanged.
  - **H7.** Fork, Monitor and Changes show labels when the thread pane has room.
    The branch is a passive current-branch indicator for now; the actual branch
    menu remains part of C8 in phase 5. **H4** remains paired with E1 in phase 4.

- **Phase 1b done** (`npm run verify` green: 447 node tests, 60 UI tests in
  7 Vitest files, a11y, contrast, audit, builds, 84 native). Checked the pinned
  plan, denial form, thought expansion and Jump to latest in the browser preview.
  - **B3.** Workspace prompt history in `sessionMemory.ts`, capped at 50
    acknowledged sends and restored across launches. Composer arrows browse at
    the first/last line, restore the draft at the newest end, and preserve
    attachments. Menus, selections, modifiers and IME keep their keys.
  - **C6.** `EditPreview` shares the approval argument parser with completed
    edit steps. Replace, write and multi-file patch previews are bounded by
    text and line caps; unknown/failed edits keep their output/error fallback.
    Open in Changes reveals the workspace's current changes.
  - **F1.** Deny and explain waits for the denial acknowledgement, then steers
    Muse or uses its queue. ACP explanations wait in the thread until a normal
    completion. Stop/failure keeps them unsent. Failed or uncertain deliveries
    stay visible and can be appended to the thread's draft; unknown steer
    results never trigger an automatic second send. The pending explanation
    queue is in memory; moving it to the draft uses normal draft persistence.
    No new native verb or approval DTO field is needed.
  - **F2.** A note below the ACP composer names the fork/export limitation and
    opens a capability table describing this app's adapter. Muse stays quiet.
  - **H1, H2, H8.** Pinned plans start collapsed above the transcript scroller
    and return to their original timeline anchor on unpin. Expanded thoughts
    show their opening line only in the body. Jump to latest occupies a row
    above the composer's right edge instead of floating over the transcript.

- **Phase 1a done** (`npm run verify` green: 437 node, 6 Vitest files, a11y,
  contrast, audit, builds, 84 native). Checked in the browser preview.
  - **A2.** `needsAttention` / `nextAttentionThread` in `lib/format.ts`. Rows
    carry `attention` and the amber dot outranks the spinner. A collapsed
    workspace shows the dot on its row. `selectNextAttentionThread` walks threads
    in sidebar order; it runs from the palette and ⌘⌥A. The shortcut is a JS
    handler, not a native menu item, so it works in the shell and the preview;
    the menu entry waits for E4.
  - **A3.** `newThread` only opens the workspace draft (defaults config,
    composer focus, cancels a pending launch restore). The old eager body is now
    `createThread`, which the first send calls. The draft view shows the
    suggestions instead of a second New thread button. ACP agents need no early
    session: `listModels` works without one, and modes appear after the first
    send, as in the existing workspace draft.
  - **A4.** While searching, collapsed workspaces show their matches. The first
    search lists workspaces never expanded. The caret hides a revealed group for
    that search only; saved expansion is untouched.
  - **A5.** Archive is in the thread menu and the palette (⌘⇧A). An Archived
    threads button appears beside Workspaces when anything is archived. It opens
    Settings on Threads through the new `setSettingsOpen(open, tab)`, which
    E1, E3 and G3 can reuse. No auto-archive.

## How to read this

- **Priority.** P0 is a core workflow gap that competitors treat as table
  stakes. P1 is expected by daily users. P2 is polish or long-term work.
- **Effort.** Small means renderer-only and local. Medium crosses one layer
  boundary. Large crosses several layers or needs a new dependency.
- **Layers.** UI (`components/`), store (`lib/store.ts`), IPC (`lib/bridge.ts`),
  native (`src-tauri/`), bridge (`packages/muse-bridge/`), CLI (needs the Muse
  CLI or protocol to change).

## Summary

| ID | Item | Priority | Effort | Layers |
|---|---|---|---|---|
| A1 | Worktree per thread | P0 | Large | UI, store, native |
| A2 | "Needs attention" state for threads | P0 | Small | UI, store |
| A3 | Lazy thread creation | P1 | Small | store |
| A4 | Search across collapsed workspaces | P1 | Small | UI |
| A5 | Archive from the sidebar | P1 | Small | UI |
| A6 | Change counts on thread rows | P2 | Small | UI |
| B1 | Per-turn snapshots with Undo and Reapply | P0 | Large | store, native |
| B2 | Edit a message and rewind | P0 | Medium | UI, store |
| B3 | Prompt history on ↑ | P1 | Small | UI, store |
| C1 | Resizable review pane | P0 | Medium | UI, store |
| C2 | Readable diffs: highlighting, line numbers, word diff, split view | P0 | Large | UI, new dependency |
| C3 | Diff new untracked files | P0 | Medium | native |
| C4 | Review scopes (last turn, staged, unstaged, branch) | P1 | Medium | UI, native |
| C5 | Line comments sent to the agent | P1 | Medium | UI, store |
| C6 | Inline diffs on edit steps in the timeline | P0 | Small | UI |
| C7 | Live Changes refresh | P1 | Medium | store, native |
| C8 | Branches, push and pull requests | P1 | Large | UI, native |
| C9 | Non-git workspaces | P1 | Small | UI, native |
| D1 | Terminal pane (PTY) | P1 | Large | UI, native, new dependency |
| D2 | File tree and read-only file viewer | P1 | Medium | UI, native |
| D3 | Open in a chosen editor | P2 | Small | native |
| E1 | Real slash commands | P0 | Medium | UI, store |
| E2 | Custom commands | P2 | Medium | UI, store |
| E3 | A fuller command palette | P1 | Medium | UI |
| E4 | Keyboard coverage and shortcut sheet | P1 | Medium | UI, native |
| E5 | Find in thread | P1 | Medium | UI |
| E6 | Interface zoom | P2 | Small | native |
| F1 | Deny with feedback | P1 | Small | UI, store |
| F2 | Clear capability notes for ACP threads | P1 | Small | UI |
| G1 | Manage MCP servers in the app | P1 | Medium | UI, native, CLI |
| G2 | Consistent saving in Settings | P1 | Medium | UI |
| G3 | Settings navigation and layout fixes | P1 | Small | UI |
| H1–H8 | UI fixes | P1 | Small | UI |
| L1–L6 | Longer-term work | P2 | Large | various |

---

## A. Parallel work and attention

### A1. Worktree per thread

- **Status.** Done in phase 3, verified with `npm run verify`. Handoff landed later.
  See the worktree decision in [DECISIONS.md](DECISIONS.md) for the derived
  grant, removal rules, listing and limits.
- **Problem.** Every thread in a workspace edits the same working tree. Two
  running threads overwrite each other, and the Changes dock mixes their edits
  under "This session" and "Other uncommitted changes".
- **Reference.** Codex (Local or Worktree for each thread, Handoff between them)
  and Claude Code (worktree option per session, auto-archive after merge).
- **Proposal.**
  - Add a Local / Worktree choice below the composer for new Muse threads.
    Worktree asks for a base branch.
  - Add a native command `git_worktree_create(grantId, base)`. It creates the
    worktree under the app data directory and mints a **derived grant** for the
    worktree root, so session, git and file calls keep working through grants.
  - Record the worktree grant on the thread. Pass that grant to `startSession`.
  - Add `git_worktree_remove(grantId)`. Call it when a worktree thread is
    deleted, after a confirm that names the branch.
  - Later: Handoff, which applies a worktree's changes to Local.
- **Touches.** `Composer.tsx`, `store.ts` (`newThread`, `deleteThread`), a new
  native command and a grant derivation in `lib.rs`, and the `Thread` type.
- **Done when.** Two threads in one repository can run at the same time, and
  each has its own diff. Deleting a worktree thread removes its worktree.

### A2. "Needs attention" state for threads

- **Problem.** A thread that is waiting for an approval or an answer looks the
  same as one that is just running. `ThreadStatus` in `Sidebar.tsx` renders
  only running, failed and unread.
- **Reference.** Codex has "Next chat needing attention" (⌘⌥A). ZCode and
  Claude Code show status dots.
- **Proposal.**
  - Add `attention: boolean` to `ThreadRow`. Derive it from `pendingApproval`
    or `userInputs?.length`, and add it to `sameRow`.
  - Render it as a distinct accent dot with `aria-label="Needs your approval"`.
  - Add a palette command and shortcut that jump to the next thread needing
    attention.
- **Done when.** A blocked thread in a collapsed or unselected workspace stands
  out, and one keystroke opens it.

### A3. Lazy thread creation

- **Problem.** "New thread" calls `startSession` straight away (`newThread` in
  `store.ts`). An empty "New thread 2" row appears even if nothing is ever sent.
- **Proposal.** Make New thread clear `selectedSessionId` and show the
  workspace draft view. `sendPrompt` already creates the session when
  `sessionId` is missing, so most of the path exists. Keep the eager path only
  for agents that need a session to list models or modes.
- **Done when.** Opening and abandoning a new thread leaves no sidebar row and
  no CLI session behind.

### A4. Search across collapsed workspaces

- **Problem.** In `Sidebar.tsx`, `const threads = open ? threadsFor(item) : []`
  hides matches in collapsed groups while a search is active.
- **Proposal.** While `threadSearch` is non-empty, show matching rows for every
  workspace and expand the groups that have matches, without changing the
  saved expansion. Workspaces that were never expanded have no threads loaded
  yet. Load them on the first search, or say "Not loaded — expand to search".
- **Done when.** Searching finds a thread in any workspace, whether or not its
  group is open.

### A5. Archive from the sidebar

- **Problem.** The README promises archiving, and the store has
  `archiveThread`. But the thread menu offers only Rename, Pin, Export, Fork,
  Preview and Delete, and Settings only restores threads "archived in an
  earlier version".
- **Proposal.** Add Archive to the thread menu and the palette (⌘⇧A). Add a
  sidebar control to view archived threads. Optionally, auto-archive idle,
  read, unpinned threads older than N days, as ZCode does. If the decision is
  to drop archiving instead, remove it from the README.

### A6. Change counts on thread rows

- **Status.** Done, verified with `npm run verify`. See the log entry under
  [Progress](#progress).
- **Proposal.** Show `+added −removed` on rows for threads that changed files.
  Compute it from `editedPaths` against the current git snapshot. Keep it in
  the memoized row selector so a streaming reply never re-renders the sidebar.

---

## B. Undo and history

### B1. Per-turn snapshots with Undo and Reapply

- **Status.** Done in phase 3, verified with `npm run verify`. Capture and restore run in Rust and
  return descriptors; C4 can request bounded review patches from saved trees.
  See the private object-store decision in
  [DECISIONS.md](DECISIONS.md) for bounds, retention and recovery limits.
- **Problem.** "Revert files" on a turn receipt (`ReceiptView` in
  `AgentTimeline.tsx`) runs `discardGitFiles`. That is `git restore`, which
  also destroys the user's own uncommitted edits and every later edit to those
  files. It deletes new files outright, and there is no Reapply.
- **Reference.** ZCode (Undo/Reapply per turn, all or nothing, "Reset chat +
  files") and Claude Code (checkpoints and rewind).
- **Proposal.**
  - When a turn starts, have the native side record a snapshot of the
    workspace without touching the index or HEAD. One option is
    `git stash create` plus a temporary index for untracked files, stored as a
    ref under `refs/muse/turns/<turnId>`. Non-git folders need a capped file
    copy of the paths the turn touches.
  - **Undo** restores the files the turn changed, but only if each file still
    matches the turn's end state. Otherwise it refuses and lists the conflicts.
    It is all or nothing.
  - **Reapply** restores the end state.
  - Garbage-collect snapshot refs when a thread is deleted or after a retention
    window.
- **Touches.** `snapshots.rs` observes native submit/start/terminal events;
  `turn_snapshots`, `turn_snapshot_restore` and `turn_snapshots_forget` require a
  grant and owning session. `bindBridgeEvents` consumes native snapshot
  descriptors and `ReceiptView` offers Undo/Reapply with one confirmation.
- **Constraints.** File changes made by shell commands can't be attributed per
  turn. Say so in the confirm dialog, as ZCode does.
- **Done when.** Undo reverts exactly one turn's edits, leaves the user's own
  edits alone, and Reapply brings the turn back.

### B2. Edit a message and rewind

- **Status.** Done in phase 3, verified with `npm run verify`. See the message
  edit decision in [DECISIONS.md](DECISIONS.md) for cut points, first-message
  handling, draft preservation and the scope of the optional file reset.
- **Problem.** "Edit and resend" (`UserMessageView` in `AgentTimeline.tsx`)
  puts the edited text in the composer and sends a new turn at the end. The old
  turn and its file changes stay.
- **Proposal.** For Muse threads, editing a message forks the session at the
  turn before it (`forkSession` with `lastTurnId` is already validated in
  `dto.rs`). It sends the edited text in the fork and switches to the fork. With
  B1 in place, offer "Reset files too" to restore that turn's snapshot. Label
  the result clearly as a fork of the original thread (`forkedFrom` already
  exists).
- **Done when.** Editing message N gives a thread whose history ends at N−1
  plus the edited message.

### B3. Prompt history on ↑

- **Problem.** Pressing ↑ in an empty composer does nothing. Both Codex and
  Claude Code restore the previous prompt.
- **Proposal.** Keep a per-workspace history of the last 50 sent prompts in
  session memory (`sessionMemory.ts`). ↑ and ↓ step through it while the caret
  is on the first or last line and no menu is open.

---

## C. Review and git

### C1. Resizable review pane

- **Problem.** The dock is a fixed `width: 360px` (`.dock` in `styles.css`).
  Below 1000px wide it becomes a `position: fixed` overlay that covers the
  transcript and clips the composer.
- **Proposal.**
  - Add a drag handle on the dock's left edge. Clamp the width between 300px
    and 60% of the window, and persist it in session memory alongside
    `dockOpen`.
  - Add an "expand" control that gives the diff the full main area while the
    composer stays visible.
  - In narrow windows, switch to an explicit Chat / Changes toggle instead of
    an overlay.
- **Done when.** A 120-column diff is readable next to the chat on a 1440px
  screen, and nothing covers the composer at 1000px.

### C2. Readable diffs: highlighting, line numbers, word diff, split view

- **Problem.** Diffs and Markdown code blocks are monochrome (`CodeBlock` in
  `Markdown.tsx`, the hunk rendering in `ReviewDock.tsx`). There are no line
  numbers and no word-level highlighting.
- **Proposal.**
  - Choose one highlighter and record the decision. Lazy-load it so the main
    chunk doesn't grow; the README already notes a large single chunk. Use it
    for code blocks, diffs, approval previews and the file viewer (D2).
  - Compute old and new line numbers from hunk headers in `lib/diff.ts`. That's
    pure and unit-testable.
  - Add word-level highlighting for paired delete and add lines.
  - Add a split / unified toggle once C1 gives the pane enough width.
- **Done when.** Diffs show line numbers and language colors, and a one-word
  change is visible at a glance.

### C3. Diff new untracked files

- **Problem.** `ReviewDock.tsx` says "New files are listed under Changes. The
  diff covers tracked changes." Files the agent creates can't be previewed
  until they are staged.
- **Proposal.** Have `git_snapshot` add a capped synthetic diff for untracked,
  non-ignored text files (as `git diff --no-index /dev/null <file>` would), and
  skip binaries.

### C4. Review scopes

- **Status.** Done in phase 3, verified with `npm run verify`. See the review
  scope decision in [DECISIONS.md](DECISIONS.md) for native boundaries, limits,
  branch semantics and read-only scoped views.
- **Reference.** The Codex review pane offers Unstaged, Staged, Commit, Branch
  and Last turn.
- **Proposal.** Add a scope selector to the Diff tab:
  - **Last turn**, from the B1 snapshot.
  - **Staged** and **Unstaged**, from separate snapshot fields.
  - **Branch**, a diff against a chosen base.
  Each scope is a native read with a grant.

### C5. Line comments sent to the agent

- **Status.** Done in phase 5, verified with `npm run verify`.
- **Reference.** Claude Code (click a line, comment, ⌘↵ submits them all) and
  Codex (inline comments in the review pane).
- **Proposal.** Click a diff line to attach a comment, held in the store per
  thread. "Send comments" composes one prompt listing
  `path:line — comment` with the hunk context, and sends it through
  `sendPrompt`, or `steer` while a turn is running. This needs no protocol
  change.

### C6. Inline diffs on edit steps in the timeline

- **Problem.** An expanded edit step shows
  `step.output || step.error || formatArgs(args)` (`StepRowView` in
  `AgentTimeline.tsx`): tool output text, not the change itself.
- **Proposal.** Reuse `approvalPreview()` (`lib/approvalPreview.ts`), which
  already parses write, replace and patch arguments for approval cards, to
  render a capped diff for completed edit steps. Add an "Open in Changes"
  link.

### C7. Live Changes refresh

- **Problem.** The snapshot refreshes on workspace switch, on `turnCompleted`
  (`bindBridgeEvents`) and when Refresh is clicked. It is stale during long
  turns and after external edits.
- **Proposal.**
  - Step 1: run a debounced `refreshGit` when an edit-kind item completes and
    when the window gains focus.
  - Step 2: if needed, add a native file watcher scoped to the grant root.
    That is a new dependency, so it needs a decision entry.

### C8. Branches, push and pull requests

- **Status.** Done in phase 5, verified with `npm run verify`; Pull landed later.
  Network push, pull and `gh` were not exercised against a real remote.
- **Problem.** Changes supports stage, commit and discard only. The branch chip
  in the top bar opens the dock rather than a branch menu.
- **Proposal.**
  - Turn the branch chip into a menu: switch, create from current, and recent
    branches. Prompt when there are uncommitted changes, as ZCode does.
  - Add a "Commit and push" option. Push uses the user's own git credential
    helper. The app never handles git credentials.
  - Add "Create pull request" when `gh` is installed and signed in, with a CI
    status line in the thread afterwards.
  - Add a "Stage all" button. Add a "Draft message" button that runs the
    existing `/commit` request in the thread and fills the commit box from the
    reply.
- **Touches.** New native git commands with grants, plus `ReviewDock.tsx`.

### C9. Non-git workspaces

- **Problem.** In a folder that isn't a repository, `refreshGit` stores the raw
  git error as `gitError`.
- **Proposal.** Detect "not a repository". Show "Changes need git. Initialize a
  repository?" with a native `git_init(grantId)` behind a confirm.

---

## D. Workspace tools

### D1. Terminal pane (PTY)

- **Status.** Done, verified with `npm run verify`. See the D1 log entry under
  [Progress](#progress) and the terminal decision in [DECISIONS.md](DECISIONS.md).
- **Reference.** Codex (⌃`), Claude Code (Ctrl+`) and ZCode (⌘J) all ship an
  integrated terminal. Muse has only the `!command` shell escape, and only for
  the Muse agent.
- **Proposal.** Add a bottom panel with a PTY that starts in the grant root.
  This needs a decision entry (PTY crate plus a terminal renderer), a
  DESIGN_SYSTEM term (today "Terminal" means the shell card in a run), and
  thought about how it interacts with the host posture: should
  `disableShell` also disable it?
- **Constraints.** The PTY is a native child process. Its lifetime, process
  group and kill-on-close follow `process.rs`.

### D2. File tree and read-only file viewer

- **Status.** Done in phase 5, verified with `npm run verify`.
- **Proposal.**
  - Add a Files tab in the dock, built on `list_workspace_files` (it already
    feeds `@` mentions). Include a filter, a "changed only" toggle and git
    status badges.
  - Add a native `read_workspace_file(grantId, relPath)`. Cap the bytes read,
    as `trust_preview` does for `AGENTS.md`, and confine the path with
    `path_within_grant`.
  - Give the viewer actions: Add to chat (creates a `ContextRef`), Copy path,
    Open externally.
  - Make paths in the transcript clickable to open them here.

### D3. Open in a chosen editor

- **Status.** Done, verified with `npm run verify`. See the log entry under
  [Progress](#progress).
- **Proposal.** Let `open_path` take an editor choice from a short native
  allowlist (VS Code, Cursor, Zed, JetBrains, system default), set in Settings.

---

## E. Composer and commands

### E1. Real slash commands

- **Status.** Done in phase 4, verified with `npm run verify`. See the phase 4
  log entry under [Progress](#progress) for what was built and what was not.
- **Problem.** `SLASH_COMMANDS` in `lib/composerText.ts` is seven canned
  prompts. `filterSlashCommands` lists skills and macros side by side, so the
  same name can appear twice (for example `/plan` and `/review`).
- **Proposal.** Add built-in actions that call existing store actions instead
  of sending text:

  | Command | Action |
  |---|---|
  | `/new` | `newThread` |
  | `/compact` | `compactThread` |
  | `/fork` | `forkThread` |
  | `/rename` | inline title edit |
  | `/model`, `/effort`, `/permissions` | open the matching picker |
  | `/init` | `openInitDialog` |
  | `/status` | context, usage and session id |
  | `/mcp`, `/skills` | Settings → Extensions |
  | `/export` | `exportSession` |
  | `/review` | the review prompt with a scope (see C4) |

  - Show built-ins first and skills second. Keep macros only if nothing else
    has that name.
  - Raise the limit of six entries and make the list scrollable.
  - Show `argumentHint` for skills.
- **Done when.** Each name appears once, and built-ins act without a model
  turn.

### E2. Custom commands

- **Status.** Done, verified with `npm run verify`. See the log entry under
  [Progress](#progress).
- **Proposal.** Let users define prompt templates (name, description, body with
  `$ARGUMENTS`) in Settings, stored with the other settings. If the CLI gains
  project-level commands, read them as it does rather than inventing a second
  format.

### E3. A fuller command palette

- **Status.** Done in phase 4, verified with `npm run verify`. See the phase 4
  log entry under [Progress](#progress) for what was built and what was not.
- **Problem.** `CommandPalette.tsx` lists about 12 fixed commands plus 8
  threads. Only threads have icons, and there are no sections.
- **Proposal.**
  - Add sections (Actions, Threads, Files, Settings) with icons.
  - Add files from the workspace file index (open in D2, or add to chat).
  - Add model, effort and permission switches, theme toggle, fork, compact,
    export and archive.
  - Add deep links to each Settings tab, and recent commands.
  - Search threads across workspaces, not only the current one.

### E4. Keyboard coverage and shortcut sheet

- **Status.** Done in phase 4, verified with `npm run verify`. See the phase 4
  log entry under [Progress](#progress) for what was built and what was not.
- **Problem.** About a dozen shortcuts exist (`App.tsx`, the native menu in
  `lib.rs`, the Settings → Shortcuts list). There is no way to switch threads,
  no shortcut sheet and no remapping.
- **Proposal.**
  - Add ⌘1–9 to go to a thread, Ctrl+Tab / Ctrl+⇧Tab and ⌘⇧] / ⌘⇧[ for
    next and previous, and ⌘/ for a shortcut sheet.
  - Add shortcuts for the model (⌘⇧I), effort (⌘⇧E) and permission (⌘⇧M)
    menus.
  - Add an option for Enter / Esc to approve or deny while an approval card has
    focus.
  - Register each new accelerator in the native menu so it doesn't fire twice
    (see the comment in `useDesktopShortcuts`).

### E5. Find in thread

- **Status.** Done in phase 4, verified with `npm run verify`. See the phase 4
  log entry under [Progress](#progress) for what was built and what was not.
- **Problem.** ⌘F focuses thread search. There is no way to find text inside a
  long transcript.
- **Proposal.** Make ⌘F find within the open thread, with highlights and
  ⌘G / ⌘⇧G. Move thread search to ⌘⇧F. Virtualized runs need to be expanded
  or searched in the model, not the DOM. This changes an existing shortcut, so
  record it in `CHANGELOG.md`.

### E6. Interface zoom

- **Status.** Done, verified with `npm run verify`. See the log entry under
  [Progress](#progress).
- **Proposal.** Add View → Zoom In / Zoom Out / Actual Size (⌘+ / ⌘− / ⌘0),
  using the webview zoom, and persist the level.

---

## F. Approvals and agent control

### F1. Deny with feedback

- **Problem.** `ApprovalChoice.acceptsFeedback` exists in `types.ts`, but
  `ApprovalCard` ignores it. `DecideApprovalParams` (`dto.rs`) and the SDK have
  no feedback field.
- **Proposal.** Without a protocol change: "Deny and explain…" opens an inline
  text field. It sends the deny choice, then sends the text as a steer, or
  queues it if steering isn't possible. If the CLI later adds approval
  feedback, switch to the native field and extend the DTO.

### F2. Clear capability notes for ACP threads

- **Problem.** ACP threads silently lose fork, export, history paging,
  permissions, busy sends, shell escapes, goals and background tasks. Controls
  just vanish.
- **Proposal.** Keep the design rule "Hidden > disabled > fake", but add one
  line under the composer agent picker that says what the agent doesn't support
  ("OpenCode threads can't be forked or exported"). Keep the full matrix in a
  popover.

---

## G. Extensions and settings

### G1. Manage MCP servers in the app

- **Status.** Blocked on the CLI: `muse mcp` has only `login` and `logout`
  (rechecked 2026-10-21 on Muse Code 1.4.11).
- **Problem.** Extensions lists servers and handles OAuth only: "Add them with
  the Muse CLI, then refresh."
- **Proposal.** First check `muse mcp --help` for add and remove. If they
  exist, wrap them as native commands the way `skill_install` and
  `mcp_login` are wrapped, with bounded arguments passed after `--`. Then add an
  "Add server" form (name, transport, command or URL, environment variable
  names; values go to the keychain or the CLI). If the CLI has no such
  commands, this item depends on the CLI.

### G2. Consistent saving in Settings

- **Status.** Done, verified with `npm run verify`. See the log entry under
  [Progress](#progress).
- **Problem.** Most tabs use Save / Cancel. The Notifications toggle saves
  immediately and sits in the Threads tab. Account uses "Save & restart
  connection".
- **Proposal.** Save preference-style settings (theme, accent, notifications,
  defaults, agent visibility) immediately. Keep an explicit "Restart
  connection" only for settings that rebuild the host: posture, credential
  mode, API key, binary path. Move Notifications to a General tab.

### G3. Settings navigation and layout fixes

- **Problem.** At 1440×900 the settings navigation overflows (584px of content
  in 520px), which hides Diagnostics and About with no hint that it scrolls.
  The dialog also always opens on Models (`setTab("Models")` on open).
- **Proposal.** Tighten the group spacing or add a fade at the scroll edges.
  Remember the last tab, and let callers open a specific tab (needed by E1 and
  E3).

---

## H. UI fixes

| ID | Issue | Where | Fix |
|---|---|---|---|
| H1 | A pinned plan sits over the next card; the subagent card's Result / Follow up / Transcript / Close buttons peek out underneath | `.card.plan.sticky`, `PlanView` | Render the pinned plan as a compact strip above the scroller, or give the sticky card an opaque background and a matching `scroll-margin` |
| H2 | Expanded thought rows repeat the first line in the header and the body | `StepRowView` (reasoning) | Drop the summary when the row is open, or start the body after the first line |
| H3 | Two model rows can both read "Muse Spark 1.3", told apart only by a tag | `modelName` strips the contributor suffix (`ModelPicker.tsx`) | Add the variant ("· Contributor") or provider to the label |
| H4 | Slash menu duplicates (`/plan`, `/review`) | `filterSlashCommands` | Covered by E1 |
| H5 | Monospace used for body text (the archived-threads empty state, slash-menu hints) | `.archive-list .model-meta`, `.mention-path` in `styles.css` | Keep monospace for paths, commands and code only |
| H6 | Changes rows truncate paths from the left ("…ps/desktop/src/App.tsx"); Discard appears only on hover; staging is a bare "−" or "+" | `.file-row .path`, `.file-discard` | Show the file name with a dimmed directory, give stage a label or checkbox, show Discard on the focused row |
| H7 | Top-bar icons (fork, monitor, dock) have no labels; the branch chip looks like a branch switcher | `ThreadView.tsx` header | Add text labels when there's room; make the chip a branch menu (C8) |
| H8 | "Jump to latest" floats over content in the middle of the transcript | `.jump-latest` | Anchor it just above the composer, at its right edge |

---

## L. Longer-term work

These need CLI or protocol support, or are product decisions. Keep each one off
the roadmap until the dependency exists.

- **L1. Scheduled automations.** Recurring prompts per workspace that run in a
  worktree (A1), with results in a review queue. They need a background
  scheduler that survives the window closing.
- **L2. Remote workspaces.** SSH, WSL and Docker. This depends on how the CLI
  runs remotely, and grants have to be extended to remote roots.
- **L3. Side chat.** A temporary question that uses the thread's context
  without adding to it. It could be built on `forkSession` with a discard on
  close, Muse only.
- **L4. Cost visibility.** Done. Per-turn cost is on the turn line and the
  per-thread estimate is in the context meter, both labeled as estimates from
  reported usage and `Model.cost`. See the log under [Progress](#progress).
- **L5. Markdown export.** Done. "Export share-safe Markdown" and "Export raw
  Markdown" sit beside the JSON exports. The file is a readable projection of
  `muse export`, not a second transcript. See the decision in
  [DECISIONS.md](DECISIONS.md).
- **L6. Signed builds and auto-update.** Already tracked in
  [RELEASING.md](RELEASING.md). Every competitor ships signed, auto-updating
  builds.

## Suggested order

1. **Quick wins, renderer only:** A2, A3, A4, A5, B3, C6, F1, F2, G3 and H1–H8.
2. **Review foundation:** C1, C2, C3, C7 and C9.
3. **Safe parallel work:** B1, then B2 and C4, then A1.
4. **Commands and navigation:** E1, E3, E4 and E5.
5. **Workspace tools and git:** D2, C8, C5, D1 and G1.
6. **Longer-term work (L1–L6),** once its CLI dependency is in place.

Each item ships with tests at the level it touches:
- `tests/*.test.mjs` for pure helpers in `lib/`.
- Vitest DOM tests for components.
- `dto.rs` and native tests for new commands.

Run `npm run verify` before you hand off. User-visible changes go in
`CHANGELOG.md` under `[Unreleased]`.
