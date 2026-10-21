# ZCode review: what the built-in harness can adopt

ZCode (`zai-org/ZCode`, Apache-2.0) is Z.ai's coding-agent harness: an Electron
workbench, a web client, a backend and — the part that matters here — a full
agent runtime in `apps/zcode-cli`. This document is a reverse-engineering of that
runtime and an assessment of what belongs in *our* harness
(`packages/muse-bridge/src/harness`).

It is a design review, not an implementation plan. Every claim below was read
in the ZCode source, not inferred from its docs.

This is one of four harness reviews. The others are
[DEEPSEEK_HARNESS_REVIEW.md](DEEPSEEK_HARNESS_REVIEW.md) (DeepSeek Harness,
`dsh`), [PI_HARNESS_REVIEW.md](PI_HARNESS_REVIEW.md) (Pi) and
[MINIMAX_CODE_REVIEW.md](MINIMAX_CODE_REVIEW.md) (MiniMax Code, which is
built on Pi). [HARNESS_REVIEWS.md](HARNESS_REVIEWS.md) compares all four and
carries the combined ranking.

## 1. What ZCode actually is

### Scale

| Area | Files | Lines |
|---|---|---|
| `core/src/runtime` (the agent loop) | 187 | 41,137 |
| `core/src/tool` (tools, executor, scheduling) | 216 | 37,685 |
| `core/src/subagent` (delegation) | 22 | 3,797 |
| `core/src/hooks` | 19 | 2,769 |
| `core/src/memory` | 14 | 1,648 |
| `core/src/context` | 14 | 1,339 |
| `core/src/compact` | 6 | 870 |
| `core/src/permission` | 6 | 1,066 |
| `core/src/system-reminder` | 3 | 467 |
| `core/src/agent` (history, turn state) | 14 | 2,641 |
| **`core/src` total** | **573** | **107,411** |
| `packages/contracts` (provider-neutral types) | | 22,963 |
| `packages/adapters` (AI-SDK provider layer) | | 55,156 |

Ours, for scale: `packages/muse-bridge/src` is 6,984 lines, of which the harness
is 1,469 (`host.ts` 630, `wire.ts` 337, `tools.ts` 270, `store.ts` 135,
`providers.ts` 97).

**Our harness is 0.8% the size of ZCode's agent runtime.** That number decides
the strategy: we cannot port ZCode, and we should not try. What we can port is
ZCode's *contracts* and a handful of specific mechanisms, each of which fixes a
defect we can demonstrate in our own code.

### The layers

```
UI (Electron/React)  ──stdio──▶  Desktop Main (host, process, forward)
                                        │
                                        ▼
                              Agent CLI  (apps/zcode-cli)
                              ├─ core/src/runtime   the loop
                              ├─ core/src/tool      registry + executor
                              ├─ core/src/permission broker
                              ├─ core/src/hooks     lifecycle hooks
                              ├─ core/src/mcp       MCP client
                              └─ core/src/context   prompt assembly
                                        │
                                        ▼
                          contracts/  →  adapters/  →  providers
                          (neutral)      (AI SDK)      (Anthropic, OpenAI, …)
```

The important structural fact: **ZCode's core does not know about any
provider.** `packages/contracts/src/model` defines a neutral `Model` interface
(`generateText`, `streamText`, `bind`), a `ModelRequest`/`ModelResult` shape and
a `ModelRetryBudget`. The AI-SDK implementation lives in `packages/adapters`.
The runtime only ever sees the contract.

We already have the same split, in miniature: `harness/wire.ts` is the only
file that knows Anthropic vs OpenAI, and `harness/host.ts` is the only file
that knows the loop. That boundary is ZCode's most important idea and we got it
right the first time.

### The turn loop, in one paragraph

`executeTurn` freezes the turn's facts *before any `await`* (model selection,
turn id, trace context) — the comment at `turn.ts:349` explains why: a model
switch that happens during async init used to cross the admission boundary.
Then it resolves context sources, runs `SessionStart` hooks, persists the user
message, and enters `runRegularTurnLoop`. Each iteration drains a
`RuntimeCommandQueue` (background-task notifications, subagent replies,
mid-turn steering), runs micro-compaction, then auto-compaction, refreshes MCP
tool listings, computes the per-turn tool set, injects per-request system
reminders, builds the provider request, and runs one model step. A model step
streams text and tool calls, executes the tool batch, settles the results into
*both* the canonical history and the turn-local request view, and loops.

Two details carry most of the weight:

- **Two-tier history.** `MessageHistory` is canonical and persisted;
  `TurnRequestState.entries` is the per-request view. `appendTurnRequestEntries`
  writes only to the turn-local copy; `commitTurnRequestEntries` writes to
  both. This is what lets a harness inject a synthetic continuation, a
  per-request reminder, or a model-only notice without polluting the
  transcript or breaking the provider's cache prefix.
- **Durable event log.** `SessionEvent`s are appended to a store (which assigns
  a sequence number) and *only stored events* are published to live sinks. The
  UI's live view, the replay and the snapshot therefore share one ordering
  fact. `SessionProjection` is derived by an `EventReducer`, never stored.

## 2. Where we differ

| Area | ZCode | Ours | Verdict |
|---|---|---|---|
| Provider layer | neutral `Model` contract + AI-SDK adapter | `wire.ts`, two wires | equivalent shape, smaller |
| Tool set | 44 built-ins + MCP + deferred loading | 7 | **big gap** |
| Tool metadata | `ToolMetadata` (readOnly, destructive, concurrentSafe, riskLevel, sideEffectScope, needsApproval) | `toolKind()` → 4 kinds | **we lose safety and parallelism** |
| Tool execution | parallel groups, topological order, budget, artifacts | strictly sequential, hard char clip | **we lose speed and output** |
| Input normalization | `resolveInput` stage before hooks/approval | parsing inside the handler | **we approve A and run B** |
| Permissions | rule engine, `ruleId` taxonomy, `ruleContent` scoping | 4 modes + per-*kind* session grant | **our session grant is too coarse** |
| Context | 3-message stable/dynamic split, cache breakpoints | one flat string rebuilt per call | **we break prompt caching** |
| Compaction | LLM compaction + local micro-compaction | char-truncation of old tool output | partial |
| Output-token limit | resume up to 3× | **ends the turn, truncated** | **bug** |
| Steering / queue | `RuntimeCommandQueue`, 3 delivery modes | throws "still working" | **gap** |
| Subagents | full, background, coordinator replies | none (Muse-only in the app) | gap |
| Skills / MCP | full, for every agent | Muse-CLI only; harness gets none | **gap** |
| Hooks | 7 events, trust model | none | gap |

## 3. What to adopt

Ordered by value per line changed. Each item names the defect it fixes in
*our* code, because that is the only justification worth having.

### A. Correctness (do these first)

**A1 — Resume after the output-token limit.**
ZCode: `runtime/methods/turn-output-token-continuation.ts`. When a provider
returns `length` with no tool calls, it appends a synthetic user message
("Output token limit hit. Resume directly — no apology, no recap…"), tagged
`queryScope: "output_token_continuation"` so it is filtered out of the recorded
projection, and re-requests, up to `MAX_OUTPUT_TOKEN_CONTINUATIONS = 3`.

The subtlety worth copying: `model_context_window_exceeded` is deliberately
treated as a *continuation*, not an overflow, because Anthropic allows the
input to fit while input + `max_tokens` does not. Turning it into an exception
triggers a pointless compaction.

Ours: `wire.ts` yields `stopReason` on the `done` event; `host.ts:504-537`
ignores it, and `runTurn` breaks out of the loop when the reply has no tool
calls. A long answer is silently truncated and the turn ends as "completed".
Fix: thread `stopReason` out of `callModel`, and in `runTurn` treat
`length`/`max_output_tokens`/`model_context_window_exceeded` as "continue" up to
three times, with the synthetic continuation message kept out of the stored
transcript. ~50 lines in `host.ts`.

**A2 — Validate and normalize before asking permission.**
ZCode's `ToolEntry.resolveInput` (`tool/types.ts:339`) is a distinct pipeline
stage that runs *after* `validateInput` and *before* the PreToolUse hook, the
permission check, the approval preview and the handler. The doc comment gives
three reasons, all of which we need:

> 1. 策略不被绕开 — a policy that scans the script sees the real script.
> 2. 跨版本可见 — the input channel is schema-less passthrough; the display
>    channel is not.
> 3. 确认与执行同字节 — parse once, that byte travels to the handler. There is
>    no "approve A, run B".

Ours: `host.ts:568-570` shows the *raw model input* on the approval card, and
`tools.ts:runTool` parses it *inside* the handler, after the user approved. So
today a user approves a call that then fails on the user's own terms:
`edit_file` with an `old_string` that matches three places asks for permission
and *then* returns "old_string matches 3 places". The approval was never
needed. Fix: add a normalization step that resolves the edit target, validates
uniqueness and the path, and fails *before* the approval card. The same step
gives us the "approved bytes are the executed bytes" invariant for free.

**A3 — Stop rebuilding the system prompt on every model call.**
Ours: `host.ts:380-394` re-reads `AGENTS.md` from disk on *every* model call
(`callModel` → `systemPrompt`). In a 40-step turn that is 40 filesystem reads,
and if `AGENTS.md` changes mid-turn the prompt changes — which invalidates the
provider's prompt cache on every step and re-bills the whole prefix.

ZCode splits the prompt into three system messages: a short `cli_prefix`, a
**stable** body and a **dynamic** body, with `cacheControl: {type:"ephemeral"}`
on the stable/dynamic boundary (`context/builder.ts`,
`runtime/helpers/provider-request-messages.ts`). The stable body is what the
cache holds; the dynamic body (date, mode, todo state) changes freely.

Fix: compute the static part once per turn, keep the volatile part in a
separate system message. On the Anthropic wire we can then send
`cache_control` on the stable message. This is the single biggest *cost* win
available to us, and it is a pure refactor.

**A4 — Mark tool output as untrusted, and refuse forged control markers.**
Every byte the model reads from `read_file` or `bash` is attacker-influenced
(a repository can contain a file that says "ignore previous instructions").
ZCode's `wrapSystemReminder` (`system-reminder/source.ts:228`) throws if the
body contains a nested `<system-reminder>` tag, and `sanitizeSystemReminderBody`
escapes any that slip through — so tool output cannot forge a reminder
boundary.

We have no reminder concept yet, so the immediate version is smaller: (a) say
in the system prompt that tool output is data, not instructions; (b) when we
add reminders (A5), enforce the nested-tag rule at the wrapper.

**A5 — A system-reminder registry, when the first reminder exists.**
ZCode declares every reminder source in three closed sets
(`SYSTEM_REMINDER_PREFIX_SOURCES`, `..._PERSISTED_SOURCES`,
`..._PER_REQUEST_SOURCES`), each with a declared delivery channel and
lifecycle. Two properties fall out for free: *persistence is decided by source,
not by call site*, and a cold resume reproduces the same provider-visible
prefix. It is 467 lines in ZCode; the *idea* is ~40 lines for us.

**A6 — Stop losing the tail of long command output.**
Ours: `tools.ts:133` clips tool output at 30,000 characters and `shellTool`
stops accumulating at 60,000. A `npm test` run with more than 30k characters of
output leaves the model with the first half and no idea what failed.

ZCode's `resultBudget` (`contracts/src/tools/contract.ts:117`) has three
strategies — `inline`, `truncate`, and **`artifact`** — where `artifact` writes
the oversized output to a file and returns a `<persisted-output>` pointer the
model can then `read_file`. It also keeps `originalBytes` (produced) and
`returnedBytes` (actually sent) as the only public metering state, and the
truncation suffix is machine-readable. The `artifact` strategy is the right
answer for `bash` in a desktop app, and it is ~60 lines: write to the session
directory, return the path plus a head/tail preview.

### B. Capability

**B1 — Per-tool capability metadata, and parallel tool execution.**
Our gate keys on `toolKind()`: `read`, `edit`, `shell`, `plan`. ZCode keys on
`ToolMetadata` (`readOnly`, `destructive`, `concurrentSafe`, `riskLevel`,
`sideEffectScope`, `needsApproval`), and `canRunInParallel`
(`tool/scheduler.ts:85`) derives parallelism from *that* metadata with a
specific precedence: `destructive` ⇒ never; explicit `concurrentSafe` wins over
`readOnly`; else `readOnly` ⇒ yes; else `sideEffectScope === "none"`.

Ours: `host.ts:466-469` runs tool calls in a sequential `for` loop. Three
independent greps run one after another. With read-only metadata, read-only
calls can run concurrently (capped, say, at 4), and a `bash` that the model
issued as `ls` can be classified read-only at the same call site as the
permission check.

**B2 — Scope the "for this session" grant to the thing that was approved.**
Ours: `live.allowed` is a `Set<ToolKind>`, and "Allow commands for session"
(`host.ts:419`) allows *every* command for the rest of the thread — including
`rm -rf`. ZCode's session grant carries a `ruleContent`: the actual command,
URL or path, matched by prefix (`git:*`), wildcard or exact equality
(`permission/service.ts:342`). "Always allow `git status`" therefore does not
mean "always allow `git push --force`".

This is a safety regression in the current harness, and it is the single
highest-priority item on this list after A1-A3. It also needs a third choice
beyond our current "once / session / deny": deny *with a typed reason*, which
comes back to the model as a normal user message rather than a bare refusal.

**B3 — An "autonomous, but not reckless" permission mode.**
ZCode's `guarded` mode runs like yolo but pauses for one approval when a
command matches a curated danger catalog (`rm -rf`, `git reset --hard`,
`git push --force`, `find -delete`, `rsync --delete`, …), matched by an AST
analyzer with per-rule exemptions (dry-run, help flags, POSIX vs CMD
dialects). A matcher that cannot parse the command falls back to the yolo
policy rather than pretending it is safe.

We could ship a much smaller version: a *dangerous-command* list checked
against the command string, with everything else auto-approved in that mode.
The list is the cheap half; the AST analyzer is the expensive half and we can
skip it. This gives users a real "let it work" mode that is not a blank
check.

**B4 — Structured questions mid-turn (`AskUserQuestion`).**
ZCode's `AskUserQuestion` never blocks forever: the queue head gets a
5-minute window, and if it expires the runtime closes the tool with empty
answers and the model continues on its best judgment — never a fake user
bubble, never a permission deny.

We have no way for the harness to ask the user anything mid-turn. The app
already has a `UserInputCard` and a `clarify` path for Muse; the harness
cannot use them. Even a minimal version — the model proposes 2-4 options, the
app renders them, the answer comes back as a tool result — would stop the
harness from guessing when a question has a small set of answers. The
auto-resolution timeout is the part that makes it safe to add: an unanswered
question must not wedge the turn.

**B5 — Steering and queueing for the harness.**
The store already speaks a disposition (`queue` / `steer` / `replace`, store.ts:548)
and passes `ifBusy` on `sendTurn`, but the bridge drops it for the harness
(`index.ts:772`) and `harness/host.ts:328` throws "still working on the
previous message". So a Muse user can queue a message mid-turn and a Harness
user cannot.

ZCode's model is the spec worth copying: three delivery modes (steer = inject
at the next tool boundary, queue = hold for the next turn, guide = inline
alongside the next tool result), all admitted through one `RuntimeCommandQueue`
so background completions, steering and rewinds never race. We do not need the
whole queue; we need the harness to stop throwing and to accept a queued
message.

**B6 — Skills and MCP for the harness.**
This is the largest capability gap and it is not a harness bug: MuseCode's
`ExtensionsView` (skills, plugins, MCP) is entirely Muse-CLI-backed
(`host.ts:831` calls `skill/list` on the Muse connection). A user who picks the
built-in Harness agent loses all of it, and the Harness is the app's
*default* agent (`store.ts:4480` prefers `harness`).

ZCode's skill model is small and worth copying whole: a directory with
`SKILL.md` (`name` + `description` frontmatter + body), only the metadata
loaded at session start and the body loaded on activation (progressive
disclosure), user scope (`~/.agents/skills`) overridden by project scope
(`.agents/skills/`), duplicate names resolved by scope. The `Skill` tool loads
the body into the session. ~150 lines plus a picker.

MCP is a bigger build (transport, OAuth, per-tool budgets, trust), but the
*shape* is right: MCP tools enter the same registry and the same permission
pipeline, get an `mcp__server__tool` name, and are marked `shouldDefer` so
they are discovered on demand rather than shipped in every prompt.

**B7 — Subagents.**
ZCode's `Agent` tool spawns a child runtime with a narrowed toolset, the
parent's allowlist intersected, a turn cap, and a model override; the child's
blocking interactions (permission prompts) are routed back to the *parent*
session, because the UI only knows the parent's id. Child tool events are
mirrored into the parent with rewritten ids. Background children wake the
parent on completion through the same command queue.

Our app already has `SubagentModal` and `controlSubagent` for Muse. The
harness has nothing. This is a big feature (a second runtime instance, event
mirroring, a parent wake channel) and should come after A and B1-B5, but it is
the feature that most changes how the harness *feels*.

### C. Product surface (UI-side, mostly Muse-generic)

These live in the renderer and mostly benefit every agent, not just the
harness.

- **Model trajectory viewer** — a per-call I/O log (input → output, tokens,
  duration, finish reason) per session. ZCode's is backed by bounded
  delta-appended JSONL read tail-first. We have `UsageView` and
  `usageLedger.ts` but no per-call trace. This is the best debugging surface
  a coding agent can ship, and the harness is exactly the agent that needs it:
  it is the one whose behaviour we own and therefore must be able to inspect.
- **Deny-with-feedback** in the approval card (B2).
- **Plan mode with an approval boundary** — ours hard-refuses edits and makes
  the user flip a mode toggle; ZCode's `ExitPlanMode` asks the user to approve
  the plan, and rejection text becomes a real user message.
- **A command palette that searches commands, threads and files at once**
  (`Cmd+K`, with `>` / `#` / `@` scope prefixes). We have `CommandPalette.tsx`;
  ZCode's version searches three scopes in one modal.

## 4. What not to copy

- **The shape of `core/src/runtime`.** 187 files and 41k lines for a
  request→tools→request loop. `subagent/runner.ts` alone is 2,162 lines. Port
  the *contracts* (`ToolEntry`, `Model`, `SessionEvent`,
  `SystemReminderSourceDescriptor`, `AgentProfile`) and write a small loop.
- **The dynamic-workflow tool family** (11 tools), MCP Apps, the CUA/browser
  plugins, off-peak scheduling, and the telemetry facade. All product-specific
  depth.
- **The memory subsystem** (`core/src/memory`, 1,648 lines plus a `dream`
  consolidation pass and an extraction subagent). The *idea* of a durable
  project memory is good; the implementation is a second agent, a lock file
  protocol and a four-phase consolidation prompt. Not now.
- **Topological tool-dependency scheduling.** We have no tool-to-tool
  dependencies, so `topologicalSort` is dead weight. Keep only
  `canRunInParallel`'s precedence rules.
- **ZCode's own dead surfaces.** `patternSources`, `alwaysAllowPatternSources`
  and `denyPriority` are written by every handler and never read by the
  runtime. The `auto` permission mode is reserved and always denies. Copying
  these would add API surface that does nothing.
- **Message-level "rewind this conversation".** ZCode *retired* it
  (`docs/rewind-button-any-message.md`) because it conflates chat rollback with
  file rollback. We have per-turn file snapshots already; the file-level undo
  is the one to keep.
- **The Anthropic thinking-signature repair machinery** (~300 lines) unless we
  hit the bug. `wire.ts:181` already sends thinking blocks back verbatim with
  their signature, which covers the common case.

## 5. Suggested order

1. **A1** (output-token resume), **A2** (validate before approval),
   **A3** (stable prompt split). Each is a contained change to
   `harness/host.ts` + `harness/wire.ts`, each fixes a demonstrable defect.
2. **A6** (artifact output), **B1** (tool metadata + parallel execution),
   **B2** (scoped session grant). The permission item is a safety fix and
   should not wait long.
3. **B5** (steering/queue — the bridge already passes `ifBusy` and throws it
   away), **B4** (AskUserQuestion), **B3** (guarded mode).
4. **B6** (skills first, MCP second). Skills are the smaller half and they fix
   a visible product gap: the default agent has no skills.
5. **B7** (subagents) and the C-tier UI surfaces.

## 6. Sources

Read from the ZCode checkout at `main`, `apps/zcode-cli/packages/core/src` and
`packages/contracts/src`, plus `apps/zcode-cli/docs/usage/04-tools.md`,
`05-permissions.md`, `07-mcp.md`, `08-skills.md`, `09-hooks.md` for the
user-facing contract. ZCode is Apache-2.0; the mechanisms above are
reimplemented here, not copied.
