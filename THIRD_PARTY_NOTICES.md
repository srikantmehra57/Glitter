# Third-party notices

Glitter redistributes third-party code. The license texts below are
summarized for attribution. Full texts are generated from the lockfiles into
`apps/desktop/src-tauri/resources/THIRD_PARTY_LICENSES.txt` and bundled with
each application. The Node runtime's license is at
<https://github.com/nodejs/node/blob/main/LICENSE>.

This product is not affiliated with or endorsed by Meta. "Muse Code" refers to
Meta's separately distributed CLI.

## Redistributed in the shipped application

| Component | Version | License | Notes |
|---|---|---|---|
| Node.js runtime | 26.8.2 | MIT (OpenJS Foundation) | Staged as the `glitter-node` sidecar by `packages/glitter-bridge/scripts/stage-sidecar.mjs`; only `bin/node` is extracted from the official archive |
| `@muse-code/sdk` | 1.3.0 | MIT — © Meta Platforms, Inc. and affiliates | Bundled into `glitter-bridge/dist/index.js` |
| `playwright-core` | 1.64.1 | Apache-2.0 — © Microsoft Corporation | Browser automation, bundled into the bridge with its registry metadata; Chromium itself is installed separately, not redistributed by Glitter |
| `chromium-bidi` | 12.1.0 | Apache-2.0 — © Google LLC and contributors | Playwright's browser-protocol dependency, bundled into the bridge |
| `@fontsource-variable/google-sans` | 5.3.2 | OFL-1.1 — © 2017 Google, Inc. | Google Sans variable font, bundled locally into the webview |
| `@fontsource-variable/inter` | 5.3.0 | OFL-1.1 — © 2016 The Inter Project Authors | Inter variable font, bundled locally into the webview |
| `react`, `react-dom` | 19.x | MIT — © Meta Platforms, Inc. and affiliates | Compiled into the webview bundle |
| `react-markdown` | 10.1.0 | MIT | Compiled into the webview bundle |
| `remark-gfm` | 4.0.1 | MIT | Compiled into the webview bundle |
| `zustand` | 5.x | MIT — © 2019 Paul Henschel | Compiled into the webview bundle |
| `@tauri-apps/api` | 2.12.3 | Apache-2.0 OR MIT | IPC and event bindings for the native shell; compiled into the webview bundle |
| `@tauri-apps/plugin-store` | 2.5.0 | MIT OR Apache-2.0 | Persists settings, drafts, and session memory (`glitter.json`); compiled into the webview bundle |
| `@tauri-apps/plugin-notification` | 2.6.0 | MIT OR Apache-2.0 | Turn and approval notifications through the OS; compiled into the webview bundle |
| `lucide-react` | 1.61.0 | ISC — © Cole Bemis and contributors | Icons compiled into the webview bundle |
| `thinking-orbs` | 0.3.2 | MIT — © 2026 Jakub Antalik | Compiled into the webview bundle |
| `highlight.js` | 11.12.0 | BSD-3-Clause — © 2006 Ivan Sagalaev | Lazy core + grammar chunks compiled into the webview bundle |
| `@xterm/xterm` | 6.0.0 | MIT — © The xterm.js authors | Terminal renderer; a lazy chunk in the webview bundle, loaded when a terminal is first opened |
| `@xterm/addon-fit` | 0.11.0 | MIT — © The xterm.js authors | Sizes the terminal to its pane; loaded with it |
| `portable-pty` | 0.9.0 | MIT — © Wez Furlong | Rust crate compiled into the native shell; opens the PTY behind the terminal pane |
| `tauri-plugin-single-instance` | 2.5.3 | Apache-2.0 OR MIT | Rust crate compiled into the native shell; focuses the existing app when opened again |
| `esbuild` | 0.28.2 | MIT — © 2020 Evan Wallace | Build tool only; not redistributed at runtime |

Agent and model identity marks (`apps/desktop/public/agents/*.svg`,
`apps/desktop/public/brands/*.svg`, and the bundled copies) are trademarks of
their respective owners and are used only to identify interoperating agents,
providers, and models. The files in `brands/` are avatar plates derived from
[Lobe Icons](https://github.com/lobehub/lobe-icons) 1.97.0 (MIT, © lobehub).
No endorsement is implied.

## Development and website tooling only (not redistributed)

| Component | Version | License |
|---|---|---|
| `three` | 0.186.1 | MIT — © three.js authors (marketing site) |
| `playwright` | 1.64.1 | Apache-2.0 (screenshot capture) |
| `sharp` | 0.35.5 | Apache-2.0 (image optimization) |
| `vite`, `vitest`, `typescript`, `tailwindcss`, `jsdom`, `@testing-library/*`, `@tauri-apps/cli` | various | MIT / Apache-2.0 / BSD |
| `openpgp` | 6.3.2 | LGPL-3.0-or-later | Build-time check of the Node `SHASUMS256.txt.asc` signature. Not bundled into the app or the bridge. |

## Rust crates

| Component | Version | License |
|---|---|---|
| `objc2-foundation` | 0.3.2 | MIT — © objc2 contributors (native macOS icon image data) |
| `option-ext` | 0.2.0 | MPL-2.0 — © Simon Sapin and contributors (linked via `dirs-sys`) |

The Tauri host links crates resolved through `Cargo.lock` (Tauri, tokio, serde,
keyring, objc2, and their transitive dependencies). All resolved crates are
licensed MIT, Apache-2.0, ISC, BSD, Unicode-3.0, or MPL-2.0. MPL-2.0 is a
file-level copyleft license; it applies to `option-ext`'s own source files
(which are unmodified) and does not extend to the rest of the binary. Per-crate
notices are available from
`cargo license --manifest-path apps/desktop/src-tauri/Cargo.toml` or from the
crate sources in the local cargo registry.

## Fonts and icons

Inter and Google Sans are bundled locally through `@fontsource-variable/inter` and
`@fontsource-variable/google-sans` under the SIL Open Font License 1.1; their
full licenses are included below with the generated npm package notices. No
fonts are remotely loaded. The other interface choices use system font stacks
(`SF`/`system-ui`). The app icon derives from the in-repo `docs/brand/glitter-mark.svg`;
`npm run icons` generates the public marks and native icons.

## License texts

### highlight.js — BSD 3-Clause License

BSD 3-Clause License

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Repository license

MIT — see [LICENSE](LICENSE).
