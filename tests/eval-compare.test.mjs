import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareReports, formatComparison, normalizeScores, scoreTemplate, summarizeReport } from "../evals/orchestrator/compare.mjs";

const prices = { "anthropic/lead": { input: 3, output: 15 }, "deepseek/build": { input: 0.3, output: 1.2 } };
const call = (role, modelId, inputTokens = 1_000_000) => ({ modelId, role, inputTokens, outputTokens: 0 });
const route = (reasonCodes, extra = {}) => ({ reasonCodes, consultCount: 0, reviewCount: 0, takeovers: [], fallbacks: [], ...extra });
const passResult = {
  config: "orchestrator-balanced",
  split: "holdout",
  task: "a",
  run: 1,
  success: true,
  cost: { usd: 3.3, partial: false },
  calls: [call("lead", "anthropic/lead"), call("builder", "deepseek/build")],
  routes: [route(["consult:auto:check-failed-twice", "review:pass"], { preRouteRule: "pre-route:exact-small-change", consultCount: 1 })],
  durationMs: 1000,
  timeToFirstEditMs: 400,
};
const manualResult = { ...passResult, task: "b", success: null, cost: { usd: 3, partial: false }, calls: [call("lead", "anthropic/lead")], routes: [], timeToFirstEditMs: undefined };
const failResult = {
  ...passResult,
  task: "c",
  success: false,
  cost: { usd: 0.3, partial: false },
  calls: [call("builder", "deepseek/build")],
  routes: [route(["consult:explicit", "review:changes-required", "plan:retry", "execution:plan-invalid"], { consultCount: 1, takeovers: ["builder:step-limit"] })],
  durationMs: 2000,
  timeToFirstEditMs: undefined,
  error: "The turn failed.",
};
const report = { startedAt: "2026-10-29T00:00:00.000Z", split: "holdout", prices, results: [passResult, manualResult, failResult] };

test("a report summary separates outcomes, cost, routing and review", () => {
  const summary = summarizeReport(report, "A");
  assert.equal(summary.label, "A");
  const group = summary.groups[0];
  assert.equal(group.cases, 3);
  assert.equal(group.automated, 2);
  assert.equal(group.passed, 1);
  assert.equal(group.failed, 1);
  assert.equal(group.manual, 1);
  assert.equal(group.successRate, 0.5);
  assert.equal(group.costUsd, 6.6);
  assert.equal(group.costPerSuccess, 6.6);
  assert.equal(group.roleCost.lead, 6);
  assert.equal(group.roleCost.builder, 0.6);
  assert.equal(group.avgCalls, 4 / 3);
  assert.equal(group.avgDurationMs, 4000 / 3);
  assert.equal(group.avgTimeToFirstEditMs, 400);
  assert.equal(group.routes, 2);
  assert.equal(group.preRouted, 1);
  assert.equal(group.routerSkipRate, 0.5);
  assert.equal(group.explicitConsultRoutes, 1);
  assert.equal(group.autoConsultRoutes, 1);
  assert.equal(group.consults, 2);
  assert.equal(group.takeoverRoutes, 1);
  assert.equal(group.planRetries, 1);
  assert.equal(group.planRejections, 1);
  assert.deepEqual(group.reviews, { pass: 1, "changes-required": 1, invalid: 0, unavailable: 0 });
  assert.equal(group.partial, false);
});

test("manual scores are validated and averaged into the comparison", () => {
  const scores = { version: 1, scores: [{ config: "orchestrator-balanced", split: "holdout", task: "b", run: 1, score: 2, notes: "clear" }] };
  const summary = summarizeReport(report, "A", scores);
  const group = summary.groups[0];
  assert.equal(group.manual, 1);
  assert.equal(group.manualScored, 1);
  assert.equal(group.manualAverage, 2);
  assert.deepEqual(group.manualDistribution, { 0: 0, 1: 0, 2: 1 });
  const text = formatComparison([summary]);
  assert.match(text, /Manual score/);
  assert.match(text, /2\.0\/2 \(1\/1\)/);
  assert.deepEqual(scoreTemplate(report.results), {
    version: 1,
    scores: [{ config: "orchestrator-balanced", split: "holdout", task: "b", run: 1, score: null, notes: "" }],
  });
  assert.deepEqual(scoreTemplate([{ ...manualResult, error: "Provider rejected the call." }, { ...manualResult, skipped: true }]).scores, [], "provider failures and skipped cases have no response to score");
  assert.throws(() => normalizeScores({ version: 1, scores: [{ config: "orchestrator-balanced", split: "holdout", task: "b", run: 1, score: 3 }] }), /null or 0-2/);
  assert.throws(() => normalizeScores({ version: 1, scores: [
    { config: "orchestrator-balanced", split: "holdout", task: "b", run: 1, score: 1 },
    { config: "orchestrator-balanced", split: "holdout", task: "b", run: 1, score: 2 },
  ] }), /more than once/);
  assert.throws(() => summarizeReport(report, "A", { version: 1, scores: [{ config: "orchestrator-balanced", split: "holdout", task: "a", run: 1, score: 2 }] }), /not a manual task/);
  assert.throws(() => summarizeReport(report, "A", { version: 1, scores: [{ config: "orchestrator-balanced", split: "holdout", task: "missing", run: 1, score: 2 }] }), /does not contain/);
});

test("the comparison renders the decision tables and flags partial costs", () => {
  const text = formatComparison([summarizeReport(report, "A")]);
  assert.match(text, /# Orchestrator report comparison/);
  assert.match(text, /orchestrator-balanced · holdout/);
  assert.match(text, /50%/);
  assert.match(text, /\$6\.6000/);
  assert.match(text, /Cost\/success/);
  assert.match(text, /Router skip/);
  assert.match(text, /Cost by role/);

  const partialReport = { ...report, prices: {}, results: [{ ...passResult, cost: { usd: 0, partial: true }, calls: [call("lead", "unknown/model", 1)] }] };
  const partial = summarizeReport(partialReport, "P");
  assert.equal(partial.groups[0].partial, true);
  assert.match(formatComparison([partial]), /partial/);
});

test("invalid reports are refused", () => {
  assert.throws(() => summarizeReport(null, "x"), /not an evaluation report/);
  assert.throws(() => compareReports([]), /At least one report/);
});

test("comparison tables identify blocked runs and keep errors separate from skips", () => {
  const summary = summarizeReport({ ...report, stop: { reason: "provider rate limit" }, results: [passResult, failResult, { config: passResult.config, split: "holdout", task: "d", run: 1, skipped: true, reason: "provider rate limit" }] }, "blocked");
  assert.equal(summary.groups[0].errors, 1);
  assert.equal(summary.groups[0].skipped, 1);
  assert.equal(summary.groups[0].cases, 2);
  const text = formatComparison([summary]);
  assert.match(text, /blocked\*\* stopped: provider rate limit/);
  assert.match(text, /Errors \| Skipped/);
  assert.match(text, /results are incomplete/);
});

test("the compare command reads report files and writes comparison.md", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "glitter-compare-"));
  const out = join(temporary, "out");
  try {
    const writeReport = async (name, startedAt, scored) => {
      const dir = join(temporary, name);
      await mkdir(dir, { recursive: true });
      const file = join(dir, "report.json");
      await writeFile(file, JSON.stringify({ startedAt, prices, results: [passResult, manualResult] }), "utf8");
      if (scored) await writeFile(join(dir, "scores.json"), JSON.stringify({ version: 1, scores: [{ config: "orchestrator-balanced", split: "holdout", task: "b", run: 1, score: 1, notes: "ok" }] }), "utf8");
      return file;
    };
    const a = await writeReport("run-a", "2026-10-29T00:00:00.000Z", true);
    const b = await writeReport("run-b", "2026-10-29T01:00:00.000Z", false);
    const { stdout } = await promisify(execFile)(process.execPath, ["evals/orchestrator/run.mjs", `--compare=${a},${b}`, `--out=${out}`], { cwd: root });
    assert.match(stdout, /run-a/);
    assert.match(stdout, /run-b/);
    assert.match(stdout, /Cost\/success/);
    assert.match(stdout, /1\.0\/2 \(1\/1\)/, "the sidecar scores.json is loaded");
    const written = await readFile(join(out, "comparison.md"), "utf8");
    assert.match(written, /run-a/);
    assert.match(written, /orchestrator-balanced · holdout/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
