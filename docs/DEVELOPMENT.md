# Development

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node.js + npm | 24 (CI uses 24; floor is `^22.22.2 \|\| ^24.15.0 \|\| >=26` — vitest 5/jsdom 30) | Everything |
| Rust (stable) | 1.90 or newer | Native shell, `npm run dev`, `npm run build`, native tests |
| Git | any recent | Changes dock, file index |
| Chromium | Playwright 1.64 registry revision, or a system Chrome/Chromium/Edge channel | The real Browser panel. Not needed for the default test suite; `npx playwright install chromium` installs the matching browser. |

Development and builds need a Mac: Glitter ships for macOS only.

## Setup

```bash
npm install          # all three workspaces; esbuild's binary ships in its optional platform package
npm run build:bridge # packages/glitter-harness/dist/index.js, needed by the native shell
```

If npm skipped optional packages and the esbuild binary is missing, run
`npm rebuild esbuild`.

No `.env` file is needed. Settings live in the app's own store and provider
secrets in the OS keychain. Toolchain discovery uses the inherited environment
as described below. See
[Environment variables](#environment-variables) for the optional development
and release variables.

## Commands

All commands run from the repository root.

| Command | What it does |
|---|---|
| `npm run dev` | Builds the bridge, then `tauri dev`: native window plus Vite on :1420 with HMR |
| `npm run dev:ui` | Renderer only, in a browser, with mock data (no Rust, no CLI) |
| `npm run dev:website` | Marketing site on http://127.0.0.1:4174 |
| `npm run build` | Unsigned release bundle in `apps/desktop/src-tauri/target/release/bundle/`. Stages the Node sidecar, which may download Node from nodejs.org (SHA-256 verified). |

The macOS DMG target shells out to `create-dmg` (`brew install create-dmg`). Without it the `.app` still builds and `scripts/verify-macos-package.mjs` still passes, but the DMG step fails with `Not enough arguments`.
| `npm run build:bridge` / `build:ui` / `build:website` | Build one part |
| `./node_modules/.bin/glitter --help` | Run the source-build Harness CLI after `build:bridge`; `--cwd` selects a workspace and `-p` runs a single prompt |
| `npm run install:cli` | Install the `glitter` launcher in `~/.local/bin`; it runs the CLI shipped in `/Applications/Glitter.app` with the app's bundled Node (`--uninstall` removes it) |
| `npm run preview` | Build the renderer and serve it with `vite preview` (mock data) |
| `npm run typecheck` | `tsc --noEmit` for the bridge and the renderer |
| `npm test` | Node test suite (`tests/*.test.mjs`) |
| `npm run test:ui` | Vitest + Testing Library DOM tests (`apps/desktop/src/**/*.test.tsx`) |
| `npm run test:native` | `cargo test`, including the mock-app native end-to-end tests |
| `npm run check:a11y` / `check:contrast` / `check:versions` | Accessibility sweep, WCAG AA contrast of every theme and accent pair, version-manifest agreement |
| `npm run verify` | Every gate above plus `npm audit`, in order. Run before a PR. |
| `npm run eval:harness -- --validate` / `--dry` / `--probes` | Validate fixtures, exercise them offline, or run scripted protocol probes. None of these call a provider. See [Harness evaluation](../evals/harness/README.md) for bounded live runs. |
| `npm run clean` | Remove the three `dist/` folders (`cargo clean` for Rust output) |
| `npm run icons` | Regenerate app icons from `apps/desktop/public/spark.svg` |

Run heavy gates **one at a time**. `node --test` and `cargo test` each saturate
the machine, and running them together starves timers and causes spurious
timeouts. `npm run verify` already runs them in sequence.

The native tests need the web bundle, because `tauri::generate_context!` embeds
`frontendDist` at compile time, and tauri-build requires the `externalBin`
sidecar file to exist even though debug builds spawn ambient Node instead of
the staged runtime. On a fresh checkout run `npm run build:bridge && npm run build:ui`
and stage the sidecar — `npm run build:sidecar -w @glitter/harness` (downloads Node
from nodejs.org), or create an empty placeholder file
`apps/desktop/src-tauri/binaries/glitter-node-<host triple>` (`rustc -vV` prints
the triple; append `.exe` on Windows) — before `npm run test:native`.

### Linting

There's no ESLint or Prettier config. Static checking is strict TypeScript
(`strict`, `noUnusedLocals`, `noUnusedParameters`) plus the source-level checks
in `tests/` and `scripts/` (hooks-after-return, accessible names, contrast,
copy). Match the formatting of the file you're editing, and don't reformat
unrelated code.

## Tests

| Suite | Location | Style |
|---|---|---|
| Node | `tests/*.test.mjs` | `node:test`. Each test bundles the TypeScript module it covers with esbuild, then imports it. Bridge tests spawn the real bridge against fake agents in `tests/fixtures/`. Some tests read source files as text to check invariants. |
| DOM | `apps/desktop/src/components/*.test.tsx` | Vitest + jsdom. Seed state with `src/test/store.ts`. |
| Native | `#[cfg(test)]` modules in `src-tauri/src/*.rs` | Unit tests, plus `native_shell_e2e_*` in `lib.rs`, which drive `tauri::test::mock_app` against `tests/fixtures/stub-bridge.mjs`. |
| Live (manual) | `npm run eval:harness -- --yes ...` | A bounded, opt-in provider evaluation. Select a model, credentials and price bounds as documented in [Harness evaluation](../evals/harness/README.md). Never run in CI. |
| Browser (manual) | `GLITTER_BROWSER_LIVE_TEST=1 node --test tests/browser.test.mjs` after `npm run build:bridge` | Real local-page navigation, AI refs, click/type, screenshots, console, live frames and shutdown from a copied standalone bundle. Skipped by default and never required in CI. If the development sandbox denies Chromium's own sandbox, also set `GLITTER_BROWSER_ALLOW_UNSANDBOXED=1` for that direct test process only. |
| Package (macOS) | `scripts/verify-macos-package.mjs` | After `npm run build`: sidecar present, bridge digest baked in, ping works without ambient Node. CI runs this. |

`tests/markdown-blocks.test.mjs` uses the repository's Markdown files (`README.md`,
`CHANGELOG.md`, `docs/*.md`, …) as a corpus. A doc change can fail it if the doc
doesn't render identically block-by-block.

## Debugging

- **Renderer.** In `npm run dev`, open devtools from the webview context menu.
  `logger.ts` writes redacted lines to the console (debug lines only in dev) and
  to the native app log.
- **Native and bridge logs.** macOS: `~/Library/Logs/com.glitter.desktop/glitter.log`
  and `security-audit.log` (approval decisions only). You can also use Settings →
  Diagnostics → **Open logs**. Bridge stderr is redacted and prefixed
  `[glitter-harness]`.
- **Bridge on its own.** `node packages/glitter-harness/dist/index.js` reads
  NDJSON requests on stdin: `{"id":"1","method":"ping","params":{}}`.
  `scripts/measure-cold-start.mjs` is a minimal driver to start from.
- **Debug-only bridge override.** Debug builds honor `GLITTER_BRIDGE_SCRIPT=/abs/path.js`.
  Release builds ignore it and verify the baked digest.

## Environment variables

None are required. Optional ones:

| Variable | Used by | Purpose |
|---|---|---|
| `TAURI_DEV_HOST` | `apps/desktop/vite.config.ts` | Dev server host for device or remote debugging |
| `GLITTER_BRIDGE_SCRIPT` | native, debug builds only | Use a different bridge script |
| `GLITTER_TEST_GRANTS_ACCOUNT` | native tests | Keyring account name for test grants |
| `GLITTER_WORK_CEILING_MS` | bridge | Test seam for the per-verb queue ceiling. May only shorten it, never lengthen it, so it cannot weaken the guard in a real session. |
| Provider API keys such as `ANTHROPIC_API_KEY` | source-build CLI and live evaluator | Optional local credential overrides. The desktop app keeps its provider keys in the keychain. |
| `GLITTER_BROWSER_LIVE_TEST` | `tests/browser.test.mjs` | Set to `1` to run the real Chromium test; otherwise it is skipped. |
| `GLITTER_BROWSER_ALLOW_UNSANDBOXED` | direct browser tests only | Set to `1` only when the development sandbox blocks Chromium's own sandbox. The native app ignores this escape hatch and always requires the sandbox. |
| `BASE`, `CHROMIUM_PATH`, `GPU_ARGS` | `apps/website/scripts/verify-site.mjs` | Target URL and browser for the site check |
| `APPLE_*` | `tauri build` | Signing and notarization, see [RELEASING.md](RELEASING.md). CI secrets only, never committed. |

### Agent toolchains

The native app augments the inherited PATH with installed standard directories
for Cargo, pyenv, rbenv, Bun, Go, Homebrew and the existing Node version managers.
For nvm it reads `~/.nvm/versions/node` and the default alias, including numeric
versions and `lts/*` alias chains. With no default alias it uses the newest
installed numeric version. It does not run shell startup files.

Both environment filters preserve `JAVA_HOME`, `JDK_HOME`, `CARGO_HOME`,
`RUSTUP_HOME`, `GOPATH`, `GOROOT`, `PYENV_ROOT`, `PYENV_VERSION`, `RBENV_ROOT`,
`RBENV_VERSION`, `BUN_INSTALL`, `NVM_DIR`, `VOLTA_HOME`, `ASDF_DATA_DIR`,
`MISE_DATA_DIR`, `VIRTUAL_ENV` and `CONDA_PREFIX`. Inherited absolute roots also
contribute their binary/shim directories to the app's PATH; each absolute
`GOPATH` entry contributes its `bin` directory. Active Python environments take
precedence. Only directories that exist enter PATH.

Settings exported only in a shell startup file are unavailable to a Finder
launch. Install into a standard location or supply the root in the app's
inherited environment. This lookup grants no additional write access; the
package-cache policy and sandbox still apply. Provider/cloud/registry secrets
and interpreter startup hooks remain excluded from inherited child environments.

## Making changes

### Adding a feature

1. Find the existing surface. UI lives in `apps/desktop/src/components/`, state
   and actions in `lib/store.ts`, IPC in `lib/bridge.ts`.
2. Put pure logic in a `lib/*.ts` module with no React or Tauri imports, so
   `tests/` can bundle and test it directly.
3. If the feature needs a new agent capability, add the bridge verb in
   `packages/glitter-harness/src/index.ts` and the Harness host. Then add it to
   `BRIDGE_METHODS` and a typed DTO in `dto.rs`, add a `bridge.ts` wrapper, and
   add the mock answer in `bridge.ts` / `mock.ts` so `dev:ui` keeps working.
4. If it needs OS access (files, git, processes, dialogs), add a dedicated
   `#[tauri::command]` in `lib.rs`. Authorize it with a workspace grant. Never
   take a raw path from the renderer.
5. Add tests at the lowest level that can prove the behavior.
6. Add user-visible changes to `CHANGELOG.md` under `[Unreleased]`.

### Adding a dependency

Check whether an existing dependency already covers it. The renderer bundle is
already over 700 kB. Add it to the workspace that uses it
(`npm install -w <workspace> <pkg>`), never to the root. Anything that ships in
the app also needs a row in `THIRD_PARTY_NOTICES.md`. Rust crates go in
`apps/desktop/src-tauri/Cargo.toml`.

### Adding a setting

1. Add the field and its default to `Settings` and `DEFAULT_SETTINGS` in
   `apps/desktop/src/lib/types.ts`.
2. Persisted fields go through `settingsPersistence.ts`. Secrets go to the
   keychain via a native command, never into `glitter.json`.
3. If the setting changes how the host starts, it's a `startHost` parameter and
   needs a DTO field in `dto.rs`.
4. Add it to the matching section of `SettingsModal.tsx`.

### Changing the version

Bump all six manifests together. See [RELEASING.md](RELEASING.md).

## Conventions

- TypeScript strict mode. Don't use `any`, `@ts-ignore` or non-null assertions
  just to silence an error.
- React function components, one per file in `components/`, named exports.
  Subscribe to the store with selectors (`useAppStore(useShallow(...))`), not the
  whole store.
- Files: `PascalCase.tsx` for components, `camelCase.ts` for renderer modules,
  `kebab-case.ts` in the bridge, `kebab-case.test.mjs` for Node tests.
- Styling uses CSS custom properties in `styles.css` / `settings.css`. Tokens and
  visual rules are in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).
- Product copy uses Workspace, Thread, Agent, Run, Plan, Changes. Keep labels
  short and in the present tense.
- Comments explain *why*, especially for security and ordering constraints.

## Common pitfalls

- **Blank window after `cargo build --release`.** The `custom-protocol` feature
  embeds the UI. `tauri dev` turns it off. Build the UI first.
- **"Bridge script missing".** Run `npm run build:bridge`.
- **Spurious test timeouts.** Something heavy is running in parallel. Run the
  gates one at a time.
- **Doc edits failing `npm test`.** See the markdown corpus note under
  [Tests](#tests).
- **A folder that worked before now says it needs re-opening.** Grants live in
  the keyring. A fresh keyring, or a folder added before grants existed, needs
  one pass through the folder picker.
