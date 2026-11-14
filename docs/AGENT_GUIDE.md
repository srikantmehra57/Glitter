# Agent guide

This guide is for AI coding agents and the engineers working with them. Read it
before changing anything. [ARCHITECTURE.md](ARCHITECTURE.md) has the full system
picture, [DEVELOPMENT.md](DEVELOPMENT.md) the commands, and
[DECISIONS.md](DECISIONS.md) the reasoning behind the current design.

## What this is

Glitter is an independent, MIT-licensed desktop app for coding agents. It
began as Muse Code Desktop, a GUI for Meta's `muse` coding-agent CLI. Users
open a workspace folder, chat with the built-in agent in threads, approve or
deny its tool calls, set the model and reasoning effort, and review the changes.

**Naming.** The product is Glitter and its built-in agent is Harness. Builds
before the rename used the bundle id `com.musecode.desktop`; `legacy.rs`
carries their data over (see "The product is called Glitter" in
[DECISIONS.md](DECISIONS.md)).

**Direction.** Harness (`packages/glitter-harness/src/harness`) calls model
providers with the user's own keys and runs its own tool loop. Glitter no longer
starts Muse or ACP agent CLIs; their existing histories stay in those CLIs'
storage. See "Harness is the only agent runtime" in [DECISIONS.md](DECISIONS.md). The next milestones
are signed releases, live end-to-end coverage, and splitting the two largest
files (see the README's known limitations).

## Where things live

| You need to change… | Look in |
|---|---|
| A UI surface | `apps/desktop/src/components/<Surface>.tsx` (+ `styles.css` / `settings.css`) |
| App state or an action | `apps/desktop/src/lib/store.ts` (one Zustand store, `useAppStore`) |
| A call from the UI to native code or the agent | `apps/desktop/src/lib/bridge.ts` |
| Domain types, default settings | `apps/desktop/src/lib/types.ts` |
| Pure logic (formatting, parsing, diffing, effort tiers) | `apps/desktop/src/lib/*.ts` |
| A command shared by slash, the palette and shortcuts | `apps/desktop/src/lib/commands.ts` (`runBuiltinCommand`, `openPicker`), names in `lib/composerText.ts` |
| Thread-menu support actions | `apps/desktop/src/lib/threadActions.ts`, `lib/store.ts` (unread and trajectory state), `UsageView.tsx`, native `support_paths` / `open_config_file` in `lib.rs` |
| Theme, typography and display preferences | `lib/fonts.ts` (installed faces), `lib/theme.ts` (`resolveTheme`), `applyTheme` in `store.ts`, `lib/zoom.ts` (native scaling), `lib/presence.ts` (`motionReduced`), the token blocks in `styles.css`, native `set_window_appearance` in `lib.rs` and the window in `tauri.conf.json` |
| A keyboard shortcut | an entry in `lib/shortcuts.ts` and its action in `runShortcut` (`App.tsx`); add a native menu item in `lib.rs` only if it needs one |
| Browser-preview mock data | `apps/desktop/src/lib/mock.ts` + `mockBridge` in `bridge.ts` |
| A native command, git, files, dialogs, grants, logging | `apps/desktop/src-tauri/src/lib.rs` |
| Per-turn file snapshots, retention, Undo and Reapply | `apps/desktop/src-tauri/src/snapshots.rs` |
| Per-thread worktrees and their derived grants | `apps/desktop/src-tauri/src/worktrees.rs`, `git_worktree_*` in `lib.rs`, `threadScope` / `activeWorkspace` in `store.ts` |
| The Files view and read-only viewer | `FilesPanel.tsx`, `lib/fileTree.ts`, native `read_workspace_file` in `lib.rs` |
| Branches, commits, push, history and pull requests | `BranchMenu.tsx`, `CommitDialog.tsx`, `GitGraphPanel.tsx`, `ReviewDock.tsx`, native `git_branches` / `git_switch` / `git_commit` / `git_push` / `git_graph` / `git_pull_request` in `lib.rs` |
| Diff line comments | `lib/lineComments.ts`, `DiffLines.tsx`, `sendLineComments` in `store.ts` |
| The terminal pane | `TerminalPane.tsx`, native `terminal.rs` and `terminal_*` commands in `lib.rs` |
| Shared browser control | `BrowserPane.tsx`, `lib/browser.ts`, `browser-types.ts` and `browser.ts` in the bridge, the Harness `browser` extension, `browserOpen` / `browserControl` / `browserClose` in `index.ts`, `dto.rs` and `BRIDGE_METHODS` |
| Review scopes and their grant-scoped reads | `ReviewDock.tsx`, `lib/diff.ts`, native `git_review` in `lib.rs` (+ `snapshots.rs` for Last turn) |
| Validation for a bridge method | `apps/desktop/src-tauri/src/dto.rs` + `BRIDGE_METHODS` in `lib.rs` |
| Executable trust | `apps/desktop/src-tauri/src/exec.rs` |
| Keychain | `apps/desktop/src-tauri/src/credentials.rs` |
| Carrying a Muse Code install over (data, logs, keychain, old worktrees) | `apps/desktop/src-tauri/src/legacy.rs`, `legacy_worktree_store` in `lib.rs` |
| Native permissions granted to the webview | `apps/desktop/src-tauri/capabilities/default.json` |
| The built-in harness agent | `packages/glitter-harness/src/harness/` (providers, wire, tools, registry, store, host) |
| Harness context compaction | `harness/compaction.ts` (summary and preserved request), `compactLive` / `compactSession` and `runStageLoop` in `harness/host.ts`, the append-only projection in `harness/store.ts`, `compactThread` in `store.ts`, and the composer context card / `/compact` |
| Harness web tools: `web_fetch`, keyed `web_search`, untrusted page text | `packages/glitter-harness/src/harness/web.ts`, registered as `webExtension` in `harness/host.ts`; the app side is `SEARCH_PROVIDERS` in `lib/providers.ts` and the Web search card in `ProvidersPanel.tsx`, with `SEARCH_PROVIDER_IDS` in `credentials.rs` fixing each key to its own provider |
| Harness background shells | `packages/glitter-harness/src/harness/shells.ts` (`startShell`, `readShell`, `killShell`, `stopSessionShells`, `stopAllShells`; the watchdog process that kills their process groups if the agent is killed outright; exited shells are pruned), the `bash_output` and `kill_shell` tools in `harness/tools.ts`, and teardown in `harness/host.ts`. The foreground shell tool ends on process exit, not pipe close (`shellTool`), and `terminateTree` in `isolation.ts` also signals descendants outside the process group |
| Writable package-manager caches (shell and stdio MCP) | `packageCacheRules` in `packages/glitter-harness/src/isolation.ts`: cache subdirectories, exact Cargo lock/bookkeeping files and create-only parent directories; never resolve cache symlinks into new grants. Policy: "Package managers share bounded writable caches" in `DECISIONS.md`; real npm/Cargo/MCP fixtures in `tests/sandbox-integration.test.mjs` |
| File tools and search: read, edit, write, `grep`, `list_files` | `harness/tools.ts` (`decodeText`/`loadEditable` refuse binary, non-UTF-8 and over-8 MB files, `matchEndings` for CRLF, the `grep` search worker with its deadline), `harness/ignore.ts` (`.gitignore` for the search tools), and `htmlToText` in `harness/web.ts` (one linear pass; keep it that way) |
| Containing failures: unawaited saves, turn start and end, the end of a turn | `contained`, `saveFailed`, `guardTurn`, `abandonTurn` and the `finally` of `runTurn` in `harness/host.ts`; never leave a promise unhandled, because the agent process is shared by every thread |
| Harness permission rules: persistent `Tool(pattern)` allow and deny lists | `packages/glitter-harness/src/harness/permission/rules.ts` (`parseRule`, `compileRules`), the `rules` guard and merged grants in `harness/host.ts`, the `harnessRules` method in `index.ts` with native validation in `dto.rs`; the app side is `harnessRules` in `lib/types.ts`, `lib/permissionRules.ts` for native limits, serialized `applyHarnessRules` in `store.ts` (on save and before starting or continuing Harness work, reset on bridge exit) and `PermissionRulesCard.tsx` in Settings → Permissions. An allow rule is a grant and never lifts a risky ask, a block, Plan mode or Read only; a deny rule is a guard rechecked before execution in every mode. A path rule is deny-only and covers built-in edits, not shell commands |
| Permissions: Ask, Auto and Full access | `apps/desktop/src/lib/types.ts` (`APPROVAL_ORDER`) and `packages/glitter-harness/src/harness/permission/` (`classify.ts`, `danger.ts`, `grants.ts`, `policy.ts`, `guards.ts`); the approval keyboard shortcuts (⌘Y, ⇧⌘Y, ⌘⌫) are in `useDesktopShortcuts` in `App.tsx`, guarded by `lib/approvalShortcut.ts` (no key repeat, an allow waits for its card to be in view) |
| Protected files: edits ask every time, the shell cannot write them | `harness/permission/protected.ts` (defaults, matcher, seatbelt rules), the ask in `policy.ts`, `buildSeatbeltProfile` in `isolation.ts`, `setPermissionRules` in `harness/host.ts`; the app side is `protectedPaths` in `lib/types.ts`, the mirrored defaults in `lib/permissionRules.ts`, `applyHarnessRules` in `store.ts`, `ProtectedPathsCard` in `PermissionRulesCard.tsx`, native validation in `dto.rs`. `.git` is refused by `gitControlGuard` in `guards.ts` |
| Harness skills: discovery, the catalog in the prompt, the `skill` tool, `/name` | `packages/glitter-harness/src/harness/skills.ts` (`discoverSkills` takes the workspace's trust: a workspace's own skills are read only when trusted); the app side is `supportsSkills` in `store.ts` and `ExtensionsView.tsx` |
| Workspace trust: whether a repository's own rules and skills reach the model | The decision is the native record in `apps/desktop/src-tauri/src/mcp_consent.rs` (`workspace_trust_set`, `inject`, which also lets a worktree follow its source workspace through `worktree_origin` in `lib.rs`), set from the app by `setWorkspaceTrust` in `lib/bridge.ts` (`confirmTrust`, `untrustWorkspace` and `mirrorWorkspaceTrust` in `store.ts`, `TrustModal.tsx`). It arrives as `workspaceTrusted` on every session verb and is read per turn through `workspaceTrusted(live)` in `harness/host.ts` into `TurnContext`, which gates `AGENTS.md`/`CLAUDE.md` in `systemPrompt`, `nestedRules` and the skills extension. The CLI starts untrusted; `--trust` (`cli/args.ts`, `cli.ts`) sets it |
| Harness MCP: config, transports, all-or-nothing sync, deferred tools, adding and removing servers | `packages/glitter-harness/src/harness/mcp.ts` (`readMcpConfig`, `addMcpServer`, `removeMcpServer`); `mcpConfig`, `addMcpServer`, `removeMcpServer` in `harness/host.ts`; the app side is `harnessMcpConfig` and `addHarnessMcpServer` / `removeHarnessMcpServer` in `store.ts`, `lib/mcpConfig.ts` for parsing what the form collects, and the agent-aware MCP section in `ExtensionsView.tsx`. Native digest-bound startup review uses `reviewMcp` / `consentMcp` in `lib/bridge.ts` and `mcp_consent.rs`; redacted rows remain visible while startup is denied |
| The bundled extension store: curated skills, MCP servers and skill bundles, installed in one click with no CLI or network | `apps/desktop/src-tauri/src/catalog.rs` (the catalog, its writer and ownership markers) with `catalog_list` / `catalog_install` / `catalog_remove` in `lib.rs`, the skill text in `apps/desktop/src-tauri/catalog/skills/`. Every `npx`/`uvx` launcher names an exact release (`pinned_package`; a test refuses an unpinned one) because MCP approval binds to the configuration text. The app side is `catalogEntries` + `installCatalogEntry` / `removeCatalogEntry` in `store.ts` and `ExtensionsStore.tsx` (Discover, which also lists sources' plugins) |
| Harness delegation: the `task` tool, hidden child sessions, stamped depth and policy | `packages/glitter-harness/src/harness/delegation.ts`; `delegate` and `readChildSession` in `harness/host.ts`; the app side is `openChild` in `store.ts` and the read-only branch in `AgentTimeline.tsx` |
| Harness Orchestrator (opt-in): settings, per-turn routing, staged Lead-guided execution, consults, Plan-mode review, route facts and handoff items | `packages/glitter-harness/src/harness/orchestrator/`: closed router assessments and handoffs, pure pre-route/policy functions, route records, capability probes, the bounded neutral transcript, the fixed stage prompts (`prompts.ts`, including the tool-less and read-enabled Lead plan variants), the Builder's `ask_lead` contract (`consult.ts`), the deterministic stuck signals (`stuck.ts`), the Plan-mode review/restore helpers (`plan-mode.ts`), the internal tuning contract (`tuning.ts`), the shared read-only tool set (`read.ts`) and the Scout contract (`scout.ts`); `runReadOnlyStage` and `orchestratorReadProbe` in `harness/host.ts` back the scout/Lead-read stages; `orchestratorProbe` in `harness/host.ts` runs a role's fixed check and caches it, and `resolveTurnRoute` / `runRouterCall` / `ensureRoleProbes` / `executionStage` decide each turn's route and role before it runs; `runLeadGuided` runs the Lead plan, Builder build, consult, optional review/repair and takeover, with `runStageLoop` for each tool stage and `auxiliaryCall` for the off-history plan, consult and review calls; request images reach the Lead plan/read/review while the Builder works from the neutral plan and an attachment vision floor blocks text-only roles that would receive them; `store.ts` saves each route with its turn and the Lead and per-plan Builder role sessions; `resumeSession` replays routes and restores both role sessions; deterministic coverage in `tests/orchestrator.test.mjs`, `tests/harness.test.mjs` and `tests/bridge-dispatch.test.mjs`; the app starts a session with `orchestratorStart` (`lib/orchestrator.ts`) in `store.ts`, keeps each `route` event in the Thread's per-turn map (`lib/bridge.ts`, `lib/types.ts`), and labels the live line, receipts and Usage calls through `lib/orchestrator.ts`; a live thread switches modes through `setOrchestrator` (`harness/host.ts`, with dispatch in `lib/bridge.ts` and native validation in `dto.rs`), which stashes the manual model and effort for the switch back; the composer's `ModelPicker` carries the switch, `GoalPicker.tsx` the goal and per-message shape, and `sendPrompt` forwards that shape as `forcedShape` through the native DTO to `TurnRequest.forcedShape`; settings render in `OrchestratorPanel.tsx` with normalization in `lib/settingsPersistence.ts`; native start validation in `dto.rs`; route metadata in the browser preview's usage fixtures (`lib/mock.ts`); product decision in `docs/DECISIONS.md`; remaining Orchestrator work in `docs/REMEDIATION_PLAN.md` |
| Orchestrator evaluation (opt-in): corpus with tune/holdout splits and vision/long-context fixtures, configs, cost-capped runner, pre-route matrix, report comparison with manual `scores.json` | `evals/orchestrator/README.md`, `corpus.mjs`, `checks.mjs`, `configs.mjs`, `pre-route.mjs`, `run.mjs`; `--validate`, `--list`, `--dry`, `--check-host` and `--pre-route` are free, while live runs need provider keys and `--yes`; deterministic corpus/check/policy coverage in `tests/eval-corpus.test.mjs` and `tests/orchestrator.test.mjs`; not part of `npm run verify` |
| Harness baseline evaluation (opt-in): synthetic coding fixtures, conformance observations and bounded/redacted live runs | `evals/harness/README.md`, `corpus.mjs`, `conformance.mjs`, `budget.mjs`, `core.mjs`, `probes.mjs` and `run.mjs`; `--probes` exercises both wire families with scripted streams and no provider; shared fixture setup and pricing use `evals/orchestrator/checks.mjs` and `configs.mjs`; deterministic coverage is in `tests/harness-eval.test.mjs`. Live runs need explicit model, environment credentials, price bounds and `--yes` |
| The plan review that ends Plan mode | `EXIT_PLAN_TOOL` and `planSettlement` in `harness/questions.ts`; `PlanReviewCard.tsx`, picked in `UserInputCards.tsx` |
| Harness questions (`ask_user`): the tool, the durable pending question, answers | `packages/glitter-harness/src/harness/questions.ts`; `parkQuestion`, `settleQuestion` and `respondUserInput` in `harness/host.ts` |
| The usage record, its bounds, the year map and trend, and the per-call Trajectory | `apps/desktop/src/lib/usageLedger.ts` (stored shape, compaction, `MAX_TURN_CALLS`), `lib/usageChart.ts` (year map, streaks, trend), `UsageView.tsx`; Harness calls arrive as `modelCall` events and land in the entry's `calls` |
| A harness tool, prompt section or hook | an `Extension` registered on `ExtensionRegistry` (`harness/registry.ts`); built-in tools are `BUILTIN_TOOLS` in `harness/tools.ts` |
| Provider keys (BYOK) | `credentials.rs` (`provider_key_set`, `provider_keys_get`), Settings → Providers (`ProvidersPanel.tsx`, `lib/providers.ts`) |
| Custom endpoints (named, typed, unlimited) | the keychain mints ids in `credentials.rs` (`custom` is the create sentinel); the bridge resolves them in `harness/providers.ts` (`resolveProvider`); the app lists them from `providerStatus` in `store.ts` via `customProviders` in `lib/providers.ts` |
| Settings pages: names, groups, the line under each title, search words | `lib/settingsNav.ts`, read by `SettingsModal.tsx` (a full-window page) and the command palette |
| The model picker: providers, then models | `ModelPicker.tsx` (and `SourceRail` in `AgentPicker.tsx`); a model from another agent's provider goes through `chooseAgentModel` in `store.ts` |
| Models switched off in the picker | `lib/modelVisibility.ts` (`hiddenModels` in Settings), the switches in `ModelLibrary.tsx` (Settings → Models) |
| Testing a model's reply | `testModel` in `harness/host.ts`, the `testModel` bridge verb (`index.ts`, `dto.rs`, `BRIDGE_METHODS`), `testModel` in `store.ts` |
| Plugins and marketplaces from GitHub: fetch, preview, install, enable, update, remove, sources | `apps/desktop/src-tauri/src/plugins.rs` (source parsing, the staged git fetch, Claude Code/Codex/skills detection, ownership markers, records under `~/.glitter/plugins` and `~/.glitter/marketplaces`) with `github_*`, `library_*` and `marketplace_*` in `lib.rs` (`plugin_git` hardens git); the app side is `githubInspect` and friends in `lib/bridge.ts` (preview answers in `lib/mock.ts`), `library` and its actions in `store.ts`, `lib/pluginLibrary.ts` (source reading, Discover rows, featured repositories), `GithubInstallDialog.tsx`, `PluginLibrary.tsx` (Installed and Sources) and the tabs in `ExtensionsView.tsx`; see "Plugins install from GitHub" in DECISIONS.md |
| Extension thumbnails | `lib/extensionArt.ts` (icon and tint per id, name or category) and `ExtensionThumb.tsx` (logo or avatar image, corner badge) |
| Bridge request routing | `packages/glitter-harness/src/index.ts` |
| The `glitter` terminal CLI: arguments, shared credentials and defaults, rendering | `packages/glitter-harness/src/cli.ts` and `src/cli/` (`args.ts`, `config.ts`, `render.ts`); launcher in `scripts/install-cli.mjs`; tests in `tests/cli.test.mjs` |
| Child-process isolation, redaction | `packages/glitter-harness/src/isolation.ts` (`buildSeatbeltProfile`: write roots, protected paths, git control files, `networkOff` for offline commands, `credentialRoots` and `sessionLogRoots` for reads), `redaction.ts`; the real-seatbelt cases are in `tests/sandbox-integration.test.mjs` (`npm run test:sandbox`) |
| Toolchain PATH and inherited environment | `extra_bin_dirs_for` / `nvm_default_bin` in native `lib.rs` (standard and inherited absolute roots; bounded nvm aliases, no shell startup), `BASE_ENV` in native `process.rs` and `BASE_ENV_KEYS` in `isolation.ts` (matching allowlists, checked in `tests/isolation.test.mjs`); setup and limits in `DEVELOPMENT.md` |
| Types shared by the bridge and UI | `packages/glitter-harness/src/protocol.ts` |
| Node or DOM tests | `tests/*.test.mjs`, `apps/desktop/src/components/*.test.tsx` |
| Release and verification scripts | `scripts/`, `packages/glitter-harness/scripts/` |
| Marketing site | `apps/website/` (independent of the app) |
| Harness work in progress | [REMEDIATION_PLAN.md](REMEDIATION_PLAN.md) — the single source of truth for audit fixes and the delivery roadmap |

## Rules to preserve

1. **The agent is the source of truth.** Show what the harness's own session
   log reports. Never
   simulate agent output, invent reasoning, or duplicate session storage.
2. **The renderer is untrusted.** Anything touching the filesystem, processes or
   credentials is authorized in Rust.
   - New bridge verbs need an allowlist entry and a strict DTO.
   - New OS access needs a dedicated command that takes a workspace grant, never
     a raw path.
   - Don't add webview capabilities to `capabilities/default.json` unless the
     renderer really calls that plugin API.
3. **Secrets stay native.** API keys live in the OS keychain. The renderer only
   ever sees a mask. Logs go through the redactors.
4. **External tools stay scoped.** MCP servers require trust and are subject to
   the harness permission pipeline; do not start unreviewed workspace commands.
5. **One implementation per concern.** One store, one IPC module (`bridge.ts`),
   one logger, one redaction policy per process, and one design-token set
   (`styles.css`). Extend these; don't add parallel ones.
6. **The browser preview keeps working.** A new bridge call needs a mock answer,
   so `npm run dev:ui` and the website screenshot script still run.
7. **Versions move together.** Six manifests. Run `npm run check:versions`.
8. **Accessibility is gated.** Icon-only buttons need `aria-label`, dialogs need
   names, and color pairs must pass WCAG AA (`npm run check:a11y`,
   `npm run check:contrast`).

## Preferred style

- Reuse existing primitives before creating new ones: `SelectMenu`,
  `ConfirmDialog` (via `store.confirm`), `ErrorBoundary`, `classifyError` and
  `describeError` (for anything shown to the user), `log`, and the `lib/*`
  helpers.
- Keep pure logic in `lib/` with no React or Tauri imports, so `tests/` can
  bundle and test it.
- Subscribe to the store with `useShallow` selectors. Avoid whole-store
  subscriptions.
- Keep code boring and explicit. Comments explain *why*, not *what*.
- Keep diffs focused. Don't reformat or rename code you aren't changing.
- Strict types: no `any`, `@ts-ignore` or blanket `as` casts to get past an
  error.
- Follow [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) for tokens, the type scale,
  spacing, copy and terminology. It is the one place design is decided: a change
  to a design decision updates it in the same commit.

## Workflow

**Before you implement:**

1. Read the existing implementation and its tests. Many behaviors are pinned by
   tests that read source as text (`tests/regressions.test.mjs`,
   `tests/ui-copy.test.mjs`). A failure there usually means you broke an
   intended invariant, not that the test is stale.
2. Find the related modules on every layer: component, store, `bridge.ts`, Rust
   command or DTO, bridge host.
3. Decide whether the change crosses the trust boundary. If it does, design the
   native side first.

**Before you create a file:** check whether that responsibility already exists.
The tables above cover most of them.

**Before you add a dependency:** check whether the platform or an existing
dependency already does the job. Shipped dependencies need a
`THIRD_PARTY_NOTICES.md` row.

**Before an architectural change:** read [DECISIONS.md](DECISIONS.md) and the
comments at the site. Most odd-looking code is a security or ordering
constraint. Record new decisions there.

**Validate** with the narrowest checks that cover the change, then
`npm run verify` before you hand off:

- `npm run typecheck`
- `npm test`
- `npm run test:ui`
- `npm run test:native` (after `build:bridge` and `build:ui`)

**Update docs** only when the architecture, commands or conventions change.
User-visible changes go in `CHANGELOG.md` under `[Unreleased]`.

## Never

- Add a duplicate implementation of something that exists.
- Create root-level reports, plans, audit notes or scratch files. Put durable
  knowledge in `docs/` and everything else in the PR description.
- Leave temporary scripts, logs, screenshots or dumps in the repo.
- Commit credentials, tokens, certificates or `.env` files.
- Bypass types, or disable lint, tests or checks, to get a green run.
- Delete code just because static search finds no reference. Check dynamic
  imports, Tauri command names, string-based tests and scripts first.
- Leave commented-out code.
- Introduce a new framework or state library without a recorded decision.
- Redesign unrelated areas during a small task.
- Run `node --test` and `cargo test` at the same time. They starve each other
  and fail spuriously.
