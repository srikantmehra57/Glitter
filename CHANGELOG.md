# Changelog

All notable changes to Glitter (called Muse Code Desktop before the rename) are
recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

See `THIRD_PARTY_NOTICES.md` for redistributed components and `README.md` for
licence terms.

## [Unreleased]

### Added

- A built-in agent, **Harness**, that works without any agent CLI installed.
  Add your own key in Settings → Providers (Anthropic, OpenAI, Google Gemini,
  OpenRouter, xAI, DeepSeek, Groq, Mistral, NVIDIA NIM, a custom
  OpenAI-compatible endpoint, or Ollama and LM Studio on this Mac) and its
  models appear in the composer. Each hosted provider's key form links to the
  page where you create a key. It reads, searches and edits files in the workspace and runs
  commands under the OS sandbox, follows the permission modes and Plan mode,
  asks through the usual approval cards, and keeps its threads on this Mac.
  Keys stay in the keychain and are sent only to their provider.
- Harness has skills. Put a folder with a `SKILL.md` (a `name` and a
  `description` in its frontmatter) in `.agents/skills` or `.glitter/skills`,
  in the workspace or in your home folder. Harness sees the list each turn,
  loads a skill when a request matches it, and runs one when you type
  `/name`. Extensions and the composer's slash menu list them.
- Harness approvals name what they allow. "Allow in thread" now covers what
  you pick on the card: this exact command, a command prefix such as
  `git push …`, every command of one program, one file, a folder, or the
  workspace. Before, one click allowed every command, or every edit, for the
  rest of the thread.
- Harness runs known read-only commands (`ls`, `git status`, `git diff`,
  `rg`, `cat` inside the workspace…) without asking, in every permission mode,
  Plan mode included.
- Harness never runs a command that would format a disk or delete the root or
  home folder, in any permission mode. Risky commands, such as `rm -r`,
  `git push --force`, `git reset --hard` or piping a download into a shell, can
  only be allowed once, and the card says why.
- When a Harness approval expires, the agent is told it expired, not that you
  denied it.
- Settings → Diagnostics → Copy diagnostics now includes the app version,
  operating system and architecture, and the last 200 redacted lines from the
  app log. If the log cannot be read, the rest of the diagnostics are still
  copied.

### Changed

- The app is now called **Glitter**. The window, menus, Dock name, About and
  Settings say Glitter; "Muse" and "Muse Code" remain only where they mean
  Meta's CLI, agent and subscription. The bundle identifier is now
  `com.glitter.desktop`, so the data folder, log folder and keychain service
  moved. On first launch Glitter moves a Muse Code install's settings, threads,
  built-in harness sessions, turn snapshots, logs, API key, provider keys,
  workspace grants and agent pins across, and deletes the old keychain entries
  once the new ones read back. macOS may ask once per entry before Glitter can
  read it. Existing worktrees stay in Muse Code's data folder and keep working
  there; new worktrees use `glitter/` branches. Quit Muse Code before you
  first open Glitter, and move `/Applications/Muse Code.app` to the Trash.
- Glitter is now macOS only. The Windows installers (NSIS and MSI) are no
  longer built, and CI tests on macOS alone.
- The model picker opens straight to the models: one click opens it, one
  click picks a model and closes it. Agents are tabs in its header instead of a
  menu inside the menu, and fast variants are ordinary rows tagged Fast.
- Reasoning effort is its own control beside the model. The chip shows the
  level as rising bars; a click opens a small panel with one large, labelled
  column per level, where hovering previews a level and a click picks it. The
  arrow keys on the chip step the level without opening it, and /effort opens it.
- Settings → Usage counts tokens from a record the app keeps as each turn
  finishes, from the counts each agent reports, so the numbers survive a
  restart or a reinstall and no longer move with which threads are loaded.
  Cached prompt tokens count as input. A new By provider section shows each
  provider's share of the period with input, output and turns, alongside top
  models, agents and tools. Turns older than two weeks roll up into daily
  totals kept for 400 days, and Clear history removes the record. Usage
  recorded before this version is not counted.
- Interface polish across the app. Hiding the sidebar now animates its rows
  out instead of dropping them at once, and the thread search field, error
  banners, the subagent card, the live activity detail and the @ and / popups
  ease in and out. A thread's four export formats now sit under one Export
  item, and its menu opens upward near the end of the list. Rows, inputs and
  segmented controls share one shape. Your messages, the composer and replies
  share one text size. Zero line counts recede. Diff line numbers are dimmer,
  and a single open file no longer adds a tab row. The light theme's
  secondary and tertiary text are further apart, and selected rows show an
  edge. Checkboxes follow the theme. The title bar's Monitor button is gone:
  the side pane's tabs open the monitor. Icon buttons show their labels as
  in-app tooltips, which hide once clicked.

### Fixed

- OpenCode and Grok no longer show "Waiting on… the provider may be busy or
  retrying" while they work. A running command or an open approval counts as
  work, the quiet notice waits 45 seconds instead of 15, it no longer labels
  the turn Retrying, and it clears as soon as the agent responds. A
  notice shows once, under the activity line, while the turn runs.
- A plan stays in the thread where the agent made it. Pinning it to the top
  is now your choice, with its pin button.
- Models load when you switch agents or add a provider, without pressing
  refresh. An agent whose listing comes back empty is asked again with a fresh
  probe, an empty list is never kept as the answer, and a listing started
  before a new provider key was added is not reused.
- The Muse subscription meters no longer show a spent window after it has
  reset: the window reads "Reset since this reading" until the next Muse turn
  brings a new reading. Settings → Usage says how old the reading is, shows a
  refresh error even when an older reading is on screen, and hides the card
  when Muse is not installed.
- Overwriting a file shows the previous text and the new text in the tool card.
- A search or file read that is cut short tells the model which offset to request next.
- Command output that is too large to keep in the turn is saved in the workspace, and the model is told how to read it back. The saved file is not a substitute for reading it.
- Calling the same tool with the same arguments again draws a harness note on the result, so a stuck loop is visible in the transcript.
- Harness: output it saves for the model to read back no longer shows up as a
  change in git or in the review, and a listing too large to keep in the turn
  still tells the model how to fetch the rest.
- Harness: reading a file with one very long line, such as minified code, shows
  the start of the line instead of saving it to a file the model then cannot
  read either.
- Harness: a reply cut off when the provider closes the connection early is
  retried, instead of the partial reply ending the turn as if it were complete.
- The context meter counts cached prompt tokens, so a cached Anthropic turn
  no longer shows an empty window.
- A reply cut off by the output limit no longer runs a half-formed tool call.
  The model is told to send it again.
- An edit that does not match one place fails before the approval card.
- Harness accepts a follow-up while a turn is running: queue it, steer it
  into the turn, or replace the turn.
- A provider that accepts a request and then sends nothing is given up on,
  and retries stop after two minutes altogether.
- A session saved by a newer build is no longer rewritten as version 1. This
  build reads the document's version, shows the fields it understands, and
  refuses to save over a newer one. A banner says the newer file was left
  unchanged.
- The bundled Node runtime is staged only after the OpenPGP signature on
  `SHASUMS256.txt.asc` checks out against the pinned Node release key. The
  unsigned checksum file is not trusted.
- Grok and OpenCode no longer stop loading models after updating
  themselves. A new version signed by the same Apple developer as the trusted
  one is accepted automatically (and recorded in the security audit log);
  anything else still needs confirming in Settings.
- A new OpenCode thread shows the effort level and the Build/Plan mode as soon
  as a model is chosen, instead of only after the first message.
- OpenCode turns are no longer failed after 25 seconds without output; slow
  reasoning models get five minutes, and real provider errors still fail at once.
- Each sidebar thread's … button sits inside its row again; it had dropped
  below the row and doubled every row's height.
- Settings → Agents lists agents left-aligned like every other settings row.
- Clicking the transcript and pressing a key no longer outlines the whole
  panel.
- Scrolling up no longer shrinks the transcript to make room for Jump to
  latest, which now floats over it.
- The context meter's card stays open while the pointer moves onto it, so
  Compact now can be reached by hovering.
- The Thread / Changes switch in narrow windows shows which side is selected.
- In Settings, the full category list fits a 900px window, the archived-threads
  empty state is no longer cut off, and Done is the primary button on every
  tab.
- The effort note reads "Thinks it through before acting · Model default"
  instead of running the two together.
- Long model names truncate on one line in the model picker.
- Opening Muse Code again now focuses the running window instead of starting a
  second copy that could overwrite workspace access and settings.
- Request deadlines, suggestion budgets, cache lifetimes and approval
  enforcement in the bridge now use a monotonic clock, so an NTP correction or
  a sleep/wake jump can no longer expire queued work early or keep an expired
  approval alive.
- The quiet-thread reconciler shares one in-flight pass instead of stacking
  overlapping session listings when the host is slow.
- Native diagnostics, including agent bridge errors and workspace-grant and
  git operation records, now reach the app log instead of being lost in
  packaged builds; the security audit log rotates at 2 MiB like the app log.
- A signal-interrupted read (EINTR) on the bridge stream no longer ends the
  relay; the frame reader retries it and the agent connection survives.
- Third-party agents can write their config on first launch. The sandbox
  allow-list names each agent's own directory and not its parent, and a
  directory that does not exist yet cannot be created from inside the
  sandbox, so the bridge creates it before the agent starts.
- Smart suggestions run in the desktop app. The request names the open
  workspace's grant, and Muse's key comes from the keychain.
- A suggestion turn cannot read project files. It is told the file names, the
  branch, uncommitted paths, and thread titles, and that hidden session runs
  outside the project.
- Rescanning models updates the catalog for every agent. The model in use on
  the open thread stays selected.
- The first message of a new thread no longer switches you back if you change
  workspace while agents are still being detected.
- Suggestion tiles are requested only on the new-thread draft, and they update
  when git status or the file list arrives instead of keeping a partial guess.
- A model catalog that lands late no longer replaces a newer one. A Rescan or a
  thread switch can list the same agent twice, and the older answer is now kept
  out of the cache the picker and suggestions read from.
- The Suggestion model picker keeps a saved selection that is no longer in the
  catalog when its row is clicked; only "Cheapest available" clears it.
- A suggestion for a third-party agent with no workspace root is refused
  instead of quietly running without the read sandbox.
- Muse's suggestion host can write its config under `~/Library/Application
  Support/muse` on macOS, so a credential refresh mid-suggestion no longer
  fails the turn.
- An image-only first message shows its images in the pending card instead of
  an empty bubble while the session starts.

### Design

- Suggestion tiles move from the centre of the empty thread stage to a grid
  directly above the composer, where they are seen; a fresh prediction
  re-pops the grid.
- The transcript, pinned plan, terminal and composer share one inset and a
  720px cap, so the content column's edges line up with the composer's.
- The radius scale runs rounder — 12/18/20/24px — and the send button is a
  circle.
- The sidebar never scrolls sideways; a thread name that does not fit rolls to
  its tail on hover.
- Controls, chips and row highlights are fully rounded capsules (`--r-pill`);
  only menu items, fields and multi-line options keep corner radii.
- Reasoning effort gets its own card in the model picker: a thin rail with a
  tick per tier, an accent-gradient fill up to a small orb thumb, the tier's
  words underneath, a Fast-mode toggle for models with a `-fast` sibling, and
  a reset to the model default. Commits keep the picker open. The model
  catalog is a view back, and picking a model with effort returns to the card.
- Smart suggestions (opt-in, Settings → General): on a new thread's empty
  state, the chosen agent predicts what to do next from the project's file
  names, branch, uncommitted paths and thread titles — never file contents —
  and shows the answers as suggestion tiles that prefill the composer. The
  agent and model are configurable (the cheapest catalog model by default),
  each prediction is a single read-only turn on a hidden no-log session that
  bills the provider like any prompt, and results cache per workspace and
  refresh at most once a minute. Anything that fails falls back to the static
  suggestions.
- The Smoke theme moves to a near-black canvas with deeper panels and glass.
- A plan left unfinished by a stopped or interrupted turn no longer shows a
  spinner on the step that was in progress.
- A sent message leaves the composer at once instead of waiting for the agent
  to acknowledge it, and is put back if the send fails. The first message of a
  new thread shows straight away while its session starts, and still reaches
  that thread if you switch away meanwhile.
- Switching to a thread on another agent shows that agent's last model list
  immediately while the fresh one loads.
- Sidebar: Search sits beside Hide sidebar, the open thread alone carries the
  highlight, the guide line under a workspace and the brand mark are gone, and
  the status line reads "Ready" instead of listing agents. Title-bar buttons
  show a tooltip.
- The sidebar resizes from its right edge: drag it, use the arrow keys, or
  double-click to return to the default width. The width is remembered.
- Copy and Retry appear under an agent's finished answer only. The notes an
  agent writes between its steps no longer show them, and no longer leave an
  empty row beneath each note, which had spread a working turn out.
- Agent, model and reasoning effort share one composer control. Its popover
  uses a compact provider dropdown, visible model rows, search for larger
  catalogs and a small effort strip with a marked default. Async catalog loads
  expand the menu instead of clipping models. This replaces the effort slider.
  Model changes keep the picker open; shortcuts open the appropriate section.
- Settings dropdowns stay anchored to their fields inside frosted and animated
  dialogs instead of being offset and clipped at the right edge. The default
  model list refreshes independently of the current conversation's agent,
  shows catalog loading/errors, and identifies a saved model that the current
  CLI no longer lists without changing the saved preference.
- The composer has a 16px clear buffer above it. Status, recovery and worktree
  notices stay inside its frame, the terminal sits above it, and nothing is
  shown underneath. Third-party capabilities use a dismissible dialog with
  Don't show again and remain available from the Agent menu. Empty workspace
  and thread states no longer show the glowing artwork.
- The composer separates the writing area from a grouped toolbar with outlined
  model, effort and permission controls. Completed turns use a compact strip
  with duration, token usage and estimated cost beside Done; file changes,
  Fork, Undo and snapshot notices stay together below the reply.
- A new "Frost & Ember" identity: matte grey canvas, frosted glass chrome,
  soft diffuse elevation, and an ember glow as the brand signal — a five-tile
  ember M mark, regenerated native app icons on frosted-grey and graphite
  tiles, and rounded surfaces throughout. Onboarding, threads, composer
  controls, settings, approvals, changes, files, and terminal share the same
  material in the Frost (light) and Smoke (dark) themes.
- New threads offer task shortcuts directly on the main panel: the dotted
  stage and the card behind it are gone, along with the band of a different
  colour that showed behind the composer.
- The sidebar is translucent on macOS. Appearance has a new Sidebar section
  with a Translucency slider, from solid to mostly see-through, next to "Tint
  the sidebar". It follows Reduce transparency, and the window's material
  follows the Light, Dark or System theme.
- The sidebar and the gutter around the main panel are one surface, so tinting
  the sidebar colours both the same. The line down the sidebar's right edge is
  gone, and the New thread icon stays visible when the sidebar is tinted.
- The sidebar lists New thread, workspaces and the account button only.
  Extensions, Usage and Settings open from the account menu, the Settings
  shortcut and the command palette.
- The main panel's corners take the 20px section radius like the cards and
  dialogs, instead of nesting inside the window's corner.
- The title bar is one strip across the top of the window, apart from the main
  panel: the window controls, the sidebar's buttons, the thread title and the
  panel's actions share one line, with the sidebar open or collapsed. Collapsing
  the sidebar no longer puts the window controls and its buttons on top of the
  panel, and no longer shifts the panel's contents.
- Show/Hide sidebar is one button that stays straight after the window
  controls, so it does not move when the sidebar opens or closes.
- Hover and selected highlights on rows, menu items and icon buttons are plain
  rounded rectangles (8px) instead of the rounder 12px shape.
- New installations follow the system theme and start with the Ember accent.
  Existing appearance preferences are preserved; Monochrome and the seven
  optional color accents remain available.
- The website is restyled to the same identity: Frost/Smoke tokens, glass
  panels, the ember accent, a General Sans display face (the dotted Array font
  is dropped), and ember-tile hero art.
- The website shows the current app. Every screenshot is recaptured, the
  features grid shows the new thread screen, diffs, approvals, worktrees, the
  command palette and the terminal, the effort control is the new gauge, the
  sample run uses the app's step list and approval card, and Themes previews
  Monochrome alongside Ember and the seven colors.
- The contrast gate now reads the shipped CSS tokens instead of a duplicate
  palette, covering Ember and all seven optional accents. Browser preview
  workspaces no longer show a spurious lost-access warning.
- OS notifications put the event in the headline — "Turn finished",
  "Turn failed", "Approval needed" — with the thread and workspace named
  underneath (and the tool on approvals), instead of a truncated prompt
  as the title and a bare phrase as the body.

### Performance

- The terminal (`@xterm`) and syntax highlighter (`highlight.js`) stay out of
  the startup script. `scripts/check-chunks.mjs` fails the build if either is
  pulled back in.
- The window opens as soon as local state loads. Agent detection, host start,
  thread listing and reopening the last thread continue in the background, with
  "Checking agents…", "Loading threads…" and "Restoring your last thread…" shown
  instead of a boot screen (or a false "No agent CLI found").
- Agent detection no longer spawns `muse --version` twice and blocks the bridge on
  each CLI in turn: probes run concurrently and are remembered per binary, so
  repeat detections and host status checks answer in about a millisecond.
- Bridge requests that name a third-party agent no longer hash the agent binary
  twice, spawn `--version` and rewrite the keychain on every call. Digests are
  reused while the file's identity (inode, size, mtime, ctime) is unchanged, and
  recently modified files are always re-hashed, so a replaced binary is still
  caught.
- Git snapshots, staging, commits, discards, file indexing and dropped-file reads
  run off the main thread; a snapshot's five reads run in parallel and read-only
  git calls take no `index.lock`.
- The bundled runtime is verified beside the window instead of before it, and
  release builds use thin LTO with stripped symbols.
- Streaming a reply no longer re-renders the settled transcript, the composer or
  the sidebar on every frame, and long replies render only the block being
  written (7 KB: about 31 ms per frame down to under 1 ms).
- Scrolling within the rendered slice of a long thread no longer re-renders it.
- Streamed text is merged for up to one frame before leaving the bridge.
- Debug log lines are no longer redacted and sent over IPC in release builds.

### Added

- Settings → Models has subscriber Contributor routing, separate from the
  selected model, for current Muse CLIs. It preserves the CLI preference by
  default; an explicit Standard or Contributor choice takes effect after
  Save & restart connection.
- ACP model discovery supports OpenCode v2's session configuration and Grok's
  current catalog, including Grok 4.7 and Grok 4.7 Fast with the CLI's pricing
  note and effort tiers. Rescan refreshes the catalog instead of retaining
  stale rows. Failed refreshes keep existing models usable and show the error.

- Hover over Show sidebar while collapsed to open a temporary sidebar over the
  conversation. It closes shortly after the pointer leaves, stays open during
  keyboard editing or menus, and can be kept open by clicking the sidebar button.
- A prompt rail at the edge of the transcript: one dash per message you sent,
  with the current one highlighted. Hover or focus it to see the messages and
  jump back to any of them.
- Export a Muse thread as Markdown, share-safe or raw, from the thread menu
  or the command palette. The file is a readable transcript of the Muse
  session log: messages, recorded thoughts, tool calls, approvals and run
  outcomes. It is not the full log. Encrypted reasoning is left out. The JSON
  exports are unchanged.
- Choose from nine thinking orb animations under Settings → Appearance, with
  live previews in the current accent color. The choice saves immediately;
  Automatic keeps the animation that follows the run's reasoning effort.
- An integrated terminal (⌘J / Ctrl+J, or the Terminal button in the thread
  header): your own login shell in the folder the open thread works in,
  including a worktree thread's checkout. The shell ends when the pane closes
  or the folder in view changes. It is off when "Disable shell" is on under
  Settings → Permissions.
- Keyboard shortcuts can be rebound under Settings → Keyboard shortcuts: choose
  Change and press the new keys. Conflicts and shortcuts reserved for editing,
  approvals and thread switching are refused, each shortcut can be reset, and
  menus, tooltips and the command palette show the current keys.
- Apply to Local on a worktree thread: its commits and uncommitted edits are
  applied to the workspace folder as uncommitted changes. If any part does not
  apply cleanly, nothing there changes. The worktree and its branch are kept.
- Pull in Changes: fast-forwards the current branch to its upstream. Diverged
  history is refused, never merged, and Pull waits while a turn is running.
- File paths written as inline code in a message open in the Files viewer when
  they name a file in the workspace.
- Pending line comments are kept across a relaunch.
- Custom slash commands: define your own prompts under Settings → General.
  They appear in the slash menu after skills; `$ARGUMENTS` in the prompt marks
  where the cursor lands.
- Choose the editor that "Open file" uses (VS Code, Cursor, Zed, IntelliJ IDEA
  or the system default) under Settings → General.
- Interface zoom: View → Zoom In, Zoom Out and Actual Size (⌘+ / ⌘− / ⌘0). The
  level is remembered.
- Thread rows show the uncommitted `+added −removed` lines in files that thread
  edited, for threads working in the folder in view.
- A Files tab in the Changes pane: the workspace's files as a tree with a
  filter, a "Changed only" toggle and git status badges, and a read-only viewer
  with syntax colours. The viewer can add the file to the chat, copy its path
  or open it in its default app. Read and edit steps, message file references
  and the command palette open files there. Files over 256 KB are shown cut,
  and binary files say they have no preview.
- The branch chip in the thread header is a menu: switch to a recent branch or
  create one from the current commit. It asks first when there are uncommitted
  changes and is locked while a turn runs.
- Changes gains Stage all, Push, Commit and push, and Create pull request.
  Pushing uses your own git credentials and never prompts; pull requests use
  your GitHub CLI (`gh`) login, and the pane shows the pull request with its
  check status. Draft message asks the agent in the open thread for a commit
  message and puts its subject line in the commit box.
- Line comments in the Diff tab: comment on any line, then send every pending
  comment to the agent as one message with the code each is about. While a Muse
  turn runs, the comments steer it.
- Slash commands that act in the app without a model turn: `/new`, `/compact`,
  `/fork`, `/rename`, `/model`, `/effort`, `/permissions`, `/init`, `/status`,
  `/mcp`, `/skills` and `/export`. `/review` drafts a prompt for the review
  scope in view. Built-ins are listed first, then skills (with their argument
  hint), then prompt macros; each name appears once and the list scrolls
  instead of stopping at six.
- The command palette is grouped into Recent, Actions, Threads, Files and
  Settings, with icons. It adds model, effort and permission switches, theme,
  fork, compact, rename, status, export, a link to every Settings category, and
  files from the workspace index to add to the chat. Searching finds threads in
  every workspace.
- Find in thread (⌘F / Ctrl+F): searches the open thread's messages, including
  ones scrolled out of view, with a match count, Enter or ⌘G for the next match
  and ⇧ for the previous one. Collapsed tool output is not searched.
- Estimated cost: the context meter's details show the thread's estimated spend
  next to its token counts, and the finished-turn line shows that turn's share.
  Both are estimated from the model's catalog price and reported usage, and are
  hidden when the model has no price. The session token counts now use the
  session totals rather than the latest model call's figures.
- More keyboard shortcuts: ⌘1–9 opens a thread by position, ⌘⇧] / ⌘⇧[ and
  Ctrl+Tab / Ctrl+⇧Tab step through threads, ⌘⇧I / ⌘⇧E / ⌘⇧M open the model,
  effort and permission menus, and ⌘/ opens the shortcut list. A focused
  approval card takes Enter to approve and Esc to deny.
- New Muse threads can work in their own git worktree. Choose Local or Worktree
  below the composer, with an optional base branch or commit. A worktree thread
  gets its own checkout on a `muse/` branch, so two threads in one repository
  can run at once and each has its own Changes, review and Undo. Forks share
  their source's worktree. Deleting the last thread in a worktree removes it
  after a confirmation that names the branch; the branch is kept when it has
  commits that are not on another branch. Uncommitted changes in the workspace
  folder do not carry over.
- Diff offers Last turn, Staged, Unstaged and Branch review scopes alongside
  All changes. Last turn reads saved before/after contents even after Undo or in
  a non-git workspace. Branch compares committed HEAD with the common ancestor
  of a chosen base; unstaged review includes new-file previews. Scope views
  offer file selection, copy and export, with clear unavailable states and no
  discard controls that could affect another scope.
- Muse messages offer Edit and rewind: send the revision in a fork ending before
  that message, with its attachments and the original thread and draft kept.
  Editing the first message starts a fresh thread labeled Edited from. Optional
  Reset files too restores only the edited turn’s saved files and blocks the
  send on conflicts. ACP threads keep Edit and resend.
- Turn receipts offer Undo and Reapply using saved file states, including new,
  deleted and binary files. User edits present before the turn and the Git index
  are preserved; later edits to affected files refuse the entire restore and
  name the conflicts. Snapshots survive relaunch, expire after seven days, and
  are removed with the thread. Queued or overlapping turns and capture limits
  explain why Undo is unavailable; older history has no destructive fallback.
- Settings remembers the last category across launches; explicit links open their
  target without resetting unsaved edits. Tighter navigation keeps all categories
  visible at desktop size, with a visible scrollbar in shorter windows.
- Contributor model names include their variant. Changes rows show filenames
  above their directories, staging uses labeled checkboxes, and focused rows
  reveal Discard. Top-bar actions show text when space allows, and the branch
  indicator no longer opens the unrelated Changes pane.
- Archived-thread empty states and slash-command hints use the body typeface.

- ↑ and ↓ at the first or last composer line browse the last 50 acknowledged
  prompts in the workspace. Returning past the newest restores the unsent draft;
  attachments stay in place and open menus keep their arrow keys.
- Expanded completed edit steps show a bounded preview of the tool's changes,
  with an Open in Changes action. Approval previews use the same renderer and
  include multiple patch files.
- Deny and explain sends feedback after the denial is acknowledged. Muse steers
  or queues it; ACP waits for the current turn to finish. Failed or uncertain
  deliveries remain visible and can be moved into the draft without replacing it.
- Third-party threads show a capability note below the composer, with a popover
  listing the desktop adapter's supported features and limits.
- Threads waiting on an approval or an answer show an amber "Needs your attention"
  dot in the sidebar, ahead of the running spinner, and a collapsed workspace
  holding one shows the dot on its row. ⌘⌥A (Ctrl+Alt+A) and the command palette
  open the next waiting thread.
- Archive is back in the thread menu and the command palette (⌘⇧A / Ctrl+Shift+A).
  When something is archived, an Archived threads button beside Workspaces opens
  Settings → Threads, where archived threads can be restored or deleted.
- Searching threads also finds matches in collapsed workspaces. They are listed
  on the first search and shown for the length of the search, without changing
  which workspaces stay expanded.
- The Changes pane is a real pane, not an overlay: it resizes from a left-edge
  handle or with arrow keys (300px minimum, up to 60% of the window, capped so
  the thread keeps room), remembers its width across launches, and expands to
  take the main area while the composer stays visible. At narrow widths a
  Thread / Changes toggle in the top bar replaces the floating dock, and the
  composer is never covered.
- New files preview in the Diff tab without being staged. Text files get a
  synthetic new-file diff (bounded per file and per snapshot, UTF-8 only,
  no binaries, symlinks or oversized files — each with an honest reason shown
  instead), and paths with spaces, tabs or non-ASCII characters open under
  their exact names.
- Diffs are easier to read: hunk headers drive old and new line numbers, and
  changed words inside paired lines are marked. The Diff tab offers a
  Unified/Split layout toggle that takes effect once the pane is wide enough
  (640px), with a hint when it is too narrow. Approval previews share the same
  renderer. Code in diffs, approval previews and Markdown blocks gets
  theme-aware syntax colouring (lazy-loaded grammars, plain fallback while it
  loads), composed with the word-change marks so a changed token keeps both
  its colour and its mark.
- The Changes pane refreshes itself: when an edit step completes and when the
  window regains focus it schedules one debounced read, and edits that land
  while a read is in flight queue exactly one follow-up. A refresh started
  during a stage, discard, commit or init can never overwrite the write's own
  answer.
- A workspace that is not a git repository offers "Initialize repository" in
  Changes instead of a raw git error. The confirmation names the workspace and
  explains that existing files are untouched and nothing is committed.

- Esc stops a running turn (as the Stop button's tooltip already claimed). An open
  menu closes first, and it never fires past a modal or from another text field.

- Atomic settings persistence: `muse-desktop.json` is written via a temp file and
  rename with the previous good copy kept as `.bak`, so a crash mid-save can no
  longer truncate it and destroy every draft and thread title.
- Corruption recovery on launch: an unreadable settings file is quarantined as
  `muse-desktop.json.corrupt` instead of being silently overwritten, and the
  newest complete backup is restored.
- A visible banner when local persistence fails, so drafts are never described as
  saved when they are not.
- `THIRD_PARTY_NOTICES.md` and `RELEASING.md`.
- `npm run verify` runs the full documented gate set, and `npm run check:versions`
  fails the build when the six version-carrying manifests disagree.
- CLI updates in the left nav: the app checks the installed Muse CLI against
  its release channel hourly, shows an update row with the channel's release
  notes when a newer release is out, and updates on demand through the
  launcher's synchronous update. Settings → About also shows the CLI release
  state with check and update actions.

### Changed

- The reasoning-effort control is redesigned as a gauge: a thin gradient track
  with a pill handle that carries the tier's name, the tier and model side by
  side above it, a dashed mark at the model's starting tier, and the fastest
  and deepest tiers named underneath as shortcuts.
- The model list is redesigned: a selection mark leads each row, context and
  effort range sit under the name, and input and output prices have their own
  column.
- The composer toolbar is redesigned. Model, effort and permissions are matching
  pills; Max and Unrestricted show as a tone on the same pill, so Unrestricted
  now stays warning-coloured while it is selected. The context meter sits on
  the right beside Send, the full model name shows when there is room, and the
  row folds labels to icons instead of wrapping in a narrow window.
- Settings is rebuilt as a two-pane dialog. Every page shares one column, each
  setting is a row with its name and help on the left and its control on the
  right, and switches, choice lists and notes use one style throughout. The
  oversized header is gone; the page title and close button sit in the page.
- The interface moves smoothly, in both directions. The sidebar and the Changes
  pane animate their width open and shut, sections grow in and shrink out,
  menus and popovers open from their anchor and fade away, dialogs ease in and
  fade out with their backdrop, and rows, tabs and buttons ease between states
  and respond to a press. Closing is never delayed by its animation, and
  reduced-motion settings still disable all of it.
- Escape in a menu inside Settings closes that menu, not Settings with it.
- The output, preview, trust and AGENTS.md dialogs are edge-to-edge with one
  gutter and real buttons, instead of a header inset inside a padded box.
- The Changes pane lines up: the commit field, actions, group labels, files and
  links share one left edge, and the added and removed counts sit in columns.
- The expanded sidebar has its own Hide sidebar button.
- Muse's logo is a single monochrome spark. The interface mark follows the
  selected Appearance theme, and the running Mac Dock icon switches with the
  system's light or dark appearance.
- The sidebar footer is an account menu. Clicking it offers Usage (the
  subscription meter, expanded in place), Appearance, Keyboard shortcuts,
  Account and Settings, instead of a usage card pinned above the footer.
- A run's step list sits on its own bordered surface panel, so tool calls and
  thoughts read as one block instead of floating over the thread background.
- The composer's `!command` chip now reads "Shell command". "Terminal" means
  the new terminal pane.
- Settings save as you change them. Only settings the Muse host is built with
  (the sandbox options under Permissions, the credential, the API key and the
  binary path) wait for "Save & restart connection"; Cancel discards just
  those. Notifications moved from Threads to a new General category.
- ⌘F / Ctrl+F now finds within the open thread. Thread search moved to ⌘⇧F /
  Ctrl+Shift+F. With no thread open, ⌘F still focuses thread search.
- New thread opens a blank draft in the workspace instead of starting a CLI
  session straight away. The session starts with the first message, so a new
  thread that is abandoned leaves no empty sidebar row and no idle session.
- Developer documentation now lives in `docs/` (architecture, development, agent
  guide, decisions, design system, releasing). The root scripts gained
  `typecheck`, `build:ui`, `test:native`, `check:a11y`, `check:contrast` and
  `clean`. The unused `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-opener`
  renderer packages were removed; the native plugins are unchanged.
- Permission options use the Muse CLI's own terminology — Read only, Ask me,
  Auto-review, Unrestricted — in the same order, in both the composer menu and
  Settings → Permissions.

### Fixed

- Double-clicking the title bar now maximizes the window and restores its size
  on the next double-click. Collapsed sidebar buttons, the thread title and
  toolbar actions align with the native window controls.
- Hovering or pressing New thread no longer flickers. Under the Ember accent the
  button's gradient was swapped for a flat colour, so for a moment it showed
  through to the sidebar; Send and the primary buttons did the same. The fill
  now stays and the hover colour fades in over it.
- The model picker no longer reads "Choose model" when a thread or the default
  model names a model Muse has stopped listing, as Muse 1.4 did with the
  `-contributor` ids. That model stays in the list, marked "Not listed", and
  can be chosen again.
- With the sidebar hidden, its buttons no longer sit under the window controls
  while those overlap the panel. The sidebar gives up its column and Show
  sidebar, New thread, Open workspace and Settings become a row in the title
  bar, after the window controls.
- Changing the effort, model or permissions no longer shakes the composer. The
  "Applying thread settings…" line used to push the composer up for the moment
  it showed, and the toolbar dimmed with it. The line now sits in the space
  under the composer without moving anything, appears only if the change takes
  more than a moment, and the controls keep their look while it applies.
- Appearance gives Thinking orb a separate preview panel. Select menus escape
  clipping scroll containers, open on the side with room, and stay within the
  window or settings dialog.
- Muse shell commands no longer fail with `sandbox_apply: Operation not permitted`
  on macOS. The desktop starts `muse serve` directly so Muse can apply its own
  command sandbox and approval policy; diagnostics report `cli-managed`.
- Pinned plans sit in a compact strip above the transcript, so they cannot cover
  the next card. Unpinning returns the full plan to its timeline position.
- Expanded thought rows no longer repeat their first line in the header.
- Jump to latest sits at the right edge above the composer in its own row,
  staying clear of transcript content as the composer grows.
- Updated website image tooling to sharp 0.35.5 and the source-map-js lockfile
  resolution to 1.2.2 to address two high-severity dependency advisories.
- A diff of more than 1.5 MB of non-ASCII text no longer panics the git snapshot
  when the size cut lands inside a character.
- A file with only unstaged edits no longer shows as staged in Changes: the two
  porcelain status columns are kept exactly instead of being trimmed to one
  letter.
- Diff file names that git quotes (tabs, quotes, non-ASCII) now parse to the
  real path, so their tabs, open-in-editor and copy actions use the true name
  instead of the escaped one.
- A background thread listing is no longer discarded when the user starts a
  thread or selects another while it runs.
- The model picker no longer blanks to "Loading…" on every thread switch.
- Session export results appear in the app's own dialog instead of a native alert.
- Tab no longer traps keyboard focus in the composer (WCAG 2.1.2): indentation
  now claims Tab only when text is selected or a completion is pending.
- The danger-confirm dialog treats Enter on a focused Cancel as cancel, so the
  safe default can no longer be defeated by keyboard.
- `skills install` and `plugins install` pass paths after `--`, so a folder name
  beginning with `-` cannot be read as a flag.
- A stale `git` snapshot can no longer resurrect pre-mutation state, `forkThread`
  can no longer create two sessions from one double-click, and a failed
  superseding send rolls the optimistic message back instead of leaving an
  unsent message in the transcript.
- The development PATH no longer includes `~/.hermes/node/bin`.
- Log detail sanitisation strips control characters and is size-capped, so an
  agent name cannot forge extra log columns.

- Every menu returns focus to its trigger when dismissed by keyboard. Closing with
  Tab (or Escape, in the model picker) left focus on the document body, because the
  focused option unmounted and the keyboard user was dropped out of the composer.
- The Changes dock tabs are wired to a labelled panel. They declared role="tab"
  with no aria-controls, and the panel was an unlabelled region, so a screen-reader
  user heard three tabs with no way to tell which one was showing.
- Opening a workspace no longer runs a quadratic membership test over the session
  listing. 200 rows per page across up to 10 pages, checked against an array of
  threads, cost about 10ms per open at a thousand threads and two thousand sessions;
  it is now a set lookup.
- Docs note that the macOS DMG target shells out to create-dmg, which is not
  installed by default. The .app still builds and verify-macos-package.mjs still
  passes without it.
- The opencode watchdog no longer reads its log synchronously on the event loop. Every tick used to stat and read up to 512 KiB of opencode’s log with sync fs, stalling every other agent’s delta streams; the listing, stat and read are now async. (Bounded and opencode-only, so the stall was brief, but it was a recurring block.)
- Two concurrent folder pickers can no longer mint two grants and lose one keyring entry; the lookup and the insert now share one lock.
- Grant verification snapshots the grant table under its lock instead of holding it across up to 256 canonicalize() syscalls, which contended with grant minting and CLI resolution.
- Closing a thread now releases its session from the bridge. The bridge held one SDK session per open thread and nothing else ever dropped one, so deleting threads (or a whole workspace) grew its session, cursor, gap, turn-key and queued-turn maps for the bridge’s lifetime. Reopening the thread resumes it again, so nothing is lost.
- A wedged send acknowledgement no longer freezes a thread. `sendTurn` awaits the acknowledgement, not the turn (the item, delta and completion streams are wired fire-and-forget), so its round trip is bounded like any other verb — which also keeps `cancelTurn` reachable on the same queue key, so Stop still works.
- A bridge verb that never answers no longer holds its queue slot forever. Requests are serialized per agent and session, so one wedged verb blocked every later call on that key — including the `cancelTurn` the user reaches for to stop it — until the queue limit started rejecting. The wait is bounded, not the request: the promise is abandoned with the renderer’s unknown-result wording, so a send whose acknowledgement never arrived stays retryable rather than rolling back as a failure. Verbs whose duration is legitimately unbounded (`sendTurn`, which awaits the whole turn, `updateCli`, and the browser sign-in) are exempt.
- Deleting a thread that still has a running turn now stops the turn. The host
  runs the agent, not the app, so a deleted thread's turn kept going unseen —
  spending quota, still writing files, and parking its next approval where
  nothing could answer it.
- Reopening a thread on a third-party agent no longer spawns a second agent
  process per reopen. The host key was re-derived from a value that was already
  a host key, so the live host was missed and each reopen leaked one more child
  while the session's requests stopped being serialized.
- An oversized streamed delta no longer kills the bridge's connection to the
  shell. Delta frames now go through the same byte ceiling as every other
  frame, splitting across frames rather than being dropped, so no text is lost.
- Unanswered approvals now settle at their 10-minute deadline (answering with
  the offered deny choice where one exists) instead of parking the agent's
  permission round trip forever, and a restored approval card clears itself.
- Starting the host no longer leaves `muse serve` running if the handshake
  fails or wedges; the wait is bounded and the spawned host is closed.
- `trust_preview` reads only the first 64 KiB of a workspace `AGENTS.md`. An
  `AGENTS.md` that was a symlink to `/dev/zero`, or simply enormous, used to
  allocate until the process aborted — reachable by opening a folder, or by an
  agent with write access planting the symlink.
- `renameSession` caps the raw name, not just the whitespace-collapsed one, so a
  space-padded payload can no longer pass a one-character check and forward
  megabytes to the host.
- The command palette is a native dialog: focus stays inside it, the app behind
  is inert while it is open, and focus returns to whatever opened it. It
  previously let Tab walk out into the sidebar and composer, and dropped focus
  to the document body on close.
- The working-indicator button keeps its button semantics. It carried
  `role="status"`, which hid the "expand to see current activity" disclosure
  from assistive technology and silently discarded its `aria-expanded` state.
- The thinking orb stops repainting under `prefers-reduced-motion`, which the
  global CSS rule cannot reach for a canvas driven by `requestAnimationFrame`.
- Committing, staging and discarding in the Changes dock disable their controls
  while in flight. A double-click on Commit sent two commits.
- Settings that fail to save now say so. A failed write rejected into a
  fire-and-forget call site, leaving the toggle looking inert with no
  explanation.
- The composer action row wraps instead of clipping the send button and context
  meter when the Changes dock takes the remaining width.
- Failures on the git, settings, extensions, timeline and task surfaces now
  report what happened and what to do next instead of raw `Error: …` text.
- The command palette's "Reconnect Muse" entry is labelled "Connection
  settings", matching what it does.
- Bulk destructive confirmations (delete all archived threads, remove an MCP
  credential) now state what is removed, as their sibling dialogs do.
- Every modal restores focus to whatever opened it. Settings opened from the
  sidebar gear and then closed left the keyboard user on the document body, and
  the webviews Tauri runs on do not do this consistently themselves. The six
  dialogs also share one focus-returning hook instead of six hand-rolled ones.

### Security

- A renderer-supplied agent binary is canonicalized and refused from temporary directories before the bridge spawns it. The native shell already resolves and injects the canonical path, so this closes the gap for direct invocations.
- Skill and plugin installation is gated behind a one-time native picker
  authorisation instead of trusting any renderer-nominated path.
- Workspace-grant capability handles are no longer written whole to stderr: git
  and grant events log a prefix, so anything reading the system log (crash
  reporters, `log show`, support bundles) cannot harvest a working grant id.
- The security audit log maps control characters to spaces, as the app log
  already did, so a renderer-chosen id cannot forge extra TSV columns.
- `skills list`, `skills enable` and `skills disable` now run through the same
  bounded, minimal-environment, process-grouped path as every other CLI call.
  They previously inherited the shell's full ambient environment, bypassing the
  filter that drops `NODE_OPTIONS`, `META_API_KEY` and similar.
- `bridge_request` no longer does typed validation, keyring and binary hashing,
  and a potentially blocking stdin write on the main thread, which is the
  window's event loop. Grant verification and revocation moved with it.
- An oversized protocol frame from a still-running bridge is skipped and the
  relay keeps reading, instead of tearing down the connection.
- Two concurrent pickers for the same folder can no longer mint two grants and
  lose one keyring entry; `listSessions` rows that name another workspace no
  longer bind under this grant; a `muse` binary inside an open workspace is
  refused; and a CLI call that outlives its ceiling is killed as a whole tree.
- ACP agents are sandboxed even without a workspace, so a session-less model
  listing cannot write outside the agent's own config and temp roots.
- Playwright raised to 1.63.1 (GHSA-7mvr-c777-76hp is dev-only but is now gone
  from the tree).

## [0.1.0] — unreleased

Initial internal build. No public release has been made; signing, notarisation
and the update feed are not yet in place (see `docs/RELEASING.md`).
