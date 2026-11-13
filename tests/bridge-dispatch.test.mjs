import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Wire-protocol tests for the agent entrypoint (`packages/glitter-harness/src/index.ts`):
 * JSON-line framing, Harness routing, per-session queues and failure
 * serialization. The entrypoint is bundled with a stubbed Harness and driven
 * over stdio like the Tauri backend drives the real process.
 */

const temporary = await mkdtemp(join(tmpdir(), 'glitter-dispatch-'));
after(() => rm(temporary, { recursive: true, force: true }));

const harnessStub = `
export const HARNESS_ID = 'harness';
export const HARNESS_NAME = 'Harness';
export class HarnessHost {
  constructor() { this.spec = { id: HARNESS_ID, name: HARNESS_NAME }; this.registry = { register() {} }; this.sessions = new Set(); }
  setCredentials(credentials) { this.credentials = credentials; }
  async start() {}
  isolation() { return { env: 'minimal', osSandbox: 'enforced', platform: 'test', cwd: '/tmp', consentRequired: false }; }
  async stop() {}
  listSessions() { return { sessions: [...this.sessions].map((sessionId) => ({ sessionId })) }; }
  listModels() { return process.env.GLITTER_TEST_HANG_MODELS ? new Promise(() => {}) : { models: Object.keys(this.credentials ?? {}).sort() }; }
  orchestratorProbe(options) { return { probe: options, providers: Object.keys(this.credentials ?? {}).sort() }; }
  async startSession(options) { this.sessions.add('h-owned'); return { sessionId: 'h-owned', options }; }
  async resumeSession(options) { this.sessions.add(options.sessionId); return { sessionId: options.sessionId, resumed: true }; }
  async closeSession(options) {
    if (options.sessionId && !this.sessions.has(options.sessionId) && options.sessionId !== 'never-opened') throw new Error('Unknown session');
    this.sessions.delete(options.sessionId);
    return { closed: true };
  }
  async sendTurn(options) {
    if (process.env.GLITTER_TEST_HANG_SUBMIT) return new Promise(() => {});
    if (options.text === 'throw-credential') throw new Error('Authorization: Bearer CANARY-DISPATCH');
    if (options.text === 'throw-known-key') throw new Error('rejected CANARY-KNOWN-KEY');
    if (options.text === 'throw-string') throw 'plain-string-boom';
    if (options.text === 'crash-async') setTimeout(() => { throw new Error('Authorization: Bearer CANARY-CRASH'); }, 10);
    if (options.text === 'throw-coded') {
      const coded = new Error('provider says slow down');
      coded.code = 'RATE_LIMIT';
      throw new Error('friendly wrapper', { cause: coded });
    }
    return { turnId: 'h-turn', via: 'harness', ...(options.ifBusy ? { ifBusy: options.ifBusy } : {}), ...(options.forcedShape ? { forcedShape: options.forcedShape } : {}), ...(options.skill ? { skill: options.skill } : {}) };
  }
  async steerTurn(options) { return { turnId: 'h-steered', text: options.text }; }
  async unqueueTurn(options) { return { turnId: options.turnId, unqueued: true }; }
  async cancelTurn() { return { cancelled: true }; }
  decideApproval(options) { return { decided: options.approvalId, choice: options.choiceId }; }
  async respondUserInput() { return { status: 'accepted' }; }
  async compactSession(options) { return { status: 'compacting', via: 'harness', sessionId: options.sessionId }; }
  async setOrchestrator(options) { return { status: 'accepted', via: 'harness', orchestrator: options.orchestrator }; }
  async setModel(options) { return { model: options.modelId }; }
  async setOption(sessionId, option, value) { return { option, value }; }
  async setApprovalMode(sessionId, mode) { return { mode }; }
  setPermissionRules(rules) { return { rules }; }
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
    raw: (line) => pending(null, () => child.stdin.write(`${line}\n`)),
    send: (line) => child.stdin.write(`${line}\n`),
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

test('an expired deadline fails before dispatch', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('ping', undefined, { deadlineInMs: 0 });
    assert.equal(response.ok, false);
    assert.match(response.error, /deadline/);
  });
});

test('ping answers without params', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('ping');
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, { pong: true });
  });
});

test('blank lines are ignored', async () => {
  await withBridge(async (bridge) => {
    bridge.send('');
    bridge.send('   ');
    const response = await bridge.request('ping');
    assert.deepEqual(response.result, { pong: true });
  });
});

test('invalid JSON reports id null and the bridge keeps serving', async () => {
  await withBridge(async (bridge) => {
    const bad = await bridge.raw('{not json');
    assert.equal(bad.id, null);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Invalid JSON/);
    const response = await bridge.request('ping');
    assert.deepEqual(response.result, { pong: true });
  });
});

test('Harness reads providers from the native credential payload', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('listModels', {
      agentId: 'harness',
      providerKeys: {
        kilo: { key: 'CANARY-KILO-KEY' },
        nvidia: { key: 'CANARY-NVIDIA-KEY' },
        'custom-1': { key: 'CANARY-CUSTOM-KEY', baseUrl: 'https://zenmux.ai/api/v1', name: 'ZenMux', wire: 'openai' },
      },
    });
    assert.equal(response.ok, true, response.error);
    assert.deepEqual(response.result.models, ['custom-1', 'kilo', 'nvidia']);
  });
});

test('an Orchestrator role check names its role, provider and model after native credential injection', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('orchestratorProbe', {
      agentId: 'harness',
      role: 'builder',
      providerId: 'anthropic',
      modelId: 'anthropic/claude-sonnet-9',
      refresh: true,
      providerKeys: { anthropic: { key: 'CANARY-ANTHROPIC-KEY' } },
    });
    assert.equal(response.ok, true, response.error);
    assert.deepEqual(response.result, {
      probe: { role: 'builder', providerId: 'anthropic', modelId: 'anthropic/claude-sonnet-9', refresh: true },
      providers: ['anthropic'],
    });
  });
});

test('a Harness start forwards the Orchestrator role settings intact', async () => {
  await withBridge(async (bridge) => {
    const orchestrator = {
      goal: 'output',
      models: {
        lead: { modelId: 'anthropic/lead', providerId: 'anthropic' },
        builder: { modelId: 'deepseek/build' },
      },
    };
    const started = await bridge.request('startSession', { agentId: 'harness', workspaceRoot: '/repo', orchestrator });
    assert.equal(started.ok, true, started.error);
    assert.equal(started.result.sessionId, 'h-owned');
    assert.deepEqual(started.result.options.orchestrator, orchestrator, 'goal and role models reach the harness unchanged');
    assert.equal(started.result.options.modelId, undefined, 'Orchestrator chooses the models, not the manual picker');
  });
});

test('a Harness compaction is routed to its host', async () => {
  await withBridge(async (bridge) => {
    await bridge.request('startSession', { agentId: 'harness', workspaceRoot: '/repo' });
    const compacted = await bridge.request('compactSession', { agentId: 'harness', sessionId: 'h-owned' });
    assert.deepEqual(compacted.result, { status: 'compacting', via: 'harness', sessionId: 'h-owned' });
  });
});

test('a live Orchestrator switch forwards its settings and its off state', async () => {
  await withBridge(async (bridge) => {
    const orchestrator = {
      goal: 'cost',
      models: {
        lead: { modelId: 'anthropic/lead' },
        builder: { modelId: 'deepseek/build' },
      },
    };
    const enabled = await bridge.request('setOrchestrator', { agentId: 'harness', sessionId: 'h-owned', orchestrator });
    assert.equal(enabled.ok, true, enabled.error);
    assert.deepEqual(enabled.result, { status: 'accepted', via: 'harness', orchestrator });
    const disabled = await bridge.request('setOrchestrator', { agentId: 'harness', sessionId: 'h-owned', orchestrator: null });
    assert.deepEqual(disabled.result, { status: 'accepted', via: 'harness', orchestrator: null });
  });
});

test('a forced shape reaches the Harness turn, and an unknown one is refused', async () => {
  await withBridge(async (bridge) => {
    const sent = await bridge.request('sendTurn', { agentId: 'harness', sessionId: 'h-owned', text: 'hi', forcedShape: 'direct-builder' });
    assert.equal(sent.ok, true, sent.error);
    assert.equal(sent.result.forcedShape, 'direct-builder');
    const bad = await bridge.request('sendTurn', { agentId: 'harness', sessionId: 'h-owned', text: 'hi', forcedShape: 'router' });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'A forced shape must be direct-small, direct-builder, lead-guided or lead-only.');
  });
});

test('an uncaught async crash reports a redacted bridgeExit, not a raw stack', async () => {
  const child = spawn(process.execPath, [outfile], { stdio: ['pipe', 'pipe', 'pipe'] });
  const bridge = link(child);
  try {
    const turn = await bridge.request('sendTurn', { sessionId: 's', text: 'crash-async' });
    assert.equal(turn.ok, true);
    // `raw('')` parks a waiter on the next id-less message: the crash event.
    const event = await bridge.raw('');
    assert.equal(event.type, 'event');
    assert.equal(event.event, 'bridgeExit');
    assert.ok(!JSON.stringify(event).includes('CANARY'));
    await Promise.race([new Promise((r) => child.on('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
    assert.ok(!bridge.stderr.join('').includes('CANARY'), bridge.stderr.join(''));
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
});

test('a long-running turn is never cut by the ceiling', async () => {

  await withBridge(async (bridge) => {
    // sendTurn awaits the turn to completion, so its duration is the agent's.
    const sent = await bridge.request('sendTurn', { sessionId: 'h-owned', text: 'go' });
    assert.equal(sent.ok, true);
  }, { GLITTER_WORK_CEILING_MS: '1' });
});

test('startSession replays an idempotency key', async () => {
  await withBridge(async (bridge) => {
    const first = await bridge.request('startSession', { workspaceRoot: '/repo', clientRequestId: 'create-1' });
    const second = await bridge.request('startSession', { workspaceRoot: '/other', clientRequestId: 'create-1' });
    assert.deepEqual(first.result, second.result);
    assert.equal(first.result.sessionId, 'h-owned');
    assert.equal(first.result.options.workspaceRoot, '/repo');
  });
});

test('unknown methods fail closed', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('bogus');
    assert.equal(response.ok, false);
    assert.equal(response.error, 'Harness does not support bogus.');
  });
});

test('retired agent verbs are refused', async () => {
  await withBridge(async (bridge) => {
    for (const method of ['startLogin', 'cancelLogin', 'usage', 'forkSession', 'readOutput', 'pageHistory', 'userShell', 'updateCli']) {
      const response = await bridge.request(method, {});
      assert.equal(response.ok, false, method);
      assert.match(response.error, /does not support/, method);
    }
  });
});

test('non-Error failures serialize through String()', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('sendTurn', { sessionId: 'h-owned', text: 'throw-string' });
    assert.equal(response.ok, false);
    assert.equal(response.error, 'plain-string-boom');
  });
});

test('detect reports the built-in agent, ready once a provider has a key', async () => {
  await withBridge(async (bridge) => {
    const bare = await bridge.request('detect', {});
    assert.equal(bare.ok, true);
    assert.equal(bare.result.agents.length, 1);
    assert.equal(bare.result.agents[0].id, 'harness');
    assert.equal(bare.result.agents[0].found, true);
    assert.equal(bare.result.agents[0].authenticated, false);
    const ready = await bridge.request('detect', { harnessProviders: ['anthropic'] });
    assert.equal(ready.result.agents[0].authenticated, true);
  });
});

test('lifecycle verbs start and stop the Harness', async () => {
  await withBridge(async (bridge) => {
    const started = await bridge.request('startHost', {});
    assert.equal(started.result.started, true);
    assert.equal(started.result.agentId, 'harness');
    assert.equal(started.result.isolation.osSandbox, 'enforced');
    assert.deepEqual((await bridge.request('stopHost', {})).result, { stopped: true });
  });
});

test('session verbs route to the Harness with their parameters', async () => {
  await withBridge(async (bridge) => {
    await bridge.request('startSession', { workspaceRoot: '/repo' });
    assert.deepEqual((await bridge.request('steerTurn', { sessionId: 'h-owned', text: 'also this' })).result, { turnId: 'h-steered', text: 'also this' });
    assert.deepEqual((await bridge.request('unqueueTurn', { sessionId: 'h-owned', turnId: 't-2' })).result, { turnId: 't-2', unqueued: true });
    assert.deepEqual((await bridge.request('cancelTurn', { sessionId: 'h-owned' })).result, { cancelled: true });
    assert.deepEqual((await bridge.request('decideApproval', { approvalId: 'h-1', choiceId: 'allow' })).result, { decided: 'h-1', choice: 'allow' });
    assert.deepEqual((await bridge.request('setModel', { sessionId: 'h-owned', modelId: 'anthropic/x' })).result, { model: 'anthropic/x' });
    assert.deepEqual((await bridge.request('setSessionOption', { sessionId: 'h-owned', option: 'effort', value: 'high' })).result, { option: 'effort', value: 'high' });
    assert.deepEqual((await bridge.request('setApprovalMode', { sessionId: 'h-owned', mode: 'auto' })).result, { mode: 'auto' });
    assert.deepEqual((await bridge.request('listSessions', { workspaceRoot: '/repo' })).result, { sessions: [{ sessionId: 'h-owned' }] });
    const skill = await bridge.request('sendTurn', { sessionId: 'h-owned', text: 'go', skill: { selector: 'review', arguments: 42 } });
    assert.deepEqual(skill.result.skill, { selector: 'review' }, 'non-string skill arguments are dropped');
  });
});

test('permission rules keep only allow and deny entries with a rule', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('harnessRules', { rules: [
      { effect: 'allow', rule: 'Bash(git status)' },
      { effect: 'maybe', rule: 'Bash(rm)' },
      { effect: 'deny', rule: 7 },
      { effect: 'deny', rule: 'Read(.env)' },
    ] });
    assert.deepEqual(response.result.rules, [{ effect: 'allow', rule: 'Bash(git status)' }, { effect: 'deny', rule: 'Read(.env)' }]);
  });
});

test('question responses require a response object', async () => {
  await withBridge(async (bridge) => {
    const missing = await bridge.request('respondUserInput', { sessionId: 'h-owned', userInputId: 'q-1' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'Question response is required.');
    const answered = await bridge.request('respondUserInput', { sessionId: 'h-owned', userInputId: 'q-1', response: { answers: {} } });
    assert.deepEqual(answered.result, { status: 'accepted' });
  });
});

test('sendTurn validates the busy disposition', async () => {
  await withBridge(async (bridge) => {
    const queued = await bridge.request('sendTurn', { sessionId: 'h-owned', text: 'go', ifBusy: 'queue' });
    assert.equal(queued.result.ifBusy, 'queue');
    const bad = await bridge.request('sendTurn', { sessionId: 'h-owned', text: 'go', ifBusy: 'later' });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'Busy disposition must be queue, steer, or replace.');
  });
});

test('failures keep the provider failure code beside the message', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('sendTurn', { sessionId: 'h-owned', text: 'throw-coded' });
    assert.equal(response.ok, false);
    assert.equal(response.error, 'friendly wrapper');
    assert.equal(response.code, 'RATE_LIMIT');
  });
});

test('dispatch failures redact labelled and natively supplied credential canaries', async () => {
  await withBridge(async (bridge) => {
    const labelled = await bridge.request('sendTurn', { sessionId: 'h-owned', text: 'throw-credential' });
    assert.equal(labelled.ok, false);
    assert.ok(!JSON.stringify(labelled).includes('CANARY'));
    const known = await bridge.request('sendTurn', { sessionId: 'h-owned', text: 'throw-known-key', providerKeys: { anthropic: { key: 'CANARY-KNOWN-KEY' } } });
    assert.equal(known.ok, false);
    assert.ok(!JSON.stringify(known).includes('CANARY'));
  });
});

// A verb that never answers holds its queue slot, and enqueue serializes per
// session, so a wedged request blocks every later call on that key - including
// the cancelTurn the user reaches for to stop the thing that is stuck.
test('a verb that never answers releases its queue slot instead of blocking the session', async () => {
  await withBridge(async (bridge) => {
    const hung = bridge.request('listModels', {});
    const guarded = hung.then((response) => response, (error) => ({ ok: false, error: String(error) }));
    const after = await bridge.request('ping', undefined);
    assert.equal(after.ok, true, 'a wedged verb must not take the process down with it');
    const settled = await guarded;
    assert.equal(settled.ok, false);
    assert.match(settled.error, /result is unknown/, 'the renderer needs the unknown-result wording to keep the turn retryable');
  }, { GLITTER_WORK_CEILING_MS: '150', GLITTER_TEST_HANG_MODELS: '1' });
});

// sendTurn awaits the submit acknowledgement, not the turn itself. A wedged
// ack would park the session's queue slot forever, the user's Stop included.
test('a wedged send acknowledgement is bounded instead of freezing the session', async () => {
  await withBridge(async (bridge) => {
    const hung = bridge.request('sendTurn', { sessionId: 'h-owned', text: 'go' });
    const guarded = hung.then((response) => response, (error) => ({ ok: false, error: String(error) }));
    const after = await bridge.request('cancelTurn', { sessionId: 'h-owned' });
    assert.equal(after.ok, true, 'the user must still be able to stop the turn');
    const settled = await guarded;
    assert.equal(settled.ok, false);
    assert.match(settled.error, /result is unknown/);
  }, { GLITTER_WORK_CEILING_MS: '150', GLITTER_TEST_HANG_SUBMIT: '1' });
});

// `closeSession` is the one verb that ends a session's life, and it must
// release the session so the process does not grow for its lifetime.
test('closeSession releases the session and can be resumed afterwards', async () => {
  await withBridge(async (bridge) => {
    const started = await bridge.request('startSession', { workspaceRoot: '/ws-a' });
    const sessionId = started.result.sessionId;
    assert.deepEqual((await bridge.request('closeSession', { sessionId })).result, { closed: true });
    assert.deepEqual((await bridge.request('listSessions', {})).result, { sessions: [] });
    const resumed = await bridge.request('resumeSession', { sessionId, workspaceRoot: '/ws-a' });
    assert.equal(resumed.ok, true, 'a released session can be resumed again');
    assert.equal((await bridge.request('closeSession', { sessionId: 'never-opened' })).ok, true, 'closing an unknown session is a no-op');
    assert.equal((await bridge.request('closeSession', { sessionId: 'someone-else' })).ok, false);
  });
});
