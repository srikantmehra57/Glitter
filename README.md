# Glitter

[![CI](https://github.com/srikantmehra57/Glitter/actions/workflows/ci.yml/badge.svg)](https://github.com/srikantmehra57/Glitter/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/srikantmehra57/Glitter)](LICENSE)

A native desktop app for coding agents. You chat with the agent, approve its
commands, set reasoning effort, and review its changes in one window.

> [!IMPORTANT]
> This is an independent open-source project, not affiliated with Meta. The Muse
> agent needs Meta's official `muse` CLI and a Muse Code subscription or API key.

## Overview

Glitter is for developers who want a focused GUI for long agent sessions. Its
built-in Harness agent calls the model provider you choose with your own API
key and runs its own tools, so no agent CLI has to be installed. Glitter also
drives external agent CLIs: Meta's `muse` CLI, which runs its own models,
tools, sessions and billing while the app starts `muse serve`, streams what the
agent is doing and sends your decisions back, and a few third-party agent CLIs
over the Agent Client Protocol (ACP).

Glitter was called Muse Code Desktop until the rename. On first launch it moves
an existing install's settings, threads, snapshots, logs and keychain entries
across; see [Upgrading from Muse Code Desktop](#upgrading-from-muse-code-desktop).

**Status: beta (0.1.0), unreleased.** The app is complete enough for daily use,
and every automated gate passes. It is built for macOS 13 or later only; there
are no Windows or Linux versions. No signed build has been published yet; see [Known limitations](#known-limitations).

## Features

- **Workspaces and threads.** Open local folders through the native picker.
  Pin, rename, search, archive and fork threads.
- **Live agent timeline.** Streaming messages, plans, tool calls with durations
  and output, subagents, background tasks and goals.
- **Approvals.** Write and edit calls show a diff preview, each choice explains
  its scope, approvals expire after 10 minutes, and there are keyboard shortcuts
  (`⌘Y`, `⌘⇧Y`, `⌘⌫`).
- **Composer.** Model, reasoning-effort and permission pickers. `@` file
  mentions from a workspace file index. Slash prompt macros. File and image
  attachments by picker or drag and drop. Steer or queue while a turn runs.
- **Changes dock.** Changed files and unified diffs from git. Stage, commit,
  and discard files or single hunks.
- **Agents.** Muse by default. OpenCode and Grok are verified. Gemini CLI, Qwen
  Code and Goose are experimental. All third-party agents are off until you
  enable them, and you can switch agents mid-thread.
- **Account.** In-app `muse login`, or an API key stored in the OS keychain.
  Choose subscription, API key or automatic billing.
- **Extensions and usage.** Manage skills, plugins and MCP servers, and see
  subscription usage, in Settings.
- **Desktop integration.** Native menu bar, command palette (`⌘K`), OS
  notifications, session export, Muse CLI update checks, light and dark themes
  with seven accents.

## Tech stack

| Layer | Technology |
|---|---|
| Native shell | Rust, Tauri 2 (OS webview, no bundled Chromium) |
| UI | React 19, TypeScript, Zustand, plain CSS with design tokens, lucide-react |
| Agent bridge | Node (bundled runtime), `@muse-code/sdk` 1.3.0 for MSP, ACP over stdio |
| Storage | Tauri store file for settings, OS keychain for secrets and workspace grants |
| Tests | `node:test`, Vitest + Testing Library, `cargo test` with Tauri's mock runtime |
| Website | Vite, three.js, Lenis (`apps/website`) |

## Architecture

```text
React UI ──invoke──▶ Rust shell ──NDJSON/stdio──▶ Node bridge ──▶ muse serve (MSP)
          ◀─events──            ◀──────────────               └─▶ ACP agent CLIs
```

The Rust shell is the trust boundary. It allowlists and type-checks every
request from the webview, authorizes file and git access through workspace
grants created by the folder picker, keeps credentials out of the renderer, and
verifies the bundled bridge before running it. Details are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository structure

```text
apps/
├── desktop/               The desktop app
│   ├── src/               React renderer
│   │   ├── components/    One file per UI surface (+ *.test.tsx DOM tests)
│   │   ├── lib/           Store, IPC, types, and pure helpers
│   │   └── test/          Vitest setup
│   └── src-tauri/         Rust shell: commands, IPC validation, grants, packaging config
└── website/               Marketing site (independent of the app)
packages/
└── glitter-bridge/        Node bridge: Muse (MSP) and ACP hosts, built-in harness, isolation, redaction
tests/                     Node test suite and fixtures (fake agents, stub bridge)
scripts/                   Release and verification scripts
docs/                      Architecture, development, agent guide, decisions, design, releasing
```

## Getting started

**Prerequisites:**

- Node.js 24 or newer (the DOM test tooling does not run on Node 20)
- Rust stable
- Git
- For live sessions only, the Muse CLI:

```bash
curl -fsSL https://dev.meta.ai/install.sh | sh
```

Then sign in with `muse` and `/login`, or add an API key later under
**Settings → Account**.

**Install and run:**

```bash
npm install
npm run dev          # native app with hot reload
npm run dev:ui       # UI only, in a browser, with mock data (no Rust or CLI needed)
```

**Build an unsigned bundle:**

```bash
npm run build        # apps/desktop/src-tauri/target/release/bundle/
```

The build may download a Node.js runtime from nodejs.org for the bridge sidecar
and verifies its SHA-256.

**Test:**

```bash
npm run verify       # every gate: versions, types, Node + DOM + native tests, a11y, contrast, audit, build
```

### Environment variables

None are required. Settings are stored by the app, and secrets go in the OS
keychain. The optional development and signing variables are listed in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#environment-variables).

## Development workflow

| Command | Purpose |
|---|---|
| `npm run dev` / `dev:ui` / `dev:website` | Run the app, the UI preview, or the site |
| `npm run typecheck` | TypeScript for the bridge and the UI |
| `npm test` · `npm run test:ui` · `npm run test:native` | Node, DOM and Rust tests |
| `npm run verify` | All gates, in sequence (what CI runs) |
| `npm run clean` | Remove build output |

Run the heavy suites one at a time. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
for debugging, adding features and settings, and common pitfalls.

## Architecture principles

- The CLI is the source of truth. The app never simulates agent behavior.
- The renderer is untrusted. Privileged work is authorized in Rust, behind an
  allowlisted verb with a typed DTO, or a dedicated command that takes a
  workspace grant.
- Secrets live only in the OS keychain.
- Third-party agents are opt-in and isolated.
- One implementation per concern: one store, one IPC module, one design-token
  set.

Coding agents should start with [AGENTS.md](AGENTS.md).

## Known limitations

- **No published release.** Builds are unsigned and not notarized, so
  Gatekeeper blocks them on other Macs. There's no auto-updater. See
  [docs/RELEASING.md](docs/RELEASING.md).
- **macOS only.** There are no Windows or Linux builds, and CI runs on macOS
  only. Some platform code for them remains in the source but is not built
  or tested.
- **Coverage gaps.** Native dialogs (folder picker, save panel) and a live,
  authenticated end-to-end session aren't covered by automated tests;
  `scripts/live-muse-smoke.mjs` is a manual check.
- **Experimental agents.** Gemini CLI, Qwen Code and Goose aren't verified.
- **Large modules.** `apps/desktop/src/lib/store.ts` (~4.4k lines) and
  `src-tauri/src/lib.rs` (~7.4k lines, tests included) hold most of the logic.
  The startup script is the app itself. The terminal and syntax highlighter
  load later, and `scripts/check-chunks.mjs` fails the build if they move back
  into that script.
- **Leftover data.** Uninstalling leaves local data behind (see below).

## Uninstall

Removing the app doesn't delete its local data.

| Data | Location |
|---|---|
| Settings and workspace metadata | `~/Library/Application Support/com.glitter.desktop/glitter.json` |
| Built-in harness threads, turn snapshots and worktrees | `~/Library/Application Support/com.glitter.desktop/` |
| Application and security logs | `~/Library/Logs/com.glitter.desktop/` |
| Credentials and workspace grants | Keychain service `com.glitter.desktop` |

Session history for the Muse CLI and ACP agents stays in each CLI's own data
directory.

## Upgrading from Muse Code Desktop

The app's bundle identifier changed from `com.musecode.desktop` to
`com.glitter.desktop`, which renames its data folder, log folder and keychain
service. Quit Muse Code before you first open Glitter. On that first launch
Glitter:

- moves the settings file (renamed `glitter.json`), built-in harness threads and
  turn snapshots into its own data folder, and the logs into its log folder;
- copies each keychain entry (API key, provider keys, workspace grants, agent
  pins, ACP consent) to the new service, then deletes the old one. macOS may ask
  once per entry whether Glitter can read it; choose **Always Allow**.

Worktrees made by Muse Code stay in
`~/Library/Application Support/com.musecode.desktop/worktrees/`, because git and
each agent's session history record their paths. They keep working, and the old
folder is removed once the last of them is. Their branches keep the `muse/`
prefix; new worktrees use `glitter/`. A step that fails is retried on the next
launch. Move `/Applications/Muse Code.app` to the Trash afterwards.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): processes, trust boundary, data flow, module map
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): setup, commands, testing, debugging, conventions
- [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md): rules and workflow for AI agents and new contributors
- [docs/DECISIONS.md](docs/DECISIONS.md): architectural decision log
- [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md): tokens, typography, copy, component behavior
- [docs/RELEASING.md](docs/RELEASING.md): versioning, signing, packaging, rollback
- [CHANGELOG.md](CHANGELOG.md) · [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) · [apps/website/README.md](apps/website/README.md)

## License

[MIT](LICENSE). Third-party attributions are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
