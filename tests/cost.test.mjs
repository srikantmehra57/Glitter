import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-cost-'));
let sequence = 0;
async function bundle(entry) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const { estimateCost, formatCost } = await bundle('apps/desktop/src/lib/cost.ts');

test('catalog rates price tokens per one million', () => {
  assert.equal(estimateCost({ promptTokens: 1_000_000, outputTokens: 1_000_000 }, { input: '1.25', output: '4.25', currency: 'USD' }), 5.5);
  assert.ok(Math.abs(estimateCost({ promptTokens: 48210, outputTokens: 12794 }, { input: '1.25', output: '4.25' }) - 0.114637) < 1e-9);
  assert.ok(Math.abs(estimateCost({ promptTokens: 12040, outputTokens: 3120 }, { input: '1.25', output: '4.25' }) - 0.02831) < 1e-9);
});

test('uncounted legs need no price, but counted legs do', () => {
  assert.ok(Math.abs(estimateCost({ promptTokens: 1000 }, { input: '2', output: 'zzz' }) - 0.002) < 1e-12);
  assert.ok(Math.abs(estimateCost({ outputTokens: 1000 }, { input: 'zzz', output: '4' }) - 0.004) < 1e-12);
  assert.equal(estimateCost({ promptTokens: 1000, outputTokens: 1000 }, { input: '2', output: 'zzz' }), undefined);
  assert.equal(estimateCost({ promptTokens: 1000, outputTokens: 1000 }, { input: 'zzz', output: '4' }), undefined);
});

test('unpriced models and empty usage yield no figure to show', () => {
  const priced = { input: '1.25', output: '4.25' };
  const usage = { promptTokens: 100, outputTokens: 100 };
  assert.equal(estimateCost(usage, null), undefined);
  assert.equal(estimateCost(usage, undefined), undefined);
  assert.equal(estimateCost(usage, { input: '-1', output: '4.25' }), undefined);
  assert.equal(estimateCost(usage, { input: '', output: '4.25' }), undefined);
  assert.equal(estimateCost(null, priced), undefined);
  assert.equal(estimateCost(undefined, priced), undefined);
  assert.equal(estimateCost({}, priced), undefined);
  assert.equal(estimateCost({ promptTokens: 0, outputTokens: 0 }, priced), undefined);
  assert.equal(estimateCost({ promptTokens: Number.NaN, outputTokens: 10 }, priced), undefined);
  assert.equal(estimateCost({ promptTokens: -5, outputTokens: 10 }, priced), undefined);
});

test('free models price real usage at zero', () => {
  assert.equal(estimateCost({ promptTokens: 100, outputTokens: 100 }, { input: '0', output: '0' }), 0);
});

test('money keeps cents, sub-cent values keep decimals', () => {
  assert.equal(formatCost(0.42), '$0.42');
  assert.equal(formatCost(12.5), '$12.50');
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(0.0042), '$0.0042');
  assert.equal(formatCost(0.005), '$0.005');
  assert.equal(formatCost(0.00001), '<$0.0001');
  assert.equal(formatCost(0.42, null), '$0.42');
  assert.equal(formatCost(0.42, 'EUR'), 'EUR 0.42');
  assert.equal(formatCost(Number.NaN), '—');
  assert.equal(formatCost(-1), '—');
});
