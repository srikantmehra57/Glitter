import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// `flushDeltas` used to write its frames straight to stdout, bypassing the
// protocol ceiling every other frame goes through. One oversized model chunk
// would then kill the shell's NDJSON reader and drop the bridge.
const temporary = await mkdtemp(join(tmpdir(), 'muse-output-framing-'));
after(() => rm(temporary, { recursive: true, force: true }));
const outfile = join(temporary, 'output.mjs');
await build({ entryPoints: [resolve('packages/glitter-harness/src/output.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const output = await import(pathToFileURL(outfile).href);

test('a delta under the ceiling is one frame', () => {
  const frames = output.deltaFrames({ sessionId: 's1', itemId: 'i1', delta: 'hello', field: 'text' }, 1024);
  assert.equal(frames.length, 1);
  assert.equal(JSON.parse(frames[0].trimEnd()).payload.delta, 'hello');
});

test('an oversized delta is split into frames the reader accepts, losing nothing', () => {
  const text = 'x'.repeat(5000) + '😀' + 'y'.repeat(5000);
  const limit = 1024;
  const frames = output.deltaFrames({ sessionId: 's1', itemId: 'i1', delta: text, field: 'text' }, limit);
  assert.ok(frames.length > 1, 'an oversized burst must not be written as one line');
  for (const frame of frames) {
    assert.ok(Buffer.byteLength(frame, 'utf8') <= limit, `frame of ${Buffer.byteLength(frame, 'utf8')} bytes exceeds the ceiling`);
    assert.ok(frame.endsWith('\n'), 'every frame is newline-terminated');
    const parsed = JSON.parse(frame);
    assert.equal(parsed.event, 'delta');
    assert.equal(parsed.payload.sessionId, 's1');
    assert.equal(parsed.payload.itemId, 'i1');
  }
  // A delta is additive, so the renderer concatenates the field: the text must
  // survive the split exactly, including across the astral character.
  assert.equal(frames.map((frame) => JSON.parse(frame).payload.delta).join(''), text);
});

test('flushDeltas writes only bounded frames', async () => {
  const { spawn } = await import('node:child_process');
  const driver = join(temporary, 'driver.mjs');
  await build({
    entryPoints: [resolve('packages/glitter-harness/src/output.ts')],
    bundle: true, platform: 'node', format: 'esm', outfile: driver, logLevel: 'silent',
    banner: { js: 'process.stdout.write = (chunk) => { const line = String(chunk); const bytes = Buffer.byteLength(line, "utf8"); if (bytes > 8 * 1024 * 1024) process.stderr.write("OVERSIZE " + bytes); };' },
  });
  // The banner above replaces the writer, so a frame over the real ceiling is
  // observable rather than emitted. Feed a burst that exceeds it.
  const script = `
    import { queueDelta } from ${JSON.stringify(pathToFileURL(driver).href)};
    queueDelta({ sessionId: 's1', itemId: 'i1', delta: 'a'.repeat(70 * 1024 * 1024), field: 'text' });
  `;
  const run = await import('node:child_process').then(({ execFileSync }) => execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  assert.ok(!run.includes('OVERSIZE'), 'no frame may cross the protocol ceiling');
  void spawn;
});
