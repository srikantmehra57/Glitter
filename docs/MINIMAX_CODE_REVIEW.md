# MiniMax Code review: what the built-in harness can adopt

MiniMax Code (`MiniMax-AI/minimax-code`, "MCode") is MiniMax's coding-agent
CLI. This document reverse-engineers it and assesses what belongs in *our*
harness (`packages/glitter-harness/src/harness`).

Read alongside [ZCODE_HARNESS_REVIEW.md](ZCODE_HARNESS_REVIEW.md),
[DEEPSEEK_HARNESS_REVIEW.md](DEEPSEEK_HARNESS_REVIEW.md) and
[PI_HARNESS_REVIEW.md](PI_HARNESS_REVIEW.md). All four are compared in
[HARNESS_REVIEWS.md](HARNESS_REVIEWS.md).

**Read this first: MiniMax Code is built on Pi.** It vendors
`third_party/pi-mono` and `@mavis/agent-core` declares
`@earendil-works/pi-agent-core`, `pi-ai` and `pi-coding-agent` as
dependencies. The agent loop is Pi's. What MiniMax built is the *product
around* it — a 568k-line monorepo where the agent core is only 10,805 lines.

That makes this document two things at once: a review of MiniMax's own
contributions, and a **case study in scaling a small agent core into a
product**. For a small desktop harness, the second reading is the more
useful one, because MiniMax had to solve exactly our problems and then
found the smallest answers.

## 1. What MiniMax Code is

### Scale

| Package | files | lines | owns |
|---|---|---|---|
| `packages/tui` | 423 | 110,660 | the terminal UI |
| `packages/local-runtime-v2` | 878 | 197,545 | the product runtime (sessions, turns, plugins, compaction, sandbox) |
| `packages/local-runtime` | 603 | 139,773 | reused host facilities (SQLite, files, git, worktrees, permission facade) |
| `packages/agent-modules` | 137 | 39,774 | 12 second-level modules (permission, compaction, skills, MCP, cron, goal, …) |
| `packages/agent-tools` | 101 | 23,006 | the tool catalog |
| `packages/shared` | 81 | 13,788 | shared types, error classifier |
| `packages/browser-core` | 31 | 12,682 | browser automation |
| `packages/agent-core` | 43 | **10,805** | turn assembly, event bridge, tool contracts — **zero IO** |
| `packages/config` | 35 | 7,272 | configuration |
| `packages/agent-extension` | 17 | 5,395 | SPI glue |
| `packages/protocol` | 3 | 2,183 | thrift-generated wire types |
| `packages/agent-runtime` | 9 | **1,417** | the extension SPI + registry |
| **total `packages/*` src** | | **568,032** | |

Ours: the harness is 1,469 lines.

The number to hold onto: **the agent core is 10,805 lines in a 568k-line
product** — 1.9%. Everything else is product surface. That is the shape we
want our harness to have, and MiniMax got there by putting the loop in Pi
and writing only the contracts themselves.

### `packages/agent-core` is zero-IO by construction

Its own header: *"Pure TypeScript core for Mavis agent-loop contracts.
**Zero IO.** This package contains no filesystem access, no process spawning,
no SQLite, no HTTP server."* And it does not implement the loop either —
`@earendil-works/pi-agent-core` does. `agent-core` is the **assembly +
contract layer**: `PiTurnRunner` wires Pi's `Agent` to MiniMax's tools,
hooks, event bridge and metrics.

This is a good decomposition for us: our `harness/` already has the same
shape (`host.ts` = loop + session, `wire.ts` = providers, `tools.ts` = tools,
`store.ts` = persistence). MiniMax's version adds one idea worth copying —
`packages/agent-runtime` (1,417 lines) is a **pluggable extension SPI** that
contributes tools, prompt prefixes, reminders and hooks *without* the core
knowing about them.

## 2. The turn model

Three nested levels, and MiniMax is careful about the names:

- **Turn** — one `PiTurnRunner.runTurn()` call; owns a `sessionId` + `turnId`.
- **Step** — one Pi iteration = one model response plus its tool executions.
- **Logical call** — one provider request with N physical retries
  (`LLMCallScope = 'agent' | 'compaction' | 'title'`).

`RunTurnCaller` is `'chat' | 'cron' | 'channel_feishu' | 'team' | 'compact'
| 'permission_llm'` — the same runtime serves a chat, a cron job, a chat
channel and a team, and the caller type is *data*.

`PiTurnRunner.runTurn` (`packages/agent-core/src/pi-turn-runner/pi-turn-runner.ts:114-248`)
has an 8-step comment in the source, and the composition order is the
interesting part:

```
composeStreamFn
  → metrics.wrapStreamFn
  → withLLMRetry
  → llmCapture.wrapLogicalStreamFn
  → metrics.wrapLogicalStreamFn
```

Metrics *inside* retry, capture *inside* metrics. The retry wrapper sees
physical attempts; the capture wrapper sees the logical call. That is the
cleanest separation of the three we found in any of the four harnesses.

## 3. What to adopt

### A. Correctness and safety

**A1 — The read-only / dangerous command classifier, already written.**
`packages/agent-modules/permission/src/tools/safe-command.ts` (393 lines) is
a **direct port of OpenAI Codex's `is_safe_command.rs`**, and its header
says so:

> A command that `isKnownSafeCommand` accepts is a known read-only operation
> that can be auto-approved without prompting the user and without persisting
> any rule.

- `ALWAYS_SAFE_COMMANDS` = `cat, cd, cut, echo, expr, false, grep, head, id,
  ls, nl, paste, pwd, rev, seq, stat, tail, tr, true, uname, uniq, wc,
  which, whoami`.
- **Conditional rules** for `base64`, `find`, `rg`, `git`, `sed` — each with
  an option blacklist, "so a flag that can write / execute disqualifies the
  otherwise read-only command".
- `isKnownSafeCommand(argv)` unwraps a `bash -lc` script and is true **only
  when every command in the script is itself safe**. That is the property
  that matters: `ls && rm -rf /` is not safe.
- Supporting parsers: `bash-ast.ts` (436), `bash-split.ts` (704),
  `bash-wrapper-unwrap.ts` (841), `bash-write-target.ts` (600).

Alongside it, the danger registries (`dangerous-patterns.ts`, 1,662 lines):
`HARD_BLOCKED_REGISTRY` (final deny), `SOFT_RISK_REGISTRY` (ask),
`DANGEROUS_BASH_PATTERNS`, `PIPE_TO_SHELL_PATTERN`,
`CROSS_PLATFORM_CODE_EXEC`, `DESTRUCTIVE_STANDALONE_COMMANDS`.

**This is the single most directly useful thing in the MiniMax review for
us.** ZCode has a `guarded` mode with a danger catalogue; dsh has *no*
command classification at all (it relies on sandbox policy instead); pi has
none. MiniMax ported the one implementation that is already battle-tested
against a real codebase's edge cases. Our harness currently approves a
`bash` call by *kind* — "allow commands for session" allows every command
for the rest of the thread, including `rm -rf`.

**A2 — A permission rule that matches a *command* or a *path*, not just a
tool name.**
`PermissionRuleMatcher` (`@mavis/permission/src/types.ts`):

```ts
type PermissionRuleMatcher =
  | { kind: 'tool' }
  | { kind: 'command'; pattern: string }
  | { kind: 'path'; pattern: string; actions?: ('read'|'write'|'delete'|'execute'|'network')[] };
```

`PermissionRule {source: 'global'|'agent'|'session', ruleBehavior, ruleValue:
{toolName, ruleContent?, matcher?}}` — and `ruleContent` for a bash rule is
the actual command, so "always allow `git status`" does not mean "always
allow `git push --force`". This is the same idea as ZCode's `ruleContent`
scoping, with a *path* axis as well.

`DecisionReason` has 13 variants (`rule`, `safetyCheck`,
`workingDirectory`, `internalWhitelist`, `trustedExactWrite`,
`tempDirectory`, `sandbox`, `mode`, `pathValidation`, `dangerousRemoval`,
`subcommandResults`, `rmRewrite`, `recoverableDeleteRewrite`) — a stable
taxonomy, so a denial is explainable and testable.

**A3 — The `CandidateScope` compatibility trick.**
`CandidateScope.kind = 'narrow' | 'byFirstWord' | 'byArgvPrefix2' |
'byDomain' | 'wholeTool'`, and:

> index 0 is always the narrow Codex-aligned default, so a client ignoring
> the field behaves as today.

The permission engine proposes *scopes* for a grant ("this command", "this
command's first word", "this argv prefix", "this domain"), and a client that
ignores the field gets the narrowest one. Our approval card offers
"Allow commands for session" with no notion of scope at all — a scope
concept would let the *user* pick how broad the grant is, and degrade safely
if the UI is old.

**A4 — Fail closed when a hook throws.**
`packages/agent-core/src/pi-turn-runner/events.ts:106-119`: a throwing
`afterLlmCall` hook **strips pending tool-call blocks and forces
`{kind:'failed'}`.** A policy hook that crashes must not leave the agent in
a state where the model believes tools ran.

Ours: `harness/host.ts:476-479` catches an error from the whole turn and
fails it — the same outcome by a different route. But a *tool* hook that
throws (we have none yet) would need this rule.

### B. Capability and quality

**B1 — The continuation contract for truncated output: tell the model how to
get the rest.**
This is the best answer to our 30k-clip problem that any of the four
harnesses produced.

`packages/agent-tools/src/desktop/output-limit.ts` (291 lines) defines
`DesktopOutputOffsetUnit = 'line' | 'match' | 'file'` and attaches to the
result:

```ts
details.desktop_output_truncation = {
  truncated: true, has_more: true, strategy,
  original_bytes, returned_bytes, max_bytes, next_offset?, offset_unit?,
};
details.desktop_output_continuation = {
  has_more: true, next_offset?, offset_unit?,
  continuation_hint: { tool, preserve_args, instruction },
};
```

The `continuation_hint` names **the tool to re-call and the arguments to
preserve**. So a truncated `grep` tells the model "re-run grep with
`next_offset: 200`"; a truncated `read` says "re-run read with
`offset: 400`". The model gets *more data on request*, not a dead end.

Two strategies: `prefix_lines` and `head_tail_lines` (45% head / 55% tail,
whole lines only, UTF-8-boundary safe via `fitUtf8Prefix`/`fitUtf8Suffix`).
Budgets: grep content 16 KiB, read text 24 KiB, bash 24 KiB (22 KiB preview).

Compare the three answers we found across the four harnesses:

| Harness | Answer | Weakness |
|---|---|---|
| Ours | clip at 30k chars | the rest is gone |
| dsh | spill to disk, head+tail, notice | the model must go read a file |
| ZCode | `resultBudget` artifact strategy | same |
| **MiniMax** | **`next_offset` + a re-issue hint** | the model asks for the next slice |

MiniMax's is the only one that stays in the tool's own vocabulary. Ours
should adopt it — it is a ~100-line change to `harness/tools.ts` and it turns
a dead end into a pagination loop.

**B2 — Externalize to an artifact, with a *recovery instruction* rather than
a pointer.**
`packages/agent-extension/src/tool-output-budget.ts` (355 lines). When the
output exceeds `maxInlineBytes` **and the turn exposes a `read` tool** (so
the model *can* recover), the text is written to an artifact and replaced
in-context with a receipt:

```
[Tool output externalized
Tool: <name>
Source: <arg>=<value>
Artifact: <reference>
Recover the needed facts from this artifact now, before answering…
Search this artifact first with bounded rg/grep when available, then read the
relevant ranges with read(path, offset, limit).
Do not treat this receipt as evidence.]
```

Three details worth stealing:

- **The gate checks recoverability.** If the turn has no `read` tool, the
  output is not externalized, because the model could not use it.
- **The receipt tells the model how to search, not just where the file is.**
- **"Do not treat this receipt as evidence."** The model must read the
  artifact, not summarize the receipt.

On persistence failure it falls back to a head+tail preview and records
`{externalized: false, fallback: true, original_bytes}`.

**B3 — The outbound projection: canonical history is never rewritten.**
`packages/agent-core/src/pi-turn-runner/outbound-message-normalizer.ts`:
`projectAgentMessagesForModel(messages, model)` produces the *provider
view* of the history. The canonical history stays canonical; the projection
strips host-only messages, runs `convertToLlm`, removes orphan tool results,
projects video→image, heals undersized images
(`MIN_PROVIDER_IMAGE_EDGE_PX = 8`), and applies the model's per-request image
ceiling.

Ours: `harness/host.ts:397-403` (`history()`) mutates the provider view
directly — it shortens old tool output in place. That conflates the
transcript with the request. ZCode and dsh both keep them separate; dsh's
is "the model history is *derived* from the log".

**B4 — A symbol-keyed identity for the logical call, across physical
retries.**
`packages/agent-core/src/pi-turn-runner/llm-retry.ts` (974 lines).
`LLM_RETRY_CALL_IDENTITY` and `LLM_RETRY_REQUEST_SETTLED_OBSERVER` are
**symbol-keyed identities shared across every physical attempt of one
logical call**. `LLMCallSettledEvent` carries `expectedTools` — *tool
identities only, never arguments* — and raw `usage` buckets only on success.

Two things to take:

- A retry counter that survives a restart (dsh keeps its retry state in a
  session projection; MiniMax keeps the identity on the logical call).
- **`expectedTools` without arguments.** When the request settles, you know
  *which* tools it was about to use without recording what it was going to
  do them to. That is a privacy-preserving audit record, and it is exactly
  right for a desktop app that logs requests.

`DEFAULT_LLM_RETRY_POLICY = {maxRetries: 5, baseDelayMs: 1000,
maxDelayMs: 30000, maxRetryElapsedMs: 120000}` — note the **elapsed cap**,
not just an attempt count. Ours has `RETRIES = 3` and a 20s per-attempt cap
with no total bound, so a turn can spend a minute and a half retrying.

**B5 — Two watchdogs, and a fresh one per attempt.**
`llm-stream-timeout.ts` (261 lines) plus `defaults.ts`:
`LLM_REQUEST_TIMEOUT_MS = 20 min`, `LLM_FIRST_EVENT_TIMEOUT_MS = 300 s`,
`LLM_STREAM_IDLE_TIMEOUT_MS = 300 s`. The first-event bound catches a
provider that accepts the connection and then says nothing; the idle bound
catches one that dies mid-stream. Both are per *attempt*, "so each retry
gets a fresh watchdog".

Ours: `harness/wire.ts:41` has a single `IDLE_MS = 180_000` and no
first-event bound. A provider that accepts and hangs costs three minutes per
attempt.

**B6 — The extension SPI: a table, not a switch.**
`packages/agent-runtime/src/registry.ts` (532 lines) plus `types.ts` (428):

```ts
interface ExtensionAPI {
  readonly params: Readonly<Record<string, unknown>>;
  registerTool<S, TCtx>(contribution: RuntimeToolContribution<S, TCtx>): void;
  contributeSystemPrompt(fn: SystemPromptContributor): void;
  contributeUserPromptPrefix(fn: UserPromptContributor): void;
  registerReminderProvider(provider: ReminderProvider): void;
  on(event: HookName, handler: HandlerFor<K>): void;
}
```

Three phases with hard invariants:

1. **Construction** — `initExtensions` runs each `ext.init(ownerApi)`. Every
   registration asserts `lifecycleState === 'initializing'` **and**
   `activeLoaded === owner`. Any failure ⇒ permanently `failed`, extensions
   cleared.
2. **Assembly** — `assembleTurn(ctx, seed)` merges tools, prompt prefixes,
   reminders and hooks. **Snapshot semantics**: `snapshotExtensions(ctx)`
   captures all enablement *before the first await*, so one `AssemblyResult`
   never mixes old and new states. Duplicate tool name → throw. Reminders
   sorted by descending priority.
3. **Execution** — the host invokes handlers; the registry is not involved.

`HOOK_MAPPINGS` is a table mapping SPI event names to hook fields, so
"adding an event = 2 one-line edits". And `resolveExtensions` applies
profile overlays where **every unresolved id throws** — "fail fast during
construction; never silently discard".

Ours: `harness/host.ts` has a fixed `TOOL_SCHEMAS` array and a hardcoded
`gate()`. There is no way to add a tool without editing the harness. A
1,417-line SPI is a lot for us, but the *table* idea and the "unresolved id
throws" rule are cheap and worth having.

**B7 — A tool factory, so a tool can exist per turn.**
`RuntimeToolContribution = RuntimeTool | RuntimeToolFactory`, where a factory
is `fn(ctx) => null | catalog` — **evaluated per turn**. This is how MCP
progressive disclosure works: a turn that does not need the MCP tools gets
no MCP tools in its catalog.

**B8 — Plan mode that changes the *catalog*, not a flag.**
`packages/agent-extension/src/plan-mode.ts` (260 lines). The plan-mode tools
are registered **conditionally per turn**:

```ts
pi.registerTool((ctx) => (!ctx.plan && agentEntryEnabled() ? enterTool : null))
```

`EnterPlanMode` / `ExitPlanMode` both return `terminate: true` and
`details.waiting_for_user: true` — *"This turn ends now; do not take further
actions."*

And the plan-mode reminder (`priority: 1000`) enforces a **single mutation
exception**: writing the canonical Plan file at exactly one path. Everything
else is read-only, **including read-only shell commands and existing builds
or tests** — but not installing dependencies. That last distinction is
careful: a plan-mode agent should still be able to check whether the project
builds.

Ours: `harness/host.ts:408` refuses edits in plan mode by returning a
string from `gate()`. There is no way to enter plan mode from the model, no
approval boundary on exit, and no exception for the plan file itself.

**B9 — `ask_user` ends the turn with a durable pending request.**
MiniMax's `ask_user` tool "ends the turn with a durable pending request"
instead of producing a final assistant message, and the TUI recognizes it
and settles as "awaiting your answer" rather than a retryable failure.

Ours: the harness has no way to ask the user anything mid-turn. The app has
a `UserInputCard` for Muse; the harness cannot use it.

**B10 — A lightweight context mode.**
`MCODE_CONTEXT_MODES = ['standard', 'lightweight']`. A whole second context
profile, not just a plan-mode flag.

### C. Product surface

- **A hook that returns a `systemMessage`** (`docs/hooks.md`): the notice
  renders after the response, is **persisted in session display history**
  (restored on reopen, no duplication), and is **excluded from canonical
  model history, compaction input, final-answer copying, and default
  Markdown export**. "systemMessage alone does not request another model
  call." The verification recipe is five manual checks. This is a precise
  answer to "where does a hook's notice live", which ZCode and dsh both
  handle but neither states this crisply.
- **Terminal status via OSC 7501** — `app=mcode` with
  `idle | working | done | error | blocked`, where `blocked` covers
  permission, question and login. Our app has the same need (a spinner is
  not a status) and already has an approval card, but no *blocked* state
  for the window itself.
- **`/btw` side conversations**: inherit the latest complete prefix of
  persisted history; **unfinished tool-call groups are excluded together**
  (you cannot fork into the middle of a tool call); the boundary is fixed
  at creation; they keep the parent's permission mode and are hidden from
  the session list.
- **A compaction trigger that can only move earlier.**
  `contextManagement.compactionTriggerAt` "can only make it *earlier*, never
  later". The default reserves the output limit (capped at ¼ window) and
  takes 95% of the remainder.

## 4. What not to copy

- **`packages/local-runtime` and `packages/local-runtime-v2`** (337k lines
  combined). A Drizzle/SQLite schema with 40+ migrations, a service mesh, a
  daemon protocol, a v1-compat bridge. Our app already has a native shell
  with its own persistence, and our harness sessions are JSONL files.
- **The browser, canvas, miniapp, website-deploy and content-safety
  subsystems** — product features, not harness mechanisms.
- **The thrift-generated protocol with numeric enums.** `RuntimeEventType`
  is a numeric enum and `ProtocolErrorCode` uses codes like
  `USAGE_LIMIT_EXCEEDED=42212`, `LLM_CREDITS_EXHAUSTED=50110`,
  `LLM_RATE_LIMITED=50111`, `LLM_AUTH_ERROR=50112`. The codes are useful;
  the *numeric* wire encoding is a thrift artifact. dsh's string codes
  (`RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, …) are better for a protocol
  that crosses a trust boundary.
- **The `operationClassifier` as a policy input.** MiniMax is explicit that
  it is "a *bounded observability label*, not a policy", and that unknown,
  malformed or throwing classifications collapse to a shared `unknown`
  metric value. We should adopt the fail-closed shape, not treat a
  classifier as an allow-list.
- **The two-runtime split** (`local-runtime` v1 + v2, 337k lines) and the
  `compat/v1` bridge. We do not need a second runtime.

## 5. The case study: what a 568k-line product kept in its 10.8k-line core

The most transferable thing in this repo is not a mechanism — it is the
*proportion*.

| Layer | MiniMax | What it holds |
|---|---|---|
| `agent-runtime` | 1,417 | the extension SPI and registry |
| `agent-core` | 10,805 | turn assembly, event bridge, tool contracts, metrics, retry |
| *(pi-agent-core)* | *2,519* | *the loop itself* |
| `agent-modules` | 39,774 | permission, compaction, skills, MCP, cron, goal, runaway-guard, reminders, hooks |
| `agent-tools` | 23,006 | the tool catalog |
| `local-runtime-v2` | 197,545 | the product runtime |
| `tui` | 110,660 | the UI |

The rule that produced this shape: **the core owns contracts and assembly;
everything else is a module that contributes to it.** MiniMax's
`agent-modules` are twelve independent packages, each mounted through the
1,417-line SPI, none of them imported by the core.

If we want our harness to grow the way this one did, the enabling change is
small: turn `TOOL_SCHEMAS` and `gate()` into *contributions* from a
registry, so that permission, compaction, skills and MCP can be added
without touching `harness/host.ts`. That is a refactor of the harness's
shape, not a feature.

## 6. Suggested order

1. **A1** (the Codex read-only command port) — the single most valuable
   import in this review. It turns "allow commands for session" from a
   blanket grant into a scoped one, and it is already written.
2. **A2** (rule matchers on command and path), **A3** (grant scopes),
   **B1** (the `next_offset` continuation contract), **B2** (the artifact
   recovery receipt).
3. **B4** (a total elapsed cap on retries), **B5** (a first-event watchdog),
   **B3** (separate the canonical history from the provider view).
4. **B6/B7** (an extension SPI with a hook table), **B8** (plan mode that
   changes the catalog), **B9** (`ask_user`).
5. Skills, MCP, subagents, compaction — as in the other reviews.

## 7. Sources

Read from the MiniMax Code checkout at `main`: `packages/agent-core/src/*`
(especially `pi-turn-runner/*`, `tools/*`, `event-bridge/*`),
`packages/agent-runtime/src/*`, `packages/agent-tools/src/desktop/*`,
`packages/agent-modules/{permission,context-manager,system-reminder,
runaway-guard,skills,mcp,goal,background-task}/*`,
`packages/local-runtime-v2/src/service/turn-system/*`,
`packages/protocol/src/*`, plus `docs/architecture.md`, `docs/hooks.md`,
`docs/tui-capabilities.md` and `docs/plugins/`. MiniMax Code is MIT-licensed
for its first-party default (see `LICENSE-STATUS.md`); the mechanisms above
are reimplemented here, not copied.
