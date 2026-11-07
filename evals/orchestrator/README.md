# Orchestrator evaluation

An opt-in, cost-capped corpus and runner for the Orchestrator. It is **not**
part of `npm run verify` and never calls a provider unless you pass `--yes`.

Free checks:

```sh
npm run eval:orchestrator -- --validate   # corpus/config shape
npm run eval:orchestrator -- --list       # tasks and configured configs
npm run eval:orchestrator -- --list --split=holdout  # only the holdout tasks
npm run eval:orchestrator -- --dry        # set up each fixture and run its checks untouched
npm run eval:orchestrator -- --check-host # bundle the harness host, no provider calls
npm run eval:orchestrator -- --pre-route  # policy-only routing matrix, no provider calls
npm run eval:orchestrator -- --compare=path/a/report.json,path/b/report.json
```

`--dry` is expected to show failing checks for tasks that need work; a task
that already passes is flagged so its checks can be tightened.

## Pre-route matrix

`pre-route.mjs` holds labeled prompt envelopes for every current pre-route
rule: exact small changes, high-risk prompts, forced shapes, continuations and
their negative lookalikes. `--pre-route` bundles only the policy, prints the
rule/case table, the share of prompts decided without the Router, any floor
raises, and exits non-zero if the policy no longer matches an expectation.

Candidate cases for the 3.5 rules (a failing test or stack trace, a review
reply, "same as before", an attachment-only request, an open-plan
continuation) are reported with where they route today, but never asserted.
A candidate case claimed by another rule is a rule interaction to review
before that rule is enabled; no default changes without the live corpus.

## Tuning and holdout

Tasks are split into `tune` and `holdout` (8 and 8 in the corpus). Rules and
defaults are chosen only from tuning tasks; the holdout is still run and
reported, so success is measured on tasks the rules did not see. Use
`--split=tune|holdout` to filter runs, dry-runs and the list; `--tasks` narrows
either split. Run `--list --split=holdout` to see the protected set.

## Live run

The runner needs model ids and provider keys in the environment. Example with a
hosted Lead and Builder:

```sh
EVAL_LEAD_MODEL=anthropic/claude-sonnet-5 \
EVAL_BUILDER_MODEL=deepseek/deepseek-chat \
EVAL_SMALL_MODEL=deepseek/deepseek-chat \
ANTHROPIC_API_KEY=... DEEPSEEK_API_KEY=... \
node evals/orchestrator/run.mjs \
  --configs=orchestrator-balanced,lead-alone \
  --tasks=known-bug,feature \
  --runs=2 --max-usd=5 --yes
```

A second pairing uses the same commands with a local Builder, for example
`EVAL_BUILDER_MODEL=ollama/qwen3-coder` (Ollama needs no key).

Configs built from the environment:

- `orchestrator-cost`, `orchestrator-balanced`, `orchestrator-output` — the
  three goals, using the Lead, Builder, Small-task and Router assignments.
- `lead-alone`, `builder-alone` — manual sessions with that model, at its
  highest published reasoning effort.
- `small-alone` — only when `EVAL_SMALL_MODEL` is set.

Model ids are `provider/model`. Baselines use the same model ids as the
orchestrator roles so the comparison measures the pipeline, not an effort
difference.

## Baseline suite

Once the keys and models above are set, run the tuning split first — rules are
chosen only from tuning tasks — then the holdout:

```sh
node evals/orchestrator/run.mjs \
  --configs=orchestrator-cost,orchestrator-balanced,orchestrator-output,lead-alone,builder-alone,small-alone \
  --split=tune --runs=2 --out=reports/tune --yes

node evals/orchestrator/run.mjs \
  --configs=orchestrator-cost,orchestrator-balanced,orchestrator-output,lead-alone,builder-alone,small-alone \
  --split=holdout --runs=2 --out=reports/holdout --yes
```

Fill `reports/tune/scores.json` and `reports/holdout/scores.json` for the
manual tasks, then compare both reports:

```sh
node evals/orchestrator/run.mjs \
  --compare=reports/tune/report.json,reports/holdout/report.json \
  --out=reports/compare
```

This yields the success, cost-per-success, role-cost, routing, takeover and
manual-score tables used by the Phase 3 exit report. `small-alone` requires
`EVAL_SMALL_MODEL`. The cost cap still applies per run; `--runs=2` is the minimum
repetition the plan asks for.

Each report records the role assignments, standalone effort levels, turn
timeout, git revision and whether the evaluated source has uncommitted changes.
The source SHA-256 covers the bridge's TypeScript and the evaluator's JavaScript;
the corpus has its own SHA-256. Per-call records retain the effort actually used
and separate cache reads and writes, so comparisons can identify their setup
and recalculate estimates.

Live runs give Harness an empty temporary home configuration. Personal
instructions, skills and MCP servers on the maintainer's Mac do not participate
in the fixture, and the report records this isolation.

An exhausted rate limit, rejected/missing credential, or billing block stops the
batch after the failing case. That case retains its error, provider code and
HTTP status; remaining cases are marked skipped with the reason. Both report
formats and comparisons identify the block. The command exits with status 1 so
a script cannot silently start its next split. Resolve the account issue or wait
for the provider limit to clear, then explicitly start a new run in a new report
directory. Task-specific errors, including context overflows, do not skip other
cases. A blocked report cannot establish a model-quality or cost comparison.

## Prices and cost cap

Costs are USD per 1M tokens. Set `EVAL_PRICES` to a JSON object or a path:

```json
{
  "anthropic/claude-sonnet-5": { "input": 3, "output": 15 },
  "deepseek/deepseek-chat": { "input": 0.27, "output": 1.1 },
  "ollama/qwen3-coder": { "input": 0, "output": 0 }
}
```

Without prices, costs are marked partial; the token cap
(`--max-tokens`, default 5,000,000) is still enforced. `--max-usd` (default 5)
is checked **between** cases, so a single expensive turn can carry the run past
the cap.

Optional `cached` and `cacheWrite` rates price cache reads and writes per 1M
tokens. These tokens are removed from the normal input charge. An unknown rate
or a combined cache count without a read/write breakdown makes the estimate
partial; the known charges are still reported. Partial totals cannot establish
a cost saving or enforce the dollar cap for unpriced usage.

## Tuning

`--tuning` overrides the internal knobs for one run; the host clamps every
value. The app's Settings never exposes these.

```sh
node evals/orchestrator/run.mjs --tuning='{"reviewAllComplex":true,"consultBudgets":{"balanced":3},"stuck":{"checkFailures":3},"leadReads":{"balanced":{"calls":6,"chars":24000}}}' ...
```

Current keys: `consultBudgets` per goal, `reviewAllComplex`, `stuck` thresholds
(`checkFailures`, `editHistory`, `repeatedCalls`, `editFailures`,
`noNewTargetSteps`, `stepLimitStepsLeft`), `scout` gates/budgets and `leadReads`
budgets. A route records each `stuck:<code>` and `consult:auto:<code>` so the
report shows how often each signal fired. `scout.enabled` turns on the 3.2
scout for Cost/Balanced
Lead-guided work; both scout and Lead reads are off by default until the corpus
supports them. To evaluate Lead reads, set a goal's budget, for example
`"leadReads":{"balanced":{"calls":6,"chars":24000}}`. The run's override is
recorded in `report.json`.

## Corpus

The corpus covers:

- a minor CSS token change and a minor copy change
- a localized bug with a failing test
- a bug with an unknown cause and a multi-file bug (holdout)
- a small feature and a cross-cutting feature (holdout)
- a security-sensitive token comparison
- a field migration across two modules (holdout)
- a two-turn continuation and a four-turn thread (holdout)
- a long-context codeword search (holdout)
- a Plan-mode review followed by a build
- a redesign and a vision swatch match scored manually (holdout)
- an ambiguous request scored manually

Keep every fixture small and deterministic. Each task lives in `corpus.mjs`:

```js
{
  id: "unique-id",
  category: "bug",
  prompt: "What the user asks.",
  turns: ["optional", "second message"],
  mode: "plan",                 // optional
  forcedShape: "lead-guided",   // optional, sent as the per-message shape
  images: [{ name: "swatch.png", mediaType: "image/png", base64Data: "..." }], // optional, first turn only
  setup: { "src/file.mjs": "..." },
  checks: [
    { kind: "file", path: "src/file.mjs", contains: "expected" },
    { kind: "command", command: ["node", "--test"] },
  ],
  manual: "Only for tasks without automated checks.",
}
```

Images are base64 PNG, JPEG, GIF or WebP and ride with the first turn only.
Vision and long-context tasks are only meaningful with role models that support
those capabilities. On a lead-guided turn the Lead plan, reads and review see
the image; the Builder works from the neutral plan and its attachment count.
`--dry` fails the task when a file or command check fails. All work happens in
a temporary workspace under the OS temp directory; `--keep` retains it for
inspection. Sessions use `approvalMode: "allowAll"` so the corpus can edit its
own fixtures; this is an evaluation setting, not a product default.

## Comparing reports

`--compare=report1.json,report2.json` reads one or more live reports (a
directory with a `report.json` also works) and prints the decision table:
automated success, cost per success, tokens, calls, latency and time to first
edit; router-skip, explicit and automatic consults, takeovers, plan retries and
fallbacks, and review outcomes; and cost by role. `--out=DIR` writes `comparison.md`.
Success excludes manual tasks, and costs are marked partial when a hosted model
has no price. The command is free and never calls a provider.

A run with manual tasks writes `scores.json` beside `report.json`, with one
`score: null` entry per manual result. Fill each score 0-2 and optional notes;
`--compare` loads the file automatically and reports the mean and scored count.
A score outside 0-2, a duplicate entry, or an entry for a non-manual or absent
result is rejected.

Compare a tuning run and a holdout run separately; rules are chosen from the
tuning split and success is reported on the holdout.

## Reports

`evals/orchestrator/reports/<timestamp>/report.json` contains every run's
checks, final text, changed files, calls by role/stage, compact routes (with
`preRouteRule` and a requested shape when one was forced) and estimated cost.
A run with manual tasks also gets a `scores.json` skeleton beside it.
`report.md` is the short table (with each result's split), the pre-routed turn
count and rule breakdown, a per-config/per-split summary, and a manual-review
template for ambiguous tasks. Reports are gitignored.

The runner is the first Phase 3 prerequisite; it does not change product
defaults. Corpus scores gate scout, Lead reads, stuck-detection thresholds,
pre-route rules and Balanced review.
