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

// F1.7 / M6 / M13. A damaged log line was dropped without a word, and a damaged
// index file made every thread unreachable although a good copy had existed.
const record = (text) => JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });

test('read reports unreadable lines, and a torn last line separately, and keeps everything else', async () => {
  const root = await mkdtemp(join(temporary, 'damaged-'));
  const store = new SessionStore(root);
  await store.create(meta('h-damaged-01'));
  const log = join(root, 'sessions', 'h-damaged-01.jsonl');
  await writeFile(log, `${record('one')}\n{not json at all\n${record('two')}\n{"type":"message","message":{"role":"us`);
  const read = await store.read('h-damaged-01');
  assert.deepEqual(read.messages.map((message) => message.content[0].text), ['one', 'two'], 'readable lines survive');
  assert.deepEqual(read.damaged, { lines: 1, tornTail: true });
  await writeFile(log, `${record('one')}\n${record('two')}\n`);
  assert.equal((await store.read('h-damaged-01')).damaged, undefined, 'a clean log reports nothing');
  await writeFile(log, `${record('one')}\n${record('two')}\n{"torn`);
  assert.deepEqual((await store.read('h-damaged-01')).damaged, { lines: 0, tornTail: true }, 'a crash mid-write is its own, milder case');
});

test('a damaged index is restored from the last good copy, said so, and set aside on the next write', async () => {
  const root = await mkdtemp(join(temporary, 'restore-'));
  const first = new SessionStore(root);
  await first.create(meta('h-restore-01'));
  await first.create(meta('h-restore-02'));
  await first.update('h-restore-02', { title: 'Second' });
  // Damage the file the way a bad disk or an editor might.
  await writeFile(join(root, 'index.json'), '[{"sessionId":"h-restore-01",');
  const messages = [];
  const second = new SessionStore(root);
  second.onRepair = (message) => messages.push(message);
  const listed = await second.list();
  assert.ok(listed.length >= 1, 'threads are listed from the backup');
  assert.ok(listed.some((row) => row.sessionId === 'h-restore-01'));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /restored from its last good copy/);
  // The next write replaces the file and keeps the unreadable one for inspection; the backup is not overwritten by it.
  await second.create(meta('h-restore-03'));
  const names = (await (await import('node:fs/promises')).readdir(root)).sort();
  assert.ok(names.some((name) => name.startsWith('index.json.corrupt-')), 'the damaged file was set aside, not deleted');
  assert.deepEqual((await new SessionStore(root).list()).map((row) => row.sessionId).sort(), ['h-restore-01', 'h-restore-02', 'h-restore-03']);
});

test('an index with no usable backup still stops with an explicit error and changes nothing', async () => {
  const root = await mkdtemp(join(temporary, 'norestore-'));
  const store = new SessionStore(root);
  await store.create(meta('h-nobak-0001'));
  await writeFile(join(root, 'index.json'), 'garbage');
  await writeFile(join(root, 'index.json.bak'), 'also garbage');
  await assert.rejects(new SessionStore(root).list(), /corrupt or invalid[\s\S]*no usable backup/);
  assert.equal(await (await import('node:fs/promises')).readFile(join(root, 'index.json'), 'utf8'), 'garbage');
});

test('a missing index with logs still present is restored from the backup and counts what it cannot list', async () => {
  const root = await mkdtemp(join(temporary, 'missing-'));
  const first = new SessionStore(root);
  await first.create(meta('h-missing-01'));
  await first.update('h-missing-01', { title: 'kept' });
  await first.create(meta('h-missing-02'));
  const fs = await import('node:fs/promises');
  await fs.rm(join(root, 'index.json'));
  await fs.writeFile(join(root, 'sessions', 'h-orphan-0001.jsonl'), '');
  const messages = [];
  const second = new SessionStore(root);
  second.onRepair = (message) => messages.push(message);
  assert.ok((await second.list()).length >= 1);
  // The backup is the index as it was before the last write, so the newest thread and the stray log are both unlisted.
  assert.match(messages[0], /index is missing[\s\S]*2 threads made since then are not listed/);
});
