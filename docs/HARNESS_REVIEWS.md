# Harness reviews: four agent harnesses, and what our harness should take

We reviewed four open-source agent harnesses against our own built-in harness
(`packages/glitter-bridge/src/harness`, 1,469 lines). This is the index and the
combined ranking.

The ranked items are **sequenced into phases in
[HARNESS_INTEGRATION_PLAN.md](HARNESS_INTEGRATION_PLAN.md)**.

| Review | Harness | License | Agent core | Core size vs. ours |
|---|---|---|---|---|
| [ZCODE_HARNESS_REVIEW.md](ZCODE_HARNESS_REVIEW.md) | ZCode (`zai-org/ZCode`) | Apache-2.0 | `core/src/runtime` + `core/src/tool` | 79,000 lines — **54×** |
| [DEEPSEEK_HARNESS_REVIEW.md](DEEPSEEK_HARNESS_REVIEW.md) | DeepSeek Harness (`deepseek-ai/deepseek-harness`) | MIT | `packages/core` | 14,571 lines — **10×** |
| [PI_HARNESS_REVIEW.md](PI_HARNESS_REVIEW.md) | Pi (`earendil-works/pi`) | MIT | `packages/agent` | 2,519 lines — **1.7×** |
| [MINIMAX_CODE_REVIEW.md](MINIMAX_CODE_REVIEW.md) | MiniMax Code (`MiniMax-AI/minimax-code`) | MIT (first-party) | `packages/agent-core` (on Pi) | 10,805 lines — **7×** |

**The scale spread is the first finding.** ZCode's runtime is 54× ours and
cannot be ported; it can only be mined for mechanisms. Pi's core is 1.7× ours
and can be read end to end, which makes it the most directly portable thing
we found — and MiniMax Code, a 568k-line product, is built on it.

## The relationship between them

They are not four independent designs. **MiniMax Code vendors Pi and builds
its agent core on `@earendil-works/pi-agent-core`.** DeepSeek's
`llm-pi-ai` package is Pi's LLM layer. So the four reduce to three
generations:

```
ZCode (2026)                DeepSeek dsh (2026)        Pi (2026)
big runtime                 plugin core                2.5k-line core
108k core lines             14.5k core lines           no compaction
                                                    └──┬──┘
                                            MiniMax Code (2026)
                                            568k product, 10.8k core
```

That lineage matters for the review: Pi is the youngest and smallest core,
it is winning adoption, and MiniMax Code is the proof that it scales.

## Where they agree

Three findings were arrived at independently by three or more of the four.
That is the strongest evidence in this exercise — when four teams with
different priorities build the same thing, it is usually right.

### 1. The tool result has three channels, not one

| Harness | Model-facing | Programmatic | UI |
|---|---|---|---|
| dsh | `output.render(args, value)` | `output.schema` (canonical JSON) | `output.presentationMeta` + `presentCall`/`presentResult` |
| Pi | `content` | `structuredContent` | `details` |
| MiniMax | `output` | `structuredOutput` | `details` |
| ZCode | the rendered text | — | `formatModelContent` / `formatPersistedModelContent` |
| **Ours** | **`output: string`** | **—** | **the same string** |

Three of four split it. We have one string carrying both the model's view and
the app's view, which is why our tool cards cannot show a diff and our
`isError` is a boolean bolted onto prose.

### 2. A truncated reply must not execute its tool calls

| Harness | Behaviour |
|---|---|
| **Pi** | every call fails with *"the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments."* |
| dsh | all tool calls are dropped when the finish reason is `max-tokens` |
| ZCode | resumes the reply up to three times, and treats `model_context_window_exceeded` as a continuation, not an overflow |
| **Ours** | **the stop reason is ignored entirely** |

The reasoning is in Pi's source: streamed JSON can produce
*valid-but-incomplete* arguments. A half-streamed `{"path": "src/ind` is
broken; a half-streamed `{"command": "npm test --filter="` is **valid and
semantically wrong**. Only the length stop reason reveals it.

### 3. The model history and the UI transcript are different things

ZCode keeps a canonical history plus a turn-local request view. dsh
*derives* the model history from an append-only log and treats "model-visible
⟺ logged" as an invariant. Pi declares the tool set in the transcript and
folds deltas. MiniMax projects a provider view without rewriting the
canonical history.

Ours stores `message` records and `item` records in the same JSONL and lets
`history()` mutate the provider view in place. The separation is worth
having.

### 4. A permission grant is scoped to a *subject*, not a tool name

ZCode's `ruleContent` (the actual command, URL or path). MiniMax's
`PermissionRuleMatcher` (tool | command pattern | path pattern with
actions). dsh's `ApprovalOutcome` closed set with `unavailable` fail-closed.

Ours: `live.allowed` is a `Set<ToolKind>`, so "allow commands for session"
allows `rm -rf` for the rest of the thread.

## Where they disagree

| Question | ZCode | dsh | Pi | MiniMax |
|---|---|---|---|---|
| Where the model history lives | canonical + turn-local | derived from a log | in the transcript | canonical + projected view |
| How a tool is parallelised | metadata groups | per-call fail-closed predicate | whole batch if *any* tool is sequential | per-tool `executionMode` |
| Permissions | a rule engine with `ruleId`s | a waterfall + deny-only guards | **none** (containerize instead) | a full classifier (Codex port) |
| Prompt caching | stable/dynamic split + `cache_control` | log structure (`in-history` append) | `cache_control` on system + last tool + last message | assembly fingerprint |
| Failure classification | error codes | **error codes** (20) | **regexes over error text** | numeric protocol codes |
| Truncated output | artifact | spill to disk + head/tail | — | **`next_offset` + re-issue hint** |
| Subagents | yes | yes | **deliberately absent** | yes |

Two disagreements are worth taking a side on:

- **dsh's per-call fail-closed parallelism beats Pi's whole-batch rule.**
  Pi serializes five greps because one of them is a write. That is safe but
  coarse, and coarse is expensive.
- **dsh's string error codes beat Pi's regexes.** Pi has no numeric error
  taxonomy; it matches ~25 regexes over provider prose to decide whether to
  retry and whether the context overflowed. MiniMax's numeric codes are
  wire-level; dsh's string codes are the right shape for a protocol that
  crosses a trust boundary.

## The combined ranking for our harness

Ordered by value per line changed. "Size" is the rough cost in our own code.

| # | Item | From | Size | Why |
|---|---|---|---|---|
| 1 | A truncated reply must not execute its tool calls | Pi | ~20 lines | A valid-but-incomplete `bash` command can execute. The stop reason is already in our stream event. |
| 2 | Scope the "for this session" grant to the command or path | MiniMax, ZCode | ~150 lines | "Allow commands for session" currently allows `rm -rf` for the rest of the thread. |
| 3 | The Codex read-only command classifier | MiniMax | ~400 lines ported | Already written and battle-tested. It is what makes #2 enforceable. |
| 4 | Normalize and re-validate before asking permission | ZCode, dsh, Pi, MiniMax | ~80 lines | We approve the raw model input and parse it after. An ambiguous `edit_file` asks permission and *then* fails. |
| 5 | Three channels out of every tool | dsh, Pi, MiniMax | ~200 lines | Enables diff cards, structured results, and independent evolution. Three of four harnesses agree. |
| 6 | Recovery vocabulary: "not started" vs "outcome unknown" | dsh, ZCode | ~30 lines | Our one generic filler tells the model nothing it can act on. |
| 7 | The `next_offset` continuation contract for truncated output | MiniMax | ~100 lines | Turns a 30k dead end into pagination the model can drive. |
| 8 | Split the cache counters; add a cache breakpoint on the last tool definition | dsh, Pi | ~60 lines | Our context chip reads full when it is not. The tool-list breakpoint is a trick we do not have. |
| 9 | A stable/dynamic system prompt, computed once per turn | ZCode, dsh | ~120 lines | We re-read `AGENTS.md` from disk on every model call and break the provider's prompt cache each time. |
| 10 | Steering and queueing for the harness | Pi, dsh, ZCode | ~100 lines | The store already sends `ifBusy`; the harness branch drops it and throws. |
| 11 | Deny-only monotonic guards, separate from ask-policy | dsh | ~40 lines | A place for invariants no listener order can talk you out of. |
| 12 | Repeat-identical-tool-call detection | dsh | ~120 lines | The most common agent failure, and we have nothing. |
| 13 | Parallel tool execution, fail-closed, commit in model order | dsh | ~80 lines | Three greps currently run one after another. |
| 14 | Provider failure codes instead of prose matching | dsh, MiniMax | ~80 lines | Our retry decision is `status >= 500` plus a regex over the message. |
| 15 | A total elapsed cap on retries, and a first-event watchdog | MiniMax | ~60 lines | Three minutes per attempt × three attempts, with no total bound. |
| 16 | Skills | all four | ~200 lines | The app's *default* agent has none; `ExtensionsView` is Muse-CLI-backed. |
| 17 | MCP with an all-or-nothing generation swap | dsh, ZCode | ~400 lines | The model must see the whole generation or none of it. |
| 18 | Subagents with a durable depth floor | dsh, ZCode | ~600 lines | Recursion bugs are the number-one way a coding agent dies. |
| 19 | A contribution registry so tools and policy are not hardcoded | MiniMax | ~400 lines | The enabling refactor for everything above to keep growing. |
| 20 | `ask_user` as a turn-ending durable request | MiniMax, dsh | ~150 lines | The harness currently cannot ask the user anything mid-turn. |

### The first five, in one sentence each

1. **Pi** — a reply that hit the output limit must not run its tool calls,
   and the model must be told to re-issue them.
2. **MiniMax** — "allow commands for this session" must mean *this command*,
   not every command.
3. **MiniMax** — port Codex's read-only command list; it is what makes #2
   enforceable rather than a guess.
4. **All four** — parse and freeze the arguments before the approval card, so
   the approved bytes are the executed bytes.
5. **dsh, Pi, MiniMax** — a tool result is three things, not one.

## What we should not build

A note on scope, because four reviews invite a scope explosion.

- **Do not port a runtime.** ZCode's 79k-line runtime, dsh's Cordis DI
  runtime and pi-durable's 27k-line transactional store are each a product.
  We have a bridge process with one store.
- **Do not adopt a plugin framework yet.** MiniMax's 1,417-line extension
  SPI is the smallest of the three, and it is still a refactor of the
  harness's shape rather than a feature. It belongs after items 1–8.
- **Do not add a permission framework before the classifier.** Items 2 and 3
  together are a scoped grant; a rule engine without a command classifier
  is a rule engine with no good rules.
- **Do not skip the cheap ones.** Items 1, 4, 6, 8 and 10 are each under
  100 lines and each close a hole we can demonstrate today.
