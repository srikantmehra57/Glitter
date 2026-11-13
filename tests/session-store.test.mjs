import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The session index is shared by the app's agent process and the `glitter`
 * CLI. Two stores on one folder stand in for the two processes.
 */
const temporary = await mkdtemp(join(tmpdir(), 'glitter-store-'));
after(() => rm(temporary, { recursive: true, force: true }));
const outfile = join(temporary, 'store.mjs');
await build({ entryPoints: [resolve('packages/glitter-harness/src/harness/store.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const { SessionStore } = await import(pathToFileURL(outfile).href);

const meta = (sessionId, workspaceRoot = '/repo') => ({ sessionId, workspaceRoot, title: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

test('two processes sharing the index keep each other\'s threads', async () => {
  const root = await mkdtemp(join(temporary, 'shared-'));
  const app = new SessionStore(root);
  const cli = new SessionStore(root);
  await app.create(meta('h-app-00001'));
  await cli.create(meta('h-cli-00001'));
  await app.create(meta('h-app-00002'));
  const seen = (rows) => rows.map((row) => row.sessionId).sort();
  assert.deepEqual(seen(await app.list('/repo')), ['h-app-00001', 'h-app-00002', 'h-cli-00001']);
  assert.deepEqual(seen(await cli.list('/repo')), ['h-app-00001', 'h-app-00002', 'h-cli-00001']);
  await cli.update('h-app-00001', { title: 'Renamed in the terminal' });
  assert.equal((await app.meta('h-app-00001')).title, 'Renamed in the terminal');
  await app.remove('h-cli-00001');
  assert.deepEqual(seen(await cli.list('/repo')), ['h-app-00001', 'h-app-00002']);
});

test('concurrent creates from two stores all land in the index', async () => {
  const root = await mkdtemp(join(temporary, 'race-'));
  const stores = [new SessionStore(root), new SessionStore(root)];
  await Promise.all(Array.from({ length: 12 }, (_, at) => stores[at % 2].create(meta(`h-race-0000${at}`))));
  assert.equal((await new SessionStore(root).list()).length, 12);
});

test('an abandoned lock file is broken instead of blocking forever', async () => {
  const root = await mkdtemp(join(temporary, 'stale-'));
  const store = new SessionStore(root);
  await store.create(meta('h-first-001'));
  const lock = join(root, 'index.json.lock');
  await writeFile(lock, '99999');
  const { utimes } = await import('node:fs/promises');
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  await store.create(meta('h-second-01'));
  assert.equal((await store.list()).length, 2);
});
