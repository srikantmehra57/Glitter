#!/usr/bin/env node
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareReports, formatComparison, scoreTemplate } from "./compare.mjs";
import { CORPUS_SPLITS, TASKS, imagesForTurn, selectTasks, taskSplit, validateCorpus } from "./corpus.mjs";
import { checksSummary, runChecks, setupTask } from "./checks.mjs";
import { buildConfigs, costOf, credentialsFromEnv, loadPrices, missingCredentials, providerBlock } from "./configs.mjs";
import { PRE_ROUTE_CASES, formatPreRouteReport, measurePreRoute, validatePreRouteCases } from "./pre-route.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function usage() {
  console.log(`Orchestrator evaluation runner (opt-in, cost-capped)

Free commands:
  node evals/orchestrator/run.mjs --validate
  node evals/orchestrator/run.mjs --list
  node evals/orchestrator/run.mjs --dry
  node evals/orchestrator/run.mjs --check-host
  node evals/orchestrator/run.mjs --pre-route
  node evals/orchestrator/run.mjs --compare=report1.json,report2.json [--out=DIR]

Live run (requires --yes and provider keys):
  EVAL_LEAD_MODEL=anthropic/claude-sonnet-5 \\
  EVAL_BUILDER_MODEL=deepseek/deepseek-chat \\
  EVAL_SMALL_MODEL=deepseek/deepseek-chat \\
  ANTHROPIC_API_KEY=... DEEPSEEK_API_KEY=... \\
  node evals/orchestrator/run.mjs --configs=orchestrator-balanced,lead-alone --tasks=known-bug,feature --yes

Options:
  --configs=a,b       Configs to run (default: all configured)
  --tasks=a,b         Tasks to run (default: all)
  --split=all|tune|holdout  Task split to run or list (default: all)
  --runs=N            Repetitions per task (default 1)
  --max-usd=N         Stop before a case beyond this estimated spend (default 5)
  --max-tokens=N      Stop before a case beyond this token count (default 5000000)
  --turn-timeout-ms=N Per-turn timeout (default 600000)
  --out=DIR           Live report directory, or comparison.md output for --compare
  --prices=JSON|PATH  Price table, or set EVAL_PRICES
  --tuning=JSON       Internal Orchestrator overrides, e.g. '{"reviewAllComplex":true}'
  --yes               Confirm paid provider calls
  --keep              Keep the temporary workspaces and session logs

The runner never runs under npm run verify.`);
}

function parseArgs(argv) {
  const options = { configs: [], tasks: [], split: "all", compare: [], runs: 1, maxUsd: 5, maxTokens: 5_000_000, turnTimeoutMs: 600_000, out: null, prices: null, tuning: null, yes: false, keep: false, validate: false, dry: false, list: false, checkHost: false, preRoute: false, help: false };
  const number = (raw, label, minimum) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < minimum) throw new Error(`${label} must be a number >= ${minimum}.`);
    return value;
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--validate") options.validate = true;
    else if (arg === "--dry") options.dry = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--check-host") options.checkHost = true;
    else if (arg === "--pre-route") options.preRoute = true;
    else if (arg.startsWith("--compare=")) options.compare = arg.slice(10).split(",").filter(Boolean);
    else if (arg.startsWith("--configs=")) options.configs = arg.slice(10).split(",").filter(Boolean);
    else if (arg.startsWith("--tasks=")) options.tasks = arg.slice(8).split(",").filter(Boolean);
    else if (arg.startsWith("--split=")) {
      options.split = arg.slice(8);
      if (options.split !== "all" && !CORPUS_SPLITS.includes(options.split)) throw new Error(`--split must be all, ${CORPUS_SPLITS.join(" or ")}.`);
    }
    else if (arg.startsWith("--runs=")) options.runs = Math.floor(number(arg.slice(7), "--runs", 1));
    else if (arg.startsWith("--max-usd=")) options.maxUsd = number(arg.slice(10), "--max-usd", 0);
    else if (arg.startsWith("--max-tokens=")) options.maxTokens = Math.floor(number(arg.slice(13), "--max-tokens", 0));
    else if (arg.startsWith("--turn-timeout-ms=")) options.turnTimeoutMs = Math.floor(number(arg.slice(18), "--turn-timeout-ms", 10_000));
    else if (arg.startsWith("--out=")) options.out = arg.slice(6);
    else if (arg.startsWith("--prices=")) options.prices = arg.slice(9);
    else if (arg.startsWith("--tuning=")) options.tuning = arg.slice(9);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function choose(all, names, label) {
  if (!names.length) return all;
  const missing = names.filter((name) => !all.some((entry) => (entry.name ?? entry.id) === name));
  if (missing.length) throw new Error(`Unknown ${label}: ${missing.join(", ")}.`);
  return all.filter((entry) => names.includes(entry.name ?? entry.id));
}

function select(options) {
  const tasks = selectTasks(choose(TASKS, options.tasks, "task"), options.split);
  if (!tasks.length) throw new Error(`No ${options.split === "all" ? "" : `${options.split} `}tasks match.`);
  return tasks;
}

async function loadHost() {
  const dir = await mkdtemp(join(tmpdir(), "glitter-eval-host-"));
  const entry = join(dir, "entry.ts");
  const host = join(ROOT, "packages/glitter-harness/src/harness/host.ts");
  const store = join(ROOT, "packages/glitter-harness/src/harness/store.ts");
  await writeFile(entry, `export { HarnessHost } from ${JSON.stringify(host)};\nexport { SessionStore } from ${JSON.stringify(store)};\n`);
  const outfile = join(dir, "host.mjs");
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
  return { ...(await import(pathToFileURL(outfile).href)), dir };
}

async function loadPolicy() {
  const dir = await mkdtemp(join(tmpdir(), "glitter-eval-policy-"));
  const entry = join(dir, "entry.ts");
  const policy = join(ROOT, "packages/glitter-harness/src/harness/orchestrator/policy.ts");
  await writeFile(entry, `export { preRoute, decideRoute } from ${JSON.stringify(policy)};\n`);
  const outfile = join(dir, "policy.mjs");
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
  return { ...(await import(pathToFileURL(outfile).href)), dir };
}

async function sourceIdentity() {
  const hash = createHash("sha256");
  for (const folder of ["packages/glitter-harness/src", "evals/orchestrator"]) {
    const files = (await readdir(join(ROOT, folder), { recursive: true })).filter((file) => /\.(?:ts|mjs)$/.test(file)).sort();
    for (const file of files) hash.update(`${folder}/${file}\0`).update(await readFile(join(ROOT, folder, file))).update("\0");
  }
  let revision = null;
  let dirty = null;
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
    dirty = Boolean(execFileSync("git", ["status", "--porcelain", "--", "packages/glitter-harness/src", "evals/orchestrator"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim());
  } catch {
    // A source archive can still identify its contents without git metadata.
  }
  return { revision, dirty, sourceSha256: hash.digest("hex"), corpusSha256: createHash("sha256").update(JSON.stringify(TASKS)).digest("hex") };
}

function makeLog() {
  const events = [];
  return {
    events,
    emit: (event, payload) => { events.push({ event, payload, at: Date.now() }); },
    forSession: (sessionId) => events.filter((entry) => entry.payload?.sessionId === sessionId),
    waitFor: async (predicate, timeoutMs, label) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const found = predicate();
        if (found) return found;
        await sleep(50);
      }
      throw new Error(`Timed out ${label} after ${timeoutMs}ms.`);
    },
  };
}

function compactRoute(route) {
  if (!route) return undefined;
  return {
    routeId: route.routeId,
    goal: route.goal,
    shape: route.shape,
    executedShape: route.executedShape,
    executionFallback: route.executionFallback,
    preRouteRule: route.preRouteRule,
    requestedShape: route.requestedShape,
    fallbacks: route.fallbacks,
    stages: route.stages.map((stage) => stage.stage),
    reasonCodes: route.reasonCodes,
    consultCount: route.consultCount,
    reviewCount: route.reviewCount,
    takeovers: route.takeovers,
    references: route.references,
  };
}

function collectRoutes(log, sessionId) {
  const byId = new Map();
  for (const entry of log.forSession(sessionId)) {
    if (entry.event === "route") byId.set(entry.payload.route.routeId, entry.payload.route);
  }
  return [...byId.values()].map(compactRoute);
}

function collectCalls(log, sessionId) {
  return log.forSession(sessionId).filter((entry) => entry.event === "modelCall").map((entry) => entry.payload.call);
}

function collectItems(log, sessionId) {
  return log.forSession(sessionId).filter((entry) => entry.event === "item").map((entry) => entry.payload.item);
}

function finalText(items) {
  const answers = items.filter((item) => item.kind === "agentMessage" && typeof item.text === "string" && item.text.trim());
  return answers.length ? answers[answers.length - 1].text : "";
}

function changedFiles(items) {
  const paths = new Set();
  for (const item of items) {
    if (item.kind === "toolCall" && item.presentation?.path) paths.add(item.presentation.path);
  }
  return [...paths];
}

function outcomeOf(log, sessionId) {
  const completed = log.forSession(sessionId).filter((entry) => entry.event === "turnCompleted");
  return completed.length ? completed[completed.length - 1].payload.outcome : undefined;
}

async function writeReport(dir, report, results) {
  await mkdir(dir, { recursive: true });
  const partialCost = results.some((result) => result.cost?.partial);
  await writeFile(join(dir, "report.json"), `${JSON.stringify({ ...report, partialCost, results }, null, 2)}\n`, "utf8");
  const lines = [
    `# Orchestrator evaluation — ${report.startedAt}`,
    "",
    `Configs: ${report.configs.join(", ") || "none"}`,
    `Tasks: ${report.tasks.join(", ")}`,
    `Split: ${report.split}`,
    `Runs per task: ${report.runs}`,
    `Caps: $${report.maxUsd} · ${report.maxTokens.toLocaleString()} tokens`,
    `Turn timeout: ${report.turnTimeoutMs} ms`,
    `Revision: ${report.source.revision ?? "unavailable"}${report.source.dirty ? " (working tree)" : ""}`,
    `Source SHA-256: ${report.source.sourceSha256}`,
    `Corpus SHA-256: ${report.source.corpusSha256}`,
    `Prices: ${report.priced ? "provided" : "missing (costs are partial)"}`,
    ...(report.stop ? [`Stopped: ${report.stop.reason}`] : []),
    "",
    "## Models",
    "",
    "| Config | Role | Model | Effort |",
    "|---|---|---|---|",
  ];
  for (const [name, config] of Object.entries(report.configurations)) {
    if (config.kind === "manual") lines.push(`| ${name} | manual | ${config.modelId} | ${config.effort} |`);
    else for (const [role, model] of Object.entries(config.models)) lines.push(`| ${name} | ${role} | ${model.modelId} | goal policy; recorded per call |`);
  }
  lines.push(
    "",
    "## Results",
    "",
    "| Config | Split | Task | Run | Result | Checks | Cost | Calls | Notes |",
    "|---|---|---|---:|---|---|---:|---:|---|",
  );
  for (const result of results) {
    const status = result.skipped ? "skipped" : result.error ? "error" : result.success === null ? "manual" : result.success ? "pass" : "fail";
    const cost = result.cost?.partial ? `≈$${result.cost.usd.toFixed(4)} (partial)` : result.cost ? `$${result.cost.usd.toFixed(4)}` : "—";
    const checks = result.checks?.length ? checksSummary(result.checks) : result.checkCount ? `${result.checkCount}` : "—";
    lines.push(`| ${result.config} | ${result.split ?? "tune"} | ${result.task} | ${result.run} | ${status} | ${checks} | ${cost} | ${result.calls?.length ?? 0} | ${(result.error ?? result.reason ?? result.manual ?? "").replaceAll("|", "\\|").slice(0, 120)} |`);
  }
  const byConfig = new Map();
  for (const result of results) {
    if (result.skipped) continue;
    const key = `${result.config} · ${result.split ?? "tune"}`;
    const row = byConfig.get(key) ?? { total: 0, passed: 0, manual: 0, errors: 0, cost: 0, partial: false };
    row.total += 1;
    if (result.success === true) row.passed += 1;
    if (result.success === null) row.manual += 1;
    if (result.error) row.errors += 1;
    row.cost += result.cost?.usd ?? 0;
    row.partial ||= Boolean(result.cost?.partial);
    byConfig.set(key, row);
  }
  lines.push("", "## Summary", "", "| Config · split | Automated pass | Manual | Errors | Estimated cost |", "|---|---:|---:|---:|---:|");
  for (const [config, row] of byConfig) lines.push(`| ${config} | ${row.passed}/${row.total - row.manual} | ${row.manual} | ${row.errors} | ${row.partial ? "partial " : ""}$${row.cost.toFixed(4)} |`);
  const routes = results.flatMap((result) => result.routes ?? []);
  if (routes.length) {
    const preRouted = routes.filter((route) => route.preRouteRule);
    const counts = new Map();
    for (const route of preRouted) counts.set(route.preRouteRule, (counts.get(route.preRouteRule) ?? 0) + 1);
    lines.push("", `Pre-routed turns: ${preRouted.length}/${routes.length}${preRouted.length ? ` · ${[...counts].map(([rule, count]) => `${rule} (${count})`).join(", ")}` : ""}`);
  }
  const manual = results.filter((result) => result.manual && !result.error);
  if (manual.length) {
    lines.push("", "## Manual review", "", "| Config | Task | Run | Prompt | Score (0-2) | Notes |", "|---|---|---:|---|---:|---|");
    for (const result of manual) lines.push(`| ${result.config} | ${result.task} | ${result.run} | ${(result.prompt ?? "").replaceAll("|", "\\|")} |  |  |`);
    lines.push("", "Fill `scores.json` beside this report (score 0-2); `--compare` reads it. The runner does not judge ambiguous work.");
  }
  await writeFile(join(dir, "report.md"), `${lines.join("\n")}\n`, "utf8");
}

async function dryRun(tasks) {
  const errors = validateCorpus(TASKS);
  if (errors.length) throw new Error(errors.join("\n"));
  const root = await mkdtemp(join(tmpdir(), "glitter-eval-dry-"));
  try {
    for (const task of tasks) {
      const workspace = join(root, task.id);
      await mkdir(workspace, { recursive: true });
      await setupTask(workspace, task);
      const checks = await runChecks(workspace, task);
      if (!checks.length) {
        console.log(`${task.id}: manual (${task.manual ?? "no automated checks"})`);
      } else {
        const passed = checks.filter((check) => check.ok).length;
        const expected = checks.length - passed;
        console.log(`${task.id}: ${passed}/${checks.length} checks pass on the untouched fixture${expected ? " (expected: task needs work)" : " — WARNING: fixture already passes"}`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function preRouteRun() {
  const errors = validatePreRouteCases(PRE_ROUTE_CASES);
  if (errors.length) throw new Error(errors.join("\n"));
  const policy = await loadPolicy();
  try {
    const report = measurePreRoute({ preRoute: policy.preRoute, decideRoute: policy.decideRoute });
    console.log(formatPreRouteReport(report));
    if (report.failures.length) {
      console.error("\nMismatches:");
      for (const failure of report.failures) console.error(`- ${failure.id}: expected ${JSON.stringify(failure.expected)}, got ${JSON.stringify(failure.actual)}`);
      process.exitCode = 1;
    }
  } finally {
    await rm(policy.dir, { recursive: true, force: true });
  }
}

async function compareRun(paths, out) {
  const loaded = [];
  const labels = new Map();
  for (const path of paths) {
    const target = resolve(path);
    const info = await stat(target);
    const file = info.isDirectory() ? join(target, "report.json") : target;
    const report = JSON.parse(await readFile(file, "utf8"));
    const raw = basename(file) === "report.json" ? basename(dirname(file)) : basename(file).replace(/\.json$/i, "");
    const scoreFile = basename(file) === "report.json" ? join(dirname(file), "scores.json") : file.replace(/\.json$/i, ".scores.json");
    let scores;
    try {
      scores = JSON.parse(await readFile(scoreFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Could not read ${scoreFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const count = (labels.get(raw) ?? 0) + 1;
    labels.set(raw, count);
    loaded.push({ label: count > 1 ? `${raw} (${count})` : raw, report, ...(scores ? { scores } : {}) });
  }
  const text = formatComparison(compareReports(loaded));
  console.log(text);
  if (out) {
    await mkdir(out, { recursive: true });
    const file = join(out, "comparison.md");
    await writeFile(file, `${text}\n`, "utf8");
    console.log(`\nComparison: ${file}`);
  }
}

async function runLive(options) {
  if (!options.yes) {
    console.error("Live evaluation calls paid providers. Re-run with --yes after checking the cost cap.");
    process.exitCode = 1;
    return;
  }
  const corpusErrors = validateCorpus(TASKS);
  if (corpusErrors.length) throw new Error(corpusErrors.join("\n"));
  const configs = buildConfigs();
  const configNames = choose(Object.entries(configs).map(([name, config]) => ({ name, ...config })), options.configs, "config");
  if (!configNames.length) throw new Error("No configs match. Set EVAL_LEAD_MODEL, EVAL_BUILDER_MODEL and optional EVAL_SMALL_MODEL/EVAL_ROUTER_MODEL.");
  const tasks = select(options);
  const credentials = credentialsFromEnv();
  const missing = missingCredentials(Object.fromEntries(configNames.map((config) => [config.name, config])), credentials);
  if (missing.length) throw new Error(`Missing provider keys for: ${missing.join(", ")}. Local ollama/lmstudio need no key.`);
  if (options.prices) process.env.EVAL_PRICES = options.prices;
  const prices = loadPrices();
  if (!Object.keys(prices).length) console.warn("No prices configured; costs will be marked partial and the token cap is the spend guard.");
  let tuning;
  if (options.tuning) {
    try { tuning = JSON.parse(options.tuning); } catch { throw new Error("--tuning must be a JSON object."); }
    if (!tuning || typeof tuning !== "object" || Array.isArray(tuning)) throw new Error("--tuning must be a JSON object.");
  }
  const hostBundle = await loadHost();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "glitter-eval-work-"));
  const storeRoot = join(workspaceRoot, "sessions");
  const homeDir = join(workspaceRoot, "home");
  await mkdir(storeRoot, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const log = makeLog();
  const host = new hostBundle.HarnessHost(log.emit, new hostBundle.SessionStore(storeRoot), globalThis.fetch, { homeDir, idleMs: 120_000, firstEventMs: 60_000, ...(tuning ? { tuning } : {}) });
  host.setCredentials(credentials);
  const catalog = await host.listModels(undefined, true).catch((error) => {
    console.warn(`Could not load the model catalog; baseline effort will be the provider default: ${error.message}`);
    return null;
  });
  const highestEffort = (modelId) => {
    const model = catalog?.models?.find((entry) => entry.modelId === modelId);
    const efforts = model?.reasoningEfforts ?? [];
    return efforts.length ? efforts[efforts.length - 1] : undefined;
  };
  const startedAt = new Date().toISOString();
  const results = [];
  let spentUsd = 0;
  let spentTokens = 0;
  let partialCost = false;
  let stopReason;
  const outDir = options.out ? options.out : join(ROOT, "evals/orchestrator/reports", startedAt.replaceAll(":", "-").replace(/\.\d+Z$/, "Z"));
  const report = {
    startedAt,
    configs: configNames.map((config) => config.name),
    configurations: Object.fromEntries(configNames.map(({ name, ...config }) => [name, config.kind === "manual" ? { ...config, effort: highestEffort(config.modelId) ?? "provider-default" } : config])),
    source: await sourceIdentity(),
    personalConfiguration: "empty",
    tasks: tasks.map((task) => task.id),
    split: options.split,
    runs: options.runs,
    maxUsd: options.maxUsd,
    maxTokens: options.maxTokens,
    turnTimeoutMs: options.turnTimeoutMs,
    priced: Object.keys(prices).length > 0,
    prices: Object.keys(prices).length ? prices : null,
    tuning: tuning ?? null,
  };
  console.log(`Workspaces: ${workspaceRoot}${options.keep ? " (kept)" : ""}`);
  try {
    for (const config of configNames) {
      for (const task of tasks) {
        for (let run = 1; run <= options.runs; run += 1) {
          if (!stopReason && (spentUsd >= options.maxUsd || spentTokens >= options.maxTokens)) {
            stopReason = "cost cap";
            report.stop = { reason: stopReason };
          }
          if (stopReason) {
            results.push({ config: config.name, split: taskSplit(task), task: task.id, run, skipped: true, reason: stopReason });
            continue;
          }
          const workspace = join(workspaceRoot, `${config.name}-${task.id}-${run}`);
          await mkdir(workspace, { recursive: true });
          await setupTask(workspace, task);
          const started = Date.now();
          let sessionId;
          let error;
          let errorCode;
          let errorStatus;
          let question;
          let firstTurnAt;
          try {
            const manualEffort = config.kind === "manual" ? highestEffort(config.modelId) : undefined;
            const opening = await host.startSession({
              workspaceRoot: workspace,
              ...(config.kind === "manual" ? { modelId: config.modelId, ...(manualEffort ? { effort: manualEffort } : {}) } : { orchestrator: { goal: config.goal, models: config.models } }),
              mode: task.mode ?? "build",
              approvalMode: "allowAll",
            });
            sessionId = opening.sessionId;
            const turns = task.turns ?? [task.prompt];
            firstTurnAt = Date.now();
            let answered = new Set();
            for (let index = 0; index < turns.length; index += 1) {
              const before = log.forSession(sessionId).filter((entry) => entry.event === "turnCompleted").length;
              const images = imagesForTurn(task, index);
              await host.sendTurn({ sessionId, text: turns[index], ...(images ? { images } : {}), ...(task.forcedShape ? { forcedShape: task.forcedShape } : {}) });
              await log.waitFor(() => log.forSession(sessionId).filter((entry) => entry.event === "turnCompleted").length > before, options.turnTimeoutMs, `${task.id} turn ${index + 1}`);
              await sleep(60);
              const inputs = log.forSession(sessionId).filter((entry) => entry.event === "userInputs" && entry.payload.requests?.length).at(-1);
              const request = inputs?.payload.requests?.find((entry) => !answered.has(entry.userInputId));
              if (request) {
                if (request.intent?.kind === "planReview" && task.mode === "plan") {
                  answered.add(request.userInputId);
                  const afterPlan = log.forSession(sessionId).filter((entry) => entry.event === "turnCompleted").length;
                  await host.respondUserInput({ sessionId, userInputId: request.userInputId, response: { action: "answer", answers: [{ questionId: "q1", selectedLabel: "Approve" }] } });
                  await log.waitFor(() => log.forSession(sessionId).filter((entry) => entry.event === "turnCompleted").length > afterPlan, options.turnTimeoutMs, `${task.id} build after plan approval`);
                  await sleep(60);
                } else {
                  if (!task.checks?.length) {
                    // An ambiguous task may legitimately stop for a question.
                    question = request;
                    break;
                  }
                  error = "The model asked a question the corpus cannot answer.";
                  break;
                }
              }
              const outcome = outcomeOf(log, sessionId);
              const terminal = outcome?.params?.terminal;
              if (outcome?.kind === "failed" || terminal === "failed") {
                error = outcome?.params?.error?.message ?? "The turn failed.";
                errorCode = outcome?.params?.error?.code;
                errorStatus = outcome?.params?.error?.status;
                break;
              }
              if (terminal === "cancelled") {
                error = "The turn was cancelled.";
                break;
              }
            }
          } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
            errorCode = typeof caught?.code === "string" ? caught.code : undefined;
            errorStatus = typeof caught?.status === "number" ? caught.status : undefined;
          }
          if (sessionId) await host.closeSession({ sessionId }).catch(() => {});
          const checks = error ? [] : await runChecks(workspace, task);
          const items = sessionId ? collectItems(log, sessionId) : [];
          const calls = sessionId ? collectCalls(log, sessionId) : [];
          const firstEdit = sessionId ? log.forSession(sessionId).find((entry) => entry.event === "item" && entry.payload.item?.kind === "toolCall" && ["edit_file", "write_file", "apply_patch"].includes(entry.payload.item.tool)) : undefined;
          const cost = costOf(calls, prices);
          spentUsd += cost.usd;
          spentTokens += calls.reduce((sum, call) => sum + (call.inputTokens ?? 0) + (call.outputTokens ?? 0), 0);
          partialCost ||= cost.partial;
          const result = {
            config: config.name,
            split: taskSplit(task),
            task: task.id,
            run,
            prompt: task.prompt,
            success: task.checks?.length ? (error ? false : checks.every((check) => check.ok)) : null,
            manual: task.manual,
            checks,
            checkCount: task.checks?.length ?? 0,
            changedFiles: changedFiles(items),
            finalText: finalText(items).slice(0, 8_000),
            ...(question ? { question } : {}),
            routes: sessionId ? collectRoutes(log, sessionId) : [],
            calls: calls.map((call) => ({ modelId: call.modelId, role: call.role, stage: call.stage, effort: call.effort, inputTokens: call.inputTokens, cachedTokens: call.cachedTokens, cacheReadTokens: call.cacheReadTokens, cacheWriteTokens: call.cacheWriteTokens, outputTokens: call.outputTokens, durationMs: call.durationMs })),
            cost,
            error,
            ...(errorCode ? { errorCode } : {}),
            ...(errorStatus != null ? { errorStatus } : {}),
            ...(firstEdit ? { timeToFirstEditMs: Math.max(0, firstEdit.at - (firstTurnAt ?? started)) } : {}),
            durationMs: Date.now() - started,
          };
          results.push(result);
          const block = error ? providerBlock({ code: errorCode, status: errorStatus }) : undefined;
          if (block) {
            stopReason = block;
            report.stop = { reason: block, config: config.name, task: task.id, run, ...(errorCode ? { code: errorCode } : {}), ...(errorStatus != null ? { status: errorStatus } : {}) };
            console.warn(`Stopped: ${block}. Remaining cases will be skipped; retry explicitly after resolving the provider block.`);
            process.exitCode = 1;
          }
          await writeReport(outDir, report, results);
          console.log(`${config.name} · ${task.id} · run ${run}: ${error ? "error" : result.success === null ? "manual" : result.success ? "pass" : "fail"}${error ? ` (${error.slice(0, 120)})` : ""}`);
        }
      }
    }
  } finally {
    await writeReport(outDir, report, results);
    const template = scoreTemplate(results);
    if (template.scores.length) {
      const file = join(outDir, "scores.json");
      const exists = await readFile(file, "utf8").then(() => true, () => false);
      if (!exists) await writeFile(file, `${JSON.stringify(template, null, 2)}\n`, "utf8");
    }
    if (!options.keep) await rm(workspaceRoot, { recursive: true, force: true });
    await rm(hostBundle.dir, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`Report: ${join(outDir, "report.md")}`);
  if (partialCost) console.log("Some calls had no price; the cost totals are partial.");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }
  if (options.validate) {
    const errors = validateCorpus(TASKS);
    if (errors.length) throw new Error(errors.join("\n"));
    const configs = buildConfigs();
    const holdout = TASKS.filter((task) => taskSplit(task) === "holdout").length;
    console.log(`Corpus OK: ${TASKS.length} tasks (${TASKS.reduce((sum, task) => sum + (task.checks?.length ?? 0), 0)} checks; ${TASKS.length - holdout} tune, ${holdout} holdout).`);
    console.log(`Configs from the environment: ${Object.keys(configs).join(", ") || "none (set EVAL_*_MODEL)"}.`);
    return;
  }
  if (options.list) {
    for (const task of select(options)) console.log(`${task.id}\t${task.category}\t${taskSplit(task)}\t${task.checks?.length ?? 0} checks${task.manual ? " + manual" : ""}`);
    console.log("---");
    for (const [name, config] of Object.entries(buildConfigs())) console.log(`${name}\t${config.kind}${config.goal ? `\t${config.goal}` : ""}`);
    return;
  }
  if (options.checkHost) {
    const hostBundle = await loadHost();
    try {
      console.log(`Host bundle OK: ${Object.keys(hostBundle).filter((key) => key !== "dir").join(", ")}`);
    } finally {
      await rm(hostBundle.dir, { recursive: true, force: true });
    }
    return;
  }
  if (options.dry) { await dryRun(select(options)); return; }
  if (options.preRoute) { await preRouteRun(); return; }
  if (options.compare.length) { await compareRun(options.compare, options.out); return; }
  await runLive(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
