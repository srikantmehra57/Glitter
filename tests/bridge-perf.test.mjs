import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'glitter-harness-perf-'));
// Non-temp fake HOME: agent resolution refuses binaries that live under /tmp.
const fakeHome = join(process.cwd(), 'tests', 'fixtures', `perf-home-${process.pid}`);
after(async () => {
  await rm(temporary, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
});
let sequence = 0;
async function bundle(entry) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

/** Capture what a module writes to stdout for the duration of `run`. */
async function captureStdout(run) {
  const frames = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { frames.push(String(chunk)); return true; };
  try { await run(frames); } finally { process.stdout.write = original; }
  return frames;
}
const parse = (frame) => JSON.parse(frame);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

// ─── delta coalescing ────────────────────────────────────────────────────────

test('deltas for one item and field merge into a single frame', async () => {
  const { queueDelta, flushDeltas } = await bundle('packages/glitter-harness/src/output.ts');
  const frames = await captureStdout(async () => {
    for (const piece of ['Hel', 'lo, ', 'wor', 'ld']) assert.equal(queueDelta({ sessionId: 's', itemId: 'i', field: 'text', delta: piece }), true);
    flushDeltas();
  });
  assert.equal(frames.length, 1);
  assert.deepEqual(parse(frames[0]), { type: 'event', event: 'delta', payload: { sessionId: 's', itemId: 'i', field: 'text', delta: 'Hello, world' } });
});

test('a pending delta is written before any other frame, so order never changes', async () => {
  const { queueDelta, writeFrame } = await bundle('packages/glitter-harness/src/output.ts');
  const frames = await captureStdout(async () => {
    queueDelta({ sessionId: 's', itemId: 'i', field: 'text', delta: 'before' });
    writeFrame('{"type":"event","event":"turnCompleted"}\n');
    queueDelta({ sessionId: 's', itemId: 'i', field: 'text', delta: 'after' });
    writeFrame('{"id":"r1","ok":true}\n');
  });
  assert.deepEqual(frames.map((frame) => parse(frame).event ?? parse(frame).id), ['delta', 'turnCompleted', 'delta', 'r1']);
  assert.equal(parse(frames[0]).payload.delta, 'before');
  assert.equal(parse(frames[2]).payload.delta, 'after');
});

test('different items and fields stay separate, in the order they first appeared', async () => {
  const { queueDelta, flushDeltas } = await bundle('packages/glitter-harness/src/output.ts');
  const frames = await captureStdout(async () => {
    queueDelta({ sessionId: 's', itemId: 'a', field: 'text', delta: '1' });
    queueDelta({ sessionId: 's', itemId: 'b', field: 'text', delta: '2' });
    queueDelta({ sessionId: 's', itemId: 'a', field: 'output', delta: '3' });
    queueDelta({ sessionId: 's', itemId: 'a', field: 'text', delta: '4' });
    queueDelta({ sessionId: 't', itemId: 'a', field: 'text', delta: '5' });
    flushDeltas();
  });
  assert.deepEqual(
    frames.map((frame) => { const { sessionId, itemId, field, delta } = parse(frame).payload; return `${sessionId}/${itemId}/${field}=${delta}`; }),
    ['s/a/text=14', 's/b/text=2', 's/a/output=3', 't/a/text=5'],
  );
});

test('deltas flush on their own within a frame, and a large burst does not wait', async () => {
  const { queueDelta } = await bundle('packages/glitter-harness/src/output.ts');
  const frames = await captureStdout(async (seen) => {
    queueDelta({ sessionId: 's', itemId: 'i', field: 'text', delta: 'tick' });
    assert.equal(seen.length, 0, 'held, not written synchronously');
    await delay(60);
    assert.equal(seen.length, 1, 'the timer flushed it');
    queueDelta({ sessionId: 's', itemId: 'i', field: 'text', delta: 'x'.repeat(70 * 1024) });
    assert.equal(seen.length, 2, 'a burst over the threshold is written immediately');
  });
  assert.equal(parse(frames[1]).payload.delta.length, 70 * 1024);
});

test('multibyte text and newlines survive the merge byte for byte', async () => {
  const { queueDelta, flushDeltas } = await bundle('packages/glitter-harness/src/output.ts');
  const frames = await captureStdout(async () => {
    queueDelta({ sessionId: 's', itemId: 'i', field: 'text', delta: 'héllo\n' });
    queueDelta({ sessionId: 's', itemId: 'i', field: 'text', delta: '日本語 🎉 "quoted"\\' });
    flushDeltas();
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].endsWith('\n'), true);
  assert.equal(frames[0].slice(0, -1).includes('\n'), false, 'the frame itself is one line');
  assert.equal(parse(frames[0]).payload.delta, 'héllo\n日本語 🎉 "quoted"\\');
});

test('payloads that are not the plain delta shape are refused and pass through untouched', async () => {
  const { queueDelta, flushDeltas } = await bundle('packages/glitter-harness/src/output.ts');
  const frames = await captureStdout(async () => {
    for (const odd of [null, undefined, 'text', {}, { sessionId: 's', itemId: 'i' }, { sessionId: 's', itemId: 'i', delta: 5 }, { sessionId: 's', itemId: 'i', field: 7, delta: 'x' }]) {
      assert.equal(queueDelta(odd), false);
    }
    flushDeltas();
  });
  assert.deepEqual(frames, [], 'nothing was held');
});

// ─── version probes ──────────────────────────────────────────────────────────

// ─── framing fast path ───────────────────────────────────────────────────────

test('whole frames inside one chunk and frames split across chunks decode identically', async () => {
  const { LineFrames } = await bundle('packages/glitter-harness/src/framing.ts');
  const text = ['{"a":1}', '{"b":"é日本"}', '', '{"c":[1,2,3]}'].map((line) => `${line}\n`).join('');
  const bytes = Buffer.from(text);
  const whole = [];
  new LineFrames().push(bytes, (line) => whole.push(line));
  // Every possible split point, including inside a multi-byte character.
  for (let cut = 0; cut <= bytes.length; cut += 1) {
    const split = [];
    const reader = new LineFrames();
    reader.push(bytes.subarray(0, cut), (line) => split.push(line));
    reader.push(bytes.subarray(cut), (line) => split.push(line));
    assert.deepEqual(split, whole, `split at byte ${cut}`);
  }
  assert.deepEqual(whole, ['{"a":1}', '{"b":"é日本"}', '', '{"c":[1,2,3]}']);
});
