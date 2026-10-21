# DeepSeek Harness review: what the built-in harness can adopt

DeepSeek Harness (`deepseek-ai/deepseek-harness`, MIT) is `dsh` — an
everything-is-a-plugin agent harness built on [Cordis](https://github.com/cordiverse/cordis).
This document reverse-engineers it and assesses what belongs in *our* harness
(`packages/muse-bridge/src/harness`).

It is a design review, not an implementation plan. Every claim was read in the
dsh source, not inferred from its docs. This is one of four harness reviews. The others are
[ZCODE_HARNESS_REVIEW.md](ZCODE_HARNESS_REVIEW.md) (ZCode),
[PI_HARNESS_REVIEW.md](PI_HARNESS_REVIEW.md) (Pi) and
[MINIMAX_CODE_REVIEW.md](MINIMAX_CODE_REVIEW.md) (MiniMax Code, which is
built on Pi). [HARNESS_REVIEWS.md](HARNESS_REVIEWS.md) compares all four and
carries the combined ranking.

## 1. What dsh actually is

### The shape

dsh has **no privileged core**. Every part of the product is a Cordis plugin:
the model adapter, the tool registry, the session log, the agent loop itself.
Plugins contribute *services*, *typed events* and *reversible effects* to a
shared context, and unregister when their plugin unloads. A running `dsh` is a
plugin tree composed at boot from ordered layers (a **profile** → **bundles**
→ patches).

The three concepts that carry the design:

1. **Capability seam** (`docs/capability-seams.md`). A capability has three
   roles — a **Service Definition** (the `ctx.<key>` owner), **Service
   Providers** (implementations) and **Consumers** (usually a model-facing
   tool). "The seam is the complete capability, never one role." This is why
   one provider swap moves the whole product: filesystem and subprocess
   providers share one execution world, so pointing them at a remote sandbox
   moves Bash, PTY and LSP with them, with no provider forks.

2. **Scope layers.** Contributions (tools, prompt sections) are *global* or
   *scoped* — owned by exactly one scope key, and a live agent is the key of
   its own scope. A scoped registration *shadows* a global one. Events flow
   **up** the scope chain, never down.

3. **Model-visible ⟺ logged.** The session log is the single source of truth.
   The LLM message history is **derived** from it (`deriveMessages()`), never
   stored separately. Every model request must be reconstructable from the log.

### Scale

| Area | files | lines |
|---|---|---|
| `packages/core` (session, tools, agent, agent-loop, system-prompt, scope) | 40 | 14,571 |
| `packages/session` (durable sessions, formats, persistence) | 97 | 18,185 |
| `packages/llm` (provider layer) | 76 | 14,352 |
| `packages/subagent` | 42 | 10,112 |
| `packages/boot` | 51 | 11,106 |
| `packages/shell` | 19 | 4,734 |
| `packages/context` | 23 | 4,460 |
| `packages/sandbox` | 19 | 3,607 |
| `packages/interaction` | 14 | 2,901 |
| `packages/compaction` | 18 | 2,828 |
| `packages/skill` | 5 | 2,774 |
| `packages/mcp` | 8 | 1,426 |
| `packages/spill` | 9 | 1,209 |
| `packages/preset` | 10 | 1,175 |
| `packages/guard` | 2 | 321 |
| **all `packages/*` src** | **2,206** | **379,338** |
| `packages/client` (the web UI) | 699 | 90,235 |
| `packages/extensions` (runtime self-modification) | 34 | 21,982 |

Ours: `packages/muse-bridge/src` is 6,984 lines, of which the harness is
1,469.

**This is the headline number.** dsh's *entire agent core* is 14,571 lines —
about ten times our harness, and a quarter of ZCode's `core/src/runtime`
(41,137) plus `core/src/tool` (37,685) combined. dsh is the harness we could
actually read end to end and port ideas from. ZCode's runtime is not, and
neither is dsh's client, extensions or session-format migration chain.

### The turn model

A **step** is one model request plus the tools it calls. A **turn** is zero or
more steps: it opens before its first input is claimed and closes once nothing
is owed.

```
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step; reject | enter(messages, startsRequestSeries?)
     step/start
     agent/request -> prepareCall
     append entered messages as user/message
     derive and freeze model history from the log
     stream the bound prepared call -> llm/stream
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> next step
  -> agent/turn-stopping
turn/end
```

Two details carry most of the weight:

- **The system prompt is derived history, not a request field.** It is surface
  node 0 — a `system/message` event. The request header
  (`EpochHeader = {config, adapterDefaults, tools}`) deliberately excludes it,
  so "a prompt change replaces or appends a system node and leaves the header
  unchanged."
- **Prompt caching is achieved by log structure, not wire annotations.** The
  prepared call carries a capability flag `systemPromptUpdate: 'in-history'`
  and `toolUpdate: 'in-history' | 'addition-only'`. When the route supports
  it, a changed system prompt or a set of added tools is **appended after the
  cached prefix** instead of rewriting message 0. A surface *replacement*
  (compaction) invalidates the cache from the first shadowed token.

## 2. Where we differ

| Area | dsh | Ours | Verdict |
|---|---|---|---|
| Tool result shape | canonical JSON value + `output.render` (model prose) + `output.presentationMeta` (replayable UI state) | one `output: string` | **we conflate three things** |
| Tool policy | `tools/pre-execute` waterfall + **monotonic guards** (deny-only) | one `gate()` on tool kind | **we have no deny-only layer** |
| Parallel tools | `isConcurrencySafe(args)`, fail-closed; rolling pool, commits in model order | strictly sequential | gap |
| Approval | closed outcome set `allowed-once \| rejected \| cancelled \| unavailable`, fail-closed | 3 choices, no "unavailable" | gap |
| Session state | one append-only log; model history **derived** | messages *and* UI items stored separately | **two sources of truth** |
| Tool-call recovery | `TOOL_NOT_STARTED` vs `TOOL_OUTCOME_UNKNOWN` + tailored guidance | one generic filler string | **we under-specify** |
| Repeat-call detection | `repeat-tool-reminder` guard | none | gap |
| Oversized output | spill to disk + head/tail retention + recognizable notice | 30k char clip | gap |
| Steering | unified inbox (`next-turn` / `next-step`), `followup` / `steer` / `inject` | throws "still working" | gap |
| Provider failures | `LlmError` code taxonomy (20 codes) | a `ProviderError` with a status | gap |
| Retries | provider-owned policy, executed by a separate plugin, durable counter | hardcoded `RETRIES = 3` inline | gap |
| Prompt caching | `in-history` append after cached prefix | prompt rebuilt per call | gap |
| Skills / MCP | full | Muse-CLI only; harness gets none | gap |
| Subagents | full, with durable depth floor and delegated policy | none | gap |

## 3. What to adopt

Each item names the defect it fixes in *our* code.

### A. Correctness and safety

**A1 — Monotonic guards: a policy layer that can only deny.**
dsh separates two things we conflate into one `gate()`:

- `tools/pre-execute` is a **waterfall**: a policy listener may return
  `{kind:'allow'}`, `{kind:'deny'}`, `{kind:'cancel'}` or `{kind:'ask'}`.
  Order matters; a later listener can change the verdict.
- A **guard** is `ToolGuard = (exec) => string | undefined`. It can only return
  a denial reason. There is no "allow" result, so *listener ordering can never
  turn a denial back into permission*.

Ours: `harness/host.ts:406-413` has one `gate(kind)` returning
`"allow" | "ask" | string`, and the only "deny" reasons are mode-based
("Plan mode is on", "the thread is read-only"). There is no place to hang a
hard invariant that no future listener can talk you out of — for example
"this path resolves outside the workspace" or "this command is in the
dangerous set".

Fix: split `gate()` into an ask-policy (per kind) and a guard (per call,
deny-only). The guard is where `confine()`'s containment check, the
dangerous-command list and the workspace-root invariant belong. ~30 lines,
and it is the pattern I'd copy first.

**A2 — Freeze the arguments once, and show the executed bytes.**
dsh's registry materializes `arguments` as detached lossless JSON in one
recursive pass, **freezes** that value before policy starts, and assigns an
opaque `exec.token`. The same frozen value flows to the policy, the approval
card, the guard, the body and the log. `callId`, `name`, `arguments`, `agent`
and `token` stay immutable through dispatch.

Ours: `harness/host.ts:570` shows `JSON.stringify(call.input)` — the raw
model input — on the approval card, and `harness/tools.ts:runTool` parses it
*inside* the handler, after the user approved. This is the same "approve A,
run B" defect the ZCode review found (`resolveInput` there), and dsh solves it
more strictly: freeze once, and there is no second parse to diverge from.

Fix: parse and freeze the input in one place, before the approval card, and
pass the frozen value to both the card and the handler.

**A3 — Replace the generic tool-call filler with a recovery vocabulary.**
Ours: `harness/wire.ts:72` fills a missing tool result with
`"The user stopped this turn before the tool ran."` — one string for every
cause. A model reading that cannot tell "never started" from "started and we
don't know what happened", and the correct action differs.

dsh distinguishes two codes (`packages/core/session/src/repair.ts`):

- `TOOL_NOT_STARTED` — "The tool call was interrupted before the Harness
  recorded it as started. Retry it if it is still needed."
- `TOOL_OUTCOME_UNKNOWN` — "…it was recorded, but no result was durably
  recorded. Its outcome is unknown. Decide whether to retry from the tool
  semantics: retry only if the operation is read-only or idempotent; if it may
  have side effects, first verify external state or ask the user. Do not
  retry blindly."

That second sentence is the whole point. It is the difference between a model
that re-runs a half-executed `write_file` and one that checks first. ~20 lines.

**A4 — A `max-tokens` reply must not execute its tool calls.**
dsh's `BlockAssembler` drops **every** tool call when the finish reason is
`max-tokens`: a truncated tool call may have incomplete arguments, and
executing it is unsafe. It also prunes the matching replay entry so content
and metadata cannot disagree.

Ours: `harness/wire.ts` yields `stopReason` and `harness/host.ts:504-537`
ignores it, so a truncated `edit_file` call with half a JSON argument reaches
`runTool`, fails to parse, and returns a parse error to the model — while a
truncated `bash` call with a *complete but wrong* command could execute.

Fix: when the stop reason is `length` / `max_output_tokens`, discard the
tool calls and treat the turn as text-only. This composes with ZCode's
output-token continuation (see the ZCode review, A1): dsh's rule is the
safety half, ZCode's is the recovery half.

**A5 — An empty completion is an error, not a success.**
dsh's error taxonomy has `EMPTY_RESPONSE` in the default *retryable* set. Our
harness treats an empty reply as a normal completion and ends the turn
silently (`host.ts:464` breaks when there are no tool calls). A provider
that returns an empty body has failed, and the user should see a retry, not
an empty message.

**A6 — Approval outcomes are a closed set that includes "unavailable".**
dsh: `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' |
'unavailable'`, and the last one is **fail-closed** — if no approval channel
is mounted, the call is *denied* with a distinct reason, not silently
allowed. Each outcome maps to a different denial reason, so the model can tell
a human "no" from an absent channel.

Ours: `harness/host.ts:415-445` has three choices
(`allow-once` / `allow-session` / `deny`) and a 10-minute expiry that
resolves to "denied". The model cannot distinguish "the user said no" from
"the prompt timed out" from "the app has no UI".

**A7 — Split the cache counters.**
dsh's `TokenUsage` keeps `inputTokens` (uncached), `cacheReadTokens` and
`cacheWriteTokens` **disjoint**, plus `outputTokens` and optional
`reasoningTokens`. Adapters that fold cache hits into a total subtract them
back out.

Ours: `harness/host.ts:84` tracks `usage: {promptTokens, outputTokens}` and
the app's context chip computes `usedTokens = promptTokens` against a window.
If a provider reports cached reads, our number is wrong — and it is wrong in
the direction that makes the context chip look full. We should track cache
reads/writes separately from the first provider that reports them.

### B. Capability and quality

**B1 — Split the tool result into three things.**
dsh's `ToolDefinition` has three separate surfaces, and the cookbook is
emphatic that they are different concerns:

| Surface | Purpose | Rule |
|---|---|---|
| `execute()` returns a **canonical JSON value** | the truth | validated against `output.schema`, frozen, persisted |
| `output.render(args, value)` | the **model-facing** prose | the only thing the model reads |
| `output.presentationMeta(args, value)` | **replayable UI state** | persisted on `tool/result` so a card reproduces on replay |

Plus `presentCall(args)` / `presentResult(args, result)` for the UI, which
must be **pure functions** — no I/O, no session state, no clock, no random —
because they run both during live streaming and during session-log replay.

Ours: `harness/tools.ts` returns `{output: string, isError?, exitCode?, path?,
command?, plan?}`. The model sees a prose string; the UI gets a JSON-stringified
args blob. There is no canonical value, so nothing can be validated, and the
UI card for a `write` cannot show a diff on replay.

Fix (small version): have `runTool` return a typed value per tool
(`{kind:'read', path, lines}` / `{kind:'diff', path, oldText, newText}` /
`{kind:'terminal', command, stdout, exitCode}`), keep one `render()` for the
model, and let the renderer (not the app) own the UI shape. The diff card
falls out of the edit tool returning `oldText`/`newText` — we already read
the file to compute the edit.

**B2 — Parallel tool execution, fail-closed.**
dsh's `isConcurrencySafe?(args): boolean` is **fail-closed**: only the exact
value `true` opts in; omission, a throw, or any other value is `exclusive`
(`packages/core/tools/src/index.ts:1313-1319`).

The scheduler is a **bounded rolling pool** (`maxParallelToolCalls`, default
10) that commits results in **model order** — "commitReady advances only
across contiguous model-order slots" — so parallel *execution* never changes
the *order* the model sees. On abort, unstarted calls get a synthetic
`tool/call` + `ABORTED_BEFORE_DISPATCH` `tool/result` pair so the log stays
valid.

Ours: `harness/host.ts:466-469` runs tool calls in a sequential `for` loop.
Three independent greps run one after another. With a per-tool predicate
("read-only, no cwd mutation") and a commit-in-model-order rule, this is
maybe 60 lines — and it is the single biggest perceived-speed win available.

**B3 — Detect repeated identical tool calls.**
dsh's `packages/guard/repeat-tool-reminder` is 240 lines and is, by value
per line, the best idea in the whole repository.

- The chain key is `JSON.stringify([toolName, canonicalize(arguments)])`,
  where `canonicalize` is a **deep key-sort** of the parsed JSON — so
  `{a:1,b:2}` and `{b:2,a:1}` are the same call.
- Thresholds `[3, 5, 8]`: the first threshold emits a gentle reminder, later
  ones a detailed one naming the tool, the run length and the canonical
  arguments (capped at 500 chars, because "large payloads would otherwise
  ride into the next request unbounded — precisely in a loop scenario").
- It hooks `tools/post-execute` and is **observe-and-enrich, never veto**:
  it counts first, then `await next()`, then folds the reminder onto whatever
  came back — so even a *denied* call counts (a model hammering a denied call
  is exactly the loop worth breaking).
- A user message resets the chain (an interjection is not a loop).
- The reminder is stamped with a labelled source, because "an unlabeled
  context would render as a user prompt".

Ours: nothing. A model that retries a failed `grep` with the same pattern
burns a turn and the user watches it happen. This is ~120 lines for us and it
needs the `post-execute` seam from B1.

**B4 — Spill oversized output instead of truncating it.**
dsh's `packages/spill` splits into a seam (`saveText` → `SpillRef`), a local
backend and a *policy* that decides when to spill. The policy keeps a
**contiguous head and tail** (binary-search `fitText`, surrogate-safe),
images are indivisible, and the full original goes to disk with a
**recognizable notice**:

```
(Omitted 12345 bytes. Full formatted result stored at: <path>. <retrievalHint>)
```

`hasSpillNotice(text)` re-detects it later. On any storage failure the
original inline result is kept — best-effort degradation.

The local backend's `encodeSegment` is an **injective** one-segment encoder:
it keeps `[A-Za-z0-9._-]` and escapes everything else as `~XXXX`, so `../`,
absolute paths, NUL and separators cannot traverse, and distinct inputs never
collide. Files are written `0600` under a `0700` root.

Ours: `harness/tools.ts:19` clips at 30,000 characters and `shellTool` stops
accumulating at 60,000. A `npm test` run with more than 30k characters of
output leaves the model with the first half and no idea what failed. This is
the same gap ZCode solves with its `resultBudget` "artifact" strategy — dsh's
version is better (head *and* tail, plus the full copy on disk).

**B5 — One inbox, two boundaries.**
dsh's `Agent` exposes `send` / `followup` / `steer` / `inject`:

- `followup` — an ordinary queued turn.
- `steer` — lands at the nearest step.
- `inject` — model-facing context for the next pre-step, **without waking
  the driver** (an idle agent stays idle).

The inbox is two ordered lists, `next-turn` and `next-step`, and every
mutation records a durable `agent/inbox/spliced` event.

The rule worth copying: **wake input submitted after a cancellation is
re-targeted to `next-turn`** — "waking input cannot join an aborted
activity". And `cancel` clears queued work unless `keepInbox`, with "the
first cause wins for that activity".

Ours: `harness/host.ts:328` throws "still working on the previous message".
The store already speaks a disposition (`queue` / `steer` / `replace`) and
the bridge already passes `ifBusy` for Muse — the harness branch just drops
it (`packages/muse-bridge/src/index.ts:772`). This is the cheapest feature in
the whole review: make the harness accept a queued message.

**B6 — Provider failure codes, not prose.**
dsh's `LlmError` carries a stable, provider-neutral `code`: `NO_ADAPTER`,
`MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `AUTH`, `RATE_LIMIT`, `QUOTA`,
`ACCOUNT_QUOTA`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `ABORTED`,
`CONTEXT_WINDOW_EXCEEDED`, `EMPTY_RESPONSE`, `MALFORMED_RESPONSE`,
`STREAM_CLOSED`, `UNSUPPORTED_CONTENT`, `IMAGE_OFFLOAD_REQUIRED`, …

Note `MISSING_CREDENTIAL` vs `INVALID_CREDENTIAL` — different user actions.
Note `CONTEXT_WINDOW_EXCEEDED` as its own code rather than something the
caller must parse out of prose.

Ours: `ProviderError` carries a message and an optional HTTP status. The
retry logic in `host.ts:552` decides "transient" from the status code
(`status == null || 408 || 409 || 429 || >= 500`) and the effort-retry from
a regex over the message (`/thinking|reasoning|effort|budget/i`). Both are
brittle in a way a code taxonomy would fix.

**B7 — Retry as a policy owned by the provider, executed by a plugin.**
dsh's `ResolvedRetryPolicy` is captured **at route registration** — the
provider owns it — and the *execution* lives in a separate plugin that
listens on the failed-step extension point. It persists the retry count in a
session projection so it survives a restart, writes the retry event
**before** the cancellable wait, honours `providerRetryAfterMs`, and uses
exponential backoff with symmetric jitter.

The separation matters: "the LLM service itself never retries — one stream =
one provider attempt." Ours mixes both in `callModel`.

**B8 — Skills, with catalog *replacement* rather than append.**
dsh's skill model is a `SKILL.md` with frontmatter, discovered from layered
roots (project `.dsh`, project `.agents`, user `.dsh`, user `.agents`,
bundled) with a **rank** per root, and the nearest layer wins a duplicate
name outright. Three tiers of progressive disclosure:

1. **Catalog** — name + description only, injected as a durable message.
2. **Model load** — the `skill` tool fetches the body; the tool result and
   the human invocation share one canonical `<skill_content>` rendering.
3. **Resources** — the model is told to load referenced resources on demand.

The one subtlety worth copying: the catalog is **re-published, not
appended**, and the message says "This complete catalog replaces every
earlier available-skills list in this session". Appending would leave stale
skill names in the model's head forever. Ours has no skills at all, and
MuseCode's `ExtensionsView` is Muse-CLI-backed — so the app's *default*
agent has no skills today.

**B9 — MCP with an all-or-nothing generation swap.**
dsh's MCP client names tools `mcp__<server>__<tool>`, and if normalization
changes the name it appends a 12-hex SHA-256 of `serverName\0rawName` so
distinct identities never collide. The sync is two-phase: **fetch** the whole
next generation (any failure leaves the previous generation registered
untouched), then **swap** — and a registry conflict rolls the whole
generation back, so "the model sees either the full generation or none of
it, never a partial set."

**B10 — Subagents with a durable depth floor and a non-widenable scope.**
dsh's `SubagentProvider` is one interface; the local/external split is by
*method presence* (`prepareContinuable` present → continuable local child;
`start` only → one-shot external). Three things are worth copying:

- **Delegation depth is a durable monotone floor.** `delegationDepthOf(agent)`
  = `max(session.header.delegationDepth, options.subagentDepth)`. The
  *persisted* header is the floor, so a resumed child cannot delegate as if
  it were top-level. Runtime options may deepen but never lower.
- **Delegated policy is stamped into the child's own log** as
  `sandbox/mode` / `approval/policy` / `permission/preset` events with
  `source:'delegation'`. The child's effective scope is then reconstructable
  from its log alone, and **a child can never widen its own scope**.
- **A parent-owned durable catalog** (`subagent/catalog`, appended to the
  *parent's* log) means children are discoverable without waking any of them,
  and completed children stay visible.

### C. Product surface

- **Plan mode as a logged collaboration state.** dsh's `exit_plan_mode` tool
  stays registered *while inactive*, so entering and leaving plan mode
  changes only the prompt section, not the request's tool catalog. And a
  mode change during an open turn is **queued** until the next accepted
  pre-step, and the delete happens only *after* a successful durable append,
  so a failed write stays retryable. Ours flips a flag on the session meta.
- **A plan review is a question, not a permission.** `AskUserQuestionIntent
  = {kind:'plan-review', approve: 'Approve'}` — the approving option is
  *named*, not positional, so no UI can infer the verdict from button order.
  A dismissed review ends the turn instead of burning a model request.
- **Derived workspace changes.** `packages/deliverables/workspace-changes`
  announces a `workspace/changes` event carrying **only the turn number**;
  the summary and diffs are served on demand from a per-session cache. The
  payload is never in the log and never model-authored.
- **A `present` tool** — "declare existing files as final deliverables",
  max 8 files, recommended 1–2.

## 4. What not to copy

- **Cordis itself.** The *shape* is portable (service definitions as `ctx`
  keys, scope layers, effect-scoped registration); the framework is not. We
  have a bridge process with one store — a DI container would be a large
  change for no product gain.
- **`packages/extensions/`** (22k lines). A runtime that defines and runs
  dynamic plugins with dual host/browser halves and a `node:vm` realm. Its
  own README disclaims being a security boundary ("treat a dynamic package
  like bash access"). A desktop harness wants skill files, not a runtime
  definer. The *read-only* half — "what APIs does this runtime expose?" — is
  the only interesting piece, and it is not a product we need.
- **The session-format migration chain** (`session-format-v0-to-v1` … v3→v4,
  6,615 lines). A new project starts at v0. Keep one format.
- **`ctx.sessionProjections`** (715 lines) with `stateVersion`, wire views and
  checkpointed state. Adopt the *idea* (UI state folded from the event log,
  so resume restores for free); not the framework.
- **PTC mode** — the `run_code` transport collapse, the reserved name, the
  per-protocol renderers. A whole product feature. For 7 tools, native calls
  only.
- **The cron dialect in `packages/schedule`** (3,921 lines). Correct, careful,
  and the wrong thing for a desktop app — the OS already has reminders. If we
  ever want in-app scheduling, take the delivery model (a reminder that
  arrives as a follow-up message in its original session, receipts that
  acknowledge *inbox delivery* rather than model execution) and skip the
  parser.
- **The `goal` domain's full machinery** (revisioned CAS, round cap, process-
  local arming). The "keep working until done" primitive is good, but it is a
  policy layer, not a harness primitive.

Two things dsh deliberately does **not** do, which are therefore gaps we
would have to build ourselves:

- **No command AST parsing.** There is no tree-sitter, no shell grammar, no
  read-only-vs-destructive classifier anywhere in `packages/shell` or
  `packages/sandbox`. The command string goes to `bash -c` verbatim, and
  classification is done by *sandbox policy* (filesystem effect) instead.
  If we want "allow `ls` but ask for `rm -rf`", we build it — ZCode's
  `guarded` mode and its danger catalogue are the reference.
- **No LSP diagnostics.** `packages/lsp` exposes exactly four navigation
  operations and explicitly has no `publishDiagnostics` consumer. If we want
  diagnostics-as-context, that is new work, not a port.

## 5. Suggested order

1. **A1** (monotonic guards), **A2** (freeze the arguments), **A4** (drop
   tool calls on `max-tokens`), **A3** (recovery vocabulary). All four are
   small, contained changes to `harness/host.ts` + `harness/tools.ts` +
   `harness/wire.ts`, and each closes a real hole.
2. **B5** (steering — the bridge already passes `ifBusy` and throws it away),
   **B3** (repeat-call detection, once B1 gives us `post-execute`),
   **B4** (spill), **B2** (parallel tools).
3. **B1** (canonical value / render / presentation split) — this is the
   enabling refactor for B2, B3, B4 and for any diff card.
4. **B8** (skills) — the app's default agent has none today, and dsh's model
   is small. **B9** (MCP) after it.
5. **B10** (subagents), **C** (plan mode as logged state, workspace changes).

## 6. dsh and ZCode side by side

> Superseded by [HARNESS_REVIEWS.md](HARNESS_REVIEWS.md), which compares all
> four harnesses. Kept here because the two-harness comparison is the
> shortest statement of the disagreement.

We reviewed two harnesses. They disagree about the load-bearing idea, and
that disagreement is the most useful thing to come out of the exercise.

| | ZCode | dsh | Ours |
|---|---|---|---|
| Shape | one large runtime, well-factored (573 core files, 107k lines) | no privileged core; the loop itself is a plugin (40 core files, 14.5k lines) | a bridge with one store (1.5k lines) |
| Extension model | plugins at the *product* level (marketplace) | plugins at the *core* level (capability seams) | none |
| Model history | two-tier: canonical + turn-local request view | **derived** from one append-only log | stored separately from the UI transcript |
| Tool result | prose with a byte budget | canonical JSON value + render + presentation meta | one `output: string` |
| Tool policy | `resolveInput` stage + a rule engine with `ruleId`s | pre-execute waterfall + **deny-only monotonic guards** | one `gate()` on tool kind |
| Parallel tools | metadata-derived grouping, topological | `isConcurrencySafe(args)`, fail-closed, commit in model order | sequential |
| Permission | rule engine, `ruleContent` scoping, `alwaysAsk` | closed approval outcomes, permission presets, sandbox mode | 4 modes, per-kind session grant |
| Prompt caching | 3-message stable/dynamic split with `cache_control` | **log structure** — append after the cached prefix | prompt rebuilt per call |
| Output-token limit | resume up to 3× | drop all tool calls | ends the turn, truncated |
| Session durability | `SessionEvent` log + projections | `SessionEvent` log + projections + `deriveMessages()` | JSONL of messages and items |
| Extensibility | skills, MCP, plugins, hooks, workflows, dynamic workflows | skills, MCP, plugins, workflows, runtime self-modification | Muse-CLI only |

**They agree on the event log.** ZCode's `SessionEvent` store and dsh's
`Session` log are the same idea, arrived at independently. dsh is stricter:
it *derives* the model history from the log rather than storing it, and it
enforces "model-visible ⟺ logged" as an invariant. ZCode keeps a canonical
history plus a turn-local view, which is more machinery but the same
underlying bet — the transcript is a projection, not the truth.

**Where each is stronger for us:**

- **ZCode** is stronger on *permissions* (a real rule engine, scoped session
  grants, `alwaysAsk`) and on *prompt caching* (an explicit stable/dynamic
  split with provider `cache_control`).
- **dsh** is stronger on *tool contracts* (canonical value vs. model prose vs.
  replayable UI state), on *tool safety* (deny-only guards, fail-closed
  parallelism, a real recovery vocabulary), and on *observability* (a compact
  assistant-stream format, a model-trajectory viewer, per-file 100% coverage
  gates).
- **dsh** is also **10× smaller in its core** than ZCode's runtime, which is
  what makes it the one we could read end to end and port ideas from.

**Combined ranking for our harness** (merging both reviews):

| Priority | Item | Source |
|---|---|---|
| 1 | Scoped session grants (never "allow all commands for the session") | ZCode `ruleContent` |
| 2 | Validate + normalize before asking permission | both (`resolveInput` / frozen args) |
| 3 | Drop tool calls on `max-tokens`; resume the reply | dsh A4 + ZCode A1 |
| 4 | Recovery vocabulary (`NOT_STARTED` vs `OUTCOME_UNKNOWN`) | dsh A3 |
| 5 | Stable/dynamic prompt split + append-after-cached-prefix | ZCode A3 + dsh `in-history` |
| 6 | Deny-only monotonic guards | dsh A1 |
| 7 | Repeat-identical-tool-call detector | dsh B3 |
| 8 | Spill oversized output (head + tail + full copy on disk) | dsh B4 / ZCode `resultBudget` |
| 9 | Parallel tools, fail-closed, commit in model order | dsh B2 / ZCode `canRunInParallel` |
| 10 | Steering / queueing for the harness | dsh B5 / ZCode `RuntimeCommandQueue` |
| 11 | Canonical tool value vs. model prose vs. UI metadata | dsh B1 |
| 12 | Skills (the app's default agent has none) | dsh B8 / ZCode |
| 13 | Provider failure codes instead of prose matching | dsh B6 |
| 14 | MCP with an all-or-nothing generation swap | dsh B9 |
| 15 | Subagents with a durable depth floor | dsh B10 / ZCode |

## 7. Sources

Read from the dsh checkout at `master`: `packages/core/{session,tools,agent,
agent-loop,system-prompt,scope}`, `packages/{llm,compaction,context,guard,
spill,sandbox,shell,interaction,feedback,jobs,session,subagent,skill,mcp,
preset,bundle,plan,goal,todo,schedule,deliverables,workflow,lsp,web,
terminal,extensions}`, plus `docs/architecture.md`, `docs/tool-execution-pipeline.md`,
`docs/capability-seams.md`, `docs/glossary.md`, `docs/subsystems/*.md` and
`docs/cookbook/adding-a-tool.md`. dsh is MIT-licensed; the mechanisms above
are reimplemented here, not copied.
