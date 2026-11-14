import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Error classification (`apps/desktop/src/lib/errors.ts`): every code branch
 * plus the timeout-unknown detector the send-retry path relies on.
 */

const temporary = await mkdtemp(join(tmpdir(), 'glitter-errors-'));
after(() => rm(temporary, { recursive: true, force: true }));

const outfile = join(temporary, 'errors.mjs');
await build({
  entryPoints: [resolve('apps/desktop/src/lib/errors.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
});
const { classifyError, describeError, timeoutUnknown } = await import(pathToFileURL(outfile).href);

test('classifyError routes a rejected or missing provider key to settings by its code', () => {
  for (const code of ['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL']) {
    const classified = classifyError(Object.assign(new Error('The provider rejected the request.'), { code }));
    assert.equal(classified.code, 'auth');
    assert.equal(classified.action, 'settings');
    assert.match(classified.lost, /draft is kept/i);
  }
});

test('a provider setup error keeps its own wording', () => {
  const detail = 'Harness has no model provider yet. Add an API key in Settings → Models & providers.';
  assert.equal(describeError('Could not load Harness models', new Error(detail)), `Could not load Harness models: ${detail}`);
});

test('classifyError treats timeouts as retryable-unknown', () => {
  const classified = classifyError(new Error('sendTurn timed out. Its result is unknown; check before retrying.'));
  assert.equal(classified.code, 'timeout');
  assert.equal(classified.action, 'retry');
  assert.match(classified.lost, /may still be running/i);
});

test('classifyError routes disconnects to reconnect', () => {
  const classified = classifyError(new Error('The agent connection closed. Reconnect from Settings.'));
  assert.equal(classified.code, 'host');
  assert.equal(classified.action, 'reconnect');
});

test('classifyError falls back to retry with the caller title', () => {
  const classified = classifyError(new Error('weird failure'), 'Send failed');
  assert.equal(classified.code, 'unknown');
  assert.equal(classified.title, 'Send failed');
  assert.equal(classified.action, 'retry');
});

test('timeoutUnknown recognizes the tagged bridge timeout', () => {
  const tagged = new Error('sendTurn timed out.');
  tagged.code = 'timeout-unknown';
  assert.equal(timeoutUnknown(tagged), true);
});

test('timeoutUnknown falls back to the result-unknown wording', () => {
  assert.equal(timeoutUnknown(new Error('sendTurn timed out. Its result is unknown; check before retrying.')), true);
  assert.equal(timeoutUnknown(new Error('The agent connection closed.')), false);
  assert.equal(timeoutUnknown(new Error('weird failure')), false);
  assert.equal(timeoutUnknown(null), false);
});

test('classifyError prefers the Harness failure code over message text', () => {
  const coded = (code) => Object.assign(new Error('friendly wrapper'), { code });
  assert.deepEqual([classifyError(coded('RATE_LIMIT')).code, classifyError(coded('RATE_LIMIT')).action], ['busy', 'retry']);
  assert.deepEqual([classifyError(coded('SERVER')).code, classifyError(coded('SERVER')).action], ['busy', 'retry']);
  assert.deepEqual([classifyError(coded('CONTEXT_WINDOW_EXCEEDED')).code, classifyError(coded('CONTEXT_WINDOW_EXCEEDED')).action], ['invalid', 'retry']);
  // Unknown codes still fall through to the message matchers.
  assert.equal(classifyError(coded('noBoundary')).code, 'unknown');
});

test('describeError keeps the reason for an unrecognized failure', () => {
  // A locked keychain is the whole message: there is nothing better to say
  // than what the OS told us, and dropping it would leave the user blind.
  assert.equal(describeError('Could not save settings', new Error('credential store locked')),
    'Could not save settings: credential store locked');
  assert.equal(describeError('Could not discard src/App.tsx', new Error('git failed')),
    'Could not discard src/App.tsx: git failed');
  assert.equal(describeError('Could not continue', new Error('Error: boom')),
    'Could not continue: boom');
});

test('describeError replaces a recognized failure with its recovery', () => {
  const auth = Object.assign(new Error('401 from the provider'), { code: 'INVALID_CREDENTIAL' });
  assert.equal(describeError('Could not send', auth),
    'The provider rejected the API key. 401 from the provider The draft is kept. Replace the key in Settings → Models & providers.');
});
