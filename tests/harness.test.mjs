import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-harness-'));
const outfile = join(temporary, 'harness.mjs');
await writeFile(join(temporary, 'entry.ts'), `
export { HarnessHost, retryBudgetOpen } from ${JSON.stringify(resolve('packages/glitter-bridge/src/harness/host.ts'))};
export { SessionStore } from ${JSON.stringify(resolve('packages/glitter-bridge/src/harness/store.ts'))};
export { confine, globRegex, runTool, scheduleToolCalls, encodeSegment } from ${JSON.stringify(resolve('packages/glitter-bridge/src/harness/tools.ts'))};
export { isTruncatedStop, repairHistory, classifyProviderFailure } from ${JSON.stringify(resolve('packages/glitter-bridge/src/harness/wire.ts'))};
export { effortTiers, resolveProvider } from ${JSON.stringify(resolve('packages/glitter-bridge/src/harness/providers.ts'))};
`);
await build({ entryPoints: [join(temporary, 'entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const { HarnessHost, SessionStore, confine, globRegex, runTool, scheduleToolCalls, encodeSegment, repairHistory, isTruncatedStop, retryBudgetOpen, effortTiers, resolveProvider, classifyProviderFailure } = await import(pathToFileURL(outfile).href);

const sse = (frames) => new Response(new ReadableStream({
  start(controller) {
    for (const frame of frames) controller.enqueue(new TextEncoder().encode(`${frame.event ? `event: ${frame.event}\n` : ''}data: ${typeof frame === 'string' ? frame : JSON.stringify(frame.data ?? frame)}\n\n`));
    controller.close();
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** An Anthropic stub: replies are scripted per call, and every request body is kept. */
function anthropicStub(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/models?limit=1000')) return Response.json({ data: [{ id: 'claude-sonnet-9', display_name: 'Claude Sonnet 9' }, { id: 'claude-haiku-9' }] });
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), headers: init.headers, body });
    return sse(script[calls.length - 1](body));
  };
  return { calls, fetchImpl };
}

const textReply = (text) => [
  { type: 'message_start', message: { usage: { input_tokens: 1200 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 3) } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(3) } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
];
const toolReply = (id, name, input, thought = 'Let me look.') => [
  { type: 'message_start', message: { usage: { input_tokens: 900 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thought } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input).slice(0, 5) } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input).slice(5) } },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
];

async function workspace() {
  const root = await mkdtemp(join(temporary, 'ws-'));
  await writeFile(join(root, 'hello.txt'), 'one\ntwo\nthree\n');
  return root;
}

function host(fetchImpl, store, limits) {
  const events = [];
  const instance = new HarnessHost((event, payload) => events.push({ event, payload }), store, fetchImpl, limits);
  instance.setCredentials({ anthropic: { key: 'sk-ant-test-key' } });
  return { instance, events };
}

/** Wait until `count` turns have finished. */
async function settled(events, count, ms = 4000) {
  for (let waited = 0; waited < ms && events.filter(({ event }) => event === 'turnCompleted').length < count; waited += 10) await new Promise((r) => setTimeout(r, 10));
  return events.filter(({ event }) => event === 'turnCompleted');
}

const until = async (events, predicate, ms = 4000) => {
  for (let waited = 0; waited < ms && !events.some(predicate); waited += 10) await new Promise((r) => setTimeout(r, 10));
  return events.find(predicate);
};

test('providers need a key unless they are local, and custom endpoints use the URL saved with the key', () => {
  assert.equal(resolveProvider('anthropic', {}), null);
  assert.equal(resolveProvider('anthropic', { anthropic: {} }), null, 'a key is required');
  assert.equal(resolveProvider('ollama', { ollama: {} })?.root, 'http://localhost:11434/v1', 'local servers need no key');
  assert.equal(resolveProvider('custom', { custom: { key: 'k' } }), null, 'a custom endpoint needs its URL');
  assert.equal(resolveProvider('custom', { custom: { key: 'k', baseUrl: 'https://llm.example/v1/' } })?.root, 'https://llm.example/v1');
  assert.deepEqual(effortTiers('anthropic', 'claude-3-5-haiku-latest'), [], 'pre-3.7 Claude has no thinking');
  assert.ok(effortTiers('anthropic', 'claude-sonnet-4-5').includes('high'));
  assert.deepEqual(effortTiers('openai', 'gpt-4o'), []);
});

test('paths stay inside the workspace, symlinks included', async () => {
  const root = await workspace();
  const outside = await mkdtemp(join(temporary, 'outside-'));
  await symlink(outside, join(root, 'escape'));
  assert.throws(() => confine(root, '../etc/passwd'), /outside the workspace/);
  assert.throws(() => confine(root, '/etc/passwd'), /outside the workspace/);
  assert.throws(() => confine(root, 'escape/secret.txt'), /outside the workspace/, 'a link out of the root is refused');
  assert.match(confine(root, 'new/dir/file.txt'), /new\/dir\/file\.txt$/, 'not-yet-existing paths inside are fine');
  const write = await runTool(root, 'write_file', { path: 'escape/x.txt', content: 'no' });
  assert.equal(write.isError, true);
  assert.ok(globRegex('**/*.ts').test('src/a/b.ts'));
  assert.ok(globRegex('*.ts').test('src/a/b.ts'), 'a bare name matches at any depth');
  assert.ok(!globRegex('src/*.ts').test('src/a/b.ts'));
});

test('edit_file needs a unique exact match, and read_file numbers lines', async () => {
  const root = await workspace();
  assert.match((await runTool(root, 'read_file', { path: 'hello.txt' })).output, /^\s+2\ttwo$/m);
  assert.equal((await runTool(root, 'edit_file', { path: 'hello.txt', old_string: 'missing', new_string: 'x' })).isError, true);
  await writeFile(join(root, 'dup.txt'), 'a\na\n');
  assert.match((await runTool(root, 'edit_file', { path: 'dup.txt', old_string: 'a', new_string: 'b' })).output, /matches 2 places/);
  assert.equal((await runTool(root, 'edit_file', { path: 'dup.txt', old_string: 'a', new_string: 'b', replace_all: true })).isError, undefined);
  assert.equal(await readFile(join(root, 'dup.txt'), 'utf8'), 'b\nb\n');
  assert.match((await runTool(root, 'grep', { pattern: 'thr' })).output, /hello\.txt:3: three/);
});

test('a stopped turn\'s unanswered tool calls are filled in before the next request', () => {
  const repaired = repairHistory([
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'bash', input: {} }] },
    { role: 'user', content: [{ type: 'text', text: 'again' }] },
  ]);
  assert.deepEqual(repaired.map((message) => message.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal(repaired[2].results[0].id, 't1');
  assert.match(repaired[2].results[0].output, /interrupted before it started/);
  const started = repairHistory([
    { role: 'assistant', text: '', toolCalls: [{ id: 't2', name: 'bash', input: {}, started: true }] },
  ]);
  assert.match(started[1].results[0].output, /outcome is unknown/);
  assert.match(started[1].results[0].output, /Do not retry blindly/);
});

test('a turn streams thinking and text, runs a read tool, and persists for resume', async () => {
  const root = await workspace();
  const store = new SessionStore(await mkdtemp(join(temporary, 'store-')));
  const { calls, fetchImpl } = anthropicStub([
    () => toolReply('tu_1', 'read_file', { path: 'hello.txt' }),
    () => textReply('It says one, two, three.'),
  ]);
  const { instance, events } = host(fetchImpl, store);
  const models = await instance.listModels();
  assert.deepEqual(models.modes.map((mode) => mode.value), ['build', 'plan']);
  assert.ok(models.models.find((model) => model.modelId === 'anthropic/claude-sonnet-9').isDefault);
  const started = await instance.startSession({ workspaceRoot: root, effort: 'high' });
  assert.equal(started.agentConfig.modelId, 'anthropic/claude-sonnet-9', 'the default model is chosen');
  await instance.sendTurn({ sessionId: started.sessionId, text: 'What is in hello.txt?' });
  const done = await until(events, ({ event }) => event === 'turnCompleted');
  assert.equal(done.payload.outcome.params.terminal, 'completed');
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant-test-key');
  assert.equal(calls[0].body.thinking.type, 'enabled', 'effort becomes a thinking budget');
  // The second call carries the tool result and replays the signed thinking block.
  const sent = calls[1].body.messages;
  assert.equal(sent[1].content[0].type, 'thinking');
  assert.equal(sent[1].content[0].signature, 'sig-1');
  assert.equal(sent[2].content[0].type, 'tool_result');
  assert.match(sent[2].content[0].content, /three/);
  const tool = events.filter(({ event, payload }) => event === 'item' && payload.item.kind === 'toolCall').at(-1);
  assert.equal(tool.payload.item.status, 'completed');
  assert.equal(tool.payload.item.tool, 'read_file');
  const reply = events.filter(({ event, payload }) => event === 'item' && payload.item.kind === 'agentMessage').at(-1);
  assert.equal(reply.payload.item.text, 'It says one, two, three.');
  assert.ok(events.some(({ event }) => event === 'sessionTitle'));
  assert.ok(events.some(({ event, payload }) => event === 'sessionFacts' && payload.context?.windowTokens === 200000));
  // A fresh host resumes from disk and replays the transcript without calling the model.
  const replayed = [];
  const fresh = new HarnessHost((event, payload) => replayed.push({ event, payload }), new SessionStore(store.root), fetchImpl);
  const listed = await fresh.listSessions(root);
  assert.equal(listed.sessions[0].name, 'What is in hello.txt?');
  const callsBefore = calls.length;
  await fresh.resumeSession({ sessionId: started.sessionId, workspaceRoot: root });
  assert.equal(calls.length, callsBefore, 'resuming runs nothing');
  assert.ok(replayed.some(({ payload }) => payload.item?.text === 'It says one, two, three.'));
  const other = new HarnessHost(() => {}, new SessionStore(store.root), fetchImpl);
  await assert.rejects(other.resumeSession({ sessionId: started.sessionId, workspaceRoot: '/elsewhere' }), /another workspace/);
});

test('edits wait for approval in Ask mode, are refused in Plan mode, and denial reaches the model', async () => {
  const root = await workspace();
  const store = new SessionStore(await mkdtemp(join(temporary, 'store-')));
  const { calls, fetchImpl } = anthropicStub([
    () => toolReply('tu_1', 'edit_file', { path: 'hello.txt', old_string: 'two', new_string: 'TWO' }),
    () => textReply('Done.'),
    () => toolReply('tu_2', 'edit_file', { path: 'hello.txt', old_string: 'one', new_string: 'ONE' }),
    () => textReply('Denied, so no change.'),
    () => toolReply('tu_3', 'write_file', { path: 'plan.txt', content: 'x' }),
    () => textReply('Planned only.'),
  ]);
  const { instance, events } = host(fetchImpl, store);
  const { sessionId } = await instance.startSession({ workspaceRoot: root, approvalMode: 'promptUnmatched' });
  await instance.sendTurn({ sessionId, text: 'Capitalise two' });
  const approval = await until(events, ({ event }) => event === 'approval');
  assert.equal(approval.payload.toolName, 'edit_file');
  assert.match(approval.payload.rawArgs, /"old_string":"two"/, 'the card can preview the edit');
  instance.decideApproval({ approvalId: approval.payload.approvalId, choiceId: 'allow-once' });
  await until(events, ({ event }) => event === 'turnCompleted');
  assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'one\nTWO\nthree\n');

  events.length = 0;
  await instance.sendTurn({ sessionId, text: 'Capitalise one' });
  const second = await until(events, ({ event }) => event === 'approval');
  instance.decideApproval({ approvalId: second.payload.approvalId, choiceId: 'deny' });
  await until(events, ({ event }) => event === 'turnCompleted');
  assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'one\nTWO\nthree\n', 'a denied edit does not run');
  assert.match(JSON.stringify(calls[3].body.messages.at(-1)), /denied/);

  events.length = 0;
  await instance.setMode(sessionId, 'plan');
  await instance.sendTurn({ sessionId, text: 'Make a plan file' });
  await until(events, ({ event }) => event === 'turnCompleted');
  assert.ok(!events.some(({ event }) => event === 'approval'), 'plan mode refuses without asking');
  assert.match(JSON.stringify(calls[5].body.messages.at(-1)), /Plan mode is on/);
  const system = calls[5].body.system;
  assert.equal(system[0].cache_control.type, 'ephemeral');
  assert.doesNotMatch(system[0].text, /PLAN MODE/);
  assert.match(system.map((block) => block.text).join('\n'), /PLAN MODE/);
});

test('a cancelled turn settles its approval and reports cancelled', async () => {
  const root = await workspace();
  const { fetchImpl } = anthropicStub([() => toolReply('tu_1', 'bash', { command: 'echo hi' })]);
  const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))));
  const { sessionId } = await instance.startSession({ workspaceRoot: root });
  await instance.sendTurn({ sessionId, text: 'run it' });
  await until(events, ({ event }) => event === 'approval');
  await instance.cancelTurn({ sessionId });
  const done = await until(events, ({ event }) => event === 'turnCompleted');
  assert.equal(done.payload.outcome.params.terminal, 'cancelled');
});

test('OpenAI-compatible providers stream text and tool calls through the same loop', async () => {
  const root = await workspace();
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'gpt-5' }, { id: 'text-embedding-3-large' }, { id: 'gpt-4.1' }] });
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_files', arguments: '{"pat' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tern":"*.txt"}' } }] }, finish_reason: 'tool_calls' }] },
        { usage: { prompt_tokens: 50, completion_tokens: 5 }, choices: [] },
        '[DONE]',
      ]);
    }
    return sse([{ choices: [{ delta: { content: 'Found hello.txt.' }, finish_reason: 'stop' }] }, '[DONE]']);
  };
  const events = [];
  const instance = new HarnessHost((event, payload) => events.push({ event, payload }), new SessionStore(await mkdtemp(join(temporary, 'store-'))), fetchImpl);
  instance.setCredentials({ openai: { key: 'sk-openai-test' } });
  const listed = await instance.listModels();
  assert.ok(!listed.models.some((model) => /embedding/.test(model.modelId)), 'non-chat models are filtered out');
  assert.deepEqual(listed.models.find((model) => model.modelId === 'openai/gpt-5').reasoningEfforts, ['minimal', 'low', 'medium', 'high']);
  const { sessionId } = await instance.startSession({ workspaceRoot: root, modelId: 'openai/gpt-5', effort: 'low' });
  await instance.sendTurn({ sessionId, text: 'list text files' });
  await until(events, ({ event }) => event === 'turnCompleted');
  assert.equal(bodies[0].reasoning_effort, 'low');
  assert.equal(bodies[0].tools[0].type, 'function');
  assert.equal(bodies[1].messages.at(-1).role, 'tool');
  assert.match(bodies[1].messages.at(-1).content, /hello\.txt/);
  assert.equal(events.filter(({ payload }) => payload.item?.kind === 'agentMessage').at(-1).payload.item.text, 'Found hello.txt.');
});

test('a rate-limited call is retried, and an unconfigured provider fails with what to do', async () => {
  const root = await workspace();
  let attempts = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/models?limit=1000')) return Response.json({ data: [{ id: 'claude-sonnet-9' }] });
    attempts += 1;
    if (attempts === 1) return new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 });
    return sse(textReply('ok now'));
  };
  const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))));
  const { sessionId } = await instance.startSession({ workspaceRoot: root });
  await instance.sendTurn({ sessionId, text: 'hi' });
  const done = await until(events, ({ event }) => event === 'turnCompleted', 8000);
  assert.equal(done.payload.outcome.params.terminal, 'completed');
  assert.ok(events.some(({ event, payload }) => event === 'agentNotice' && /Retrying/.test(payload.message ?? '')));

  events.length = 0;
  await instance.setModel({ sessionId, modelId: 'openai/gpt-5' });
  await instance.sendTurn({ sessionId, text: 'again' });
  const failed = await until(events, ({ event }) => event === 'turnCompleted');
  assert.match(failed.payload.outcome.params.error.message, /OpenAI has no key\. Add it in Settings → Providers/);
});

test('cached input counts in the context window, and the session keeps the counters apart', async () => {
  const root = await workspace();
  const { fetchImpl } = anthropicStub([
    () => [
      { type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 100000, cache_creation_input_tokens: 500 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    ],
  ]);
  const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))));
  const { sessionId } = await instance.startSession({ workspaceRoot: root });
  await instance.sendTurn({ sessionId, text: 'hi' });
  await until(events, ({ event }) => event === 'turnCompleted');
  const context = events.filter(({ event, payload }) => event === 'sessionFacts' && payload.context).at(-1).payload.context;
  assert.equal(context.usedTokens, 100520);
  assert.equal(context.cacheReadTokens, 100000);
  assert.equal(context.cacheWriteTokens, 500);
  const usage = events.filter(({ event, payload }) => event === 'sessionFacts' && payload.usage).at(-1).payload.usage;
  assert.equal(usage.promptTokens, 20);
  assert.equal(usage.cacheReadTokens, 100000);
  assert.equal(usage.cacheWriteTokens, 500);
  assert.equal(usage.outputTokens, 4);
  assert.equal(usage.totalTokens, 100524);
});

test('a reply cut off by the output limit does not run its tool call', async () => {
  const root = await workspace();
  const { calls, fetchImpl } = anthropicStub([
    () => [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_cut', name: 'bash' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 8 } },
    ],
    () => textReply('sent again'),
  ]);
  const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))));
  const { sessionId } = await instance.startSession({ workspaceRoot: root });
  await instance.sendTurn({ sessionId, text: 'run a command' });
  const done = await until(events, ({ event }) => event === 'turnCompleted');
  assert.equal(done.payload.outcome.params.terminal, 'completed');
  assert.equal(events.some(({ event }) => event === 'approval'), false);
  const tool = events.find(({ event, payload }) => event === 'item' && payload.item?.tool === 'bash');
  assert.equal(tool.payload.item.status, 'failed');
  assert.match(tool.payload.item.visibleOutput, /re-issue/i);
  assert.match(JSON.stringify(calls[1].body.messages), /re-issue/i);
  assert.equal(isTruncatedStop('length'), true);
  assert.equal(isTruncatedStop('max_output_tokens'), true);
  assert.equal(isTruncatedStop('end_turn'), false);
});

test('an ambiguous edit fails before the approval card', async () => {
  const root = await workspace();
  await writeFile(join(root, 'dup.txt'), 'a\na\n');
  const { calls, fetchImpl } = anthropicStub([
    () => toolReply('tu_1', 'edit_file', { path: 'dup.txt', old_string: 'a', new_string: 'b' }),
    () => textReply('no change'),
  ]);
  const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))));
  const { sessionId } = await instance.startSession({ workspaceRoot: root, approvalMode: 'promptUnmatched' });
  await instance.sendTurn({ sessionId, text: 'replace a' });
  await until(events, ({ event }) => event === 'turnCompleted');
  assert.equal(events.some(({ event }) => event === 'approval'), false);
  assert.match(JSON.stringify(calls[1].body.messages), /matches 2/);
  assert.equal(await readFile(join(root, 'dup.txt'), 'utf8'), 'a\na\n');
});

test('the stable prompt is snapshotted once per turn', async () => {
  const root = await workspace();
  await writeFile(join(root, 'AGENTS.md'), 'RULE-ALPHA\n');
  const { calls, fetchImpl } = anthropicStub([
    () => toolReply('tu_1', 'write_file', { path: 'AGENTS.md', content: 'RULE-BETA\n' }),
    () => textReply('rewrote the rules'),
  ]);
  const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))));
  const { sessionId } = await instance.startSession({ workspaceRoot: root, approvalMode: 'allowAll' });
  await instance.sendTurn({ sessionId, text: 'rewrite the rules' });
  await until(events, ({ event }) => event === 'turnCompleted');
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'RULE-BETA\n');
  assert.equal(calls[0].body.system[0].text, calls[1].body.system[0].text);
  assert.match(calls[1].body.system[0].text, /RULE-ALPHA/);
  assert.doesNotMatch(calls[1].body.system[0].text, /RULE-BETA/);
  assert.equal(calls[0].body.system[0].cache_control.type, 'ephemeral');
  assert.equal(calls[0].body.system[1].cache_control, undefined);
});

test('a follow-up can queue, steer, or replace a running turn', async () => {
  const root = await workspace();
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/models?limit=1000')) return Response.json({ data: [{ id: 'claude-sonnet-9' }] });
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (bodies.length === 1) { entered(); await gate; }
    return sse(textReply('done'));
  };
  const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))));
  const { sessionId } = await instance.startSession({ workspaceRoot: root });
  await assert.rejects(instance.sendTurn({ sessionId, text: 'too soon', ifBusy: 'steer' }), /no running turn to steer/);
  const first = await instance.sendTurn({ sessionId, text: 'first message' });
  assert.equal(first.disposition, 'started');
  await started;
  const queued = await instance.sendTurn({ sessionId, text: 'queued follow up', ifBusy: 'queue' });
  assert.equal(queued.disposition, 'queued');
  assert.notEqual(queued.turnId, first.turnId);
  await assert.rejects(instance.sendTurn({ sessionId, text: 'no disposition' }), /still working/);
  const dropped = await instance.unqueueTurn({ sessionId, turnId: queued.turnId });
  assert.equal(dropped.unqueued, true);
  const again = await instance.sendTurn({ sessionId, text: 'queued follow up', ifBusy: 'queue' });
  release();
  for (let waited = 0; waited < 8000 && events.filter(({ event, payload }) => event === 'turnCompleted' && payload.outcome?.params?.terminal === 'completed').length < 2; waited += 10) await new Promise((r) => setTimeout(r, 10));
  const dones = events.filter(({ event }) => event === 'turnCompleted');
  assert.equal(dones.filter(({ payload }) => payload.outcome?.kind === 'unqueued').length, 1);
  assert.equal(dones.filter(({ payload }) => payload.outcome?.params?.terminal === 'completed').length, 2);
  assert.ok(events.some(({ event, payload }) => event === 'turnStarted' && payload.turnId === again.turnId));
  assert.match(JSON.stringify(bodies.at(-1)), /queued follow up/);
  assert.equal(retryBudgetOpen(0, 1), true);
  assert.equal(retryBudgetOpen(120_000, 1), false);
  assert.equal(retryBudgetOpen(0, 4), false);
});

test('a steered message is folded in after the tool result, not between the call and its result', async () => {
  const root = await workspace();
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/models?limit=1000')) return Response.json({ data: [{ id: 'claude-sonnet-9' }] });
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (bodies.length === 1) {
      entered();
      await gate;
      return sse(toolReply('tu_1', 'read_file', { path: 'hello.txt' }));
    }
    return sse(textReply('saw the steer'));
  };
  const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))));
  const { sessionId } = await instance.startSession({ workspaceRoot: root });
  const first = await instance.sendTurn({ sessionId, text: 'look' });
  await started;
  const steered = await instance.sendTurn({ sessionId, text: 'also check the date', ifBusy: 'steer' });
  assert.equal(steered.disposition, 'steered');
  assert.equal(steered.turnId, first.turnId);
  assert.ok(events.some(({ payload }) => payload.item?.text === 'also check the date'));
  release();
  const dones = await settled(events, 1);
  assert.equal(dones.filter(({ payload }) => payload.outcome?.params?.terminal === 'completed').length, 1);
  const messages = bodies[1].messages;
  const assistant = messages.findIndex((message) => message.role === 'assistant');
  const follow = messages[assistant + 1];
  assert.equal(follow.content[0].type, 'tool_result');
  assert.ok(follow.content.some((block) => block.type === 'text' && /also check the date/.test(block.text)));
  assert.equal(messages.slice(0, assistant + 1).some((message) => JSON.stringify(message).includes('also check the date')), false);
});

test('replacing a running turn aborts it and starts the new one', async () => {
  const root = await workspace();
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/models?limit=1000')) return Response.json({ data: [{ id: 'claude-sonnet-9' }] });
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) { entered(); await gate; }
    return sse(textReply('done'));
  };
  const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))));
  const { sessionId } = await instance.startSession({ workspaceRoot: root });
  const first = await instance.sendTurn({ sessionId, text: 'first message' });
  await started;
  const replaced = await instance.sendTurn({ sessionId, text: 'replacement text', ifBusy: 'replace' });
  assert.equal(replaced.disposition, 'started');
  assert.notEqual(replaced.turnId, first.turnId);
  release();
  const dones = await settled(events, 2, 8000);
  assert.equal(dones[0].payload.turnId, first.turnId);
  assert.equal(dones[0].payload.outcome.params.terminal, 'cancelled');
  assert.equal(dones.at(-1).payload.outcome.params.terminal, 'completed');
  assert.match(JSON.stringify(bodies.at(-1)), /replacement text/);
});

test('a provider that accepts and then sends nothing is not retried once the budget is closed', async () => {
  const root = await workspace();
  let attempts = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/models?limit=1000')) return Response.json({ data: [{ id: 'claude-sonnet-9' }] });
    attempts += 1;
    return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))), { firstEventMs: 40, retryElapsedMs: 0 });
  const { sessionId } = await instance.startSession({ workspaceRoot: root });
  await instance.sendTurn({ sessionId, text: 'hi' });
  const failed = await until(events, ({ event }) => event === 'turnCompleted', 4000);
  assert.equal(failed.payload.outcome.params.terminal, 'failed');
  assert.match(failed.payload.outcome.params.error.message, /sent nothing/);
  assert.equal(attempts, 1);
});

test('a tool that started and never recorded a result tells the model not to retry blindly', async () => {
  const store = new SessionStore(await mkdtemp(join(temporary, 'store-')));
  const now = new Date().toISOString();
  await store.create({ sessionId: 'h-tool-start', workspaceRoot: '/tmp/ws', title: null, createdAt: now, updatedAt: now });
  await store.append('h-tool-start', [
    { type: 'message', message: { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'bash', input: { command: 'rm x' } }] } },
    { type: 'toolStarted', id: 'c1' },
  ]);
  const { messages } = await store.read('h-tool-start');
  assert.equal(messages[0].toolCalls[0].started, true);
  const repaired = repairHistory(messages);
  assert.match(repaired[1].results[0].output, /outcome is unknown/);
});

test('the UI, the bridge and the native keychain agree on the provider list', async () => {
  const ids = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1]);
  const ui = ids(await readFile(resolve('apps/desktop/src/lib/providers.ts'), 'utf8'), /\{ id: "([a-z]+)"/g);
  const bridge = ids(await readFile(resolve('packages/glitter-bridge/src/harness/providers.ts'), 'utf8'), /\{ id: "([a-z]+)", name:/g);
  const native = (await readFile(resolve('apps/desktop/src-tauri/src/credentials.rs'), 'utf8')).match(/PROVIDER_IDS: &\[&str\] = &\[([^\]]+)\]/)[1].match(/"([a-z]+)"/g).map((id) => id.slice(1, -1));
  assert.deepEqual(ui, bridge);
  assert.deepEqual(native, bridge);
});

test('a write_file result carries the diff metadata', async () => {
  const root = await workspace();
  const wrote = await runTool(root, 'write_file', { path: 'hello.txt', content: 'new\n' });
  assert.equal(wrote.value.kind, 'diff');
  assert.equal(wrote.value.oldText, 'one\ntwo\nthree\n');
  assert.equal(wrote.value.newText, 'new\n');
  assert.equal(wrote.presentation.oldText, 'one\ntwo\nthree\n');
  assert.equal(wrote.presentation.newText, 'new\n');
  assert.match(wrote.output, /Overwrote hello\.txt/);
  const created = await runTool(root, 'write_file', { path: 'fresh.txt', content: 'hi\n' });
  assert.equal(created.value.created, true);
  assert.equal(created.value.oldText, '');
  assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'new\n');
});

test('a truncated grep result carries next_offset and re-issuing it returns the next slice', async () => {
  const root = await workspace();
  await writeFile(join(root, 'hits.txt'), Array.from({ length: 250 }, (_, index) => `hit ${index}`).join('\n'));
  const first = await runTool(root, 'grep', { pattern: '^hit', path: 'hits.txt' });
  assert.equal(first.continuation.offsetUnit, 'match');
  assert.equal(first.continuation.nextOffset, 200);
  assert.match(first.output, /: hit 0$/m);
  assert.match(first.output, /: hit 199$/m);
  assert.doesNotMatch(first.output, /: hit 200$/m);
  const second = await runTool(root, 'grep', { pattern: '^hit', path: 'hits.txt', next_offset: first.continuation.nextOffset });
  assert.match(second.output, /: hit 200$/m);
  assert.match(second.output, /: hit 249$/m);
  assert.doesNotMatch(second.output, /: hit 199$/m);
  assert.equal(second.continuation, undefined);
});

test('two identical grep calls trigger the repeat warning', async () => {
  const root = await workspace();
  const { calls, fetchImpl } = anthropicStub([
    () => toolReply('g1', 'grep', { pattern: 'two', path: 'hello.txt' }),
    () => toolReply('g2', 'grep', { path: 'hello.txt', pattern: 'two' }),
    () => textReply('done'),
  ]);
  const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))));
  const { sessionId } = await instance.startSession({ workspaceRoot: root });
  await instance.sendTurn({ sessionId, text: 'find two' });
  const done = await until(events, ({ event }) => event === 'turnCompleted');
  assert.equal(done.payload.outcome.params.terminal, 'completed');
  assert.doesNotMatch(JSON.stringify(calls[1].body.messages), /harness-repeat/);
  assert.match(JSON.stringify(calls[2].body.messages), /harness-repeat/);
  assert.match(JSON.stringify(calls[2].body.messages), /not the user/);
});

test('two independent reads run concurrently and their results reach the model in order', async () => {
  const root = await workspace();
  await writeFile(join(root, 'a.txt'), 'alpha\n');
  await writeFile(join(root, 'b.txt'), 'beta\n');
  let started = 0;
  let overlapped = false;
  let release = () => {};
  const both = new Promise((resolve) => { release = resolve; });
  const timer = setTimeout(release, 2500);
  const { calls, fetchImpl } = anthropicStub([
    () => [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'r1', name: 'read_file' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'r2', name: 'read_file' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"b.txt"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
    ],
    () => textReply('both'),
  ]);
  const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))), {
    beforeTool: async (name) => {
      if (name !== 'read_file') return;
      started += 1;
      if (started >= 2) { overlapped = true; release(); }
      else await both;
    },
  });
  const { sessionId } = await instance.startSession({ workspaceRoot: root });
  await instance.sendTurn({ sessionId, text: 'read both' });
  const done = await until(events, ({ event }) => event === 'turnCompleted', 6000);
  clearTimeout(timer);
  assert.equal(done.payload.outcome.params.terminal, 'completed');
  assert.equal(overlapped, true, 'the second read started before the first finished');
  const results = calls[1].body.messages.at(-1).content;
  assert.equal(results[0].tool_use_id, 'r1');
  assert.match(results[0].content, /alpha/);
  assert.equal(results[1].tool_use_id, 'r2');
  assert.match(results[1].content, /beta/);
  const order = [];
  const scheduled = await scheduleToolCalls({
    safe: [true, true, false],
    onAborted: (index) => `abort-${index}`,
    run: async (index) => {
      order.push(`start${index}`);
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 40 : 5));
      order.push(`end${index}`);
      return index;
    },
  });
  assert.deepEqual(scheduled, [0, 1, 2]);
  assert.ok(order.indexOf('start1') < order.indexOf('end0'), 'concurrent calls overlap');
  assert.ok(order.indexOf('end0') < order.indexOf('start2') && order.indexOf('end1') < order.indexOf('start2'), 'an exclusive call waits until the pool is idle');
});

test('oversized output is saved, keeps its paging hint, and the receipt is not the evidence', async () => {
  const root = await workspace();
  const long = 'n'.repeat(72);
  await mkdir(join(root, 'many'));
  for (let index = 0; index < 520; index += 1) await writeFile(join(root, 'many', `${long}-${String(index).padStart(3, '0')}.txt`), '');
  const result = await runTool(root, 'list_files', { path: 'many' }, undefined, { canRead: true });
  assert.match(result.output, /Tool output externalized/);
  assert.match(result.output, /Tool: list_files/);
  assert.match(result.output, /Do not treat this receipt as evidence/);
  assert.match(result.output, /read_file\(path, offset, limit\)/);
  assert.match(result.output, /re-run list_files with next_offset 500/, 'the next slice is still named after the receipt');
  assert.equal(result.continuation.nextOffset, 500);
  assert.equal(result.presentation.truncated, true);
  assert.match(result.presentation.artifactPath, /^\.muse\/tool-output\//);
  assert.equal(result.presentation.artifactPath.includes('..'), false);
  const info = await stat(join(root, result.presentation.artifactPath));
  assert.equal(info.mode & 0o777, 0o600);
  const dir = await stat(join(root, '.muse/tool-output'));
  assert.equal(dir.mode & 0o777, 0o700);
  assert.equal(await readFile(join(root, '.muse/tool-output/.gitignore'), 'utf8'), '*\n', 'saved output stays out of git status and the review');
  const recovered = await runTool(root, 'read_file', { path: result.presentation.artifactPath, limit: 2 }, undefined, { canRead: true });
  assert.match(recovered.output, /many\/n{72}-000\.txt/);
  assert.doesNotMatch(recovered.output, /Tool output externalized/);
  const rest = await runTool(root, 'list_files', { path: 'many', next_offset: 500 }, undefined, { canRead: true });
  assert.equal(rest.value.files.length, 20);
  assert.equal(rest.continuation, undefined);
  assert.equal(encodeSegment('../etc/passwd').includes('/'), false);
  const kept = await runTool(root, 'list_files', { path: 'many' });
  assert.doesNotMatch(kept.output, /Tool output externalized/, 'without a read tool the result stays inline');
});

test('read_file cuts a line longer than its budget instead of saving it again', async () => {
  const root = await workspace();
  await writeFile(join(root, 'wide.txt'), `${'z'.repeat(40_000)}\nafter\n`);
  const result = await runTool(root, 'read_file', { path: 'wide.txt' }, undefined, { canRead: true });
  assert.doesNotMatch(result.output, /Tool output externalized/);
  assert.equal(result.presentation.artifactPath, undefined);
  assert.match(result.output, /z{20}/);
  assert.match(result.output, /line 1 cut: 40000 characters in all/);
  assert.ok(result.output.length < 30_000);
  assert.equal(result.continuation.nextOffset, 2, 'paging goes on from the next line');
  const next = await runTool(root, 'read_file', { path: 'wide.txt', offset: result.continuation.nextOffset }, undefined, { canRead: true });
  assert.match(next.output, /^\s+2\tafter$/m);
});

test('a stream that closes without its end marker is retried, not taken as the reply', async () => {
  const root = await workspace();
  let attempts = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/models?limit=1000')) return Response.json({ data: [{ id: 'claude-sonnet-9' }] });
    attempts += 1;
    if (attempts === 1) return sse(textReply('half a repl').slice(0, 3));
    return sse(textReply('whole reply'));
  };
  const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))));
  const { sessionId } = await instance.startSession({ workspaceRoot: root });
  await instance.sendTurn({ sessionId, text: 'hi' });
  const done = await until(events, ({ event }) => event === 'turnCompleted', 8000);
  assert.equal(done.payload.outcome.params.terminal, 'completed');
  assert.equal(attempts, 2);
  assert.ok(events.some(({ event, payload }) => event === 'agentNotice' && /ended the reply early\. Retrying/.test(payload.message ?? '')));
  assert.equal(events.filter(({ payload }) => payload.item?.kind === 'agentMessage').at(-1).payload.item.text, 'whole reply');
});

test('an empty response is a coded failure, not an empty reply', async () => {
  const root = await workspace();
  for (const [body, pattern] of [[() => sse([]), /closed the stream without sending a reply/], [() => new Response(null, { status: 200 }), /sent an empty response/]]) {
    let attempts = 0;
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/models?limit=1000')) return Response.json({ data: [{ id: 'claude-sonnet-9' }] });
      attempts += 1;
      return body();
    };
    const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))), { retryElapsedMs: 0 });
    const { sessionId } = await instance.startSession({ workspaceRoot: root });
    await instance.sendTurn({ sessionId, text: 'hi' });
    const failed = await until(events, ({ event }) => event === 'turnCompleted', 4000);
    assert.equal(failed.payload.outcome.params.terminal, 'failed');
    assert.match(failed.payload.outcome.params.error.message, pattern);
    assert.equal(attempts, 1);
  }
  assert.equal(classifyProviderFailure(undefined, 'Anthropic ended the reply early.'), 'STREAM_CLOSED');
});

test('provider failures use codes, and a context overflow is not retried', async () => {
  assert.equal(classifyProviderFailure(429, 'slow down'), 'RATE_LIMIT');
  assert.equal(classifyProviderFailure(401, 'invalid x-api-key'), 'INVALID_CREDENTIAL');
  assert.equal(classifyProviderFailure(403, 'forbidden'), 'INVALID_CREDENTIAL');
  assert.equal(classifyProviderFailure(400, 'prompt is too long for the context window'), 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(classifyProviderFailure(undefined, 'The provider accepted the request but sent nothing.'), 'EMPTY_RESPONSE');
  assert.equal(classifyProviderFailure(undefined, 'Could not reach Anthropic: refused'), 'TRANSPORT');
  const root = await workspace();
  let attempts = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/models?limit=1000')) return Response.json({ data: [{ id: 'claude-sonnet-9' }] });
    attempts += 1;
    return new Response(JSON.stringify({ error: { message: 'prompt is too long for the context window' } }), { status: 400 });
  };
  const { instance, events } = host(fetchImpl, new SessionStore(await mkdtemp(join(temporary, 'store-'))));
  const { sessionId } = await instance.startSession({ workspaceRoot: root });
  await instance.sendTurn({ sessionId, text: 'hi' });
  const failed = await until(events, ({ event }) => event === 'turnCompleted', 4000);
  assert.equal(failed.payload.outcome.params.terminal, 'failed');
  assert.equal(attempts, 1);
  assert.match(failed.payload.outcome.params.error.message, /context window/);
});

test.after(async () => { await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
