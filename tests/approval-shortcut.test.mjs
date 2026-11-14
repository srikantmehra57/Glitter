import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'glitter-approval-shortcut-'));
after(() => rm(temporary, { recursive: true, force: true }));
const outfile = join(temporary, 'approvalShortcut.mjs');
await build({ entryPoints: [resolve('apps/desktop/src/lib/approvalShortcut.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const { APPROVAL_ALLOW_DELAY_MS, approvalShortcutBlocked, approvalViewKey, trackShownApproval } = await import(pathToFileURL(outfile).href);

const shown = { key: 's1:a1', at: 1000 };
const press = (over) => approvalShortcutBlocked({ repeat: false, allow: true, shown, key: 's1:a1', now: 1000 + APPROVAL_ALLOW_DELAY_MS, ...over });

// M17: holding the key repeated keydown and approved the next card unseen.
test('a repeated keydown never decides, allow or deny', () => {
  assert.equal(press({ repeat: true }), true);
  assert.equal(press({ repeat: true, allow: false }), true);
});

test('an allow waits until its card has been in view', () => {
  assert.equal(press({ now: 1000 + APPROVAL_ALLOW_DELAY_MS - 1 }), true, 'a second tap on the next card is too soon');
  assert.equal(press({ now: 1000 + APPROVAL_ALLOW_DELAY_MS }), false, 'a settled card can be allowed');
});

test('a deny is never delayed, because refusing an unseen card is safe', () => {
  assert.equal(press({ allow: false, now: 1000 }), false);
});

test('an allow is refused when the card in view is not the one being decided', () => {
  assert.equal(press({ shown: null }), true);
  assert.equal(press({ key: 's1:a2' }), true);
  assert.equal(press({ key: null }), true);
});

test('the delay restarts only when a different card comes into view', () => {
  const first = trackShownApproval(null, 's1:a1', 1000);
  assert.deepEqual(first, { key: 's1:a1', at: 1000 });
  assert.equal(trackShownApproval(first, 's1:a1', 5000), first, 'an unrelated store update keeps the original time');
  assert.deepEqual(trackShownApproval(first, 's1:a2', 5000), { key: 's1:a2', at: 5000 }, 'the next card starts its own delay');
  assert.deepEqual(trackShownApproval(first, 's2:a1', 5000), { key: 's2:a1', at: 5000 }, 'the same approval in another thread is a new card');
  assert.equal(trackShownApproval(first, null, 5000), null, 'no card in view clears the clock');
});

test('a card is identified by its thread and approval together', () => {
  assert.equal(approvalViewKey('s1', 'a1'), 's1:a1');
  assert.equal(approvalViewKey(undefined, 'a1'), null);
  assert.equal(approvalViewKey('s1', null), null);
});

test('the key handler uses the guard and ignores a refocused window until the card settles', () => {
  const app = readFileSync('apps/desktop/src/App.tsx', 'utf8');
  assert.match(app, /approvalShortcutBlocked\(\{[\s\S]{0,200}repeat: event\.repeat/, 'the handler passes the key-repeat flag');
  assert.match(app, /void state\.decide\(approval\.approvalId, choice\.choiceId\)/, 'the decision still runs');
  assert.ok(app.indexOf('approvalShortcutBlocked') < app.indexOf('void state.decide(approval.approvalId'), 'the guard runs before the decision');
  assert.match(app, /addEventListener\("focus", restartShown\)/, 'a window that regains focus restarts the delay');
});
