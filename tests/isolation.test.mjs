import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'glitter-isolation-'));
const outfile = join(temporary, 'isolation.mjs');
await build({ entryPoints: [resolve('packages/glitter-harness/src/isolation.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const {
  filterChildEnv, confinedCwd, approvalAlive, approvalExpiry, approvalExpiryMono, describeIsolation, HOST_QUEUE_LIMIT,
  buildSeatbeltProfile, wrapSandboxedCommand, sandboxBackend, terminateTree, credentialRoots,
} = await import(pathToFileURL(outfile).href);

test('an offline profile keeps outbound traffic on this Mac, and the default stays online', () => {
  const offline = buildSeatbeltProfile(['/work'], [], false);
  assert.match(offline, /\(deny network-outbound\)/);
  assert.match(offline, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/, 'local dev servers stay reachable');
  assert.match(offline, /\(allow network-outbound \(remote unix-socket\)\)/, 'name lookup still works');
  assert.doesNotMatch(buildSeatbeltProfile(['/work']), /network-outbound/, 'online commands are unchanged');
  const roots = credentialRoots('/Users/someone');
  assert.ok(roots.includes('/Users/someone/.aws'));
  assert.ok(roots.includes('/Users/someone/Library/Keychains'));
  assert.ok(!roots.includes('/Users/someone/.ssh'), 'SSH keys stay readable for signed commits');
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
