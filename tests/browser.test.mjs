import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { metadataPlugin, STANDALONE_BANNER } from '../packages/glitter-harness/scripts/playwright-metadata.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'glitter-browser-tests-'));
const outfile = join(temporary, 'browser.mjs');
await writeFile(join(temporary, 'entry.ts'), `
  export { BrowserManager, browserExtension, normalizeBrowserUrl, parseBrowserControl } from ${JSON.stringify(resolve('packages/glitter-harness/src/browser.ts'))};
  export { ExtensionRegistry } from ${JSON.stringify(resolve('packages/glitter-harness/src/harness/registry.ts'))};
  export { decide } from ${JSON.stringify(resolve('packages/glitter-harness/src/harness/permission/policy.ts'))};
  export { covers, scopesFor } from ${JSON.stringify(resolve('packages/glitter-harness/src/harness/permission/grants.ts'))};
  export { anthropicMessages, openAiMessages } from ${JSON.stringify(resolve('packages/glitter-harness/src/harness/wire.ts'))};
  export { estimateRequestTokens, fitHistory } from ${JSON.stringify(resolve('packages/glitter-harness/src/harness/context.ts'))};
  export { SessionStore } from ${JSON.stringify(resolve('packages/glitter-harness/src/harness/store.ts'))};
  export { browserPoint, normalizeBrowserAddress } from ${JSON.stringify(resolve('apps/desktop/src/lib/browser.ts'))};
`);
await build({ entryPoints: [join(temporary, 'entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent', plugins: [metadataPlugin], banner: { js: STANDALONE_BANNER } });
const { BrowserManager, browserExtension, normalizeBrowserUrl, parseBrowserControl, ExtensionRegistry, decide, covers, scopesFor, anthropicMessages, openAiMessages, estimateRequestTokens, fitHistory, SessionStore, browserPoint, normalizeBrowserAddress } = await import(pathToFileURL(outfile).href);

test('browser URLs and control arguments are bounded and closed', () => {
  assert.equal(normalizeBrowserUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(normalizeBrowserAddress('127.0.0.1:5173/path'), 'http://127.0.0.1:5173/path');
  for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'data:text/html,hello', 'https://user:pass@example.com']) assert.throws(() => normalizeBrowserUrl(url));
  assert.equal(parseBrowserControl({ action: 'type', ref: 'e2', text: '' }).request.text, '');
  assert.equal(parseBrowserControl({ action: 'click', x: 20, y: 30 }).request.x, 20);
  assert.equal(parseBrowserControl({ action: 'click', ref: 'f1e3' }).request.ref, 'f1e3');
  assert.match(parseBrowserControl({ action: 'click' }).error, /requires a ref, selector/);
  assert.match(parseBrowserControl({ action: 'evaluate' }).error, /supported browser action/);
  assert.match(parseBrowserControl({ action: 'snapshot', script: '1' }).error, /Unknown browser argument/);
  assert.match(parseBrowserControl({ action: 'resize', width: 20, height: 200 }).error, /between 320 and 2560/);
});

test('the browser extension registers without launching and marks read versus control subjects', () => {
  const manager = new BrowserManager(() => {});
  const registry = new ExtensionRegistry();
  registry.register(browserExtension(manager));
  const turn = registry.snapshot({ sessionId: 'h-1', turnId: 't', workspaceRoot: '/workspace', mode: 'build', delegationDepth: 0 });
  assert.ok(turn.tools.has('browser'));
  assert.match(turn.prompt.stable.join('\n'), /untrusted evidence/);
  assert.deepEqual(manager.subject('/workspace', { action: 'snapshot' }), { kind: 'browser', control: false, origin: '' });
  assert.deepEqual(manager.subject('/workspace', { action: 'navigate', url: 'localhost:3000' }), { kind: 'browser', control: true, origin: 'http://localhost:3000' });
});

test('browser control asks per origin in Ask and Auto, with read-only and full-access paths', () => {
  const subject = { kind: 'browser', control: true, origin: 'http://localhost:3000' };
  for (const mode of ['onRequest', 'promptUnmatched', 'guarded']) {
    const verdict = decide({ kind: 'browser', subject, mode, planMode: false, grants: [] });
    assert.equal(verdict.kind, 'ask', mode);
    assert.deepEqual(verdict.scopes[0].grant, { kind: 'browser', origin: subject.origin });
  }
  const grants = [{ kind: 'browser', origin: subject.origin }];
  assert.equal(covers(grants, subject), true);
  assert.equal(covers(grants, { ...subject, origin: 'https://example.com' }), false);
  assert.equal(scopesFor(subject)[0].scopeLabel, `Browser on ${subject.origin}`);
  assert.equal(decide({ kind: 'browser', subject, mode: 'guarded', planMode: false, grants }).kind, 'allow');
  assert.equal(decide({ kind: 'browser', subject, mode: 'allowAll', planMode: false, grants: [] }).kind, 'allow');
  assert.equal(decide({ kind: 'browser', subject, mode: 'guarded', planMode: true, grants: [] }).kind, 'deny');
  assert.equal(decide({ kind: 'browser', subject: { ...subject, control: false }, mode: 'denyUnmatched', planMode: true, grants: [] }).kind, 'allow');
});

test('pointer mapping accounts for letterboxing and browser scaling', () => {
  assert.deepEqual(browserPoint(300, 200, { left: 100, top: 50, width: 400, height: 300 }, { width: 800, height: 600 }), { x: 400, y: 300, scale: 0.5 });
  assert.deepEqual(browserPoint(150, 200, { left: 100, top: 50, width: 400, height: 300 }, { width: 800, height: 600 }), { x: 100, y: 300, scale: 0.5 });
  assert.equal(browserPoint(99, 50, { left: 100, top: 50, width: 400, height: 300 }, { width: 800, height: 600 }), null);
  assert.equal(browserPoint(0, 0, { left: 0, top: 0, width: 0, height: 100 }, { width: 800, height: 600 }), null);
});

test('tool screenshots use Anthropic image blocks and a following OpenAI image message', () => {
  const image = { type: 'image', mediaType: 'image/jpeg', data: 'aW1n' };
  const messages = [
    { role: 'assistant', text: '', toolCalls: [{ id: 'call-1', name: 'browser', input: { action: 'screenshot' } }] },
    { role: 'tool', results: [{ id: 'call-1', name: 'browser', output: 'Screenshot captured.', images: [image] }] },
  ];
  const anthropic = anthropicMessages(messages);
  const result = anthropic.at(-1).content[0];
  assert.equal(result.type, 'tool_result');
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(result.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aW1n' } });
  const openAi = openAiMessages({ stable: '', volatile: '' }, messages);
  const toolAt = openAi.findIndex((message) => message.role === 'tool');
  assert.equal(openAi[toolAt].content, 'Screenshot captured.');
  assert.equal(openAi[toolAt + 1].role, 'user');
  assert.equal(openAi[toolAt + 1].content[1].type, 'image_url');
  assert.match(openAi[toolAt + 1].content[1].image_url.url, /^data:image\/jpeg;base64,aW1n$/);
});

test('tool images count toward context and are omitted explicitly under pressure and on disk', async () => {
  const image = { type: 'image', mediaType: 'image/jpeg', data: 'aW1n' };
  const message = { role: 'tool', results: [{ id: 'call-1', name: 'browser', output: 'Screenshot captured.', images: [image] }] };
  assert.ok(estimateRequestTokens({ system: { stable: '', volatile: '' }, messages: [message], tools: [] }) > 1_100);
  const fitted = fitHistory({ messages: [message], budget: 50 });
  assert.equal(fitted.trimmed, true);
  assert.equal(fitted.messages[0].results[0].images, undefined);
  assert.match(fitted.messages[0].results[0].output, /image omitted to fit/);
  const store = new SessionStore(join(temporary, 'session-store'));
  await store.create({ sessionId: 'h-browser1', workspaceRoot: '/workspace', title: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await store.append('h-browser1', [{ type: 'message', message }]);
  const restored = await store.read('h-browser1');
  assert.equal(restored.messages[0].results[0].images, undefined);
  assert.match(restored.messages[0].results[0].output, /omitted from saved history/);
});

/** Opt-in live verification: npm test does not require a browser installation. */
test('standalone bundled bridge navigates, interacts, captures and closes a real Chromium page', { skip: process.env.GLITTER_BROWSER_LIVE_TEST !== '1', timeout: 90_000 }, async () => {
  const html = `<!doctype html><title>Browser smoke</title><style>body{font:20px sans-serif;padding:40px;background:#f7f3ee}input,button{font:inherit;padding:10px;margin:6px}#out{color:#175f3a}</style><label for="name">Name</label><input id="name" aria-label="Name"><button id="go">Go</button><h1 id="out">Ready</h1><script>document.getElementById('go').onclick=()=>{document.getElementById('out').textContent='Hello '+document.getElementById('name').value;console.error('smoke-console')}</script>`;
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const isolated = join(temporary, 'standalone');
  await mkdir(isolated, { recursive: true });
  await copyFile(resolve('packages/glitter-harness/dist/index.js'), join(isolated, 'index.js'));
  const child = spawn(process.execPath, [join(isolated, 'index.js')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GLITTER_NATIVE_BROWSER_CHECK: '', GLITTER_BROWSER_BIN: '', GLITTER_BROWSER_SHA256: '' } });
  child.stderr.on('data', () => {});
  const pending = new Map();
  const events = [];
  let buffer = '';
  let next = 0;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf('\n');
      if (at < 0) break;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.type === 'event') { events.push(message); continue; }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.ok) waiter.resolve(message.result);
        else waiter.reject(new Error(message.error));
      }
    }
  });
  function request(method, params) {
    const id = `browser-${++next}`;
    const result = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`Timed out: ${method}`)); }, 30_000).unref();
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return result;
  }
  const root = '/tmp/glitter-browser-live';
  try {
    const address = server.address();
    const opened = await request('browserOpen', { workspaceRoot: root, url: `http://127.0.0.1:${address.port}/`, width: 900, height: 700 });
    assert.equal(opened.state.status, 'ready');
    const snapshot = await request('browserControl', { workspaceRoot: root, action: 'snapshot' });
    const inputRef = snapshot.text.split('\n').find((line) => line.includes('textbox') && line.includes('Name'))?.match(/\[ref=([^\]]+)\]/)?.[1];
    const buttonRef = snapshot.text.split('\n').find((line) => line.includes('button') && line.includes('Go'))?.match(/\[ref=([^\]]+)\]/)?.[1];
    assert.ok(inputRef && buttonRef, snapshot.text);
    await request('browserControl', { workspaceRoot: root, action: 'type', ref: inputRef, text: 'Glitter' });
    await request('browserControl', { workspaceRoot: root, action: 'click', ref: buttonRef });
    const after = await request('browserControl', { workspaceRoot: root, action: 'snapshot' });
    assert.match(after.text, /Hello Glitter/);
    const screenshot = await request('browserControl', { workspaceRoot: root, action: 'screenshot' });
    assert.ok(screenshot.image?.data.length > 1_000);
    assert.ok(!screenshot.text.includes(screenshot.image.data), 'base64 never enters text output');
    const logs = await request('browserControl', { workspaceRoot: root, action: 'console' });
    assert.match(logs.text, /smoke-console/);
    const before = events.filter((event) => event.event === 'browserFrame').length;
    await request('browserControl', { workspaceRoot: root, action: 'setStreaming', stream: true });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.ok(events.filter((event) => event.event === 'browserFrame').length > before, 'live panel receives frames');
    await request('browserControl', { workspaceRoot: root, action: 'setStreaming', stream: false });
    const closed = await request('browserClose', { workspaceRoot: root });
    assert.equal(closed.state.status, 'closed');
    child.stdin.end();
    await Promise.race([once(child, 'exit'), new Promise((_, reject) => setTimeout(() => reject(new Error('Bridge did not shut down')), 5_000))]);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    server.close();
  }
});
