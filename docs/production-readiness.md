# Production readiness

Audit of Glitter against a 111-item production-readiness checklist,
done on 2026-10-18 at `d6b4725` (branch `audit/fixes-round-1`). Every item has a
status, its evidence, and the action taken. Re-run this review before the first
public release and whenever the app gains a server, a hosted website, or
telemetry.

**Update 2026-10-20:** the three remaining code gaps were closed — reconciler
single-flight (#35), monotonic bridge clocks (#60), and the diagnostics bundle
(#72). Signing and release engineering are unchanged.

## 1. App profile and assumptions

| Aspect | Finding |
|---|---|
| What it is | A single-user desktop GUI for Meta's `muse` coding-agent CLI (and opt-in ACP agents). The CLI does all agent work; the app is the client. |
| Stack | Rust + Tauri 2 native shell, React 19 + Zustand renderer in the OS webview, Node bridge (bundled Node v26.8.2 sidecar) on `@muse-code/sdk` 1.3.0. Static marketing site in Vite + three.js. |
| Architecture | One process tree per user: renderer → (Tauri IPC) → Rust shell → (NDJSON over stdio) → Node bridge → `muse serve` / ACP agent CLIs. Monolith, no server. |
| Hosting / deploy target | End-user Macs (macOS 13+) as `.app`/`.dmg`. Windows and Linux are out of scope (DECISIONS: "macOS is the only platform"). **No signed or published build exists yet.** The website has no hosting config in the repo. |
| Sync / async | Streaming events from the CLI; bounded in-process queues. No brokers, cron servers, or background workers. |
| External services | `api.meta.ai` (Muse CLI release channel check), `nodejs.org` (build time only), the user's git remotes and `gh` (user-initiated). Model traffic goes through the CLI, not the app. |
| Data stores | One JSON settings document (`glitter.json`), the OS keychain (API key, workspace grants, agent digest pins, ACP consent), a private git object store for per-turn file snapshots, and logs. Session history is owned by the CLI. No database. |
| Auth | The CLI's `muse login` device-code flow, or an API key kept in the keychain. The app has no user accounts. |
| Exposure | User-facing, local only. No listener, no public API, no webhooks, no file uploads to a server, no payments. |
| Scale | One user per install. Load is one person's agent sessions. |
| Sensitivity | High locally: the agent can read and write the user's code and run shell commands, and the keychain holds an API key. That is why the native trust boundary carries most of the weight. |

**Assumptions.** The target is a public desktop release to individual
developers. The website will later be served from a static host or CDN. No
telemetry backend is planned, so the app sends no telemetry today (none is in
the code). Under these assumptions, the server-side items (load balancers,
Kubernetes, databases, queues, WAF) are N/A, and the risk sits in the trust
boundary, local data integrity, supply chain, and release engineering.

**Baseline before changes.** `npm run verify` passed: 609 Node tests, 247 DOM
tests, 169 native tests, a11y 67/67, contrast pass, `npm audit` 0
vulnerabilities, and all builds green. `cargo audit` found 0 vulnerabilities
and 14 warnings. Clippy had 24 warnings (not gated). Evidence for this audit
was saved under `/tmp/prr/` on the audit machine.

## 2. Summary scorecard

| Group | OK | GAP (fixed) | N/A | VERIFY |
|---|---|---|---|---|
| A. Traffic control and edge (8) | 4 | 0 | 4 | 0 |
| B. Build, deploy, release (14) | 4 | 3 (0) | 7 | 0 |
| C. Service resilience (6) | 4 | 0 | 2 | 0 |
| D. Async, messaging, jobs (7) | 1 | 1 (1) | 5 | 0 |
| E. Realtime (3) | 0 | 0 | 3 | 0 |
| F. Data layer (10) | 2 | 0 | 8 | 0 |
| G. Consistency and concurrency (12) | 6 | 2 (2) | 4 | 0 |
| H. Scaling and performance (11) | 4 | 0 | 7 | 0 |
| I. Observability (9) | 1 | 3 (3) | 4 | 1 |
| J. Security (14) | 7 | 0 | 6 | 1 |
| K. Reliability, recovery, cost (6) | 3 | 1 (0) | 2 | 0 |
| L. Networking and protocols (5) | 0 | 0 | 5 | 0 |
| M. API contracts and dependencies (3) | 2 | 1 (1) | 0 | 0 |
| N. Operations and learning (3) | 0 | 3 (3) | 0 | 0 |
| **Total (111)** | **38** | **14 (10)** | **57** | **2** |

GAPs by priority: **P0** 1 (blocked on the owner), **P1** 6 (all fixed),
**P2** 3, **P3** 0.

## 3. Full checklist

Line numbers refer to the tree at the end of this audit. Where code moves
often, the citation names the symbol.

### A. Traffic control and edge

| # | Item | Status | Evidence or reason | Priority | Action taken / plan |
|---|---|---|---|---|---|
| 1 | Rate Limiting | OK | No server endpoints. The only automatic paid call, Smart Suggestions (an LLM turn), is off by default (`suggestionsEnabled: false`, `apps/desktop/src/lib/types.ts:589`), runs one at a time (`suggestInFlight`, `store.ts:2183`), waits at least 60 s between runs and caches results for 15 min (`lib/suggestions.ts:11-13`). The bridge caps each verb's queue at 16 (`HOST_QUEUE_LIMIT`, `isolation.ts:21`) and the shell caps in-flight calls at 512 (`track_pending`, `lib.rs`). | — | — |
| 2 | Caching | OK | Version probe cache (`probe-cache.ts`), suggestion cache keyed by workspace and context signature (`store.ts:677`, `2219`), and the ACP model catalog cache. With one user, a cache key cannot leak another user's data. | — | — |
| 3 | Load Balancing | N/A | One local process tree, no server. | — | — |
| 4 | Reverse Proxies | N/A | No network listener. The equivalent request-size limits are enforced natively: `IPC_BODY_LIMIT` 48 MiB (`lib.rs:4047`), `MAX_FRAME_BYTES` 64 MiB (`framing.rs:4`). | — | — |
| 5 | API Gateways | OK | The Rust shell is the gateway: allowlisted `BRIDGE_METHODS`, 37 `deny_unknown_fields` DTOs (`dto.rs`), grant injection, and oversized IPC bodies rejected before dispatch (`ipc_body_oversized`). | — | — |
| 6 | CDN | N/A | App assets are embedded in the binary. The website has no hosting config in the repo. | — | Revisit when the site is hosted (see §6). |
| 7 | Edge Caching | N/A | Same as #6. | — | Same as #6. |
| 8 | Cache Invalidation | OK | `updateCli` drops the probe cache after a launcher update (`cli-update.ts`). A new agent process invalidates the ACP catalog (ARCHITECTURE.md). The suggestion signature changes with git and file state. Late catalog replies are discarded by `modelVersion` (`store.ts:3947`). | — | — |

### B. Build, deploy, and release

| # | Item | Status | Evidence or reason | Priority | Action taken / plan |
|---|---|---|---|---|---|
| 9 | CI/CD | GAP | CI is strong: a 3-OS matrix runs Node, DOM and native tests, typecheck, version, audit, a11y and contrast gates, then builds an unsigned `.app` and checks the bundle (`.github/workflows/ci.yml`). There is **no signed or notarized release pipeline**: the Developer ID and Authenticode certificates are missing (`docs/RELEASING.md` §0), so Gatekeeper blocks the app on every other Mac. | **P0** (blocked on owner) | Added a RustSec advisory gate (`58c77ba`). Signing needs a paid Apple Developer Program membership and a Windows certificate. Once you have them, add a tag-triggered release job that signs, notarizes, runs `verify-macos-package.mjs`, and uploads artifacts. |
| 10 | Docker | N/A | Desktop app distributed as OS bundles. Nothing runs in containers. | — | — |
| 11 | Kubernetes | N/A | No server workloads. | — | — |
| 12 | Feature Flags | OK | Third-party agents are off by default and need consent (`DEFAULT_ENABLED_AGENTS`, `exec.rs`). Smart Suggestions are opt-in. Contributor mode is tri-state and defaults to the CLI's own preference. No remote flags are needed. | — | — |
| 13 | Blue-Green Deployment | N/A | No server. The desktop equivalent is a staged rollout, which needs an updater (#14). | — | — |
| 14 | Canary Releases | GAP | No update channel exists, so there is no way to ship to a subset of users first. | P2 | Comes with the updater (backlog #1): publish a `beta` feed alongside `stable` in `latest.json`. |
| 15 | Rolling Deployments | N/A | No fleet. | — | — |
| 16 | Rollbacks | GAP | The manual rollback is documented (`RELEASING.md` §6). Data is forward-compatible because settings are normalized on read (`settingsFields`, `settingsPersistence.ts:14`), so an older build reads a newer document. But there is no updater: users must reinstall by hand, and no archive of previous artifacts exists. | P2 | Backlog #1 and #3. |
| 17 | Health Checks | OK | `ensure_bridge` checks whether the child has exited and respawns it on the next request (`lib.rs`). `status`/`ping` verbs exist. The SDK schema fingerprint is compared with the CLI's at handshake and shown in Diagnostics. A 30 s reconciler clears stuck turns (`App.tsx:193`). | — | — |
| 18 | Liveness & Readiness Probes | OK | `bridgeExit`, `hostExit` and `connectionError` events drive UI state (`store.ts:3946`). The window opens before the bridge is ready, and early requests wait on the `ensure_bridge` lock (`run()` setup). | — | — |
| 19 | Infrastructure as Code | N/A | No cloud infrastructure exists. CI and dependency automation are already code (`.github/`). | — | Revisit when the update feed or website gets hosting. |
| 20 | Terraform | N/A | Nothing to provision. | — | — |
| 21 | Helm Charts | N/A | No Kubernetes. | — | — |
| 22 | Build Caching | OK | `setup-node` npm cache plus `Swatinem/rust-cache` (`ci.yml:24-29`). | — | — |

### C. Service resilience

| # | Item | Status | Evidence or reason | Priority | Action taken / plan |
|---|---|---|---|---|---|
| 23 | Service Discovery | N/A | Fixed child processes resolved by path. Executables are canonicalized and digest-pinned (`exec.rs`). | — | — |
| 24 | Circuit Breakers | OK | Fails fast instead of queuing: the per-verb queue limit rejects new calls (`index.ts:244`), a 100 s work ceiling applies (`index.ts:215`), and request deadlines are checked (`index.ts:249`). The app has no automatic retry loops that could hammer a dependency. | — | — |
| 25 | Timeouts | OK | Every outbound call has a bound. Renderer→bridge defaults to 120 s (`bridge.ts:146`). Git network calls use `NETWORK_TIMEOUT` of 120 s (`lib.rs:2161`). Every CLI subprocess goes through `run_bounded` with an explicit 30–900 s timeout and kills its process group on expiry (`lib.rs:3252`). The channel fetch uses `AbortController` (`cli-update.ts:178`). Launcher updates use an `execFile` timeout. Build-time Node downloads now time out at 30 s / 10 min (`058b088`). | — | Download timeouts added in `058b088`. |
| 26 | Retries | OK | The app never retries non-idempotent work on its own. A timeout reports "result is unknown; check before retrying" (`bridge.ts:142`). Model retries belong to the CLI and are surfaced as `turnRetry` (`host.ts:387`). | — | — |
| 27 | Exponential Backoff | N/A | The app has no automatic retry loops. The CLI owns model retry delays (`retryDelayMs`). | — | — |
| 28 | Idempotency | OK | Turn creation is keyed by `sessionId + clientTurnId` (`host.ts:242`). Create calls are deduplicated by `clientRequestId` (`index.ts:286-308`). Retries reuse `pendingTurnKey` (`store.ts:3681-3687`). Fork is single-flight because `session/fork` is not idempotent (`store.ts:1799`). Duplicate in-flight ids are refused (`track_pending`). | — | — |

### D. Async, messaging, and jobs

| # | Item | Status | Evidence or reason | Priority | Action taken / plan |
|---|---|---|---|---|---|
| 29 | Message Queues | N/A | No broker. The in-process queues are bounded (#1). | — | — |
| 30 | Pub/Sub | N/A | One consumer of one event stream (`bridge-line`). | — | — |
| 31 | Event-Driven Architecture | OK | The bridge turns every host's stream into one event vocabulary (`protocol.ts`). Deltas are coalesced per frame (`output.ts`, `tests/delta-batching.test.mjs`). | — | — |
| 32 | Distributed Transactions | N/A | No writes span services. Local multi-step writes are ordered so a failure leaves a safe state: public settings are written before the credential (`settingsPersistence.ts:55-59`), and git mutations run under `git_write_lock`. | — | — |
| 33 | Saga Pattern | N/A | No cross-service workflow. The closest case, a failed `replace` turn, rolls back exactly the state it changed (`store.ts:3689-3691`). | — | — |
| 34 | Dead Letter Queues | N/A | No queue consumers. | — | — |
| 35 | Cron Jobs | GAP → fixed | The 30 s `reconcileRunningThreads` interval (`App.tsx:193`, `store.ts:3648`) had no single-flight guard. On a slow host, runs could overlap. Each run is a read plus an idempotent settle, so the impact was wasted calls, not corruption. | P3 | **Fixed:** the interval shares one in-flight promise (`reconcileRunningThreads`, `store.ts`); a pass still running is reused, and a new pass starts only after it settles. A DOM test covers the shared pass and the next-pass reset. |

### E. Realtime

| # | Item | Status | Evidence or reason | Priority | Action taken / plan |
|---|---|---|---|---|---|
| 36 | WebSockets | N/A | Streaming runs over local stdio NDJSON. Disconnect is detected by EOF, which emits `bridgeExit` (`spawn_bridge_stdio`). | — | — |
| 37 | Long Polling | N/A | Same as #36. | — | — |
| 38 | Server-Sent Events | N/A | Same as #36. | — | — |

### F. Data layer

No database. Persistence is one JSON document, the keychain, and the CLI's own
session store. Revisit #39–46 only if the app ever adds SQLite or a server.

| # | Item | Status | Evidence or reason | Priority | Action taken / plan |
|---|---|---|---|---|---|
| 39 | Database Indexing | N/A | No database. | — | — |
| 40 | Query Optimization | N/A | No database. Git reads are bounded and truncated instead (`DIFF_LIMIT`, `cap_text`). | — | — |
| 41 | N+1 Queries | N/A | No ORM. The reconciler batches session listing per folder, not per thread (`store.ts:3653`). | — | — |
| 42 | Connection Pooling | N/A | No database connections. | — | — |
| 43 | Read Replicas | N/A | No database. | — | — |
| 44 | Sharding | N/A | No database. | — | — |
| 45 | Partitioning | N/A | No database. | — | — |
| 46 | Replication | N/A | No database. | — | — |
| 47 | Database Migrations | OK | Stored data is migrated on read: a legacy plaintext API key moves into the keychain and is then stripped from the document (`settingsPersistence.ts:34-41`). A corrupt store is quarantined and restored from `.bak` (`repair_store_files`, test `a_truncated_store_is_quarantined_and_restored_from_the_backup`). | — | — |
| 48 | Schema Versioning | OK | Settings and session memory are normalized on read (`settingsFields`, `normalizeMemory`). `documentVersion` / `migrateMemory` branch on the stored version. A document newer than `SESSION_MEMORY_VERSION` is loaded for display and `SessionMemoryPersistence.save` refuses to rewrite it. | — | — |

### G. Consistency and concurrency

| # | Item | Status | Evidence or reason | Priority | Action taken / plan |
|---|---|---|---|---|---|
| 49 | Leader Election | N/A | One instance per user, enforced since this audit (#55). | — | — |
| 50 | CAP Theorem | N/A | Single node. The CLI is the source of truth. | — | — |
| 51 | Eventual Consistency | OK | The UI derives from CLI events. The reconciler repairs missed turn ends (`store.ts:3648`). Stale catalog responses are dropped (`modelVersion`). | — | — |
| 52 | Optimistic Locking | N/A | One writer per file once #55 is fixed. Renderer saves are serialized through a promise queue (`settingsPersistence.ts:24-28`). | — | — |
| 53 | Pessimistic Locking | OK | `persist_store_atomic` writes temp → rename and keeps a `.bak` inside a critical section. `git_write_lock` guards mutating git ops (`lib.rs:1295`). A log write lock now serializes rotation and appends (`99c1bf1`). | — | — |
| 54 | Distributed Locks | N/A | Not a distributed system. The process-level guard is #55. | — | — |
| 55 | Race Conditions | GAP → fixed | **Found:** a second app instance loads the grant table once and later rewrites the *whole* table (`persist_grants` → `credentials::grants_store`), and it also rewrites the whole settings document. Last writer wins, so one instance silently dropped workspace access and settings written by the other, while two bridges shared the snapshot store. Windows and Linux start a second instance on a double-click; macOS does with `open -n`. Other races were already handled (duplicate request ids, fork single-flight, grant revocation versus session binding lock order). | P1 | **Fixed:** `tauri-plugin-single-instance` 2.4.1 is registered first, and a second launch focuses the running window (`dc795bd`). Verified on the installed app (§4). |
| 56 | Deadlocks | OK | The lock order grants → sessions is documented and followed (`snoop_bridge_response`, `remove_grant`). Poisoned locks map to errors, not panics. The new log lock holds only filesystem calls. | — | — |
| 57 | Memory Leaks | OK | Long-lived tables are bounded: 512 pending calls, session bindings evict oldest first (`session_order`), snapshots capped at `RECORD_LIMIT` 100 and `FILE_LIMIT` 2000 (`snapshots.rs:11-17`). Listener and PTY leaks were fixed in `2557cc3`/`d6b4725`. Logs are bounded (`99c1bf1`). | — | — |
| 58 | Thread Safety | OK | All shared native state is behind `Mutex` or atomics (`AppState`). JS is single-threaded. A concurrent-write test covers the log (`concurrent_app_log_writes_are_complete_tsv_lines`). | — | — |
| 59 | Network Partitions | OK | Offline, the channel check times out and reports it, git push/pull are bounded, and the CLI's `connectionError` shows a reconnect hint while keeping drafts (`store.ts:3946-3952`). | — | — |
| 60 | Clock Skew | GAP → fixed | The native side uses monotonic `Instant`. The bridge measured request deadlines, suggestion budgets, cache lifetimes and the 10-minute approval expiry with `Date.now()`, so a wall-clock jump (NTP or sleep/wake) could shorten or extend them. The CLI stays authoritative for approvals. | P3 | **Fixed:** the native shell sends a relative request budget and the bridge starts every deadline, suggestion budget and cache TTL from `performance.now()`. Approval enforcement uses a monotonic deadline alongside the wall-clock `expiresAt` the renderer shows; the expiry timer is unchanged. |

### H. Scaling and performance

| # | Item | Status | Evidence or reason | Priority | Action taken / plan |
|---|---|---|---|---|---|
| 61 | Garbage Collection | N/A | No server heap under load. Session memory is bounded (#57), and delta merging cuts allocation churn. | — | — |
| 62 | Backpressure | OK | The stdin write blocks on a full pipe on the blocking pool, never the UI thread (`bridge_request`). Also: queue limit 16, pending cap 512, and a 64 MiB frame cap where an oversized frame is skipped instead of killing the relay (`spawn_bridge_stdio`). Terminal IPC is coalesced (`6649f3b`). | — | — |
| 63 | Autoscaling | N/A | Single-user desktop app. | — | — |
| 64 | Horizontal Scaling | N/A | Single-user desktop app. | — | — |
| 65 | Vertical Scaling | N/A | Single-user desktop app. | — | — |
| 66 | Cold Starts | OK | The window opens before bridge warm-up (`run()` setup comment). Bridge cold start under 5 s is asserted (`tests/cold-start.test.mjs:15`). The Finder cold start is a manual release check (`RELEASING.md` §5). | — | — |
| 67 | Serverless Limits | N/A | No serverless. | — | — |
| 68 | Latency | OK | Streaming deltas merge per animation frame. `tests/bridge-perf.test.mjs` covers the hot path. Vite keeps `@xterm` in its own chunk (`vite.config.ts`). `highlight.js` core and each grammar load on demand. `scripts/check-chunks.mjs` fails the build if the startup script imports either, or if highlight core is inlined into it. Measured after `npm run build:ui`. | — | — |
| 69 | Throughput | OK | One user's sessions. Covered by the perf test above. | — | — |
| 70 | P99 Latency | N/A | No request-serving service. Interactive latency is covered by #66 and #68. | — | — |
| 71 | Tail Latency | N/A | Same as #70. The worst head-of-line wait is bounded by the 100 s work ceiling (`index.ts:205-215`). | — | — |

### I. Observability

| # | Item | Status | Evidence or reason | Priority | Action taken / plan |
|---|---|---|---|---|---|
| 72 | Monitoring | GAP → fixed | No crash or error telemetry (none in the code). This is a privacy-friendly default, but the owner only learned of crashes when a user reported them. | P2 | **Fixed:** Settings → Diagnostics → Copy diagnostics bundles the app version, OS and architecture, CLI version and compatibility, sandbox posture and the last 200 redacted app-log lines. If the log cannot be read, the rest is still copied. Opt-in crash reporting remains a privacy decision. |
| 73 | Logging | GAP → fixed | **Found:** logs were structured (TSV: timestamp, level, event, detail), redacted, and rotated at 2 MiB, but 24 native diagnostics used `eprintln!`, which packaged GUI apps discard. Bridge crash output, keyring failures and git operation records (push, discard-all, grant revoked) were invisible in production. The security audit log grew without bound. | P1 | **Fixed in `99c1bf1`:** `native_log` writes redacted lines to the app log as well as stderr, the audit log rotates at 2 MiB, and writes are serialized. Three tests were added. A `app.second_instance` line from the packaged build shows the routing works (§4). |
| 74 | Distributed Tracing | N/A | One host. A request id ties each call together across renderer → shell → bridge (`bridge.ts`, `track_pending`). | — | — |
| 75 | Metrics | N/A | No service to measure. Settings has Diagnostics and Usage views. | — | — |
| 76 | Alerts | VERIFY | There is no runtime alerting to do. CI failures alert only if GitHub notifications reach the owner. | — | See §6. |
| 77 | SLOs | GAP → fixed | The budgets that exist are now written down. Crash-free sessions stay unmeasured: there is no telemetry. A signed macOS build is still blocked on a Developer ID certificate (#9). | P3 | **Fixed:** `RELEASING.md` "Release SLOs" records bridge cold start (under 5 s, tested), Finder cold start (manual), and reconnect behavior. Crash-free sessions have no number until an opt-in report exists. |
| 78 | SLIs | N/A | Nothing to measure without telemetry. Revisit with #77. | — | — |
| 79 | Error Budgets | N/A | Needs #77 first. | — | — |
| 80 | Observability | OK | Settings → Diagnostics (sandbox, schema compatibility), `open_log_folder`, and a separate security audit log. | — | — |

### J. Security

| # | Item | Status | Evidence or reason | Priority | Action taken / plan |
|---|---|---|---|---|---|
| 81 | Secrets Management | OK | The API key lives in the OS keychain and the renderer only sees a mask (`credentials.rs`, `settingsPersistence.ts:51-54`). I scanned the full git history for AWS, GitHub, OpenAI, Slack, Google and private-key patterns: only test canaries matched (e.g. the AWS documentation key `AKIAIOSFODNN7EXAMPLE`). No `.env` or key files were ever committed. Signing secrets are documented as CI secrets only. Logs are redacted (`redaction.ts`, `redact_log_detail`). | — | — |
| 82 | IAM | OK | The webview gets 12 least-privilege permissions (`capabilities/default.json`). Workspace grants are minted only by the native picker. CI runs with `permissions: contents: read` and SHA-pinned actions. | — | — |
| 83 | OAuth | OK | The CLI runs the `muse login` device-code flow (`login.ts`). The app holds no OAuth tokens. | — | — |
| 84 | JWT Rotation | N/A | The app issues and holds no JWTs. The CLI owns its tokens. | — | — |
| 85 | TLS | OK | Only outbound HTTPS (`api.meta.ai`, `nodejs.org`). No listener. `open_url` allows only http(s) and hands the URL to the system browser (`url_open_allowed` + test). | — | — |
| 86 | Encryption at Rest | VERIFY | Secrets are in the encrypted keychain, and the settings JSON holds none. Snapshots and logs are plaintext under the user profile, with the same sensitivity as the workspace itself. | — | Depends on FileVault/BitLocker on the user's machine (§6). |
| 87 | Encryption in Transit | OK | HTTPS for every network call. IPC and stdio are local. | — | — |
| 88 | WAF | N/A | No server. | — | — |
| 89 | DDoS Protection | N/A | No server. | — | — |
| 90 | CORS | N/A | No HTTP server. The CSP limits `connect-src` to IPC (`tauri.conf.json`). | — | — |
| 91 | CSRF | N/A | No cookie-authenticated server. | — | — |
| 92 | SQL Injection | N/A | No SQL. The equivalent risk, command injection, is handled: processes spawn with argument arrays, user-chosen values sit after `--`, and the editor is a closed list (`editor_choice_is_a_closed_list`). | — | — |
| 93 | XSS | OK | No `dangerouslySetInnerHTML`, `innerHTML =` or `rehype-raw` anywhere in the renderer (searched). React escapes output, and the CSP has `script-src 'self'`. | — | — |
| 94 | SSRF | OK | The app never fetches a user-supplied URL. The channel URL is fixed and the channel name is allowlisted (`cli-update.ts:65-73`). | — | — |

### K. Reliability, recovery, and cost

| # | Item | Status | Evidence or reason | Priority | Action taken / plan |
|---|---|---|---|---|---|
| 95 | Disaster Recovery | GAP | The source is on GitHub. No release artifacts are archived, and future signing keys have no backup plan. | P2 | Backlog #3. |
| 96 | Backups | OK | Settings are written atomically with a `.bak` copy, and a corrupt file is quarantined and restored (`repair_store_files`). Per-turn file snapshots support Undo (`snapshots.rs`). Session history is the CLI's. RPO is the last settings save; RTO is automatic repair on next launch. | — | — |
| 97 | Failover | N/A | Local app. The bridge respawns on the next request after a crash (native e2e test "Bridge crash: the next request respawns the stub"). | — | — |
| 98 | Multi-Region Deployment | N/A | No server. | — | — |
| 99 | Chaos Engineering | OK | Failure-injection tests exist for a bridge crash and respawn, a truncated store, oversized frames, EINTR on reads, and hung handles (CI step timeout). | — | — |
| 100 | Cost Optimization | OK | Paid AI calls are opt-in, throttled, and default to the cheapest model. Logs are now bounded (`99c1bf1`). No cloud spend. CI cost is a 3-OS matrix plus one weekly advisory job. | — | — |

### L. Networking and protocols

| # | Item | Status | Evidence or reason | Priority | Action taken / plan |
|---|---|---|---|---|---|
| 101 | DNS | N/A | No hosted service. Revisit when the website or update feed is hosted. | — | — |
| 102 | TCP vs UDP | N/A | Local pipes and outbound HTTPS only. | — | — |
| 103 | HTTP/2 & HTTP/3 | N/A | No server. Revisit for the website host. | — | — |
| 104 | gRPC | N/A | Not used, and not a fit for a stdio bridge. | — | — |
| 105 | Webhooks | N/A | None incoming or outgoing. | — | — |

### M. API contracts and dependencies

| # | Item | Status | Evidence or reason | Priority | Action taken / plan |
|---|---|---|---|---|---|
| 106 | API Versioning | OK | No public API. The internal protocol ships inside one bundle. The SDK is pinned exactly, and its schema fingerprint is checked against the CLI at handshake (ARCHITECTURE.md). `tests/bridge-parity.test.mjs` keeps the verb sets aligned. | — | — |
| 107 | Semantic Versioning | OK | SemVer with Keep a Changelog (`CHANGELOG.md`). Six manifests are enforced by `npm run check:versions`. | — | — |
| 108 | Dependency Hell | GAP → fixed | Lockfiles are committed. `npm audit` reports 0 vulnerabilities. `cargo audit` reports 0 vulnerabilities and 13 warnings, all transitive through Tauri: unmaintained `unic-*`, `zbus`/`zvariant` and `proc-macro-error`, plus a Linux-only `glib` unsoundness advisory. **Found:** Dependabot covered workflows only, Rust advisories were not gated, one locked crate was yanked, and the shipped Node runtime was verified only against checksums from its own origin. | P1 | **Fixed:** Dependabot for npm and cargo with a 7-day cooldown (`cc8dfb4`), a RustSec CI gate (`58c77ba`), off yanked `yoke-derive` (`5222663`), and in-repo SHA-256 pins for the Node runtime (`058b088`). **Remaining P2:** majors behind (Vite 8, TypeScript 7, plugin-react 6, lucide 1), backlog #4. |

### N. Operations and learning

| # | Item | Status | Evidence or reason | Priority | Action taken / plan |
|---|---|---|---|---|---|
| 109 | Production Incidents | GAP → fixed | There was a release rollback note but no incident runbook and no security reporting path. | P1 | **Fixed:** §7 runbook and `.github/SECURITY.md` (`9df0769`). |
| 110 | On-Call | GAP → fixed | Ownership and escalation weren't written down. | P1 | **Fixed:** §7 names the owner and the routes. Make sure GitHub notifications reach you (§6). |
| 111 | Postmortems | GAP → fixed | No template. | P1 | **Fixed:** §8 template. |

## 4. Fixes made

| Commit | Fix | Why | How it was verified |
|---|---|---|---|
| `99c1bf1` | Native diagnostics go to the app log; the audit log rotates at 2 MiB; log writes are serialized | Packaged builds dropped bridge crash output, keyring failures and git operation records. The audit log was unbounded. | 3 new native tests (rotation, redacted single-line audit entry, 8 threads × 200 lines with no interleaving). Native suite 172/172. The packaged-app log shows `app.second_instance`. |
| `058b088` | Pinned SHA-256 for the six Node runtime archives; download timeouts | Detects a tampered or swapped runtime that would otherwise match its own origin's checksums. A hung download could stall CI. | `npm run build:sidecar` passed. A deliberately wrong pin failed with `Pinned SHA-256 mismatch … refusing to stage`. The staged binary reports `v26.8.2`. |
| `58c77ba` | `advisories` workflow: `cargo audit` on PRs, `main`, weekly | The Rust trust boundary had no vulnerability gate. | `cargo audit` exits 0 locally (0 vulnerabilities, 13 allowed warnings). The YAML parses. |
| `cc8dfb4` | Dependabot for npm and cargo, minor/patch grouped, 7-day cooldown, SDK excluded | Only workflow pins were kept fresh. | The YAML parses. Takes effect on GitHub. |
| `5222663` | `yoke-derive` 0.8.3 → 0.8.4 | 0.8.3 was yanked. | Lockfile diff touches only that crate. The yanked warning is gone from `cargo audit`. |
| `9df0769` | `.github/SECURITY.md` | No private vulnerability reporting path. | Review. |
| `dc795bd` | Single-instance guard (`tauri-plugin-single-instance` 2.4.1, which fits the locked Tauri 2.11.5; 2.5.x would have forced Tauri 2.12 builds only 4 days old) | A second instance overwrote the whole grant table and settings document (lost updates). | See the single-instance evidence below. |
| this file | Audit, runbook, postmortem template | Items #109–111. | — |

**Single-instance evidence** (installed `/Applications/Glitter.app`, built
from `dc795bd`):

```text
open                        → main PID 50614 (+ glitter-node sidecar 50649)
open -n                     → main PID still 50614, no second main process
direct second launch        → exit 0 after 0.07 s (PID 50660)
glitter.log            → 1792309060620  info  app.second_instance  focused the running window
                              1792309071499  info  app.second_instance  focused the running window
```

The plugin source was checked before adoption. It uses a Unix socket on macOS,
D-Bus on Linux and a named mutex on Windows, and adds no webview capability.
The lockfile adds only the plugin: Tauri stays at 2.11.5 and no existing
package changed version. `node scripts/verify-macos-package.mjs` passed on the
rebuilt bundle.

**Final gate** (final tree):

- `npm run verify`: exit 0. 6 manifests agree. Node tests 609/609, DOM tests
  247 in 24 files, a11y 67 components, contrast 380/380 pairs, `npm audit` 0
  vulnerabilities, bridge/UI/website builds green, native tests 172/172 (169
  at baseline plus 3 new logging tests).
- `cargo audit`: exit 0. 0 vulnerabilities and 13 warnings (12 unmaintained, 1
  unsound, 0 yanked), all transitive through Tauri.
- Clippy: 23 warnings, down from 24 at baseline. No new ones.

## 5. Remaining backlog (priority order)

1. **P0, blocked on owner: sign and notarize releases** (#9). Needs an Apple
   Developer ID Application certificate, notarization credentials, and a Windows
   Authenticode certificate. These are paid, so it's your call. Then add a
   tag-triggered `release.yml` that imports the certificate from secrets, runs
   `npm run build` with `APPLE_*` set, runs `verify-macos-package.mjs`, staples,
   and uploads the `.dmg`/`.msi`.
2. **P2: auto-updater with staged channels** (#14, #16). After #1, add
   `tauri-plugin-updater` (`RELEASING.md` "Adding the auto-updater"). Host
   `latest.json` with `stable` and `beta` feeds, keep the updater key offline
   with a backup, and keep the previous artifact published so a rollback is a
   feed edit.
3. **P2: release artifacts and key backup** (#95, #16). Attach every release's
   artifacts and checksums to a GitHub Release. Store the signing certificate
   and updater private key in a password manager plus one offline copy, and
   write the recovery steps into `RELEASING.md`.
4. **P2: major dependency upgrades** (#108). Done on the dependency side.
   Vite is 8.3.5 (desktop and website), with `@tailwindcss/vite` 4.3.3.
   `@vitejs/plugin-react` is 6.1.2, which drops Babel and transforms JSX
   with Oxc. TypeScript is 7.0.2 in the desktop app and the bridge (`tsc`
   is the native compiler; this repo does not import the TypeScript API).
   `lucide-react` is 1.61.0. Lucide 1 removes brand icons; this app does
   not use any. A packaged smoke test of the desktop bundle is still open
   and belongs with the release pass in item 1.
5. **P3, done.** Release SLOs are in `RELEASING.md` (#77). Session memory
   branches on `version` and will not downgrade a newer document (#48). The
   startup chunk no longer includes xterm or highlight.js, and
   `scripts/check-chunks.mjs` locks that (#68). CI runs `cargo clippy -- -D warnings`
   on Linux. `stage-sidecar.mjs` verifies `SHASUMS256.txt.asc` against the vendored
   Node release key before it trusts the download.

## 6. Needs verification in production

- [ ] **Secret scanning and push protection** are on for the GitHub repo. It is
      private today (`gh api repos/srikantmehra57/Glitter` reports
      `private: true`, `security_and_analysis: null`), so this needs GitHub
      Advanced Security or a public repo. Check under Settings → Code security.
- [ ] **Private vulnerability reporting** is enabled once the repo is public
      (Settings → Code security).
- [ ] **Dependabot PRs appear** within a week of merging `cc8dfb4` (Insights →
      Dependency graph → Dependabot).
- [ ] **The `advisories` workflow** runs green on GitHub (Actions → advisories →
      Run workflow).
- [ ] **CI failure notifications reach the owner**: GitHub → Settings →
      Notifications → Actions → "Send notifications for failed workflows only".
- [ ] **Gatekeeper on a second Mac**, after signing (`spctl -a -vv "/Applications/Glitter.app"`
      reports `source=Notarized Developer ID`).
- [ ] **Website, once hosted**: HTTPS with HSTS
      (`curl -sI https://<site> | grep -i strict-transport`), long-lived cache
      headers on hashed assets (`curl -sI https://<site>/assets/<file>.js | grep -i cache-control`),
      HTTP/2 (`curl -sI --http2 https://<site> | head -1`), and DNS TTLs
      (`dig +noall +answer <site>`).
- [ ] **Disk encryption on user machines** for snapshot and log data at rest
      (`fdesetup status` on macOS). Document it as a recommendation in the
      README.

## 7. Runbook

**Owner and escalation.** The repository maintainer
([@srikantmehra57](https://github.com/srikantmehra57)) owns releases and
incidents. Issues come in through GitHub Issues. Security reports follow
`.github/SECURITY.md`. There is no second on-call person: when the owner is
unavailable, nothing ships.

**Build and install (current, unsigned).**

```bash
npm run verify                     # every gate, serially
npm run build                      # .app in apps/desktop/src-tauri/target/release/bundle/macos/
node scripts/verify-macos-package.mjs
```

Then follow AGENTS.md: quit Glitter, move `/Applications/Glitter.app` to
the Trash, `ditto` the new bundle into `/Applications`, move the build-folder
bundles to the Trash, and launch the installed copy.

**Release (once signing exists).** Follow `docs/RELEASING.md` §1–6: bump the
versions, move the changelog, run the gates, package, do the manual
pre-flight, then publish.

**Roll back.**

1. Code: `git revert <bad commit>` on `main`, then rebuild. Don't rewrite
   published history.
2. Users: reinstall the previous artifact (§6 of `RELEASING.md`). Settings are
   normalized on read, so an older build opens a newer settings document. The
   grant table and agent pins in the keychain have the same shape across
   versions.
3. If a release corrupted settings, quitting the app and restarting triggers
   `repair_store_files`, which restores `glitter.json.bak`.

**Check health.**

- In the app: Settings → Diagnostics (CLI found, auth, schema compatibility,
  sandbox posture).
- Processes: `pgrep -fl "Glitter.app/Contents/MacOS"` (exactly one) and
  `pgrep -fl glitter-node` (the bridge).
- CLI: `muse --version` and `muse config status`.
- Live probe when a CLI is available: `node scripts/live-muse-smoke.mjs`.

**Find logs.**

| Log | macOS |
|---|---|
| App log (renderer and native events, bridge stderr) | `~/Library/Logs/com.glitter.desktop/glitter.log` (+ `.previous.log`) |
| Security audit (approval decisions) | `~/Library/Logs/com.glitter.desktop/security-audit.log` (+ `.previous.log`) |
| Settings | `~/Library/Application Support/com.glitter.desktop/glitter.json` (+ `.bak`) |

Lines are TSV: `epoch-ms  level  event  detail`. For example,
`rg 'bridge\.|grants\.|pins\.' ~/Library/Logs/com.glitter.desktop/glitter.log`
shows the bridge and keychain history. The log is already redacted, but read it
before attaching it to a public issue.

**Respond to an incident.**

1. **Triage** (first hour). Reproduce on the latest build. Classify it:
   security (a grant escape or credential exposure), data integrity (lost
   settings or grants, a wrong Undo), or availability (the bridge won't
   start). Security issues stay private.
2. **Contain.** If a release is at fault, pull the download link or feed entry
   (once one exists) and post a pinned GitHub issue with a workaround, such as
   disabling third-party agents or Smart Suggestions or reinstalling the
   previous build.
3. **Diagnose.** Collect the reporter's redacted app log, OS, app version and
   `muse --version`. Use `git log`/`git bisect` against the packaged repro.
4. **Fix.** Write a failing test, fix it, run `npm run verify`, package, and
   install-test.
5. **Communicate.** Comment on the issue, add a `CHANGELOG.md` entry under the
   fixed version, and for security issues, publish an advisory after the fix
   ships.
6. **Learn.** Write a postmortem from §8 for anything that reached users or
   lost data, and store it in the issue or PR.

## 8. Postmortem template (blameless)

```markdown
# Postmortem: <short title>

- Date / duration:
- Severity: (security | data integrity | availability | degraded)
- Author:            Reviewed by:

## Impact
Who was affected, how many, what they saw, and any data lost or exposed.

## Timeline (UTC)
- hh:mm detected by …
- hh:mm mitigated by …
- hh:mm resolved by …

## Root cause
The technical chain of events. Describe systems and decisions, not people.

## What went well / what didn't

## Fixes
- Immediate (shipped): commit / release
- Preventive: tests, gates, design changes

## Follow-ups
| Action | Owner | Due | Issue |
|---|---|---|---|
```
