# Harness integration plan

A phased plan to bring the built-in harness (`packages/glitter-bridge/src/harness`)
up to what the four reviewed harnesses do, and to close the gap between the
harness and the rest of the app.

**Sources.** [HARNESS_REVIEWS.md](HARNESS_REVIEWS.md) compares ZCode, DeepSeek
Harness, Pi and MiniMax Code and carries the 20-item ranking this plan
sequences. The per-harness reviews are
[ZCODE_HARNESS_REVIEW.md](ZCODE_HARNESS_REVIEW.md),
[DEEPSEEK_HARNESS_REVIEW.md](DEEPSEEK_HARNESS_REVIEW.md),
[PI_HARNESS_REVIEW.md](PI_HARNESS_REVIEW.md) and
[MINIMAX_CODE_REVIEW.md](MINIMAX_CODE_REVIEW.md).

**The problem this plan solves.** The harness is the app's default agent
(`store.ts:4480` prefers it over Muse) and currently its least capable one.
It has no skills, no MCP, no plugins, no structured questions, and a
permission model that grants `rm -rf` for the rest of a thread.

**Shape of the plan.** Phases 1–3 are self-contained and each ships alone.
Phase 3 is the enabling refactor: everything after it is a module rather than
a special case in `host.ts`. Phases 4–7 are each independently valuable and
independently shippable.

## Ground rules (apply to every phase)

- **The renderer stays untrusted.** Nothing in this plan moves filesystem,
  process or credential work into the webview. New bridge verbs need an
  allowlist entry and a strict DTO (`lib.rs`, `dto.rs`).
- **One implementation per concern.** No parallel permission model, no second
  session store, no second tool registry.
- **The agent is the source of truth.** No simulated agent output, no invented
  reasoning.
- **Every phase adds tests** to `tests/harness.test.mjs` (which already has
  Anthropic and OpenAI stubs) and, for UI work, to the matching
  `apps/desktop/src/components/*.test.tsx`.
- **Every phase passes `npm run verify`** before hand-off.
- **User-visible changes** go in `CHANGELOG.md` under `[Unreleased]`.
- **Architectural changes** (Phases 2, 3, 7) get a `docs/DECISIONS.md` entry.
- **UI phases** follow the build/install workflow in `AGENTS.md`: build, then
  replace `/Applications/Glitter.app`, then trash the bundle copy.
- Phases 1–3 are **harness-only**: no protocol change, no new dependency, no
  UI change. That keeps them fast to review and safe to land.

---

## Phase 0 — Baseline

**Goal.** Land the research so the next agent picks it up without re-deriving
it.

- [x] Four harness reviews (`docs/*HARNESS_REVIEW.md`)
- [x] Four-way comparison and ranking (`docs/HARNESS_REVIEWS.md`)
- [x] This plan (`docs/HARNESS_INTEGRATION_PLAN.md`)
- [x] Confirm Phase 1's eight items against the current tree — the harness has
      uncommitted work in flight (`harness/host.ts`, `harness/store.ts`,
      `UsageView.tsx`, `usageLedger.ts`, `store.ts`)

**Exit:** the plan is in `docs/`, and no phase-1 line number is stale.

---

## Phase 1 — Harness correctness

**Status: done** (PR #1, confirmed against the tree on 2026-10-21). Every item
is in `harness/` and each test below is in `tests/harness.test.mjs`.

- [x] 1.1 `wire.ts` reads `cache_read_input_tokens` and
      `cache_creation_input_tokens`; `usedTokens` is their sum with
      `input_tokens`. OpenAI's `cached_tokens` is subtracted from
      `prompt_tokens` so the counters stay disjoint there too.
- [x] 1.2 `sessionFacts.usage` carries `promptTokens` (uncached),
      `cacheReadTokens` and `cacheWriteTokens`, persisted in the session meta.
      The chip already read `context`; it shows a Cached row and `format.ts` a
      cache line.
- [x] 1.3 `isTruncatedStop` (`length`, `max_tokens`, `max_output_tokens`)
      fails every tool call in the reply with a "re-issue" result.
- [x] 1.4 `TOOL_NOT_STARTED` and `TOOL_OUTCOME_UNKNOWN`, told apart by a
      `toolStarted` record written before the side effect.
- [x] 1.5 `prepareTool` freezes the arguments; the card's `rawArgs` and the
      handler use the same object. An ambiguous edit fails with no card.
- [x] 1.6 `SystemPrompt { stable, volatile }`, built once per turn. Only the
      stable block carries `cache_control`. Differs from the plan: the date and
      mode are the volatile part; `AGENTS.md` is in the stable part and is
      re-read at the next turn, not mid-turn.
- [x] 1.7 `ifBusy` queue / steer / replace, plus `unqueueTurn`. A steer is
      folded in after the tool results, never between a call and its result.
- [x] 1.8 Three retries inside a 120 s total budget (`retryBudgetOpen`), a
      60 s first-event watchdog separate from the 180 s idle one.

**Goal.** Close eight defects a user can hit today. Harness-only, ~400 lines,
no UI, no protocol change.

| # | Change | Source | Why | Effort |
|---|---|---|---|---|
| 1.1 | Read Anthropic's `cache_read_input_tokens` and `cache_creation_input_tokens`; report `usedTokens` as the **sum** | dsh, Pi | `wire.ts` reads only `input_tokens`, which Anthropic counts *uncached only*. The composer chip shows "0% used" for a 120k cached prefix | 3 lines |
| 1.2 | Split the usage counters: `promptTokens` (uncached), `cacheReadTokens`, `cacheWriteTokens`; thread them through `sessionFacts` and the context chip | dsh, Pi | Today `promptTokens` is the only counter, and the chip's `remainingTokens` is wrong | 40 lines |
| 1.3 | When the stop reason is `length` / `max_output_tokens`, **discard the tool calls** and return a result telling the model to re-issue them with complete arguments | Pi | A half-streamed `{"command":"npm test --filter="}` is valid JSON and semantically wrong. We ignore `stopReason` today | 30 lines |
| 1.4 | Replace the single recovery filler with two causes: "never started" and "outcome unknown", each with actionable wording | dsh, ZCode | One string tells the model nothing it can act on | 30 lines |
| 1.5 | Parse and freeze tool arguments **once**, before the approval card, and hand the same frozen value to the card and the handler | all four | We show raw model input and parse it after approval; an ambiguous `edit_file` asks permission, then fails | 80 lines |
| 1.6 | Compute the system prompt once per turn; split it into a stable part and a volatile part | ZCode, dsh | `AGENTS.md` is re-read from disk on every model call (≈40 reads/turn), and any change invalidates the provider's prompt cache every step | 120 lines |
| 1.7 | Honor the `ifBusy` disposition the store already sends: queue, steer, replace | dsh, Pi, ZCode | The composer already offers "Queue a follow-up"; the harness throws "still working" | 100 lines |
| 1.8 | Add a total elapsed cap to retries, and a first-event watchdog (separate from the idle watchdog) | MiniMax | 3 min × 3 attempts with no total bound; a provider that accepts and hangs costs 9 minutes | 60 lines |

**Files.** `packages/glitter-bridge/src/harness/{wire.ts,host.ts,tools.ts}`,
`packages/glitter-bridge/src/index.ts` (pass `ifBusy`), `apps/desktop/src/lib/types.ts`
(usage shape), `apps/desktop/src/components/Composer.tsx` (chip).

**Tests.** Extend `tests/harness.test.mjs`:

- an Anthropic stub reporting `cache_read_input_tokens` yields a `usedTokens`
  that includes it
- a `length` stop with a tool call produces a tool result saying "re-issue",
  and the tool does **not** run
- an `edit_file` whose `old_string` is ambiguous produces **no** approval card
  (it fails before the card)
- a queued turn is admitted while a turn runs, and runs after it
- a first-event watchdog fires on a stub that never sends a frame

**Risks.** 1.5 and 1.6 change what the approval card shows and what the
provider receives — check the `harness.test.mjs` assertions on
`rawArgs` and on `calls[n].body.system` before landing.

**Exit.** `npm run verify` green; the context chip is correct on a cached
Anthropic turn; no truncated reply can execute a tool.

---

## Phase 2 — The tool contract

**Status: done.** Most of it landed with the Phase 1 work in PR #1 (with the
DECISIONS entry "A tool result is three channels, and the model pages what
does not fit"). A follow-up PR closed the gaps found when checking it against
the exit criteria, marked *follow-up* below.

- [x] 2.1 `ToolValue` → `render()` (model prose) and `presentationMeta()`
      (card state, persisted on the transcript item as `presentation`). A
      fourth field, `display`, is the user's view when it must differ from the
      model's receipt.
- [x] 2.2 `Continuation` with `nextOffset`, `offsetUnit` (`line` / `match` /
      `file`) and `continuationHint`; `grep` and `list_files` take
      `next_offset`, `read_file` takes `offset`. *Follow-up:* an externalized
      result keeps the paging instruction after its receipt, and a walk that
      hits its limit stops instead of reading the rest of the tree.
- [x] 2.3 Output past 30 000 characters goes to `.muse/tool-output/` in the
      workspace (0600 / 0700, one encoded filename) with a receipt.
      *Follow-up:* that folder gets a `.gitignore` of `*`, so saved output
      never shows as a project change; `read_file` is never externalized (it
      is how saved output is read back) and cuts one over-long line at its
      budget instead, so a minified line cannot loop receipt → receipt.
- [x] 2.4 `executionMode()` is `concurrent` only for an exact `true` from
      `isConcurrencySafe`; `scheduleToolCalls` is a pool of 10 that runs
      anything else alone, with results in model order.
- [x] 2.5 Deep key-sorted `canonicalize`; the 2nd, 5th and 8th identical call
      gets a labelled `[harness-repeat]` note. The call still runs.
- [x] 2.6 `ProviderError.code`, retries keyed on it. *Follow-up:* an empty
      body is `EMPTY_RESPONSE` (it was classed as malformed), a stream that
      closes with no frame is `EMPTY_RESPONSE` and one that closes without its
      end marker is `STREAM_CLOSED`; both are retried instead of a partial
      reply being taken as the answer. Not changed: a 400 that rejects the
      reasoning setting is still recognised by its wording.

Differs from the plan: the Files list names `types.ts` and the tool-card
components, against the "harness-only" ground rule. The `presentation` field
and the card that reads it did ship in PR #1; the follow-up is harness-only.

**Goal.** Stop treating a tool result as one string. This is the enabling
refactor for Phases 3–7, and the reason diff cards, artifact output and
nested tool calls become possible at all.

| # | Change | Source | Effort |
|---|---|---|---|
| 2.1 | A tool returns a **canonical typed value**; a separate `render()` produces the model's prose; a separate `presentationMeta()` produces replayable UI state | dsh, Pi, MiniMax | 200 lines |
| 2.2 | The `next_offset` continuation contract: a truncated result carries the offset, the unit (`line`/`match`/`file`) and a `continuation_hint` naming the tool and args to re-issue | MiniMax | 100 lines |
| 2.3 | Externalize oversized output to an artifact with a **recovery receipt** (how to search it, how to read it, and that the receipt is not evidence) | MiniMax, dsh | 120 lines |
| 2.4 | Per-tool `executionMode`, fail-closed parallelism, and results committed in **model order** | dsh, Pi | 80 lines |
| 2.5 | Detect a repeated identical tool call (deep key-sorted argument canonicalization) and warn the model | dsh | 120 lines |
| 2.6 | Provider failure codes instead of prose matching (`RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, `MISSING_CREDENTIAL` vs `INVALID_CREDENTIAL`, `EMPTY_RESPONSE`) | dsh | 80 lines |

**Files.** `harness/tools.ts` (largest change), `harness/host.ts`,
`harness/wire.ts` (error taxonomy), `apps/desktop/src/lib/types.ts` (the new
result shape), the tool-card components.

**Tests.** `tests/harness.test.mjs`: a `write_file` result carries the diff
metadata; a truncated `grep` result carries `next_offset` and re-issuing it
returns the next slice; two identical `grep` calls trigger the repeat
warning; two independent reads run concurrently and their results reach the
model in order.

**Exit.** A tool result is three things (model prose / typed value / UI
metadata) and the model can page through truncated output.

---

## Phase 3 — An extension surface

**Status: done** (2026-10-21, with the DECISIONS entry "Harness tools,
prompt sections and hooks come from a registry"). The system prompt and the
seven tool schemas a turn sends were compared byte for byte before and after,
in Build and Plan mode, and are identical.

- [x] 3.1 `ExtensionRegistry` in `harness/registry.ts`: an `Extension`
      contributes tools, `stable` / `volatile` prompt sections (the latter are
      the reminders) and hooks. `register` returns the function that removes it.
- [x] 3.2 `HookEvents` maps a name to its payload: `turnStarted`,
      `toolStarting`, `toolFinished`, `turnFinished`. Handlers observe only, run
      in registration order, and one that throws becomes a warning notice.
- [x] 3.3 `snapshot()` is the first statement of `runTurn`, before any await.
      It copies the tool map, schemas, prompt sections and hook tables, so a
      registration made mid-turn waits for the next turn.
- [x] 3.4 A duplicate extension id, static tool name or profile id throws at
      `register` and adds nothing; a factory's duplicate, an unknown profile, or
      a profile naming a missing tool throws at `snapshot`, failing the turn
      before any model call. Profiles exist for Phase 7; nothing uses one yet.
- [x] 3.5 A tool entry may be a factory of the turn context, returning a
      definition, a list, or nothing for that turn.
- [x] 3.6 `BUILTIN_TOOLS` in `tools.ts` holds the seven tools as
      `ToolDefinition`s (schema, permission `kind`, `concurrencySafe`,
      `validate`, `run`), registered as the `builtin` extension with the
      prompt line that names them. `runTool(root, name, …)` stays for tests.

Differs from the plan: the host still owns the permission gate and the plan
card, keyed on a definition's `kind` (`read` / `edit` / `shell` / `plan`), not
on tool names. Phase 4 replaces the gate.

**Goal.** Replace the hardcoded `TOOL_SCHEMAS` and `gate()` in `host.ts` with
a small registry, so that permission, skills, MCP and subagents become
*modules* rather than special cases.

MiniMax's lesson: their agent core is 10,805 lines in a 568k-line product
because everything else is a module mounted through a 1,417-line SPI.

| # | Change | Source | Effort |
|---|---|---|---|
| 3.1 | A contribution registry: extensions register tools, prompt prefixes, reminders and hooks | MiniMax | 300 lines |
| 3.2 | A hook table (name → handler) so adding an event is two one-line edits | MiniMax | 60 lines |
| 3.3 | Snapshot semantics: a turn's contributions are captured **before the first await**, so a turn never mixes old and new state | MiniMax | 40 lines |
| 3.4 | Duplicate tool name → throw; an unresolved profile id → throw (never silently discard) | MiniMax | 40 lines |
| 3.5 | A per-turn tool **factory**, so a tool can exist only for the turns that need it | MiniMax | 40 lines |
| 3.6 | The existing seven tools move to the registry unchanged — no behaviour change | — | 100 lines |

**Files.** New `harness/registry.ts`; `harness/host.ts` shrinks; `harness/tools.ts`
registers rather than exports a constant.

**Tests.** `tests/harness.test.mjs`: a duplicate tool name throws; a turn's
tool set is stable across a registry change made mid-turn; the seven built-in
tools still work identically (the existing suite is the regression net).

**Exit.** `harness/host.ts` no longer knows what a tool is, and the existing
harness test suite passes **unchanged**.

---

## Phase 4 — The permission model

**Status: done** (2026-10-21, with the DECISIONS entry "Harness permissions:
guards deny, the policy asks, and a grant names its subject"). The code is in
`harness/permission/`.

- [x] 4.1 A thread grant is a `Grant` naming its subject: an exact command, an
      argv prefix, a file, or a folder (`grants.ts`). A tool definition's
      `subject()` says what a call acts on, so the host stays tool-agnostic.
      Changing the permission mode clears the grants, as before.
- [x] 4.2 `classify.ts` ports the Codex read-only list and its per-program
      rules (`base64`, `find`, `rg`, `git`, `sed`) over a small shell reader
      (`shell.ts`) instead of a full bash AST. The reader refuses what it does
      not model (substitution, subshells, here-documents, control flow), and a
      refused script is never read-only. Stricter than Codex: an argument that
      is absolute, starts with `~` or has a `..` segment asks instead, because
      the harness's read tools are confined to the workspace. A read-only
      script runs without asking in every mode, Plan mode and read-only
      threads included.
- [x] 4.3 `danger.ts`: `block` rules (root or home `rm -r`, formatting or
      erasing a disk, raw writes to a device, recursive `chmod` of root, fork
      bombs) and `ask` rules (recursive `rm`, force pushes, discarding changes,
      history rewrites, `find -delete`/`-exec`, `rsync --delete`, inline code,
      pipe-to-shell, `sudo`, publishing, the keychain). Wrappers such as `sudo`
      and `env` are unwrapped and `bash -c` scripts read; a script the reader
      cannot parse is checked against coarser fallback patterns.
- [x] 4.4 `guards.ts`: a guard returns a refusal or nothing, guards run before
      the policy in every mode, and a guard that throws refuses. Extensions
      contribute guards through the registry; the built-in extension
      contributes the danger guard.
- [x] 4.5 Approvals end as `allowed`, `rejected`, `cancelled`, `expired` or
      `unavailable`, each with its own message to the model. `unavailable` is
      immediate when the host has no approval channel (`approvalChannel:
      false`), for the delegated children of Phase 7.
- [x] 4.6 The card offers thread scopes narrowest first. A client that lists
      every choice gets one labelled button per scope with the narrowest at
      index 1 (the ⇧⌘Y slot); this app groups choices that carry `scopeLabel`
      into a picker beside one "Allow in thread" button. A risky command is
      offered no thread scope, and the card says why.

Differs from the plan: no bash AST (the reader covers what the classifier
needs and refuses the rest), and an `expired` outcome beside the four named,
since a timeout was the case the reviews said the model could not tell apart.
Full access still runs ask-level risks without asking; the guarded mode is
5.5.

**Goal.** Make the permission model mean something. Today "Allow commands for
session" allows every command, including `rm -rf`, for the rest of the thread.

| # | Change | Source | Effort |
|---|---|---|---|
| 4.1 | Scope a session grant to a **subject**: the actual command, path or URL — never just the tool kind | ZCode, MiniMax | 150 lines |
| 4.2 | Port the read-only command classifier (Codex's `is_safe_command.rs`, already ported by MiniMax) plus the bash AST it needs | MiniMax | 400 lines |
| 4.3 | A danger registry: hard-block vs. soft-ask, with pipe-to-shell and code-exec patterns | MiniMax | 250 lines |
| 4.4 | **Deny-only monotonic guards**: a layer that can only deny, so no listener order turns a denial into permission | dsh | 40 lines |
| 4.5 | A closed approval outcome set — `allowed-once`, `rejected`, `cancelled`, `unavailable` — failing closed when no channel is mounted | dsh | 60 lines |
| 4.6 | Grant **scopes** on the approval card: this command / this command's first word / this argv prefix, with the narrowest as the default so an older UI degrades safely | MiniMax | 120 lines |

**Files.** New `harness/permission/` (classifier, rules, guards);
`harness/host.ts`; `apps/desktop/src/lib/types.ts` (approval choice shape);
`apps/desktop/src/components/ApprovalCard.tsx` (scope buttons).

**Tests.** `tests/harness.test.mjs`: "allow `git status` for this session"
does not allow `git push --force`; `ls && rm -rf /` is not classified
read-only; a guard denial survives a policy listener that says allow.

**Exit.** No session grant is broader than the thing the user approved.

---

## Phase 5 — App parity

**Status: in progress.** 5.1, 5.2, 5.3 and 5.4 are done (2026-10-21 and
2026-10-22, with the DECISIONS entries "Harness skills are folders it discovers
each turn", "A Harness question ends the turn", "Plan mode ends with a plan
review" and "Per-call usage is emitted, not logged"); 5.5 is not started.

- [x] 5.1 `harness/skills.ts`: a skill is a folder with a `SKILL.md` whose
      frontmatter has `name` (the folder name when missing) and
      `description`. Roots, nearest first: `.glitter/skills` and
      `.agents/skills` in the workspace, then the same two in the home folder;
      the nearest wins a duplicate name. A skill with no description, an
      invalid name, or a folder or file that resolves outside its root is
      skipped. The `skills` extension publishes names and descriptions as a
      stable prompt section, rebuilt every turn and saying it replaces any
      earlier list, and adds a `skill` tool (read kind, so no approval) only
      when the catalog has entries. The tool loads the body, or with `file`
      another file confined to that skill's folder. A `/name` typed in a
      Harness thread is expanded when sent: the transcript shows what was
      typed, the model gets the same `<skill_content>` rendering the tool
      returns. The composer, the slash menu and Extensions list Harness skills
      through `listSkills`.
- [x] 5.2 `harness/questions.ts`: `ask_user` takes one to four questions, each
      with no options (a free answer) or two to six, single or multiple
      choice. A batch that asks ends the turn: the batch's other results and
      the question are written to the session log as a `question` record, and
      the app gets a `userInputs` event marked `turnEnded` after
      `turnCompleted`, so the thread is idle while the card waits. Answering,
      explaining ("Let me explain") or declining completes the tool message
      and starts a new turn (`turnStarted` with `cause: "userInput"`). A new
      message settles an unanswered question first, so nothing can wedge. The
      question survives a restart and reopens with the thread. Only the first
      ask in a reply stands; with no approval channel the tool is not offered.
      The card is the existing `UserInputCard`; no new UI.
- [x] 5.3 `exit_plan_mode`, offered only in Plan-mode turns (a per-turn
      factory, with a volatile prompt line telling the model to use it), is a
      5.2 question with a `planReview` intent. Its one question names its
      answers, `Approve` and `Keep planning`, with the plan as the Approve
      option's preview, so a client without the review card still works. The
      app's `PlanReviewCard` shows the plan as Markdown with Approve and
      build, Send feedback and Keep planning. Approve switches the thread to
      Build (an `agentConfig` event) before the next turn's snapshot, so the
      next turn has edit tools and no plan review. Feedback becomes a real user
      message, in the history and the transcript, and the model revises in
      Plan mode. Keep planning, or declining, settles the call and starts no
      turn: no model request is spent on a dismissed review.
- [x] 5.4 The harness emits a `modelCall` per call it makes: provider, model,
      effort, input tokens (cached included, the way the ledger counts them),
      the cached share, output tokens, the provider's finish reason, duration,
      how many tool calls the reply asked for, and — only on a retry — which
      attempt landed. The app gathers them on the thread until the turn ends,
      then stores them as that ledger entry's `calls`: at most 80 for one turn,
      detailed for the newest 25 turns, and re-bounded when read back. Settings
      → Usage shows them in a Trajectory section, recent turns that have calls,
      newest first, each opening onto its call list. The harness session log
      keeps no copy (see "Per-call usage is emitted, not logged").

**Goal.** Give the harness the features the app already gives Muse.

| # | Change | Source | Effort |
|---|---|---|---|
| 5.1 | **Skills** for the harness: `SKILL.md`, progressive disclosure (name + description at start, body on load), the catalog **replaced** rather than appended | all four | 250 lines + picker |
| 5.2 | `ask_user` as a turn-ending durable request, reusing the app's existing `UserInputCard` | MiniMax, dsh | 150 lines + UI |
| 5.3 | Plan mode as a real **approval boundary**: the model proposes a plan, the user approves or rejects with typed feedback, and the rejection becomes a user message | ZCode, dsh, MiniMax | 200 lines + UI |
| 5.4 | A per-call **trajectory view**, extending the in-flight `usageLedger.ts` with each call's input, output, finish reason, tokens and duration | ZCode, dsh | 250 lines + UI |
| 5.5 | An "autonomous but not reckless" permission mode: ordinary calls auto-approve, dangerous ones still ask | ZCode, MiniMax | 80 lines |

**Files.** `harness/skills.ts` (new), `harness/host.ts`,
`apps/desktop/src/components/ExtensionsView.tsx` (skills list becomes
agent-aware), `apps/desktop/src/components/UserInputCards.tsx`,
`apps/desktop/src/components/UsageView.tsx`, `apps/desktop/src/lib/usageLedger.ts`.

**Tests.** `apps/desktop/src/components/*.test.tsx` for each UI surface;
`tests/harness.test.mjs` for the skill catalog, `ask_user` and the per-call
usage a turn reports.

**Exit.** The default agent can use a skill, ask a question, and be
approved to leave plan mode.

---

## Phase 6 — MCP

**Goal.** External tools, with the same guarantees as built-in ones.

| # | Change | Source | Effort |
|---|---|---|---|
| 6.1 | Launch stdio and streamable-HTTP MCP servers; sandboxed, timeout-bounded, scrubbed environment | dsh, ZCode | 300 lines |
| 6.2 | Merge MCP tools into the same registry and the same permission pipeline — `mcp__server__tool`, needs approval, per-tool budgets | dsh, ZCode | 150 lines |
| 6.3 | Two-phase **all-or-nothing** sync: build the whole next generation, then swap; roll back on conflict, so the model sees the full set or none | dsh | 120 lines |
| 6.4 | Deferred discovery, so MCP tools do not ship in every prompt | dsh, ZCode | 150 lines |
| 6.5 | Surfaces in the app's existing MCP settings, agent-aware | — | 80 lines |

**Exit.** An MCP server's tools appear, are permissioned, and can be revoked
without leaving a partial set behind.

---

## Phase 7 — Subagents

**Goal.** Delegation, done safely.

| # | Change | Source | Effort |
|---|---|---|---|
| 7.1 | A `task` tool that spawns a child agent with a narrowed tool set, a turn cap and a model override | ZCode, dsh | 300 lines |
| 7.2 | **Delegation depth as a durable monotone floor**, so a resumed child cannot delegate as if it were top-level | dsh | 80 lines |
| 7.3 | The child's delegated policy stamped into **its own log**, so its scope is reconstructable and it can never widen it | dsh | 100 lines |
| 7.4 | A parent-owned durable child catalog, so children are discoverable without waking them | dsh | 100 lines |
| 7.5 | A read-only drill-down in the app, reusing the existing `SubagentModal` | ZCode | 150 lines + UI |

**Exit.** A delegated task runs under a policy the user can see, and cannot
recurse without bound.

---

## Phase 8 — Optional: codemode

The model writes a program that calls tools, executed in a sandbox, so nested
calls never enter the model's context (Pi). **Defer.** It needs 2.1 (a
canonical value), 2.4 (parallel execution) and a way for a nested call to
inherit the approval gate — Pi exports `runToolCall` for exactly this. Only
worth it if long, tool-heavy turns are a real complaint.

---

## Sequencing at a glance

```
0  Baseline
   │
1  Harness correctness ──────── ship alone, ~400 lines
   │
2  Tool contract ────────────── ship alone, ~700 lines
   │
3  Extension surface ────────── ship alone, ~580 lines   ← the enabling refactor
   │
4  Permission model ─────────── ship alone, ~1000 lines
   │
5  App parity ───────────────── skills, ask_user, plan boundary, trajectory
   │
6  MCP ──────────────────────── needs 2, 3
   │
7  Subagents ────────────────── needs 3, 4
   │
8  Codemode (optional) ──────── needs 2, 4
```

**Phases 1–4 are the whole of the urgent work.** After Phase 4 the harness
is correct, safe and honestly scoped, and the app stops being *worse* on its
default agent than on Muse. Phases 5–7 make it better.

**Rough effort.** Phase 1 ≈ 1 week, Phase 2 ≈ 1.5 weeks, Phase 3 ≈ 1 week,
Phase 4 ≈ 2 weeks, Phase 5 ≈ 2–3 weeks, Phase 6 ≈ 2 weeks, Phase 7 ≈ 2 weeks.

---

## Explicitly not doing

- **A plugin *framework*.** Phase 3 is a registry, not a runtime. Pi's
  `pi-durable` (27k lines), dsh's Cordis DI runtime and ZCode's dynamic
  workflow family are each a product, not a harness primitive.
- **A rule engine before the classifier.** 4.1 without 4.2 is a rule engine
  with no good rules.
- **An LLM-based permission classifier.** MiniMax has one for its `auto` mode;
  it is a network round-trip on every decision and a prompt-injection surface.
- **A durable/transactional session store.** Our JSONL sessions are readable,
  greppable and deletable. That is a feature.
- **Porting ZCode's runtime.** 79k lines, and dsh's core is already 10×
  ours.

## Risks to watch across phases

| Risk | Mitigation |
|---|---|
| The harness grows a second permission model, or a second tool registry | Phase 3 exists to prevent exactly this; the "one implementation per concern" rule is the gate |
| A new dependency sneaks in | Each phase adds none; check `THIRD_PARTY_NOTICES.md` if that changes |
| The approval card's contract changes under the app | Phase 1.5 and 4.6 change `ApprovalChoice`; update `types.ts`, `ApprovalCard.tsx` and `tests/approval-preview.test.mjs` together |
| The context chip's numbers move | Phase 1.1–1.2 change what `sessionFacts` carries; `format.ts` and `Composer.tsx` follow in the same PR |
| The trust boundary erodes | No phase moves filesystem, process or credential work into the renderer; new bridge verbs need a `BRIDGE_METHODS` entry and a DTO |
