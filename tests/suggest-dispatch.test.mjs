import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Dispatch tests for the `suggest` verb: the dedicated quiet Muse host (always
 * `--no-session-log`, read-only posture), the per-workspace queue key, and the
 * ACP routing path.
 */

const temporary = await mkdtemp(join(tmpdir(), 'muse-suggest-'));
after(() => rm(temporary, { recursive: true, force: true }));

const hostStub = `
export class MuseHost {
  constructor(quiet) {
    this.quiet = quiet === true;
    this.started = false;
    this.startCalls = 0;
    this.suggestCalls = 0;
  }
  get running() { return this.started; }
  detect() { return { found: true, via: 'muse' }; }
  status() { return { running: this.started, via: 'muse' }; }
  async start(...args) {
    this.startCalls += 1;
    this.startArgs = args;
    const delay = Number(process.env.MUSE_TEST_SLOW_START ?? 0);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (process.env.MUSE_TEST_JUMP_WALL_CLOCK) {
      const now = Date.now;
      Date.now = () => now() + 3_600_000;
    }
    this.started = true;
    return { started: true };
  }
  async stop() {
    this.started = false;
    process.stderr.write('stop ' + (this.quiet ? 'quiet' : 'main') + '\\n');
    return { stopped: true };
  }
  async listModels() {
    if (process.env.MUSE_TEST_HANG_MODELS) return new Promise(() => {});
    return { models: [] };
  }
  async suggest(options) {
    this.suggestCalls += 1;
    return { text: '[]', quiet: this.quiet, startCalls: this.startCalls, startArgs: this.startArgs, calls: this.suggestCalls, options };
  }
}`;

const acpStub = `
export class AcpAgentHost {
  constructor(spec, bin, emit) { this.spec = spec; this.bin = bin; }
  ownsApproval() { return false; }
  decideApproval() { return { decided: 'acp' }; }
  isolation() { return { env: 'minimal', osSandbox: 'unavailable', platform: 'test', cwd: '/tmp', consentRequired: true }; }
  async start() {}
  async stop() { process.stderr.write('stop acp\\n'); }
  async listSessions() { return { sessions: [] }; }
  async suggest(options) { return { text: 'acp-suggested', spec: this.spec.id, options }; }
}`;

const agentsStub = `
const SPECS = {
  muse: { id: 'muse', name: 'Muse', protocol: 'msp' },
  opencode: { id: 'opencode', name: 'OpenCode', protocol: 'acp' },
};
export function agentSpec(id) {
  const spec = SPECS[id];
  if (!spec) throw new Error('Unknown agent: ' + id);
  return spec;
}
export function resolveAgentBin(spec) { return spec.id === 'opencode' ? '/fake/opencode' : null; }
export function checkAgentBin(raw) { return raw; }
export function detectAgents() { return []; }`;

const loginStub = `
export class LoginFlow {
  async start() { return { url: 'https://stub.invalid', code: 'STUB' }; }
  cancel() { return { cancelled: false }; }
}`;

const replacements = { './host.js': hostStub, './acp.js': acpStub, './agents.js': agentsStub, './login.js': loginStub };
const outfile = join(temporary, 'bridge.mjs');
await build({
  entryPoints: [resolve('packages/muse-bridge/src/index.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
  plugins: [{ name: 'test-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(replacements, path) ? { path, namespace: 'test-boundary' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, ({ path }) => ({ contents: replacements[path], loader: 'ts', resolveDir: resolve('packages/muse-bridge/src') }));
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

test('suggest drives the quiet host once, with a no-log read-only posture, and forwards the request', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('suggest', { workspaceRoot: '/repo', prompt: 'ideas?', modelId: 'tiny-model', providerId: 'meta', timeoutMs: 5000, museBin: '/muse', contributorMode: 'off' });
    assert.equal(response.ok, true);
    const result = response.result;
    assert.equal(result.quiet, true, 'the suggestion ran on the dedicated quiet host, not the main host');
    assert.equal(result.startCalls, 1);
    const posture = result.startArgs[4];
    assert.equal(posture.noSessionLog, true);
    assert.equal(posture.disableWrite, true);
    assert.equal(posture.disableShell, true);
    assert.equal(posture.contributorMode, 'off');
    assert.deepEqual(posture.denyReadRoots, ['/repo']);
    assert.equal(result.options.workspaceRoot, '/repo');
    assert.equal(result.options.prompt, 'ideas?');
    assert.equal(result.options.modelId, 'tiny-model');
    assert.equal(result.options.providerId, 'meta');
    assert.ok(result.options.timeoutMs > 0 && result.options.timeoutMs <= 5000);
    // A second request finds the host already running and skips start entirely.
    const second = await bridge.request('suggest', { workspaceRoot: '/repo', prompt: 'more' });
    assert.equal(second.result.calls, 2);
    assert.equal(second.result.startCalls, 1, 'the quiet host is reused instead of respawned');
  });
});

test('suggest restarts the quiet host when contributor mode or the workspace changes', async () => {
  await withBridge(async (bridge) => {
    await bridge.request('suggest', { workspaceRoot: '/repo', prompt: 'a', contributorMode: 'off' });
    const changed = await bridge.request('suggest', { workspaceRoot: '/repo', prompt: 'b', contributorMode: 'on' });
    assert.equal(changed.ok, true);
    assert.equal(changed.result.startCalls, 2);
    assert.equal(changed.result.startArgs[4].contributorMode, 'on');
    const moved = await bridge.request('suggest', { workspaceRoot: '/other', prompt: 'c', contributorMode: 'on' });
    assert.equal(moved.result.startCalls, 3);
    assert.deepEqual(moved.result.startArgs[4].denyReadRoots, ['/other']);
  });
});

test('suggest does not send a turn when host start uses up the budget', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('suggest', { workspaceRoot: '/repo', prompt: 'x', timeoutMs: 30 });
    assert.equal(response.ok, false);
    assert.match(response.error, /timed out/i);
  }, { MUSE_TEST_SLOW_START: '80' });
});

test('suggest elapsed budget is unaffected by a wall-clock jump', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('suggest', { workspaceRoot: '/repo', prompt: 'x', timeoutMs: 5000 });
    assert.equal(response.ok, true);
    assert.equal(response.result.text, '[]');
  }, { MUSE_TEST_JUMP_WALL_CLOCK: '1' });
});

test('suggest requires a workspace root', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('suggest', { prompt: 'x' });
    assert.equal(response.ok, false);
    assert.match(response.error, /workspace root/i);
  });
});

test('an ACP suggestion with no workspace root is refused, not run unconfined', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('suggest', { agentId: 'opencode', prompt: 'x' });
    assert.equal(response.ok, false);
    assert.match(response.error, /workspace root/i);
  });
});

test('suggest never waits behind a wedged session verb', async () => {
  await withBridge(async (bridge) => {
    const wedged = bridge.request('listModels', {});
    wedged.catch(() => {});
    const response = await bridge.request('suggest', { workspaceRoot: '/repo', prompt: 'x' });
    assert.equal(response.ok, true);
    assert.equal(response.result.text, '[]');
  }, { MUSE_TEST_HANG_MODELS: '1' });
});

test('suggest routes to the named ACP agent and leaves the muse hosts alone', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('suggest', { agentId: 'opencode', workspaceRoot: '/repo', prompt: 'x', modelId: 'zen/a' });
    assert.equal(response.ok, true);
    assert.equal(response.result.text, 'acp-suggested');
    assert.equal(response.result.spec, 'opencode');
    assert.equal(response.result.options.modelId, 'zen/a');
    // A muse suggestion afterwards still sees its own host starting fresh.
    const muse = await bridge.request('suggest', { workspaceRoot: '/repo', prompt: 'x' });
    assert.equal(muse.result.startCalls, 1);
  });
});

test('shutdown stops the suggestion host along with everything else', async () => {
  const child = spawn(process.execPath, [outfile], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const bridge = link(child);
    await bridge.request('suggest', { workspaceRoot: '/repo', prompt: 'x' });
    child.stdin.end();
    await Promise.race([new Promise((r) => child.on('exit', r)), new Promise((r) => setTimeout(r, 2000))]);
    const lines = bridge.stderr.join('');
    assert.match(lines, /stop quiet/, 'the quiet host is stopped at shutdown');
    assert.match(lines, /stop main/, 'the main host is stopped at shutdown');
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
