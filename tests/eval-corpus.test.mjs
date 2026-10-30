import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CORPUS_IMAGE_TYPES, CORPUS_SPLITS, TASKS, imagesForTurn, selectTasks, taskSplit, validateCorpus } from "../evals/orchestrator/corpus.mjs";
import { runChecks, safeRelative, setupTask } from "../evals/orchestrator/checks.mjs";
import { buildConfigs, costOf, credentialsFromEnv, missingCredentials } from "../evals/orchestrator/configs.mjs";

const task = (id) => TASKS.find((entry) => entry.id === id);

test("the starter corpus is internally consistent", () => {
  assert.deepEqual(validateCorpus(TASKS), []);
  assert.equal(new Set(TASKS.map((entry) => entry.id)).size, TASKS.length);
  assert.ok(TASKS.some((entry) => entry.category === "security"));
});

test("fixtures reject escaping paths", () => {
  assert.equal(safeRelative("src/a.mjs"), true);
  assert.equal(safeRelative("src/../a.mjs"), true);
  assert.equal(safeRelative("../a.mjs"), false);
  assert.equal(safeRelative("src/../../a.mjs"), false);
  assert.equal(safeRelative("/tmp/a.mjs"), false);
  assert.equal(safeRelative("."), false);
});

test("the corpus keeps separate tuning and holdout splits", () => {
  assert.deepEqual(CORPUS_SPLITS, ["tune", "holdout"]);
  const holdout = selectTasks(TASKS, "holdout");
  const tune = selectTasks(TASKS, "tune");
  assert.ok(holdout.length, "the holdout split is not empty");
  assert.ok(tune.length, "the tuning split is not empty");
  assert.ok(holdout.every((entry) => taskSplit(entry) === "holdout"));
  assert.ok(tune.every((entry) => taskSplit(entry) === "tune"));
  assert.ok(holdout.some((entry) => entry.checks?.length), "the holdout has automated tasks");
  assert.ok(tune.some((entry) => entry.checks?.length), "tuning has automated tasks");
  assert.deepEqual(selectTasks(TASKS, "all").map((entry) => entry.id), TASKS.map((entry) => entry.id));
  assert.throws(() => selectTasks(TASKS, "other"), /Unknown task split/);
});

test("the split flag filters the task list", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const run = (...args) => promisify(execFile)(process.execPath, ["evals/orchestrator/run.mjs", ...args], { cwd: root });
  const { stdout: holdout } = await run("--list", "--split=holdout");
  assert.match(holdout, /unknown-cause-bug\tbug\tholdout/);
  assert.doesNotMatch(holdout, /minor-css/);
  const { stdout: tune } = await run("--list", "--split=tune");
  assert.match(tune, /minor-css\tminor\ttune/);
  assert.doesNotMatch(tune, /unknown-cause-bug/);
});

test("the corpus covers the plan's task classes", () => {
  const categories = new Set(TASKS.map((entry) => entry.category));
  for (const category of ["minor", "bug", "feature", "security", "migration", "continuation", "long-thread", "long-context", "plan-mode", "redesign", "vision", "ambiguous"]) {
    assert.ok(categories.has(category), `the corpus needs a ${category} task`);
  }
  assert.ok(TASKS.some((entry) => entry.id === "unknown-cause-bug"), "the unknown-cause floor needs a Router-visible fixture");
  assert.ok(TASKS.some((entry) => entry.id === "major-bug"));
  assert.ok(TASKS.some((entry) => entry.id === "cross-cutting-feature"));
});

test("vision fixtures attach valid image bytes to the first turn", () => {
  const vision = task("vision-swatch");
  assert.ok(vision);
  assert.equal(vision.images.length, 1);
  assert.ok(CORPUS_IMAGE_TYPES.includes(vision.images[0].mediaType));
  assert.deepEqual(imagesForTurn(vision, 0), [{ mediaType: "image/png", base64Data: vision.images[0].base64Data }]);
  assert.equal(imagesForTurn(vision, 1), undefined, "later turns stay text-only");
  assert.equal(imagesForTurn(task("minor-css"), 0), undefined, "a text task attaches nothing");
  const bytes = Buffer.from(vision.images[0].base64Data, "base64");
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "the swatch is a PNG");
  const errors = validateCorpus([...TASKS, { id: "bad-image", prompt: "x", manual: "y", images: [{ name: "", mediaType: "image/svg+xml", base64Data: "!!" }] }]);
  assert.ok(errors.some((error) => error.includes("bad-image")), "invalid image metadata is rejected");
});

test("the long-context fixture buries one codeword in a large prompt", () => {
  const entry = task("long-context");
  assert.ok(entry);
  assert.ok(entry.prompt.length > 50_000, "the prompt is large enough to stress context fitting");
  assert.equal((entry.prompt.match(/ORCHID-42/g) ?? []).length, 1);
  assert.ok(entry.prompt.indexOf("ORCHID-42") > 20_000, "the codeword is buried, not at the start");
});

test("every automated fixture fails on its untouched setup", async () => {
  for (const entry of TASKS.filter((task) => task.checks?.length)) {
    const root = await mkdtemp(join(tmpdir(), `glitter-eval-${entry.id}-`));
    try {
      await setupTask(root, entry);
      const checks = await runChecks(root, entry);
      assert.ok(checks.some((check) => !check.ok), `${entry.id} must need work before the model runs`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

const referenceFixes = {
  "minor-copy": {
    "src/panel.mjs": [
      "export function buttonLabel() {",
      "  return 'Store';",
      "}",
      "",
    ].join("\n"),
  },
  "unknown-cause-bug": {
    "src/price.mjs": [
      "export function applyDiscount(cents, percent) {",
      "  return Math.round(cents * (1 - percent / 100));",
      "}",
      "",
    ].join("\n"),
  },
  "major-bug": {
    "src/cart.mjs": [
      "export function subtotal(items) {",
      "  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);",
      "}",
      "",
    ].join("\n"),
    "src/total.mjs": [
      "import { subtotal } from './cart.mjs';",
      "",
      "export function total(items, rate = 0) {",
      "  return Math.round(subtotal(items) * (1 + rate) * 100) / 100;",
      "}",
      "",
    ].join("\n"),
  },
  "cross-cutting-feature": {
    "src/format.mjs": [
      "const symbols = { USD: '$', EUR: '€' };",
      "",
      "export function formatMoney(cents, currency = 'USD') {",
      "  return `${symbols[currency] ?? currency}${(cents / 100).toFixed(2)}`;",
      "}",
      "",
    ].join("\n"),
    "src/cart.mjs": [
      "import { formatMoney } from './format.mjs';",
      "",
      "export function cartLine(item) {",
      "  return `${item.name}: ${formatMoney(item.price, item.currency)}`;",
      "}",
      "",
    ].join("\n"),
    "src/invoice.mjs": [
      "import { formatMoney } from './format.mjs';",
      "",
      "export function invoiceTotal(items) {",
      "  const cents = items.reduce((sum, item) => sum + item.price, 0);",
      "  return formatMoney(cents, items[0]?.currency);",
      "}",
      "",
    ].join("\n"),
  },
  migration: {
    "src/account.mjs": [
      "export function createAccount(input) {",
      "  return { displayName: input.displayName, plan: input.plan ?? 'free' };",
      "}",
      "",
    ].join("\n"),
    "src/profile.mjs": [
      "import { createAccount } from './account.mjs';",
      "",
      "export function profileLabel(input) {",
      "  const account = createAccount(input);",
      "  return `${account.displayName} (${account.plan})`;",
      "}",
      "",
    ].join("\n"),
  },
  "long-context": {
    "src/codeword.txt": "ORCHID-42\n",
  },
  "long-thread": {
    "src/words.mjs": [
      "export function countWords(text) {",
      "  const trimmed = text.trim();",
      "  return trimmed ? trimmed.split(/\\s+/).length : 0;",
      "}",
      "",
    ].join("\n"),
    "src/tags.mjs": [
      "export function uniqueWords(text) {",
      "  const words = [];",
      "  for (const word of text.toLowerCase().split(/\\s+/)) {",
      "    if (word && !words.includes(word)) words.push(word);",
      "  }",
      "  return words;",
      "}",
      "",
    ].join("\n"),
    "src/summary.mjs": [
      "import { countWords } from './words.mjs';",
      "import { uniqueWords } from './tags.mjs';",
      "",
      "export function summary(text) {",
      "  return { words: countWords(text), unique: uniqueWords(text).length };",
      "}",
      "",
    ].join("\n"),
    "README.md": [
      "# Word tools",
      "",
      "`countWords` counts words, `uniqueWords` returns lowercase unique words in first-seen order, and `summary` combines them.",
      "",
    ].join("\n"),
  },
};

test("the expanded fixtures pass with a reference fix", async () => {
  for (const [id, files] of Object.entries(referenceFixes)) {
    const entry = task(id);
    assert.ok(entry, id);
    const root = await mkdtemp(join(tmpdir(), `glitter-eval-fix-${id}-`));
    try {
      await setupTask(root, entry);
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content, "utf8");
      }
      const checks = await runChecks(root, entry);
      assert.deepEqual(checks.filter((check) => !check.ok), [], `${id} must be solvable`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("the known-bug fixture fails before the fix and passes after it", async () => {
  const root = await mkdtemp(join(tmpdir(), "glitter-eval-test-"));
  try {
    const bug = task("known-bug");
    await setupTask(root, bug);
    const before = await runChecks(root, bug);
    assert.equal(before.length, 1);
    assert.equal(before[0].ok, false, "the fixture must fail before any model work");
    await writeFile(join(root, "src/range.mjs"), "export function range(start, end) {\n  const out = [];\n  for (let i = start; i <= end; i += 1) out.push(i);\n  return out;\n}\n", "utf8");
    const after = await runChecks(root, bug);
    assert.equal(after[0].ok, true, "the fixture must pass once fixed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the free pre-route check matches the policy and exits cleanly", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ["evals/orchestrator/run.mjs", "--pre-route"], { cwd: root });
  assert.match(stdout, /Expectations matched: \d+\/\d+/);
  assert.match(stdout, /pre-route:exact-small-change/);
  assert.match(stdout, /failing-test/, "candidate cases are reported");
});

test("file checks and baseline configs use the same rules as the runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "glitter-eval-test-"));
  try {
    const css = task("minor-css");
    await setupTask(root, css);
    assert.equal((await runChecks(root, css))[0].ok, false);
    await writeFile(join(root, "src/theme.css"), ":root {\n  --accent: #ff8800;\n}\n", "utf8");
    assert.equal((await runChecks(root, css))[0].ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const configs = buildConfigs({ EVAL_LEAD_MODEL: "anthropic/lead", EVAL_BUILDER_MODEL: "deepseek/builder", EVAL_SMALL_MODEL: "deepseek/builder" });
  assert.deepEqual(Object.keys(configs), ["orchestrator-cost", "orchestrator-balanced", "orchestrator-output", "lead-alone", "builder-alone", "small-alone"]);
  assert.deepEqual(missingCredentials(configs, {}), ["anthropic", "deepseek"]);
  assert.deepEqual(credentialsFromEnv({}), { ollama: { key: "" }, lmstudio: { key: "" } }, "keyless local providers still get a credential entry");
  assert.deepEqual(missingCredentials(configs, { anthropic: { key: "x" }, deepseek: { key: "y" } }), []);

  const calls = [
    { modelId: "anthropic/lead", inputTokens: 1_000_000, outputTokens: 1_000_000 },
    { modelId: "deepseek/builder", inputTokens: 1_000_000, outputTokens: 1_000_000 },
  ];
  const cost = costOf(calls, { "anthropic/lead": { input: 3, output: 15 } });
  assert.equal(cost.usd, 18);
  assert.equal(cost.partial, true, "an unpriced hosted call makes the total partial");
  assert.equal(costOf([{ modelId: "ollama/qwen3-coder", inputTokens: 10, outputTokens: 10 }], {}).partial, false, "local calls are priced at zero explicitly");
});
