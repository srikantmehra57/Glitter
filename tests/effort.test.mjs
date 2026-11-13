import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-effort-'));
let sequence = 0;
async function bundle(entry) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const { clampTier, tiersFor, defaultTier, isPeak, modelFor, withUnlistedModels, isFastModel, VOCABULARY } = await bundle('apps/desktop/src/lib/effort.ts');
const { stepFromItem } = await bundle('apps/desktop/src/lib/agent.ts');

test('effort clamps to the nearest supported tier at or below when the model changes', () => {
  const tiers = ['low', 'medium', 'high', 'max'];
  assert.equal(clampTier('xhigh', tiers), 'high');
  assert.equal(clampTier('none', tiers), 'low');
  assert.equal(clampTier('max', tiers), 'max');
  assert.deepEqual(tiersFor(undefined), VOCABULARY);
  assert.deepEqual(tiersFor({ modelId: 'm', reasoningEfforts: [] }), VOCABULARY, 'empty efforts fall back to vocabulary');
  assert.deepEqual(tiersFor({ modelId: 'm' }), VOCABULARY, 'model without tiers falls back to vocabulary');
  assert.deepEqual(tiersFor({ modelId: 'm', reasoningEfforts: ['low', 'high'] }), ['low', 'high'], 'model tiers win when present');
  assert.equal(defaultTier({ modelId: 'm', reasoningEfforts: tiers }), 'high');
  assert.equal(defaultTier({ modelId: 'm', reasoningEfforts: [] }), 'high', 'falls back to default high effort');
  assert.equal(defaultTier({ modelId: 'm', defaultReasoningEffort: 'low', reasoningEfforts: ['low', 'high'] }), 'low', 'model default wins');
  assert.equal(defaultTier({ modelId: 'm' }, VOCABULARY, 'medium'), 'medium', 'user default wins when model declares none');
  assert.equal(isPeak('max', tiers), true);
  assert.equal(isPeak('high', ['low', 'high']), false);
});

test('fast variants are recognized by their suffix', () => {
  assert.equal(isFastModel({ modelId: 'grok-4.7', providerId: 'grok' }), false);
  assert.equal(isFastModel({ modelId: 'grok-4.7-build-fast', providerId: 'grok' }), true);
  assert.equal(isFastModel(undefined), false);
  assert.equal(isFastModel({ modelId: 'm-fast' }), true);
  // "-fastest" and friends are not fast variants.
  assert.equal(isFastModel({ modelId: 'm-fastest' }), false);
});

test('reminderChild and unknown items never render as the agent reply', () => {
  assert.equal(stepFromItem({ itemId: 'r', kind: 'reminderChild', status: 'completed', fallbackText: 'Reminder child session' }).kind, 'reminder');
  const unknown = stepFromItem({ itemId: 'u', kind: 'futureThing', status: 'completed', fallbackText: 'x' });
  assert.equal(unknown.kind, 'other');
  assert.equal(unknown.title, 'Future thing');
  assert.equal(stepFromItem({ itemId: 'a', kind: 'agentMessage', status: 'completed', text: 'hi' }).kind, 'message');
});

test('a selected model the catalog no longer lists stays in the picker list', () => {
  // Muse 1.4 lists no `-contributor` ids, but a saved default or an open thread can still name one.
  const catalog = [{ modelId: 'muse-wonder-1.0', providerId: 'meta', isDefault: true }, { modelId: 'muse-spark-1.3', providerId: 'meta' }];
  const stale = { modelId: 'muse-spark-1.3-contributor', providerId: 'meta' };
  const merged = withUnlistedModels(catalog, [stale, stale, { modelId: 'muse-spark-1.3' }, { modelId: '  ' }, {}]);
  assert.deepEqual(merged.map((model) => model.modelId), ['muse-wonder-1.0', 'muse-spark-1.3', 'muse-spark-1.3-contributor']);
  assert.deepEqual(merged[2], { ...stale, unlisted: true });
  assert.equal(modelFor(merged, stale), merged[2]);
  // Nothing to add returns the catalog itself, so a memoized list keeps its identity.
  assert.equal(withUnlistedModels(catalog, [{ modelId: 'muse-spark-1.3' }]), catalog);
  // Before the catalog arrives there is nothing to compare against.
  assert.deepEqual(withUnlistedModels([], [stale]), []);
});
