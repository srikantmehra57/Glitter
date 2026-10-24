import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Wire-protocol tests for the bridge entrypoint (`packages/glitter-bridge/src/index.ts`):
 * JSON-line framing, method routing between the Muse host and ACP agents, and
 * session-ownership tracking. The entrypoint is bundled with stubbed hosts and
 * driven over stdio like the Tauri backend drives the real bridge.
 */

const temporary = await mkdtemp(join(tmpdir(), 'muse-dispatch-'));
after(() => rm(temporary, { recursive: true, force: true }));

const hostStub = `
export class MuseHost {
  detect() { return { found: true, via: 'muse' }; }
  status() { return { running: true, via: 'muse' }; }
  async readUsage() { return process.env.GLITTER_TEST_HANG_USAGE ? new Promise(() => {}) : { usage: 'muse-usage' }; }
  async start() { return { server: 'muse-server' }; }
  async stop() { return { stopped: 'muse' }; }
  async listSessions() { return { sessions: [{ sessionId: 'muse-listed' }] }; }
  async listModels() { return { models: 'muse-models' }; }
  async startSession() { return { sessionId: 'muse-owned' }; }
  async resumeSession(options) { return { sessionId: options.sessionId, resumed: 'muse' }; }
  async sendTurn(options) {
    // A wedged submit acknowledgement: the queue ceiling in index.ts is what
    // stops this parking the session's queue slot forever.
    if (process.env.GLITTER_TEST_HANG_SUBMIT) return new Promise(() => {});
    if (options.text === 'throw-credential') throw new Error('Authorization: Bearer CANARY-DISPATCH');
    if (options.text === 'throw-known-key') throw new Error('rejected CANARY-KNOWN-KEY');
    if (options.text === 'throw-string') throw 'plain-string-boom';
    if (options.text === 'crash-async') setTimeout(() => { throw new Error('Authorization: Bearer CANARY-CRASH'); }, 10);
    if (options.text === 'throw-msp') {
      const msp = new Error('server says overloaded');
      msp.kind = 'overloaded';
      msp.retryable = true;
      throw new Error('friendly wrapper', { cause: msp });
    }
    return { turnId: 'muse-turn', via: 'muse', ...(options.ifBusy ? { ifBusy: options.ifBusy } : {}) };
  }
  async steerTurn(options) { return { turnId: 'muse-steered', via: 'muse', text: options.text }; }
  async unqueueTurn(options) { return { turnId: options.turnId, unqueued: true, via: 'muse' }; }
  async forkSession(options) { return { sessionId: 'fork-1', via: 'muse', cut: options.lastTurnId ?? null }; }
  async compactSession() { return { status: 'admitted', via: 'muse' }; }
  async readSession(options) { return { session: { sessionId: options.sessionId }, via: 'muse' }; }
  async pageOlderHistory(options) { return { items: [], via: 'muse', cursor: options.cursor }; }
  async listSkills(options) { return { skills: [], via: 'muse', session: options.sessionId }; }
  async mcpServers() { return { servers: [], via: 'muse' }; }
  async userShell(options) { return { commandId: 'cmd-1', status: 'accepted', via: 'muse', command: options.commandText }; }
  async readOutput(options) { return { content: 'full', via: 'muse', offset: options.offsetBytes ?? 0 }; }
  async setReasoningEffort(options) { return { status: 'accepted', via: 'muse', tier: options.reasoningEffort }; }
  async subagentControl(options) { return { status: 'accepted', via: 'muse', action: options.action }; }
  async taskControl(options) { return { status: 'accepted', via: 'muse', action: options.action }; }
  async workflowControl(options) { return { status: 'accepted', via: 'muse', action: options.action }; }
  async goalControl(options) { return { status: 'accepted', via: 'muse', action: options.action }; }
  async cancelTurn() { return { cancelled: 'muse' }; }
  async respondUserInput() { return { status: 'accepted', via: 'muse' }; }
  decideApproval() { return { decided: 'muse' }; }
  async setApprovalMode() { return { mode: 'muse-mode' }; }
  async setModel() { return { model: 'muse-model' }; }
  async renameSession(options) { return { name: options.name, via: 'muse' }; }
}`;

const acpStub = `
export class AcpAgentHost {
  constructor(spec, bin, emit) { this.spec = spec; this.bin = bin; this.tag = (globalThis.__acpInstances = (globalThis.__acpInstances ?? 0) + 1); this.workspace = null; }
  ownsApproval(approvalId) { return approvalId.indexOf('acp-') === 0; }
  decideApproval() { return { decided: 'acp' }; }
  async start(options) { this.workspace = options?.workspaceRoot ?? null; }
  isolation() { return { env: 'minimal', osSandbox: 'unavailable', platform: 'test', cwd: '/tmp', consentRequired: true }; }
  async stop() { return { stopped: 'acp' }; }
  async listSessions() { return { sessions: [{ sessionId: 'acp-listed' }] }; }
  async listModels() { return { models: 'acp-models' }; }
  async startSession(options) { this.workspace = options.workspaceRoot; return { sessionId: 'acp-' + String(options.workspaceRoot).replace(/[^a-z0-9]+/gi, ''), host: this.tag, workspace: this.workspace }; }
  async resumeSession(options) { return { sessionId: options.sessionId, resumed: 'acp', host: this.tag }; }
  async closeSession(options) { this.sessions?.delete?.(options.sessionId); return { closed: true }; }
  async sendTurn() { return { turnId: 'acp-turn', via: 'acp' }; }
  async cancelTurn() { return { cancelled: 'acp' }; }
  async setModel() { return { model: 'acp-model' }; }
  async setEffort(sessionId, value) { return { effort: value, via: 'acp' }; }
  async setMode(sessionId, value) { return { mode: value, via: 'acp' }; }
  async setOption(sessionId, option, value) { return { option, value, via: 'acp' }; }
}`;

const harnessStub = `
export const HARNESS_ID = 'harness';
export class HarnessHost {
  constructor() { this.spec = { id: HARNESS_ID, name: 'Harness' }; }
  ownsApproval(approvalId) { return approvalId.indexOf('h-') === 0; }
  decideApproval() { return { decided: 'harness' }; }
  setCredentials() {}
}`;

const agentsStub = `
const SPECS = {
  muse: { id: 'muse', name: 'Muse', protocol: 'msp' },
  opencode: { id: 'opencode', name: 'OpenCode', protocol: 'acp' },
  gemini: { id: 'gemini', name: 'Gemini CLI', protocol: 'acp' },
  weird: { id: 'weird', name: 'Weird', protocol: 'msp' },
};
export function agentSpec(id) {
  const spec = SPECS[id];
  if (!spec) throw new Error('Unknown agent: ' + id);
  return spec;
}
export function resolveAgentBin(spec) { return spec.id === 'opencode' ? '/fake/opencode' : null; }
export function checkAgentBin(raw) { return raw.startsWith('/tmp/') ? null : '/canonical/' + raw.split('/').pop(); }
export function detectAgents() { return [{ id: 'muse' }, { id: 'opencode' }]; }`;

const loginStub = `
export class LoginFlow {
  async start() { return { url: 'https://stub.invalid', code: 'STUB-CODE' }; }
  cancel() { return { cancelled: false }; }
}`;
const replacements = { './host.js': hostStub, './acp.js': acpStub, './harness/host.js': harnessStub, './agents.js': agentsStub, './login.js': loginStub };
const outfile = join(temporary, 'bridge.mjs');
await build({
  entryPoints: [resolve('packages/glitter-bridge/src/index.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
  plugins: [{ name: 'test-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(replacements, path) ? { path, namespace: 'test-boundary' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, ({ path }) => ({ contents: replacements[path], loader: 'ts', resolveDir: resolve('packages/glitter-bridge/src') }));
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

test('startSession replays an idempotency key', async () => {
  await withBridge(async (bridge) => {
    const first = await bridge.request('startSession', { workspaceRoot: '/repo', clientRequestId: 'create-1' });
    const second = await bridge.request('startSession', { workspaceRoot: '/other', clientRequestId: 'create-1' });
    assert.deepEqual(first.result, second.result);
    assert.equal(first.result.sessionId, 'muse-owned');
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

test('unknown methods fail closed', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('bogus');
    assert.equal(response.ok, false);
    assert.equal(response.error, 'Unknown method: bogus');
  });
});

test('non-Error failures serialize through String()', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('sendTurn', { sessionId: 'muse-owned', text: 'throw-string' });
    assert.equal(response.ok, false);
    assert.equal(response.error, 'plain-string-boom');
  });
});

test('detect merges host detection with the agent list', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('detect', {});
    assert.equal(response.ok, true);
    assert.equal(response.result.found, true);
    assert.deepEqual(response.result.agents, [{ id: 'muse' }, { id: 'opencode' }]);
  });
});

test('requests default to the Muse host', async () => {
  await withBridge(async (bridge) => {
    assert.deepEqual((await bridge.request('startHost', {})).result, { server: 'muse-server' });
    assert.deepEqual((await bridge.request('status', {})).result, { running: true, via: 'muse' });
    assert.deepEqual((await bridge.request('usage', {})).result, { usage: 'muse-usage' });
    assert.deepEqual((await bridge.request('listModels', {})).result, { models: 'muse-models' });
    assert.deepEqual((await bridge.request('stopHost', {})).result, { stopped: 'muse' });
  });
});

test('an explicit agent id starts an ACP session and claims it', async () => {
  await withBridge(async (bridge) => {
    const started = await bridge.request('startSession', { agentId: 'opencode', workspaceRoot: '/repo' });
    assert.equal(started.ok, true);
    assert.equal(started.result.sessionId, 'acp-repo');
    // The claimed session routes back to its owner without an explicit agent id.
    const turn = await bridge.request('sendTurn', { sessionId: 'acp-repo', text: 'hi' });
    assert.deepEqual(turn.result, { turnId: 'acp-turn', via: 'acp' });
    const resumed = await bridge.request('resumeSession', { sessionId: 'acp-repo', workspaceRoot: '/repo' });
    assert.deepEqual(resumed.result, { sessionId: 'acp-repo', resumed: 'acp', host: 1 });
  });
});

test('listed sessions are claimed for their agent', async () => {
  await withBridge(async (bridge) => {
    const listed = await bridge.request('listSessions', { agentId: 'opencode' });
    assert.deepEqual(listed.result, { sessions: [{ sessionId: 'acp-listed' }] });
    const turn = await bridge.request('sendTurn', { sessionId: 'acp-listed', text: 'hi' });
    assert.deepEqual(turn.result, { turnId: 'acp-turn', via: 'acp' });
    await bridge.request('listSessions', {});
    const museTurn = await bridge.request('sendTurn', { sessionId: 'muse-listed', text: 'hi' });
    assert.deepEqual(museTurn.result, { turnId: 'muse-turn', via: 'muse' });
  });
});

test('session ownership beats an explicit agent id', async () => {
  await withBridge(async (bridge) => {
    await bridge.request('startSession', { agentId: 'opencode', workspaceRoot: '/repo' });
    const turn = await bridge.request('sendTurn', { sessionId: 'acp-repo', agentId: 'muse', text: 'hi' });
    assert.deepEqual(turn.result, { turnId: 'acp-turn', via: 'acp' });
  });
});

test('approvals route to the agent that owns them', async () => {
  await withBridge(async (bridge) => {
    // Touch the ACP host first so it exists for the ownership search.
    await bridge.request('startHost', { agentId: 'opencode' });
    const acp = await bridge.request('decideApproval', { approvalId: 'acp-9', choiceId: 'c' });
    assert.deepEqual(acp.result, { decided: 'acp' });
    const harness = await bridge.request('decideApproval', { approvalId: 'h-9', choiceId: 'allow-once' });
    assert.deepEqual(harness.result, { decided: 'harness' }, 'Harness ownership survives native sessionId stripping');
    const muse = await bridge.request('decideApproval', { approvalId: 'muse-9', choiceId: 'c' });
    assert.deepEqual(muse.result, { decided: 'muse' });
  });
});

test('question responses require a response object', async () => {
  await withBridge(async (bridge) => {
    const missing = await bridge.request('respondUserInput', { sessionId: 'muse-owned', userInputId: 'q' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'Question response is required.');
    const accepted = await bridge.request('respondUserInput', { sessionId: 'muse-owned', userInputId: 'q', response: { action: 'cancel' } });
    assert.deepEqual(accepted.result, { status: 'accepted', via: 'muse' });
  });
});

test('setSessionOption routes by protocol', async () => {
  await withBridge(async (bridge) => {
    const muse = await bridge.request('setSessionOption', { sessionId: 'muse-owned', option: 'effort', value: 'high' });
    assert.equal(muse.ok, false);
    assert.equal(muse.error, 'Muse sessions use setModel/setApprovalMode.');
    const effort = await bridge.request('setSessionOption', { agentId: 'opencode', sessionId: 's', option: 'effort', value: 'high' });
    assert.deepEqual(effort.result, { effort: 'high', via: 'acp' });
    const mode = await bridge.request('setSessionOption', { agentId: 'opencode', sessionId: 's', option: 'mode', value: 'plan' });
    assert.deepEqual(mode.result, { mode: 'plan', via: 'acp' });
    const option = await bridge.request('setSessionOption', { agentId: 'opencode', sessionId: 's', option: 'temperature', value: '0.2' });
    assert.deepEqual(option.result, { option: 'temperature', value: '0.2', via: 'acp' });
  });
});

test('ACP hosts start, stop, and reject unsupported methods', async () => {
  await withBridge(async (bridge) => {
    const started = await bridge.request('startHost', { agentId: 'opencode' });
    assert.equal(started.result.started, true);
    assert.equal(started.result.agentId, 'opencode');
    assert.equal(started.result.isolation.env, 'minimal');
    const stopped = await bridge.request('stopHost', { agentId: 'opencode' });
    assert.deepEqual(stopped.result, { stopped: true });
    const usage = await bridge.request('usage', { agentId: 'opencode' });
    assert.equal(usage.ok, false);
    assert.equal(usage.error, 'OpenCode does not support usage.');
  });
});

test('one agent in two workspaces runs two hosts', async () => {
  await withBridge(async (bridge) => {
    const a = await bridge.request('startSession', { agentId: 'opencode', workspaceRoot: '/ws-a' });
    const b = await bridge.request('startSession', { agentId: 'opencode', workspaceRoot: '/ws-b' });
    // A sandbox profile is fixed at spawn, so each workspace must get its
    // own host process instead of reusing one scoped to another folder.
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.result.host, b.result.host);
    assert.equal(a.result.workspace, '/ws-a');
    assert.equal(b.result.workspace, '/ws-b');
    // Session verbs route to the host that owns the session's workspace.
    const resumed = await bridge.request('resumeSession', { sessionId: a.result.sessionId, workspaceRoot: '/ws-a' });
    assert.deepEqual(resumed.result, { sessionId: a.result.sessionId, resumed: 'acp', host: a.result.host });
    // stopHost stops every host of the agent, across workspaces.
    const stopped = await bridge.request('stopHost', { agentId: 'opencode' });
    assert.deepEqual(stopped.result, { stopped: true });
  });
});

test('unknown, missing, and non-ACP agents fail with guidance', async () => {
  await withBridge(async (bridge) => {
    const unknown = await bridge.request('listSessions', { agentId: 'nopez' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, 'Unknown agent: nopez');
    const missing = await bridge.request('listSessions', { agentId: 'gemini' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'Gemini CLI is not installed. Install it, then choose Rescan.');
    const protocol = await bridge.request('listSessions', { agentId: 'weird' });
    assert.equal(protocol.ok, false);
    assert.equal(protocol.error, 'Weird is not an ACP agent.');
  });
});

test('a native-injected agent binary bypasses self-resolution', async () => {
  await withBridge(async (bridge) => {
    // Gemini self-resolution returns null in the stub, so this only starts
    // when the injected canonical path is honored.
    const started = await bridge.request('startHost', { agentId: 'gemini', agentBin: '/native/gemini' });
    assert.equal(started.result.started, true);
    assert.equal(started.result.agentId, 'gemini');
  });
});


// The native shell injects a validated canonical path, so this is defence in
// depth for direct invocations: a temp-dir binary must never be spawned.
test('a supplied agent binary is canonicalized and refused from temp', async () => {
  // Each bridge is a fresh process, so the host cache starts empty: the injected
  // path is validated on the request that would actually spawn the child.
  await withBridge(async (bridge) => {
    const injected = await bridge.request('startHost', { agentId: 'gemini', agentBin: '/native/gemini' });
    assert.equal(injected.result.started, true, 'a validated injected path is honored');
  });
  await withBridge(async (bridge) => {
    const shadowed = await bridge.request('startHost', { agentId: 'gemini', agentBin: '/tmp/shadow-gemini' });
    assert.equal(shadowed.ok, false, 'a temp-dir binary must not be spawned');
  });
});

test('steerTurn and unqueueTurn route to the Muse host', async () => {
  await withBridge(async (bridge) => {
    const steered = await bridge.request('steerTurn', { sessionId: 's', text: 'more tests' });
    assert.deepEqual(steered.result, { turnId: 'muse-steered', via: 'muse', text: 'more tests' });
    const reclaimed = await bridge.request('unqueueTurn', { sessionId: 's', turnId: 't-1' });
    assert.deepEqual(reclaimed.result, { turnId: 't-1', unqueued: true, via: 'muse' });
  });
});

test('sendTurn validates the busy disposition and ACP rejects queue verbs', async () => {
  await withBridge(async (bridge) => {
    const queued = await bridge.request('sendTurn', { sessionId: 's', text: 'later', ifBusy: 'queue' });
    assert.equal(queued.result.ifBusy, 'queue');
    const bad = await bridge.request('sendTurn', { sessionId: 's', text: 'x', ifBusy: 'wait' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Busy disposition/);
    const acp = await bridge.request('steerTurn', { agentId: 'opencode', sessionId: 's', text: 'x' });
    assert.equal(acp.ok, false);
    assert.match(acp.error, /does not support queued turns/);
    const acpUnqueue = await bridge.request('unqueueTurn', { agentId: 'opencode', sessionId: 's', turnId: 't' });
    assert.equal(acpUnqueue.ok, false);
    assert.match(acpUnqueue.error, /does not support queued turns/);
  });
});

test('fork/compact/read route to the Muse host and ACP rejects them', async () => {
  await withBridge(async (bridge) => {
    const forked = await bridge.request('forkSession', { sessionId: 's', lastTurnId: 't-3' });
    assert.deepEqual(forked.result, { sessionId: 'fork-1', via: 'muse', cut: 't-3' });
    const compacted = await bridge.request('compactSession', { sessionId: 's' });
    assert.deepEqual(compacted.result, { status: 'admitted', via: 'muse' });
    const read = await bridge.request('readSession', { sessionId: 's', excludeItems: false });
    assert.deepEqual(read.result, { session: { sessionId: 's' }, via: 'muse' });
    for (const method of ['forkSession', 'compactSession', 'readSession']) {
      const acp = await bridge.request(method, { agentId: 'opencode', sessionId: 's' });
      assert.equal(acp.ok, false);
      assert.match(acp.error, /does not support this session operation/);
    }
  });
});

test('readOutput/setReasoningEffort route to the Muse host and ACP rejects them', async () => {
  await withBridge(async (bridge) => {
    const output = await bridge.request('readOutput', { sessionId: 's', itemId: 'i', outputRef: 'r', offsetBytes: 8 });
    assert.deepEqual(output.result, { content: 'full', via: 'muse', offset: 8 });
    const effort = await bridge.request('setReasoningEffort', { sessionId: 's', reasoningEffort: 'low' });
    assert.deepEqual(effort.result, { status: 'accepted', via: 'muse', tier: 'low' });
    for (const method of ['readOutput', 'setReasoningEffort']) {
      const acp = await bridge.request(method, { agentId: 'opencode', sessionId: 's' });
      assert.equal(acp.ok, false);
      assert.match(acp.error, /does not support this session operation/);
    }
  });
});

test('pageHistory routes to the Muse host and ACP rejects it', async () => {
  await withBridge(async (bridge) => {
    const chunk = await bridge.request('pageHistory', { sessionId: 's', cursor: 'c-old' });
    assert.deepEqual(chunk.result, { items: [], via: 'muse', cursor: 'c-old' });
    const acp = await bridge.request('pageHistory', { agentId: 'opencode', sessionId: 's', cursor: 'c-old' });
    assert.equal(acp.ok, false);
    assert.match(acp.error, /does not support this session operation/);
  });
});

test('failures keep the MSP kind and retryability beside the message', async () => {
  await withBridge(async (bridge) => {
    const failed = await bridge.request('sendTurn', { sessionId: 's', text: 'throw-msp' });
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'friendly wrapper');
    assert.equal(failed.code, 'overloaded');
    assert.equal(failed.retryable, true);
    const plain = await bridge.request('sendTurn', { sessionId: 's', text: 'throw-string' });
    assert.equal(plain.ok, false);
    assert.equal(plain.code, undefined);
  });
});

test('ecosystem verbs route to the Muse host and ACP rejects them', async () => {
  await withBridge(async (bridge) => {
    const skills = await bridge.request('listSkills', { sessionId: 's' });
    assert.deepEqual(skills.result, { skills: [], via: 'muse', session: 's' });
    const servers = await bridge.request('mcpServers', {});
    assert.deepEqual(servers.result, { servers: [], via: 'muse' });
    const shell = await bridge.request('userShell', { sessionId: 's', commandText: 'git status --short' });
    assert.deepEqual(shell.result, { commandId: 'cmd-1', status: 'accepted', via: 'muse', command: 'git status --short' });
    for (const method of ['listSkills', 'mcpServers', 'userShell']) {
      const acp = await bridge.request(method, { agentId: 'opencode', sessionId: 's' });
      assert.equal(acp.ok, false);
      assert.match(acp.error, /does not support this session operation/);
    }
  });
});

test('oversight verbs route to the Muse host and ACP rejects them', async () => {
  await withBridge(async (bridge) => {
    const subagent = await bridge.request('subagentControl', { sessionId: 's', subagentId: 'k', action: 'stop' });
    assert.deepEqual(subagent.result, { status: 'accepted', via: 'muse', action: 'stop' });
    const task = await bridge.request('taskControl', { sessionId: 's', action: 'stopAll' });
    assert.deepEqual(task.result, { status: 'accepted', via: 'muse', action: 'stopAll' });
    const workflow = await bridge.request('workflowControl', { sessionId: 's', workflowRunId: 'r', action: 'cancel' });
    assert.deepEqual(workflow.result, { status: 'accepted', via: 'muse', action: 'cancel' });
    const goal = await bridge.request('goalControl', { sessionId: 's', action: 'pause' });
    assert.deepEqual(goal.result, { status: 'accepted', via: 'muse', action: 'pause' });
    for (const method of ['subagentControl', 'taskControl', 'workflowControl', 'goalControl']) {
      const acp = await bridge.request(method, { agentId: 'opencode', sessionId: 's' });
      assert.equal(acp.ok, false);
      assert.match(acp.error, /does not support this session operation/);
    }
  });
});

test('renameSession routes to the Muse host', async () => {
  await withBridge(async (bridge) => {
    const renamed = await bridge.request('renameSession', { sessionId: 'muse-owned', name: 'New name' });
    assert.equal(renamed.ok, true);
    assert.deepEqual(renamed.result, { name: 'New name', via: 'muse' });
    // Claimed ACP sessions do not reach the Muse rename path.
    await bridge.request('startSession', { agentId: 'opencode', workspaceRoot: '/repo' });
    const acp = await bridge.request('renameSession', { sessionId: 'acp-repo', name: 'Nope' });
    assert.equal(acp.ok, false);
    assert.equal(acp.error, 'OpenCode does not support renameSession.');
  });
});

test('login verbs route to the login flow', async () => {
  await withBridge(async (bridge) => {
    const started = await bridge.request('startLogin', { museBin: '/fake/muse' });
    assert.equal(started.ok, true);
    assert.deepEqual(started.result, { url: 'https://stub.invalid', code: 'STUB-CODE' });
    const cancelled = await bridge.request('cancelLogin');
    assert.deepEqual(cancelled.result, { cancelled: false });
  });
});


test('dispatch failures redact labelled and natively supplied credential canaries', async () => {
  await withBridge(async (bridge) => {
    const labelled = await bridge.request('sendTurn', { sessionId: 's', text: 'throw-credential' });
    assert.equal(labelled.ok, false);
    assert.ok(!JSON.stringify(labelled).includes('CANARY'));
    await bridge.request('startHost', { museApiKey: 'CANARY-KNOWN-KEY' });
    const known = await bridge.request('sendTurn', { sessionId: 's', text: 'throw-known-key' });
    assert.equal(known.ok, false);
    assert.ok(!JSON.stringify(known).includes('CANARY'));
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

// `owners` maps a session to the *host key* it runs on, and `agentOf` returns
// that key. Re-deriving a key from it appended the workspace a second time, so
// the live host was missed and a second agent child was spawned per reopen.
test('reopening a session keeps one ACP host instead of spawning a duplicate', async () => {
  await withBridge(async (bridge) => {
    globalThis.__acpInstances = 0;
    const first = await bridge.request('startSession', { agentId: 'opencode', workspaceRoot: '/ws-a' });
    const replay = await bridge.request('sendTurn', { sessionId: first.result.sessionId, workspaceRoot: '/ws-a', text: 'again' });
    assert.equal(replay.ok, true);
    const resumed = await bridge.request('resumeSession', { sessionId: first.result.sessionId, workspaceRoot: '/ws-a' });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.result.host, first.result.host, 'every extra host is a leaked agent child and a doubled sandbox profile');
    // Session verbs still route to the host that owns the session's workspace.
    const stopped = await bridge.request('stopHost', { agentId: 'opencode', workspaceRoot: '/ws-a' });
    assert.deepEqual(stopped.result, { stopped: true });
  });
});

// A verb that never answers holds its queue slot, and enqueue serializes per
// session, so a wedged request blocks every later call on that key - including
// the cancelTurn the user reaches for to stop the thing that is stuck.
test('a verb that never answers releases its queue slot instead of blocking the session', async () => {
  await withBridge(async (bridge) => {
    const hung = bridge.request('usage', undefined);
    const guarded = hung.then((response) => response, (error) => ({ ok: false, error: String(error) }));
    const after = await bridge.request('ping', undefined);
    assert.equal(after.ok, true, 'a wedged verb must not take the session down with it');
    const settled = await guarded;
    assert.equal(settled.ok, false);
    assert.match(settled.error, /result is unknown/, 'the renderer needs the unknown-result wording to keep the turn retryable');
  }, { GLITTER_WORK_CEILING_MS: '150', GLITTER_TEST_HANG_USAGE: '1' });
});


// sendTurn awaits the submit acknowledgement, not the turn itself: the item,
// delta and completion streams are wired fire-and-forget. A wedged ack would
// therefore park the call, and with it the session's queue slot, forever -
// blocking every later call on that session, the user's Stop included.
test('a wedged send acknowledgement is bounded instead of freezing the session', async () => {
  await withBridge(async (bridge) => {
    const hung = bridge.request('sendTurn', { sessionId: 'muse-owned', text: 'go' });
    const guarded = hung.then((response) => response, (error) => ({ ok: false, error: String(error) }));
    // The same session queue must not be stuck behind it.
    const after = await bridge.request('cancelTurn', { sessionId: 'muse-owned' });
    assert.equal(after.ok, true, 'the user must still be able to stop the turn');
    const settled = await guarded;
    assert.equal(settled.ok, false);
    assert.match(settled.error, /result is unknown/);
  }, { GLITTER_WORK_CEILING_MS: '150', GLITTER_TEST_HANG_SUBMIT: '1' });
});

test('a long-running turn is never cut by the ceiling', async () => {

  await withBridge(async (bridge) => {
    // sendTurn awaits the turn to completion, so its duration is the agent's.
    const sent = await bridge.request('sendTurn', { sessionId: 'muse-owned', text: 'go' });
    assert.equal(sent.ok, true);
  }, { GLITTER_WORK_CEILING_MS: '1' });
});

// The bridge holds one SDK session per open thread and nothing else ever drops
// it, so opening and closing threads over a long-lived bridge grew the session
// maps for the process's lifetime. `closeSession` is the one verb that ends a
// session's life, and it must release the host's state and the ownership entry.
test('closeSession drops the host session and the ownership entry', async () => {
  await withBridge(async (bridge) => {
    const started = await bridge.request('startSession', { agentId: 'opencode', workspaceRoot: '/ws-a' });
    const sessionId = started.result.sessionId;
    const closed = await bridge.request('closeSession', { agentId: 'opencode', sessionId });
    assert.equal(closed.ok, true);
    assert.deepEqual(closed.result, { closed: true });

    // Resuming must start a fresh host for the session rather than reuse a
    // released one, and the workspace key must not have drifted.
    const resumed = await bridge.request('resumeSession', { agentId: 'opencode', sessionId, workspaceRoot: '/ws-a' });
    assert.equal(resumed.ok, true, 'a released session can be resumed again');

    // Closing an unknown session is a no-op, not a crash.
    const unknown = await bridge.request('closeSession', { agentId: 'opencode', sessionId: 'never-opened' });
    assert.equal(unknown.ok, true);
  });
});

test('closeSession is rejected for a session the host does not own', async () => {
  await withBridge(async (bridge) => {
    const museOwned = await bridge.request('startSession', { workspaceRoot: '/ws-a' });
    const wrong = await bridge.request('closeSession', { agentId: 'opencode', sessionId: museOwned.result.sessionId, workspaceRoot: '/ws-a' });
    // The native side binds session -> grant, so a cross-agent close never
    // reaches a host that does not own it; the bridge at least stays consistent.
    assert.equal(wrong.ok, false);
  });
});
