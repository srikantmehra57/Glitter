import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The `glitter` command: argument parsing, the credentials and defaults it
 * shares with the app, terminal safety, and whole runs against a local
 * stand-in for the Anthropic API.
 */

const temporary = await realpath(await mkdtemp(join(tmpdir(), 'glitter-cli-')));
after(() => rm(temporary, { recursive: true, force: true }));

const entry = join(temporary, 'units.ts');
await writeFile(entry, `
export { parseArgs, PERMISSIONS, UsageError } from ${JSON.stringify(resolve('packages/glitter-harness/src/cli/args.ts'))};
export { envCredentials, keychainCredentials, loadCredentials, appDefaults, safeBaseUrl, appDataDir } from ${JSON.stringify(resolve('packages/glitter-harness/src/cli/config.ts'))};
export { safeText, toolSummary } from ${JSON.stringify(resolve('packages/glitter-harness/src/cli/render.ts'))};
`);
const units = join(temporary, 'units.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: units, logLevel: 'silent' });
const { parseArgs, PERMISSIONS, UsageError, envCredentials, keychainCredentials, loadCredentials, appDefaults, safeBaseUrl, appDataDir, safeText, toolSummary } = await import(pathToFileURL(units).href);

const cli = join(temporary, 'cli.mjs');
await build({ entryPoints: [resolve('packages/glitter-harness/src/cli.ts')], bundle: true, platform: 'node', format: 'esm', outfile: cli, logLevel: 'silent', define: { __GLITTER_VERSION__: '"9.9.9-test"' } });

/** The app's model library, as Settings → Models & providers would have saved it. */
await mkdir(join(temporary, 'harness'), { recursive: true });
await writeFile(join(temporary, 'harness', 'models.json'), JSON.stringify([{ providerId: 'anthropic', model: 'claude-test', source: 'user', addedAt: '2026-01-01T00:00:00.000Z' }]));

test('arguments select chat, headless and listing runs', () => {
  assert.deepEqual(
    { ...parseArgs(['-p', 'fix', 'the', 'bug', '--output-format', 'json', '-m', 'anthropic/x']) },
    { command: 'chat', print: true, prompt: 'fix the bug', outputFormat: 'json', model: 'anthropic/x', continueLast: false, mcp: false, trust: false, keychain: true, verbose: false },
  );
  assert.equal(parseArgs(['models']).command, 'models');
  assert.equal(parseArgs(['sessions']).command, 'sessions');
  assert.equal(parseArgs(['-p', 'models']).prompt, 'models', 'a headless prompt is never a subcommand');
  assert.equal(parseArgs(['--permission-mode=full-access']).permission, 'full-access');
  assert.equal(parseArgs(['-C', '/tmp/x', '-c']).continueLast, true);
  assert.equal(parseArgs(['--', '-p', 'literal']).prompt, '-p literal');
  assert.equal(parseArgs(['-h']).command, 'help');
  assert.equal(PERMISSIONS.ask, 'onRequest');
  assert.equal(PERMISSIONS['read-only'], 'denyUnmatched');
});

test('bad arguments are refused with a reason', () => {
  for (const [argv, reason] of [
    [['--bogus'], /Unknown option/],
    [['-m'], /needs a value/],
    [['-m', '-p'], /needs a value/],
    [['--mode', 'yolo'], /build or plan/],
    [['--permission-mode', 'root'], /read-only/],
    [['--output-format', 'json'], /only with -p/],
    [['-p', '--output-format', 'xml'], /text, json, stream-json/],
    [['-c', '-r', 'h-x'], /not both/],
  ]) assert.throws(() => parseArgs(argv), (error) => error instanceof UsageError && reason.test(error.message), argv.join(' '));
});

test('environment keys and addresses lay over the app keychain', () => {
  const keychain = JSON.stringify({ anthropic: { key: 'kc-anthropic' }, 'custom-1': { key: 'kc-custom', baseUrl: 'https://llm.example/v1', name: 'Mine', wire: 'openai' } });
  const read = () => keychain;
  const merged = loadCredentials({ keychain: true, platform: 'darwin', read, env: { ANTHROPIC_API_KEY: 'env-anthropic', GEMINI_API_KEY: 'env-google', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' } });
  assert.deepEqual(merged.anthropic, { key: 'env-anthropic', baseUrl: 'http://127.0.0.1:9999/v1' });
  assert.deepEqual(merged.google, { key: 'env-google' });
  assert.equal(merged['custom-1'].baseUrl, 'https://llm.example/v1', 'a custom endpoint keeps its address');
  assert.deepEqual(loadCredentials({ keychain: false, platform: 'darwin', read, env: {} }), {}, '--no-keychain skips the app entry');
  assert.deepEqual(loadCredentials({ keychain: true, platform: 'linux', read, env: {} }), {}, 'only macOS has the app keychain');
  assert.deepEqual(keychainCredentials(() => Buffer.from(keychain).toString('hex')).anthropic, { key: 'kc-anthropic' }, 'hex output from security is decoded');
  assert.deepEqual(keychainCredentials(() => { throw new Error('not found'); }), {});
  assert.deepEqual(keychainCredentials(() => 'not json'), {});
  assert.throws(() => envCredentials({ OPENAI_BASE_URL: 'http://evil.example/v1' }), /https address/);
});

test('a provider address must be https, or http on this machine', () => {
  assert.equal(safeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(safeBaseUrl('http://localhost:1234/v1'), 'http://localhost:1234/v1');
  assert.equal(safeBaseUrl('http://10.0.0.2/v1'), null);
  assert.equal(safeBaseUrl('https://user:pass@example.com'), null);
  assert.equal(safeBaseUrl('file:///etc/passwd'), null);
});

test('app defaults come from the app settings file, and unusable ones are dropped', async () => {
  const file = join(temporary, 'glitter.json');
  await writeFile(file, JSON.stringify({ settings: { defaultModel: 'anthropic/claude-x', defaultEffort: 'high', defaultApprovalMode: 'guarded', harnessRules: [{ effect: 'deny', rule: 'Read(.env)' }, { effect: 'maybe', rule: 'x' }] } }));
  assert.deepEqual(appDefaults(file), { modelId: 'anthropic/claude-x', effort: 'high', approvalMode: 'guarded', rules: [{ effect: 'deny', rule: 'Read(.env)' }] });
  await writeFile(file, JSON.stringify({ settings: { defaultModel: 'grok-4.7' } }));
  assert.deepEqual(appDefaults(file), { rules: [] }, 'a model id without a provider is from an earlier agent');
  assert.deepEqual(appDefaults(join(temporary, 'missing.json')), { rules: [] });
  assert.equal(appDataDir('/Users/me', 'darwin'), '/Users/me/Library/Application Support/com.glitter.desktop');
});

test('terminal output drops escape sequences and control characters', () => {
  assert.equal(safeText('ok\u001b[2J\u001b]0;pwned\u0007 done\r\n\u0000x'), 'ok done\nx');
  assert.equal(safeText('tab\tand\nnewline'), 'tab\tand\nnewline');
  assert.equal(toolSummary({ commandText: 'ls -la' }), '$ ls -la');
  assert.equal(toolSummary({ args: JSON.stringify({ path: 'src/a.ts' }) }), 'src/a.ts');
  assert.equal(toolSummary({ args: 'not json' }), '');
});

// ─── Whole runs ───────────────────────────────────────────────────────────

const frames = (events) => events.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const text = (words) => frames([
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
]);
const tool = (id, name, input) => frames([
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
]);

/** A stand-in Anthropic API. Each chat call takes the next scripted reply; every request body is kept. */
async function provider(script) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (request.url.startsWith('/v1/models')) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'claude-test', display_name: 'Claude Test' }] }));
        return;
      }
      requests.push(JSON.parse(body));
      const reply = script[requests.length - 1] ?? text('No more replies.');
      response.setHeader('content-type', 'text/event-stream');
      response.end(reply);
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  after(() => server.close());
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

async function run(args, { url, cwd, input, env = {} }) {
  const home = join(temporary, 'home');
  await mkdir(home, { recursive: true });
  const child = spawn(process.execPath, [cli, '--no-keychain', ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: home, NO_COLOR: '1', GLITTER_HARNESS_DIR: join(temporary, 'harness'), ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: url, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const code = await new Promise((done) => child.on('close', done));
  clearTimeout(timer);
  return { code, stdout, stderr };
}

async function project() {
  const root = await mkdtemp(join(temporary, 'ws-'));
  await writeFile(join(root, 'hello.txt'), 'one\n');
  return root;
}

test('glitter -p prints the reply, saves the thread, and -c continues it', async () => {
  const api = await provider([text('Hello from the stub.'), text('Second answer.')]);
  const cwd = await project();
  const first = await run(['-p', 'say hello'], { url: api.url, cwd });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout.trim(), 'Hello from the stub.');
  assert.equal(api.requests[0].model, 'claude-test');
  const listed = await run(['sessions'], { url: api.url, cwd });
  assert.match(listed.stdout, /^h-[a-z0-9-]+ /m);
  const again = await run(['-c', '-p', 'and again', '--output-format', 'json'], { url: api.url, cwd });
  assert.equal(again.code, 0, again.stderr);
  const result = JSON.parse(again.stdout.trim());
  assert.equal(result.type, 'result');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.text, 'Second answer.');
  assert.equal(result.sessionId, listed.stdout.split(' ')[0]);
  const history = JSON.stringify(api.requests[1].messages);
  assert.ok(history.includes('say hello') && history.includes('Hello from the stub.'), 'the second turn carries the first');
  const index = JSON.parse(await readFile(join(temporary, 'harness', 'index.json'), 'utf8'));
  assert.ok(index.some((meta) => meta.sessionId === result.sessionId && meta.workspaceRoot === cwd), 'the app reads the same index');
});

test('a headless run denies a step that needs approval and says so', async () => {
  const api = await provider([tool('tu_1', 'bash', { command: 'touch made-by-agent.txt' }), text('Could not run it.')]);
  const cwd = await project();
  const result = await run(['-p', 'make a file'], { url: api.url, cwd });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Denied bash/);
  assert.equal(existsSync(join(cwd, 'made-by-agent.txt')), false);
  assert.equal(result.stdout.trim(), 'Could not run it.');
  const denial = JSON.stringify(api.requests[1].messages);
  assert.match(denial, /denied|rejected|declined/i, 'the model is told the step was refused');
});

test('stdin becomes the prompt, and stream-json emits one event per line', async () => {
  const api = await provider([text('Summarized.')]);
  const cwd = await project();
  const result = await run(['-p', '--output-format', 'stream-json'], { url: api.url, cwd, input: 'summarize this text' });
  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === 'item' && event.item?.kind === 'agentMessage'));
  assert.deepEqual(events.at(-1).type, 'result');
  assert.ok(JSON.stringify(api.requests[0].messages).includes('summarize this text'));
});

test('a chat answers approvals and slash commands from its input', async () => {
  const api = await provider([tool('tu_1', 'bash', { command: 'touch approved.txt' }), text('Made it.')]);
  const cwd = await project();
  const result = await run([], { url: api.url, cwd, input: 'make approved.txt\n1\n/status\n/exit\n' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Approval needed bash/);
  assert.match(result.stdout, /Made it\./);
  assert.match(result.stdout, /Permissions\s+ask/);
  assert.match(result.stdout, /Continue with: glitter -r h-/);
  assert.equal(existsSync(join(cwd, 'approved.txt')), true, 'the approved command ran');
});

test('without a provider, or in the home folder, the CLI explains and stops', async () => {
  const cwd = await project();
  const bare = await run(['-p', 'hi'], { url: 'http://127.0.0.1:1', cwd, env: { ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: '' } });
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /no model provider is set up/);
  const home = await run(['-p', 'hi'], { url: 'http://127.0.0.1:1', cwd: join(temporary, 'home') });
  assert.equal(home.code, 2);
  assert.match(home.stderr, /whole home folder/);
  const version = await run(['--version'], { url: 'http://127.0.0.1:1', cwd });
  assert.equal(version.stdout.trim(), 'glitter 9.9.9-test');
});
