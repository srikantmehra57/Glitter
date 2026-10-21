import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-cli-update-'));
after(() => rm(temporary, { recursive: true, force: true }));
let sequence = 0;
async function bundle(entry, replacements = {}) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
    plugins: [{ name: 'test-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(replacements, path) ? { path, namespace: 'test-boundary' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, ({ path }) => ({ contents: replacements[path], loader: 'ts', resolveDir: resolve('packages/muse-bridge/src') }));
    } }],
  });
  return import(pathToFileURL(outfile).href);
}

const cliUpdate = await bundle('packages/muse-bridge/src/cli-update.ts', {
  './detect.js': `export const resolveMuseBin = () => globalThis.testMuseBin ?? null;`,
});
const { cachedProbe, forgetProbe, rememberProbe } = await bundle('packages/muse-bridge/src/probe-cache.ts');
// A second cli-update bundle with a forget spy: each bundle inlines its own
// probe-cache copy, so the real invalidation is observed through the spy.
const spied = await bundle('packages/muse-bridge/src/cli-update.ts', {
  './detect.js': `export const resolveMuseBin = () => globalThis.testMuseBin ?? null;`,
  './probe-cache.js': `export const forgetProbe = (path) => { (globalThis.forgotten ??= []).push(path); };`,
});

const { channelManifestUrl, checkCliUpdate, cliChannel, installedCliVersion, installDirForBin, parseChannelManifest, pendingUpdateNotice, updateCli } = cliUpdate;

const INSTALLED = '3.14.3-R1';
const LATEST = '3.14.4-R2';
const manifest = (overrides = {}) => JSON.stringify({
  channel: 'muse-stable',
  version: LATEST,
  manifest_url: 'https://example.invalid/release.json',
  urgency: 'encouraged',
  notification_text: 'Faster startup.',
  ...overrides,
});

/** A fake launcher install dir: a `muse` file plus launcher state files. */
async function fakeInstall(files = {}) {
  const dir = await mkdtemp(join(temporary, 'install-'));
  await writeFile(join(dir, 'muse'), '#!/bin/sh\n');
  for (const [name, contents] of Object.entries(files)) await writeFile(join(dir, name), contents);
  globalThis.testMuseBin = join(dir, 'muse');
  return dir;
}

after(() => { delete globalThis.testMuseBin; delete globalThis.forgotten; });

function withChannel(value, body) {
  const previous = process.env.MUSE_CHANNEL;
  if (value === undefined) delete process.env.MUSE_CHANNEL;
  else process.env.MUSE_CHANNEL = value;
  try { return body(); }
  finally {
    if (previous === undefined) delete process.env.MUSE_CHANNEL;
    else process.env.MUSE_CHANNEL = previous;
  }
}

test('channel defaults to muse-stable and rejects unknown channels', () => {
  withChannel(undefined, () => assert.equal(cliChannel(), 'muse-stable'));
  withChannel('', () => assert.equal(cliChannel(), 'muse-stable'));
  withChannel('muse-canary', () => assert.equal(cliChannel(), 'muse-canary'));
  withChannel('muse-beta', () => assert.throws(() => cliChannel(), /Unsupported Muse channel/));
  assert.equal(channelManifestUrl('muse-stable'), 'https://api.meta.ai/muse-code/channels/muse-stable');
});

test('channel manifest parsing mirrors the launcher validation', () => {
  assert.deepEqual(parseChannelManifest(manifest(), 'muse-stable'), {
    channel: 'muse-stable', version: LATEST, manifestUrl: 'https://example.invalid/release.json', urgency: 'encouraged', notification: 'Faster startup.',
  });
  assert.throws(() => parseChannelManifest('x'.repeat(8193), 'muse-stable'), /size budget/);
  assert.throws(() => parseChannelManifest('{nope', 'muse-stable'), /not valid JSON/);
  assert.throws(() => parseChannelManifest('[]', 'muse-stable'), /not an object/);
  assert.throws(() => parseChannelManifest(manifest({ channel: 'muse-canary' }), 'muse-stable'), /different channel/);
  for (const version of [undefined, 42, '3.14.4', 'v3.14.4-R2', '3.14.4-R']) {
    assert.throws(() => parseChannelManifest(manifest({ version }), 'muse-stable'), /no usable version/, String(version));
  }
  assert.equal(parseChannelManifest(manifest({ version: '3.14.4-R2.7' }), 'muse-stable').version, '3.14.4-R2.7');
  assert.throws(() => parseChannelManifest(manifest({ manifest_url: '' }), 'muse-stable'), /no usable manifest URL/);
  assert.throws(() => parseChannelManifest(manifest({ manifest_url: `https://x/
` }), 'muse-stable'), /no usable manifest URL/);
  assert.throws(() => parseChannelManifest(manifest({ urgency: 'someday' }), 'muse-stable'), /no usable urgency/);
  assert.throws(() => parseChannelManifest(manifest({ notification_text: null }), 'muse-stable'), /no notification text/);
});

test('installed version and notice files are read strictly', async () => {
  const dir = await fakeInstall({ '.muse-version': `${INSTALLED}\n`, '.muse-update-notice': `${INSTALLED}\t${LATEST}\n` });
  // tmpdir may sit behind a symlink (/var on macOS); the launcher resolves it too.
  assert.equal(installDirForBin(join(dir, 'muse')), realpathSync(dir));
  assert.equal(installDirForBin(join(dir, 'missing')), null);
  assert.equal(installedCliVersion(dir), INSTALLED);
  assert.deepEqual(pendingUpdateNotice(dir), { from: INSTALLED, to: LATEST });

  const bare = await fakeInstall();
  assert.equal(installedCliVersion(bare), null);
  assert.equal(pendingUpdateNotice(bare), null);

  const rotten = await fakeInstall({ '.muse-version': `3.14.4
`, '.muse-update-notice': `same	same
` });
  assert.equal(installedCliVersion(rotten), null);
  assert.equal(pendingUpdateNotice(rotten), null);
});

test('update check compares installed against the channel without network in tests', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => manifest() };
  };
  await withChannel(undefined, async () => {
    await fakeInstall({ '.muse-version': `${INSTALLED}\n` });
    const newer = await checkCliUpdate({ fetchImpl });
    assert.deepEqual(newer, { available: true, current: INSTALLED, latest: LATEST, urgency: 'encouraged', notification: 'Faster startup.', channel: 'muse-stable' });
    assert.equal(calls[0].url, 'https://api.meta.ai/muse-code/channels/muse-stable');
    assert.equal(calls[0].init.headers.Accept, 'application/json');

    await fakeInstall({ '.muse-version': `${LATEST}\n` });
    const current = await checkCliUpdate({ fetchImpl });
    assert.equal(current.available, false);
    assert.equal(current.latest, LATEST);
  });
});

test('update check reports no update when it cannot compare', async () => {
  let fetched = 0;
  const fetchImpl = async () => { fetched += 1; return { ok: true, status: 200, text: async () => manifest() }; };
  await withChannel(undefined, async () => {
    globalThis.testMuseBin = null;
    assert.deepEqual(await checkCliUpdate({ fetchImpl }), { available: false, current: null, latest: null, urgency: 'none', notification: '', channel: 'muse-stable' });
    await fakeInstall();
    const unmanaged = await checkCliUpdate({ fetchImpl });
    assert.equal(unmanaged.available, false);
    assert.equal(unmanaged.latest, null);
    assert.equal(fetched, 0);
  });
});

test('update check surfaces channel failures and bad channels', async () => {
  await withChannel(undefined, async () => {
    await fakeInstall({ '.muse-version': `${INSTALLED}\n` });
    await assert.rejects(() => checkCliUpdate({ fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }) }), /HTTP 503/);
    await assert.rejects(() => checkCliUpdate({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{nope' }) }), /not valid JSON/);
  });
  await withChannel('muse-beta', async () => {
    await assert.rejects(() => checkCliUpdate({ fetchImpl: async () => ({}) }), /Unsupported Muse channel/);
  });
});

test('forgetting one probe leaves the rest cached', async () => {
  const dir = await fakeInstall();
  const a = join(dir, 'muse');
  const b = join(dir, 'other');
  await writeFile(b, '#!/bin/sh\n');
  rememberProbe(a, 'Muse Code 3.14.3');
  rememberProbe(b, 'other 1.0');
  forgetProbe(a);
  assert.equal(cachedProbe(a), undefined);
  assert.equal(cachedProbe(b), 'other 1.0');
});

test('update reports the swap and drops the stale version probe', async () => {
  await withChannel(undefined, async () => {
    const dir = await fakeInstall({ '.muse-version': `${INSTALLED}\n` });
    const bin = join(dir, 'muse');
    globalThis.forgotten = [];
    const outcome = await spied.updateCli({ runSyncUpdateImpl: async (target) => {
      assert.equal(target, bin);
      // What the launcher does on success: swap state, leave a notice.
      await writeFile(join(dir, '.muse-version'), `${LATEST}\n`);
      await writeFile(join(dir, '.muse-update-notice'), `${INSTALLED}\t${LATEST}\n`);
      return `Muse Code ${LATEST}`;
    } });
    assert.deepEqual(outcome, { updated: true, from: INSTALLED, to: LATEST, version: LATEST });
    assert.deepEqual(globalThis.forgotten, [bin]);
  });
});

test('update is a quiet no-op when already current, and errors surface', async () => {
  await withChannel(undefined, async () => {
    await fakeInstall({ '.muse-version': `${LATEST}\n` });
    const outcome = await updateCli({ runSyncUpdateImpl: async () => `Muse Code ${LATEST}` });
    assert.deepEqual(outcome, { updated: false, from: LATEST, to: LATEST, version: LATEST });

    await assert.rejects(() => updateCli({ runSyncUpdateImpl: async () => { throw new Error('no network'); } }), /no network/);
    globalThis.testMuseBin = null;
    await assert.rejects(() => updateCli({ runSyncUpdateImpl: async () => '' }), /not found/);
  });
});
