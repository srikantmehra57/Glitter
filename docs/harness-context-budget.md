# Harness context budget: fit before the call

**Status:** historical design note; the implementation below is now in the
working tree and remains a baseline to verify. Its proposed integration-plan
phase is superseded by Phase 2 of
[HARNESS_UPGRADE_PLAN.md](HARNESS_UPGRADE_PLAN.md). See
[DECISIONS.md](DECISIONS.md) ("A tool result is three channels…", "The app has
its own agent harness", "The request is fitted to the model's window before it
is sent") for the recorded choices. The scope and statements below record the
original design, not an active plan or an up-to-date description of every
remaining limitation.

## Original problem

The harness has no context management. `history()` clips old tool output to
4,000 chars and keeps the last 8 messages in full (`host.ts`); a thread that
grows past the model's window fails with `CONTEXT_WINDOW_EXCEEDED`, which
`classifyProviderFailure` deliberately marks non-retryable — the turn dies and
the user loses the turn's work. The four reviewed harnesses all manage this:

| Mechanism | ZCode | dsh | MiniMax (on Pi) |
|---|---|---|---|
| Fit before the call | `context/builder.ts` budget split | `packages/context` | — |
| Compaction | LLM + local micro-compaction | LLM compaction | LLM compaction |
| Oversized output | spill to disk + head/tail | `packages/spill` (head+tail+notice) | — |

Our reviews flagged the gap: "char-truncation of old tool output"
(ZCODE_HARNESS_REVIEW §2) and "clip at 30k chars — the rest is gone"
(MINIMAX_CODE_REVIEW). Oversized *single* results are already handled —
`tools.ts` spills them to `.muse/tool-output` with a receipt. What is missing is
fitting the *accumulated* history into the window.

## Scope of this change (deliberately small)

1. **Fit before the call.** Estimate the request's tokens, compare against the
   model's window, and trim old tool output until it fits. No compaction turn,
   no summarization, no extra model call in this phase.
2. **A trimming ladder instead of one hard clip.** The current binary
   full/4k-char clip becomes: full → head+tail → skeleton (tool name, first
   line, byte size). Each rung says what it is, so the model knows the tail is
   not the whole output.
3. **Reactive recovery.** A `CONTEXT_WINDOW_EXCEEDED` (or a 400 whose prose
   matches) trims once more and retries, inside the existing retry budget,
   instead of failing the turn.

Out of scope (later phases, per the plan's "Explicitly not doing" discipline):
LLM compaction, micro-compaction of the stable prefix, spilling history itself.

## Invariants kept

- **The transcript is the truth.** Trimming is a *request view*, exactly what
  `history()` already is. The persisted JSONL keeps full output; only the
  provider sees the trimmed copy. Resume from disk is unaffected, and the
  "model-visible ⟺ logged" reading stays true — the model sees a labelled
  notice, never a silent loss.
- **One implementation per concern.** Spill stays in `tools.ts` (this change
  adds no new spill path); the estimator, the budget split and the ladder live
  in `harness/context.ts` as pure functions; `host.ts` gains one call before
  `streamChat` and one branch in the retry loop.
- **No new permission surface, no renderer change, no bridge verb.**

## Estimator

One estimator for both wires. The providers' tokenizers disagree with each
other and with us; what matters is being consistently *conservative* (slightly
over), because the estimate only gates trimming — providers remain the source
of truth via the `usage` event, and the context chip keeps using reported
tokens.

- 1 token ≈ 4 characters, counted over exactly what the wire sends: system
  prompt (stable + volatile), message text/thinking parts, tool-call argument
  JSON, tool outputs, and the per-request tool schemas.
- Images are counted at a flat 1,100 tokens each (what the providers charge for
  a 1568px image).

## Budget split

`window` = the model's context limit (catalog `contextLimit`, else
`contextWindow()`'s family table, else unknown). Unknown → no fitting, current
behaviour preserved exactly.

- output reserve = `min(32_000, 10% of window)` — matches `wire.ts`'s
  `MAX_TOKENS`, and shrinks on small windows so input + output can never
  exceed the window;
- input budget = window − reserve;
- system + tools + recent messages are measured; old tool results are trimmed
  in age order (oldest first) until the request fits.

## The trimming ladder (per tool result, oldest first)

1. Full output.
2. Head 3,000 + tail 1,000 chars, joined by a `… (N chars elided …)` marker —
   the head keeps what was asked, the tail keeps errors and summaries.
3. Skeleton: tool name, first line, byte size.

The rung is chosen by *budget pressure*, not by output size, so a huge result
in a roomy window stays intact — the difference from today's clip-at-4k-regardless.

## Reactive recovery

`callModel`'s retry loop already branches on error shape (the effort retry).
Add: a `CONTEXT_WINDOW_EXCEEDED` code, or a 400 whose prose matches the window
regex, forces the ladder to its lowest rung for the oldest results and retries
once — inside the same attempt count and elapsed cap as ordinary retries, so a
genuinely hopeless thread still fails after the budget is spent. This is ZCode's
`model_context_window_exceeded` lesson inverted: for *input* overflow,
retrying with a smaller request is the recovery, not a pointless compaction.

## Tests (tests/harness.test.mjs)

- the estimator counts system + history + tool schemas conservatively;
- a window smaller than the history trims the oldest tool output first, the
  newest stays intact, and the transcript on disk keeps the full text;
- the ladder reaches the skeleton rung under enough pressure;
- a provider 400 "prompt is too long" trims and retries once, then fails if
  still over;
- an unknown window (no catalog entry, unknown family) changes nothing.

## What this does not fix (recorded, not silently ignored)

- LLM compaction of old *turns* (not just tool output) — needs summarizer
  plumbing; a later phase.
- Estimator drift from real tokenizers — acceptable: it only gates trimming,
  and providers report real usage every call.
- History itself spilling to disk — the receipts from `tools.ts` already bound
  any single result, and the ladder bounds the rest.
