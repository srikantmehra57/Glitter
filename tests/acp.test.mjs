import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-acp-'));
const outfile = join(temporary, 'acp.mjs');
await build({ entryPoints: [resolve('packages/glitter-bridge/src/acp.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const { AcpAgentHost, fatalProviderError, zenFreeModel, fallbackOpencodeModel, modelIdsFromError, modelOption, applyClineFree, fetchClineFreeIds, opencodeModelsFromCatalog, disabledOpencodeModelIds, mergeOpencodeModels } = await import(pathToFileURL(outfile).href);

test('rate limits and disabled models are fatal provider errors', () => {
  assert.equal(fatalProviderError('mimo-v2.5-free: Rate limit exceeded. Please try again later.'), true);
  assert.equal(fatalProviderError('Model access is disabled'), true);
  assert.equal(fatalProviderError('Upstream request failed: Insufficient account funds'), true);
  assert.equal(fatalProviderError('timeout waiting for stream'), false);
});

test('the OpenCode catalog keeps every Zen model the workspace has not turned off', () => {
  const disabled = disabledOpencodeModelIds({ providers: { opencode: { models: { 'big-pickle': { disabled: true }, 'gpt-6-astra': { name: 'kept' } } } } });
  assert.deepEqual([...disabled], ['big-pickle']);
  const catalog = opencodeModelsFromCatalog({
    opencode: { models: {
      'gpt-6-astra': { name: 'GPT-6 Astra', cost: { input: 10, output: 50 }, limit: { context: 1050000 }, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
      'deepseek-v4.1-flash-free': { name: 'DeepSeek V4.1 Flash Free', cost: { input: 0, output: 0 }, limit: { context: 200000 } },
      'big-pickle': { name: 'Big Pickle', cost: { input: 0, output: 0 } },
    } },
  }, disabled);
  assert.deepEqual(catalog.map((model) => model.modelId), ['opencode/gpt-6-astra', 'opencode/deepseek-v4.1-flash-free']);
  assert.equal(catalog[0].displayLabel, 'GPT-6 Astra');
  assert.equal(catalog[0].contextLimit, 1050000);
  assert.deepEqual(catalog[0].reasoningEfforts, ['low', 'high']);
  assert.equal(catalog[1].description, 'Free');
  const merged = mergeOpencodeModels([
    { modelId: 'opencode/gpt-6-astra', isActive: true, reasoningEfforts: ['high'] },
    { modelId: 'opencode/only-session', displayLabel: 'Only session' },
  ], catalog);
  assert.equal(merged.find((model) => model.modelId === 'opencode/gpt-6-astra').isActive, true);
  assert.deepEqual(merged.find((model) => model.modelId === 'opencode/gpt-6-astra').reasoningEfforts, ['high']);
  assert.equal(merged.at(-1).modelId, 'opencode/only-session');
  assert.deepEqual(mergeOpencodeModels([{ modelId: 'zen/a' }], []).map((model) => model.modelId), ['zen/a']);
});

test('OpenCode Free Zen models fall back to Big Pickle instead of another gated Free row', () => {
  assert.equal(zenFreeModel('opencode/nemotron-3.5-lightning-free'), true);
  assert.equal(zenFreeModel('opencode/muse-spark-1.2-contributor-free'), true);
  assert.equal(zenFreeModel('opencode/big-pickle'), false);
  const catalog = [
    { modelId: 'opencode/mimo-v2.5-free' },
    { modelId: 'opencode/big-pickle' },
    { modelId: 'opencode/claude-sonnet-5' },
  ];
  assert.equal(fallbackOpencodeModel(catalog, 'opencode/nemotron-3.5-lightning-free'), 'opencode/big-pickle');
  assert.equal(fallbackOpencodeModel(catalog, 'opencode/muse-spark-1.2-contributor-free'), 'opencode/big-pickle');
  assert.equal(fallbackOpencodeModel([{ modelId: 'opencode/claude-sonnet-5' }], 'opencode/claude-sonnet-5'), undefined);
  assert.deepEqual(modelIdsFromError('nemotron-3.5-lightning-free: Upstream request failed: Model access is disabled.'), ['nemotron-3.5-lightning-free', 'opencode/nemotron-3.5-lightning-free']);
});

function fakeAgent(agentId = 'fake', flags = []) {
  const events = [];
  const spec = { id: agentId, name: 'Fake', protocol: 'acp', bins: [], acpArgs: [resolve('tests/fixtures/fake-acp-agent.mjs'), ...flags], verified: true, signIn: '' };
  let host;
  host = new AcpAgentHost(spec, process.execPath, (event, payload) => {
    events.push({ event, payload });
    if (event === 'approval') host.decideApproval({ approvalId: payload.approvalId, choiceId: payload.availableChoices[0].choiceId });
  });
  return { host, events };
}

/** Cline files its provider picker under the `model` category beside the model list. */
const clineConfig = [
  { id: 'provider', category: 'model', type: 'select', currentValue: 'cline', options: [{ value: 'cline', name: 'Cline Usage-Billing' }, { value: 'cline-pass', name: 'ClinePass' }] },
  { id: 'model', category: 'model', type: 'select', currentValue: 'anthropic/claude-sonnet-5.5', options: [{ value: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5' }, { value: 'openai/gpt-5.6', name: 'GPT-5.6' }] },
  { id: 'mode', category: 'mode', type: 'select', currentValue: 'act', options: [{ value: 'plan', name: 'Plan' }, { value: 'act', name: 'Act' }] },
];

test('a Cline model is free only while Cline still promotes it', async () => {
  const listed = await fetchClineFreeIds(async () => ({ ok: true, json: async () => ({ free: [{ id: 'cline-free/minimax-m3.1-flash', name: 'Minimax M3.1 Flash' }, { id: '' }, { name: 'skipped' }] }) }));
  assert.deepEqual(listed, [{ id: 'cline-free/minimax-m3.1-flash', name: 'Minimax M3.1 Flash' }]);
  assert.equal(await fetchClineFreeIds(async () => { throw new Error('offline'); }), null);
  const models = [
    { modelId: 'nvidia/nemotron-3-ultra:free', displayLabel: 'Nemotron 3 Ultra (free)', description: 'Free' },
    { modelId: 'nemotron-3.5-lightning-free', displayLabel: 'Nemotron 3.5 Lightning (free)', providerId: 'nvidia' },
    { modelId: 'cline-free/solar-mini4', displayLabel: 'Solar Mini 4 (free)' },
  ];
  const free = [
    { id: 'nvidia/nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning' },
    { id: 'cline-free/solar-mini4', name: 'Solar Mini 4' },
    { id: 'cline-free/minimax-m3.1-flash', name: 'Minimax M3.1 Flash', description: 'Next-generation Flash model' },
  ];
  const applied = applyClineFree(models, free);
  assert.equal(applied[0].modelId, 'cline-free/minimax-m3.1-flash');
  assert.equal(applied[0].free, true);
  assert.equal(applied[0].displayLabel, 'Minimax M3.1 Flash');
  assert.equal(applied.find((model) => model.modelId === 'nvidia/nemotron-3-ultra:free').free, false);
  assert.equal(applied.find((model) => model.modelId === 'nvidia/nemotron-3-ultra:free').displayLabel, 'Nemotron 3 Ultra');
  assert.equal(applied.find((model) => model.modelId === 'nemotron-3.5-lightning-free').free, true);
  assert.equal(applied.find((model) => model.modelId === 'cline-free/solar-mini4').free, true);
});

test('a provider picker filed under the model category is not mistaken for the model list', () => {
  assert.equal(modelOption(clineConfig)?.id, 'model', 'the option named model wins');
  assert.equal(modelOption([{ id: 'picked', category: 'model', options: [] }])?.id, 'picked', 'the category is the fallback');
  assert.equal(modelOption([]), undefined);
  const host = new AcpAgentHost({ id: 'cline', name: 'Cline CLI', protocol: 'acp', bins: [], acpArgs: [], verified: false, signIn: '' }, process.execPath, () => {});
  const models = host.modelsFromConfig(clineConfig);
  assert.deepEqual(models.map((model) => model.modelId), ['anthropic/claude-sonnet-5.5', 'openai/gpt-5.6']);
  assert.deepEqual(models.filter((model) => model.isActive).map((model) => model.modelId), ['anthropic/claude-sonnet-5.5']);
  assert.equal(models[0].providerId, 'anthropic', 'the vendor behind the model names the provider');
  host.track('s-1', '/repo', clineConfig);
  const config = host.sessionConfig('s-1');
  assert.equal(config.modelId, 'anthropic/claude-sonnet-5.5');
  assert.equal(config.mode, 'act');
  assert.deepEqual(config.modes.map((mode) => mode.value), ['plan', 'act']);
});

const until = async (events, predicate) => {
  for (let i = 0; i < 200 && !events.some(predicate); i++) await new Promise((r) => setTimeout(r, 10));
  return events.find(predicate);
};

test('OpenCode discovers models before a user thread through ACP, without the interactive models command', async () => {
  const { host, events } = fakeAgent('opencode');
  try {
    const [first, second] = await Promise.all([host.listModels(), host.listModels()]);
    assert.deepEqual(first.models.map((model) => model.modelId), ['zen/a', 'zen/b']);
    assert.deepEqual(second, first);
    assert.equal(first.source, 'catalog');
    assert.ok(!events.some(({ event }) => ['item', 'delta', 'turnStarted', 'sessionStarted'].includes(event)), 'model discovery sends no prompt or transcript events');
    assert.equal(host.sessions.size, 0, 'discovery does not create an owned UI session');
    const started = await host.startSession({ workspaceRoot: temporary });
    assert.equal(started.sessionId, 's2', 'concurrent catalog readers share one discovery session');
    assert.deepEqual((await host.listModels('s2')).models.map((model) => model.modelId), ['zen/a', 'zen/b']);
  } finally { await host.stop(); }
});

test('a new OpenCode thread learns its modes and a picked model\'s efforts before any session exists', async () => {
  const { host, events } = fakeAgent('opencode');
  try {
    const listed = await host.listModels();
    assert.deepEqual(listed.modes.map((mode) => mode.value), ['build', 'plan'], 'the catalog carries the agent\'s modes');
    assert.equal(listed.defaultMode, 'build');
    assert.equal(listed.models.find((model) => model.modelId === 'zen/b').reasoningEfforts, undefined, 'only the probe\'s active model reports efforts up front');
    const described = await host.listModels(undefined, false, 'zen/b');
    assert.deepEqual(described.models.find((model) => model.modelId === 'zen/b').reasoningEfforts, ['low', 'high', 'max'], 'a draft\'s picked model is described');
    assert.equal(host.sessions.size, 0, 'describing a model opens no UI session');
    assert.ok(!events.some(({ event }) => ['item', 'agentConfig'].includes(event)), 'the probe stays silent');
    const started = await host.startSession({ workspaceRoot: temporary, mode: 'plan' });
    assert.equal(started.agentConfig.mode, 'plan', 'the draft\'s mode carries into the thread');
  } finally { await host.stop(); }
});

test('Grok refresh discovers newly served variants and keeps Fast pricing and effort metadata', async () => {
  const { host } = fakeAgent('grok', ['--grok-catalog']);
  try {
    assert.deepEqual((await host.listModels()).models.map((model) => model.modelId), ['grok-4.6']);
    const fresh = await host.listModels(undefined, true);
    assert.deepEqual(fresh.models.map((model) => model.modelId), ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6']);
    const fast = fresh.models.find((model) => model.modelId === 'grok-4.7-build-fast');
    assert.equal(fast.description, 'Fast variant. 2x the price.');
    assert.equal(fast.contextLimit, 256000);
    assert.deepEqual(fast.reasoningEfforts, ['low', 'high']);
    assert.equal(fast.defaultReasoningEffort, 'high');
    await host.startSession({ workspaceRoot: temporary });
    const scoped = await host.listModels('s2', true);
    assert.equal(scoped.models.find((model) => model.modelId === 'grok-4.6').isActive, true);
    assert.equal(scoped.models.find((model) => model.modelId === 'grok-4.7').isActive, false);
    assert.equal(host.sessions.size, 1, 'refresh leaves the owned thread open');
    await host.stop();
    assert.deepEqual((await host.listModels()).models.map((model) => model.modelId), ['grok-4.6'], 'a restarted agent cannot reuse the old process catalog');
  } finally { await host.stop(); }
});

test('an empty model listing is not kept: the next listing asks the agent again', async () => {
  const { host } = fakeAgent('opencode', ['--late-catalog']);
  try {
    assert.deepEqual((await host.listModels()).models, []);
    assert.deepEqual((await host.listModels()).models.map((model) => model.modelId), ['zen/a', 'zen/b']);
  } finally { await host.stop(); }
});

test('ACP model discovery surfaces authentication errors instead of an empty success', async () => {
  const { host } = fakeAgent('opencode', ['--auth-required']);
  try { await assert.rejects(host.listModels(), /needs a sign-in/); }
  finally { await host.stop(); }
});

test('ACP turn maps to the same items, plan, approval, and completion events as Muse', async () => {
  const { host, events } = fakeAgent();
  try {
    const started = await host.startSession({ workspaceRoot: '/tmp/ws' });
    assert.equal(started.sessionId, 's1');
    assert.deepEqual({ model: started.agentConfig.modelId, effort: started.agentConfig.effort, mode: started.agentConfig.mode }, { model: 'zen/a', effort: 'high', mode: 'build' });

    const { turnId } = await host.sendTurn({ sessionId: 's1', text: 'list files' });
    const done = await until(events, (e) => e.event === 'turnCompleted');
    assert.equal(done.payload.turnId, turnId);
    assert.equal(done.payload.outcome.params.terminal, 'completed');

    const items = events.filter((e) => e.event === 'item').map((e) => e.payload.item);
    assert.equal(items[0].kind, 'userMessage');
    const thought = items.filter((i) => i.kind === 'reasoning').at(-1);
    assert.equal(thought.text, 'Thinking hard.');
    const reply = items.filter((i) => i.kind === 'agentMessage').at(-1);
    assert.equal(reply.text, 'Done, found a.txt.');
    assert.equal(reply.status, 'completed');
    const tool = items.filter((i) => i.itemId === 't1').at(-1);
    assert.deepEqual({ tool: tool.tool, status: tool.status, exit: tool.exitCode, out: tool.visibleOutput, cmd: tool.commandText }, { tool: 'bash', status: 'completed', exit: 0, out: 'a.txt\n', cmd: 'ls' });
    assert.ok(items.every((i) => i.turnId === turnId), 'every item belongs to the turn');

    const approval = events.find((e) => e.event === 'approval').payload;
    assert.deepEqual(approval.availableChoices.map((c) => c.decision), ['approved', 'denied']);
    assert.equal(typeof approval.expiresAt, 'number', 'ACP approval carries its expiration deadline');
    assert.deepEqual(events.find((e) => e.event === 'sessionFacts').payload.plan, [{ id: 'plan-0', text: 'Run ls', status: 'inProgress' }]);
    assert.equal(events.find((e) => e.event === 'sessionTitle').payload.title, 'List files');
    assert.ok(events.some((e) => e.event === 'delta' && e.payload.delta === 'found a.txt.'), 'message streams as deltas');
  } finally { await host.stop(); }
});

test('stop() settles parked approvals instead of throwing', async () => {
  const { host } = fakeAgent();
  const settled = [];
  // `approvals` is TS-private but a plain runtime field; park one waiter directly.
  host.approvals.set('a-parked', { sessionId: 's1', choices: new Set(['allow']), resolve: (value) => settled.push(value) });
  await host.stop();
  assert.deepEqual(settled, [null]);
  assert.equal(host.approvals.size, 0);
});

test('stop() during a live parked approval settles it without unhandled rejections', async () => {
  const events = [];
  const spec = { id: 'fake', name: 'Fake', protocol: 'acp', bins: [], acpArgs: [resolve('tests/fixtures/fake-acp-agent.mjs')], verified: true, signIn: '' };
  const host = new AcpAgentHost(spec, process.execPath, (event, payload) => { events.push({ event, payload }); });
  await host.startSession({ workspaceRoot: '/tmp/ws' });
  await host.sendTurn({ sessionId: 's1', text: 'list files' });
  const approval = await until(events, (e) => e.event === 'approval');
  assert.ok(approval, 'approval parks before stop');
  await host.stop();
  assert.ok(true, 'stop settled the parked approval and the reply-into-dying-stdin path stayed quiet');
});

test('ACP models, effort tiers, and sessions come from the agent', async () => {
  const { host } = fakeAgent();
  try {
    const listed = await host.listSessions('/tmp/ws');
    assert.deepEqual(listed.sessions.map((s) => [s.sessionId, s.name]), [['s-old', 'Earlier work']]);
    await host.startSession({ workspaceRoot: '/tmp/ws' });
    const { models } = await host.listModels('s1');
    assert.deepEqual(models.map((m) => m.modelId), ['zen/a', 'zen/b']);
    assert.equal(models[0].displayLabel, 'Model A');
    assert.deepEqual(models[0].reasoningEfforts, ['low', 'high', 'max'], 'the agent effort option, minus "default"');
    const switched = await host.setModel({ sessionId: 's1', modelId: 'zen/b' });
    assert.equal(switched.agentConfig.modelId, 'zen/b');
    const effort = await host.setEffort('s1', 'max');
    assert.equal(effort.agentConfig.effort, 'max');
  } finally { await host.stop(); }
});

test('Cline runs at the picked reasoning level, relaunching with its open sessions when the level changes', async () => {
  const { host, events } = fakeAgent('cline', ['--cline']);
  // Cline's free-promotion list is fetched from its API; the test stays offline.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  const reply = async (sessionId, text, reasoningEffort) => {
    const before = events.filter(({ event }) => event === 'turnCompleted').length;
    await host.sendTurn({ sessionId, text, reasoningEffort });
    for (let waited = 0; waited < 4000 && events.filter(({ event }) => event === 'turnCompleted').length === before; waited += 10) await new Promise((r) => setTimeout(r, 10));
    return events.filter(({ event, payload }) => event === 'item' && payload.item.kind === 'agentMessage' && payload.sessionId === sessionId).at(-1)?.payload.item.text;
  };
  try {
    const { models } = await host.listModels();
    assert.deepEqual(models[0].reasoningEfforts, ['none', 'low', 'medium', 'high', 'xhigh'], 'every Cline model offers its --thinking levels');
    assert.equal(models[0].defaultReasoningEffort, 'medium');
    const started = await host.startSession({ workspaceRoot: '/tmp/ws', effort: 'high' });
    assert.equal(started.agentConfig.effort, 'high');
    const { sessionId } = started;
    assert.match(await reply(sessionId, 'hi'), /^thinking=high /, 'a new thread starts in a process at its level');
    await host.setModel({ sessionId, modelId: 'nvidia/nemotron-3.5-super' });
    await host.setMode(sessionId, 'plan');
    const picked = await host.setEffort(sessionId, 'low');
    assert.deepEqual({ status: picked.status, effort: picked.agentConfig.effort }, { status: 'accepted', effort: 'low' });
    const replayed = events.length;
    assert.equal(await reply(sessionId, 'again'), 'thinking=low model=nvidia/nemotron-3.5-super mode=plan', 'the relaunch keeps the session, its model and its mode');
    assert.ok(!events.slice(replayed).some(({ payload }) => payload?.item?.text === 'replayed history'), 'the reload does not replay history into the thread');
    assert.equal((await host.setEffort(sessionId, 'max')).status, 'unsupported', 'Cline has no max');
  } finally { globalThis.fetch = realFetch; await host.stop(); }
});

test('ACP cancel waits for a terminal state and kills a hanging process tree', { timeout: 8000 }, async () => {
  const pidFile = join(temporary, `grandchild-${Date.now()}.pid`);
  const spec = { id: 'fake', name: 'Fake', protocol: 'acp', bins: [], acpArgs: [resolve('tests/fixtures/hung-acp-agent.mjs')], verified: true, signIn: '' };
  const previous = process.env.GLITTER_TEST_PID_FILE;
  process.env.GLITTER_TEST_PID_FILE = pidFile;
  const host = new AcpAgentHost(spec, process.execPath, () => {});
  try {
    await host.startSession({ workspaceRoot: temporary });
    await host.sendTurn({ sessionId: 's1', text: 'hang' });
    const cancelled = await host.cancelTurn({ sessionId: 's1' });
    assert.equal(cancelled.status, 'terminal');
    assert.equal(cancelled.escalated, true);
    const pid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim());
    if (pid) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.throws(() => process.kill(pid, 0));
    }
  } finally {
    await host.stop();
    if (previous === undefined) delete process.env.GLITTER_TEST_PID_FILE;
    else process.env.GLITTER_TEST_PID_FILE = previous;
    await rm(pidFile, { force: true });
  }
});

test('ACP spawn uses a confined cwd and a minimal environment', async () => {
  const { host } = fakeAgent();
  try {
    await host.startSession({ workspaceRoot: temporary });
    const isolation = host.isolation();
    assert.equal(isolation.env, 'minimal');
    assert.notEqual(isolation.cwd, process.env.HOME);
    assert.ok(isolation.consentRequired === true || isolation.osSandbox === 'enforced');
  } finally { await host.stop(); }
});

test('expired ACP approvals are rejected and do not resolve the waiter as chosen', async () => {
  const { host } = fakeAgent();
  const settled = [];
  host.approvals.set('stale', { sessionId: 's1', choices: new Set(['allow']), expiresAt: Date.now() - 1, expiresAtMono: performance.now() - 1, resolve: (value) => settled.push(value) });
  assert.throws(() => host.decideApproval({ approvalId: 'stale', choiceId: 'allow' }), /expired/);
  assert.deepEqual(settled, [null]);
  await host.stop();
});

test('ACP initialization errors redact stderr canaries before reaching the caller', { timeout: 5000 }, async () => {
  const spec = { id: 'fake', name: 'Fake', protocol: 'acp', bins: [], verified: true, signIn: '',
    acpArgs: ['-e', "process.stdin.once('data', () => { process.stderr.write('Authorization: Bea'); setTimeout(() => { process.stderr.write('rer CANARY-ACP\\n'); process.exit(1); }, 10); })"] };
  const host = new AcpAgentHost(spec, process.execPath, () => {});
  try {
    await assert.rejects(host.start(), (error) => !error.message.includes('CANARY') && /redacted/.test(error.message));
  } finally { await host.stop(); }
});

test('suggest runs one muted turn: text is collected, nothing is emitted, the session is closed', async () => {
  const { host, events } = fakeAgent();
  try {
    const result = await host.suggest({ workspaceRoot: temporary, prompt: 'What next?', modelId: 'zen/a' });
    assert.equal(result.text, 'Done, found a.txt.');
    assert.equal(host.sessions.size, 0, 'the suggestion session is removed when the turn ends');
    assert.notEqual(host.isolation().cwd, temporary, 'the suggestion process is not started inside the workspace');
    assert.ok(!events.some(({ event }) => ['item', 'delta', 'turnStarted', 'sessionStarted', 'sessionRow', 'approval', 'agentConfig'].includes(event)), 'a muted turn emits no renderer events');
  } finally { await host.stop(); }
});

test('suggest fails when the requested model cannot be selected and still closes the session', async () => {
  const { host } = fakeAgent('fake', ['--reject-model']);
  try {
    await assert.rejects(() => host.suggest({ workspaceRoot: temporary, prompt: 'What next?', modelId: 'nope' }), /model refused/);
    assert.equal(host.sessions.size, 0);
  } finally { await host.stop(); }
});

test('a model rescan returns the freshly probed catalog and keeps the session row active', async () => {
  const { host } = fakeAgent('opencode', ['--grow-catalog']);
  try {
    await host.startSession({ workspaceRoot: temporary });
    const fresh = await host.listModels('s1', true);
    assert.deepEqual(fresh.models.map((model) => model.modelId), ['zen/a', 'zen/c']);
    assert.equal(fresh.models.find((model) => model.modelId === 'zen/a').isActive, true);
    assert.equal(fresh.models.find((model) => model.modelId === 'zen/c').isActive, false);
  } finally { await host.stop(); }
});

test('an agent CLI thread answers permission requests by its mode, and audits each automatic answer', async () => {
  for (const [mode, expected] of [['allowAll', { status: 'completed', choice: 'yes', outcome: 'auto-approved' }], ['denyUnmatched', { status: 'failed', choice: 'no', outcome: 'auto-denied' }]]) {
    const events = [];
    const spec = { id: 'fake', name: 'Fake', protocol: 'acp', bins: [], acpArgs: [resolve('tests/fixtures/fake-acp-agent.mjs')], verified: true, signIn: '' };
    const host = new AcpAgentHost(spec, process.execPath, (event, payload) => events.push({ event, payload }));
    try {
      await host.startSession({ workspaceRoot: '/tmp/ws', approvalMode: mode });
      await host.sendTurn({ sessionId: 's1', text: 'list files' });
      await until(events, (e) => e.event === 'turnCompleted');
      assert.ok(!events.some((e) => e.event === 'approval'), `${mode} answers without a card`);
      const tool = events.filter((e) => e.event === 'item' && e.payload.item.itemId === 't1').at(-1).payload.item;
      assert.equal(tool.status, expected.status, `${mode}: the command ${expected.status === 'completed' ? 'ran' : 'was declined'}`);
      const audit = events.find((e) => e.event === 'approvalAudit').payload;
      assert.deepEqual({ choice: audit.choiceId, outcome: audit.outcome }, { choice: expected.choice, outcome: expected.outcome });
    } finally { await host.stop(); }
  }
  const { host } = fakeAgent();
  try {
    await host.startSession({ workspaceRoot: '/tmp/ws' });
    assert.deepEqual(host.setApprovalMode('s1', 'onRequest').effectiveMode, { mode: 'promptUnmatched' }, 'a mode an agent CLI cannot honour falls back to Ask me');
    assert.throws(() => host.setApprovalMode('nope', 'allowAll'), /Unknown Fake session/);
  } finally { await host.stop(); }
});
