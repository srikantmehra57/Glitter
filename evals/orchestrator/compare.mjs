/**
 * Turn one or more live report.json files into the Phase 3 decision table.
 * It is pure and free: no provider calls, no writes unless the CLI asks for a
 * comparison.md. Costs are partial whenever a hosted call has no price.
 */

import { costOf } from "./configs.mjs";

const KNOWN_ROLES = ["lead", "builder", "small", "router"];
const REVIEW_OUTCOMES = ["pass", "changes-required", "invalid", "unavailable"];
export const SCORE_MIN = 0;
export const SCORE_MAX = 2;

export function scoreKey(result) {
  return `${result.config}\u0000${result.split ?? "tune"}\u0000${result.task}\u0000${result.run}`;
}

/** Validate a manual scores file and key it to the results it names. */
export function normalizeScores(input, label = "scores") {
  if (!input || typeof input !== "object" || input.version !== 1 || !Array.isArray(input.scores)) throw new Error(`${label} must be a version 1 scores file.`);
  const scores = new Map();
  for (const [index, entry] of input.scores.entries()) {
    if (!entry || typeof entry !== "object") throw new Error(`${label} entry ${index} is not an object.`);
    if (typeof entry.config !== "string" || !entry.config.trim()) throw new Error(`${label} entry ${index} has no config.`);
    if (typeof entry.task !== "string" || !entry.task.trim()) throw new Error(`${label} entry ${index} has no task.`);
    if (!Number.isInteger(entry.run) || entry.run < 1) throw new Error(`${label} entry ${index} has an invalid run.`);
    const split = entry.split ?? "tune";
    if (split !== "tune" && split !== "holdout") throw new Error(`${label} entry ${index} has an unknown split.`);
    if (entry.score !== null && (!Number.isInteger(entry.score) || entry.score < SCORE_MIN || entry.score > SCORE_MAX)) throw new Error(`${label} entry ${index} score must be null or ${SCORE_MIN}-${SCORE_MAX}.`);
    if (entry.notes !== undefined && typeof entry.notes !== "string") throw new Error(`${label} entry ${index} notes must be a string.`);
    const config = entry.config.trim();
    const task = entry.task.trim();
    const key = scoreKey({ config, split, task, run: entry.run });
    if (scores.has(key)) throw new Error(`${label} scores ${task} run ${entry.run} more than once.`);
    scores.set(key, { score: entry.score, notes: entry.notes ?? "" });
  }
  return scores;
}

/** A skeleton for a run's manual tasks; the operator fills score and notes. */
export function scoreTemplate(results) {
  return {
    version: 1,
    scores: results.filter((result) => !result.skipped && result.success === null).map((result) => ({
      config: result.config,
      split: result.split ?? "tune",
      task: result.task,
      run: result.run,
      score: null,
      notes: "",
    })),
  };
}

function emptyGroup(config, split) {
  return {
    config,
    split,
    cases: 0,
    automated: 0,
    passed: 0,
    failed: 0,
    manual: 0,
    manualScored: 0,
    manualTotal: 0,
    manualDistribution: { 0: 0, 1: 0, 2: 0 },
    skipped: 0,
    errors: 0,
    costUsd: 0,
    partial: false,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    firstEditTotal: 0,
    firstEditCount: 0,
    routes: 0,
    preRouted: 0,
    consults: 0,
    explicitConsultRoutes: 0,
    autoConsultRoutes: 0,
    takeovers: 0,
    takeoverRoutes: 0,
    planRetries: 0,
    planRejections: 0,
    reviews: Object.fromEntries(REVIEW_OUTCOMES.map((outcome) => [outcome, 0])),
    roleCost: {},
    executionFallbacks: {},
  };
}

function addRoleCost(group, calls, prices) {
  const byRole = new Map();
  for (const call of calls) {
    const role = call.role ?? "manual";
    const bucket = byRole.get(role) ?? [];
    bucket.push(call);
    byRole.set(role, bucket);
  }
  for (const [role, roleCalls] of byRole) {
    const cost = costOf(roleCalls, prices);
    group.roleCost[role] = (group.roleCost[role] ?? 0) + cost.usd;
    group.partial ||= cost.partial;
  }
}

function addRoutes(group, routes) {
  for (const route of routes) {
    group.routes += 1;
    if (route.preRouteRule) group.preRouted += 1;
    group.consults += route.consultCount ?? 0;
    const reasons = route.reasonCodes ?? [];
    if (reasons.includes("consult:explicit")) group.explicitConsultRoutes += 1;
    if (reasons.some((code) => code.startsWith("consult:auto:"))) group.autoConsultRoutes += 1;
    group.takeovers += route.takeovers?.length ?? 0;
    if ((route.takeovers?.length ?? 0) > 0) group.takeoverRoutes += 1;
    if (reasons.includes("plan:retry")) group.planRetries += 1;
    if (reasons.includes("execution:plan-invalid")) group.planRejections += 1;
    for (const outcome of REVIEW_OUTCOMES) {
      if (reasons.includes(`review:${outcome}`)) group.reviews[outcome] += 1;
    }
    if (route.executionFallback) group.executionFallbacks[route.executionFallback] = (group.executionFallbacks[route.executionFallback] ?? 0) + 1;
  }
}

function finalize(group) {
  group.successRate = group.automated ? group.passed / group.automated : null;
  group.costPerSuccess = group.passed ? group.costUsd / group.passed : null;
  group.avgCalls = group.cases ? group.calls / group.cases : 0;
  group.avgDurationMs = group.cases ? group.durationMs / group.cases : 0;
  group.avgTimeToFirstEditMs = group.firstEditCount ? group.firstEditTotal / group.firstEditCount : null;
  group.routerSkipRate = group.routes ? group.preRouted / group.routes : null;
  group.manualAverage = group.manualScored ? group.manualTotal / group.manualScored : null;
  return group;
}

export function summarizeReport(report, label = "report", scores) {
  if (!report || typeof report !== "object" || !Array.isArray(report.results)) throw new Error(`${label} is not an evaluation report with a results list.`);
  const prices = report.prices && typeof report.prices === "object" ? report.prices : {};
  const scoreMap = scores ? (scores instanceof Map ? scores : normalizeScores(scores, `${label} scores`)) : new Map();
  const usedScores = new Set();
  const groups = new Map();
  for (const result of report.results) {
    const key = `${result.config} · ${result.split ?? "tune"}`;
    const group = groups.get(key) ?? emptyGroup(result.config, result.split ?? "tune");
    if (result.skipped) {
      group.skipped += 1;
      groups.set(key, group);
      continue;
    }
    const score = scoreMap.get(scoreKey(result));
    if (score) {
      usedScores.add(scoreKey(result));
      if (result.success !== null) throw new Error(`${label} scores ${result.task} run ${result.run}, but that result is not a manual task.`);
      if (score.score !== null) {
        group.manualScored += 1;
        group.manualTotal += score.score;
        group.manualDistribution[score.score] += 1;
      }
    }
    group.cases += 1;
    if (result.success === true) group.passed += 1;
    else if (result.success === false) group.failed += 1;
    else group.manual += 1;
    group.automated = group.passed + group.failed;
    if (result.error) group.errors += 1;
    group.costUsd += result.cost?.usd ?? 0;
    group.partial ||= Boolean(result.cost?.partial);
    group.inputTokens += (result.calls ?? []).reduce((sum, call) => sum + (call.inputTokens ?? 0), 0);
    group.outputTokens += (result.calls ?? []).reduce((sum, call) => sum + (call.outputTokens ?? 0), 0);
    group.calls += result.calls?.length ?? 0;
    group.durationMs += result.durationMs ?? 0;
    if (Number.isFinite(result.timeToFirstEditMs)) {
      group.firstEditTotal += result.timeToFirstEditMs;
      group.firstEditCount += 1;
    }
    addRoleCost(group, result.calls ?? [], prices);
    addRoutes(group, result.routes ?? []);
    groups.set(key, group);
  }
  for (const key of scoreMap.keys()) {
    if (!usedScores.has(key)) throw new Error(`${label} has a score for a result the report does not contain.`);
  }
  return {
    label,
    startedAt: report.startedAt,
    split: report.split,
    groups: [...groups.values()].map(finalize).sort((left, right) => left.config.localeCompare(right.config) || left.split.localeCompare(right.split)),
  };
}

export function compareReports(reports) {
  if (!Array.isArray(reports) || !reports.length) throw new Error("At least one report is required.");
  return reports.map(({ label, report, scores }) => summarizeReport(report, label, scores));
}

const pct = (value) => value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
const money = (value) => value === null || value === undefined ? "—" : `$${value.toFixed(4)}`;
const duration = (value) => value === null || value === undefined ? "—" : `${Math.round(value)} ms`;
const tokens = (value) => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`;

function roleTotal(summary, role) {
  return summary.groups.reduce((sum, group) => sum + (group.roleCost[role] ?? 0), 0);
}

export function formatComparison(summaries) {
  const lines = [
    "# Orchestrator report comparison",
    "",
    ...summaries.map((summary) => `- **${summary.label}**${summary.startedAt ? ` — started ${summary.startedAt}` : ""}${summary.split ? ` · split ${summary.split}` : ""}`),
    "",
    "## Outcome and cost",
    "",
    "| Report | Config · split | Cases | Automated | Passed | Manual | Manual score | Skipped | Success | Cost | Cost/success | Tokens | Calls | Avg latency | First edit |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const summary of summaries) {
    for (const group of summary.groups) {
      const manualScore = group.manual ? `${group.manualAverage === null ? "—" : `${group.manualAverage.toFixed(1)}/2`} (${group.manualScored}/${group.manual})` : "—";
      lines.push(`| ${summary.label} | ${group.config} · ${group.split} | ${group.cases} | ${group.automated} | ${group.passed} | ${group.manual} | ${manualScore} | ${group.skipped} | ${pct(group.successRate)} | ${money(group.costUsd)}${group.partial ? " (partial)" : ""} | ${money(group.costPerSuccess)} | ${tokens(group.inputTokens + group.outputTokens)} | ${group.calls} | ${duration(group.avgDurationMs)} | ${duration(group.avgTimeToFirstEditMs)} |`);
    }
  }
  lines.push("", "## Routing, consults and review", "", "| Report | Config · split | Router skip | Consult routes (explicit/auto) | Consults | Takeover routes | Plan retries/fallbacks | Reviews pass/changes/invalid/unavailable |", "|---|---|---:|---:|---:|---:|---:|---:|");
  for (const summary of summaries) {
    for (const group of summary.groups) {
      lines.push(`| ${summary.label} | ${group.config} · ${group.split} | ${group.preRouted}/${group.routes} (${pct(group.routerSkipRate)}) | ${group.explicitConsultRoutes}/${group.autoConsultRoutes} | ${group.consults} | ${group.takeoverRoutes} | ${group.planRetries}/${group.planRejections} | ${REVIEW_OUTCOMES.map((outcome) => group.reviews[outcome]).join("/")} |`);
    }
  }
  lines.push("", "## Cost by role", "", "| Report | Lead | Builder | Small-task | Router | Manual run | Other |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const summary of summaries) {
    const known = KNOWN_ROLES.map((role) => money(roleTotal(summary, role)));
    const other = summary.groups.reduce((sum, group) => sum + Object.entries(group.roleCost).filter(([role]) => !KNOWN_ROLES.includes(role) && role !== "manual").reduce((inner, [, value]) => inner + value, 0), 0);
    lines.push(`| ${summary.label} | ${known.join(" | ")} | ${money(roleTotal(summary, "manual"))} | ${money(other)} |`);
  }
  lines.push("", "* Success excludes manual tasks; cost per success is total cost divided by automated passes. Manual score is the mean 0-2 rubric score, with scored/total in parentheses.");
  const partial = summaries.some((summary) => summary.groups.some((group) => group.partial));
  if (partial) lines.push("* Costs are partial because at least one hosted model has no price; the report's token cap still applies.");
  return lines.join("\n");
}
