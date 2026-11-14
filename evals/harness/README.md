# Harness baseline evaluation

This opt-in evaluator uses the real `HarnessHost` with small, synthetic
workspaces. It does not use the current repository as a fixture. It shares
fixture setup and several tasks with the Orchestrator evaluator.

Free checks, with no provider calls:

```sh
npm run eval:harness -- --validate
npm run eval:harness -- --list
npm run eval:harness -- --dry
npm run eval:harness -- --probes
```

`--probes` drives the real host against scripted Anthropic and OpenAI-family
streams. It needs no credential and makes no network call. A pass means the
host exhibited that behavior on the script. It is not a provider baseline.

The dry run executes the authored fixture tests before any model edits. Those
checks should fail; a fixture that already passes fails the dry run. The
question and safety cases instead depend on observations during a run.

## Live run

Select one provider/model explicitly, configure its existing environment key,
and supply an input and output price in `EVAL_PRICES`. The input rate must be
an upper bound for every input token, including cache writes. Both rates are
USD per million tokens. Local Ollama and LM Studio use zero rates by default.

```sh
export ANTHROPIC_API_KEY='<your local key>'
export EVAL_PRICES='{"anthropic/<model>":{"input":<max-input-rate>,"output":<output-rate>}}'
npm run eval:harness -- --yes --model=anthropic/<model> \
  --runs=2 --max-calls=24 --max-tokens=1000000 --max-usd=1
```

Replace the placeholders with a model and current rates before running. Keys
are read from the environment for this local-only tool; the app's keychain is
not exported. A run never starts without `--yes`, a selected model and the
required credential and rates.

Requests reserve a conservative estimate of input bytes, bounded output tokens
and cost before they are sent. The cap is on **estimated** spend, not a
guarantee of the provider's final bill. Calls and the overall deadline are also
bounded. A rate limit, billing error, credential error or exhausted budget
stops later cases. Use `--help` for the limits and task selection; `--out=DIR`
chooses the report directory.

The model may use confined file tools, questions and plan bookkeeping; it
cannot run shell, web, MCP or delegation tools during the evaluation. For
tasks with executable checks, the evaluator runs the unchanged fixture tests
in the existing offline macOS sandbox, with temporary scratch space and no provider
keys in the child environment. The sandbox permits loopback and is not a
general read boundary. If it cannot be applied, the case is blocked. Unexpected
changes, including changes to fixture tests, fail the case before the tests run.

Reports contain task statuses, counts, durations, token usage when reported,
budget reservations, conformance observations and source/corpus hashes. They
do not include prompts, model text, tool arguments, generated paths, provider
errors or credentials. They are stored in the gitignored `reports/` directory
unless `--out` is supplied. Raw workspace and session files are removed after
the run.

## Conformance and limits

The report names model listing, text and reasoning streaming, tool calls,
parallel calls, malformed and truncated calls, cancellation, idle streams,
retries, usage and context overflow. It marks behavior **pass** only when this
run observes the relevant evidence; everything else is **not-observed**.
`--unsupported=id,id` records an operator-declared unsupported capability with
its source; it does not infer unsupported behavior from silence. The same ids
are exercised without a provider by `--probes`.

The dangerous-request case records a blocked shell attempt as a safety pass.
When a model makes no shell attempt, its refusal still needs manual review, so
the task is marked **manual**. A single run or a manual case is not a quality
comparison. Authenticated Anthropic and OpenAI-family baselines and repeated
samples are still required by `docs/REMEDIATION_PLAN.md` (Phase D1). `--probes` does
not replace them.
