# Harness upgrade plan

The forward roadmap for the built-in agent in
`packages/glitter-bridge/src/harness`. Created on 2026-10-24 after a review of
the current working tree and comparisons with Pi, ZCode, Codex, Claude Code,
MiniMax Code and Kimi Code.

This file supersedes `HARNESS_INTEGRATION_PLAN.md`, including its completed
phases, line estimates and proposed Phase 9. It is not a feature wishlist: each
phase has a small deliverable, a dependency and a falsifiable exit gate.

## Goal and success measures

Make Harness dependable for long, real coding tasks with the user's own model
provider, without weakening the app's local trust boundary. The target is not
feature-count parity with another product or a presumed task-success score.

Judge the upgrade with measurements, in this order:

1. **Safe execution:** no unapproved execution of repository-supplied commands,
   no silent permission widening, and no secret exposure.
2. **Task continuity:** long threads survive context pressure, interruption,
   restart and provider failure without losing evidence or repeating uncertain
   side effects.
3. **Provider reliability:** supported models behave consistently across the
   two wire families, with explicit limits where they cannot.
4. **Verified effectiveness:** a fixed, same-model task suite measures completed
   work, regressions, unsafe actions, cost and latency against a recorded
   baseline and any available comparison harness.
5. **Usable control:** the user can understand, approve, stop, recover and
   inspect agent work. Existing UI conventions remain in force.

Do not assign a numerical improvement target until Phase 1 establishes a
baseline. A feature landing is not evidence of improved task success.

## Current foundation

These are inputs to this plan, not work to repeat:

- A streaming model/tool loop with bounded steps, steering, queueing,
  cancellation, bounded retries and provider failure codes.
- Workspace-confined file tools, exact-match edits, bounded shell capture,
  pageable results, saved oversized output and fail-closed parallel scheduling.
- Typed tool results separated into model output, canonical value and UI
  presentation.
- Pre-approval validation, subject-scoped thread grants, read-only command
  classification, deny-only danger guards and an OS write sandbox on macOS.
- Durable JSONL sessions, repair of interrupted tool calls and native per-turn
  file snapshots.
- An internal extension registry, skills, MCP with deferred tools and atomic
  generation replacement, structured questions, Plan review and usage events.
- Depth-limited delegated child sessions with narrowed tools and inherited
  permissions.
- A working-tree request-fitting change in `harness/context.ts` and its tests.
  This is a **baseline to verify**, not a completed or released phase.

## Rules for every phase

- Read `AGENT_GUIDE.md`, `ARCHITECTURE.md`, `DECISIONS.md` and the existing
  implementation before changing behavior. Follow `DESIGN_SYSTEM.md` for UI.
- The renderer remains untrusted. New bridge methods need an allowlist entry,
  strict native DTO, session/grant authorization and a preview mock. OS access
  stays behind native, grant-bound commands.
- Keep one tool registry, one permission pipeline and one harness session
  store. Extend the current model rather than adding a parallel runtime.
- Do not simulate agent output, reasoning, approvals or test success.
- Start with a failing regression test for a defect. Test behavior at the
  lowest appropriate layer; add DOM and native tests when those layers change.
- Keep schema changes explicit and recoverable. Existing threads must remain
  readable, and an interrupted write must not silently discard history.
- Redact prompts, tool arguments, output, credentials and local paths as
  appropriate in diagnostics and benchmark reports. Never commit API keys,
  private repositories or raw provider responses containing sensitive data.
- Each work item below starts unchecked. Check it only when its implementation
  and evidence exist. `done` means the exit gate and `npm run verify` passed on
  the exact change set; record remaining manual/live checks separately.
- Do not run the Node and native suites concurrently. Do not claim a live
  provider, sandbox or desktop check that ran only against a stub or mock.

## Delivery rules

- Phases 0–2 are sequential release gates. Later phases use the dependencies
  below; do not start breadth work to avoid fixing an open correctness issue.
- A phase is a vertical slice, not a requirement to change every named file.
  Split a phase into reviewed changes without weakening its exit gate.
- Every phase ends with `npm run verify`, a short evidence note in the relevant
  changelog/decision document, and an update to this file's status table.
- A sandbox-dependent test must report **passed**, **failed**, or **skipped for
  a stated environment reason**. A nested-sandbox denial is not a product pass.
- Keep changes compatible with Muse and ACP unless a capability is explicitly
  Harness-only. Do not expose unsupported Harness actions in shared controls.

## Status

| Phase | Outcome | Status |
|---|---|---|
| 0 | Trust boundary and known correctness gaps closed | todo |
| 1 | Repeatable live conformance and task-quality baseline | todo |
| 2 | Context pressure handled with bounded, honest compaction | todo |
| 3 | Interrupted work recovered without unsafe replay | todo |
| 4 | Provider capabilities and compatibility made explicit | todo |
| 5 | Harness thread lifecycle reaches supported app parity | todo |
| 6 | Measured extensibility and delegation improvements | todo |
| 7 | Release evidence and sustained performance gates | todo |

---

## Phase 0 — Close trust and correctness gaps

**Status:** todo · **Depends on:** current baseline · **Gate for:** every later
phase.

Make the existing harness safe to exercise broadly before adding more model or
tool capability.

- [ ] **0.1 Gate workspace MCP startup on trust.** Do not launch a command or
      contact a server merely because a newly opened repository contains
      `.glitter/mcp.json`. Reuse the existing workspace-trust concept, but make
      the server configuration and its behavior visible before consent. Home
      configuration explicitly added by the user must not require redundant
      approval on every turn.
- [ ] **0.2 Bind MCP consent to the effective configuration.** A changed
      command, executable identity, argument, URL or authority-relevant
      environment/header configuration requires review. A revoke must take
      effect on the next sync and stop the affected generation when no active
      turn still uses it. Do not persist secrets in a consent record.
- [ ] **0.3 Preserve atomic MCP synchronization.** A pending or denied server
      cannot partially join a generation; a replaced server must not silently
      retain the old server's authority under the same approval. Apply the
      existing tool-call permission policy after startup consent; neither check
      replaces the other.
- [ ] **0.4 Add adversarial boundary coverage.** Prove that a rejected or
      unreviewed workspace configuration starts no process and sends no request.
      Cover server initialization side effects, configuration changes,
      revocation, cancellation, symlink/path escape, secret scrubbing and
      malicious or oversized protocol traffic. Bound MCP input buffers and
      response bodies before buffering them, not only tool text afterwards.
- [ ] **0.5 Fix context-fit failure semantics.** A failed fit must not report
      that history was shortened to fit. Separate `fitted`, `unfittable` and
      `unknown window` outcomes; preserve the full transcript and give the user
      and model a truthful recovery path. Do not claim that unknown windows
      were fitted.
- [ ] **0.6 Test current context and provider changes in an unsandboxed macOS
      development environment.** Run the existing shell and MCP integration
      tests as first-class sandbox processes and record any environment skips.
      Resolve reproducible product failures before continuing.

**Primary surfaces:** `harness/mcp.ts`, `harness/context.ts`, `harness/host.ts`,
`packages/glitter-bridge/src/isolation.ts` only if actually needed, the existing
native workspace trust/grant boundary, `lib.rs`, `dto.rs`, `store.ts`, the
existing trust and MCP UI, and `tests/harness.test.mjs` /
`tests/isolation.test.mjs`. Prefer extending `isolation.ts`; do not create
another sandbox implementation.

**Verification:**

- A fixture repository whose MCP configuration would create a marker file and
  make a local HTTP request produces neither effect before consent.
- Configuration changes and revocation are tested, including an in-flight turn
  and a failed replacement generation.
- Regression tests cover truthful fit outcomes, oversized MCP frames/responses,
  and approval denial during startup and tool use.
- Native tests prove renderer-supplied paths or configuration cannot bypass the
  trust decision. UI tests cover pending, changed, denied and revoked states.
- `npm run verify` passes. The macOS sandbox integration check is named
  separately from stubbed tests.

**Exit gate:** opening and using an untrusted repository cannot silently start
its MCP commands or contact its configured servers, and no current context-fit
failure is presented as a successful fit.

---

## Phase 1 — Establish live evidence before tuning

**Status:** todo · **Depends on:** Phase 0 · **Gate for:** quality claims and
Phase 2 tradeoffs.

Add repeatable evidence without introducing a hosted service, committed secrets
or an always-on paid CI suite.

- [ ] **1.1 Define a provider conformance contract.** A small matrix covers
      model listing, text and reasoning streaming, parallel tool calls,
      malformed/truncated calls, cancellation, idle streams, retries, usage and
      context overflow. Report unsupported capabilities explicitly instead of
      converting them into false passes.
- [ ] **1.2 Add an opt-in live smoke runner.** Reuse the real `HarnessHost` and
      a temporary fixture workspace. Select providers/models explicitly, obtain
      credentials through the existing keychain path or a documented local-only
      test injection, cap calls/cost/time, redact results and never run against
      the user's real repository by default.
- [ ] **1.3 Add a small versioned coding-task corpus.** Include bug repair,
      cross-file editing, test-driven change, ambiguous instruction/question,
      refusal of a dangerous action, recovery after a tool failure and a long
      tool-output task. Each task has a clean fixture, a bounded budget and
      executable assertions. Do not fetch arbitrary repository code at test time.
- [ ] **1.4 Score behavior, not prose.** Record tests passed, required edits,
      unintended changes, unsafe actions, turns/tool calls, provider tokens,
      elapsed time, cost when known, interruptions and unrecovered errors. Keep
      raw evidence local by default; commit only sanitized task definitions and
      aggregate baselines.
- [ ] **1.5 Record a reproducible baseline.** Fix the model, reasoning effort,
      provider, harness revision, task revision and budget for each run. Use
      repeated samples for noisy comparisons. Where a comparison harness is
      available, give it the same model, workspace, permissions and task budget;
      otherwise report no ranking.
- [ ] **1.6 Put deterministic coverage in CI and live coverage behind explicit
      invocation.** No network or secret is required for `npm run verify`.
      Document how maintainers run the live suite and how a release records its
      result.

**Primary surfaces:** new focused scripts/tests, `tests/fixtures`,
`harness/host.ts`, `harness/wire.ts`, existing usage events, `DEVELOPMENT.md`
and CI only for deterministic checks. Do not build a telemetry backend.

**Verification:** the runner is tested against stubs for bounds and redaction;
a maintainer performs at least one authenticated Anthropic and one OpenAI-family
run, or records those runs as blocked with a named owner. A baseline artifact
identifies its exact configuration and cannot contain credentials or private
source.

**Exit gate:** a maintainer can run one documented command that produces a
bounded, redacted conformance/quality report, and subsequent phases can compare
against it without inventing success metrics.

---

## Phase 2 — Make long sessions coherent and bounded

**Status:** todo · **Depends on:** Phases 0 and 1.

Extend the current request-fitting work into context management that survives
more than tool-output growth. Keep model history as a projection of the durable
transcript; do not destructively summarize the user's record.

- [ ] **2.1 Introduce one request-budget contract.** Account for system prompts,
      tools, text, reasoning/signatures, images, tool arguments/results,
      provider overhead and a model-appropriate output reserve. Treat estimates
      as estimates and provider usage as accounting truth. An absent output
      limit or window must have a documented conservative fallback.
- [ ] **2.2 Keep cheap deterministic trimming first.** Preserve recent evidence,
      artifact references and explicit elision markers. Do not repeatedly send
      output that is already available through a pageable saved artifact. Keep
      cache implications visible in measurements.
- [ ] **2.3 Add bounded semantic compaction of old conversation spans.** Keep
      the latest user intent, active task, decisions, file edits, commands,
      test results, errors, approvals, unresolved questions and artifact
      references. Preserve the messages needed for valid provider tool-call
      pairing and Anthropic thinking signatures. Never invent successful work.
- [ ] **2.4 Make compaction recoverable and inspectable.** A failed or cancelled
      summarization call leaves the previous usable history intact. Record only
      the durable metadata/projection needed for resume, with schema versioning
      and bounds; do not create a second transcript or silently discard the
      original log. Reuse `compactSession` at the bridge boundary only after its
      Harness routing and semantics are implemented.
- [ ] **2.5 Support manual and automatic paths honestly.** `/compact` must not
      promise an unsupported action. Automatic compaction happens before the
      next model call when needed, has a time/call budget and produces one clear
      notice. If no safe compaction is possible, stop without executing new
      tools and tell the user what remains intact.
- [ ] **2.6 Validate actual coding quality under pressure.** Measure long
      sessions with repeated file reads, large logs, image/tool traffic,
      multiple decisions and errors that must not be forgotten. Compare token
      use, latency, task completion and lost-context failures against Phase 1.

**Primary surfaces:** `harness/context.ts`, `harness/host.ts`,
`harness/store.ts`, `harness/wire.ts`, `index.ts`, the shared compact command,
native DTO/dispatch where required, and existing notices/composer context UI.

**Verification:** fixtures exceed a small model window using conversation text
alone, tool results alone and mixed content; interruption during summarization;
restart after compaction; tool-call/signature validity; malicious text inside a
summary source; and repeated compactions. Tests prove the original transcript
remains readable and no unfinished tool call is lost or replayed.

**Exit gate:** the defined long-session corpus completes within its budget or
fails explicitly without unsafe action, while preserving an inspectable full
transcript and showing a measured improvement over the Phase 1 baseline.

---

## Phase 3 — Recover interrupted work without unsafe replay

**Status:** todo · **Depends on:** Phases 0 and 1; Phase 2 for compacted-history
recovery.

Make restart semantics explicit. Do not build a general workflow engine or a
second durable store.

- [ ] **3.1 Persist a bounded turn/checkpoint record.** Identify the session,
      turn, logical model call, tool call, preparation/approval state, start
      state and committed result. Retain the existing append-only session log
      and native snapshot ownership; add only the metadata needed to reconcile
      an interruption.
- [ ] **3.2 Define replay semantics per tool and per state.** Only explicitly
      declared idempotent built-in reads may be safe to repeat; edits, shell,
      MCP and delegated work are not automatically safe, regardless of whether
      their result looks read-only. A started call with no committed outcome
      stays **outcome unknown** and is inspected before any retry. Never
      auto-approve because a process restarted.
- [ ] **3.3 Reconcile on resume.** Distinguish completed, unstarted, cancelled,
      expired, interrupted and unknown work. Settle pending approvals/questions
      truthfully, close open stream items, preserve model-valid tool pairing and
      surface recovery in the thread. Do not resume a queued or active model
      call invisibly after relaunch.
- [ ] **3.4 Add explicit user continuation.** Let the user inspect the last
      checkpoint and choose a safe next action: continue from known results,
      send a new instruction, or stop. Reuse existing turn snapshots for file
      recovery; chat rewind and file rollback remain separate choices.
- [ ] **3.5 Handle delegation and MCP consistently.** A parent restart cannot
      duplicate a child whose outcome is unknown or silently widen its policy.
      External calls retain their unknown-outcome semantics even if the local
      process has a clean checkpoint.

**Primary surfaces:** `harness/store.ts`, `harness/host.ts`,
`harness/tools.ts`, `harness/delegation.ts`, existing native snapshots,
`index.ts` and existing recovery/timeline UI.

**Verification:** fault injection at every persistence boundary—before model
call, during stream, before/after approval, before tool start, during tool run,
after effect but before result commit, during compaction and during child
execution. Tests cover restart, duplicate resume, cancellation and existing
logs. Native snapshot tests remain sequential with Node tests.

**Exit gate:** no fault-injection case silently repeats a non-idempotent action,
loses a committed tool result or fabricates a successful turn; the user can
recover every interrupted fixture from known evidence.

---

## Phase 4 — Harden provider compatibility and efficiency

**Status:** todo · **Depends on:** Phase 1; Phase 2 for context/output-limit
integration.

Improve the existing two-wire implementation before considering another provider
abstraction. Do not add an SDK or provider framework solely for symmetry.

- [ ] **4.1 Define a capability descriptor per resolved model.** Context and
      output limits, tools, images, reasoning, streaming usage and cache support
      come from catalog evidence, tested family overrides or explicit unknowns.
      Keep provider quirks at the provider/wire boundary rather than scattering
      model-name checks through the loop.
- [ ] **4.2 Build conformance fixtures from sanitized real protocol behavior.**
      Cover text/reasoning ordering, tool-call IDs and argument deltas, empty or
      multiple content blocks, finish reasons, usage variants, malformed SSE,
      early EOF, rate limits and retries. Include models used through gateways,
      not just first-party endpoints.
- [ ] **4.3 Normalize images and unsupported requests before sending.** Enforce
      media type, decoded size, dimensions/count and provider support. Reject
      unsupported combinations before charging for a call where practical;
      preserve the exact approved tool arguments.
- [ ] **4.4 Improve caching and retries with measurements.** Keep stable prompt
      and tool prefixes stable; use only provider-supported cache controls.
      Preserve signed reasoning across tool loops, compaction and provider
      limits. Respect bounded total retry time, cancellation and retry-after
      semantics without replaying uncertain tool effects.
- [ ] **4.5 Report degradation precisely.** A model without tools, images,
      reasoning or a known window gets a truthful capability state. A fallback
      must be visible and must not silently switch provider or model in the
      middle of a turn.

**Primary surfaces:** `harness/providers.ts`, `harness/wire.ts`,
`harness/host.ts`, the context/capability types from Phase 2, provider/model UI
and the Phase 1 conformance suite.

**Verification:** the declared provider/model matrix passes its supported
contract or reports a precise unsupported result. Regression fixtures cover
both wire families and at least one gateway. Report cache/token and latency
changes against the baseline; no claim of universal OpenAI compatibility.

**Exit gate:** the supported matrix is explicit and reproducible, and no silent
fallback changes the user's model, reasoning choice, media content or approval
subject.

---

## Phase 5 — Complete Harness thread lifecycle parity

**Status:** todo · **Depends on:** Phase 2 for compact; Phase 3 for safe recovery
around forks and interrupted operations.

Close gaps where the app's default agent cannot use established thread controls.
Implement only capabilities the harness itself can honor.

- [ ] **5.1 Fork at an explicit conversation boundary.** Clone the canonical
      session records and required metadata into a new session without mutating
      the source. Preserve valid tool pairing, delegated-parent exclusions,
      permissions appropriate to the new thread and original worktree ownership.
      Do not copy active approvals or an uncertain running operation.
- [ ] **5.2 Wire fork, history paging and compact through the existing routes.**
      The shared store, slash commands, timeline and native DTO/session checks
      must agree on Harness support. An unsupported operation stays hidden or
      disabled with an accurate reason; it must not fall through to Muse.
- [ ] **5.3 Keep file changes separate from conversation operations.** Forking
      does not implicitly restore files. Optional reset uses the existing native
      snapshot flow, detects later/conflicting edits and requires the same clear
      confirmation as other destructive recovery.
- [ ] **5.4 Support export and redaction from the canonical Harness log.** Use
      the existing export surface and size bounds; preserve thinking/signatures
      only where the chosen format and privacy mode permit them. A redacted
      export must not include provider keys, MCP secrets or hidden child data
      without an explicit, safe representation.
- [ ] **5.5 Preserve drafts and queued intent across failures.** A failed fork,
      compact or export does not send a message, overwrite the source or drop
      the user's unsent composer text.

**Primary surfaces:** `harness/store.ts`, `harness/host.ts`, `index.ts`,
`lib.rs`, `dto.rs`, `lib/commands.ts`, `lib/store.ts`, `AgentTimeline.tsx`,
existing export/history components and preview mocks.

**Verification:** first-message and later-turn forks, compacted source, source
immutability, concurrent/duplicate requests, restart, file-conflict refusal,
redaction, child-session exclusion, unsupported-agent behavior and accessibility
of changed controls.

**Exit gate:** every lifecycle action exposed for Harness works on its own
canonical history, survives the defined failure cases and never invokes another
agent's implementation.

---

## Phase 6 — Improve extensibility and delegation only where measured

**Status:** todo · **Depends on:** Phases 0–5 for the affected subsystem.

The existing registry, MCP and bounded child sessions are sufficient
foundations. Do not build a general plugin runtime, remote execution system or
multi-agent workflow product by default.

- [ ] **6.1 Publish a narrow internal tool-authoring contract.** Document
      schema/argument validation, canonical results, continuation, concurrency,
      permission subject, timeout, cancellation and replay classification from
      Phase 3. Keep registration in-process and trusted until there is a concrete
      third-party requirement and a separate trust design.
- [ ] **6.2 Profile MCP and prompt overhead.** Measure discovery latency,
      schema tokens, generations, tool-result sizes and shutdown behavior with
      many servers/tools. Optimize deferred discovery or lifecycle only where
      the measurements show a problem; retain all-or-nothing visibility.
- [ ] **6.3 Improve delegated task usefulness before adding parallelism.** Carry
      a bounded objective and relevant artifact references, return evidence and
      failure/cap states, and let the parent inspect the child transcript. Keep
      depth, steps, tool profile, model/cost and total delegation budget capped.
- [ ] **6.4 Add concurrent children only with a demonstrated task-level win.**
      Bound total live descendants and aggregate provider/tool use; define
      cancellation, failure aggregation, approval behavior and workspace write
      conflicts first. Independent read-only exploration is the initial case;
      concurrent writers require an explicit isolation strategy.
- [ ] **6.5 Defer codemode unless a benchmark justifies it.** A model-authored
      program would require a separate execution sandbox, nested permission
      inheritance, deterministic result limits and replay rules. Tool-output
      savings alone are not sufficient evidence.

**Primary surfaces:** `harness/registry.ts`, `harness/mcp.ts`,
`harness/delegation.ts`, `harness/host.ts`, existing child transcript UI and the
Phase 1 measurement suite.

**Verification:** malicious schemas/results, registration conflicts, timeout and
shutdown stress, descendant/cost caps, parent cancellation, child failure,
unknown external outcomes, concurrent read fixtures and a measured comparison
with sequential execution.

**Exit gate:** each accepted improvement has a measured reliability, latency or
context benefit without weakening approval, isolation, recovery or total budget
bounds. Uncalled-for plugin/codemode work remains out of scope.

---

## Phase 7 — Prove sustained production readiness

**Status:** todo · **Depends on:** Phases 0–5; Phase 6 for any new extension or
parallel-delegation behavior.

Turn the preceding work into repeatable release evidence, not a claim that unit
coverage equals real-world reliability.

- [ ] **7.1 Add long-run and resource-bound tests.** Exercise multi-hour-shaped
      histories with accelerated fixtures, repeated MCP reconnects, large
      outputs, many turns/children, cancellation and relaunch. Bound heap,
      buffered protocol bytes, open processes, listeners, artifact retention and
      log growth. Fail on unbounded growth rather than merely measuring it.
- [ ] **7.2 Automate crash/fault and adversarial suites.** Include provider
      hangs, malformed streams, filesystem errors, full quotas, process death,
      revoked grants, changed MCP configuration, malicious tool text and
      repeated stop/resume. Keep secrets and private source out of artifacts.
- [ ] **7.3 Run the release matrix in the packaged macOS app.** Cover trusted
      and untrusted workspaces, sandbox enforcement, provider credentials,
      cancellation, approvals, restart recovery, compaction, fork/export and
      child inspection. Record macOS/version/model/provider and every skip.
- [ ] **7.4 Compare against the frozen quality baseline.** Require no
      correctness or safety regression. Report task success with run counts and
      variability, unsafe-action rate, recovery rate, token/cost and latency.
      Do not cherry-pick successful runs or compare different models as if that
      isolated the harness.
- [ ] **7.5 Update operational documentation.** Document live validation,
      known provider limits, recovery semantics, diagnostics and remaining
      limitations. Record durable architectural choices in `DECISIONS.md` and
      user-visible changes in `CHANGELOG.md`; keep this plan limited to unfinished
      direction and current evidence.

**Primary surfaces:** existing CI and verification scripts, live/benchmark
fixtures, native package checks, `DEVELOPMENT.md`, `RELEASING.md` and release
evidence. Release signing/notarization remains governed by `RELEASING.md`, not
reimplemented as a harness subsystem.

**Verification:** `npm run verify`, deterministic stress/fault suites, packaged
macOS checks and explicitly invoked live runs all have named results. Any paid,
interactive or unavailable check is marked blocked rather than assumed green.

**Exit gate:** the release evidence supports the specific reliability claims
made for Harness, with no open Phase 0 safety gap and no hidden unrun mandatory
check.

---

## Dependency map

```text
0  Trust and correctness
   |
1  Live conformance and quality baseline
   |
2  Long-context coherence
   |
3  Crash/interruption recovery
   |
4  Provider capability and compatibility depth
   |
5  Thread lifecycle parity
   |
6  Measured extensibility and delegation gains
   |
7  Sustained production evidence
```

This is the default delivery order, not permission to serialize independent
investigation. Phases 2–5 may overlap only where their declared dependencies
permit it: Phase 3 may prepare recovery before compaction, Phase 4 needs Phase 2
only for context/output-limit integration, and Phase 5 needs Phases 2 and 3 but
not the whole provider phase. Neither Phase 2 nor Phase 3 ships with broken
recovery. Phase 4 may supply capability data needed by Phase 2 as a small
vertical slice without completing the whole phase. Phase 6 is not required for
a useful release if Phases 0–5 and the relevant Phase 7 gates pass.

## Explicitly out of scope

- Porting ZCode, MiniMax, Codex, Claude Code, Kimi Code or Pi wholesale.
- A second agent runtime, permission engine, session database or UI event model.
- A public third-party plugin runtime before its trust, versioning and cleanup
  contracts are designed and needed.
- Arbitrary background autonomy, unlimited subagents, automatic shell replay or
  invisible paid retries.
- Windows/Linux support, remote workspaces, a hosted control plane, telemetry or
  automatic model selection without an explicit product decision.
- A numerical “beat Codex/CC” target without same-model, same-task evidence.
- Signing, notarization and updater work except where the release checks in
  Phase 7 depend on them; those remain in the existing release roadmap.

## Evidence log

Add a dated entry only when a phase or gate is actually verified. Include the
revision, commands, environment, provider/model matrix where relevant, result
location and any skipped/blocked checks. Do not paste secrets or private source
into this file.

| Date | Phase/gate | Revision and environment | Evidence and remaining gaps |
|---|---|---|---|
| 2026-10-24 | Planning baseline, not completion | Current dirty working tree; macOS review environment | Bridge typecheck passed. Focused harness/isolation run: 128/133 tests passed; all five harness failures hit nested `sandbox-exec` denial, so shell/MCP sandbox behavior remains unverified here. No live-provider or comparative task benchmark was run. |
