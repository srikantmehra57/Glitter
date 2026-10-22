# Agent guide

This guide is for AI coding agents and the engineers working with them. Read it
before changing anything. [ARCHITECTURE.md](ARCHITECTURE.md) has the full system
picture, [DEVELOPMENT.md](DEVELOPMENT.md) the commands, and
[DECISIONS.md](DECISIONS.md) the reasoning behind the current design.

## What this is

Glitter is an independent, MIT-licensed desktop app for coding agents. It
began as Muse Code Desktop, a GUI for Meta's `muse` coding-agent CLI, and can
also drive a few third-party agent CLIs over ACP. Users open a workspace folder,
chat with the agent in threads, approve or deny its tool calls, set the model
and reasoning effort, and review the resulting git changes. For Muse and the
ACP agents, all agent work is done by the CLI and the app is the client.

**Naming.** The product is Glitter. "Muse" (and "Muse Code", Meta's name for
its CLI and subscription) names Meta's agent and everything that talks to it:
the Muse agent, `host.ts`, `museBin`/`museApiKey`, auth and detection copy,
`@muse-code/sdk`. Keep those as they are and use Glitter for the app itself.
Builds before the rename used the bundle id `com.musecode.desktop`; `legacy.rs`
carries their data over (see "The product is called Glitter" in
[DECISIONS.md](DECISIONS.md)).

**Direction.** The app is becoming an independent agent harness. Its built-in
Harness agent (`packages/glitter-bridge/src/harness`) calls model providers with
the user's own keys and runs its own tool loop, so no agent CLI has to be
installed; Muse and the ACP agents stay supported alongside it. See "The app
has its own agent harness" in [DECISIONS.md](DECISIONS.md). The next milestones
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
| Theme, accent, sidebar tint and translucency | `lib/theme.ts` (`resolveTheme`), `applyTheme` in `store.ts`, the token blocks in `styles.css`, native `set_window_appearance` in `lib.rs` and the window in `tauri.conf.json` |
| A keyboard shortcut | an entry in `lib/shortcuts.ts` and its action in `runShortcut` (`App.tsx`); add a native menu item in `lib.rs` only if it needs one |
| Browser-preview mock data | `apps/desktop/src/lib/mock.ts` + `mockBridge` in `bridge.ts` |
| A native command, git, files, dialogs, grants, logging | `apps/desktop/src-tauri/src/lib.rs` |
| Per-turn file snapshots, retention, Undo and Reapply | `apps/desktop/src-tauri/src/snapshots.rs` |
| Per-thread worktrees and their derived grants | `apps/desktop/src-tauri/src/worktrees.rs`, `git_worktree_*` in `lib.rs`, `threadScope` / `activeWorkspace` in `store.ts` |
| The Files tab and read-only viewer | `FilesPanel.tsx`, `lib/fileTree.ts`, native `read_workspace_file` in `lib.rs` |
| Branches, push and pull requests | `BranchMenu.tsx`, `ReviewDock.tsx`, native `git_branches` / `git_switch` / `git_push` / `git_pull_request` in `lib.rs` |
| Diff line comments | `lib/lineComments.ts`, `DiffLines.tsx`, `sendLineComments` in `store.ts` |
| The terminal pane | `TerminalPane.tsx`, native `terminal.rs` and `terminal_*` commands in `lib.rs` |
| Review scopes and their grant-scoped reads | `ReviewDock.tsx`, `lib/diff.ts`, native `git_review` in `lib.rs` (+ `snapshots.rs` for Last turn) |
| Validation for a bridge method | `apps/desktop/src-tauri/src/dto.rs` + `BRIDGE_METHODS` in `lib.rs` |
| Executable or agent binary trust | `apps/desktop/src-tauri/src/exec.rs` |
| Keychain | `apps/desktop/src-tauri/src/credentials.rs` |
| Carrying a Muse Code install over (data, logs, keychain, old worktrees) | `apps/desktop/src-tauri/src/legacy.rs`, `legacy_worktree_store` in `lib.rs` |
| Native permissions granted to the webview | `apps/desktop/src-tauri/capabilities/default.json` |
| Muse protocol behavior | `packages/glitter-bridge/src/host.ts` |
| Third-party (ACP) agents | `packages/glitter-bridge/src/acp.ts`, registry in `agents.ts` |
| The built-in harness agent | `packages/glitter-bridge/src/harness/` (providers, wire, tools, registry, store, host) |
| Harness permissions: read-only commands, risky and blocked commands, thread grants, the Autonomous mode | `packages/glitter-bridge/src/harness/permission/` (`classify.ts`, `danger.ts`, `grants.ts`, `policy.ts`, `guards.ts`, over the `shell.ts` reader) |
| Harness skills: discovery, the catalog in the prompt, the `skill` tool, `/name` | `packages/glitter-bridge/src/harness/skills.ts`; the app side is `supportsSkills` in `store.ts` and `ExtensionsView.tsx` |
| Harness MCP: config, transports, all-or-nothing sync, deferred tools | `packages/glitter-bridge/src/harness/mcp.ts`; the app side is `harnessMcp` in `store.ts` and the agent-aware MCP section in `ExtensionsView.tsx` |
| The plan review that ends Plan mode | `EXIT_PLAN_TOOL` and `planSettlement` in `harness/questions.ts`; `PlanReviewCard.tsx`, picked in `UserInputCards.tsx` |
| Harness questions (`ask_user`): the tool, the durable pending question, answers | `packages/glitter-bridge/src/harness/questions.ts`; `parkQuestion`, `settleQuestion` and `respondUserInput` in `harness/host.ts` |
| The usage record, its bounds, and the per-call Trajectory | `apps/desktop/src/lib/usageLedger.ts` (stored shape, compaction, `MAX_TURN_CALLS`), `UsageView.tsx`; Harness calls arrive as `modelCall` events and land in the entry's `calls` |
| A harness tool, prompt section or hook | an `Extension` registered on `ExtensionRegistry` (`harness/registry.ts`); built-in tools are `BUILTIN_TOOLS` in `harness/tools.ts` |
| Provider keys (BYOK) | `credentials.rs` (`provider_key_set`, `provider_keys_get`), Settings → Providers (`ProvidersPanel.tsx`, `lib/providers.ts`) |
| Bridge request routing | `packages/glitter-bridge/src/index.ts` |
| Child-process isolation, redaction | `packages/glitter-bridge/src/isolation.ts`, `redaction.ts` |
| Types shared by the bridge and UI | `packages/glitter-bridge/src/protocol.ts` |
| Node or DOM tests | `tests/*.test.mjs`, `apps/desktop/src/components/*.test.tsx` |
| Release and verification scripts | `scripts/`, `packages/glitter-bridge/scripts/` |
| Marketing site | `apps/website/` (independent of the app) |
| Harness work in progress | [HARNESS_INTEGRATION_PLAN.md](HARNESS_INTEGRATION_PLAN.md) — phased plan; [HARNESS_REVIEWS.md](HARNESS_REVIEWS.md) — what the four reviewed harnesses do and why |

## Rules to preserve

1. **The agent is the source of truth.** Show what the agent (a CLI, or the
   built-in harness's own session log) reports. Never
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
4. **Third-party agents stay opt-in.** Default-off, consent-gated,
   digest-pinned, sandboxed where possible.
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
- Follow [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) for tokens, spacing, copy and
  terminology.

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
