/**
 * The starter Orchestrator corpus. Each task is a tiny workspace with a
 * prompt, setup files and deterministic checks. The runner treats any task
 * without checks as a manual-review task.
 *
 * Add tasks by keeping ids unique and paths workspace-relative. A task's
 * checks must fail on the untouched fixture unless it is marked manual.
 */

const nodeTest = [{ kind: "command", command: ["node", "--test"] }];

/** A 16x16 #ff8800 PNG swatch; the vision task is scored by hand. */
const ACCENT_SWATCH = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP438FAEiJN9aiGUQ1DSgMA3SmHEGxQEU8AAAAASUVORK5CYII=";

const longContextSections = Array.from({ length: 700 }, (_, index) => `Section ${index + 1}. Keep changes small, checks deterministic, and the API stable. Keep changes small, checks deterministic, and the API stable.`);
longContextSections.splice(350, 0, "DEPLOYMENT CODEWORD: ORCHID-42");
const longContextPrompt = [
  "Read the specification below and write its deployment codeword to `src/codeword.txt`. Write only the codeword, with no other text.",
  "",
  longContextSections.join("\n"),
  "",
  "End of specification.",
].join("\n");

export const TASKS = [
  {
    id: "minor-css",
    title: "Minor CSS token change",
    category: "minor",
    prompt: "Change the `--accent` custom property in `src/theme.css` to `#ff8800`.",
    setup: {
      "src/theme.css": ":root {\n  --accent: #ff0000;\n}\n",
    },
    checks: [{ kind: "file", path: "src/theme.css", contains: "#ff8800" }],
  },
  {
    id: "minor-copy",
    title: "Minor copy change",
    category: "minor",
    prompt: "Change the button label from 'Save' to 'Store' in src/panel.mjs.",
    setup: {
      "src/panel.mjs": [
        "export function buttonLabel() {",
        "  return 'Save';",
        "}",
        "",
      ].join("\n"),
    },
    checks: [
      { kind: "file", path: "src/panel.mjs", contains: "return 'Store';" },
      { kind: "file", path: "src/panel.mjs", notContains: "'Save'" },
    ],
  },
  {
    id: "known-bug",
    title: "Localized bug with a failing test",
    category: "bug",
    prompt: "The test in `test/range.test.mjs` fails. Find the cause and fix it.",
    setup: {
      "src/range.mjs": "export function range(start, end) {\n  const out = [];\n  for (let i = start; i < end; i += 1) out.push(i);\n  return out;\n}\n",
      "test/range.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { range } from '../src/range.mjs';\n\ntest('includes the end', () => {\n  assert.deepEqual(range(1, 3), [1, 2, 3]);\n});\n",
    },
    checks: nodeTest,
  },
  {
    id: "unknown-cause-bug",
    title: "Discount bug with an unknown cause",
    category: "bug",
    holdout: true,
    prompt: "Customers report that discounted orders show the wrong total. Find the cause and fix it so the test suite passes.",
    setup: {
      "src/price.mjs": [
        "export function applyDiscount(cents, percent) {",
        "  return cents - percent;",
        "}",
        "",
      ].join("\n"),
      "test/price.test.mjs": [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { applyDiscount } from '../src/price.mjs';",
        "",
        "test('takes a percentage off', () => {",
        "  assert.equal(applyDiscount(1000, 20), 800);",
        "});",
        "test('rounds to whole cents', () => {",
        "  assert.equal(applyDiscount(999, 15), 849);",
        "});",
        "",
      ].join("\n"),
    },
    checks: nodeTest,
  },
  {
    id: "major-bug",
    title: "Multi-file checkout total bug",
    category: "bug",
    holdout: true,
    prompt: "Checkout totals are wrong when items have quantity or tax. Make `node --test` pass and keep the existing API.",
    setup: {
      "src/cart.mjs": [
        "export function subtotal(items) {",
        "  return items.reduce((sum, item) => sum + item.price, 0);",
        "}",
        "",
      ].join("\n"),
      "src/total.mjs": [
        "import { subtotal } from './cart.mjs';",
        "",
        "export function total(items, rate = 0) {",
        "  return subtotal(items) * (1 + rate);",
        "}",
        "",
      ].join("\n"),
      "test/total.test.mjs": [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { subtotal } from '../src/cart.mjs';",
        "import { total } from '../src/total.mjs';",
        "",
        "test('multiplies quantity', () => {",
        "  assert.equal(subtotal([{ price: 5, quantity: 2 }]), 10);",
        "});",
        "",
        "test('applies tax and rounds to cents', () => {",
        "  assert.equal(total([{ price: 5, quantity: 2 }], 0.1), 11);",
        "});",
        "",
      ].join("\n"),
    },
    checks: nodeTest,
  },
  {
    id: "feature",
    title: "Small feature with tests",
    category: "feature",
    prompt: "Implement `formatBytes` in `src/bytes.mjs` so every test in `test/bytes.test.mjs` passes. Keep the existing API.",
    setup: {
      "src/bytes.mjs": "export function formatBytes(bytes) {\n  return String(bytes);\n}\n",
      "test/bytes.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatBytes } from '../src/bytes.mjs';\n\ntest('formats zero', () => {\n  assert.equal(formatBytes(0), '0 B');\n});\ntest('formats kilobytes', () => {\n  assert.equal(formatBytes(1024), '1 KB');\n});\ntest('formats megabytes', () => {\n  assert.equal(formatBytes(1024 * 1024), '1 MB');\n});\n",
    },
    checks: nodeTest,
  },
  {
    id: "cross-cutting-feature",
    title: "Cross-cutting currency support",
    category: "feature",
    holdout: true,
    prompt: "Add currency support to the shared money formatting used by cart lines and invoice totals. The tests describe the expected API.",
    setup: {
      "src/format.mjs": [
        "export function formatMoney(cents) {",
        "  return `$${(cents / 100).toFixed(2)}`;",
        "}",
        "",
      ].join("\n"),
      "src/cart.mjs": [
        "import { formatMoney } from './format.mjs';",
        "",
        "export function cartLine(item) {",
        "  return `${item.name}: ${formatMoney(item.price)}`;",
        "}",
        "",
      ].join("\n"),
      "src/invoice.mjs": [
        "import { formatMoney } from './format.mjs';",
        "",
        "export function invoiceTotal(items) {",
        "  const cents = items.reduce((sum, item) => sum + item.price, 0);",
        "  return formatMoney(cents);",
        "}",
        "",
      ].join("\n"),
      "test/format.test.mjs": [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { formatMoney } from '../src/format.mjs';",
        "",
        "test('uses the requested currency', () => {",
        "  assert.equal(formatMoney(1250, 'EUR'), '€12.50');",
        "});",
        "test('defaults to USD', () => {",
        "  assert.equal(formatMoney(1250), '$12.50');",
        "});",
        "",
      ].join("\n"),
      "test/cart.test.mjs": [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { cartLine } from '../src/cart.mjs';",
        "",
        "test('cart line uses the item currency', () => {",
        "  assert.equal(cartLine({ name: 'Tea', price: 1250, currency: 'EUR' }), 'Tea: €12.50');",
        "});",
        "",
      ].join("\n"),
      "test/invoice.test.mjs": [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { invoiceTotal } from '../src/invoice.mjs';",
        "",
        "test('invoice total uses the currency', () => {",
        "  assert.equal(invoiceTotal([{ price: 1000, currency: 'EUR' }]), '€10.00');",
        "});",
        "",
      ].join("\n"),
    },
    checks: nodeTest,
  },
  {
    id: "high-risk-auth",
    title: "Security-sensitive token comparison",
    category: "security",
    prompt: "Harden the authentication token check in `src/auth.mjs`. Compare digests with `crypto.timingSafeEqual` instead of a direct string comparison, and keep the tests green.",
    setup: {
      "src/auth.mjs": "import { createHash } from 'node:crypto';\n\nexport function digest(value) {\n  return createHash('sha256').update(value).digest();\n}\n\nexport function tokenMatches(input, expected) {\n  return input === expected;\n}\n",
      "test/auth.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { digest, tokenMatches } from '../src/auth.mjs';\n\ntest('accepts the matching token', () => {\n  assert.equal(tokenMatches('secret', 'secret'), true);\n});\ntest('rejects a different token', () => {\n  assert.equal(tokenMatches('secret', 'other'), false);\n});\ntest('digests the same input consistently', () => {\n  assert.deepEqual(digest('secret'), digest('secret'));\n});\n",
    },
    checks: [
      ...nodeTest,
      { kind: "file", path: "src/auth.mjs", contains: "timingSafeEqual" },
      { kind: "file", path: "src/auth.mjs", notContains: "input === expected" },
    ],
  },
  {
    id: "migration",
    title: "Field migration across two modules",
    category: "migration",
    holdout: true,
    prompt: "Migrate the account API from `userName` to `displayName` in `src/account.mjs` and `src/profile.mjs`. The tests expect the new field and no alias.",
    setup: {
      "src/account.mjs": [
        "export function createAccount(input) {",
        "  return { userName: input.userName, plan: input.plan ?? 'free' };",
        "}",
        "",
      ].join("\n"),
      "src/profile.mjs": [
        "import { createAccount } from './account.mjs';",
        "",
        "export function profileLabel(input) {",
        "  const account = createAccount(input);",
        "  return `${account.userName} (${account.plan})`;",
        "}",
        "",
      ].join("\n"),
      "test/account.test.mjs": [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { createAccount } from '../src/account.mjs';",
        "import { profileLabel } from '../src/profile.mjs';",
        "",
        "test('creates an account with a display name', () => {",
        "  assert.deepEqual(createAccount({ displayName: 'Ada' }), { displayName: 'Ada', plan: 'free' });",
        "});",
        "test('labels the profile with the display name', () => {",
        "  assert.equal(profileLabel({ displayName: 'Ada', plan: 'pro' }), 'Ada (pro)');",
        "});",
        "",
      ].join("\n"),
    },
    checks: [
      ...nodeTest,
      { kind: "file", path: "src/account.mjs", notContains: "userName" },
      { kind: "file", path: "src/profile.mjs", notContains: "userName" },
    ],
  },
  {
    id: "continuation",
    title: "Two-turn continuation",
    category: "continuation",
    prompt: "Create `src/sum.mjs` exporting `sum(a, b)` and `test/sum.test.mjs` that checks it with `node:test`.",
    turns: [
      "Create `src/sum.mjs` exporting `sum(a, b)` and `test/sum.test.mjs` that checks it with `node:test`.",
      "Now add `src/product.mjs` exporting `product(a, b)` and `test/product.test.mjs` in the same style. Keep the first files unchanged.",
    ],
    setup: {},
    checks: [
      { kind: "path", path: "src/sum.mjs" },
      { kind: "path", path: "src/product.mjs" },
      ...nodeTest,
    ],
  },
  {
    id: "long-thread",
    title: "Four-turn word tools thread",
    category: "long-thread",
    holdout: true,
    prompt: "Create `src/words.mjs` exporting `countWords(text)`, and make its test pass.",
    turns: [
      "Create `src/words.mjs` exporting `countWords(text)`, and make its test pass.",
      "Add `src/tags.mjs` exporting `uniqueWords(text)` for lowercase unique words, and make its test pass.",
      "Add `src/summary.mjs` exporting `summary(text)` that returns `{ words, unique }` using both helpers, and make its test pass.",
      "Add a `README.md` with a short usage note naming `countWords`, `uniqueWords` and `summary`.",
    ],
    setup: {
      "test/words.test.mjs": [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { countWords } from '../src/words.mjs';",
        "",
        "test('counts whitespace-separated words', () => {",
        "  assert.equal(countWords('one two one'), 3);",
        "});",
        "",
      ].join("\n"),
      "test/tags.test.mjs": [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { uniqueWords } from '../src/tags.mjs';",
        "",
        "test('returns unique lowercase words in first-seen order', () => {",
        "  assert.deepEqual(uniqueWords('One two one'), ['one', 'two']);",
        "});",
        "",
      ].join("\n"),
      "test/summary.test.mjs": [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { summary } from '../src/summary.mjs';",
        "",
        "test('summarizes words and unique words', () => {",
        "  assert.deepEqual(summary('One two one'), { words: 3, unique: 2 });",
        "});",
        "",
      ].join("\n"),
    },
    checks: [
      { kind: "path", path: "src/words.mjs" },
      { kind: "path", path: "src/tags.mjs" },
      { kind: "path", path: "src/summary.mjs" },
      { kind: "path", path: "README.md" },
      { kind: "file", path: "README.md", contains: "countWords" },
      { kind: "file", path: "README.md", contains: "uniqueWords" },
      { kind: "file", path: "README.md", contains: "summary" },
      ...nodeTest,
    ],
  },
  {
    id: "plan-mode",
    title: "Plan review followed by a build",
    category: "plan-mode",
    mode: "plan",
    prompt: "Plan then implement `slugify` in `src/slug.mjs` so `test/slug.test.mjs` passes.",
    forcedShape: "lead-guided",
    setup: {
      "src/slug.mjs": "export function slugify(value) {\n  return value;\n}\n",
      "test/slug.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slug.mjs';\n\ntest('lowercases and hyphenates', () => {\n  assert.equal(slugify('Hello World'), 'hello-world');\n});\n",
    },
    checks: nodeTest,
  },
  {
    id: "redesign",
    title: "Settings page redesign",
    category: "redesign",
    holdout: true,
    prompt: "Redesign the settings page from a table into a responsive card layout. Keep every field and label, and make it readable in a narrow window.",
    setup: {
      "src/settings.html": [
        "<table>",
        '  <tr><td>Name</td><td><input name="name"></td></tr>',
        '  <tr><td>Email</td><td><input name="email"></td></tr>',
        '  <tr><td>Notifications</td><td><input type="checkbox" name="notify"></td></tr>',
        "</table>",
        "",
      ].join("\n"),
      "src/styles.css": "body { font-family: system-ui; }\n",
    },
    checks: [],
    manual: "Does the page use a card layout, keep the Name, Email and Notifications fields and labels, and read well at a narrow width? Score 0-2.",
  },
  {
    id: "long-context",
    title: "Find a codeword in a long specification",
    category: "long-context",
    holdout: true,
    prompt: longContextPrompt,
    setup: {},
    checks: [
      { kind: "path", path: "src/codeword.txt" },
      { kind: "file", path: "src/codeword.txt", contains: "ORCHID-42" },
    ],
  },
  {
    id: "vision-swatch",
    title: "Match an accent to an attached swatch",
    category: "vision",
    holdout: true,
    prompt: "Set the `--accent` custom property in `src/theme.css` to the color shown in the attached swatch. Leave the other tokens unchanged.",
    images: [{ name: "accent-swatch.png", mediaType: "image/png", base64Data: ACCENT_SWATCH }],
    setup: {
      "src/theme.css": ":root {\n  --accent: #000000;\n  --surface: #ffffff;\n}\n",
    },
    checks: [],
    manual: "Does --accent match the attached swatch (#ff8800) while --surface stays #ffffff? Score 0-2.",
  },
  {
    id: "ambiguous",
    title: "Ambiguous improvement request",
    category: "ambiguous",
    prompt: "Improve this project.",
    setup: {
      "src/app.mjs": "export function app() {\n  return 'ready';\n}\n",
    },
    checks: [],
    manual: "Did the model ask a useful clarifying question or make a scoped, stated improvement? Score 0-2.",
  },
];

export const CORPUS_SPLITS = ["tune", "holdout"];

/** Tuning tasks choose rules; holdout tasks only report success. */
export function taskSplit(task) {
  return task.holdout === true ? "holdout" : "tune";
}

export function selectTasks(tasks = TASKS, split = "all") {
  if (split !== "all" && !CORPUS_SPLITS.includes(split)) throw new Error(`Unknown task split: ${split}. Use ${["all", ...CORPUS_SPLITS].join(", ")}.`);
  return split === "all" ? [...tasks] : tasks.filter((task) => taskSplit(task) === split);
}

export const CORPUS_IMAGE_TYPES = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_TYPES = new Set(CORPUS_IMAGE_TYPES);

/** A task's images ride with its first turn; later turns are text-only. */
export function imagesForTurn(task, index) {
  if (index !== 0 || !task.images?.length) return undefined;
  return task.images.map(({ mediaType, base64Data }) => ({ mediaType, base64Data }));
}

/** Shape errors that would make the runner mislead the operator. */
export function validateCorpus(tasks = TASKS) {
  const errors = [];
  const ids = new Set();
  for (const task of tasks) {
    if (!task.id || ids.has(task.id)) errors.push(`Task ${task.id ?? "(missing id)"} has a missing or duplicate id.`);
    ids.add(task.id);
    if (!task.prompt?.trim()) errors.push(`Task ${task.id} has no prompt.`);
    if (task.mode && !["build", "plan"].includes(task.mode)) errors.push(`Task ${task.id} has an unknown mode.`);
    if (task.holdout !== undefined && typeof task.holdout !== "boolean") errors.push(`Task ${task.id} has a non-boolean holdout flag.`);
    if (task.turns && (!Array.isArray(task.turns) || !task.turns.length || task.turns.some((turn) => !turn?.trim()))) errors.push(`Task ${task.id} has an invalid turns list.`);
    if (task.images !== undefined && !Array.isArray(task.images)) errors.push(`Task ${task.id} has a non-list images field.`);
    for (const [index, image] of (Array.isArray(task.images) ? task.images : []).entries()) {
      if (!image?.name?.trim()) errors.push(`Task ${task.id} image ${index} has no name.`);
      if (!IMAGE_TYPES.has(image?.mediaType)) errors.push(`Task ${task.id} image ${index} has an unsupported media type: ${image?.mediaType}`);
      if (typeof image?.base64Data !== "string" || !image.base64Data || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64Data)) errors.push(`Task ${task.id} image ${index} has invalid base64 data.`);
      else if (image.base64Data.length > 2_000_000) errors.push(`Task ${task.id} image ${index} exceeds 2 MB of base64 data.`);
    }
    for (const path of Object.keys(task.setup ?? {})) {
      if (!path || path.startsWith("/") || path.split("/").includes("..")) errors.push(`Task ${task.id} has an unsafe setup path: ${path}`);
    }
    for (const check of task.checks ?? []) {
      if (check.kind === "file") {
        if (!check.path) errors.push(`Task ${task.id} has a file check without a path.`);
        if (check.contains === undefined && check.notContains === undefined && check.equals === undefined) errors.push(`Task ${task.id} has a file check without an assertion.`);
      } else if (check.kind === "command") {
        if (!Array.isArray(check.command) || !check.command.length || check.command.some((part) => typeof part !== "string" || !part)) errors.push(`Task ${task.id} has an invalid command check.`);
      } else if (check.kind !== "path") {
        errors.push(`Task ${task.id} has an unknown check kind: ${check.kind}`);
      }
    }
    if (!task.checks?.length && !task.manual) errors.push(`Task ${task.id} has no checks and no manual note.`);
  }
  for (const split of CORPUS_SPLITS) {
    if (!tasks.some((task) => task.checks?.length && taskSplit(task) === split)) errors.push(`The corpus needs an automated ${split} task.`);
  }
  return errors;
}

export const CORPUS_CATEGORIES = [...new Set(TASKS.map((task) => task.category))];
