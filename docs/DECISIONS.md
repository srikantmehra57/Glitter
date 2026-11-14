# Decisions

These are the architectural decisions a new contributor needs to know about. Add
an entry when you make a choice that's expensive to reverse or that later work
must respect. Don't log routine changes here; they belong in git history and
`CHANGELOG.md`.

---

### Toolchains are discovered without running shell startup files

- **Date:** 2026-11-15
- **Decision:** Extend the native app's existing PATH lookup with Cargo, pyenv,
  rbenv, Bun and Go's standard directories. Honor inherited absolute toolchain
  roots, including Java and active Python environments. Read nvm's installed
  `versions/node` directories and default aliases as bounded text; resolve
  numeric versions, `node`, `stable` and alias chains without evaluating shell
  code. Both the native bridge launcher and its shell/MCP children preserve the
  same explicit allowlist of toolchain roots and version selectors.
- **Why:** Finder launches lack the shell's PATH, and a correct PATH alone is
  insufficient when either environment filter drops `JAVA_HOME`, `GOPATH` or
  a version manager's root. Sourcing a login shell would also execute startup
  files and could import credentials or interpreter hooks.
- **Consequences:**
  - The existing Homebrew, Volta, asdf, nodenv, mise and fnm paths remain.
    Only directories that exist enter the augmented PATH. Custom roots must
    be absolute; a multi-root `GOPATH` contributes each absolute `bin` directory.
  - Toolchain settings must be present in the app's inherited environment.
    Shell-only functions, aliases and exports are not imported. A missing or
    unsupported nvm default does not select another installed version;
    without a default alias, the newest installed numeric version is used.
  - Provider, cloud and registry credentials and startup hooks such as
    `NODE_OPTIONS`, `BASH_ENV`, `PYTHONPATH`, `RUBYOPT` and `JAVA_TOOL_OPTIONS`
    remain excluded. PATH discovery adds no filesystem or network grant.
  - Regression coverage compares the two allowlists, launches an actual child
    with toolchain settings and secret sentinels, and runs fixture executables
    from the GUI-discovered paths. Fixtures do not claim real compiler builds.

---

### Package managers share bounded writable caches

- **Date:** 2026-11-14
- **Decision:** Shell commands and stdio MCP servers keep the same write
  sandbox. Both may write npm's `~/.npm`, Cargo's `~/.cargo/registry` and
  `~/.cargo/git` (plus Cargo's exact package-cache lock files and SQLite cache
  bookkeeping files), Gradle's caches, daemon, native, notifications and wrapper
  folders, Maven's `~/.m2/repository`, Go's `~/go/pkg`, Bun's
  `~/.bun/install/cache` and Yarn's `~/.yarn/berry/cache`. Missing parent
  directories may be created, but their other contents are not writable.
  The existing `~/.cache` and `~/Library/Caches` allowances remain.
- **Why:** Package installs and uncached `npx` MCP launchers need these folders.
  Granting whole toolchain folders would also let a command replace binaries,
  change configuration or overwrite credentials. A per-command unsandboxed
  escape would give an ordinary install more authority than it needs.
- **Consequences:**
  - Cache contents are shared across workspaces and can include executable
    package code. An allowed install or MCP launcher may change what a later
    command runs from those caches. Package scripts still run with the child's
    existing sandbox and network policy; this is not a package trust check.
  - The new cache allowances do not follow a symlink to a location outside the
    allowed folders. Creating a cache symlink must not grant its target on a
    later command.
  - Global binary installs, custom cache locations outside existing write
    roots, Cargo configuration and credentials, Gradle properties and Maven
    settings remain outside this allowance. Run those setup steps yourself or
    put a custom cache inside the workspace. Toolchain discovery is F2.3.
  - Offline commands remain offline; stdio MCP startup still requires its
    existing trust and digest-bound approval. No unsandboxed fallback is added.
  - Cargo's `.package-cache`, `.package-cache-mutate`, `.global-cache` and its
    `-journal`/`-shm`/`-wal` sidecars are writable as exact files. A real local
    registry fixture showed that a download can succeed while Cargo silently
    leaves its cache unlocked and untracked if only `registry/` is writable.

---

### One failure stays one failure: tools, streams and saves are contained

- **Date:** 2026-11-14
- **Decision:**
  - **Files.** `read_file`, `edit_file`, `multi_edit` and `write_file` refuse a
    file that is binary, is not valid UTF-8, or is over 8 MB, instead of
    rewriting it through a string. A file whose lines all end in CRLF takes a
    multi-line `old_string` written with plain newlines and keeps its endings;
    a file that mixes them says so.
  - **Shell.** A command is over when its shell exits, plus 200 ms for output
    in flight, not when every pipe closes. A timeout or Stop ends the call within
    3 s whatever holds the pipes, and terminating a command also signals the
    descendants it started in other sessions, found before the leader is
    signalled. A small watchdog process kills background shells' process groups
    if the agent process dies without running its exit handlers.
  - **Search.** `grep` runs in a worker thread with a 20 s deadline and Stop; it
    reads files in batches, so a broad search still stops as soon as it has its
    answer. `grep` and `list_files` honor `.gitignore` (root and nested; no git
    process, no global excludes) and say what they left out;
    `include_ignored` turns that off. `htmlToText` is a single linear pass.
  - **Crashes.** Every fire-and-forget save is contained: a failure becomes one
    warning on its thread per minute. `runTurn` always reports its end, a turn
    that cannot start after its message was saved is settled, and a second net
    under every started turn turns a bug into a failed turn, not an exited
    process. The process-level crash sink stays for what nothing else catches.
  - **Providers.** A mid-stream error frame is classified by its own type:
    overload, rate limit and timeout retry; a bad request, a refusal or an
    exhausted quota do not. A `Retry-After` is honored up to the 120 s retry
    budget. A provider that never sends headers times out after 60 s, and one
    event larger than 16 MB is refused.
  - **Persistence.** An unreadable log entry is reported when a thread opens. A
    reply cut off by an error is saved as cut off, and a retry writes over it
    instead of adding a second copy. The index keeps a copy of its last good
    state and falls back to it. Usage totals are saved every two seconds at most.
  - **MCP.** A stdio server that exits is started again on its next call, up to
    three times with a doubling wait, and then says to refresh. A call that was
    running when it died is never repeated. A server whose tool names collide is
    left out alone.
  - **Stop.** `cancelTurn` answers `stopping` while the turn is still running.
- **Why:** Each of these let one bad file, page, pattern, provider answer or
  full disk freeze or end the single process every thread shares, or corrupt a
  file silently.
- **Consequences:**
  - A server that fails to *start* still fails the whole MCP generation: the
    all-or-nothing swap in "Harness MCP" below stands for that case, because a
    partial tool list after a configuration change is the stale-authority
    problem it was written to avoid.
  - A `.gitignore` pattern with more than three wildcards, or longer than 512
    characters, is ignored: a search then looks at more, never less.
  - A process that left its session and is not a descendant of the command, a
    daemon it started earlier for example, is not stopped.
  - Not done here: paging the thread log on open and an incremental index (L2,
    M13's second half) wait for F3.4; the index is still rewritten whole, only
    less often.

---

### An untrusted workspace's rules and skills stay out of the prompt

- **Date:** 2026-11-14
- **Decision:** A workspace's own `AGENTS.md` and `CLAUDE.md` (root and nested)
  and its `.glitter/skills` and `.agents/skills` reach the model only while the
  user has trusted that workspace. Untrusted, the model gets nothing from the
  repository, and its system prompt says so, so it does not go looking. The
  user's own `~/.glitter/AGENTS.md` and home skills are theirs and always load.
  The decision is the native record that already carried MCP trust
  (`mcp_consent.rs`): it rides to the agent as `workspaceTrusted` with
  `startSession`, `resumeSession`, `sendTurn` and `listSkills`, is read again on
  every turn, and reaches each contribution as `TurnContext.workspaceTrusted`.
  Revoking it takes effect on the next message.
- **Why:** The trust prompt promised this and enforced nothing: "Trust
  workspace" only set a flag in the renderer's settings document, which the
  native side never read, and only MCP startup checked trust. A cloned
  repository could put instructions or a skill in front of the model before
  the user decided anything.
- **Consequences:**
  - "Trust workspace" and "Stop trusting" now call `workspace_trust_set`. A
    workspace remembered as trusted by the settings document is carried to the
    native record when its grant is restored; syncing only raises trust.
  - Approving MCP startup still trusts the workspace. Withdrawing that approval
    does not untrust it: rules and skills are a separate decision.
  - A worktree thread is trusted while the workspace it was made from is, found
    through the app's own worktree store. It never trusts that workspace in
    return, and its MCP approval is its own.
  - A delegated child follows the thread it works for.
  - The CLI has no trust prompt, so it starts untrusted. `--trust` loads the
    folder's rules and skills; `--mcp` implies it.
  - Open question answered: an untrusted workspace's rules are not shown to the
    model and not sent anywhere. The trust dialog still previews them to the
    user.

---

### Offline commands reach this Mac only, and cannot read keys or saved threads

- **Date:** 2026-11-14
- **Decision:** A shell command that did not ask for the network runs under a
  profile that allows loopback and Unix sockets only under the folders the
  sandbox may write (the workspace, temp, caches) plus `~/.gnupg`, and nothing
  else. It cannot connect to `/var/run/mDNSResponder` (the system resolver) or
  to a Docker socket. Offline commands also cannot read `~/.ssh`,
  `~/.gnupg/private-keys-v1.d`, or the saved threads of any workspace
  (`GLITTER_HARNESS_DIR`, `~/.glitter/harness` and the app's own `harness`
  folder); every sandboxed child, MCP servers included, cannot read the saved
  threads.
- **Why:** The old rule allowed every Unix socket "for name lookup". The
  resolver daemon answers any name for any caller, so a command with no route
  could send data out as a hostname (`<data>.attacker.example`), and a Docker
  socket gives a container the network. Measured on macOS, closing the resolver
  socket makes an outside name fail at once and leaves `localhost` working,
  because that name resolves without it. A private key or another project's
  conversation printed by an offline command goes straight into the model's
  context.
- **Consequences:**
  - This Mac's own `.local` name does not resolve offline. Some JVM and Hadoop
    style tests look it up; run them with `network: true`.
  - A commit signed with a key *file* cannot be made from an offline agent
    shell. An agent-held key (ssh-agent, gpg-agent) still signs, and the app's
    own Commit button is unaffected.
  - Loopback stays open on purpose: dev servers, test databases and browsers
    need it. A local proxy or published container port the user runs is
    reachable through it. This is not closed.
  - Not closed: a command that asked for the network, and Full access, are not
    narrowed, so the Docker socket stays reachable there, and a container can
    mount the host. Removing it needs its own decision.
  - Domain-level egress control is D6.7.

---

### Bundled MCP servers name an exact release

- **Date:** 2026-11-14
- **Decision:** Every npm and PyPI launcher in the bundled catalog names an
  exact release (`@modelcontextprotocol/server-memory@2.0.1`,
  `mcp-server-time@2026.10.28`), never a bare name or `@latest`. Each is the
  newest release at least 14 days old on the day it was pinned, and a native
  test refuses an unpinned launcher. Moving to a newer release is a deliberate
  edit.
- **Why:** MCP startup approval binds to the text of the configuration. An
  unpinned `npx -y pkg` never changes that text, so a new, compromised or
  broken release ran under an approval that still looked current. With the
  release in the text, a new one changes the digest and needs a new review.
- **Consequences:** An entry that an earlier build wrote unpinned is still the
  store's own: Remove accepts it and Install brings it to the pinned release,
  which changes the text and asks for approval again. The pinned releases are
  older than the newest ones on purpose. `uvx name@version` is uv's documented
  form; it was not run on a machine with uv.

---

### Native workspace Git skips repository hooks

- **Date:** 2026-11-14
- **Decision:** Git commands started by the app for a workspace, including
  background reads, worktree operations, commit, push and pull, override
  `core.hooksPath` to disable hooks and disable `core.fsmonitor`. A project can
  still run its own checks through the terminal.
- **Why:** The agent can change repository metadata, while the app's Git runs
  with the app's authority. A repository hook must not cross that boundary.
- **Superseded in part by** "The app's Git does not trust the repository's own
  settings" below, which covers filters, drivers and redirects as well.

---

### The app's Git does not trust the repository's own settings

- **Date:** 2026-11-14
- **Decision:** Before each workspace Git command (status and diff refresh,
  review, stage, discard, commit, switch, worktree creation and handoff, push,
  pull, and `gh`), the app lists the effective configuration with its scopes
  (`git config --list --show-scope`) and treats only the *local* and
  *worktree* scopes as the repository's. It then:
  - blanks every repository-defined `filter.*.clean/smudge/process` (and sets
    `required=false`), `diff.*.command/textconv` and `diff.external` with `-c`,
    so the zero-click background refresh runs no planted driver;
  - refuses a push, pull or pull request when the repository sets
    `url.*.insteadOf`/`pushInsteadOf`, `remote.*.uploadpack/receivepack/vcs/
    proxy`, `core.sshCommand`, `core.gitProxy`, `core.askPass`, a credential
    helper, or an `http.*` proxy, certificate or resolve override;
  - refuses a commit when it sets a `gpg.*` program or SSH key command;
  - refuses everything when it sets `core.worktree`;
  - always forces `core.hooksPath=/dev/null`, `core.fsmonitor=false` and
    `protocol.ext.allow=never`. `gh` gets the same settings through
    `GIT_CONFIG_COUNT`, which every Git it starts reads.
  The listing and the command read config a few milliseconds apart, so the
  agent must not be able to change it in between: the shell's seatbelt denies
  writes to the workspace's `.git` entry itself, `.git/config`,
  `config.worktree`, `commondir`, `.git/hooks`, and each linked worktree's
  `config.worktree`/`commondir`/`gitdir`; the edit tools refuse any path with
  a `.git` component in every mode.
- **Why:** The 2026-11-14 audit executed a planted clean filter through the
  background `git diff --numstat` refresh with no click: `--no-ext-diff
  --no-textconv` do not stop clean filters. Running the app's Git inside the
  agent's sandbox was rejected because push and pull need the user's network,
  credential helper and SSH agent, and Git LFS (a global filter) must keep
  working. Treating global and system config as the user's keeps LFS and the
  user's own credential helper and signing setup intact. A refusal names the
  key and the `git config --local --unset-all` that removes it, rather than
  silently ignoring a setting the user may have chosen.
- **Consequences:** Filters a repository defines for itself (for example
  `git-crypt`, which installs into local config) are not applied by the app, so
  those files can show as changed in its Git views; the terminal is unaffected.
  The agent cannot run `git init` at the workspace root, change local Git
  config (`git config`, `git remote add`, `push -u`'s upstream), create linked
  worktrees itself, or install hooks; the user does these, and the app has its
  own Initialize and worktree actions. `git add` and `git commit` in the shell
  still work. Merge drivers are not neutralized because no app Git command
  merges (pull is fast-forward only). An `include.path` the user points at a
  file inside the workspace is read but not protected from the agent.

---

### Protected files ask every time; the shell cannot write them

- **Date:** 2026-11-14
- **Decision:** A user-editable set of workspace path patterns (Settings →
  Permissions → Protected files; defaults: agent instructions `AGENTS.md`,
  `CLAUDE.md`, skills folders `.glitter/` and `.agents/`, `.env`, `.env.*`,
  `.envrc`, and key files) is protected. An edit tool asks before each change
  to one, in every permission mode including Full access, and the card offers
  allow-once only, so approving one change never approves the next. The
  shell's seatbelt and stdio MCP servers cannot write them at all. `.git` is
  stricter: the edit tools always refuse it and it is not configurable.
  Files under `node_modules` are exempt. Settings store the list only once
  the user changes it, so later defaults reach everyone else. Reading is
  governed separately by deny-only `Read(path)` rules, which also keep
  `grep` out of the file.
- **Why:** Edits run unasked in Ask and Auto, and the audit found that an
  agent could make its own instructions permanent (M16) or change secrets and
  `direnv`'s `.envrc` (which runs on `cd`) unseen (H8). These files outlive
  the turn, so a per-call look is cheap insurance. The shell gets a hard deny
  rather than an ask because a command cannot be previewed as a diff, and the
  edit tools give the agent a reviewable way to make the same change.
- **Consequences:** The agent's shell cannot run `cp .env.example .env`,
  generate a key file, or write `AGENTS.md`; it uses the edit tools, which
  ask, or the user removes the pattern. A headless `glitter -p` run refuses a
  protected change even in full access. Seatbelt matches the way APFS does,
  so case variants are denied too. Shell reads of secrets are not limited
  here (F0.4).

---

### The model library is what the user adds

- **Date:** 2026-11-14
- **Decision:** Settings → AI has one page, **Models & providers**, in place of
  the Models and Providers tabs. The composer's picker, the new-thread defaults
  and the Orchestrator role lists offer exactly the models the user added to
  the model library — not every model each provider lists. An entry carries the
  metadata the user chose: display name, context window, effort levels with one
  default, and image, document and video support that may stay unknown. The
  harness persists the library (`models.json`, 0600, beside the session store)
  and is its only writer; the renderer edits it through four new bridge verbs
  (`modelLibraryList`, `modelLibraryPut`, `modelLibraryRemove`,
  `listProviderModels`). At runtime the precedence is: learned window (the
  provider's own overflow statement) → the library entry → the live catalog row
  → the family table; user-set effort levels replace `effortTiers` entirely. A
  first run seeds the library once from the models past threads actually used
  (thread model, manual model, Orchestrator roles), and the renderer quietly
  adds any saved default or role model that predates it. The add-model dialog
  fetches the chosen provider's own listing for suggestions
  (`listProviderModels`, scoped and cached) and pre-fills what it reports;
  `hiddenModels`/`hiddenProviders` are retired.
- **Why:** Fetching every model from every provider buried the picker and left
  context windows and reasoning levels to family-regex guesses. Making the
  library explicit keeps the picker clean and puts one source of truth — the
  user — behind the metadata turns depend on.
- **Consequences:** A model not in the library cannot be sent to, and an empty
  library means an empty picker until the user adds one. Deleting the file
  re-seeds from session history only. The scoped suggestion listing is a second
  consumer of the catalog fetch path; both share the credential-keyed cache.
  The `glitter` CLI lists models through the same host method, so its `/models`
  shows the library too; a model id typed at `/model` still resolves when the
  provider accepts it.

---

### The `glitter` CLI shares the app's engine and state

- **Date:** 2026-11-13
- **Decision:** `glitter` (`packages/glitter-harness/src/cli.ts`) runs
  `HarnessHost` in its own process, with no bridge and no native shell in
  between. It reads the provider keys from the app's Keychain entry
  (`com.glitter.desktop` / `provider-keys`), the defaults and permission rules
  from the app's settings file, and uses the app's harness folder for threads
  and the model library. Environment keys override saved ones.
- **Why:** A thread should move between the terminal and the app, and the user
  should set a provider up once.
- **Consequences:** The harness folder has two writers. The session index is
  re-read when its file changes and is written under `index.json.lock`, so
  neither process drops the other's threads. Anything else in that folder that
  both processes write needs the same treatment. The CLI is outside the native
  trust boundary: it has no workspace grants or MCP approval records, so it
  refuses `/` and the home folder as a workspace and starts MCP servers only
  with `--mcp`. A headless run denies any step that needs approval. The app
  bundle ships `cli.js`, and `npm run install:cli` writes a launcher that runs
  it with the bundled Node rather than a system Node.

---

### Harness is the only agent runtime

- **Date:** 2026-11-13
- **Decision:** Glitter runs its own Harness with the provider or local model
  selected by the user. The Muse MSP and third-party ACP integrations, their
  connection settings and their agent-specific UI are retired. This supersedes
  earlier decisions below that kept those integrations alongside Harness.
- **Continuity:** Harness retains its JSONL session store and native workspace
  grants. Existing Muse and ACP histories stay in those CLIs' own storage;
  Glitter neither converts nor deletes them. Retired keychain entries remain in
  the keychain rather than being deleted on launch.
- **Surfaces:** The model picker lists model providers; Settings → Providers
  manages their credentials. The `glitter` terminal CLI runs the same Harness
  engine with the app's provider keys and session store (see the next entry).

### An unknown context window is learned from the provider's own rejection

- **Date:** 2026-11-13
- **Decision:** A model whose window no catalog row or family table knows is
  treated as unknown until evidence arrives, not as unmanageable. When the
  provider rejects a request as an overflow, the harness parses the limit out
  of the provider's prose (`parseContextLimit` in `wire.ts`, anchored to
  maximum-phrasings so a prompt-size count is never mistaken for the window)
  and adopts it for the model: the window resolution becomes learned → catalog
  → family (`windowFor` on the host). A learned window drives the same retry
  the known-window path gives — the refit fits the real budget — and from the
  next call on, trimming, auto-compaction, the context meter and the
  orchestrator's `long_context` capability all behave as if the window had been
  listed. A rejection that states no number still gets one recovery retry
  against half the estimated request; a second rejection stands. Learned
  windows live for the host's lifetime and are cleared when the credential set
  changes, the same trigger that rebuilds the catalog cache, so a re-pointed
  custom endpoint re-learns. The once-per-model capability notice stays: it is
  accurate while the window is unknown and stops once one is learned, and a
  catalog-listed window now counts there too (it previously read only the
  family table and announced listed models as unknown).
- **Why:** An unknown window previously disabled every safeguard at once — no
  fitting, no overflow retry, no auto-compaction, no context reporting — so a
  long thread on a custom endpoint died on its first overflow with no
  recovery. The provider's rejection is the one authoritative statement of the
  real limit, and it costs one failed request to obtain. This supersedes the
  2026-10-23 decision below in one respect: an unknown window no longer keeps
  the request unchanged through an overflow; it keeps it unchanged only until
  the provider says otherwise.

### The built-in agent compacts its own model history

- **Date:** 2026-11-07
- **Decision:** A known model window and a request estimated above 80% of its
  input budget trigger a tool-less summary between tool rounds, after at least
  six history messages. `/compact` and the context card offer the same action
  while the thread is idle. The thread's model writes the summary with a
  two-minute limit; the latest user request remains separate and retains its
  image parts. A bounded transcript gives the summary the original request and
  recent work, and says when older entries were omitted.
- **Recovery:** Save the compacted model projection before replacing live
  history; the append-only transcript remains the source of truth. A failed,
  truncated or cancelled summary leaves the previous projection intact. Do not
  compact while an unanswered question or staged plan depends on model history.
  Automatic failures fall back to request fitting, which either fits safely or
  stops with a context error. Clear the old reported context count until a
  provider reports the next request's usage.
- **Scope:** Muse delegates compaction to its CLI. Third-party ACP adapters do
  not expose it. Summaries can miss details, and no automated test establishes
  coding quality with a live provider under long-session pressure.

### Orchestrator separates judgement from execution in the built-in harness

- **Date:** 2026-10-26
- **Context:** A long tool loop pays one model for both high-judgement decisions
  and repetitive reading and typing. Automatic model selection was explicitly
  out of scope without a product decision; [REMEDIATION_PLAN.md](REMEDIATION_PLAN.md)
  carries the remaining Orchestrator delivery and evaluation gates (D1.5, D4.12, D6.5).
- **Decision:** Build Orchestrator as an opt-in mode for the built-in Harness
  agent, off by default. The user assigns the Lead, Builder, Small-task and
  Router roles; providers are independent and the app never infers a role from
  a model's name. Manual mode, Muse and external agents are unchanged.
- **Architecture:** Orchestration is a fixed app-driven pipeline, not open-ended
  model-driven delegation through the `task` tool. Each role works in its own
  session. Only bounded, validated, provider-neutral handoff documents cross
  sessions; provider reasoning blocks, signatures and tool-call history never
  do. The Lead session persists for the thread, while Builder and Small-task
  sessions are fresh per plan or direct turn.
- **Safety and accounting:** Every stage keeps the existing permissions,
  approvals, cancellation and same-model retry behavior. Routing never weakens
  a risk floor or substitutes an unavailable role silently. Usage is counted
  per model call, including planning, consultation, review and repair. New live
  evaluations are opt-in and cost-capped.
- **Release gate:** Balanced cannot be recommended from unit tests alone. The
  fixed corpus must compare Lead-alone, Builder-alone and Small-alone baselines
  with complete Orchestrator accounting, and show matching task success at a
  clearly lower cost per successful task before Phase 2 ships.

### Settings is a page, and the picker lists providers, not agents

- **Date:** 2026-10-22
- **Context:** Glitter grew from a Muse client into an agent harness, but its
  surfaces still framed it as one: Settings opened on a Muse Account page, and
  the model picker nested the built-in agent's providers under an "Agents"
  section with Harness as one more row, so picking a model took three levels.
- **Decision:** The model picker has two levels, providers then models. Each
  provider the built-in agent has a key for is a provider, and every other
  installed agent (Muse, Cline CLI…) is one provider of its own. Choosing a
  model from another agent's provider switches the thread's agent
  (`chooseAgentModel`), exactly as the old agent row did. Settings is a
  full-window page with four groups (AI, Workspace, App, System) named once in
  `lib/settingsNav.ts`; the Account page is gone and Muse's connection lives on
  Agents. A remembered Account page opens Agents.
- **Hidden models:** `hiddenModels` (agent, provider and model, so the same id
  under two providers stays distinct) takes a model out of the picker only. The
  catalog, a thread already on it and the default-model menu are unaffected, and
  the thread's current model is never hidden from its own picker.
- **Testing a model:** a `testModel` bridge verb runs one tool-less, one-word
  completion through the built-in agent and returns only its timing and a short
  reply. It reaches no session, transcript or log, and the DTO refuses any agent
  but the built-in one: a CLI agent's model could only be checked by starting a
  session, which the app will not do behind the user's back. Keys are injected
  natively, as for every built-in agent call.
- **Consequences:** Another agent's catalog loads when its provider is opened or
  a search needs it, so opening the picker never starts an agent CLI by itself.


### Plugins install from GitHub, reviewed before they run

- **Date:** 2026-11-13
- **Context:** The bundled store only grows with a release, and the plugins
  people actually use live on GitHub: Claude Code plugins and marketplaces
  (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`), Codex
  plugins (`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`) and
  plain Agent Skills repositories. Extensions had no way to reach them.
- **Decision:** `src-tauri/src/plugins.rs` fetches and installs them. The user
  pastes a repository (`owner/repo`, a github.com or clone URL, or a `tree/`
  link); the native side builds `https://github.com/<owner>/<repo>.git` from the
  validated name and fetches one commit with the system `git` into
  `~/.glitter/cache/github/<token>`. It reads a plugin (skills, commands, MCP
  servers, plus the agents, hooks and LSP servers it cannot run), a marketplace
  (each listing's source: this repository, another GitHub repository, pinned
  or not), or a folder of skills, and returns a preview and the token.
  Installing reads that same staged folder again, so what is installed is what
  the user saw. A marketplace becomes a *source*: its listings show in
  Discover, and each one is fetched and previewed before it installs.
- **Where it lands:** the plugin's files are copied to
  `~/.glitter/plugins/<id>/source` (regular files only, bounded in count and
  size), its skills to `~/.agents/skills/<name>` with a marker naming the
  plugin, its commands as skills there too (so `/name` calls them), and its
  servers into `~/.glitter/mcp.json` with `${CLAUDE_PLUGIN_ROOT}` pointed at the
  installed folder. `plugin.json` beside the files records the origin commit
  and exactly what was written. Turning a plugin off takes the skills and
  servers back and keeps the files, so turning it on needs no network.
- **Trust:** the renderer sends a source string, a token and a list of names,
  never a path or content. `git` runs with prompts off, `protocol.allow=never`
  except https, `core.symlinks=false`, no hooks and no submodules, under the
  network timeout; private repositories work through the user's own git
  credentials. Thumbnails are a plugin's own logo from its manifest, or the
  owner's GitHub avatar fetched with `curl --proto =https`, both sniffed by
  their bytes and handed to the webview as data URLs, so the CSP stays
  `img-src 'self' data: blob:`. Nothing runs at install: skills are text, and a
  server only starts when a built-in agent thread starts MCP, where its tool
  calls follow the thread's permissions as before. The preview lists every
  server's command line and the variables it expects.
- **Ownership:** as in the store, a skill folder is removed only when its marker
  names this plugin (store markers never match a plugin's folder, and the other
  way round), and a server only while its entry is still exactly what was
  written. A skill or server name already taken is skipped and reported, never
  overwritten. Two plugins with the same name from different repositories are
  refused; reinstalling from the same repository is an update.
- **Consequences:** Updates compare the recorded commit with `git ls-remote`
  of the same branch; a plugin pinned to a commit has nothing to compare. An
  update is a fresh preview of the latest commit that keeps the user's choice
  of parts. Agents, hooks and LSP servers are shown and counted but not
  installed until the built-in agent can run them.

### The extension store ships inside the app

- **Date:** 2026-10-22
- **Context:** Extensions listed only what already existed — the Muse CLI's
  skill and plugin inventories and the servers in `.glitter/mcp.json`. A fresh
  install with no CLI showed three empty sections and gave no way to get an
  extension without a terminal.
- **Decision:** A curated catalog is compiled into the app
  (`src-tauri/src/catalog.rs`, with each skill's `SKILL.md` pulled in by
  `include_str!`). It has three kinds: a `skill`, an `mcp` server, and a
  `plugin`, which is a named bundle of skills and servers rather than a runtime.
  Installing writes skills to `~/.agents/skills/<id>` and merges servers into
  `.glitter/mcp.json` — the home folder's file, or the workspace's for a
  workspace-scoped server such as the filesystem one. Installs serve the Harness
  only; the CLI's own inventories are untouched, and "Plugin" keeps its CLI
  meaning in the CLI section of the same screen.
- **Trust:** The renderer sends an entry id and a workspace grant, never
  content. Skill text and server definitions come only from the compiled
  catalog, so no install can write a file the app did not ship. Installing
  something that writes MCP config is confirmed first, naming each server,
  because a server is a command line; per-call approval is unchanged.
- **Native writer, deliberate duplicate:** `harness/mcp.ts` already adds and
  removes servers, and that path stays the one behind the "Add server" form,
  because it also reconnects the running generation. The store writes the same
  file natively instead, because installing must work with no host, no session
  and no CLI, and because it has to preserve keys and legacy bare maps it did
  not write while claiming only what it did. Two writers, one file: keep the
  merge rules and the 0600/0700 modes in sync when either changes.
- **Ownership:** A store-installed skill folder carries
  `.glitter-catalog.json` with its id and version; removing deletes only a
  folder whose marker matches. A server is removed only while its command,
  arguments, environment and URL are still exactly what the catalog wrote.
  Anything the user edited is left in place and the store says so, which is why
  a partial install is reported rather than quietly skipped.
- **Consequences:** The library grows with an app release, not at runtime:
  adding an entry is a Rust change plus its `SKILL.md`. Nothing is downloaded,
  so there is no registry to trust and the store works offline.

### The product is called Glitter

- **Date:** 2026-10-21
- **Context:** The app began as Muse Code Desktop, a GUI for Meta's `muse`
  CLI, and has grown into an independent agent harness. "Muse Code" is also
  Meta's own name for that CLI and its subscription.
- **Decision:** The app, its packages (`glitter`, `@glitter/desktop`,
  `@glitter/harness`, `@glitter/website`), the bridge folder
  (`packages/glitter-harness`), the Node sidecar (`glitter-node`), the crate
  (`glitter`) and the bundle identifier (`com.glitter.desktop`) are named
  Glitter. "Muse" and "Muse Code" stay wherever they name Meta's CLI, agent,
  SDK or subscription.
- **Migration:** The identifier named the app data and log folders and the
  keychain service. On first launch `legacy.rs` moves a Muse Code install's
  settings document (renamed `glitter.json`), harness threads, turn snapshots
  and logs across, copies each keychain entry to the new service before
  deleting the old one, and leaves a marker so later launches skip it; a failed
  step is retried next launch. Worktrees are not moved: their paths live in
  each repository's git metadata, in the grants and in every agent CLI's own
  session store, which the app cannot rewrite. They stay in the old data
  folder, the worktree commands accept that folder as a second store
  (`legacy_worktree_store`), and it is removed once its last worktree is.
  Their `muse/` branches and `refs/muse/` snapshot refs are still cleaned up.
- **Consequences:** macOS may ask once per keychain entry before Glitter can
  read what Muse Code saved. Running Muse Code and Glitter side by side is not
  supported.

### Suggestion turns cannot read the workspace

- **Date:** 2026-10-15
- **Decision:** Predictive suggestions run on a host that is not the user's
  session host. The OS sandbox denies reading that workspace: seatbelt appends
  a last-match `file-read-data` deny, and bubblewrap mounts an empty directory
  over the project after the writable binds. The prompt carries file names,
  the branch, uncommitted paths, and thread titles. The deny root is fixed at
  spawn, so a different workspace restarts the quiet Muse host. Do not deny
  `/`, the home directory, or temp, and do not re-allow a config path that
  contains or sits inside the workspace.
- **What stays unwrapped:** The interactive Muse host. An outer write sandbox
  there prevents `sandbox_apply` in shell commands the user approves. The
  quiet host disables write and shell, so wrapping only that process is safe.
  ACP suggestions use their own host: its cwd is the temp directory, and the
  workspace is not a write root. Windows has no seatbelt or bubblewrap; the
  cwd and the omitted path are the best effort there.
- **Failure:** If the quiet host cannot start under the deny, the empty state
  keeps the static tiles.

### Agent catalogs and Contributor routing follow the current CLI protocol

- **Date:** 2026-10-13
- **Decision:** ACP models come from the agent's initialization metadata or
  session config options. OpenCode v2's interactive `models` command is not a
  catalog API. Before a user thread exists, create a prompt-free session in
  the confined temporary directory, then close it if the agent supports closing.
  Share concurrent discovery requests, invalidate on a new process and force
  discovery on Rescan. Keep authentication errors visible and preserve the
  usable catalog if a refresh fails.
- **Contributor routing:** Muse subscriber Contributor mode is a CLI setting,
  separate from a model ID. An explicit choice in Settings → Models becomes
  `--contributor-mode on|off` when the host restarts. No choice means no flag,
  preserving the user's CLI preference. Do not synthesize Contributor variants
  from base rows or silently enable training consent. Keep actual legacy
  pay-as-you-go Contributor rows and selections supported.
- **Sources:** [OpenCode ACP configuration](https://dev.opencode.ai/v2/docs/cli/acp/)
  and [Muse CLI changelog](https://dev.meta.ai/docs/muse-code/changelog).

### Markdown export is a projection of the Muse session log

- **Date:** 2026-10-12
- **Decision:** "Export Markdown" runs `muse export` and renders a readable
  transcript from that document (export schema 1). It is not a second copy of
  the session, and it is not the full log.
- **What it keeps:** messages, thought text the host recorded in the clear,
  tool calls, approvals and run outcomes that are not a plain completion.
  Share-safe and raw follow the same flag as the JSON export.
- **What it leaves out:** encrypted reasoning blobs, and every other event.
  The header says the file is not the full export. A schema other than 1 is
  refused; the JSON export is the way to keep that document. A log over 64 MiB
  is refused for the same reason.

### The terminal pane is a deliberate exception to "the renderer is untrusted"

- **Date:** 2026-10-12
- **Decision:** The app has an integrated terminal: the user's login shell on
  a PTY, started in a granted folder, with keystrokes sent from the webview.
  The owner chose this knowing the cost below.
- **What it changes:** Every other native command authorizes what it is asked
  to do. A terminal cannot: whatever the renderer writes to it runs as the
  user. Code running in the webview can therefore open a terminal and execute
  arbitrary commands, which the earlier model ruled out. The webview renders
  agent output and repository content, so the protections that remain matter
  more than before: the strict CSP (no remote or inline script), text-only
  rendering of agent output, and the strict span adapter for highlighted code.
- **Limits that still hold:** a terminal starts only in a folder with a live
  grant, as the user's own shell with the user's environment (the API key is in
  the keychain, not the environment). At most eight are open. Each write is
  capped at 64 KB. Input uses a per-session writer outside the global manager
  lock, so a blocked PTY write cannot stop close, revocation or shutdown.
  Terminal ids are unguessable. A terminal ends, with the process group it
  leads, when its pane closes, when its grant or worktree is revoked, and when
  the app shuts down.
- **"Disable shell" turns it off.** The setting is a promise about the app, not
  only about the agent. The renderer hides the terminal when it is on, and the
  native side refuses `terminal_open` after a host start that carried
  `disableShell`. The native check follows the host's posture because settings
  live in the renderer; before any host has started, only the renderer's check
  applies.
- **Dependencies:** `portable-pty` 0.9 (MIT) for the PTY, since the standard
  library has none and the crate covers macOS, Linux and Windows ConPTY; and
  `@xterm/xterm` 6 with `@xterm/addon-fit` (MIT) for rendering, since a
  terminal emulator is not something to hand-write. The renderer is a lazy
  chunk loaded on first use, so the main bundle does not grow.
- **Not built:** multiple tabs, a shell that survives the pane closing,
  scrollback persistence, and links from terminal output.

### One shortcut table drives the key handler, the labels and the native menu

- **Date:** 2026-10-12
- **Decision:** `lib/shortcuts.ts` lists every rebindable action with its
  default chord (a platform modifier, optional Shift and Alt, and a physical
  key code). The key handler looks a pressed chord up in it, tooltips and the
  palette read their labels from it, and Settings stores only the user's
  overrides. A shortcut handled anywhere else cannot be rebound or shown.
- **Native menu:** in the desktop shell the menu owns the chords of its own
  items and consumes the key before the webview, so the handler skips those
  there and the menu event runs the action. When an override touches a menu
  item, the renderer sends the new accelerators and `set_menu_shortcuts`
  rebuilds the menu. It accepts only the menu ids this app forwards and a
  closed accelerator grammar; the menu's structure and labels are fixed.
- **Not rebindable:** text entry keys, approval keys, Esc, ⌘1–9, Ctrl+Tab and
  ⌘G. They are either positional or tied to what has focus, and rebinding onto
  them, or onto cut, copy, paste, undo, quit, close, hide and minimize, is
  refused.

### Preferences save at once; host settings wait for a restart

- **Date:** 2026-10-12
- **Decision:** Settings no longer batches every edit behind Save changes.
  Theme, accent, notifications, defaults, agent visibility, the editor choice
  and custom commands are committed as they change. The settings the Muse host
  is constructed with (`ephemeralSessions`, `disableWrite`, `disableShell`,
  `sandboxNetwork`, `museAuthMode`, `museApiKey`, `museBin`) stay in the
  dialog's draft until "Save & restart connection", because applying one means
  restarting the host. Cancel discards only those. The list is `RESTART_KEYS`
  in `SettingsModal.tsx`; a new host-construction setting belongs in it.
- **Reason:** One dialog had three saving models (Save, an immediate toggle,
  Save & restart). The split now follows a real difference: whether the change
  costs a restart.
- **Editor choice:** the renderer stores an editor id. `open_path` maps the id
  to a program through a closed native list and refuses anything else, so the
  renderer never names a program or a path to one.
- **Custom commands** are prompt text stored with the settings. Choosing one
  inserts its text into the composer, where the user sees and can edit exactly
  what will be sent; nothing is expanded at send time and there is no second
  command format beside the CLI's skills.
- **Forward compatibility:** Settings fields introduced by a newer build are
  retained when an older build saves the document. Each commit is applied to
  the live state before its first await, so overlapping changes persist their
  union instead of replacing one another.

### Workspace tools read through grants, and network git runs as the user

- **Date:** 2026-10-12
- **File viewer:** `read_workspace_file` takes a grant and a workspace-relative
  path. The path must be relative with no `..`, must resolve canonically inside
  the grant root (so a symlink cannot leave it), must be a regular file, and
  may not pass through a `.git` directory, lexically or after resolving
  symlinks, because git metadata can hold credentials. The read stops at
  256 KB; a file with a NUL byte in its first 8 KB is reported as binary and
  not returned. The viewer is read-only: there is no write command, and
  editing stays with the agent and the user's editor. Ignored files such as
  `.env` can be viewed when asked for by path. The agent in the same workspace
  can already read them, so refusing here would protect nothing.
- **Branches:** `git_switch` accepts a name only after `git check-ref-format
  --branch` (which also refuses a leading dash), switches only to an existing
  local branch, and creates only a name that does not exist. Uncommitted
  changes are left to git: they come along, or the switch is refused and
  nothing moves.
- **Push and pull requests:** `git_push` and `git_pull_request` run `git` and
  the user's `gh` with the user's environment, so their credential helper, SSH
  agent and `gh` login apply. The app never reads, stores or asks for a git
  credential. Prompts are disabled (`GIT_TERMINAL_PROMPT=0`, SSH batch mode,
  `GH_PROMPT_DISABLED`) and each call is bounded at two minutes, so a missing
  credential fails instead of hanging. Push targets the branch's upstream, or
  publishes to `origin` (or the only remote); it never force-pushes and never
  takes a remote or refspec from the renderer. A pull request link is passed
  to the renderer only when it is http(s). The UI confirms before each push;
  the shared dialog's explicit Push or Commit and push choice plus Continue is
  that confirmation, while the pull-request flow keeps its confirmation.
- **Pull** is fast-forward only (`git pull --ff-only --no-rebase`). A diverged
  branch or a conflicting local edit is refused with nothing changed; merging
  and rebasing stay with the user's git.
- **No background network:** pull request status is read only when the user
  pushes, creates or refreshes. Nothing polls GitHub.
- **Line comments** are renderer-only. They are kept per thread in session
  memory and sent through the normal send or steer path as text; there is no protocol
  field for them.

### Commit inclusion and history stay inside the active grant

- **Date:** 2026-10-26
- **Commit:** `git_commit` remains staged-only by default. Its optional
  include-unstaged flag runs `git add --all -- .` immediately before `git
  commit`, under the same native write lock. This includes deletions and new
  files, honors `.gitignore`, and cannot stage beyond the granted subtree. It
  does not use `git commit -a`, which would omit new files. If the commit fails,
  any newly staged files remain staged and the UI says so. The app does not run
  repository hooks (see "Native workspace Git skips repository hooks" above).
- **Draft sequencing:** A blank message uses the ordinary agent turn and keeps
  the composer-preservation rules. The result is bound to its originating
  thread. Closing the dialog or changing the active grant cancels the pending
  commit/push continuation; a successful commit followed by a failed push can
  retry only the push.
- **Graph:** `git_graph` accepts only a grant, never a revision or path from the
  renderer. Git renders the topology itself across refs, scoped by `-- .` to the
  grant. The command returns at most 200 commits and 512 KiB, handles an unborn
  HEAD as empty, strips ambient repository overrides and does not modify the
  index, refs or files. Graph responses are owned by the active selection and
  grant and invalidated by fresh snapshots and mutations.

### A worktree thread gets a derived grant, not a wider one

- **Date:** 2026-10-12
- **Decision:** A new Muse thread can start in its own git worktree: a linked
  worktree of the workspace repository on a new `glitter/<id>` branch
  (`muse/<id>` before the rename), stored under the app data directory in
  `worktrees/<digest of the repository root>/<id>`.
  `git_worktree_create` takes the workspace grant and an optional base, creates
  the worktree, and mints a grant for its root. The thread's session, snapshots,
  Changes, review, file index and opened files all use that grant. The thread
  still belongs to its workspace in the sidebar.
- **Why a derived grant is safe:** It is the one grant not minted by the folder
  picker. Its root is a directory the command itself just created inside the
  app's own store, for a repository the caller already holds a grant for. The
  renderer names neither the path nor the branch. A grant on a subfolder of a
  repository is refused, because a worktree checks out the whole repository and
  would expose the subfolder's siblings. Worktrees do not nest.
- **Removal:** `git_worktree_remove` accepts only grants rooted at worktree
  depth inside the store, so it can never delete a folder the user opened. It
  discards the worktree with its uncommitted files (the UI confirms first and
  names the branch) and revokes the grant. The branch is deleted only when
  another ref still reaches its tip, so no commit is lost; otherwise it is kept
  and the user is told. The branch name is read from the repository's own
  worktree table, not from files inside the worktree, which an agent can rewrite.
  A worktree goes with its last thread: forks share their source's worktree.
- **Revoking the workspace:** Removing a workspace revokes its worktree grants
  with it. Worktrees with nothing uncommitted or ignored are removed; ones that
  hold either stay on disk for the user to recover with git, since removing a
  workspace from the sidebar never asked to discard work. Non-forced removal
  checks `git status --ignored`, so an ignored `.env` counts as unsaved work.
- **Listing:** The CLI files a worktree session under the worktree's root, so a
  workspace listing does not return it. The renderer keeps each thread's
  worktree record in session memory and lists each worktree through its own
  grant, which also binds its sessions natively. Only sessions with a record
  become threads. A stale or forged record gains nothing: the grant id still
  has to be live in the native table.
- **Handoff:** `git_worktree_handoff` applies a worktree's net changes (its
  commits plus staged, unstaged and new files since the merge base with the
  workspace's HEAD) to the workspace folder as uncommitted edits. The patch is
  built through a throwaway index, so the worktree's index and files are not
  touched, and it is carried as raw bytes so files in any encoding survive.
  `git apply --check` runs first: either the whole patch lands or nothing in
  the workspace changes. Nothing is staged, committed, merged or removed. The
  destination is found natively from the worktree's own grant and must still
  be granted; the renderer names no path. Patches over 20 MB are refused.
- **Limits:** A worktree starts from a commit, so uncommitted changes in the
  workspace folder do not come along, and the repository needs at least one
  commit. Ignored files (dependencies, build output, `.env`) are not copied.
  Workspace trust is a host-wide setting and is not re-prompted per worktree.
  Handoff applies changes as a patch, not a merge, so the worktree's commit
  history stays on its branch.

### Review scopes are separate from working-tree mutations

- **Date:** 2026-10-12
- **Decision:** All changes keeps the existing working-tree snapshot and its
  discard controls. The Diff selector also offers Staged (HEAD → index),
  Unstaged (index → worktree plus new files), Branch (merge-base of a chosen
  base and HEAD → HEAD), and Last turn (the owning thread's latest finished
  turn's saved before → after trees). Branch resolves both revisions once;
  uncommitted edits and changes unique to the base branch are excluded.
- **Native boundary:** `git_review` takes a grant and a strict request with a
  closed scope enum. Last turn additionally requires the owning session and
  opaque snapshot id, with grant/root/session/state/expiry checks. Read access
  is checked again before returning. Last turn works without a workspace Git
  repository and stays immutable after Undo or subsequent file edits. It has
  no fallback to HEAD or an older turn when the requested state is missing.
- **Bounds and reuse:** Metadata and patches share the existing capped Git
  reader (1.5 MB per output), with at most 2,000 scoped files. Unstaged uses the
  existing untracked preview limits and skip reasons. Ordinary reads remove
  ambient Git repository/index overrides, disable fsmonitor and use
  `--no-optional-locks`; saved-tree reads use the private snapshot environment.
  The workspace index, refs and files are not modified.
- **UI ordering:** Scope results and errors belong to a workspace path, grant,
  thread, scope, base and saved-state identity. Navigation, new requests and
  Git mutations supersede pending answers. Scope changes clear file tabs;
  opening a path from Changes returns to All changes. Other scope views are
  read-only because the existing discard/hunk operations act on the combined
  worktree diff. Copy/export use the displayed patch; Open current file
  explicitly opens its present workspace path.

### Message edits fork at the preceding canonical turn

- **Date:** 2026-10-12
- **Decision:** Muse edits use the inclusive MSP `lastTurnId` cut for the turn
  before the edited prompt, then send the revised prompt and its attachments in
  the new session. Local groupings, missing history and extra prompts inside a
  turn cannot stand in for a canonical boundary. A first message requires
  exhausted history and starts an empty session: the pinned SDK has no
  empty-history fork cut. Its provenance says **Edited from**, rather than
  asserting that the CLI created a history fork. ACP retains append/resend.
- **Ordering:** Fork/resume returns the canonical items it emitted while
  attaching; the renderer seeds the new row from that response because item
  events can precede row registration. Its canonical order is reconciled with
  partial early streams while preserving newer item contents. An explicit cut acknowledgement and
  usable history are required before a revised prompt is sent. Create retries
  reuse `clientRequestId`, and failed sends keep the fork draft. A completed
  edit retires its create retry; editing the source again creates a new fork.
  Navigation or grant replacement during the operation keeps the edit as a
  draft without selecting, resetting files or sending in another workspace.
- **Files:** Reset files too is opt-in and confirmed. Create the fork first,
  then reuse B1's native restore for the edited turn only, then select and send.
  A conflicting restore sends nothing. This does not reset every later turn:
  unrelated later changes remain, while later edits to an affected file can
  block its restore. No transcript truncation or new native file command is
  introduced, and the source thread’s composer draft remains separate.

### Turn file states use a private native Git object store

- **Date:** 2026-10-12
- **Context:** Restoring a receipt's paths from HEAD destroys edits made before
  or after the turn and cannot be reapplied. File restoration also crosses the
  native workspace-grant boundary.
- **Decision:** Rust captures the workspace immediately before an authorized
  `sendTurn` enters the bridge and captures its end state before forwarding the
  trusted terminal event. Raw file bytes and executable bits live in a private
  bare repository under app-data `turn-snapshots`; an independent disposable
  index builds the trees. The workspace index, HEAD and refs never move. This
  also works in non-git folders, without creating a workspace repository.
  Private [`info/attributes` overrides](https://git-scm.com/docs/gitattributes)
  disable content conversions for capture and restore, preserving CRLF, ident
  expansions and encoded/binary bytes. Files in the before tree remain eligible
  for the end capture even when ignore rules change during the turn.
- **Restore:** Grant, canonical root, session and opaque snapshot id must all
  match. Undo requires every affected file to match the end state; Reapply
  requires the before state. Both preflight the full contents and modes and use
  [Git's checked index apply](https://git-scm.com/docs/git-apply) against the
  private index, so normal conflicts refuse the entire restore. Unrelated
  later edits remain. A saved intent reconciles an interrupted restore after
  relaunch; mixed states disable restoration and retain the saved objects for
  inspection. Disk failures and process termination cannot guarantee atomic
  writes across several filesystem paths.
- **Bounds:** 2,000 files, 2 MiB per file, 32 MiB per tree, an 8-second scan
  budget checked between files, 10 seconds per Git subprocess and 1 MiB of
  metadata per record. Git workspaces
  include tracked and non-ignored untracked paths; non-git scans include
  dotfiles and skip `.git` and the file index's build/dependency directories.
  Symlinks, submodules, special files, non-UTF-8 paths and backslash filenames
  disable Undo. Snapshot metadata returns when a thread opens; saved contents
  reach the renderer only as bounded, explicitly requested review patches.
  Storage is private
  to the OS account, expires after seven days, and retains at most 100 completed
  records (active records remain until a terminal event; excess runs do not
  capture file contents). Thread deletion removes its refs and collects objects.
- **Lifecycle:** Queued, external, overlapping or disconnected turns never get
  a baseline captured after work begins. Failed/cancelled turns can restore
  changes when both states were captured. Retry keys reuse the original baseline.
  Active work and user shells block restores in overlapping workspace roots;
  deletion and stopping notices do not assert a process has already stopped.
  Shell or other-app edits made during the turn cannot be separated from agent
  edits, which the confirmation explains. Older history has no destructive
  fallback. Message rewind reuses this restore; Last turn review reads its
  saved trees without restoring them.
- **Reason:** One restore mechanism covers binary, created, deleted and mode-only
  changes without a new dependency, replacing HEAD-based discard with reversible
  workspace state while preserving the CLI as the source of thread history.

### The app has its own agent harness

- **Date:** 2026-10-21
- **Context:** Depending on installed agent CLIs made the app fragile: Grok
  and Homebrew updates broke binary pins, OpenCode Zen accounts rejected free
  models, and every agent needed its own sign-in. The product is moving from a
  GUI for Muse Code to an independent agent harness.
- **Decision:** The bridge hosts a built-in agent (`harness/`) that calls model
  providers directly with the user's own keys (Anthropic, any OpenAI-compatible
  API, local servers) and runs its own tool loop. This supersedes "The CLI is the
  engine" for that agent; Muse and the ACP agents remain supported clients.
- **Constraints kept:**
  - Provider keys live in the OS keychain (`credentials.rs`); the renderer sees
    masks only. Native code injects keys into harness requests alone, and a
    custom endpoint's URL is stored with its key so a key cannot be redirected.
  - Tools resolve every path inside the workspace after following symlinks. The
    shell runs under the same OS write sandbox and minimal environment as ACP
    agents, so it never sees provider keys.
  - Edits and commands follow the app's permission modes (read only, ask,
    auto-review, unrestricted) and Plan mode, through the existing approval cards.
  - Sessions are the harness's own JSONL files in the app data folder.
- **Consequences:** The app now owns agent behaviour for this agent: the
  system prompt, tool set, retries, context trimming and provider quirks are
  ours to maintain. Effort support per model follows published families
  (`effortTiers`), since providers do not report it. Provider quirks stay in
  the shared wire rather than in a path per provider: NVIDIA NIM, for one,
  rejects request fields its schema does not list, so `stream_options` goes
  only where `modelCapabilities` reports streaming usage, including custom
  OpenAI-compatible gateways. ZenMux omits `usage` unless that flag is set,
  and without it the app can count only the reply. A gateway that rejects
  the field is asked once more without it. NIM's RFC 7807 error bodies are
  read by their `detail`. A muted delegated call adds its reported tokens
  to every open ancestor, so the thread that started the work is billed.

### A tool result is three channels, and the model pages what does not fit

- **Date:** 2026-10-21
- **Decision:** Each harness tool returns a typed value. `render()` is the only
  text the model reads. `presentationMeta()` is pure card state persisted on
  the transcript item, so a write's before/after redraws without reading the
  file again. A truncated read, search or listing carries `next_offset`, the
  unit (`line`, `match` or `file`) and the tool call that fetches the next
  slice. Output past the inline budget is written under `.muse/tool-output`
  in the workspace (mode 0600, directory 0700, a single encoded filename) and
  replaced with a receipt that says how to search it and that the receipt is
  not evidence. If that write fails, the inline result stays. The turn only
  does this when a read tool is available, which the built-in set always is.
- **Parallelism:** A tool runs beside other tools only when its definition's
  `concurrencySafe` is exactly true (`read_file`, `list_files`, `grep`).
  Anything else, including an unknown name, runs alone after the pool is idle.
  Results are committed in the model's call order. A call that never started
  because the turn was stopped still gets a result, so the history stays valid.
- **Repeats:** The same tool and the same deep key-sorted arguments are one
  chain. The second, fifth and eighth calls add a labelled harness note to
  the result. The call still runs. A user message, including a steer, clears
  the chain.
- **Provider errors:** `ProviderError` carries a code (`RATE_LIMIT`,
  `CONTEXT_WINDOW_EXCEEDED`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`,
  `EMPTY_RESPONSE`, and the transport codes). Retries follow the code. A
  missing key and a rejected key stay different, and a context-window overflow
  is not retried. The two-minute retry budget is unchanged.
- **Saved output stays scratch:** the folder holds a `.gitignore` of `*`, so
  saved output never appears in git status or the review as a project change.
  `read_file` is never saved this way, because it is how saved output is read
  back: a single line longer than its budget is cut there with a note, and
  paging goes on from the next line. A receipt keeps the paging instruction of
  the slice it replaced, since the artifact holds that slice only.
- **A stream must end:** a provider stream that closes with no frame is
  `EMPTY_RESPONSE`, and one that closes without its end marker (Anthropic's
  stop reason or `message_stop`, OpenAI's `finish_reason` or `[DONE]`) is
  `STREAM_CLOSED`. Both are retried inside the same budget; a partial reply is
  never taken as the answer. A stop by the user still keeps what arrived.
- **Not in this decision:** a tool registry, permission scopes, and any new
  bridge verb. Cards read `presentation` on the existing item. Saved output is
  read back with `read_file`.

### The CLI is the engine; the app is a client

- **Superseded in part (2026-10-21):** still true for Muse and the ACP agents;
  the built-in harness above runs its own loop.

- **Date:** 2026-09-18
- **Context:** Muse already has a complete agent runtime and a session protocol
  (MSP, served by `muse serve`).
- **Decision:** The desktop app runs no models and executes no tools itself. It
  drives the official CLI and shows what the CLI reports.
- **Reason:** One source of truth for sessions, approvals and billing, and CLI
  upgrades reach the app without a rewrite.
- **Consequences:** Features depend on what the protocol exposes. The UI must
  not invent state, such as fake chain-of-thought or a local copy of history.

### Tauri 2 with the system webview, not Electron

- **Date:** 2026-09-18
- **Decision:** Native shell in Rust (Tauri 2). The UI renders in the OS webview.
- **Reason:** A small footprint, and a native trust boundary separate from the
  web content.
- **Consequences:** UI code must work in WebKit (macOS), WebView2 (Windows) and
  WebKitGTK (Linux). Privileged work goes into Rust commands.

### A separate Node bridge built on the official SDK

- **Date:** 2026-09-18
- **Decision:** MSP is spoken by `packages/glitter-harness`, a Node process that uses
  `@muse-code/sdk` and talks to the shell over NDJSON on stdio. It isn't
  reimplemented in Rust.
- **Reason:** The SDK is the supported client. Reimplementing the protocol would
  drift from it.
- **Consequences:** The app ships its own Node runtime (the `glitter-node` sidecar).
  The SDK is pinned exactly, and moving the pin is a deliberate change. It was
  re-pinned from 0.1.1 to 1.3.0 on 2026-09-21 to match the CLI's schema.

### The renderer is untrusted

- **Date:** 2026-09-20
- **Context:** The webview renders agent output, repository content and tool
  output, all of which are attacker-influenced.
- **Decision:** The native shell authorizes every privileged operation itself:
  - an allowlist of bridge verbs, each with a typed DTO
  - (one exception, recorded above: the terminal pane, whose input the native
    side cannot authorize)
  - workspace grants minted only by the native folder picker (plus grants
    derived for app-made worktrees of an already granted repository) and stored
    in the OS keyring
  - session and approval ownership bound from bridge traffic
  - the API key held natively, with the renderer seeing only a mask
- **Reason:** A compromised renderer must not be able to reach arbitrary paths,
  sessions or credentials.
- **Consequences:** Every new capability needs a native command or DTO. Folders
  added before grants existed have to be re-opened once through the picker.

### Release builds verify their own bridge

- **Date:** 2026-09-20
- **Decision:** `build.rs` bakes the SHA-256 of the bridge bundle into the binary.
  Release builds refuse a script that doesn't match, and they never use the
  user's Node.
- **Reason:** Stops script swapping and PATH or `NODE_OPTIONS` hijacking.
- **Consequences:** Any change to the bridge requires rebuilding the shell.
  `GLITTER_BRIDGE_SCRIPT` works in debug builds only.

### Third-party agents are opt-in and isolated

- **Date:** 2026-09-21
- **Decision:** ACP agents (OpenCode, Grok, Gemini CLI, Qwen Code, Goose, Cline
  CLI) are off by default. Before one is enabled:
  - the user gives informed consent, stored in the keyring
  - the binary is pinned by digest
  - it runs with a filtered environment and a confined working directory
  - it runs under an OS write sandbox where one is available
- **Hardening (2026-10-24):** Detection and Settings resolve and hash ACP
  binaries without executing them. First use or confirmation records the
  identity pin before a version probe. Probes receive only base process
  variables, never provider credentials, and version metadata updates only
  while the pinned path and digest still match. Automatic ACP permission
  answers select once-only choices, never an always grant.
- **Reason:** These are third-party binaries running with the user's identity.
- **Consequences:** Only Muse, OpenCode and Grok are marked verified. The others
  are labeled experimental in `packages/glitter-harness/src/agents.ts`.

### Muse owns its shell sandbox

- **Date:** 2026-10-12
- **Decision:** Start `muse serve` directly with a filtered environment and a
  temporary working directory. Keep shell, write and network posture flags,
  workspace trust and session approval modes under the existing CLI protocol.
  ACP agents retain their separate OS isolation and consent requirements.
- **Reason:** Applying the desktop's outer write sandbox makes Muse's nested
  shell sandbox fail with `sandbox_apply: Operation not permitted` on macOS.
  The outer wrapper also restricts approved escalation and Unrestricted sessions.
- **Consequences:** Host diagnostics report `cli-managed`, which identifies the
  sandbox owner without claiming an active session is sandboxed. This does not
  pass `--disable-sandbox`, disable approvals or retry failed commands outside
  Muse's permission policy. Restart the connection after updating the app.

### The Mac Dock icon follows system appearance

- **Date:** 2026-10-12
- **Decision:** Keep one SVG spark source and generate light/dark native icon
  assets with `npm run icons`. Update the running Dock icon through AppKit on
  `RunEvent::Ready` and the main window's `ThemeChanged` event, on the main thread.
  The interface SVG follows its containing document's color scheme.
- **Reason:** The interface can use an explicit theme while the Dock belongs
  to macOS. Keeping these choices separate preserves both expectations.
- **Consequences:** No renderer command or new webview permission is needed.
  The inactive Finder/launcher icon uses the generated light bundle icon;
  the running app selects its Dock appearance without changing OS preferences.

### One store, merged streaming

- **Date:** 2026-09-21
- **Decision:** All renderer state lives in one Zustand store. Stream deltas are
  merged per animation frame, in the bridge and again in the store. Components
  subscribe through narrow `useShallow` selectors, and long replies re-render
  only the block being written.
- **Reason:** Per-token `setState` re-rendered the whole window while streaming.
- **Consequences:** `store.ts` is large; splitting it is open work (see the
  README's known limitations). Use selectors, not whole-store subscriptions.

### Permission vocabulary matches the CLI

- **Date:** 2026-09-21
- **Decision:** Approval modes are labeled as the CLI labels them: Read only,
  Ask me, Auto-review, Unrestricted. "Unrestricted" (`allowAll`) can be set per
  thread but not as the global default. A saved `allowAll` default falls back to
  prompting.
- **Reason:** Users move between the CLI and the app, and an unrestricted
  default is too easy to forget about.

### Settings persistence is atomic and native

- **Date:** 2026-09-22
- **Context:** The store plugin saves with truncate-and-write, so a crash
  mid-save could destroy every draft and thread title.
- **Decision:** `glitter.json` is written by the native
  `persist_store_atomic` command: temp file, then rename, with a `.bak` kept. An
  unreadable file is quarantined as `.corrupt`, and the backup is restored. A
  banner shows when persistence fails.

### One running instance

- **Date:** 2026-10-18
- **Context:** The workspace-grant table in the keyring and `glitter.json`
  settings document are whole-table writes. Two instances make those writes
  last-writer-wins, silently dropping grants or settings.
- **Decision:** Register the official Tauri single-instance plugin first. Its
  platform mechanisms are a Unix socket on macOS, D-Bus on Linux, and a named
  mutex on Windows.
- **Tradeoff:** Snap and Flatpak packaging would need a D-Bus slot declaration.

### No public build until it is signed

- **Date:** 2026-09-22
- **Decision:** Artifacts stay unsigned, internal builds until there's a Developer
  ID or Authenticode certificate and notarization. No auto-updater ships
  without a signing key to verify its payloads.
- **Consequences:** See [RELEASING.md](RELEASING.md) for the preconditions and
  the six-manifest version bump.

### Durable docs only

- **Date:** 2026-10-04
- **Context:** Audit reports, QA notes and plans from earlier work had built up
  at the root and in `docs/muse-desktop-audit/`, with conflicting test counts and
  status claims.
- **Decision:** They were removed. Lasting content was folded into `docs/`
  (architecture, development, design system, releasing, this log). Progress
  reports and plans don't get committed.

### Syntax colouring via highlight.js core, not a theme engine

- **Date:** 2026-10-11
- **Context:** C2 needs readable code in diffs, approval previews and Markdown.
  Options were the all-language highlight.js bundle, a wasm-based
  highlighter, or the bare core with a picked grammar list.
- **Decision:** `highlight.js@11.12.0` core only. Twenty named grammars load
  lazily per root language (each on an isolated `newInstance()` engine with
  its finite sublanguage closure pre-registered), never `highlightAuto` and
  never the root package. The raw output HTML is re-parsed into offset spans
  by a strict adapter that accepts only `<span class>`/escaped-text grammar
  and rejects anything else — decoded text must reproduce the source exactly.
  Tokens map to four theme-aware `--syntax-*` colours we own; sources over
  64Ki UTF-16 code units (or lines over 4096 chars), unknown languages and
  any failure render plain, debounced at 120ms with a bounded result LRU. The
  seam (`lib/syntax.ts` + `components/SyntaxCode.tsx`) is shared so a future
  file viewer reuses it.
- **Reason:** Smallest correct surface for the trust boundary — no foreign
  markup or class names ever reach React, and lazy chunks keep the main
  bundle free of highlighter code.
- **Consequences:** New languages mean extending the alias map plus a new
  dynamic grammar loader entry in `lib/syntax.ts` — never eager imports. Sublanguage cycles
  (js↔xml) require the visited-set closure — never recursive await chains.

### A closed surface lingers for its exit; it is never kept open for it

- **Date:** 2026-10-12
- **Decision:** Exit animations do not delay closing. When a dialog, menu or
  section closes, the app's state, focus, inertness and the dialog `close`
  event change at once. Only the pixels stay: `usePresence`
  (`lib/presence.ts`) keeps the element mounted for one exit with a `closing`
  class, and `useModalDialog` calls `close()` immediately and marks the dialog
  `data-closing`, which the stylesheet uses to keep the now non-modal dialog
  drawn, with a spread shadow standing in for the backdrop.
- **Reason:** Keeping a modal open while it fades leaves the app behind it
  inert, so a command that moves focus as it closes the palette (Find in
  thread, Search threads) loses that focus. Delaying the store change would
  also make every caller wait on an animation.
- **Consequences:** A dialog component must draw from the last value it was
  given (`useRetained`), because the store has already cleared it. The
  programmatic `close()` swallows its own `close` event; without that, the
  event arrives after the store has moved on and would dismiss a dialog that
  reopened in the meantime (two confirmations in a row). Reduced motion, and
  any environment without `matchMedia`, skips the linger entirely.

### Frost & Ember: glass chrome, solid reading surfaces, ember accent

- **Date:** 2026-10-13
- **Decision:** The visual identity is Frost & Ember: a matte grey canvas with
  frosted glass for chrome only (sidebar, composer, popovers, dialogs) while
  transcripts, code and diffs always sit on solid surfaces. New installations
  default to the `system` theme (Frost light / Smoke dark) and the `ember`
  accent; a saved theme or accent is never touched. Popovers and menus fill
  with near-opaque `--glass-strong` (.97 light / .95 dark) because a popover
  nested inside another backdrop-filtered surface cannot blur what is behind
  it — the fill must carry the obscuring. The website shares the identity but
  drops the dotted Array display font for General Sans at light weight.
- **Reason:** Nested `backdrop-filter` is a hard platform limit, so translucency
  cannot be the only obscuring mechanism in menus that open over the composer.
  System-default theme and an ember default accent apply only where no saved
  preference exists, keeping upgrades invisible to existing users.
- **Consequences:** Reading surfaces (transcript, code, diffs) must never get a
  translucent fill. `EmberTiles` artwork is decorative, static, `aria-hidden`,
  and needs a solid-fallback path when `backdrop-filter` is unavailable or
  `prefers-reduced-transparency` is set. The icon generator contract is fixed:
  the mark's inner SVG is embedded at 0.75 scale on an `rx=14` app-icon tile,
  light and dark.

### The Mac window is transparent over a sidebar material

- **Date:** 2026-10-13
- **Decision:** On macOS the main window is created transparent with the system
  `sidebar` material behind the webview (`transparent` and `windowEffects` in
  `tauri.conf.json`, `macOSPrivateApi` and the `macos-private-api` feature of
  `tauri`). The page decides how much of it shows: the shell, the one surface
  behind the sidebar and the gutter around the main panel, is painted at the
  opacity `lib/theme.ts` resolves from the Appearance settings, and everything
  else stays opaque. The window takes the interface's light or dark appearance
  through `set_window_appearance`, which sets it on the `NSWindow` only.
- **Reason:** A translucent sidebar needs something behind the page, and
  WKWebView only stops drawing its own background through a private key
  (`drawsBackground`), which Tauri gates behind that flag. The material follows
  the window's appearance, so an explicit Light or Dark theme on the opposite
  system setting would otherwise put dark glass under light text. Setting the
  appearance on the window, not the application, leaves `NSApp` following
  macOS, which is what the Dock icon reads (see the Dock icon decision).
- **Consequences:** The app cannot ship through the Mac App Store while the
  flag is on; distribution is a notarized download, as planned. The browser
  preview keeps an opaque window and shows no translucency setting, where `?material` in a dev build turns
  the control on for design work. The sidebar no longer has a glass fill or a
  backdrop blur of its own, which amends the Frost & Ember decision: glass is
  for the composer, popovers and dialogs. Reduced transparency, a translucency
  of zero, or no material keep the shell fully opaque. Nothing but the shell
  may be see-through: reading surfaces stay solid.

### macOS is the only platform

- **Date:** 2026-10-21
- **Decision:** Glitter is built, tested and shipped for macOS 13 or later
  only. CI runs on macOS alone, and the bundle targets are `.app` and `.dmg`.
  There are no Windows or Linux builds or installers.
- **Reason:** The app leans on macOS throughout (the window material, the
  Keychain, the seatbelt sandbox for agents), and a single platform is what
  can be verified and supported. Keeping Linux CI meant working around runner
  limits, such as AppArmor refusing bubblewrap its user namespaces, for a
  version that would not ship.
- **Consequences:** The Windows and Linux code paths were removed from the
  source on the same date: bubblewrap isolation, Windows Job Objects (native
  and in the bridge), `.exe`/`.cmd` binary lookup, Windows shells, Windows
  environment variables in the child-env allowlists, Windows and Linux install
  directories in binary search, and the Windows and Linux Node runtimes in the
  sidecar script. The keyring and single-instance dependencies are macOS-only.
  Earlier decisions that mention those platforms describe how the code was
  written, not what ships.

### Harness tools, prompt sections and hooks come from a registry

- **Date:** 2026-10-21
- **Decision:** `HarnessHost` does not know what a tool is. Tools, system
  prompt sections and hook handlers are contributed by extensions registered
  on `ExtensionRegistry` (`harness/registry.ts`); the seven built-in tools are
  the `builtin` extension (`BUILTIN_TOOLS` in `tools.ts`). A tool is a
  `ToolDefinition`: its schema, a permission `kind` the gate reads, whether it
  is concurrency-safe, a `validate` step run on the frozen arguments before any
  approval card, and `run`. Skills, MCP and subagents (Phases 5–7 of the
  harness plan) are meant to be extensions, not new branches in `host.ts`.
- **Snapshot:** `runTurn` takes a snapshot before its first await, and the
  whole turn works from it: tool map, schemas, prompt sections and copied hook
  tables. A registration or removal made during a turn reaches the next turn,
  so a model never sees a tool set that changed between its steps.
- **Fail loudly:** A duplicate extension id, static tool name or profile id
  throws at `register` and adds nothing. A factory's duplicate, an unknown
  profile, or a profile naming a tool the turn lacks throws at `snapshot`,
  which fails the turn before any model call. Nothing is silently dropped.
- **Hooks observe:** Handlers run in registration order, one at a time. They
  cannot change or refuse a call; a handler that throws becomes a warning
  notice and the turn continues. Permission stays in the host's gate, so no
  extension or listener order can turn a denial into an allow (Phase 4 adds
  deny-only guards as their own layer).
- **Stable prompt:** Stable sections join the cached prefix after the identity
  and workspace lines; volatile sections follow the date and mode. The built-in
  extension contributes the one line that names its tools, so the prefix a turn
  sends is unchanged by this refactor.

### Harness permissions: guards deny, the policy asks, and a grant names its subject

- **Date:** 2026-10-21
- **Decision:** Every harness call passes two layers in `harness/permission/`.
  Deny-only guards run first in every permission mode: a guard can return a
  refusal and nothing else, and one that throws refuses. The built-in danger
  guard blocks commands no mode may run (deleting the root or home folder,
  formatting a disk, raw device writes). Then the ask-policy decides allow,
  deny or ask from the mode, Plan mode and the thread's grants. The policy
  never sees a call a guard refused, so no mode or grant can undo a refusal.
- **Grants:** "Allow in thread" records a grant for the subject the user picked
  on the card: an exact command, an argv prefix (`git push …`), one program,
  a file, a folder or the workspace. A prefix grant covers a script only when
  every command starts with a granted prefix, with no expansion, assignment or
  redirection; compound scripts are offered exact grants only. Interpreters get no program-wide grant,
  and wrappers such as `env`, `sudo` or `xargs` get the exact command only,
  because either would cover any command. A risky command is asked about every
  time and offered no grant.
- **Shell boundary (updated 2026-11-06):** A command name cannot establish a
  read-only operation: commands can follow symlinks or invoke helpers from
  repository configuration. Ask requests approval for shell calls, and Plan
  refuses shell and MCP calls and uses the confined workspace read tools. Auto
  still runs ordinary shell calls; its OS sandbox restricts writes and selected
  credential reads, but is not a general workspace-only read boundary.
  Existing MCP servers and background shells are not terminated by entering
  Plan; the Plan turn does not start a server, issue a new MCP call, or read
  or control an earlier shell.
- **Outcomes:** An approval ends as allowed, rejected, cancelled, expired or
  unavailable, each with its own message to the model. With no approval
  channel the request is refused at once instead of waiting.
- **Persistent rules (2026-11-11):** Settings saves built-in-agent allow and
  deny rules. Allows become ordinary grants; denies are guards in every mode.
  Updates are serialized, reapplied after a bridge restart, and awaited before
  starting or continuing a thread. Guards are checked again after approval and
  the execution checkpoint so a deny added while a call waits takes effect.
  An unparseable shell script is refused when a Bash deny is present. These
  rules govern tool subjects, not everything an arbitrary program can do:
  Edit denies do not confine a shell, and commands run indirectly by other
  programs are outside the shell reader's view.
- **Later:** Full access still runs ask-level risks without asking. The guarded
  mode added on 2026-10-22 ("Autonomous is the harness's guarded mode") is the
  one that stops at them.

### Harness skills are folders it discovers each turn

- **Date:** 2026-10-21
- **Decision:** The harness reads skills itself instead of through an agent
  CLI. A skill is a folder holding a `SKILL.md` with `name` and `description`
  frontmatter, found under `.glitter/skills` and `.agents/skills` in the
  workspace and then in the home folder; the nearest root wins a duplicate
  name. `.agents/skills` is the convention the reviewed harnesses share, and
  `.glitter/skills` is ours.
- **Progressive disclosure:** A turn's system prompt carries names and
  descriptions only. The `skill` tool loads a body, and with `file` any other
  file in that skill's folder. The catalog is rebuilt for every turn inside the
  registry snapshot and says it replaces any earlier list, so a removed or
  renamed skill does not linger. Discovery is synchronous because the snapshot
  must not await; it reads at most 16 KiB of each `SKILL.md` and 200 skills.
- **Reach:** Loading a skill is a read and needs no approval, including a skill
  from the home folder, which is outside the workspace: the user put it in a
  skills folder for agents to read. The tool's `file` argument cannot leave that
  skill's folder, and a skill folder or `SKILL.md` that resolves outside its
  root through a symlink is not listed. Workspace skills load like `AGENTS.md`
  does: whoever can change the workspace can change what the agent reads.
- **Typed invocations:** `/name` in a Harness thread is expanded when it is
  sent, so a queued turn runs the skill as it was then. The transcript keeps
  what the user typed; the model receives the tool's own rendering. An unknown
  name fails with `skillNotFound`, which makes the app refresh its list.

### A Harness question ends the turn

- **Date:** 2026-10-21
- **Decision:** The harness's `ask_user` tool does not block inside a turn the
  way an approval does. A model reply that asks ends its turn: the question,
  with the other results of the same batch, is written to the session log, and
  the thread is idle with the question card showing. The answer becomes that
  call's result and a new turn continues from it. Declining or explaining
  continues too, with a result that says so, so the history stays valid.
- **Why:** A question can wait for hours. Holding a turn, a provider stream
  and an abort controller open for that long is fragile, and a 10-minute
  expiry like approvals have would throw the question away. A logged question
  survives a restart and reopens with the thread.
- **No wedge:** Any new message from the user settles an unanswered question
  first, with a result that says the user moved on, so the tool message always
  precedes the next user message.
- **App contract:** The `userInputs` event carries `turnEnded: true`, so the
  store leaves the thread idle (a Muse question arrives mid-turn and still marks
  it running), and the turn that continues after an answer is announced with
  `turnStarted` and `cause: "userInput"`. The card is the existing
  `UserInputCard`: answers, "Let me explain" and "Decline to answer" map onto
  the same response shape Muse uses.

### Steering is durable before its model-history boundary

- **Date:** 2026-10-24
- **Decision:** An accepted steer writes a pending `steer` record to the
  Harness session log before its transcript item is shown. The next tool
  boundary appends a `steerSettled` marker with the same item ids. On resume,
  settled steers become ordinary user messages at that point in history;
  unsettled ones are returned to the host and settled before the next turn.
- **Why:** The transcript and model history must not diverge when a steer is
  cancelled, replaced or abandoned before a tool result arrives. Persisting
  only the transcript item loses the instruction; appending a user message
  immediately would put it between a tool call and its result, which providers
  cannot accept. The two record types preserve both orderings without a second
  session store.

### Plan mode ends with a plan review

- **Date:** 2026-10-21
- **Decision:** In Plan mode the harness offers `exit_plan_mode`, and leaving
  Plan mode is the user's approval of the plan, not a mode toggle the model can
  flip. The review is a turn-ending question (see "A Harness question ends the
  turn") with a `planReview` intent, so it is durable and cannot wedge a turn.
  The verdict is read from a named answer, `Approve`, never from a position.
- **Outcomes:** Approve switches the thread to Build before the next turn
  starts, and that turn carries the plan out. Feedback goes in as the user's own
  message, so the model revises the plan as it would answer any message, and
  the transcript shows what the user wrote. Keep planning ends the review
  without starting a turn.
- **App contract:** A `userInputs` request may carry `intent: { kind:
  "planReview", plan }`. The app shows `PlanReviewCard` for it; any other client
  sees one ordinary question with the plan as the Approve option's preview.
- **Not done:** The model cannot enter Plan mode on its own, and Plan mode has
  no exception for writing a plan file; the plan travels in the tool call.

### Per-call usage is emitted, not logged

- **Date:** 2026-10-22
- **Decision:** Each model call the harness makes emits a `modelCall` event
  carrying its own tokens, cached share, finish reason, duration, tool count
  and — only on a retry — which attempt landed. The session log keeps no
  per-call copy. The app's usage ledger is the only durable record: one `calls`
  array beside the turn the calls belong to.
- **Why:** The session log already stores the running totals a resumed session
  needs, and the ledger already owns accounting — totals, tools and durations
  are counted there as each turn finishes. A per-call breakdown in the log
  would be a second copy of numbers nothing in the harness reads back: history
  is rebuilt from messages, never from usage.
- **Bounds:** The ledger keeps at most 80 calls for one turn (a turn stops at 80
  steps, so that is a whole trajectory) and keeps detail for the newest 25
  turns; older turns keep their totals. Both bounds are re-applied when a stored
  ledger is read, because stored JSON is untrusted.
- **Consequences:** Trajectory detail is app-local and recent. A client that is
  not this app sees the events pass but has nothing to read back later, and an
  agent other than Harness reports totals only, so its turns have no trajectory.

### Autonomous is the harness's guarded mode

- **Date:** 2026-10-22
- **Decision:** The harness offers a fifth permission mode, `guarded`, labeled
  **Autonomous** in the composer between Auto-review and Unrestricted. It allows
  edits and runs commands without asking, but a command the danger catalog
  rates ask-level (`rm -r`, `git push --force`, `git reset --hard`, `chmod -R`,
  a download piped into a shell…) still asks every time. The deny-only guards
  run first, as in every mode, so nothing they block can run; Plan mode refuses
  edits, shell commands and MCP calls. A risky call is offered no thread grant: the card allows it
  once or denies it, and says why.
- **Why:** The four CLI modes keep their exact Muse CLI meanings, and
  Auto-review is a review policy, not "run everything harmless". A separate
  opt-in mode supplies the "autonomous but not reckless" behavior the reviews
  asked for without changing what the existing modes mean or choosing it for
  the user.
- **Mode boundary:** `guarded` exists in the shared protocol so the renderer
  can describe a harness thread, but it is harness-only. The renderer maps it
  to Auto-review whenever a thread switches to Muse, the Muse host rejects it
  outright if it arrives anyway, and hydration clamps it to Ask me rather than
  keeping it as the default for new threads.

### Permission modes belong to the app

- **Date:** 2026-10-24
- **Decision:** The composer offers three modes for every agent and model:
  **Ask** (`onRequest`), **Auto** (`guarded`) and **Full access** (`allowAll`).
  Descriptions are one line. A thread already on Read only (`denyUnmatched`)
  keeps it until the user picks another mode. Full access is still not a saved
  default. Auto may be. A saved Ask-me (`promptUnmatched`) loads as Ask.
- **Why:** The menu had grown to five entries, with a different subset for
  Muse, the built-in harness and each agent CLI, and the long lines were the
  Muse CLI's own sentences. Other harnesses offer three. The permission is a
  property of the app, so switching model or provider does not change it.
- **Enforcement:** The built-in harness decides with `decide`: edits run in
  Ask, shell commands ask, ordinary commands run in Auto, a risky command asks,
  and a blocked command is refused in every mode. ACP permission requests are
  answered by `acpPermissionDecision`; its classification depends on what the
  external agent reports. Muse's
  CLI has no Auto mode, so Ask and Auto are sent as its prompt mode and the
  app answers the approvals that come back. A provider echo of its own mode
  does not replace the mode the app stored.
- **Consequences:** The old Auto-review and Ask-me rows are gone from the menu.
  What an agent CLI does without asking is still outside the app's reach.

### MCP servers are user configuration, synced all or nothing

- **Date:** 2026-10-22
- **Decision:** The harness reads MCP servers from `.glitter/mcp.json` in the
  workspace and in the home folder, with the workspace winning a duplicate
  name. A sync connects and lists every server in the next generation before
  swapping it in; one failure closes what it opened and retires the previous
  generation for future turns, so changed configuration never keeps stale
  authority. Tools are `mcp__server__tool`, join the same registry and
  ask-policy as built-in tools, and every call asks unless a thread grant names
  that tool or server, or the mode is Full access. MCP tools are deferred: a
  turn starts with `tool_search` and activates what it names.
- **Why:** MCP is user configuration, never renderer input, and a server runs
  with its own authority. An all-or-nothing swap keeps the tool list consistent
  with what is actually running, and reference counting lets an in-flight turn
  keep the generation it started with while a new one is swapped in. Deferring
  their schemas keeps every request small while the full catalog stays one
  `tool_search` away. MCP is the one tool kind that still asks in Autonomous:
  the harness cannot audit what an external server does with a call.
- **Bounds:** Server names, env and header keys, argument counts, timeouts,
  tool counts, description sizes and result sizes are bounded. Stdio frames and
  each HTTP response, including error bodies and SSE streams, have a 1 MiB
  ceiling enforced while reading; an oversized stdio server is terminated and
  no partial generation becomes available. `NODE_OPTIONS`
  is refused, and a stdio server starts under `spawnIsolated` with its
  configured env merged after the environment scrub. Every env and header value
  is registered with the diagnostic redactor before startup; sync errors are
  sanitized before they reach notices or `mcpStatus`.
- **Consequences:** Extensions → MCP shows the harness's own generation for a
  harness thread and the CLI's servers for Muse; the two are not merged. A
  broken config is reported as a notice and does not fail the turn.

### The app writes MCP config, and secret values are write-only

- **Date:** 2026-10-22
- **Decision:** Extensions → MCP can add a server to the workspace or home
  config and remove one from the file that defines it. Writes go through the
  harness host (`harnessMcpConfig`, `harnessMcpAddServer`,
  `harnessMcpRemoveServer`), behind the usual allowlist, native DTO and session
  binding, and the bridge parses the definition with the same `parseServer` the
  sync uses before it writes anything. A file is replaced atomically through a
  temp file, with `.glitter` at 0700 and the file at 0600. Environment and
  header values are accepted on add and are never returned: rows carry only key
  names, and a display URL drops userinfo, query and fragment. An entry that
  fails to parse still appears as a row with its error, so it can be removed
  rather than trapping the whole list. A home addition that a workspace server
  of the same name would hide is refused, and a duplicate in the same file is
  refused.
- **Why:** The CLI still has no `muse mcp add` or `remove`, and hand-editing
  JSON for a secret-bearing file is where mistakes and leaked tokens come from.
  Writing on the bridge means there is one parser, one set of bounds and one
  atomic write path for both the app and the sync, and the renderer never has
  to hold a value longer than the add request.
- **Bounds:** The native DTO mirrors the bridge limits: name ≤64 characters,
  command or URL ≤4096, args ≤64 each ≤4096, env and headers ≤64 entries with
  keys ≤128 and values ≤4096 without CR or LF, timeout 1000–600000 ms.
  `NODE_OPTIONS` stays refused.
- **Consequences:** A value is not recoverable from the app; to change one,
  remove the server and add it again, or edit the file. The list reads the
  effective rows across both files, but a remove only touches the file named
  by the row's scope. After a write the host re-syncs the generation, so a
  newly added server connects and a removed one drops its tools.

### A delegated task is a hidden child with a stamped, narrowed scope

- **Date:** 2026-10-22
- **Decision:** The `task` tool starts a child agent as a hidden session
  (`h-…`) in the same harness host. The child is filtered out of
  `listSessions` and runs under a registry profile
  (`delegate`, then `delegate-leaf` at the cap) with a 24-step turn cap. Its
  scope is written both to the session index and to its own log as a
  `delegation` record: parent session, depth, profile, approval mode and Plan
  mode. A call that needs approval appears in the visible ancestor thread,
  identifies the delegated run and offers a single-call decision. Without a
  visible active ancestor or approval channel, the call is refused. The
  model may choose a model from the catalog; otherwise the child inherits the
  parent's model and effort. Children are catalogued by the parent's persisted
  `subagent` items, and `readChildSession` returns a child transcript read-only
  through the parent's binding.
- **Why:** Routing tool approvals through the visible thread lets a child work
  in Ask mode without granting it more authority. Single-call decisions avoid
  presenting a child-only grant as a thread-wide grant. Narrowing its tools by profile means
  the child's capability is fixed when it starts, not chosen by its own model.
  Stamping depth and policy in two durable places means a resumed child is
  still a child: it cannot delegate as if it were top-level, widen its
  permission mode, or claim a tool its profile excluded. Keeping the catalog
  in the parent log makes children observable without an extra index.
- **Bounds:** Depth 2, 24 delegated steps, description ≤120 characters, prompt
  ≤100,000 characters, result ≤30,000 characters. Plan/review, skills, MCP
  discovery and `ask_user` are excluded from delegated turns.
- **Consequences:** `listSessions` hides children, but `store.list` keeps them,
  and the parent's card can open one through `readChildSession`. The child's
  logs are complete (muted only suppresses live events), so a crash and resume
  behaves like any other harness session. A thread's mode and permission mode
  are immutable while it is a child; an attempt to change either explains why.

### Cline CLI's reasoning level is a launch flag

- **Date:** 2026-10-22
- **Decision:** Cline CLI's ACP server offers no effort option per session; it
  reads `--thinking <none|low|medium|high|xhigh>` once, when the process starts,
  and without the flag runs with reasoning off. The host starts Cline with the
  level the thread wants (`medium` by default) and lists those five levels on
  every Cline model. A new level is recorded at once and applied before the
  next turn: the host relaunches Cline while no turn is running and reloads the
  open sessions into the new process with `session/load`, muted so their
  history does not replay into the thread, then restores each session's model
  and mode.
- **Why:** The only per-session alternative is writing Cline's own settings
  file, which the app does not own. One process per level would multiply
  sandboxes and probes.
- **Consequences:** The level is process-wide, so two Cline threads at
  different levels relaunch Cline as they alternate. A turn running in another
  thread defers the relaunch, so the new level then waits for idle. Cline
  cannot reload a session that has never had a turn; a new thread therefore
  starts in a process already at its level, and a reload that fails posts a
  notice on that thread.

### Harness effort follows each provider's own switch

- **Date:** 2026-10-22
- **Decision:** Effort tiers stay per provider and model family
  (`effortTiers`). Gateways (OpenRouter, the Cline API, the Kilo API) take
  OpenRouter's vocabulary, None to Extra high, for reasoning families. The
  Cline API gets the pair its own CLI sends, `reasoning_effort` and
  `reasoning.enabled`. Kilo's gateway is OpenRouter-shaped, so it gets
  `reasoning.effort`, including `none`. Its `kilo-auto` routers are virtual
  ids, so they always offer that vocabulary. NIM's
  gpt-oss models take `reasoning_effort`; its hybrid thinkers have only on and
  off, shown as None and High and sent as `chat_template_kwargs` with both
  `thinking` and `enable_thinking`, since templates read one or the other.
  None is sent explicitly only where the wire has an off switch (`SENDS_NONE`);
  elsewhere it leaves the provider's default. Custom OpenAI-compatible
  gateways such as ZenMux use Minimal through High. Kimi K3, including K3.1
  Pro and Highspeed, and K2.8 are the exception: Moonshot publishes Low, High,
  and Max, with Max as the default, and the model always reasons. Their
  `capabilities.reasoning` catalog flag wins when present, including new model
  families; the family matcher is the fallback when it is absent. The Kimi
  list replaces both. That flag follows the catalog into request validation
  so the picker and the wire agree.
- **Why:** Most providers do not report reasoning support in their model lists,
  and a field a provider does not accept fails the call. Where a custom gateway
  does report it, use that signal rather than requiring every new model family
  to be added to a regex.

### OpenRouter's own effort levels replace the gateway vocabulary

- **Date:** 2026-10-26
- **Decision:** An OpenRouter model row that carries
  `reasoning.supported_efforts` supplies the picker's tiers, and
  `reasoning.default_effort` its default. The list keeps the app's tier order
  and follows the catalog into request validation, so Max reaches the wire
  where the model lists it and a level the model does not list is dropped
  instead of sent. A `supported_efforts` of `null` accepts every gateway level;
  an omitted one means the model exposes no effort selection, so no picker and
  no invented family levels. Rows without the block, and the Cline and Kilo
  gateways, keep the family fallback, None to Extra high.
- **Why:** OpenRouter reports effort support per model, but the fixed gateway
  list capped every model at Extra high — hiding Max on Kimi K3.1 Pro and
  others — and offered levels some models reject.

### The request is fitted to the model's window before it is sent

- **Date:** 2026-10-23
- **Decision:** A thread longer than the model's window no longer dies on a
  non-retryable `CONTEXT_WINDOW_EXCEEDED`. Before every model call,
  `harness/context.ts` estimates the request's tokens (≈4 chars/token over
  exactly what the wire sends, images at a flat 1,100 — deliberately
  conservative; providers remain the source of truth through `usage`) and,
  when the window is known, fits the history into it: output reserve
  `min(32k, 10%)`, the rest for input. Fitting shortens old tool results one
  rung at a time — full → head 3k + tail 1k (marked) → skeleton (tool, first
  line, original size) — a result descending fully before the next is touched,
  oldest first, so the newest evidence stays verbatim longest. The recency clip
  (last 8 messages verbatim, older output at 4k chars) moved from `host.ts` to
  the same module as rung zero. Trimming is a request view: the persisted
  transcript keeps full output, and every rung says what it is, so the model
  knows the tail is not the whole output. An overflow the estimator missed is
  recovered reactively: the sent view is refit with the ladder forced to its
  bottom rung (not budget-driven — the provider's count is the one that
  overflowed) and retried once inside the ordinary retry budget; a view that
  cannot shrink fails at once, keeping the overflow code non-retryable in
  effect. The window is resolved through the catalog, which the turn now loads
  if needed, so a listed `context_length` beats the family default. Fitting
  reports `fitted`, `unfittable` or `unknown_window`: an unknown window keeps
  the request unchanged, and only a genuine fit can emit the shortened-to-fit
  notice. An unfittable request stops before another provider call with a
  `CONTEXT_WINDOW_EXCEEDED` recovery error naming a new thread or larger model;
  the full transcript remains intact, and a reactive retry requires a tighter
  request that actually fits.
- **Why:** The four reviewed harnesses all manage this (ZCode's context
  builder, dsh's compaction and spill, MiniMax's compaction trigger); ours had
  only the clip, and a long session was the one thing that broke the default
  agent. Compaction and summarization are deliberately deferred: they need a
  second model call and a summarizer plumbing this phase does not build.
- **Consequences:** No new permission surface, bridge verb or renderer change
  — the fit happens inside `callModel`, and the one visible effect is an
  `agentNotice` (once per session) plus a warning on the reactive retry.
  Oversized *single* results still spill to `.muse/tool-output` in `tools.ts`;
  this phase fits the *accumulated* history and adds no spill path. Unknown
  windows (no catalog row, unknown family) change nothing. The estimator can
  disagree with a real tokenizer in either direction; the ladder's markers
  make each retry strictly smaller, and the provider's own `usage` keeps the
  context chip honest.

### One managed Chromium is shared by the agent and the Browser pane

- **Date:** 2026-10-24
- **Decision:** Add an in-app Browser for the built-in Harness, implemented by
  one Playwright manager in the Node bridge rather than a Tauri child webview.
  The agent and panel use the same fresh context and operation queue per
  workspace or worktree root. The renderer sees JPEG frames and plain text,
  never remote DOM, and forwards its pointer and keyboard input through that
  queue. One page lives per root; downloads and service workers are disabled,
  navigation is limited to http(s), and the user's normal browser profile is
  never opened.
- **Why:** Playwright supplies reliable locators, AI accessibility refs,
  actionability, screenshots and a backpressured screencast. A native webview
  would put hostile page content inside Glitter's window and require a second,
  platform-specific automation implementation. Raster-only panel content also
  keeps the strict renderer CSP and overlay behavior intact.
- **Authorization:** The native shell chooses a compatible installed Chromium,
  validates and digest-pins its executable, and supplies that identity to the
  bridge. No renderer-provided executable, profile or CDP endpoint is accepted.
  Browser verbs require a live workspace grant and revocation closes the
  context. Production always enables Chromium's sandbox; only a direct test
  process can explicitly opt into a development-sandbox fallback, never the
  native app. The browser gets a filtered environment and closes with the
  bridge.
- **Permissions and privacy:** Snapshot, screenshot, console, scroll and wait
  are inspection. Navigation and page-changing actions need an exact-origin
  grant in Ask and Auto, with the origin checked again after the approval wait.
  Full access skips prompts; Plan mode keeps inspection only. Screenshots are
  explicit model-visible image results, not base64 in tool text or screencast
  frames. Old images leave the request view with an omission note and image
  bytes are not persisted in session JSONL. The panel tells the user that page
  content and screenshots go to the selected model provider.
- **Packaging and limits:** `playwright-metadata.mjs` embeds Playwright's package
  and browser-registry metadata into the single verified bridge bundle, so no
  runtime `node_modules` tree is needed. Chromium is installed separately and
  is not redistributed by Glitter. This first version is Harness-only and has
  one tab, no downloads, no arbitrary page-script tool and no Safari/WKWebView
  verification claim. The mock browser preview remains a separate UI-only
  development mode.
