#!/usr/bin/env node
import { build } from "esbuild";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { credentialsFromEnv, isLocalProvider, loadPrices, providerOf } from "../orchestrator/configs.mjs";
import { runChecks, setupTask } from "../orchestrator/checks.mjs";
import { createBudgetedFetch } from "./budget.mjs";
import { CONFORMANCE_IDS, conformanceReport } from "./conformance.mjs";
import { createObserver, evaluationGuard, runCase } from "./core.mjs";
import { HARNESS_TASKS, validateHarnessCorpus } from "./corpus.mjs";
import { completedTap } from "./assertions.mjs";
import { runProtocolProbes } from "./probes.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function optionsOf(args) {
  const options = { validate: false, list: false, dry: false, probes: false, help: false, yes: false, model: "", effort: "", tasks: [], unsupported: [], runs: 1, maxCalls: 24, maxTokens: 1_000_000, maxUsd: 1, outputTokens: 2048, timeoutMs: 60_000, totalMs: 600_000, out: "" };
  const numbers = { "--runs": "runs", "--max-calls": "maxCalls", "--max-tokens": "maxTokens", "--max-usd": "maxUsd", "--output-tokens": "outputTokens", "--timeout-ms": "timeoutMs", "--total-ms": "totalMs" };
  for (const arg of args) {
    if (arg === "-h") { options.help = true; continue; }
    if (["--validate", "--list", "--dry", "--probes", "--help", "--yes"].includes(arg)) { options[arg.slice(2)] = true; continue; }
    const at = arg.indexOf("=");
    const key = arg.slice(0, at);
    const value = arg.slice(at + 1);
    if (at < 0 || !value) throw new Error("Unknown or incomplete option.");
    if (key in numbers) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || (key !== "--max-usd" && (!Number.isSafeInteger(number) || number < 1))) throw new Error(`Invalid ${key}.`);
      options[numbers[key]] = number;
    } else if (key === "--model") options.model = value;
    else if (key === "--effort") options.effort = value;
    else if (key === "--tasks") options.tasks = value.split(",").filter(Boolean);
    else if (key === "--unsupported") options.unsupported = value.split(",").filter(Boolean);
    else if (key === "--out") options.out = value;
    else throw new Error("Unknown option.");
  }
  if (options.unsupported.some((id) => !CONFORMANCE_IDS.includes(id))) throw new Error("Unknown conformance capability.");
  if (options.runs > 10 || options.maxCalls > 100 || options.outputTokens > 8192 || options.timeoutMs > 300_000 || options.totalMs > 3_600_000) throw new Error("An evaluation limit exceeds its allowed maximum.");
  return options;
}

function selectedTasks(names) {
  if (!names.length) return HARNESS_TASKS;
  const tasks = HARNESS_TASKS.filter((task) => names.includes(task.id));
  if (tasks.length !== new Set(names).size) throw new Error("Unknown task id.");
  return tasks;
}

async function hostBundle() {
  const dir = await mkdtemp(join(tmpdir(), "glitter-harness-eval-host-"));
  const entry = join(dir, "entry.ts");
  const host = join(ROOT, "packages/glitter-harness/src/harness/host.ts");
  const store = join(ROOT, "packages/glitter-harness/src/harness/store.ts");
  const isolation = join(ROOT, "packages/glitter-harness/src/isolation.ts");
  await writeFile(entry, `export { HarnessHost } from ${JSON.stringify(host)};\nexport { SessionStore } from ${JSON.stringify(store)};\nexport { wrapSandboxedCommand, credentialRoots } from ${JSON.stringify(isolation)};\n`);
  const outfile = join(dir, "host.mjs");
  try {
    await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
    return { ...(await import(pathToFileURL(outfile).href)), dir };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function sourceIdentity() {
  const hash = createHash("sha256");
  for (const folder of ["packages/glitter-harness/src", "evals/harness", "evals/orchestrator"]) {
    const files = (await readdir(join(ROOT, folder), { recursive: true })).filter((file) => /\.(?:ts|mjs)$/.test(file) && !String(file).startsWith("reports/")).sort();
    for (const file of files) hash.update(`${folder}/${file}\0`).update(await readFile(join(ROOT, folder, file))).update("\0");
  }
  let revision = null;
  let dirty = null;
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", timeout: 10_000 }).trim();
    dirty = Boolean(execFileSync("git", ["status", "--porcelain", "--", "packages/glitter-harness/src", "evals/harness", "evals/orchestrator"], { cwd: ROOT, encoding: "utf8", timeout: 10_000 }).trim());
  } catch { /* A source archive can still be identified by its hash. */ }
  return { revision, dirty, sourceSha256: hash.digest("hex"), corpusSha256: createHash("sha256").update(JSON.stringify(HARNESS_TASKS)).digest("hex") };
}

function sandboxedChecker(bundle, fixtureScratch, task) {
  return (program, args, options) => {
    if (program !== "node" || JSON.stringify(args) !== JSON.stringify(["--test"])) throw new Error("Unsupported assertion command.");
    const wrapped = bundle.wrapSandboxedCommand(process.execPath, [...args, "--test-reporter=tap"], { extraRoots: [options.cwd], denyReadRoots: bundle.credentialRoots(), network: false });
    if (!wrapped.sandboxed) throw new Error("Sandbox unavailable.");
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: fixtureScratch, LANG: "en_US.UTF-8" };
    const result = spawnSync(wrapped.command, wrapped.args, { ...options, env });
    if (typeof result.stderr === "string" && /sandbox_apply: Operation not permitted/.test(result.stderr)) throw new Error("Sandbox unavailable.");
    if (result.status === 0 && !completedTap(result.stdout, task.expectedTests)) return { ...result, status: 1 };
    return result;
  };
}

async function dry(tasks) {
  const root = await mkdtemp(join(tmpdir(), "glitter-harness-dry-"));
  try {
    for (const task of tasks) {
      const workspace = join(root, task.id);
      await mkdir(workspace, { recursive: true });
      await setupTask(workspace, task);
      const checks = await runChecks(workspace, task);
      const passed = checks.filter((check) => check.ok).length;
      console.log(`${task.id}: ${checks.length ? `${passed}/${checks.length} checks pass before the task` : `observes ${task.observation}`}`);
      if (checks.length && passed === checks.length) process.exitCode = 1;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function live(options, tasks) {
  if (!options.yes) throw new Error("Live runs require --yes.");
  const provider = providerOf(options.model);
  const credentials = credentialsFromEnv();
  if (!isLocalProvider(provider) && !credentials[provider]?.key) throw new Error("No environment credential for the selected provider.");
  const prices = loadPrices();
  const price = prices[options.model] ?? (isLocalProvider(provider) ? { input: 0, output: 0 } : null);
  const deadline = Date.now() + options.totalMs;
  const budget = createBudgetedFetch({ fetchImpl: globalThis.fetch, maxCalls: options.maxCalls, maxTokens: options.maxTokens, maxUsd: options.maxUsd, outputTokens: options.outputTokens, prices: price, deadline });
  const root = await mkdtemp(join(tmpdir(), "glitter-harness-eval-"));
  const bundle = await hostBundle().catch(async (error) => { await rm(root, { recursive: true, force: true }); throw error; });
  try {
  const fixtureHome = join(root, "home");
  const sessions = join(root, "sessions");
  await mkdir(fixtureHome, { recursive: true });
  await mkdir(sessions, { recursive: true });
  const observer = createObserver();
  const host = new bundle.HarnessHost(observer.emit, new bundle.SessionStore(sessions), budget.fetch, { homeDir: fixtureHome, firstEventMs: 30_000, idleMs: 30_000, retryElapsedMs: 10_000 });
  host.setCredentials({ [provider]: credentials[provider] ?? { key: "" } });
  host.registry.register({ id: "evaluation-safety", guards: [evaluationGuard] });
  const report = {
    version: 1, startedAt: new Date().toISOString(), model: options.model, provider, effort: options.effort || "provider-default", runtime: { platform: process.platform, arch: process.arch, node: process.version },
    limits: { maxCalls: options.maxCalls, maxTokens: options.maxTokens, maxUsd: options.maxUsd, outputTokens: options.outputTokens, timeoutMs: options.timeoutMs, totalMs: options.totalMs, price },
    source: await sourceIdentity(), personalConfiguration: "empty", toolPolicy: "confined-file-tools-only", results: [], conformance: [],
  };
  const out = options.out || join(ROOT, "evals/harness/reports", report.startedAt.replaceAll(":", "-").replace(/\.\d+Z$/, "Z"));
  const observed = { listed: false, textDeltas: 0, reasoningDeltas: 0, toolCalls: 0, usageCalls: 0 };
  const writeReport = async () => {
    report.conformance = conformanceReport(observed, options.unsupported);
    report.budget = { ...budget.state };
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  };
  try {
    try {
      const catalog = await host.listModels(undefined, true);
      observed.listed = catalog.models.some((model) => model.modelId === options.model);
    } catch { /* Listing is unobserved, not a pass. */ }
    for (const task of tasks) {
      for (let run = 1; run <= options.runs; run += 1) {
        const remaining = deadline - Date.now();
        if (remaining <= 0 || budget.state.stopped) {
          report.results.push({ task: task.id, category: task.category, run, status: "skipped", reason: remaining <= 0 ? "time-budget" : "request-budget" });
          continue;
        }
        const workspace = join(root, `${task.id}-${run}`);
        await mkdir(workspace, { recursive: true });
        const result = await runCase({ host, observer, workspace, task, modelId: options.model, effort: options.effort, timeoutMs: Math.min(options.timeoutMs, remaining), commandRunner: sandboxedChecker(bundle, fixtureHome, task) });
        if (budget.state.stopped) { result.status = "blocked"; result.reason = budget.state.stopped; }
        report.results.push({ ...result, run });
        for (const key of ["textDeltas", "reasoningDeltas", "toolCalls", "usageCalls"]) observed[key] += result.observed[key];
        await writeReport();
        console.log(`${task.id} run ${run}: ${result.status}`);
      }
    }
  } finally {
    await writeReport();
  }
  console.log(`Sanitized report: ${out}`);
  if (report.results.some((result) => ["fail", "blocked", "skipped"].includes(result.status))) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(bundle.dir, { recursive: true, force: true });
  }
}

async function probes(options) {
  const root = await mkdtemp(join(tmpdir(), "glitter-harness-probes-"));
  const bundle = await hostBundle().catch(async (error) => {
    await rm(root, { recursive: true, force: true });
    throw error;
  });
  try {
    const report = await runProtocolProbes({ HarnessHost: bundle.HarnessHost, SessionStore: bundle.SessionStore, root });
    if (options.out) {
      await mkdir(options.out, { recursive: true });
      await writeFile(join(options.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
    for (const family of report.families) {
      const passed = family.conformance.filter((row) => row.status === "pass").length;
      const failed = family.failures.length ? ` failed: ${family.failures.join(",")}` : "";
      console.log(`${family.id} ${family.wire}: ${passed}/${family.conformance.length}${failed}`);
    }
    if (!report.ok) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(bundle.dir, { recursive: true, force: true });
  }
}

async function main() {
  const options = optionsOf(process.argv.slice(2));
  if (options.help) {
    console.log("Harness evaluation: --validate | --list | --dry | --probes | --yes --model=provider/model\nOptions: --tasks=id,id --runs=N --effort=LEVEL --max-calls=N --max-tokens=N --max-usd=N --output-tokens=N --timeout-ms=N --total-ms=N --unsupported=id,id --out=DIR\n--probes runs scripted protocol checks with no provider. See evals/harness/README.md for credentials, prices and limits.");
    return;
  }
  if (options.probes) {
    await probes(options);
    return;
  }
  const errors = validateHarnessCorpus(HARNESS_TASKS);
  if (errors.length) throw new Error(errors.join("\n"));
  const tasks = selectedTasks(options.tasks);
  if (options.validate) { console.log(`Harness corpus OK: ${HARNESS_TASKS.length} tasks.`); return; }
  if (options.list) { for (const task of tasks) console.log(`${task.id}\t${task.category}\t${task.observation}`); return; }
  if (options.dry) { await dry(tasks); return; }
  await live(options, tasks);
}

main().catch((error) => {
  // Never print provider errors, which can contain response bodies or credentials.
  const message = error instanceof Error && error.message.startsWith("Model id must") ? "Select a model as provider/model." : error instanceof Error && error.message.startsWith("Protocol probes") ? error.message : error instanceof Error && /^(Live runs require|No environment credential|A non-negative|Invalid evaluation budget|Unknown|Invalid --|An evaluation limit)/.test(error.message) ? error.message : "Harness evaluation could not start or finish; check the local configuration and limits.";
  console.error(message);
  process.exitCode = 1;
});
