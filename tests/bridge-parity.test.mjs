import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Contract parity across the renderer↔native bridge boundary, scanned as text
 * in the capabilities.test.mjs tradition:
 *
 *  - `BRIDGE_METHODS` (lib.rs) is the allowlist the native side routes;
 *  - `validate_params` (dto.rs) must vet every allowlisted verb — unknown verbs
 *    fail closed — and its documented-shape test table must name the same set;
 *  - `mockBridge` (bridge.ts) must answer, or deliberately fall through, every
 *    verb the renderer calls, so the browser preview stays an honest oracle.
 *
 * A renamed verb or a forgotten arm fails here before it ships.
 */

const lib = readFileSync(resolve('apps/desktop/src-tauri/src/lib.rs'), 'utf8');
const dto = readFileSync(resolve('apps/desktop/src-tauri/src/dto.rs'), 'utf8');
const bridge = readFileSync(resolve('apps/desktop/src/lib/bridge.ts'), 'utf8');

const allowlistBlock = lib.match(/const BRIDGE_METHODS: &\[&str\] = &\[([\s\S]*?)\];/);
assert.ok(allowlistBlock, 'BRIDGE_METHODS allowlist not found in lib.rs');
const allowlist = [...allowlistBlock[1].matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]);
assert.ok(allowlist.length > 30, 'the scan found the whole allowlist');

// Verbs named by a `match method` arm head inside validate_params. Inner arms
// (`Some("answer") => …`, `_ => check_id(method, "taskId", …)`) are deeper and
// never start the line with a quote, so arm heads are the quote-led lines.
const validationBlock = dto.slice(dto.indexOf('fn validate_params'), dto.indexOf('Unsupported bridge method'));
assert.ok(validationBlock.includes('match method'), 'the validate_params match was found');
const validated = new Set();
for (const line of validationBlock.split('\n')) {
  const head = line.trimStart();
  if (!head.startsWith('"')) continue;
  for (const match of head.matchAll(/"([A-Za-z]+)"(?=\s*(?:\||=>))/g)) validated.add(match[1]);
}
assert.ok(validated.size > 30, 'the scan found the validate_params arms');

// Verbs named by the `every_method_accepts_its_documented_shape` cases table.
const casesBlock = dto.slice(dto.indexOf('let cases'), dto.indexOf('for (method, params) in cases'));
assert.ok(casesBlock.includes('json!'), 'the documented-shape table was found');
const documented = new Set([...casesBlock.matchAll(/\("([A-Za-z]+)",/g)].map((match) => match[1]));
assert.ok(documented.size > 30, 'the scan found the cases table');

test('every allowlisted verb has a validate_params arm and nothing else does', () => {
  assert.deepEqual([...validated].sort(), [...allowlist].sort());
});

test('every allowlisted verb has a documented-shape case in the dto test table', () => {
  assert.deepEqual([...documented].sort(), [...allowlist].sort());
});

// Verbs the renderer calls through `bridge("…")` in shipped code (test mocks
// excluded); readModelCatalog-style wrappers all funnel through store.ts today.
const called = new Set();
for (const name of readdirSync(resolve('apps/desktop/src'), { recursive: true })) {
  if (!/\.tsx?$/.test(name) || name.includes('.test.')) continue;
  for (const match of readFileSync(resolve('apps/desktop/src', name), 'utf8').matchAll(/\bbridge(?:<[^>]*>)?\(\s*"([A-Za-z]+)"/g)) called.add(match[1]);
}
assert.ok(called.size > 30, 'the scan found the renderer call sites');

// Verbs named by a `case "…"` label inside the mockBridge switch; the
// unlabeled `default:` is the silent `{}` fallback this guard fences.
const mockStart = bridge.indexOf('function mockBridge');
const mockBlock = bridge.slice(mockStart, bridge.indexOf('\n}\n', mockStart));
const mocked = new Set([...mockBlock.matchAll(/case "([A-Za-z]+)"/g)].map((match) => match[1]));
assert.ok(mocked.has('sendTurn') && mocked.has('detect'), 'the scan found the mock cases');

/**
 * Renderer-called verbs with no explicit mock case. Each is unreachable in the
 * browser preview — `preview` early-returns, the local-fork branch, or the
 * busy-send gate — or tolerates `{}` (fire-and-forget, optional-field reads).
 * A verb enters this list only with a stated reason; a new renderer call that
 * lands on the fallback fails the parity test until it is answered or listed.
 */
const PREVIEW_FALLBACK = new Set([
  'cancelLogin',      // startLogin early-returns on preview, so no prompt is ever up to cancel
  'closeSession',     // fire-and-forget `.catch(() => {})` on thread/workspace removal
  'compactSession',   // compactThread early-returns on preview
  'forkSession',      // preview forks locally instead of asking the bridge
  'pageHistory',      // history paging and rebuild both early-return on preview
  'respondUserInput', // the respond call is `!preview`-guarded
  'resumeSession',    // selectThread early-returns on preview
  'setSessionOption', // the ACP config path tolerates `{}` — agentConfig is optional
  'startLogin',       // startLogin early-returns on preview
  'steerTurn',        // busy sends (steer/queue/replace) are disabled in preview
  'unqueueTurn',      // queues never accumulate in preview; the action early-returns
]);

test('every verb the renderer calls has a mock answer or a documented fallback', () => {
  const unanswered = [...called].filter((verb) => !mocked.has(verb) && !PREVIEW_FALLBACK.has(verb)).sort();
  assert.deepEqual(unanswered, [], 'a renderer-called verb resolves the silent mock `{}` fallback — give mockBridge an arm or document the fallback');
  const stale = [...PREVIEW_FALLBACK].filter((verb) => mocked.has(verb) || !called.has(verb)).sort();
  assert.deepEqual(stale, [], 'a documented fallback gained a real arm or lost its caller — update the list');
});
