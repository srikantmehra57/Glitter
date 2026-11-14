# Remediation and delivery plan — single source of truth

The one forward plan for Glitter/Harness: (A) fix the verified defects from the
2026-11-14 audit and (B) close the gap to a top-3 agent harness. Created
2026-11-14; consolidated the older plans on the same date.

**This document supersedes and replaces** `HARNESS_UPGRADE_PLAN.md`,
`ORCHESTRATOR_PLAN.md`, `IMPROVEMENTS.md`, `production-readiness.md`,
`HARNESS_INTEGRATION_PLAN.retired.md` and `harness-context-budget.md`. Those
files have been removed; their unfinished, still-relevant work is folded in
below (see [Consolidation record](#consolidation-record)). It remains the source
of truth until every item is implemented or explicitly rejected. Durable
knowledge stays in [DECISIONS.md](DECISIONS.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[AGENT_GUIDE.md](AGENT_GUIDE.md), [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md),
[DEVELOPMENT.md](DEVELOPMENT.md) and [RELEASING.md](RELEASING.md).

**Status: in progress.** Phases F0 (the trust boundary) and F1 (corruption,
hangs and crashes) are implemented: every item is marked done below, and
`npm run verify` passed on the change set on 2026-11-14 (845 Node tests with one
skipped, 500 UI tests, 217 native tests). The skip is the real-Chromium browser
test, which this check does not run. F2.1's cache implementation and automated
verification are complete, with packaged checks still open. F2.3's toolchain
implementation and automated verification are complete as of 2026-11-15, with
real compiler and packaged checks still open. F2.4's delegated approvals are
implemented and verified, with a packaged desktop interaction still unrun.
Completed items are marked below, and partial work and accepted residuals are
called out without claiming that the corresponding finding is closed.

## Provenance and method

Two independent audits were run on the working tree (`feat/environment-inspector`,
HEAD `8735546` plus uncommitted changes) and reconciled:

- A static read of the harness core, permission pipeline, wire layer,
  persistence, Rust trust boundary and the in-flight Models/Providers refactor.
- A second audit that **executed** reproductions in a scratch folder and ran the
  full gate (`npm run verify`: 775 Node tests, 499 UI tests, 208 native tests,
  0 audit vulnerabilities at the time of that run). Its findings are folded into
  the register below; the standalone report and workpapers were removed.

A third pass on 2026-11-14 read the wire layer, MCP client, browser and web
tools, skills, the Orchestrator, credentials, native request authorization,
snapshot restore and the catalog, and re-ran the git experiment. It withdrew M8,
corrected M9 and M11, widened C1, M1 and H5, and added H9–H11, M15–M23 and
L9–L14. Areas it found sound: credentials and keychain handling, native
session/grant authorization, snapshot restore, the Orchestrator's routing,
planning, build, review and takeover, and web-fetch redirect handling. Not read
closely: the plugin installer's internals, the MCP consent module, the
terminal's PTY handling and most UI components.

Every issue below was re-verified against source before inclusion. Evidence
tags:

- **Confirmed (executed)** — reproduced by running the code.
- **Confirmed (read)** — verified by reading the cited source; not executed.
- **By reading** — plausible from source; needs a reproduction before fixing.

The central lesson: the escape is not in the *sandboxed* agent process — it is
in the **trusted, unsandboxed app process** (its own `git`) reading and executing
what the sandboxed agent is allowed to write (`.git/`). Fixes must follow that
direction, not only harden the shell.

## Rules for every phase

- The renderer stays untrusted; new bridge verbs need an allowlist entry, a
  strict native DTO, session/grant authorization and a preview mock. OS access
  stays behind grant-bound native commands.
- One permission pipeline, one session store, one sandbox implementation
  (`isolation.ts`), one design-token set. Extend; do not add parallel ones.
- Start each fix with a failing regression test that reproduces the defect. Pin
  the invariant in `tests/` (or `tests/regressions.test.mjs` for source-text
  invariants). Do not claim a live/sandbox/desktop check that ran only on a stub.
- Keep diffs focused; no unrelated redesign. Update `CHANGELOG.md` under
  `[Unreleased]` for user-visible changes and `DECISIONS.md` for new decisions.
- Validate with the narrowest checks, then `npm run verify` before handoff.
  Never run `node --test` and `cargo test` concurrently.
- A phase is `done` only when its exit gate and `npm run verify` pass on the
  exact change set; record live/manual checks separately. Paid, interactive or
  unavailable checks are marked **blocked** with a named owner, never assumed
  green.
- Measure before tuning. A feature landing is not evidence of improved task
  success; quality claims require the D1 baseline.

## Findings register

Severity reflects the reconciled audit. Both audits were verified against source.

| ID | Severity | Summary | Evidence | Primary surface |
|---|---|---|---|---|
| C1 | Critical | App git executes agent-planted config, unsandboxed, with network. Zero-click: the background `git diff` and `diff --numstat` refresh run a planted clean filter even with `--no-ext-diff --no-textconv`. Also `git add` (filter) and commit/switch/pull/push/worktree-add (hooks) | Confirmed (executed) + read | `lib.rs` git calls, `worktrees.rs` |
| C2 | Critical | "Offline" shell leaks via DNS (Unix-socket name lookup), localhost and Docker socket | Confirmed (executed) | `isolation.ts` |
| C3 | Critical | `edit_file`/`write_file` corrupt non-UTF-8/binary files (UTF-8 round-trip) | Confirmed (executed) | `tools.ts` |
| C4 | Critical | Package managers blocked in every mode (`~/.npm`, `~/.cargo`, `~/go`, `~/.m2` unwritable) | Confirmed (executed) | `isolation.ts` |
| C5 | Critical | Undo refused above 2000 files / 2 MiB per file / 32 MiB total | Confirmed (read) | `snapshots.rs` |
| C6 | Critical | One unhandled rejection kills every thread (shared process) | Confirmed (read) | `host.ts`, `index.ts` |
| H1 | High | Deny rules bypassed by path/wrapper (`/usr/bin/git`, `env git`, `command git`) | Confirmed (executed) | `permission/rules.ts` |
| H2 | High | Path deny rules case-sensitive on case-insensitive APFS (`.ENV` vs `.env`) | Confirmed (executed) | `permission/rules.ts` |
| H3 | High | Shell hangs past timeout/Stop when a descendant holds the output pipe | Confirmed (executed) | `tools.ts` |
| H4 | High | `grep` ReDoS freezes the whole process; `read_file` has no size cap | Confirmed (executed) | `tools.ts` |
| H5 | High | Deleting a thread leaves its JSONL transcript and index row (no `remove()` caller); delegated child sessions' logs are left too | Confirmed (read) | `store.ts`, `host.ts`, `store.ts` (UI) |
| H6 | High | Subagents cannot run commands in Ask mode (no approval channel) | Confirmed (read) | `host.ts` |
| H7 | High | Agent PATH/env misses cargo/pyenv/rbenv/bun; strips `JAVA_HOME`/`GOPATH`/`NVM_DIR` (PATH *is* augmented for brew/volta/asdf/mise/fnm) | Confirmed (read) | `lib.rs`, `process.rs` |
| H8 | High | Edits to `.git/`, `.env`, `package.json` scripts run unasked in Ask and Auto; README overstates edit approvals | Confirmed (read) | `permission/policy.ts` |
| M1 | Medium | Danger classifier misses any git global option: `git -c … push --force`, `git -C . reset --hard`, `git -C . push --force`, `git --no-pager -C sub clean -fdx` all assess as no risk | Confirmed (executed) | `permission/danger.ts` |
| M2 | Medium | `web_fetch` has no loopback/private-IP guard; Full access never asks | Confirmed (read) | `harness/web.ts` |
| M3 | Medium | Sandbox fails open if `sandbox-exec` spawn throws | Confirmed (read) | `isolation.ts` |
| M4 | Medium | Failed/retried attempts' tokens not billed to the usage ledger | Confirmed (read) | `host.ts` |
| M5 | Medium | No output-token cap on the OpenAI-compatible wire (local models truncate) | Confirmed (read) | `harness/wire.ts` |
| M6 | Medium | Corrupt JSONL lines dropped silently on read | Confirmed (read) | `harness/store.ts` |
| M7 | Medium | Unbounded SSE buffer (custom endpoint can OOM the bridge); no timeout before response headers arrive | Confirmed (read) | `harness/wire.ts` |
| M8 | — | **Withdrawn.** `compactSession` returns immediately and the summary runs detached, so the 100 s bridge ceiling does not bound it | Refuted (read) | — |
| M9 | Medium | Every mid-stream provider error is classified `TRANSPORT` and retried, including permanent ones (an invalid request), which burns the retry budget and re-bills. (The earlier claim that `overloaded_error` is *not* retried was wrong: it is.) `Retry-After` is capped at 20 s, so a provider asking for 60 s is retried early | Confirmed (executed) | `harness/wire.ts` |
| M10 | Medium | `cancelTurn` returns `terminal` after 3 s regardless of real state | Confirmed (read) | `host.ts` |
| M11 | Medium | Thread can stick busy: a throw in `beginTurn` after the message is durable leaves `prompting` set. (Tool calls left without results are *not* a defect: `repairHistory` fills them at send time.) | By reading | `host.ts` |
| M12 | Medium | Retried streams duplicate text (partial saved as completed, retry adds a second) | By reading | `host.ts` |
| M13 | Medium | Session index rewritten in full on every model call; corrupt index has no in-app repair | By reading | `harness/store.ts` |
| M14 | Medium | Compaction item ids can collide after a restart (`…:idle:compaction:1`) | By reading | `host.ts` |
| L1 | Low | Edit/write TOCTOU between `confine()` and `writeFile` (unsandboxed process) | By reading | `tools.ts` |
| L2 | Low | `read()` loads whole JSONL into memory; slow on long threads | By reading | `harness/store.ts` |
| L3 | Low | Partial streams marked `completed` in transcript on error | By reading | `host.ts` |
| L4 | Low | Refactor drops `hiddenModels`/`hiddenProviders` with no notice | Confirmed (read) | `settingsPersistence.ts` |
| L5 | Low | Token estimate is chars÷4; 10,000 CJK characters estimate as 2,500 tokens, so compaction fires late | Confirmed (executed) | `harness/context.ts` |
| L6 | Low | CRLF files cannot be edited with LF `old_string`; error does not say why | Confirmed (executed) | `tools.ts` |
| L7 | Low | `grep`/`list_files` ignore `.gitignore`, skip >1 MB files silently, re-walk per page | By reading | `tools.ts` |
| L8 | Low | Hard caps (80 steps/turn, 24/subagent), 10-min approval expiry, 120 s retry budget are not configurable; long outages fail with no auto-resume | By reading | `host.ts`, `isolation.ts` |
| H9 | High | Agent cannot `git add`/`commit` inside a worktree thread: the worktree's index and objects live in the main repo's `.git`, outside the sandbox write roots | Confirmed (executed) | `isolation.ts`, `tools.ts` (`spawnShell`), `worktrees.rs` |
| H10 | High | One fetched page can freeze every thread: `htmlToText` is quadratic on unclosed `<script` tags and runs on the shared event loop (160 KB took 1.8 s; the 5 MB limit extrapolates to ~30 min) | Confirmed (executed) | `harness/web.ts` |
| H11 | High | Stdio MCP servers start inside the write sandbox, where `~/.npm` is blocked; six of the eight bundled catalog servers launch with `npx -y …` and likely cannot start uncached | By reading (same condition as C4) | `harness/mcp.ts`, `catalog.rs` |
| M15 | Medium | The trust prompt does not gate what it previews: project skills and `AGENTS.md`/`CLAUDE.md` load whether or not the workspace is trusted; only MCP startup checks trust | Confirmed (read) | `harness/skills.ts`, `host.ts` (`systemPrompt`) |
| M16 | Medium | Agent can make its own instructions permanent: unasked edits to `AGENTS.md` or `.glitter/skills/` are loaded by every later thread | By reading | `permission/policy.ts`, `harness/skills.ts` |
| M17 | Medium | Approval shortcut (⌘Y) has no key-repeat check and no minimum display time; holding or double-tapping approves the next card unseen | Confirmed (read) | `App.tsx` |
| M18 | Medium | Sandboxed shell reads everything: `~/.ssh` and the app's session logs for every other workspace | Confirmed (executed for `~/.ssh`) | `isolation.ts` |
| M19 | Medium | A crashed stdio MCP server stays dead until a manual refresh or config change; two servers producing one tool name disable all MCP | By reading | `harness/mcp.ts` |
| M20 | Medium | MCP tool-result images are dropped to a text placeholder; MCP tools must be rediscovered every turn, and each activation changes the tool list and invalidates the prompt-cache prefix | By reading | `harness/mcp.ts`, `host.ts` |
| M21 | Medium | Bundled catalog servers are unpinned (`@latest` or no version); consent binds to the config text, not the package version | Confirmed (read) | `catalog.rs` |
| M22 | Medium | Undo does not tell the agent: files are restored but the model's history still says its edits are in place | Confirmed (read) | `store.ts` (UI), `host.ts` |
| M23 | Medium | Background shells are orphaned if the agent process is killed, and exited shells are never dropped from memory | By reading | `harness/shells.ts` |
| L9 | Low | `.terminal` files are not in the default-open block list; opening one runs its command (needs a user click) | By reading | `lib.rs` (`default_open_would_execute`) |
| L10 | Low | One browser page per workspace is shared by all its threads | By reading | `browser.ts` |
| L11 | Low | Cost estimate is absent for direct Anthropic/OpenAI/Google keys and partial elsewhere: prices come only from a listing's `pricing` field or user entry | Confirmed (read) | `host.ts` (`providerModels`), `lib/cost.ts` |
| L12 | Low | MCP gaps: no legacy SSE transport, no session re-initialise, `tools/list_changed` ignored, no server-side cancel, tool schemas sent to providers unvalidated | By reading | `harness/mcp.ts` |
| L13 | Low | Switching provider mid-thread replays foreign tool-call ids; strict providers may reject them | By reading | `harness/wire.ts` |
| L14 | Low | A whole-workspace snapshot is taken synchronously on every send under the git write lock; Undo is practical only for the latest turn | Confirmed (read) | `lib.rs`, `snapshots.rs` |

---

## Completed foundations (already done — do not redo)

Recorded so this plan reflects true state. Evidence lives in `DECISIONS.md` and
`CHANGELOG.md`.

- **Trust & correctness** (former upgrade Phase 0): workspace MCP startup gated
  on trust; consent bound to the effective configuration; atomic MCP
  synchronization; adversarial boundary coverage; truthful context-fit outcomes;
  real seatbelt integration tests.
- **Crash/interruption recovery** (former upgrade Phase 3): bounded
  turn/checkpoint records; per-tool replay semantics; resume reconciliation;
  explicit user continuation; delegation/MCP consistency.
- **Provider compatibility** (former upgrade Phase 4): per-model capability
  descriptors; conformance fixtures from sanitized real behavior; image/
  unsupported-request normalization; caching/retries; precise degradation notes.
- **Conformance contract & CI separation** (former upgrade 1.1, 1.6): scripted
  probes pass 12/12 on both wire families; `npm run verify` needs no network or
  secret; live runs are opt-in (`--yes`, model, credential, `EVAL_PRICES`).
- **Orchestrator** (former orchestrator Phases 0–3.4): per-call ledger, route
  records, neutral transcript, handoffs, capability probes, pure policy, all four
  turn shapes, `ask_lead`, stuck detection v2, Lead review/repair, takeover,
  Plan-mode integration, session isolation, internal tuning contract, shared
  read-only stage, scout context pack (internal flag), opt-in Lead reads, free
  pre-route matrix (23/23). Offline validation: 16 tasks / 28 checks. **Live
  model quality and cost savings are NOT yet established** (see D1).
- **App parity** (former IMPROVEMENTS, shipped): worktree per thread, per-turn
  snapshots + Undo/Reapply, review scopes, line comments, branches/push/pull/PRs,
  terminal pane, file tree + viewer, open-in-editor, slash/custom commands,
  command palette, keyboard coverage, find-in-thread, zoom, MCP management,
  settings saving/navigation, cost visibility. (Harness fork/export parity is
  still open — D3.4.)
- **Context budget design** (former `harness-context-budget.md`): implemented in
  `harness/context.ts`; extended by D2.

---

# Part A — Fix phases

Order is deliberate: make the boundary hold (F0) before stopping
corruption/crashes (F1) before usability (F2) before lifecycle (F3). Each phase
is independently shippable.

## Phase F0 — Make the trust boundary hold

**Status:** done 2026-11-14 (residuals listed per item) · **Depends on:** current baseline · **Gate for:** every
later phase and any autonomy claim.

The sandboxed agent must not be able to make the trusted app execute its code,
exfiltrate data while "offline", or talk its way past a deny rule.

- [x] **F0.1 Neutralize agent-planted git config and hooks (C1).** No app git
      call may execute a repository-supplied hook or filter driver. Disable
      hooks on **every** workspace git invocation (`read_git_command`,
      `run_git_with`, stage, commit, switch, pull, push) the way `plugin_git`
      already does (`core.hooksPath=/dev/null`), and neutralize clean/smudge/
      textconv/diff/merge drivers configured in `.git/config`. Candidate
      approaches: an isolated global/system config that empties the driver
      namespaces, plus refusing to run drivers defined only in the repo config.
      `--no-ext-diff --no-textconv` do **not** stop clean filters: the background
      `git diff` and `diff --numstat` refresh executes a planted filter with no
      click (executed 2026-11-14). The open vectors are therefore every read
      (status/diff refresh), `git add` (filter) and commit/switch/pull/push/
      `worktree add` (hooks). Also neutralize `core.sshCommand`,
      `credential.helper`, `gpg.program` with `commit.gpgsign`, `url.*.insteadOf`
      (silently redirects Push) and merge drivers on Pull (by reading). Consider
      running the app's read-only git inside the same offline sandbox as the
      agent's shell, which covers every config key at once. F0.2 does not replace
      this: the sandboxed shell can still write `.git/config` and `.git/hooks`.
      **Done 2026-11-14** (decision: "The app's Git does not trust the
      repository's own settings" in DECISIONS.md). Every workspace git call
      reads the effective config with scopes; repository-scope filter and
      diff drivers are blanked, and repository-scope redirects, ssh/proxy/
      credential programs (network) and signing programs (commit) refuse with
      the key named; `core.worktree` refuses everything; hooks, fsmonitor and
      `ext::` stay forced off; `gh` gets the same through `GIT_CONFIG_COUNT`.
      The read-then-run race is closed by F0.2's `.git` part: the seatbelt
      denies `.git`, `config`, `config.worktree`, `commondir`, `hooks/` and
      linked-worktree redirects, and the edit tools refuse `.git` paths.
      Evidence: native `workspace_git_never_runs_repository_drivers` (planted
      clean/smudge/process/textconv/diff drivers through refresh, review,
      stage, commit, push, pull, switch and worktree; fails without the fix),
      `repository_settings_that_redirect_or_run_programs_refuse_their_operation`,
      and the real-seatbelt `C1` case in `npm run test:sandbox`. Known
      residuals, accepted: repository-only filters (git-crypt) are not applied
      in app views; merge drivers are not neutralized because no app git
      merges; a user `include.path` into the workspace is not protected; the
      seatbelt protects only the workspace root's `.git`, so in a folder of
      several repositories the agent can still plant hooks in a nested
      repository that the user's own terminal git would run (the app's git
      never runs there).
- [x] **F0.2 Protected-path guard (H8, M16).** Add a deny-only guard to the permission
      pipeline that refuses agent edits/writes to `.git/`, `.glitter/`,
      `AGENTS.md`/`CLAUDE.md` (root and nested), and sensitive dotfiles
      (`.env*`, key material) in every mode short of an explicit per-call
      approval. The guard covers the edit tools only; deny the same paths in the
      seatbelt profile so the shell cannot write them either (git itself must
      still be able to update `.git/` for commits the user approved). Make the protected set configurable and visible
      in Settings → Permissions. Add read-deny rules for secrets. Correct the
      README claim that edits show an approval diff in every mode; state the real
      behavior (edits run unasked in Ask/Auto except protected paths).
      **Done 2026-11-14** (decision: "Protected files ask every time; the
      shell cannot write them" in DECISIONS.md). `.git` is a hard deny for
      the edit tools (`gitControlGuard`, landed with F0.1). The protected set
      (`permission/protected.ts`; defaults `AGENTS.md`, `CLAUDE.md`,
      `.glitter/**`, `.agents/**`, `.env`, `.env.*`, `.envrc`, `*.pem`,
      `*.key`, `*.p12`, `*.pfx`, `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`)
      makes an edit ask with allow-once only, in every mode including Full
      access; the seatbelt denies the same paths to the shell and to stdio MCP
      servers (with `node_modules` given back, and parents of anchored
      patterns locked). Settings → Permissions shows and edits the set
      (**Protected files**, Restore defaults), carried by the `harnessRules`
      verb with native validation; the CLI reads the same setting. Read-deny
      is a new `Read(path)` rule kind that refuses `read_file` and `grep` on
      the path and makes `grep` skip it. README now states the real edit
      behavior. Evidence: `H8/M16` and `H8` host tests and the `Read rules`
      test in `tests/harness.test.mjs`, the profile test in
      `tests/isolation.test.mjs`, the real-seatbelt `H8` case in
      `npm run test:sandbox`, DTO tests, and the Settings UI test. Not
      covered: `package.json` scripts (H8) and editor task files such as
      `.vscode/tasks.json` are not in the default set; shell reads of secrets
      are F0.4.
- [x] **F0.3 Fix deny-rule matching (H1, H2).** In `permission/rules.ts`
      `denies()`: unwrap wrappers (`env`, `sudo`, `command`, `nice`, …) reusing
      the `danger.ts` unwrap logic, compare program **basenames** (`/usr/bin/git`
      ≡ `git`), and case-fold path comparisons on case-insensitive filesystems.
      Apply the same normalization to grant `covers()` so allow and deny agree.
      **Done 2026-11-14.** Deny rules compare every form a command could run
      as: the program basename, case-folded; each start after a wrapper's
      options and option values; `env -S` strings; `bash -c` behind a wrapper;
      git with its global options removed; and `xargs` partial matches. Path
      rules and edit grants case-fold on macOS and Windows. Command grants
      deliberately keep literal argv: widening `git status` to `/tmp/x/git
      status` would run another program. Evidence: `H1/H2` test in
      `tests/harness.test.mjs`.
- [x] **F0.4 Close offline egress channels (C2).** Tighten `NETWORK_OFF` in
      `isolation.ts`: block external DNS resolution (the Unix-socket name-lookup
      allowance is the exfil channel), restrict the localhost allowance to what
      dev servers need, and deny the Docker socket and arbitrary Unix sockets.
      Document the offline-capability tradeoff; if name lookup must stay, gate it
      behind the same network permission as outbound IP. (Domain allowlist is D6.7.)
      Feasibility risk: on macOS every name lookup, `localhost` included, uses the
      same system socket, so blocking it may break dev servers; require a test.
      Also deny reads of key material and of the app's own data folder (M18):
      `~/.ssh` private keys and other workspaces' session logs are readable today.
      **Done 2026-11-14** (decision: "Offline commands reach this Mac only, and
      cannot read keys or saved threads" in DECISIONS.md). Reproduced first: in
      the old offline profile `example.com` resolved to a real address. The
      feasibility risk did not hold: measured on this Mac, with the resolver
      socket closed an outside name fails at once while `localhost` still
      resolves and connects, because that name never needed the socket. Offline
      Unix sockets are now allowed only under the folders the sandbox may write
      and `~/.gnupg`; `/var/run/mDNSResponder` and Docker sockets are refused.
      Offline commands cannot read `~/.ssh`, GPG private keys or any workspace's
      saved threads, and every sandboxed child (MCP servers included) cannot read
      the saved threads. Evidence: the real-seatbelt `C2` and `M18` cases in
      `npm run test:sandbox` (the `C2` case fails against the old rule, checked
      by restoring it), and the profile tests in `tests/isolation.test.mjs`.
      Accepted residuals: loopback stays open, so a local proxy or published
      container port is reachable; this Mac's own `.local` name does not resolve
      offline (JVM tests that look it up need `network: true`); a commit signed
      with a key *file* cannot be made from an offline agent shell. Not closed:
      a command that asked for the network, and Full access, can still use the
      Docker socket, and a container can mount the host. That is a separate
      write-sandbox escape and needs its own decision.
- [x] **F0.5 Fail closed on sandbox spawn error (M3).** Remove the unsandboxed
      fallback in `spawnIsolated`; a failed `sandbox-exec` spawn refuses the
      command with a clear error instead of downgrading.
- [x] **F0.6 Fix the danger classifier's git-option gap (M1).** Skip global
      options (`-c <val>`, `-C <path>`, `--git-dir`, `--work-tree`) before locating
      the subcommand in `danger.ts`, so `git -c … push --force` is assessed as a
      force push. The same gap hides `reset --hard`, `clean` and `checkout`
      behind `-C` or `--no-pager`.
- [x] **F0.7 Make the trust prompt real (M15).** An untrusted workspace's skills
      and `AGENTS.md`/`CLAUDE.md` (root and nested) must not enter the prompt.
      Pass the native trust decision to the harness the way MCP authorization
      already travels, and gate `skillsExtension` and `systemPrompt` on it.
      **Done 2026-11-14** (decision: "An untrusted workspace's rules and skills
      stay out of the prompt" in DECISIONS.md). The prompt promised this and
      enforced nothing: "Trust workspace" set only a renderer-side flag the
      native side never read. It now calls `workspace_trust_set`, and
      `workspaceTrusted` reaches every turn, the nested-rules loader, the skill
      list and `/skill` expansion. Untrusted, the model gets nothing from the
      repository and is told so; the user's own `~/.glitter` rules and skills
      still load. Workspaces already trusted in settings are carried to the
      native record when their grant is restored. A worktree thread follows its
      source workspace, a delegated child follows its thread, withdrawing MCP
      approval no longer untrusts, and the CLI gained `--trust`. Evidence:
      `tests/harness.test.mjs` (untrusted, revoked mid-thread, delegated child),
      `tests/regressions.test.mjs` (the decision reaches native; a refusal
      changes nothing; remembered trust is carried), `tests/cli.test.mjs`, and
      native `mcp_consent` tests (worktree inheritance, trust is not an MCP
      approval, revoking MCP keeps trust).
- [x] **F0.8 Guard the approval shortcut (M17).** Ignore key repeat and require a
      short minimum display time before ⌘Y/⇧⌘Y can act on a newly shown card.
      **Done 2026-11-14.** A repeated keydown never decides, and an allow waits
      600 ms after its card came into view (the clock restarts for a different
      card, a thread switch or a refocused window). A deny is never delayed.
      Evidence: `tests/approval-shortcut.test.mjs` for the guard and the wiring.
      The key event itself was not driven in the desktop app.
- [x] **F0.9 Pin bundled MCP servers (M21).** Give every catalog entry an exact
      version, and bind consent to it so a new version needs a new review.
      **Done 2026-11-14** (decision: "Bundled MCP servers name an exact release"
      in DECISIONS.md). All seven `npx`/`uvx` entries name an exact release, the
      newest at least 14 days old. Approval already binds to the configuration
      text, so the release in the text is the binding; a test shows a new release
      changes the digest, and a native test refuses an unpinned launcher. An
      entry an earlier build wrote unpinned can still be removed, and Install
      moves it to the pin. Not run: `uvx name@version` on a machine with uv (none
      here), and starting these servers in the sandbox, which is F2.1.
- [x] **F0.10 Block `.terminal` on default open (L9).** Add it to
      `EXECUTABLE_EXTENSIONS`; review other handler-executed types.
      **Done 2026-11-14:** added `.terminal`, `.tool`, `.fileloc`, `.webloc`,
      `.inetloc`, `.jar`, `.pkg`/`.mpkg`, `.prefPane`, `.mobileconfig`,
      `.shortcut`, `.saver`, `.scptd`, `.applescript`; the native test checks
      every listed extension in upper case.

**Primary surfaces:** `apps/desktop/src-tauri/src/lib.rs` (git calls),
`packages/glitter-harness/src/isolation.ts`,
`harness/permission/{rules,danger,policy,guards}.ts`, `README.md`, Settings →
Permissions UI, `tests/` + native tests.

**Verification:**

- A fixture repo with a planted `.git/config` clean filter and a
  `.git/hooks/pre-commit` marker produces **no** marker and **no** network request
  under any app git button (stage, commit, switch, pull, push) or background
  refresh.
- The agent cannot edit `.git/config` or `.env` in Ask/Auto/Full without explicit
  approval; a regression test pins the protected-path guard.
- `Bash(git push *)` denies `/usr/bin/git push`, `env git push`, `command git
  push`, `git -C . push`; `Edit(.env)` denies `.ENV`.
- An "offline" command cannot resolve an external name or reach the Docker
  socket; a real seatbelt integration test (`npm run test:sandbox`) proves it.
- A failed `sandbox-exec` spawn refuses rather than runs unsandboxed.
- The same fixture's filter does not run during the background status/diff
  refresh, with no button pressed.
- The sandboxed shell cannot write `.git/config`, `.git/hooks` or `AGENTS.md`,
  and cannot read `~/.ssh` private keys or another workspace's session log.
- An untrusted workspace's skills and `AGENTS.md` are absent from the request.
- Holding ⌘Y approves one card, not the next one that appears.
- `npm run verify` passes; the sandbox check is named separately from stubs.

**Exit gate:** a sandboxed agent cannot make the trusted app execute its code,
cannot exfiltrate while offline, and cannot bypass a deny rule by path, wrapper
or case.

---

## Phase F1 — Stop corruption, hangs and whole-process crashes

**Status:** done 2026-11-14 (residuals listed per item) · **Depends on:** F0 · **Gate for:** unattended runs and
long sessions.

A single tool, stream or disk error must not corrupt a file, freeze every
thread, or kill the process.

- [x] **F1.1 Encoding/binary guard on edit and write (C3, L6).** Detect
      non-UTF-8/binary content before editing (reuse the read tool's null-byte
      check, extended to invalid UTF-8); refuse with a clear message rather than
      round-tripping through UTF-8. Preserve original encoding/line endings on
      write. Make the CRLF mismatch error explain the cause.
      **Done 2026-11-14.** `read_file`, `edit_file`, `multi_edit` and `write_file`
      refuse binary, non-UTF-8 and over-8 MB files with a message that says what
      to do; the approval card is not drawn for an edit that cannot run. A file
      with CRLF throughout takes a multi-line edit and keeps its endings; a mixed
      file's error names the cause. A byte order mark survives. Evidence: three
      tests in `tests/harness.test.mjs` (Latin-1 and PNG bytes unchanged, no
      U+FFFD written; the size cap; CRLF and mixed endings).
- [x] **F1.2 Shell exit and pipe semantics (H3).** Resolve the shell tool on
      process **exit**, not only on pipe close; on timeout/Stop kill the whole
      process group **and** any descendant holding the stdout/stderr pipe so the
      call cannot outlive its timeout. Add a hard wall-clock ceiling independent
      of pipe state. Kill background shells when the agent process dies
      uncleanly and drop exited shells from memory (M23).
      **Done 2026-11-14.** The call resolves on shell exit plus a 200 ms drain
      (`sleep 6 & echo started` returns at once), a timeout or Stop ends it
      within 3 s, and `terminateTree` finds descendants before signalling the
      leader and stops those that left the process group. A watchdog process
      kills background shells' groups when the agent is SIGKILLed, and exited
      shells are dropped after 15 minutes or past eight per thread. Evidence:
      five tests in `tests/harness.test.mjs` and the SIGKILL test in
      `tests/isolation.test.mjs`. Not covered: a daemon a command started in an
      earlier call and left running, and any process a command reparented to
      launchd before the kill.
- [x] **F1.3 Bounded, cancellable search and read (H4, H10, L7).** Make
      `htmlToText` linear (or run it off the event loop with a timeout): one
      fetched page with unclosed `<script` tags freezes every thread today. Run `grep` regex off
      the shared event loop (worker with a timeout, or a linear-time engine) so
      one pattern cannot freeze every thread; cancel it on Stop. Add a file-size
      cap to `read_file`. Honor `.gitignore` and make skipped files visible (L7).
      **Done 2026-11-14.** `htmlToText` is one linear pass (600 KB of each
      hostile shape in well under a second; 5 MB of unclosed `<script` in under
      three, against about half an hour), checked for the same output as the old
      version on well-formed pages. `grep` runs in a worker with a 20 s deadline
      and Stop, in batches so it still stops early, with `.gitignore` honored and
      skipped files named. Evidence: tests for the backtracking pattern (the
      event loop never stalled 400 ms), cancellation, `.gitignore` semantics, and
      a hostile `.gitignore`, which found and fixed a stall of its own: V8
      compiles a regex on first use, so an oversized pattern failed outside its
      guard.
- [x] **F1.4 Contain the crash blast radius (C6, M11).** Catch the finalization
      `store.append` in `runTurn`'s `finally` and the `pump → beginTurn` rethrow;
      clear `prompting` on a post-durable failure; surface a per-thread notice
      instead of an unhandled rejection. Audit every `void`'d turn/store promise
      for a `.catch()`. The main trigger is `store.update`, called un-awaited on
      every model call (`accumulateUsage`): it throws after a 5 s index-lock
      wait, for example while the `glitter` CLI is writing. Keep the process-level crash sink for unknown bugs only.
      **Done 2026-11-14.** Fire-and-forget saves go through `contained`, a
      warning per thread at most once a minute; `runTurn`'s finalization cannot
      throw before `turnCompleted`; `guardTurn` and `abandonTurn` settle a turn
      that cannot start or finish, including queued ones; two more unhandled
      paths (a failed read probe, the CLI's approval) are handled. Evidence: four
      tests in `tests/harness.test.mjs` that watch for unhandled rejections.
- [x] **F1.5 Classify mid-stream provider errors (M9).** Overloads are already
      retried (as `TRANSPORT`); the defect is that permanent stream errors are
      retried too. Read the error type in the stream frame: map
      `overloaded_error`/`rate_limit_error` to `SERVER`/`RATE_LIMIT` and treat
      `invalid_request_error` and similar as final. Honor a `Retry-After` longer
      than 20 s when the budget allows instead of retrying early. Add a timeout
      for the wait before response headers (M7).
      **Done 2026-11-14.** Error frames are classified by their own type on all
      three wires; `Retry-After` is honored up to the 120 s budget; a provider
      that sends no headers for 60 s times out and is retried; one SSE event over
      16 MB is refused. Evidence: classification, retry and non-retry, header
      timeout, Stop during the header wait, and oversize-event tests.
- [x] **F1.8 MCP resilience (M19).** Restart a crashed stdio server (bounded,
      with backoff) or mark it failed with a one-click restart; let a tool-name
      collision exclude only the colliding server instead of failing the whole
      generation.
      **Done 2026-11-14.** A dead stdio server restarts on its next call, three
      times at most with a doubling wait, then names the refresh; a colliding
      server is left out alone and named. A server that fails to *start* still
      fails the generation, deliberately (DECISIONS.md, "Harness MCP"). Evidence:
      two tests in `tests/harness.test.mjs`.
- [x] **F1.6 Truthful cancellation (M10).** `cancelTurn` reports the real state
      (`stopping` vs `terminal`) and the UI reflects it; do not return `terminal`
      while a tool is still running.
      **Done 2026-11-14.** `cancelTurn` answers `stopping` while the turn runs and
      the thread shows "Still stopping" without being declared finished.
      Evidence: a host test and a store test.
- [x] **F1.7 Honest persistence and protocol bounds (M6, M7, M12, M13, M14, L3).**
      Notice (don't silently drop) corrupt JSONL lines; cap the SSE buffer; do not
      save a failed partial stream as a completed message then duplicate it on
      retry; make the session index incremental or repairable; make compaction
      item ids restart-safe; label partial streams as partial.
      **Done 2026-11-14, except the index and the log are still read whole**
      (F3.4 owns paging and an incremental index). Unreadable log entries are
      reported; a cut-off reply is marked cut off and a retry overwrites it; the
      index keeps a last-good copy and restores from it with a notice, setting the
      damaged file aside; usage is saved at most every two seconds; compaction
      ids no longer repeat after a restart; the SSE event cap landed with F1.5.
      Evidence: `tests/session-store.test.mjs` and three host tests.

**Primary surfaces:** `harness/tools.ts`, `harness/host.ts`, `harness/wire.ts`,
`harness/store.ts`, `index.ts`, `isolation.ts` (process-group kill), `tests/`.

**Verification:**

- Editing a Latin-1 file and a binary file is refused with a clear message; no
  `EF BF BD` is written; a CRLF edit either succeeds preserving endings or
  explains the mismatch.
- `sleep 6 & echo started` returns when the shell exits, not 6 s later. A
  detached (`setsid`) descendant holding the pipe cannot outlive a 2 s timeout
  (today it returns after the descendant exits); Stop ends the turn either way.
- `htmlToText` on 5 MB of unclosed `<script` tags returns in bounded time and
  does not block other threads.
- A permanent mid-stream error is not retried; a crashed MCP server recovers or
  reports failed.
- `(a+)+$` against a long line cannot block other threads and is cancellable;
  `read_file` on an oversized file refuses instead of OOMing.
- A forced finalization-append failure leaves other threads running and shows a
  per-thread notice; the process does not exit; `prompting` never sticks.
- A scripted mid-stream `overloaded_error` is retried within budget; a retried
  stream does not duplicate transcript text.
- `npm run verify` passes.

**Exit gate:** no single tool, stream or disk error corrupts a file, freezes
other threads, or kills the process; cancellation and timeouts are truthful.

---

## Phase F2 — Make the agent usable on a real project

**Status:** in progress (F2.1, F2.3, F2.4) · **Depends on:** F0, F1 · **Gate for:** daily-driver
adoption.

The agent must install dependencies, undo on a normal repo, find the user's
toolchains, and delegate usefully in the default mode.

- [ ] **F2.1 Writable package-manager caches or an escape hatch (C4, H11).** The
      same decision governs stdio MCP servers, which start in this sandbox: the
      bundled `npx -y …` servers likely cannot start uncached (reproduce in the
      app first; the scripted attempt was blocked). Allow the
      standard cache roots (`~/.npm`, `~/.cargo`, `~/.gradle`, `~/go`, `~/.m2`,
      …; `~/.cache` is already writable) under the write sandbox, **or** add a per-command "run
      unsandboxed" approval that is explicit, scoped and audited. Decide which in
      DECISIONS.md; do not silently widen the sandbox for all commands.
      **Implementation and automated verification done 2026-11-14.** The
      decision "Package managers share bounded writable caches" grants cache
      subdirectories and Cargo's exact lock/bookkeeping files, plus directory
      creation for their parents. Binaries, config and credentials are not
      granted; cache and parent symlinks never grant their targets. Shells and
      stdio MCP use the same profile, without an unsandboxed fallback. Evidence:
      F2.1 tests in `tests/isolation.test.mjs` and real-seatbelt fixtures in
      `tests/sandbox-integration.test.mjs`: first-use caches, forbidden config and
      binaries, parent renames, symlink escapes, `npm install` with an empty
      cache, Cargo git and localhost registry downloads (including cache locks
      and bookkeeping), and an uncached npm-exec MCP tool exchange. All fixtures
      use temporary data and no external registry or provider. `npm run verify`
      passed: 852 Node tests (851 passed, the live-browser test skipped), 500 UI
      tests, 217 native tests and zero audit vulnerabilities. **Packaged app
      reproduction and a bundled pinned server's uncached registry startup are
      still unrun** (owner: repository maintainer); the fixture MCP server is
      not evidence of those checks. F2.1 stays open until they pass.
- [ ] **F2.2 Snapshots that scale (C5).** Snapshot only the files a turn touches
      (plus their pre-turn state) instead of the whole workspace, so Undo works on
      large repos. Keep conflict detection and retention. Raise/remove the
      whole-tree caps once snapshots are scoped. (Foundation for checkpoints D3.3.)
      This also removes the whole-workspace capture on every send (L14). After
      an Undo or Reapply, tell the agent what was restored so its next turn does
      not assume the undone edits exist (M22).
- [ ] **F2.7 Git inside worktree threads (H9).** Add the worktree's git directory
      and the common object store (`git rev-parse --git-dir --git-common-dir`)
      to the sandbox write roots for that thread, without exposing the main
      checkout's working files. Decide how a fresh worktree gets its ignored
      files (`node_modules`, `.env`); today it has none and cannot reinstall.
- [ ] **F2.3 Toolchain PATH and environment (H7).** Extend `extra_bin_dirs()` with
      `~/.cargo/bin`, pyenv, rbenv, bun and a default nvm layout; preserve
      tool-specific variables (`JAVA_HOME`, `GOPATH`, `NVM_DIR`, …) or derive the
      agent environment from the user's login shell. Keep the secret scrub.
      **Implementation and automated verification done 2026-11-15.** Native PATH discovery now adds
      Cargo, pyenv, rbenv, Bun and Go, honors inherited absolute roots and active
      Python environments, and resolves installed nvm defaults/aliases without
      sourcing a shell. The native and Harness environment allowlists preserve
      toolchain settings while dropping credentials and startup hooks. A real
      child-process regression reproduced `JAVA_HOME` being dropped before the
      fix; native fixtures run cargo/python/ruby/bun/node stand-ins with only
      GUI-discovered paths. Numeric/default/LTS/custom-root nvm selection,
      malformed/cyclic aliases and allowlist parity have regression coverage.
      `npm run verify` passed: 856 Node tests (855 passed, the live-browser test
      skipped), 500 UI tests, 221 native tests and zero audit vulnerabilities.
      These fixtures do not claim real compiler builds. **Live verification
      blocked:** a real `JAVA_HOME`-dependent build needs a configured JDK (none
      found in the standard macOS/Homebrew locations), and the packaged
      Finder-launch toolchain check is unrun (owner for both: repository
      maintainer). F2.3 stays open until those checks pass.
- [x] **F2.4 Bubble child approvals to the parent (H6).** A delegated child's ask
      routes to the parent thread's approval card instead of failing closed, so
      subagents can run commands in Ask mode. Keep the child's narrowed tools and
      inherited mode; never widen authority.
      **Done 2026-11-15.** Approval requests surface on
      the active visible ancestor, including from nested children, and identify
      the delegated run. Only allow-once and deny are offered; checkpoint records
      remain in the child, and Stop cancels the waiting request. Headless and
      orphaned children still refuse. Regression tests cover allow, deny, Stop,
      nesting, headless operation and a real sandboxed shell completing after
      approval. `npm run verify` passed: 860 Node tests (one live-browser test
      skipped), 501 UI tests and 221 native tests. A packaged desktop interaction
      has not been driven (owner: repository maintainer).
- [ ] **F2.5 Bill failed attempts to the ledger (M4).** Accumulate usage from
      partial streams on failure/retry so cost is not undercounted on flaky days.
- [ ] **F2.6 Configurable limits (L8).** Make step caps, approval expiry and retry
      budget configurable with safe defaults; document the unattended-run
      tradeoffs. (Auto-resume is D6.8.)

**Primary surfaces:** `isolation.ts`, `snapshots.rs`, `lib.rs`
(`extra_bin_dirs`/`command`), `process.rs`, `harness/host.ts` (delegation, usage),
`DECISIONS.md`, Settings UI.

**Verification:**

- `npm install` succeeds in a fixture project under the chosen cache/escape
  policy; the decision and its security tradeoff are recorded.
- Undo/Reapply works on a repo with >2000 files and a >2 MiB file; conflict
  detection still refuses unsafe restores.
- A fixture using cargo/pyenv/bun resolves its toolchain; `JAVA_HOME`-dependent
  builds run.
- A subagent shell call in Ask mode raises a parent approval card and runs only
  after approval.
- In a worktree thread the agent can `git add` and `git commit`; a bundled
  `npx` MCP server starts on a machine with an empty npm cache.
- After Undo, the next turn's request tells the model which files were restored.
- `npm run verify` passes.

**Exit gate:** the agent installs dependencies, undoes on a normal repo, finds
the user's toolchains, and delegates usefully in the default permission mode.

---

## Phase F3 — Thread lifecycle and data ownership (fix side)

**Status:** not started · **Depends on:** F1 · **Gate for:** trust in local data
handling. (Conversation fork/export/edit-resend is D3.4.)

- [ ] **F3.1 Wire thread deletion (H5).** Add an authorized bridge verb that calls
      `SessionStore.remove()` (index + JSONL), with native session/grant
      authorization and a preview mock; call it from `deleteThread`. Remove the
      thread's delegated child sessions (their logs and index rows) with it. Keep CLI and
      app views consistent. Decide and document whether deletion is recoverable
      (trash) or permanent.
- [ ] **F3.2 Cross-process session lock.** Add a per-session writer lease so the
      app and CLI cannot append divergent histories to one thread; a second
      writer is refused with a clear error, not a README warning.
- [ ] **F3.3 Settings migration notice (L4).** Tell users once that
      `hiddenModels`/`hiddenProviders` were retired in favor of the model library;
      do not silently re-show previously hidden models.
- [ ] **F3.4 Long-thread read performance (L2, M13).** Page or stream the JSONL
      projection instead of loading the whole log; make the index incremental or
      repairable in-app.

**Primary surfaces:** `harness/store.ts`, `harness/host.ts`, `index.ts`, `dto.rs`,
`lib.rs`, `store.ts` (UI), `bridge.ts`, `mock.ts`, `settingsPersistence.ts`,
`tests/`.

**Verification:**

- Deleting a thread removes its JSONL and index entry; it no longer appears in
  the CLI; the chosen recoverability behavior is tested.
- Two processes attempting to write one session: the second is refused cleanly.
- A long thread opens without loading the whole log; a corrupt index is repairable.
- `npm run verify` passes.

**Exit gate:** threads can be deleted truthfully; one session has one writer;
upgrades do not silently discard user preferences.

---

# Part B — Delivery phases

Feature and evidence work, priority-ordered. Benchmark: Oct–Nov 2026 landscape
(Claude Code, Codex, Cursor, OpenCode) — subagents, hooks, skills, MCP, parallel
worktree runs, checkpoints, goal mode and OS sandboxing are shared table stakes.
Glitter's differentiators to protect: native GUI approvals with scoped grants,
conflict-safe per-turn Undo, per-thread worktrees, the shared Playwright browser
for UI verification, the multi-role Orchestrator, and a real cost-capped eval
harness.

Sources: context.dev four-way comparison (2026-10-18); winder.ai harness
comparison (2026-08-20, updated 2026-10-12); Morph and mem0.ai 2026 comparisons;
Stacklok enterprise harness comparison (2026-09-15).

## Phase D1 — Live evidence and quality baseline

**Status:** not started (contract + CI separation done) · **Depends on:** F0–F1
· **Gate for:** every quality claim, D2 tradeoffs, D4.1 parallelism, D5.4
comparison, and the Orchestrator exit report. **Blocked on:** provider keys and
spend; the maintainer with provider access owns model/price selection and runs.

Add repeatable evidence without a hosted service, committed secrets or an
always-on paid CI suite. (Former upgrade Phase 1 + Orchestrator baselines/3.5–3.7.)

- [ ] **D1.1 Opt-in live smoke runner.** Reuse the real `HarnessHost` and a
      temporary fixture workspace; select providers/models explicitly; obtain
      credentials via the keychain or a documented local-only injection; cap
      calls/cost/time; redact results; never run against the user's real repo by
      default.
- [ ] **D1.2 Versioned coding-task corpus.** Bug repair, cross-file editing,
      test-driven change, ambiguous instruction/question, refusal of a dangerous
      action, recovery after tool failure, long tool-output task. Each has a clean
      fixture, bounded budget and executable assertions; no arbitrary repo fetch
      at test time.
- [ ] **D1.3 Score behavior, not prose.** Tests passed, required edits, unintended
      changes, unsafe actions, turns/tool calls, tokens, elapsed, cost,
      interruptions, unrecovered errors. Keep raw evidence local; commit only
      sanitized task definitions and aggregate baselines.
- [ ] **D1.4 Reproducible baseline.** Fix model, effort, provider, harness
      revision, task revision and budget; repeated samples for noisy comparisons;
      a comparison harness gets the same model/workspace/permissions/budget, else
      report no ranking.
- [ ] **D1.5 Orchestrator baselines and tuning.** Record Lead-alone, Builder-alone
      and Small-alone baselines at highest supported effort; run the Balanced
      review experiment (3.6) and consult/pre-route tuning (3.5) as corpus
      comparisons, not guesses; write the exit report (3.7) with chosen defaults,
      evidence and rejected options. Replay a resumed Builder's earlier
      observations into the build report.

**Primary surfaces:** `evals/harness/`, `evals/orchestrator/`, `tests/fixtures`,
`harness/host.ts`, `harness/wire.ts`, usage events, `DEVELOPMENT.md`; CI for
deterministic checks only. No telemetry backend.

**Exit gate:** one documented command produces a bounded, redacted
conformance/quality report; the Orchestrator's chosen defaults match or beat the
Lead-alone baseline's success rate at lower cost per successful task (including
every plan/consult/review/retry call), with no floor or safety behavior weakened.
Subsequent phases compare against this baseline without inventing metrics.

---

## Phase D2 — Long-session coherence

**Status:** not started (implementation exists; quality gate open) · **Depends
on:** D1 · **Gate for:** long unattended tasks.

Extend request-fitting into context management that survives more than
tool-output growth. Model history stays a projection of the durable transcript;
never destructively summarize the user's record. (Former upgrade Phase 2;
subsumes M5, L5.)

- [ ] **D2.1 One request-budget contract.** Account for system prompts, tools,
      text, reasoning/signatures, images, tool arguments/results, provider
      overhead and a model-appropriate output reserve. Estimates are estimates;
      provider usage is accounting truth. An absent output limit/window has a
      documented conservative fallback. **Send an explicit output-token cap on the
      OpenAI-compatible wire (M5).** Improve the chars÷4 estimate for CJK/dense
      code (L5).
- [ ] **D2.2 Cheap deterministic trimming first.** Preserve recent evidence,
      artifact references and explicit elision markers; do not resend output
      already available via a pageable artifact; keep cache implications visible.
- [ ] **D2.3 Bounded semantic compaction of old spans.** Keep latest user intent,
      active task, decisions, file edits, commands, test results, errors,
      approvals, unresolved questions and artifact references; preserve valid
      tool-call pairing and Anthropic thinking signatures; never invent success.
- [ ] **D2.4 Recoverable, inspectable compaction.** A failed/cancelled
      summarization leaves the previous usable history intact; record only durable
      metadata/projection with schema versioning and bounds; no second transcript,
      no silent discard.
- [ ] **D2.5 Honest manual and automatic paths.** `/compact` promises only what is
      supported; automatic compaction runs before the next call when needed, with
      a time/call budget and one clear notice; if no safe compaction is possible,
      stop without new tools and say what remains intact.
- [ ] **D2.6 Validate quality under pressure.** Long sessions with repeated reads,
      large logs, image/tool traffic, multiple decisions and errors that must not
      be forgotten; compare token use, latency, completion and lost-context
      failures against D1.

**Primary surfaces:** `harness/context.ts`, `harness/host.ts`, `harness/store.ts`,
`harness/wire.ts`, `index.ts`, the shared compact command, native DTO/dispatch,
notices/composer context UI.

**Exit gate:** the long-session corpus completes within budget or fails
explicitly without unsafe action, preserving an inspectable full transcript and
showing a measured improvement over the D1 baseline.

---

## Phase D3 — Basic parity (incomplete without these)

**Status:** not started · **Depends on:** F0–F2; D1 for any quality claim ·
**Gate for:** any "top-3" claim.

- [ ] **D3.1 Signed, notarized releases + auto-updater.** Gatekeeper blocks every
      other Mac; there is no update path. Needs an Apple Developer ID Application
      certificate, notarization credentials (and Windows Authenticode for D3.5) —
      **paid, owner decision**. Then a tag-triggered `release.yml` (import cert
      from secrets, `npm run build` with `APPLE_*`, `verify-macos-package.mjs`,
      staple, upload `.dmg`/`.msi`); `tauri-plugin-updater` with `stable`/`beta`
      feeds, offline updater key + backup, previous artifact kept for rollback;
      release artifacts + checksums on GitHub Releases. Governed by RELEASING.md.
- [ ] **D3.2 User-configurable hooks.** Pre/post tool-use hooks (formatter/test
      after edits). The internal registry already has hooks; expose a safe, scoped
      user surface. Consider reading Claude Code-style hooks for ecosystem
      compatibility (Cursor loads them).
- [ ] **D3.3 Checkpoints and `/rewind`.** Per-tool-call checkpoints beyond per-turn
      Undo, building on F2.2's scoped snapshots; rewind to any step.
- [ ] **D3.4 Thread lifecycle parity (fork, export, edit-and-resend).** Former
      upgrade Phase 5; redo Harness export (the old Markdown export rode the
      retired Muse CLI).
      - Fork at an explicit conversation boundary: clone canonical records +
        metadata into a new session without mutating the source; preserve valid
        tool pairing, delegated-parent exclusions, permissions and worktree
        ownership; do not copy active approvals or an uncertain running operation.
      - Wire fork/history-paging/compact through the shared store, slash commands,
        timeline and native DTO/session checks; unsupported operations stay
        hidden/disabled with an accurate reason, never fall through to Muse.
      - Keep file changes separate from conversation operations: forking does not
        restore files; optional reset uses the native snapshot flow with conflict
        detection and clear confirmation.
      - Export + redaction from the canonical Harness log with size bounds;
        preserve thinking/signatures only where format/privacy permit; a redacted
        export excludes provider keys, MCP secrets and hidden child data.
      - Preserve drafts and queued intent across a failed fork/compact/export.
- [ ] **D3.5 Cross-platform strategy.** Windows and Linux builds, or a recorded
      decision to stay macOS-only with rationale. Sandbox seams exist (seatbelt vs
      none); plan bubblewrap/Windows equivalents.
- [ ] **D3.6 Persistent shell state.** cwd/env/virtualenv continuity across calls
      (a session shell) so multi-step workflows do not reset each call.

**Primary surfaces:** RELEASING.md + release CI, `harness/registry.ts` (hooks),
`snapshots.rs` + timeline (checkpoints), `harness/store.ts`/`host.ts`/`index.ts`/
`lib.rs`/`dto.rs`/`lib/commands.ts`/`store.ts`/`AgentTimeline.tsx` + export
components + mocks (lifecycle), platform sandbox code, `harness/tools.ts`/shells.

**Exit gate:** a stranger can install a signed build, update it, hook their own
checks, rewind to any step, fork/export/edit-resend a Harness thread safely, and
trust a published task-success baseline.

---

## Phase D4 — Competitive parity (good to have)

**Status:** not started · **Depends on:** D1–D3 · **Gate for:** feature-count
parity with the leaders.

- [ ] **D4.1 Parallel subagents on existing worktrees.** Former upgrade Phase
      6.3/6.4 + Orchestrator Phase 4 (sequential first, then parallel on disjoint
      files once measured). Improve delegated task usefulness first (bounded
      objective, artifact references, evidence/failure/cap states, parent
      transcript inspection); add concurrent children only with a demonstrated
      task-level win; bound total live descendants and aggregate provider/tool
      use; define cancellation, failure aggregation, approval behavior and
      workspace write conflicts; independent read-only exploration is the initial
      case; concurrent writers need explicit isolation. Highest-leverage parity
      item; the worktrees exist.
- [ ] **D4.2 Narrow tool-authoring contract (6.1).** Document schema/argument
      validation, canonical results, continuation, concurrency, permission
      subject, timeout, cancellation and replay classification. Keep registration
      in-process and trusted until a concrete third-party requirement and a
      separate trust design exist.
- [ ] **D4.3 MCP depth (6.2 + OAuth).** Profile discovery latency, schema tokens,
      generations, tool-result sizes and shutdown with many servers/tools;
      optimize only where measured. Add MCP OAuth, resources and prompts (today
      only static headers work, so most hosted servers cannot connect). Pass
      tool-result images to the model instead of a placeholder, keep activated
      tools across turns without invalidating the prompt-cache prefix (M20), and
      close the protocol gaps in L12 (legacy SSE, session re-initialise,
      `tools/list_changed`, server-side cancel, schema validation).
- [ ] **D4.4 Durable cross-session memory.** A memory substrate that survives
      restarts and projects — the dimension models still handle badly (Letta's
      Terminal-Bench win over Claude Code is the evidence).
- [ ] **D4.5 Language-server diagnostics.** Feed compiler/linter errors back after
      edits automatically instead of via bash.
- [ ] **D4.6 Model fallback chains + per-thread spend caps.** Automatic failover on
      `RATE_LIMIT`/outage and a budget that stops a runaway thread; the cost ledger
      exists.
- [ ] **D4.7 IDE surface or ACP.** VS Code/JetBrains extension, or Agent Client
      Protocol support (Zed/OpenHands speak ACP) as the cheap entry into editors.
- [ ] **D4.8 Semantic code search.** Embeddings/repository map for large codebases;
      ripgrep-backed, `.gitignore`-aware search as the floor (builds on F1.3).
- [ ] **D4.9 CI integration + automated PR review.** GitHub Actions/GitLab agent
      runs and PR review (Codex review, Bugbot are default expectations).
- [ ] **D4.10 Per-project permission rules.** Rules are global today; scope them
      per workspace.
- [ ] **D4.11 Provider breadth + documents.** Bedrock, Vertex, Azure; subscription
      sign-in where terms allow; native Gemini wire; PDF/document attachments.
- [ ] **D4.12 Orchestrator user tuning (Phase 5).** Editable presets, consult and
      review budgets, effort ceilings, plan templates, per-role fallback lists and
      more than one Builder model (e.g. a UI specialist). Expose the internal
      tuning contract in Settings only after D1 supports the defaults.
- [ ] **D4.13 Side chat.** A temporary question that uses the thread's context
      without adding to it; build on fork with discard-on-close.
- [ ] **D4.15 Built-in price table (L11).** Ship prices (including cached rates)
      for first-party providers so cost shows without an OpenRouter-style
      listing; keep the user override.
- [ ] **D4.16 Browser per thread and cross-provider history (L10, L13).** Give
      each thread its own page, or lock the shared one; normalize tool-call ids
      when a thread switches provider.
- [ ] **D4.14 Codemode — defer (6.5).** A model-authored program needs a separate
      execution sandbox, nested permission inheritance, deterministic result
      limits and replay rules. Tool-output savings alone are not sufficient
      evidence; keep out of scope unless a benchmark justifies it.

**Exit gate:** feature-for-feature parity with the leaders on the dimensions that
change a developer's day, each accepted improvement carrying a measured
reliability/latency/context benefit, without weakening approval, isolation,
recovery or total budget bounds.

---

## Phase D5 — Production readiness

**Status:** not started · **Depends on:** D1–D4 · **Gate for:** release claims.

Turn the preceding work into repeatable release evidence, not a claim that unit
coverage equals real-world reliability. (Former upgrade Phase 7 +
production-readiness backlog/verification.)

- [ ] **D5.1 Long-run and resource-bound tests (7.1).** Multi-hour-shaped histories
      with accelerated fixtures, repeated MCP reconnects, large outputs, many
      turns/children, cancellation and relaunch. Bound heap, buffered protocol
      bytes, open processes, listeners, artifact retention and log growth; **fail**
      on unbounded growth, not merely measure it.
- [ ] **D5.2 Crash/fault and adversarial suites (7.2).** Provider hangs, malformed
      streams, filesystem errors, full quotas, process death, revoked grants,
      changed MCP configuration, malicious tool text, repeated stop/resume. Keep
      secrets and private source out of artifacts.
- [ ] **D5.3 Packaged release matrix (7.3).** Trusted and untrusted workspaces,
      sandbox enforcement, provider credentials, cancellation, approvals, restart
      recovery, compaction, fork/export, child inspection. Record macOS/version/
      model/provider and every skip. Includes the packaged desktop smoke test.
- [ ] **D5.4 No-regression baseline comparison (7.4).** Require no correctness or
      safety regression vs the frozen D1 baseline; report task success with run
      counts and variability, unsafe-action rate, recovery rate, token/cost and
      latency. No cherry-picking; no comparing different models as if it isolated
      the harness.
- [ ] **D5.5 Operational documentation (7.5).** Live validation, known provider
      limits, recovery semantics, diagnostics, remaining limitations. Durable
      choices → DECISIONS.md; user-visible → CHANGELOG.md.
- [ ] **D5.6 Repository and hosting verification.** Secret scanning + push
      protection (needs GitHub Advanced Security or a public repo); private
      vulnerability reporting once public; Dependabot PRs appearing; the
      `advisories` workflow green; CI failure notifications reaching the owner;
      Gatekeeper on a second Mac after signing (`spctl -a -vv` reports `source=
      Notarized Developer ID`); website HTTPS+HSTS, long-lived cache on hashed
      assets, HTTP/2, DNS TTLs once hosted; document disk-encryption recommendation
      (`fdesetup status`) in the README.

**Exit gate:** the release evidence supports the specific reliability claims made
for Harness, with no open F0 safety gap and no hidden unrun mandatory check. Any
paid/interactive/unavailable check is marked blocked with a named owner.

---

## Phase D6 — Exceptional (category-defining)

**Status:** not started · **Depends on:** D1–D5 · **Gate for:** moving into the
top-3 conversation rather than matching it.

- [ ] **D6.1 Cloud/background/scheduled agents.** Start a task, close the laptop,
      review a PR from a phone; notification when input is needed. Recurring
      prompts per workspace that run in a worktree with results in a review queue
      (former IMPROVEMENTS L1), needing a background scheduler that survives the
      window closing. The single biggest differentiator Glitter lacks (Codex
      Cloud, Cursor cloud agents).
- [ ] **D6.2 Remote workspaces.** SSH, WSL and Docker (former IMPROVEMENTS L2);
      grants extended to remote roots.
- [ ] **D6.3 Process isolation per thread.** One crash/hang cannot touch other
      threads (a per-session bridge process or worker), complementing F1.4.
- [ ] **D6.4 Verified VM/container sandbox.** Beyond seatbelt (OpenHands-style
      Docker isolation) for untrusted-repo autonomy and fleet use.
- [ ] **D6.5 Orchestrator Teams with merge orchestration.** The Lead splits a plan
      into independent steps, each built by its own Builder session, parallel on
      disjoint files with conflict-aware merge (Orchestrator Phase 4 + D4.1).
      Leapfrogs sequential delegation.
- [ ] **D6.6 A benchmark-leading eval loop.** Publish Terminal-Bench/SWE-bench
      results from the cost-capped eval harness; the harness itself moves scores
      15–35 points on the same model. This is how a newcomer proves top-3.
- [ ] **D6.7 Network egress allowlist by domain.** Replace on/off network with a
      per-domain allowlist (pairs with F0.4).
- [ ] **D6.8 Auto-resume after outage/restart.** Long unattended runs beyond the
      step cap, resuming safely from the checkpoint record (pairs with F2.6).
- [ ] **D6.9 Secret redaction before provider/log.** Redact secrets from content
      before it reaches the provider or the session log (today redaction is
      diagnostics-only).
- [ ] **D6.10 Encrypted transcripts at rest.** Protect local session logs.
- [ ] **D6.11 Fleet/enterprise layer.** SSO, audit logs, managed policy, cost
      attribution across a team — the platform layer above the harness.
- [ ] **D6.12 Self-improving skill memory.** Turn corrected mistakes into durable
      skills automatically (Osmani's ratchet); pairs with the existing skills
      system.

**Exit gate:** Glitter offers something the leaders do not — verified isolation,
merge-orchestrated teams, or a published harness-driven benchmark lead — not just
parity.

---

## Operational readiness appendix

Preserved from the former `production-readiness.md` (operational knowledge, not
forward direction). Release mechanics live in [RELEASING.md](RELEASING.md).

**Owner and escalation.** The repository maintainer
([@srikantmehra57](https://github.com/srikantmehra57)) owns releases and
incidents; issues via GitHub Issues; security reports via `.github/SECURITY.md`.
No second on-call: when the owner is unavailable, nothing ships.

**Build and install (current, unsigned).**

```bash
npm run verify                     # every gate, serially
npm run build                      # .app in apps/desktop/src-tauri/target/release/bundle/macos/
node scripts/verify-macos-package.mjs
```

Then follow AGENTS.md: quit Glitter, move `/Applications/Glitter.app` to the
Trash, `ditto` the new bundle into `/Applications`, move build-folder bundles to
the Trash, launch the installed copy.

**Roll back.** Code: `git revert <bad commit>` on `main`, rebuild; don't rewrite
published history. Users: reinstall the previous artifact (RELEASING.md §6);
settings normalize on read so an older build opens a newer document. If a release
corrupted settings, restart triggers `repair_store_files` (restores
`glitter.json.bak`).

**Find logs.**

| Log | macOS |
|---|---|
| App log (renderer/native events, bridge stderr) | `~/Library/Logs/com.glitter.desktop/glitter.log` (+ `.previous.log`) |
| Security audit (approval decisions) | `~/Library/Logs/com.glitter.desktop/security-audit.log` (+ `.previous.log`) |
| Settings | `~/Library/Application Support/com.glitter.desktop/glitter.json` (+ `.bak`) |

Lines are TSV (`epoch-ms  level  event  detail`); already redacted, but read
before attaching to a public issue.

**Respond to an incident.** (1) Triage in the first hour: reproduce on the latest
build; classify security / data integrity / availability; security stays private.
(2) Contain: pull the download/feed entry, post a pinned issue with a workaround.
(3) Diagnose: collect redacted app log, OS, app version; `git log`/`git bisect`
against the packaged repro. (4) Fix: failing test → fix → `npm run verify` →
package → install-test. (5) Communicate: issue comment, CHANGELOG entry, advisory
for security after the fix ships. (6) Learn: write a postmortem for anything that
reached users or lost data.

**Postmortem template (blameless).**

```markdown
# Postmortem: <short title>
- Date / duration:
- Severity: (security | data integrity | availability | degraded)
- Author:            Reviewed by:

## Impact
Who was affected, how many, what they saw, and any data lost or exposed.

## Timeline (UTC)
- hh:mm detected by …
- hh:mm mitigated by …
- hh:mm resolved by …

## Root cause
The technical chain of events. Describe systems and decisions, not people.

## What went well / what didn't

## Fixes
- Immediate (shipped): commit / release
- Preventive: tests, gates, design changes

## Follow-ups
| Action | Owner | Due | Issue |
```

---

## Suggested sequence

1. **F0** (boundary holds) — non-negotiable first; the security claims must be
   true before anything else.
2. **F1** (no corruption/hangs/crashes) — small, surgical, high value.
3. **F2** (usable on a real project) — unlocks daily-driver adoption.
4. **F3** (lifecycle/ownership fix side) and **D1** (live baseline) in parallel;
   D1 is blocked on keys/spend, so start its offline scaffolding immediately.
5. **D2** (long-session coherence) and **D3** (basic parity), prioritizing D3.1
   signed releases and D3.4 lifecycle.
6. **D4** (competitive parity), prioritizing D4.1 parallel subagents.
7. **D5** (production readiness) gates any release claim.
8. **D6** (exceptional), betting on D6.1 cloud agents + D6.6 published evals.

Phases may overlap where dependencies allow; the order is default delivery, not
a permission to serialize independent investigation.

## Open decisions to record in DECISIONS.md before implementing

- ~~F0.4~~ and ~~F0.7~~: recorded in DECISIONS.md on 2026-11-14.
- F2.7: how a worktree thread gets ignored files (`node_modules`, `.env`).
- ~~F2.1~~: bounded package-cache roots, create-only parents and exact Cargo
  cache metadata files; recorded in DECISIONS.md on 2026-11-14.
- F3.1: deletion recoverable (trash) vs permanent.
- D3.1/D3.5: paid signing certificates and cross-platform commitment vs documented
  macOS-only focus.
- D4.1: concurrent-writer isolation strategy before parallel builders.
- D6.4: VM/container sandbox scope vs the existing seatbelt boundary.

## Consolidation record

On 2026-11-14 this plan absorbed the unfinished, still-relevant work from the
older plans and became the single source of truth.

**Merged and removed:**

- `HARNESS_UPGRADE_PLAN.md` — Phases 0/3/4 recorded as completed foundations;
  Phase 1 → D1, Phase 2 → D2, Phase 5 → D3.4, Phase 6 → D4.1/D4.2/D4.3/D4.14,
  Phase 7 → D5.
- `ORCHESTRATOR_PLAN.md` — Phases 0–3.4 recorded as completed foundations;
  baselines/3.5–3.7 → D1.5, Phase 4 (Teams) → D4.1/D6.5, Phase 5 (user tuning) →
  D4.12. Product design detail remains in DECISIONS.md and the source.
- `IMPROVEMENTS.md` — shipped items recorded as completed foundations; open
  longer-term work L1 (scheduled) → D6.1, L2 (remote) → D6.2, L3 (side chat) →
  D4.13; Harness export redo → D3.4.
- `production-readiness.md` — backlog → D3.1/D5, verification checklist → D5.6,
  runbook + postmortem → Operational readiness appendix.
- `HARNESS_INTEGRATION_PLAN.retired.md` — already retired, all phases complete;
  removed with no open work to carry.
- `harness-context-budget.md` — historical design note, implemented in
  `harness/context.ts` and superseded by D2; removed.

**Also removed (audits and reviews):** the standalone audit report
(`AUDIT_2026-11-14.md`), the `.audit/` workpapers, and the dated peer/competitor
reviews (`HARNESS_REVIEWS.md`, `DEEPSEEK_HARNESS_REVIEW.md`,
`MINIMAX_CODE_REVIEW.md`, `PI_HARNESS_REVIEW.md`, `ZCODE_HARNESS_REVIEW.md`).
Their verified findings live in the register above.

**Kept (durable knowledge, not forward plans):** `AGENT_GUIDE.md`,
`ARCHITECTURE.md`, `DECISIONS.md`, `DESIGN_SYSTEM.md`, `DEVELOPMENT.md`,
`RELEASING.md`.

References to the removed plans in `AGENT_GUIDE.md`, `README.md`, `DECISIONS.md`
and `evals/harness/README.md` were redirected here.
