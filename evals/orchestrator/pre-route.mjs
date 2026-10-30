/**
 * Free pre-route measurement matrix. Each case is a prompt envelope plus the
 * rule the current policy should choose, or that the Router must decide.
 * `candidate` marks a rule from 3.5 that still needs corpus evidence; the matrix
 * reports where each case goes today without changing behavior.
 *
 * A case with `expect.finalShape` also checks the floors after `preRoute`, so a
 * new rule cannot quietly lower a shape.
 */

const SHAPES = new Set(["direct-small", "direct-builder", "lead-guided", "lead-only"]);
const GOALS = new Set(["cost", "balanced", "output"]);

export const ALL_CAPABILITIES = Object.freeze({
  lead: ["tools", "vision", "long_context"],
  builder: ["tools", "vision", "long_context"],
  small: ["tools", "vision", "long_context"],
});

export const PRE_ROUTE_CASES = [
  {
    id: "exact-css",
    prompt: "Set color to #fff",
    expect: { decided: true, rule: "pre-route:exact-small-change", finalShape: "direct-small" },
  },
  {
    id: "exact-quoted",
    prompt: "Change `buttonColour` to `buttonColor`",
    expect: { decided: true, rule: "pre-route:exact-small-change", finalShape: "direct-small" },
  },
  {
    id: "exact-selector",
    prompt: "Update .button to .primary-button",
    expect: { decided: true, rule: "pre-route:exact-small-change", finalShape: "direct-small" },
  },
  {
    id: "exact-negative-broad",
    prompt: "Change all `foo` to `bar`",
    expect: { decided: false },
  },
  {
    id: "exact-negative-question",
    prompt: "Why does `foo` fail?",
    expect: { decided: false },
  },
  {
    id: "exact-negative-refactor",
    prompt: "Refactor `foo`",
    expect: { decided: false },
  },
  {
    id: "exact-negative-attachment",
    prompt: "Change `foo` to `bar`",
    attachments: [{ name: "shot.png", mediaType: "image/png" }],
    expect: { decided: false },
  },
  {
    id: "exact-negative-long",
    prompt: `Change \`foo\` to \`bar\` ${"x".repeat(300)}`,
    expect: { decided: false },
  },
  {
    id: "risk-auth",
    prompt: "Fix the auth callback",
    expect: { decided: true, rule: "pre-route:high-risk", finalShape: "lead-guided" },
  },
  {
    id: "risk-migration",
    prompt: "Add a database migration",
    expect: { decided: true, rule: "pre-route:high-risk", finalShape: "lead-guided" },
  },
  {
    id: "risk-drop",
    prompt: "Drop the database records",
    expect: { decided: true, rule: "pre-route:high-risk", finalShape: "lead-guided" },
  },
  {
    id: "risk-output-writes",
    prompt: "Rotate secrets in deployment",
    goal: "output",
    expect: { decided: true, rule: "pre-route:high-risk", finalShape: "lead-only" },
  },
  {
    id: "forced-build",
    prompt: "Implement `formatBytes` in `src/bytes.mjs`.",
    forcedShape: "lead-guided",
    expect: { decided: true, rule: "pre-route:forced-shape", shape: "lead-guided" },
  },
  {
    id: "forced-small-risk",
    prompt: "Fix this auth callback",
    forcedShape: "direct-small",
    expect: { decided: true, rule: "pre-route:forced-shape", shape: "direct-small", finalShape: "lead-guided" },
  },
  {
    id: "continuation-lead",
    prompt: "Also add a test.",
    openTask: { shape: "lead-guided" },
    candidate: "open-plan-continuation",
    expect: { decided: true, rule: "pre-route:continuation", shape: "lead-guided" },
  },
  {
    id: "continuation-small-risk",
    prompt: "Now drop the users table.",
    openTask: { shape: "direct-small" },
    candidate: "open-plan-continuation",
    expect: { decided: true, rule: "pre-route:continuation", shape: "direct-small", finalShape: "lead-guided" },
  },
  {
    id: "continuation-negative",
    prompt: "Also add a test.",
    expect: { decided: false },
  },
  {
    id: "candidate-failing-test",
    prompt: "The test in `test/range.test.mjs` fails. Find the cause and fix it.",
    candidate: "failing-test",
    note: "The exact-small rule currently claims this prompt, so the unknown cause never reaches the Router.",
    expect: { decided: true, rule: "pre-route:exact-small-change", finalShape: "direct-small" },
  },
  {
    id: "candidate-stack-trace",
    prompt: "TypeError: Cannot read properties of undefined\n  at range (src/range.mjs:12)\nFix it.",
    candidate: "failing-test",
    note: "A bare stack trace can be claimed as an exact small change today.",
    expect: { decided: true, rule: "pre-route:exact-small-change", finalShape: "direct-small" },
  },
  {
    id: "candidate-review-reply",
    prompt: "Looks good, proceed.",
    candidate: "review-reply",
    note: "A reply normally arrives with openTask, which the continuation rule handles; this bare prompt needs the Router.",
    expect: { decided: false },
  },
  {
    id: "candidate-review-reply-open-task",
    prompt: "Looks good, proceed.",
    openTask: { shape: "lead-guided" },
    candidate: "review-reply",
    note: "The real reply envelope is already covered by the continuation rule.",
    expect: { decided: true, rule: "pre-route:continuation", shape: "lead-guided" },
  },
  {
    id: "candidate-same-as-before",
    prompt: "Same as before, but for the settings page.",
    candidate: "same-as-before",
    note: "A new prompt with no openTask; the Router must judge the reference.",
    expect: { decided: false },
  },
  {
    id: "candidate-attachment-only",
    prompt: "What should I change here?",
    attachments: [{ name: "shot.png", mediaType: "image/png" }],
    candidate: "attachment-only",
    note: "Attachments block exact-small; the Router decides whether vision changes the route.",
    expect: { decided: false },
  },
];

/** Shape errors that would make the matrix mislead the operator. */
export function validatePreRouteCases(cases = PRE_ROUTE_CASES) {
  const errors = [];
  const ids = new Set();
  for (const entry of cases) {
    if (!entry.id || ids.has(entry.id)) errors.push(`Case ${entry.id ?? "(missing id)"} has a missing or duplicate id.`);
    ids.add(entry.id);
    if (!entry.prompt?.trim()) errors.push(`Case ${entry.id} has no prompt.`);
    if (entry.goal && !GOALS.has(entry.goal)) errors.push(`Case ${entry.id} has an unknown goal: ${entry.goal}`);
    if (entry.forcedShape && !SHAPES.has(entry.forcedShape)) errors.push(`Case ${entry.id} has an unknown forced shape: ${entry.forcedShape}`);
    if (entry.openTask && !SHAPES.has(entry.openTask.shape)) errors.push(`Case ${entry.id} has an unknown open-task shape: ${entry.openTask.shape}`);
    if (entry.candidate !== undefined && !entry.candidate) errors.push(`Case ${entry.id} has an empty candidate label.`);
    if (!entry.expect || typeof entry.expect.decided !== "boolean") errors.push(`Case ${entry.id} has no expected decision.`);
    else if (entry.expect.decided) {
      if (!entry.expect.rule?.startsWith("pre-route:")) errors.push(`Case ${entry.id} expects a decision without a pre-route rule.`);
      if (entry.expect.shape && !SHAPES.has(entry.expect.shape)) errors.push(`Case ${entry.id} expects an unknown shape: ${entry.expect.shape}`);
      if (entry.expect.finalShape && !SHAPES.has(entry.expect.finalShape)) errors.push(`Case ${entry.id} expects an unknown final shape: ${entry.expect.finalShape}`);
      if (!entry.expect.shape && !entry.expect.finalShape) errors.push(`Case ${entry.id} expects a decision without a shape or final shape.`);
    }
  }
  return errors;
}

const shapeOf = (entry) => ({
  ...(entry.forcedShape ? { forcedShape: entry.forcedShape } : {}),
  ...(entry.openTask ? { openTask: entry.openTask } : {}),
  ...(entry.attachments ? { attachments: entry.attachments } : {}),
});

function expectedOf(entry) {
  if (!entry.expect.decided) return { decided: false };
  return { decided: true, rule: entry.expect.rule, shape: entry.expect.shape, ...(entry.expect.finalShape ? { finalShape: entry.expect.finalShape } : {}) };
}

/**
 * Run every case through the current policy. A mismatch is a failure to fix
 * before the matrix is trusted; a candidate case is reported, never asserted.
 */
export function measurePreRoute({ preRoute, decideRoute, cases = PRE_ROUTE_CASES, capabilities = ALL_CAPABILITIES }) {
  const failures = [];
  const byRule = new Map();
  const candidates = [];
  let decided = 0;
  let matched = 0;
  let floors = 0;
  for (const entry of cases) {
    const result = preRoute({ prompt: entry.prompt, ...shapeOf(entry) });
    const actual = result.decided
      ? { decided: true, rule: result.rule, shape: result.shape }
      : { decided: false };
    const expected = expectedOf(entry);
    const rule = result.decided ? result.rule : "router";
    const bucket = byRule.get(rule) ?? { cases: 0, matched: 0 };
    bucket.cases += 1;
    let ok = actual.decided === expected.decided
      && (!actual.decided || (actual.rule === expected.rule && (!expected.shape || actual.shape === expected.shape)));
    let finalShape;
    if (result.decided && decideRoute) {
      const decision = decideRoute({
        goal: entry.goal ?? "balanced",
        roleCapabilities: capabilities,
        preRoute: result,
        reviewAllowed: false,
      });
      finalShape = decision.shape;
      if (entry.expect.finalShape && finalShape !== entry.expect.finalShape) {
        ok = false;
        failures.push({ id: entry.id, expected: `floor ${entry.expect.finalShape}`, actual: `final shape ${finalShape}` });
      }
      if (result.shape && finalShape !== result.shape) floors += 1;
    }
    if (ok) {
      bucket.matched += 1;
      matched += 1;
    } else if (!failures.some((failure) => failure.id === entry.id)) {
      failures.push({ id: entry.id, expected, actual: { ...actual, ...(finalShape ? { finalShape } : {}) } });
    }
    if (result.decided) decided += 1;
    if (entry.candidate) {
      candidates.push({
        id: entry.id,
        candidate: entry.candidate,
        rule,
        ...(entry.note ? { note: entry.note } : {}),
      });
    }
    byRule.set(rule, bucket);
  }
  const total = cases.length;
  return {
    total,
    decided,
    matched,
    accuracy: total ? matched / total : 1,
    routerSkipRate: total ? decided / total : 0,
    floors,
    byRule: [...byRule.entries()].map(([rule, row]) => ({ rule, ...row })).sort((left, right) => left.rule.localeCompare(right.rule)),
    candidates,
    failures,
  };
}

export function formatPreRouteReport(report) {
  const lines = [
    `Pre-route matrix: ${report.total} cases · ${report.decided} decided (${Math.round(report.routerSkipRate * 100)}%) · ${report.total - report.decided} need the Router`,
    `Expectations matched: ${report.matched}/${report.total} · floors raised: ${report.floors}`,
    "",
    "| Rule | Cases | Matched |",
    "|---|---:|---:|",
  ];
  for (const row of report.byRule) lines.push(`| ${row.rule} | ${row.cases} | ${row.matched} |`);
  if (report.candidates.length) {
    lines.push("", "Candidate cases (reported, not asserted):", "", "| Case | Candidate | Today | Note |", "|---|---|---|---|");
    for (const row of report.candidates) lines.push(`| ${row.id} | ${row.candidate} | ${row.rule} | ${row.note ?? ""} |`);
  }
  return lines.join("\n");
}

export const PRE_ROUTE_RULES = Object.freeze([
  "pre-route:forced-shape",
  "pre-route:continuation",
  "pre-route:high-risk",
  "pre-route:exact-small-change",
]);
