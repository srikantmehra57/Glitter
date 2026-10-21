# Pi review: what the built-in harness can adopt

Pi (`earendil-works/pi`, MIT) is a minimal, extensible agent harness —
"unified LLM API, agent loop, TUI, coding agent CLI". This document
reverse-engineers it and assesses what belongs in *our* harness
(`packages/glitter-bridge/src/harness`).

Read alongside [ZCODE_HARNESS_REVIEW.md](ZCODE_HARNESS_REVIEW.md),
[DEEPSEEK_HARNESS_REVIEW.md](DEEPSEEK_HARNESS_REVIEW.md) and
[MINIMAX_CODE_REVIEW.md](MINIMAX_CODE_REVIEW.md). All four are compared in
[HARNESS_REVIEWS.md](HARNESS_REVIEWS.md).

**The headline before anything else: MiniMax Code is built on Pi.**
`minimax-code` vendors `third_party/pi-mono` and `@mavis/agent-core` declares
`@earendil-works/pi-agent-core`, `pi-ai` and `pi-coding-agent` as
dependencies. A major vendor chose Pi as its engine. That is the strongest
possible signal about Pi's design, and it means
[MINIMAX_CODE_REVIEW.md](MINIMAX_CODE_REVIEW.md) is best read as a *case
study in scaling Pi* rather than an independent harness.

## 1. What Pi is

### Scale

| Package | files | lines | what it owns |
|---|---|---|---|
| `packages/agent` (`pi-agent-core`) | 6 | **2,519** | the agent loop |
| `packages/ai` (`pi-ai`) | 199 | 27,453 | unified LLM API |
| `packages/durable` (`pi-durable`) | 84 | 27,231 | durable conversations/tasks/documents |
| `packages/codemode` | 18 | 3,075 | code-that-calls-tools |
| `packages/mcp` | 18 | 3,277 | MCP |
| `packages/env` | 8 | 2,346 | remote execution (Rust daemon + SSH) |
| `packages/coding-agent` | 252 | 76,062 | the CLI, TUI, extensions, skills |
| `packages/tui` | 46 | 19,626 | TUI library |
| `packages/chord` | 40 | 14,799 | hot-reloadable plugin host |
| **all `packages/*` src** | | **179,406** | |

Ours: the harness is 1,469 lines.

**`pi-agent-core` is 2,519 lines — 1.7× our entire harness.** It is the only
harness of the four whose *core* is the same order of magnitude as ours. That
makes it the most directly portable thing we have found, and it explains why
MiniMax could build a 568k-line product on it.

### The core

`packages/agent/src/agent-loop.ts` is 949 lines; `types.ts` 539; `agent.ts`
613. That is the whole runtime. It has **no compaction, no persistence, no
providers** — it is a pure state machine over one function.

### The abstraction seam

```ts
// packages/agent/src/types.ts:33
export type StreamFn = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
```

The contract (`types.ts:27-32`): **the stream function must not throw**.
Failures are encoded *in the stream* as a terminal `AssistantMessage` with
`stopReason: "error" | "aborted"` and an `errorMessage`. The core never sees
an HTTP error, so the loop has exactly one failure path.

`setDefaultStreamFn()` lets a host install a provider implementation without
the core depending on a provider catalog. The core is provider-agnostic in
the same way ours is — and ours already got this right.

## 2. The turn model

Pi's vocabulary is deliberately small:

- **Agent** — one run of the loop over a context.
- **Turn** — one model request plus the tools it calls.
- **Tool call** — one tool.

`runLoop` (`agent-loop.ts:163-321`) is a two-level loop:

```
outer: follow-up queue
  inner: tool calls / steering
    prepareRequest -> streamAssistantResponse
      stopReason error|aborted  -> HARD EXIT
    toolCalls?  -> executeToolCalls (or failToolCallsFromTruncatedMessage)
    finishTurn -> {action: "continue" | "end"}
    getSteeringMessages
  getFollowUpMessages -> continue the outer loop
```

### Extension points

All on `AgentLoopConfig` (`types.ts:193-342`):

| Hook | Purpose |
|---|---|
| `convertToLlm(messages)` | required bridge to the LLM vocabulary |
| `transformContext(messages, signal)` | compaction / pruning / injection |
| `getApiKey(provider)` | fresh token per request |
| `prepareRequest(ctx, signal)` | before **every** request |
| `prepareNextTurn(ctx)` | after `turn_end` — where compaction lives |
| `finishTurn(turn, signal)` | `{action:"continue"\|"end"}` |
| `getSteeringMessages()` / `getFollowUpMessages()` | mid-run injection / post-run queue |
| `beforeToolCall(ctx, signal)` | **the approval gate** — `{block?, reason?, terminate?}` |
| `afterToolCall(ctx, signal)` | redaction / annotation of the result |
| `toolExecution: "sequential" \| "parallel"` | default `"parallel"` |

The core **never retries**. Provider-level retry lives in `pi-ai`.

## 3. What to adopt

### A. Correctness and safety

**A1 — A truncated reply must not execute its tool calls.**
`failToolCallsFromTruncatedMessage` (`agent-loop.ts:478-506`). When
`stopReason === "length"`, *every* tool call in the message fails with:

> `Tool call "<name>" was not executed: the response hit the output token
> limit, so its arguments may be truncated. Re-issue the tool call with
> complete arguments.`

The reasoning is in the comment: streamed JSON can produce
*valid-but-incomplete* arguments. A half-streamed `{"path": "src/ind` is
syntactically broken; a half-streamed `{"command": "npm test --filter="` is
**syntactically valid and semantically wrong**. Executing that second one is
the dangerous case, and only the length stop reason reveals it.

Ours: `harness/wire.ts` yields `stopReason` and `harness/host.ts:504-537`
ignores it, so a truncated `bash` call can execute a half-written command.

This is the **single most important item in this review**, and note that ZCode
and dsh both reach a weaker version of the same conclusion (ZCode resumes the
reply up to three times; dsh silently drops the calls). Pi does both halves:
it refuses to execute *and* tells the model to re-issue. Our fix should be
the same: refuse, and give the model the recovery instruction.

**A2 — The approval gate must be able to rewrite the input, and the rewrite
must be re-validated.**
Pi's `beforeToolCall` returns `{block?, reason?}` and the *host* may rewrite
the arguments. MiniMax's equivalent (`@mavis/agent-core`) re-validates the
rewritten input against the authoritative schema
(`isRuntimeToolInputValid` = `Value.Check` on the typebox schema) before
executing.

Ours: `harness/host.ts:570` shows `JSON.stringify(call.input)` on the
approval card and `harness/tools.ts:runTool` parses it inside the handler
*after* the user approved. Both the ZCode review (`resolveInput`) and the dsh
review (frozen arguments) found the same hole. Pi adds the missing piece: a
rewrite is possible, and it is re-validated.

**A3 — `afterToolCall` may not leave the result internally inconsistent.**
Pi's `finalizeExecutedToolCall` applies `afterToolCall` overrides
field-by-field, and then: **if `content` was replaced but `structuredContent`
was not, the structured content is dropped** — because it may no longer
describe the content.

Ours: `harness/host.ts` has a single `visibleOutput` string and an optional
`failureReason`. There is no structured channel, so there is nothing to
invalidate. But the moment we add one (see B1), this rule is the thing that
keeps the transcript honest.

**A4 — Tool errors are results, never exceptions.**
`prepareToolCall` and `executePreparedToolCall` catch everything: unknown
tool, validation failure, a blocked call, a thrown body — all become
`isError: true` results. A thrown exception never escapes the tool layer.

Ours: `harness/tools.ts:255-269` already does this — `runTool` catches and
returns `{output, isError}`. We got this right.

### B. Capability and quality

**B1 — Three channels out of every tool.**
Pi's `AgentToolResult` (`types.ts:424`):

```ts
{
  content: (TextContent | ImageContent)[];   // → the model
  structuredContent?: unknown;                // → programmatic callers, NOT sent to the model
  details?: TDetails;                         // → the UI
  usage?; isError?; terminate?
}
```

dsh has the same split independently (`output.schema` + `output.render` +
`output.presentationMeta`), and so does MiniMax (`output` / `structuredOutput`
/ `details`). **Three of the four harnesses we reviewed arrived at the same
three-way split.** That is the strongest consensus signal in this whole
exercise, and it is worth taking even though we only have one channel.

Ours: `harness/tools.ts` returns `{output: string, isError?, exitCode?,
path?, command?, plan?}`. One string carries both the model's view and the
UI's view. Splitting it means: the model gets prose, the app gets typed data
(a diff, a file listing, a command), and the two can evolve independently.

**B2 — The loadout-delta protocol: tools are declared in the transcript, not
in the request.**
Pi's `declareToolChanges` (`agent-loop.ts:333-367`). The system message
carries `toolsAdded` / `toolsRemoved`; the *effective* tool set is
`getCurrentTools(messages)`, which folds the deltas over the history. Each
request computes the delta between what the history says and what the agent
can actually execute, and inserts a system message with the change.

Why this matters: **the history records what was available when.** Replay
reconstructs the tool set exactly, and a tool that appears mid-session is
announced rather than silently present. It is also the cheapest possible
prompt-cache strategy — the tool declaration lives in a system message, so
adding a tool does not rewrite the whole request.

Ours: `harness/host.ts:506` passes `TOOL_SCHEMAS` on every request, so the
tool list is re-sent in full each time, and there is no notion of a tool
appearing or disappearing mid-thread.

**B3 — Truncated output, answered with a *continuation* rather than a
pointer.**
We found three answers to "the output was too big" in the four harnesses:

- dsh: spill the full copy to disk, keep head+tail, replace with a notice.
- ZCode: `resultBudget` with an `artifact` strategy.
- MiniMax: `next_offset` — see the MiniMax review; it is the best of the
  three, because it tells the model exactly which arguments to re-issue.

Ours: `harness/tools.ts:19` clips at 30,000 characters. The model sees the
first 30k and no way to get the rest. A continuation contract
(`next_offset` + a `continuation_hint`) is a much better answer than a
truncation marker.

**B4 — Prompt-cache breakpoints in three places, not one.**
Pi's Anthropic adapter (`packages/ai/src/api/anthropic-messages.ts`) places
`cache_control` on: the system prompt blocks, the **last tool definition**,
and the **last user/assistant/tool-result text content**. The middle one is
the trick we do not have: caching the tool schemas separately from the
conversation means a long conversation does not re-bill the tool list, and a
tool change does not re-bill the conversation.

Pi also has `CacheRetention = "none" | "short" | "long"` with
`Model.promptCache: {short?: number, long?: number}` (cache lifetime in
seconds) — a notion of *cache TTL* that neither ZCode nor dsh has, and that
we certainly don't.

Ours: no cache control at all, and the system prompt is rebuilt on every
call (see the ZCode review, A3).

**B5 — Cache-aware context accounting.**
Pi's `Usage` (`types.ts:451`): `input`, `output`, `cacheRead`, `cacheWrite`,
`cacheWrite1h?`, `reasoning?`, `totalTokens`, plus a `cost` breakdown. The
cache counters are **disjoint from `input`**, and the total is computed by
adding them back. dsh has the same split; we have `promptTokens` only.

This matters for a specific reason: our context chip computes
`usedTokens = promptTokens` against a window. If a provider reports cached
reads separately, our number is wrong — and wrong in the direction that makes
the chip look full when it is not.

**B6 — `transformContext` and `prepareNextTurn`: two places to put
compaction.**
Pi's core has no compaction, but it has exactly the two seams compaction
needs: `transformContext` (prune/inject before *every* request) and
`prepareNextTurn` (after a turn ends, before the next). Ours has neither —
we truncate old tool output in `history()` and call it done.

**B7 — A runnable program instead of a chain of tool calls.**
`packages/codemode` (3,075 lines, one dependency: `quickjs-wasi`). The model
writes JavaScript; the script runs in a **QuickJS VM compiled to WASM** whose
only capability is calling injected tools.

- Nested tool calls **never enter the LLM context** — only the script's
  output and return value do. A script that greps 40 files and prints three
  lines costs one model round-trip, not forty.
- The VM has no timers, no `fetch`, no `process`, no `require`, no modules,
  no `WebAssembly`. `eval`/`Function` work but only produce more code in the
  same VM.
- `CodemodeResult` is `{ok, value, output, calls, storeWrites}` — the calls
  are recorded with status and duration, so the audit trail survives.
- `execute()` **never rejects** for script failures; the error is a value.

Two details worth stealing even without the VM:

- **The approval gate is inherited by nested calls.** The integration
  guidance is to wrap `execute()` as an `AgentTool` named `codemode` and run
  each nested call through `runToolCall()` — which `pi-agent-core` *exports*
  for exactly this purpose. So a nested tool call goes through the same
  `prepare → validate → beforeToolCall → execute → afterToolCall` pipeline
  as a top-level one, and the user is asked to approve it the same way.
- **Deterministic replay.** The host owns the clock, the RNG (`seed`) and
  every tool result; results must be numbered 1, 2, … without gaps, and the
  VM applies them in order. Same script + seed + tools ⇒ identical calls.
  That is a resumable, replayable tool-execution log.

### C. Product surface

- **Skills**: `SKILL.md` with frontmatter, progressive disclosure (only
  *name, description, path* in the system prompt at startup), `/skill:name`
  forces one, malformed files and skills without a description are not
  loaded, name collisions keep the first. Same model as ZCode, dsh and
  MiniMax — the spec has converged, and ours has none.
- **Prompt caching of the *system* prompt via a replay model**: Pi's
  `SystemMessage` carries `sections?: Record<string, string | null>` — named
  ordered prompt sections, where `null` *removes* a section. Replaying every
  system message in order yields the current prompt. That is a clean way to
  let a plugin add or retract a prompt section without rewriting the prompt.
- **Extension handler composition patterns** (`docs/extensions.md`): the doc
  names six patterns — Notification, In-place mutation, Chained
  transformation, **Gate**, Actionable boundary, Last override — and says
  plainly: *"gate handlers should fail closed when their safety decision
  cannot be made."* Ours has no extension points at all.
- **An explicit no-permissions stance.** Pi ships **no** permission system
  and says so: "Pi does not include a built-in permission system for
  restricting filesystem, process, network, or credential access. By default,
  it runs with the permissions of the user and process that launched it." It
  documents three containerization patterns instead.

That is a defensible choice for a CLI, and it is the **wrong** choice for a
desktop app. We already have a native trust boundary; we should keep it and
not follow Pi here.

## 4. What not to copy

- **`pi-durable` (27,231 lines).** The durability model is excellent —
  "only committed state is observable", eight invariants, external effects
  outside the mutation transaction, `replay: "safe"` deciding whether a
  tool reruns after a crash — and it is a whole subsystem. Our sessions are
  JSONL files that a user can delete; we do not need a transactional store.
  The *ideas* worth taking are listed below.
- **The RPC framing detail** is worth taking verbatim even without RPC:
  "strict JSONL framing (one object per line, LF-terminated; strip optional
  CR; **do not** split on U+2028/U+2029 — Node's `readline` does and breaks
  JSON strings." Our bridge speaks NDJSON over stdio. Let me check whether
  our framing has this bug — see §5.
- **`pi-env`** (a Rust daemon over SSH for remote tool execution) is a
  product feature we do not need. But its `docs/semantics.md` is a great
  pattern: it defines the behavioural contract that a remote implementation
  must match the local one *exactly* — "only error messages may differ". If
  we ever add a remote workspace, that is the spec to write first.
- **`pi-coding-agent` (76k lines) and `pi-tui` (19.6k)** are the CLI and
  terminal UI. Not relevant to a desktop app.
- **Textual error classification.** Pi has *no* numeric error codes; it
  classifies retries and context overflow with ~25 regexes over provider
  error text. dsh's `LlmError` code taxonomy is strictly better. Do not
  copy the regex approach.
- **The whole-batch-sequential rule.** Pi's scheduler: if *any* tool in the
  batch is `executionMode: "sequential"`, the **entire batch** runs
  sequentially. That is safe but coarse — one `write` in a batch of five
  greps serializes all five. dsh's per-call fail-closed predicate is
  better. Adopt dsh's rule, not Pi's.

### Two ideas from `pi-durable` worth taking on their own

- **`replay: "never" | "safe"` on every tool.** If the process dies
  mid-tool-call, the tool reruns on reopen *only* when it declares itself
  replay-safe; otherwise the model gets an `interrupted` error result with
  the output committed so far. That is dsh's `TOOL_OUTCOME_UNKNOWN`, stated
  as a per-tool declaration rather than inferred at recovery time — and it
  is a better place to put it, because the tool knows.
- **A crash-loop guard.** `settings.restartLimit` (default 5) → the task is
  *parked* with a reason instead of restarting forever. A desktop app that
  resumes a thread on launch needs this, or a thread that crashes on open
  will crash on open forever.

## 5. Two things checked in our code

Two claims from this review were checked against our own source rather than
assumed:

1. **Our bridge's NDJSON framing is already safe.** Pi warns that
   "strict JSONL framing (one object per line, LF-terminated; strip optional
   CR; **do not** split on U+2028/U+2029 — Node's `readline` does and breaks
   JSON strings)". Ours
   (`packages/glitter-bridge/src/framing.ts:12-47`) splits on **raw byte 10**
   and decodes UTF-8 per frame — it never goes through `readline` and never
   treats U+2028/U+2029 as a delimiter, so a line separator inside a JSON
   string stays inside the frame. No change needed. Worth recording because
   this is the kind of bug that only shows up with non-ASCII content.

2. **Our `repairHistory` in `harness/wire.ts:57-81` fills a missing tool
   result with one generic string** — "The user stopped this turn before the
   tool ran." Pi, dsh and ZCode all distinguish "not started" from "outcome
   unknown". We do not. See the dsh review, A3, for the replacement wording.

## 6. Suggested order

1. **A1** (truncated tool calls must not execute) — the highest-value fix in
   this review, ~20 lines in `harness/host.ts`.
2. **A2** (normalize + re-validate before the approval card), **B5** (split
   the cache counters), **B4** (cache breakpoints on the last tool
   definition).
3. **B1** (three-way tool result), **B3** (continuation contract for
   truncated output), **B2** (loadout deltas in the transcript).
4. **B7** (codemode) — high ceiling, genuinely novel, and it needs B1 and
   the exported-`runToolCall` pattern to keep the approval gate intact.
5. Skills, MCP, subagents — as in the other reviews.

## 7. Sources

Read from the Pi checkout at `main` (v1.3.0): `packages/agent/src/*`,
`packages/ai/src/{types,models,models.generated,utils/*,api/*,providers/*}`,
`packages/codemode/src/*`, `packages/durable/src/{harness,storage,tasks}/*`,
`packages/env/src/*`, and `packages/coding-agent/docs/*` (extensions,
skills, packages, rpc, sdk, cli, usage, compaction, containerization,
session-format, message-types, codemode). Pi is MIT-licensed; the mechanisms
above are reimplemented here, not copied.
