import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Dispatch tests for the `suggest` verb on the Harness: its own per-workspace
 * queue key (never behind a session verb), parameter forwarding and the
 * workspace-root requirement.
 */

const temporary = await mkdtemp(join(tmpdir(), 'glitter-suggest-'));
after(() => rm(temporary, { recursive: true, force: true }));

const harnessStub = `
export const HARNESS_ID = 'harness';
export const HARNESS_NAME = 'Harness';
export class HarnessHost {
  constructor() { this.spec = { id: HARNESS_ID, name: HARNESS_NAME }; this.registry = { register() {} }; this.calls = 0; }
  setCredentials() {}
  async stop() { if (process.env.GLITTER_TEST_STOP_FILE) (await import('node:fs')).writeFileSync(process.env.GLITTER_TEST_STOP_FILE, 'stopped'); }
  listModels() { return process.env.GLITTER_TEST_HANG_MODELS ? new Promise(() => {}) : { models: [] }; }
  async suggest(options) {
    this.calls += 1;
    if (process.env.GLITTER_TEST_JUMP_WALL_CLOCK) { const now = Date.now; Date.now = () => now() + 3_600_000; }
    return { text: '[]', calls: this.calls, options };
  }
}`;
const browserStub = `
export class BrowserManager { async closeAll() {} }
export function browserExtension() { return { id: 'browser', tools: [] }; }
`;

const replacements = { './harness/host.js': harnessStub, './browser.js': browserStub };
const outfile = join(temporary, 'bridge.mjs');
await build({
  entryPoints: [resolve('packages/glitter-harness/src/index.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
  plugins: [{ name: 'test-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(replacements, path) ? { path, namespace: 'test-boundary' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, ({ path }) => ({ contents: replacements[path], loader: 'ts', resolveDir: resolve('packages/glitter-harness/src') }));
  } }],
});

function link(child) {
  let buffer = '';
  const waiters = new Map();
  const stderr = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id ?? null);
      if (waiter) { waiters.delete(message.id ?? null); waiter(message); }
    }
  });
  const pending = (id, write) => new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`timed out waiting for response ${String(id)}${stderr.length ? `: ${stderr.join('')}` : ''}`));
    }, 5000);
    waiters.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    write();
  });
  let sequence = 0;
  return {
    request: (method, params, extra = {}) => {
      const id = `t${sequence++}`;
      const line = params === undefined ? { id, method, ...extra } : { id, method, params, ...extra };
      return pending(id, () => child.stdin.write(`${JSON.stringify(line)}\n`));
    },
    stderr,
  };
}

async function withBridge(body, env = {}) {
  const child = spawn(process.execPath, [outfile], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  try {
    await body(link(child));
  } finally {
    child.stdin.end();
    await Promise.race([new Promise((r) => child.on('exit', r)), new Promise((r) => setTimeout(r, 2000))]);
    if (child.exitCode === null) child.kill();
  }
}

test('suggest forwards the request to the Harness with a trimmed model id', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('suggest', { workspaceRoot: '/repo', prompt: 'ideas?', modelId: '  tiny-model ', timeoutMs: 5000 });
    assert.equal(response.ok, true, response.error);
    assert.deepEqual(response.result.options, { workspaceRoot: '/repo', prompt: 'ideas?', modelId: 'tiny-model', timeoutMs: 5000 });
    const blank = await bridge.request('suggest', { workspaceRoot: '/repo', prompt: 'more', modelId: '   ' });
    assert.equal(blank.result.options.modelId, undefined, 'a blank model leaves the choice to the Harness');
    assert.equal(blank.result.calls, 2);
  });
});

test('suggest elapsed budget is unaffected by a wall-clock jump', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('suggest', { workspaceRoot: '/repo', prompt: 'x', timeoutMs: 5000 });
    assert.equal(response.ok, true);
    assert.equal(response.result.text, '[]');
    assert.equal((await bridge.request('ping')).ok, true, 'later deadlines still use the monotonic clock');
  }, { GLITTER_TEST_JUMP_WALL_CLOCK: '1' });
});

test('suggest requires a workspace root, so it never runs unconfined', async () => {
  await withBridge(async (bridge) => {
    for (const workspaceRoot of [undefined, '', '   ']) {
      const response = await bridge.request('suggest', { prompt: 'x', ...(workspaceRoot === undefined ? {} : { workspaceRoot }) });
      assert.equal(response.ok, false);
      assert.match(response.error, /workspace root/i);
    }
  });
});

test('suggest never waits behind a wedged session verb', async () => {
  await withBridge(async (bridge) => {
    const wedged = bridge.request('listModels', {});
    wedged.catch(() => {});
    const response = await bridge.request('suggest', { workspaceRoot: '/repo', prompt: 'x' });
    assert.equal(response.ok, true);
    assert.equal(response.result.text, '[]');
  }, { GLITTER_TEST_HANG_MODELS: '1' });
});

test('shutdown stops the Harness', async () => {
  const marker = join(temporary, 'stopped');
  const child = spawn(process.execPath, [outfile], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GLITTER_TEST_STOP_FILE: marker } });
  try {
    const bridge = link(child);
    await bridge.request('suggest', { workspaceRoot: '/repo', prompt: 'x' });
    child.stdin.end();
    await Promise.race([new Promise((r) => child.on('exit', r)), new Promise((r) => setTimeout(r, 2000))]);
    assert.equal(existsSync(marker), true, 'the Harness is stopped at shutdown');
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
