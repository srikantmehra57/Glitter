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
built-in **Harness** agent calls the model provider you choose with your own API
key and runs its own tools in your workspace, so no agent CLI has to be
installed — a hosted provider, an OpenAI-compatible or Anthropic endpoint you
name yourself, or a model served on this Mac by Ollama or LM Studio.

Glitter also drives external agent CLIs: Meta's `muse` CLI, which runs its own
models, tools, sessions and billing while the app starts `muse serve`, streams
what the agent is doing and sends your decisions back, and third-party agent
CLIs over the Agent Client Protocol (ACP).

New threads use Harness once it has a key, and Muse when that's what's ready;
you can set a different default and switch agents mid-thread.

Glitter was called Muse Code Desktop until the rename. On first launch it moves
an existing install's settings, threads, snapshots, logs and keychain entries
across; see [Upgrading from Muse Code Desktop](#upgrading-from-muse-code-desktop).

**Status: beta (0.1.0), unreleased.** The app is complete enough for daily use,
and every automated gate passes. It is built for macOS 13 or later only; there
are no Windows or Linux versions. No signed build has been published yet; see [Known limitations](#known-limitations).

## Features

- **A built-in agent that needs no CLI.** Harness reads, searches and edits files
  in the workspace and runs commands under the OS sandbox. It works in Plan mode
  and ends a plan with your approval, asks you questions when it needs a
  decision, keeps a checklist it updates as it works, hands subtasks to
  subagents, and uses skills and MCP servers. Its threads stay on this Mac, and
  a key leaves it only in the request to the provider that issued it.
- **A shared Browser for UI verification.** Harness can open a local dev server
  or another http(s) page, inspect accessibility refs and console errors,
  navigate, click, fill forms and capture screenshots it can see. The Browser
  side panel shows the same fresh Chromium page and lets you navigate and take
  control. It is separate from your normal browser profile, streams only while
  visible, and closes with its workspace grant. Browser control asks per web
  origin in Ask and Auto; inspection stays available in Plan mode.
- **Providers, endpoints and models.** Thirteen providers are built in —
  Anthropic, OpenAI, Google Gemini, OpenRouter, Cline API, Kilo API, xAI,
  DeepSeek, Groq, Mistral, NVIDIA NIM, and Ollama and LM Studio on this Mac —
  and you can add any number of custom endpoints, each named and typed
  (OpenAI-compatible or Anthropic) and keyed in the keychain. Settings → Models
  is a model library: switch models or whole providers in and out of the picker,
  and **Test** a model to see how long it answers in, or why it fails.
- **Workspaces and threads.** Open local folders through the native picker. The
  sidebar groups threads under their workspace, flags the ones that are running
  or need you, and searches across every workspace at once. Pin, rename,
  archive, fork and export a thread, or give it its own git worktree.
- **A turn that reads as one story.** The agent's mark and name once per turn,
  its notes folded away as it moves on, and its work hung on a quiet rail — one
  line when collapsed, a list of steps with their outcome, duration and path or
  command when opened. Streaming answers, plans, tool output, subagents,
  background tasks and goals all sit on that rail. A context compaction is a
  centred seam, the changed files form one review card, and the turn closes with
  a single **Done** line: duration, input and output tokens, estimated cost and the model,
  with Undo and Fork beside it.
- **Approvals.** Write and edit calls show a diff preview, each choice explains
  its scope, approvals expire after 10 minutes, and there are keyboard shortcuts
  (`⌘Y`, `⌘⇧Y`, `⌘⌫`). Permission modes are Ask, Auto and Full access, the same
  for every agent and model, decided by the app.
- **Composer.** Model, reasoning-effort and permission pickers — models are
  reached through an icon rail of providers. `@` file mentions from a workspace
  file index, slash prompt macros, file and image attachments by picker or drag
  and drop, and steer or queue while a turn runs.
- **Changes dock.** Changed files and unified diffs from git. Stage, commit,
  push, discard files or single hunks, comment on a line and send it back to the
  agent, switch branches and open pull requests. A file tree with a read-only
  viewer and a real terminal pane sit in the same dock, and Find searches the
  thread.
- **Undo.** Every turn keeps a file snapshot, so Undo returns the workspace to
  how it was before the turn and Reapply puts the work back.
- **Context that fits.** Before a call, Harness estimates the request against the
  model's window and summarizes long histories as they approach the input limit.
  You can also use `/compact` or **Compact now** in the context card. The latest
  request, including its images, stays in context and the full transcript stays
  on disk. If summarization fails, Harness can still shorten old tool output to
  fit, with a notice when it does so.
- **Usage.** A local token and cost ledger: today's total, a year of activity,
  a 7- or 30-day trend per model, provider share, streaks and the longest turn,
  and a per-call trajectory for each turn. Days and legend entries answer on
  hover.
- **Account and agents.** In-app `muse login`, or a Muse API key, with
  subscription, API key or automatic billing — all on Settings → Agents. Muse
  CLI update checks are built in.
- **Extensions.** Settings → Extensions installs curated skills, MCP servers and
  plugins from a bundled store in one click, with no CLI and no download,
  alongside the skills, plugins and servers already on this Mac.
- **Appearance.** Light, dark or system, with three dark depths (Subtle, Mid,
  Pure black), nine accents, sidebar tint and translucency, ten thinking-orb
  styles, and motion that steps aside under `prefers-reduced-motion`.
- **Desktop integration.** Native menu bar, command palette (`⌘K`), OS
  notifications, haptics, Markdown session export, and Settings as a full-window
  page of twelve sections in four groups.

## Tech stack

| Layer | Technology |
|---|---|
| Native shell | Rust, Tauri 2 (OS webview, no bundled Chromium) |
| UI | React 19, TypeScript, Zustand, design tokens in CSS on a Tailwind v4 theme layer, lucide-react |
| Agent bridge | Node (bundled runtime), `@muse-code/sdk` 1.3.0 for MSP, ACP over stdio |
| Browser verification | Playwright 1.64 driving an installed, native-pinned Chromium; fresh incognito contexts and raster-only panel frames |
| Built-in harness | HTTPS to Anthropic Messages and OpenAI-compatible Chat Completions; tools confined to the workspace and the seatbelt sandbox |
| Storage | `glitter.json` for settings, the OS keychain for secrets and workspace grants, JSONL for harness threads |
| Tests | `node:test`, Vitest + Testing Library, `cargo test` with Tauri's mock runtime |
| Website | Vite, three.js, Lenis (`apps/website`) |

## Architecture

```text
React UI ──invoke──▶ Rust shell ──NDJSON/stdio──▶ Node bridge ──▶ muse serve (MSP)
          ◀─events──            ◀──────────────               ├─▶ ACP agent CLIs
                                                              └─▶ Model providers
                                                                  (HTTPS, your keys)
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
│   │   ├── lib/           Store, IPC, types, theme, usage charts, pure helpers
│   │   └── test/          Vitest setup
│   └── src-tauri/         Rust shell: commands, IPC validation, grants, packaging config
└── website/               Marketing site (independent of the app)
packages/
└── glitter-bridge/        Node bridge: the built-in harness (providers, wire, tools,
                           permissions, skills, MCP, delegation, context fitting),
                           Muse (MSP) and ACP hosts, isolation, redaction
tests/                     Node test suite and fixtures (fake agents, stub bridge)
scripts/                   Release and verification scripts
docs/                      Architecture, development, agent guide, decisions, design, releasing
```

## Getting started

**Prerequisites:**

- Node.js 22.22.2, 24.15 or newer (CI uses 24; the DOM test tooling does not run
  on Node 20)
- Rust stable
- Git
- For the built-in agent: an API key for one model provider, added under
  **Settings → Providers**, or a local server such as Ollama. No key is needed to
  open the app and try the UI.
- For the Muse agent, the Muse CLI:

```bash
curl -fsSL https://dev.meta.ai/install.sh | sh
```

Then sign in with `muse` and `/login`, or sign in inside the app under
**Settings → Agents**.

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
and verifies its SHA-256. On macOS, install the result as the single
`/Applications/Glitter.app`; see [AGENTS.md](AGENTS.md).

**Test:**

```bash
npm run verify       # every gate: versions, types, Node + DOM + Rust tests,
                     # a11y, contrast, audit, chunk budget, all three builds
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
| `npm run check:versions` · `check:a11y` · `check:contrast` | Manifest agreement, accessible names, WCAG AA contrast of every theme and accent |
| `npm run verify` | All local gates, in sequence |
| `npm run clean` | Remove the three `dist/` folders |

CI runs those gates on macOS, adds `cargo clippy -- -D warnings` and checks the
packaged app bundle; the Rust dependency audit runs on Ubuntu. Run the heavy
suites one at a time. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for
debugging, adding features and settings, and common pitfalls.

## Architecture principles

- The agent is the source of truth — an external CLI, or the built-in harness's
  own session log. The app never simulates agent behaviour.
- The renderer is untrusted. Privileged work is authorized in Rust, behind an
  allowlisted verb with a typed DTO, or a dedicated command that takes a
  workspace grant.
- Secrets live only in the OS keychain, and go only to the provider that issued
  them.
- Third-party agents are opt-in and isolated.
- One implementation per concern: one store, one IPC module, one design-token
  set.

Coding agents should start with [AGENTS.md](AGENTS.md).

## Known limitations

- **No published release.** Builds are unsigned and not notarized, so
  Gatekeeper blocks them on other Macs. There's no auto-updater. See
  [docs/RELEASING.md](docs/RELEASING.md).
- **macOS only.** There are no Windows or Linux builds, and the app CI runs on
  macOS. Some platform code for them remains in the source but is not built or
  tested.
- **Summaries are lossy.** Compaction asks the thread's model to summarize its
  history. A very long transcript may need to omit older middle entries from
  that request, and a summary can miss details. The full transcript remains
  available in the thread.
- **Harness threads are local.** They live in this Mac's app data folder, with no
  sync and no shared session storage with the CLI agents.
- **Coverage gaps.** Native dialogs (folder picker, save panel) and a live,
  authenticated end-to-end session aren't covered by automated tests;
  `scripts/live-muse-smoke.mjs` is a manual check.
- **Experimental agents.** Gemini CLI, Qwen Code, Goose and Cline CLI aren't
  verified.
- **Large modules.** `apps/desktop/src/lib/store.ts` (~5.0k lines) and
  `src-tauri/src/lib.rs` (~7.8k lines, tests included) hold most of the logic.
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

The app points its bridge at that harness folder. Run the bridge outside the
app, and the same threads default to `~/.glitter/harness/`.

Session history for the Muse CLI and ACP agents stays in each CLI's own data
directory.

## Upgrading from Muse Code Desktop

The app's bundle identifier changed from `com.musecode.desktop` to
`com.glitter.desktop`, which renames its data folder, log folder and keychain
service. Quit Muse Code before you first open Glitter. On that first launch
Glitter:

- moves the settings file (renamed `glitter.json`), built-in harness threads and
  turn snapshots into its own data folder, and the logs into its log folder;
- copies each keychain entry (API key, provider keys, custom endpoint keys,
  workspace grants, agent pins, ACP consent) to the new service, then deletes
  the old one. macOS may ask once per entry whether Glitter can read it; choose
  **Always Allow**.

Worktrees made by Muse Code stay in
`~/Library/Application Support/com.musecode.desktop/worktrees/`, because git and
each agent's session history record their paths. They keep working, and the old
folder is removed once the last of them is. Their branches keep the `muse/`
prefix; new worktrees use `glitter/`. A step that fails is retried on the next
launch. Move `/Applications/Muse Code.app` to the Trash afterwards, and keep only
one Glitter on the Mac.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): processes, trust boundary, data flow, module map
- [docs/HARNESS_UPGRADE_PLAN.md](docs/HARNESS_UPGRADE_PLAN.md): the current forward roadmap for the built-in agent
- [docs/harness-context-budget.md](docs/harness-context-budget.md): how a long harness thread is fitted into the model's window
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): setup, commands, testing, debugging, conventions
- [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md): rules and workflow for AI agents and new contributors
- [docs/DECISIONS.md](docs/DECISIONS.md): architectural decision log
- [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md): tokens, typography, copy, component behavior
- [docs/RELEASING.md](docs/RELEASING.md): versioning, signing, packaging, rollback
- [docs/production-readiness.md](docs/production-readiness.md): the pre-release audit
- [CHANGELOG.md](CHANGELOG.md) · [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) · [apps/website/README.md](apps/website/README.md)

## License

[MIT](LICENSE). Third-party attributions are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
