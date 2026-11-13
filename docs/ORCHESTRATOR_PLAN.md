# Orchestrator mode plan

A plan for an opt-in mode in which a strong model does the thinking and a cheap
model does the typing. Glitter reads each request, decides how much judgement
it needs, and splits the work between the models the user assigned, from any
provider. Written on 2026-10-26; revised on 2026-10-28 after the staged
pipeline landed. The Phase 0 product
decision is recorded in `docs/DECISIONS.md`. Phase 1 foundations are in place:
the per-call ledger migration, closed router and handoff schemas, pure
pre-route/policy functions and floors, route records, capability probe
requests, validation and caching, the bounded neutral transcript/thread brief,
deterministic tests and preview fixtures for every route shape. Settings →
Orchestrator stores the toggle, goal and role assignments (with the
Small-task → Builder and Router → Small-task fallbacks), runs each role's live
capability check against its Harness model and shows the result under its
picker, and shows the provider disclosure. A built-in agent thread started
while Orchestrator is on now routes every turn: pre-route rules, one Router
call for open prompts, the policy floors, a recorded route, then the decided
stage runs. Lead-guided is staged: the Lead writes a validated plan from a
bounded neutral thread brief (one retry when the plan is rejected), the Builder
executes it with tools, the app assembles a build report from the edits and
checks the Builder actually produced, and the Lead reviews it when the goal
requires — high-risk work in every goal, other non-trivial work in Output. An
Output review can require one repair and a re-review. A Builder provider error
or step limit hands the rest to the Lead in Balanced and Output and records the
takeover; a plan rejected twice falls back to a Lead-only turn. The Builder can
ask the Lead with `ask_lead` within the goal's consult budget, and the app
consults the Lead once when it detects a repeated failing check after edits, a
file edited back to an earlier version, or a near-limit build with edits and no
passing check; the answer reaches the Builder as guidance. Every stage is
recorded on the route with its model and effective effort, and the final route
is emitted after execution, so the receipt and Usage name the stages that ran. The plan, build report, review notes and automatic guidance are
durable trajectory items, and the route references them.
Each route is saved with its turn and replayed on resume; Usage tags every call
with its role. The composer carries the mode: a built-in thread switches
Orchestrator on or off from the model picker, live, restoring the manual model
and effort when switched off; its effort control becomes the goal control, with
a per-message shape that applies to the next message and returns to Auto after
it; a floor that raised the shape is marked on the live line and the receipt.
Each staged plan's Builder now runs in a fresh session seeded with the plan and
a bounded neutral transcript, and a staged turn keeps only neutral user and
final-answer messages in the thread; a Builder question or a restart resumes
that plan's session, and a model change resets it. The Lead keeps its own
durable session for the thread (plans, build reports, reviews and consult
answers), reset when its model changes; the plan call is tool-less unless the
goal's Lead-read budget is enabled. Request images go to the Lead plan, read
stage and review session; the Builder's neutral session sees only the
attachment count and works from the plan. The build report carries the
Builder's summary, a bounded patch, diff stat and checks. In Plan mode the
validated Lead plan opens the existing plan-review card; the Builder starts only after approval, and the
approved plan carries into the next Build turn, recovered from the session after
a restart. A Builder resumed after a user question reviews only the changes
made after that question; replaying the pre-question observations into the
build report remains. Scout and Lead reads are implemented behind their internal
budgets; the evaluation corpus is in place, while the three manual baselines
remain outstanding.

`docs/HARNESS_UPGRADE_PLAN.md:569` lists automatic model selection as out of
scope "without an explicit product decision". Phase 0 of this plan is that
decision; record it in `docs/DECISIONS.md` before any code lands.

## The idea

**Pay frontier prices for judgement, not for reading and typing.**

Most of an agent's tokens are not spent thinking. Each step of the tool loop
re-sends the whole context: a feature that takes 40 steps at 30k tokens of
context reads about 1.2M input tokens, while the decisions that make the
feature right fit in a few thousand. Today one model pays for both, so either a
frontier model pays frontier prices for the 40 steps, or a cheap model makes the
decisions it is weakest at.

Orchestrator separates them:

- A **Lead** model (a frontier reasoning model, such as Opus or Kimi-class)
  understands the request, diagnoses, decides the approach and writes a
  concrete plan. It runs few calls, at high effort, because that is where its
  quality matters.
- A **Builder** model (a cheap, capable coder, such as DeepSeek, MiniMax or
  Qwen-class, or a local model) follows the plan through the long tool loop:
  reading files, editing, running tests. It runs many calls, at its highest
  supported effort: cheap models write poor code at low effort, and their
  reasoning tokens cost little, so cutting their effort saves almost nothing
  and costs quality.
- The Lead **reviews** the result when the goal calls for it, and answers the
  Builder's questions when it gets stuck.
- Trivial work skips the Lead entirely. A one-line CSS change goes straight to
  a cheap model; nobody pays for planning it.

The difficulty check decides *how much* Lead involvement a request needs, not
just which single model runs it. The user's goal (cost, balanced, output)
decides how often the Lead plans, reviews and is consulted.

The providers are independent. A Lead from Anthropic, a Builder from DeepSeek
and a Small-task model running in Ollama is the intended setup, not an edge
case.

## Roles

| Role | Does | Calls | Effort | Example class |
|---|---|---|---|---|
| **Lead** | Diagnoses, plans, reviews, answers Builder questions, takes over when the Builder fails. The user's "main orchestrator". | Few | High | Frontier reasoning model |
| **Builder** | Implements Lead plans; handles mid-level tasks alone when no plan is needed. | Many | Highest supported | Cheap strong coder |
| **Small-task** | Trivial edits alone; reads and summarises code for the Lead (scout). Defaults to "Same as Builder". | Some | Highest when editing code; low for copy, questions and scouting | Cheapest capable model |
| **Router** | Judges each prompt. Under "Advanced"; defaults to "Same as Small-task". | One per turn, often skipped | Low | Any reliable JSON model |

Any role may use any provider the user has set up, including custom endpoints,
gateways (OpenRouter, Kilo, Cline, NVIDIA NIM) and local servers (Ollama,
LM Studio). The app never ranks models by name; it uses the roles the user
filled in.

## Turn shapes

The policy picks one shape per turn:

| Shape | Flow | Typical use |
|---|---|---|
| **Direct (Small)** | Small-task model does it alone | Typo, copy, exact CSS property, isolated rename, simple question |
| **Direct (Builder)** | Builder does it alone | Localized bug with a clear cause, small self-contained feature |
| **Lead-guided** | (Scout) → Lead plans → Builder builds → checks → (Lead reviews → Builder repairs) | Features, redesigns, major bugs, refactors, anything with design choices |
| **Lead only** | Lead does it alone | Work where thinking and doing cannot be separated: unexplained intermittent failures, delicate security code in Output mode, a plan the Builder failed twice |

Later (Phase 4): **Lead-guided team**, where the Lead's plan splits into
independent steps, each built by its own Builder session.

### The handoff documents

Models never share a conversation. They hand each other documents, which is
what makes mixing providers safe (see Sessions):

- **Context pack** (scout → Lead): the files, symbols and excerpts relevant to
  the request, with paths and line ranges. Lets the Lead think on a condensed
  view instead of paying to read the repository. The Lead may ask for more
  reads within a budget.
- **Plan** (Lead → Builder): goal; acceptance criteria; files and symbols to
  change and why; ordered steps with exact intent; constraints and things not to
  touch; tests and checks to run; known risks; "ask the Lead if…" triggers. The
  plan is the main quality lever, so its format is fixed and validated: a plan
  without acceptance criteria or concrete file targets is rejected and the Lead
  is asked once to complete it.
- **Build report** (Builder → Lead): what changed (diff stat and the diff
  itself for review), check results, deviations from the plan and open
  questions.
- **Review notes** (Lead → Builder): pass, or specific required fixes.

In Plan mode the Lead's plan is what the user reviews in the existing plan
review card (`PlanReviewCard.tsx`); the Builder starts only after approval.

### Asking the Lead

The Builder gets an `ask_lead` tool: a question plus the relevant excerpt. The
Lead answers from its own session, which already holds the plan, so an answer
is one short call. Each goal sets a budget of consults per turn. The app also
consults the Lead on the Builder's behalf when it detects the Builder is stuck:
the same check failing twice after edits, the same file edited back and forth,
or a step limit approaching with acceptance criteria unmet.

### When the Builder fails

After its consults are spent and checks still fail, the Builder stops and hands
back a build report. Depending on the goal, the Lead then either takes over the
remaining work (visible: "Lead took over · Builder stuck on X"), or the turn
ends with the result, the failing evidence and a one-click "Let the Lead
finish".

## Goals

Effort names are targets; the app maps them to each model's supported efforts
(`reasoningEfforts` on `Model`, `apps/desktop/src/lib/types.ts:338`) and records
the effort actually used.

**Effort rule: any stage that writes or repairs code runs at the model's
highest supported effort, in every goal.** That covers Builder builds and
repairs, Small-task code edits and Lead takeovers. Goals save money by choosing
the model and limiting Lead calls, never by lowering effort where code is
produced. Low effort is reserved for stages that produce no code: the router,
scout summaries, copy edits and plain questions. A model with no effort control
records "n/a"; a model whose highest tier is unusually slow or expensive is
still run at it, and the evaluation reports the cost so a user can change the
role.

| | Optimize for cost | Balanced (default) | Optimize for output |
|---|---|---|---|
| **Trivial** | Small direct | Small direct | Small direct, then relevant checks |
| **Mid-level** | Builder direct | Builder direct; a short Lead plan when the router reports design choices or several files | Lead-guided with review |
| **Complex** | Lead-guided: scout context pack, Lead plan at medium effort, no review | Lead-guided: Lead reads within a budget, high-effort plan; Lead review for high-risk work | Lead-guided: Lead reads freely, highest-effort plan, Lead review, one repair and re-review |
| **Effort when writing code** | Highest supported | Highest supported | Highest supported |
| **Consults** | 1 | 2 | 4 |
| **Builder fails** | Stop with evidence and "Let the Lead finish" | Lead takes over once | Lead takes over once |
| **Checking** | No paid checking; existing tests or type-check once when they cover the change; none for CSS or copy | Relevant checks; review as above | Relevant checks, review and re-review |
| **Answers** | Short | Normal | Includes residual-risk note |

**High-risk floor** (auth, security, payments, secrets, destructive data,
migrations, concurrency), in every goal: the Lead plans and the Lead reviews.
In Output mode the Lead writes the risky part itself. Permissions and approvals
never change with the goal.

Output mode never adds a Lead plan or review to trivial work.

The 80-step parent and 24-step child limits remain failure backstops, not
targets.

## Routing

```text
Prompt
  → Pre-route rules (no model call)            ── decided? ─┐
  → Router call (bounded, tool-less, JSON)                  │
  → Validated assessment                                    │
  → Policy: floors, goal, capabilities  ◄───────────────────┘
  → Route record (persisted)
  → Turn shape: Direct / Lead-guided / Lead only
  → Per-call usage with model, role and price
```

### Pre-route rules

The router call is skipped when the answer is already known. Each records
`pre-route:<rule>` so the evaluation can measure it:

| Case | Route |
|---|---|
| User forced a shape for this message | That shape (floors still apply) |
| Continuing an open Lead-guided task ("continue", a reply to a question, a queued follow-up) | Same task, same shape |
| Prompt names a high-risk area by keyword | Lead-guided with review |
| Short prompt naming one exact property, selector, string or identifier to change, no "redesign / refactor / all / every / why" wording, no attachment | Small direct |

The list stays short and is tuned from the evaluation corpus. A rule can never
pick less Lead involvement than a floor requires.

### Router

Input is a bounded envelope, not the session: the prompt, the last one or two
turns' text when the prompt refers back, Plan/Build mode, the open task's
shape, attachment names and types, earlier escalation markers. Start at about
4k input and 200 output tokens; tune from measurements.

Output is JSON only, no tools, no reasoning text:

```ts
{
  taskKind: "question" | "minor_edit" | "bug_fix" | "feature" |
            "redesign" | "refactor" | "migration" | "security" | "other",
  difficulty: "trivial" | "mid" | "complex",
  designChoices: boolean,      // does it need decisions before typing?
  separable: boolean,          // can the thinking be written down for someone else?
  causeKnown: boolean,         // for bugs: is the cause evident from the prompt?
  risk: "low" | "medium" | "high",
  confidence: "low" | "high",
  continuity: "new" | "continuation",
  requiredCapabilities: Array<"tools" | "vision" | "long_context">,
  reasonCodes: string[]
}
```

`designChoices` and `separable` are what decide between Direct, Lead-guided
and Lead only. The router cannot name a provider, model, effort, permission or
approval.

### Floors

| Request | Minimum |
|---|---|
| Typo, copy edit, exact CSS property, isolated rename | Small direct |
| Localized bug with known cause, small self-contained feature | Builder direct |
| Redesign, major bug, broad refactor, feature with design choices | Lead-guided |
| Bug with unknown cause | Lead diagnoses (read-only) before any Builder edits |
| High-risk area | Lead plans and reviews, every goal |
| Router confidence low or invalid JSON | One level more Lead involvement (invalid JSON → Lead-guided without review) |
| An earlier attempt in this task failed | Never less Lead involvement for that task |
| Needs vision, tools or long context | Only roles whose model has it; otherwise the Lead does that part |
| User said "no sub-agents", "don't review" | Honoured, without weakening permissions |

Attachment images are a capability floor: any stage that receives them needs
vision. Lead-guided turns send the request images to the Lead's plan, reads and
review; the Builder's fresh session stays neutral and works from the written
plan. Direct shapes and Lead-only execution already carry the thread image.

## Sessions and history across providers

Replaying one provider's conversation to another breaks: reasoning signatures,
tool-call formats and caches differ. So nothing provider-specific ever crosses
between models:

- **Each model works in its own session.** Provider-specific blocks (thinking,
  signatures, tool-call IDs) stay inside it.
- **The Lead's session lives for the whole thread.** It holds the user's
  requests, its plans, build reports and review notes, so follow-ups like "now
  make it responsive" reach a Lead that remembers. Because the Lead's model
  never changes within a thread, its prompt cache stays warm across turns;
  existing compaction keeps it bounded.
- **Builder and Small-task sessions are fresh** per plan or per direct turn.
  They get the plan (or the prompt), a bounded tail of the app's neutral
  transcript and a short thread brief. Inside their own tool loop they cache
  normally.
- **The neutral transcript is app-owned**: user messages, final answers, plans,
  build reports and diff stats as plain text. It is what any model, on any
  provider, can be given.

This replaces model switching inside one session, so the earlier
"same provider" rule and cache-stickiness rule are not needed: no session ever
changes model, and the only cross-model traffic is a bounded document.

## Capabilities and trust

- **Capability probe.** The first time a model is assigned a role, the app runs
  a short fixed check suited to the role (Builder: a scripted multi-step tool
  use and edit in a scratch directory; Router: strict JSON; Lead: plan format)
  and caches the result per model. A model that fails cannot take the role;
  unknown is treated as unsupported.
- **Data disclosure.** Settings lists every provider that will receive code
  under the current roles: "Your prompts and code are sent to: Anthropic
  (Lead), DeepSeek (Builder), Ollama on this Mac (Small-task)." The disclosure
  updates when a role changes.
- Credentials stay injected natively (`apps/desktop/src-tauri/src/lib.rs:765`);
  the renderer never sees keys. No new workspace, shell, browser or OS
  permission is needed. Every model's tool calls go through the same
  permission pipeline and native turn snapshots as today.

## Settings

A new **Orchestrator** section directly after **Models** in the Settings
navigation (`apps/desktop/src/lib/settingsNav.ts`). Follow
`docs/DESIGN_SYSTEM.md` and record the section there in the same commit.

1. Orchestrator applies to Harness threads; a thread can switch between it and
   a manually selected model.
2. **Use Orchestrator for new threads**: off by default.
3. **Goal**: Optimize for cost / Balanced / Optimize for output, with a
   two-line summary of what it does.
4. **Lead model**, **Builder model**, **Small-task model**: the existing
   provider → model picker, all providers. Each shows its probe result.
5. **Advanced** (collapsed): **Router model**.
6. The data-disclosure list and inline availability warnings linking to
   Providers.

No thresholds, consult budgets or plan templates in the first release.

## Composer

Keep the one-row composer and the 16px buffer above it; nothing renders beneath
it.

- The model popover gains an **Orchestrator** option for built-in agent
  threads. In that mode the trigger reads **Orchestrator** and the effort
  control becomes a **goal** control in the same footprint.
- **Per-message override** in the goal popover, "This message": Auto / Small /
  Builder / Lead-guided / Lead only. Applies to the next message, then returns
  to Auto. Floors still apply and the label says when one did.
- Switching back to Manual restores the previous model and effort.

Implemented today: the picker's switch writes the stored roles to the live
session (`setOrchestrator`), and switching off clears the block and restores
the model and effort stashed when it went on. The goal chip replaces effort in
the same footprint and writes goal changes to the session. A per-message shape
rides the next non-steer send as `forcedShape`, then returns to Auto once the
send is delivered; a steer leaves it queued. Floors still apply, and the live
line and receipt mark `· floor` with the reason on hover.

### Showing the route

Short facts in the turn header and trajectory, never private reasoning:

- "Lead plan · <lead> → Builder · <builder>"
- "Scout · <small>"
- "Approved plan · <lead> → Builder · <builder>"
- "Builder resumed · <builder>"
- "Builder asked the Lead · 1 of 2"
- "Lead took over · tests kept failing"
- "Reviewed by <lead> · 2 reviews"
- "Router unavailable · Lead-guided fallback"

Single-role turns keep their shape and model in the receipt rather than
repeating them. The plan, build report, review notes and automatic guidance
appear as collapsed trajectory steps. The turn footer reports e.g. "12 calls ·
2 models"; Usage shows the split by role.

Implemented today: the live line and receipt carry the decided shape, a
`floor` mark when a floor raised the per-message shape and a `fallback` mark
with the reason on hover, the calls/model count once calls arrive, and the
executing model in place of the single-model estimate; the final route event
carries every stage that ran, and the executor is read from the last stage that
wrote code, so a plan or review call never replaces the Builder. A staged turn
adds one quiet route-facts line with the plan/build pair, consults, takeover and
review, and the same facts are in the receipt's hover title. The plan, context
pack, build report, review notes and automatic guidance are durable steps, and
the route references the plan, latest context pack, latest build report and latest
review item. A Plan-mode turn opens the same plan in the plan-review card;
approval builds that plan, and feedback plans again. Usage tags each trajectory
call with its role.

## Persistence and accounting

### Route records

Additive settings defaults; older settings load unchanged. Each routed turn
stores: route ID and policy version; goal, shape, reason codes and pre-route
rule; role snapshot; models and effective efforts per stage; the consult budget
and consult/review counts; fallbacks, takeovers and escalations; references to
the plan, context pack and reports, each the item id of that handoff in the
turn's trajectory. No keys, no router reasoning, no duplicate prompt. Ephemeral
sessions keep records in memory only.

### Usage per call

The ledger assigns a turn to one model (`apps/desktop/src/lib/usageLedger.ts:129`),
which cannot describe a Lead-guided turn. Versioned ledger migration:

- `ModelCall` gains `routeId`, `role` (router / scout / lead-plan / builder /
  consult / review / repair / takeover / small) and effective effort.
- Every call counted exactly once; tokens and estimated cost per call from that
  call's model and price, with the price kept on the record.
- Turn and daily aggregates break down by role and model, so the user sees for
  example "Lead 9% of tokens, 61% of cost".
- Any unpriced call makes the total **partial**, never $0. Local models are
  priced at zero explicitly, not by omission.
- Trajectory retention derives from the stage budgets, so nothing is dropped at
  the current 80-call boundary.

No per-turn "saved X%"; savings come only from the aggregate evaluation.

## Failure behavior

- **Router fails:** no retry; Lead-guided without review (or the floor), shown.
- **A role is unavailable:** stop and say which; never substitute another model
  silently. If only the Builder is down, offer "Run with the Lead only".
- **Plan invalid twice:** the Lead does the work itself, shown.
- **Builder fails:** consults, then takeover or stop, per goal.
- **Provider errors:** existing same-model transient retries only.
- **Cancel:** every stage shares the turn's abort signal; cancelling stops the
  current stage and starts no further one.
- **Budget exhausted:** return the current result and remaining risk; start no
  hidden paid work.

## Phases

### Phase 0 — Decision and baseline

Record the decision in `docs/DECISIONS.md`. Build the evaluation corpus and
record three manual baselines: Lead alone, Builder alone, Small alone. The
Builder and Small baselines run at their highest supported effort, the same as
in Orchestrator, so the comparison measures the plan's value and not an effort
difference.

### Phase 1 — Foundations

Per-call ledger migration, route records, neutral transcript and thread brief,
handoff document formats and validators, capability probes, pure policy
functions (floors, goals, pre-route rules, shapes), preview fixtures,
deterministic tests. No automatic routing.

### Phase 2 — First release

Settings, composer mode and override, pre-route rules, router, all four turn
shapes with one Builder, `ask_lead` and stuck detection, Lead review and repair
per goal, takeover, Plan-mode integration, disclosure, cross-provider from day
one, accurate usage.

This is an app-driven pipeline with fixed stages, not open-ended model-driven
delegation, so it does not wait for the delegation evidence in
`HARNESS_UPGRADE_PLAN.md` Phase 6.

**Exit gate:** on the corpus, Balanced with a frontier Lead and a cheap Builder
matches the Lead-alone baseline's success rate at a clearly lower cost per
successful task, including every plan, consult, review and retry call. No
complex or high-risk fixture runs Small direct.

### Phase 3 — Adaptive quality

**Status:** in progress. 3.0.2's route reason codes for explicit and automatic
consults, stuck signals and review outcomes are landed, as is 3.0.3's bounded
patch in the build report, an expanded 3.0.1 corpus/runner with free validation,
dry-run, host-bundle, pre-route and report-comparison checks and a tune/holdout
split, 3.0.4's session isolation, 3.0.5's internal
tuning contract, 3.1's shared read-only stage and read probe, 3.2's scout
context pack behind the internal flag, 3.3's opt-in Lead reads, 3.4's richer
stuck signals and re-armed automatic consult, and 3.5's free pre-route matrix.
Live baseline runs still need provider keys and spend; the consult/pre-route
decisions, the Balanced review experiment and the exit report are next. Tune
only after the corpus and baselines exist: every decision below is a corpus
comparison, not a guess.

On 2026-11-13, offline validation covered 16 tasks and 28 checks, and the
scripted pre-route matrix passed 23/23 cases. These results do not establish
live model quality or cost savings.

**Exit gate:** the chosen defaults match or beat the Phase 2 Balanced baseline's
success rate at lower or equal cost per successful task; the review-all-complex
choice is supported by the corpus; no floor or safety behavior weakens; and
`npm run verify` stays green.

| Task | Depends on | Leaves behind |
|---|---|---|
| **3.0** Prerequisites | — | Corpus, baselines, eval runner, instrumentation, patch-bearing report, session isolation, internal tuning config |
| **3.1** Read-only stage | 3.0.5 | Bounded local-history read loop shared by scout and Lead reads |
| **3.2** Scout context pack | 3.1 | `scout` stage, validated pack, fallback and context-pack item |
| **3.3** Lead reads | 3.1 | Per-goal read budgets for the Lead plan |
| **3.4** Stuck detection v2 | 3.0.2 | Richer signals, bounded evidence and consult rules |
| **3.5** Consult/pre-route tuning | 3.0.1, 3.4 | Chosen budgets and rules with fixtures |
| **3.6** Balanced review | 3.0.3, 3.5 | Data-gated review of all complex Balanced work |
| **3.7** Exit report | All | Defaults, evidence and rejected options |

#### 3.0 Prerequisites

1. **Corpus, baselines and runner (Phase 0 carry-over).** Build the fixed
   fixture repositories, automated checks and a manual rubric with a
   `scores.json` sidecar described under Live evaluation; record Lead-alone,
   Builder-alone and Small-alone baselines
   at their highest supported effort. Add an opt-in, cost-capped
   `eval:orchestrator` runner under `evals/orchestrator/` that runs any
   configuration and writes a machine-readable report plus a short table. It is
   not part of `npm run verify`. The corpus and runner are in place: 16 tasks
   (28 checks) span the plan's minor, copy, bug, feature, security, migration,
   continuation, long-thread, long-context, plan-mode, redesign, vision and
   ambiguous classes. The tune/holdout split is in place: 8 tuning and 8
   holdout tasks, selected with `--split=tune|holdout`, so rules are not tuned
   on the tasks that report success. Vision images ride with a task's first
   turn. `--validate`, `--list`,
   `--dry`, `--check-host` and `--pre-route` are free, while live baseline runs
   still need provider keys and spend. Run each fixture two to three times.
   Record task success, review quality, cost per success, role split, plan
   rejection, consult rate, takeover rate, pre-route accuracy, router skip rate,
   time to first edit and latency.
2. **Decision-grade instrumentation (landed for scout use, Lead read steps,
   plan retries, stuck signals, consults and review outcomes).** Add additive
   route metadata, preferably reason codes plus a small signal list, for scout
   use and fallback, Lead read steps, stuck signals, explicit versus automatic
   consults, consult outcomes and review outcome. Stage rows and `modelCall`
   role/stage already cover models and usage; fill the gaps without storing
   prompts or reasoning. The runner reads the persisted routes and items and
   captures the host's `modelCall` and `turnCompleted` events; the app's Usage
   ledger stays the app-side view.
3. **Patch-bearing build report (landed).** Populate `BuildReport.diff` with a
   bounded patch from the Builder's edit observations, so a review can judge the
   actual change. Without it, the review experiment in 3.6 cannot measure review
   quality.
4. **Session isolation (landed).** The Lead has a durable session for the
   thread (requests, plans, build reports, review notes and consult answers)
   with its model fixed for the thread; provider-specific blocks stay inside
   that session, while the app-owned transcript remains neutral. Each plan's
   Builder gets a fresh session seeded with the plan and a bounded neutral
   transcript; a Builder question or a restart resumes the same session, and a
   model change resets it. Staged turns write only neutral user and final-answer
   messages to the thread. Direct and manual shapes keep their existing history.
   A resumed Builder's review currently covers the changes made after its
   question; replaying the earlier observations into the build report is a
   follow-up.
5. **Internal tuning config (landed).** `OrchestratorTuning` (in
   `tuning.ts`) carries the consult budgets, Balanced review-all-complex,
   stuck thresholds and reserved scout/Lead-read budgets. The host resolves and
   clamps a partial override from `HostLimits.tuning`; the evaluation runner
   exposes it as `--tuning`, and tests use the same seam. The app never exposes
   these values in Settings, and Phase 5 does. The route record keeps the
   consult budget it ran with. The scout and Lead-read entries are consumed by
   3.2 and 3.3 and stay off or zero until the corpus supports them.

#### 3.1 Shared read-only stage (landed)

The local-history loop is in place as `runReadOnlyStage`. It offers only
`read_file`, `list_files` and `grep`; no edits, shell, MCP, delegation or
`ask_user`. It runs against the workspace under the existing permission guards
with a step count and a character budget, suppresses the model's text and
reasoning from the transcript while keeping tool items visible, and returns the
final text plus the read tools used. Calls carry the role and stage in
`modelCall` and Usage. A hallucinated non-read tool is refused before it runs.
The internal `orchestratorReadProbe` verifies a real successful read, caches the
answer per model, and is what read-enabled stages call; a failure means fall
back to no reads, never another model. It is intentionally not a Settings role
probe.

The scout (3.2) and Lead reads (3.3) use this loop. Deterministic tests cover
the read probe (pass, text-only, wrong path, non-read tool), read-only tool
filtering, text suppression, budget exhaustion and role/stage accounting.

#### 3.2 Scout context pack (landed)

The Scout path is implemented behind the internal `tuning.scout.enabled` flag
(default off until the corpus justifies it). When enabled for Cost or Balanced
Lead-guided work on complex or unknown-cause requests, the Small-task model runs
through `runReadOnlyStage` and returns a validated `context-pack`; one rejected
pack gets one retry. Its read tools must actually be used, the pack and excerpts
are capped by the tuning values, and the pack is a durable
`orchestratorContextPack` item referenced by the route. The Lead plan prompt
carries the pack. A failed read probe, invalid pack or unavailable Scout records
a fallback and the Lead plans without it; no other model is substituted. Output
keeps Lead reads rather than a scout.

Tests cover the enabled path, the invalid-pack fallback, a Scout without read
tool support, the context-pack item/route fact and the policy gates. The live
corpus still decides when the flag is turned on by default.

#### 3.3 Lead reads (landed)

The Lead plan stage now has an optional read path through 3.1. It is off by
default: a goal's `leadReads` budget must set positive `calls` and `chars`
(Cost initial target is zero, Balanced 6/24k, Output 20/64k; the corpus chooses
when to enable them). When a budget is set and the internal read probe passes,
the Lead reads in its own durable session before writing the plan; reads are
tagged `lead-plan`, visible in the trajectory, and never enter the Builder's
session. The plan is validated as today, with one read-stage retry; two rejected
plans still fall back to the Lead-only turn. A failed read probe or read stage
records `lead-read:unavailable` and the Lead plans tool-less from the brief; no
other model is substituted. In Plan mode, reads happen before the plan-review
card. The read stage and the tool-less plan carry the current request's images
when the Lead is vision-capable; an approved or resumed plan reattaches only
images the Lead session does not already hold.

Tests cover the enabled path, the tool-less default, the no-read-tool fallback,
the read-stage retry, image delivery to the read-and-plan stage, and role/stage
accounting.

#### 3.4 Stuck detection v2 (landed)

The detector tracks seven deterministic codes: `check-failed-twice`,
`edit-back-and-forth`, `repeated-call` (the same tool with canonical
arguments), `edit-failed-twice` (the same failed edit signature), `no-progress`
(no new path over `noNewTargetSteps` after edits), `plan-checks-failing` (the
plan's checks are still not passing near the step limit), and `step-limit`. The
Builder loop observes every call and result, not only edit and command
presentations, and passes the step index. Evidence is the last three bounded
failure lines plus the edited paths, never prompts or reasoning. Each signal
fires at most once per Builder attempt; a successful automatic consult re-arms
only its own code, so a second consult needs another occurrence and the goal's
remaining budget. The state is per turn: a resumed Builder after a user question
starts a new attempt, and the route still records `stuck:<code>` and
`consult:auto:<code>`. The thresholds are internal tuning values. Do not fire
when a question is already pending or the budget is spent.

Acceptance: deterministic tests for each signal and for legitimate retries that
must not fire; no duplicate identical consult; consult evidence is bounded and
contains no provider-private data; corpus reports false-positive and
consult-success rates before thresholds are changed.

Tests cover each new signal, the tuning clamps, a corrected retry that must not
fire, and a second automatic consult only after guidance.

#### 3.5 Consult budgets and pre-route rules from data

Keep the internal budgets (currently 1/2/4 for Cost/Balanced/Output) as the
starting point and change them only when the corpus shows a better point for a
goal, difficulty and risk class. Evaluate candidate pre-route rules, each with
positive and negative fixtures: a short continuation with an open plan; a prompt
naming a failing test or stack trace; a review/approval reply; a reference to a
previous change ("same as before"); an attachment-only request; and the
existing exact-small-change, high-risk and continuation rules. A rule never
lowers a floor, and every skip records `pre-route:<rule>` for accuracy and
router-skip measurements. Phase 3 keeps these internal; Phase 5 exposes tuning.

The free measurement half is landed in `evals/orchestrator/pre-route.mjs`: 23
labeled cases cover every current rule, floor raises and negative lookalikes,
and `--pre-route` prints rule accuracy and the Router-skip rate without a
provider call. Candidate cases are reported with their current route, not
asserted. It already exposes one rule interaction: the exact-small rule claims
a prompt naming a failing test or a stack trace before the Router can assess
the cause. Whether to add a failing-test candidate rule, and every budget or
default change, still waits for the live corpus.

Acceptance: corpus pre-route accuracy and router-skip rate; no floor regression;
bad-router fallback unchanged; every new rule has fixtures and a documented
reason based on the corpus.

#### 3.6 Review in Balanced for all complex work

Add an internal `reviewAllComplex` switch for Balanced. Evaluate Balanced with
review for all complex work against Balanced with review only for high-risk
work, using the patch-bearing report from 3.0.3. Gate the default on success or
review-quality improvement at an acceptable cost per successful task; do not
enable it for trivial or mid-level work, and never weaken the high-risk floor.
Start with review only; evaluate one Balanced repair as a separate variant only
if review findings often require fixes and the corpus supports the cost. Cost
mode keeps no review except the high-risk floor; Output keeps its existing
review, repair and re-review.

The free comparison half is landed: `--compare` reads `report.json` files and
prints success, cost per success, cost by role, router-skip, consult, takeover,
plan-retry/fallback and review-outcome rates, latency and time to first edit per
config and split. Manual tasks use a sidecar `scores.json` with 0-2 rubric
scores; the comparison reports their mean and scored count. The live A/B still
waits for provider keys and spend.

Acceptance: corpus A/B with cost and quality; no review of trivial work;
high-risk behavior unchanged; the chosen default is recorded in this document
and `docs/DECISIONS.md` if it changes a product default.

#### 3.7 Sequencing and exit report

Order the work so measurements lead the changes:

1. 3.0.1–3.0.2 (corpus, runner, instrumentation) — the long pole.
2. 3.0.3–3.0.5 (patch report, session isolation, tuning config) in parallel.
3. 3.1 read-only stage, then 3.2 scout and 3.3 Lead reads behind flags.
4. 3.4 stuck v2 in parallel with the read work.
5. 3.5 consult/pre-route tuning from the first corpus report.
6. 3.6 review experiment using the patch-bearing report.
7. Exit report: chosen defaults, per-fixture success/cost, rejected options and
   the remaining risks. Update this plan, `CHANGELOG.md`, `docs/AGENT_GUIDE.md`
   and the route facts/Design System if scout or read facts are shown.

Out of scope: Phase 4 teams, Phase 5 user-facing tuning, model ranking and new
provider work. If the corpus is not ready, do not change defaults from Phase 2;
build the runner and instrumentation first.

### Phase 4 — Teams

The Lead splits a plan into independent steps, each built by its own Builder
session, sequentially first, then in parallel on disjoint files once measured.
Uses the delegation work in `HARNESS_UPGRADE_PLAN.md` Phase 6.

### Phase 5 — User tuning

Editable presets, consult and review budgets, effort ceilings, plan templates,
per-role fallback lists and more than one Builder model (for example a
specialist for UI work).

## Validation

### Automated (`npm run verify`; Node and Rust tests never run together)

- Policy matrix: difficulty × goal × risk × confidence × designChoices ×
  separable × capability × forced shape.
- Floors: complex and high-risk fixtures never run Small direct, through any
  rule or override; high-risk always gets Lead plan and review.
- Pre-route rules: positive and negative fixtures for each.
- Handoffs: plan validator accepts and rejects the right plans; no
  provider-specific block ever enters another model's session (fixtures across
  Anthropic-wire, OpenAI-wire, gateway, custom and local providers, including
  models that always return reasoning).
- Lead session continuity across turns; Builder sessions fresh; neutral
  transcript tail bounded.
- `ask_lead` budgets, stuck detection, takeover and stop paths per goal.
- Capability probes: pass, fail, unknown, re-probe on model change.
- Effort mapping per provider family; every code-writing stage resolves to the
  model's highest supported tier in every goal, and only non-code stages run
  low.
- Bad router JSON, prompt injection aimed at the router or carried in a plan,
  unavailable roles, unknown price, missing capability.
- Cancellation at every stage, retries without re-routing, queued and steered
  turns, restart and resume mid-pipeline.
- Ledger migration, per-role cost, partial totals, exactly-once counting.
- DOM: Settings navigation and search, disclosure list, built-in-agent-only
  visibility, composer mode and override, route labels, plan review card,
  keyboard access, narrow layout, browser preview.
- Manual model selection remains available when Orchestrator is off.

### Live evaluation (opt-in, cost-capped, not part of verify)

Fixed fixture repositories: minor CSS and copy changes, full redesigns,
localized and major bugs, bugs with unknown cause, small and cross-cutting
features, security and migration cases, ambiguous prompts, continuations, long
threads, vision and long-context requests. At least two pairings, for example a
frontier Lead with a cheap hosted Builder and with a local Builder. Repeated
runs against the three baselines.

Measure task success and review quality, cost per successful task, the cost
and token split by role, plan rejection rate, consult rate, takeover rate,
pre-route accuracy, router skip rate, time to first edit and total latency.

The key question the evaluation answers: **does a cheap Builder following a
frontier Lead's plan match the frontier model working alone, for much less?**
If it does not on a task class, the policy routes that class to Lead only.
Balanced becomes the recommended default only when the answer is yes overall.
A Cost mode that is cheaper only because it fails more often does not pass.
