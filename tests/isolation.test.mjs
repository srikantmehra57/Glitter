import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-isolation-'));
const outfile = join(temporary, 'isolation.mjs');
await build({ entryPoints: [resolve('packages/glitter-bridge/src/isolation.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const {
  filterChildEnv, confinedCwd, approvalAlive, approvalExpiry, approvalExpiryMono, describeIsolation, HOST_QUEUE_LIMIT,
  buildSeatbeltProfile, wrapSandboxedCommand, sandboxBackend, ensureDirectories, terminateTree,
} = await import(pathToFileURL(outfile).href);

test('child env keeps PATH/HOME and strips unrelated secrets', () => {
  const env = filterChildEnv({
    PATH: '/usr/bin',
    HOME: '/Users/me',
    META_API_KEY: 'sk-muse',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    GITHUB_TOKEN: 'ghp_secret',
    NODE_OPTIONS: '--require ./evil.js',
    XAI_API_KEY: 'xai-key',
  }, 'grok');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/Users/me');
  assert.equal(env.XAI_API_KEY, 'xai-key');
  assert.equal('META_API_KEY' in env, false);
  assert.equal('AWS_SECRET_ACCESS_KEY' in env, false);
  assert.equal('GITHUB_TOKEN' in env, false);
  assert.equal('NODE_OPTIONS' in env, false);
});

test('Muse children may receive META_API_KEY and nothing else secret', () => {
  const env = filterChildEnv({ META_API_KEY: 'sk-muse', AWS_SECRET_ACCESS_KEY: 'aws', PATH: '/bin' }, 'muse');
  assert.equal(env.META_API_KEY, 'sk-muse');
  assert.equal('AWS_SECRET_ACCESS_KEY' in env, false);
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

test('agent seatbelt stays write-scoped to the workspace and the agent config', () => {
  const profile = buildSeatbeltProfile('agent', 'grok', ['/work/repo']);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /subpath "\/work\/repo"/);
  assert.match(profile, /\.grok/);
  assert.doesNotMatch(profile, /subpath "[^"]*\/\.config"/, 'does not grant all of ~/.config');
  assert.doesNotMatch(profile, /subpath "[^"]*\/Application Support"/, 'does not grant all of ~/Library/Application Support');
  assert.match(profile, /\(allow default\)/);
});

test('a Cline child gets its own key, and its own config directory is writable', () => {
  const env = filterChildEnv({ PATH: '/usr/bin', CLINE_API_KEY: 'cline-key', CLINE_MODEL: 'anthropic/claude-sonnet-5.5', OPENAI_API_KEY: 'openai-key' }, 'cline');
  assert.equal(env.CLINE_API_KEY, 'cline-key');
  assert.equal(env.CLINE_MODEL, 'anthropic/claude-sonnet-5.5');
  assert.equal('OPENAI_API_KEY' in env, false, 'another provider\'s key stays out');
  const profile = buildSeatbeltProfile('agent', 'cline', ['/work/repo']);
  assert.match(profile, /\.cline/);
  assert.doesNotMatch(profile, /subpath "[^"]*\/\.config"/, 'does not grant all of ~/.config');
});

test('muse seatbelt denies system paths and still allows temp and /usr/local', () => {
  const profile = buildSeatbeltProfile('muse', 'muse');
  assert.match(profile, /subpath "\/usr"\)/);
  assert.match(profile, /subpath "\/System"\)/);
  assert.match(profile, /subpath "\/usr\/local"\)/);
  assert.match(profile, /subpath "\/tmp"\)/);
  assert.doesNotMatch(profile, /subpath "\/home\/secret"/);
});

test('a missing agent config directory is created before the sandbox can grant it', () => {
  const root = join(tmpdir(), `muse-config-${process.pid}`);
  const parent = join(root, '.config');
  const child = join(parent, 'grok');
  try {
    assert.equal(existsSync(child), false);
    ensureDirectories([child]);
    assert.equal(existsSync(child), true);
    // The parent is created only so the child can exist. It is not what the profile grants.
    assert.equal(existsSync(parent), true);
    if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
      const childReal = realpathSync(child);
      const parentReal = realpathSync(parent);
      const profile = `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath "${childReal}"))\n`;
      const write = (path) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', `echo ok > ${JSON.stringify(path)}`], { timeout: 8000, encoding: 'utf8' });
      const inside = write(join(child, 'probe'));
      if (inside.status !== 0 && /sandbox_apply: Operation not permitted/.test(inside.stderr ?? '')) return;
      assert.equal(inside.status, 0, inside.stderr);
      assert.equal(existsSync(join(child, 'probe')), true);
      const outside = write(join(parent, 'probe'));
      assert.notEqual(outside.status, 0, 'the parent directory stays outside the allow-list');
      assert.equal(existsSync(join(parent, 'probe')), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('suggestion seatbelt denies reading file contents in the workspace and still allows a file outside it', () => {
  const profile = buildSeatbeltProfile('agent', 'muse', [], ['/work/repo']);
  assert.match(profile, /deny file-read-data/);
  assert.match(profile, /subpath "\/work\/repo"/);
  // Muse's config is writable and re-allowed for reads wherever `muse /login`
  // keeps it, including the macOS Application Support path.
  assert.match(profile, /Library\/Application Support\/muse/);
  assert.doesNotMatch(buildSeatbeltProfile('agent', 'grok', ['/work/repo']), /file-read-data/);
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return;
  const root = mkdtempSync(join(tmpdir(), 'muse-deny-'));
  const secret = join(root, 'secret.txt');
  try {
    writeFileSync(secret, 'secret-contents');
    const denied = buildSeatbeltProfile('agent', 'muse', [], [root]);
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

test('wrap uses the platform sandbox and leaves the muse arguments intact', () => {
  const wrapped = wrapSandboxedCommand('/fake/muse', ['serve', '--trust-workspace'], { kind: 'muse', agentId: 'muse', backend: sandboxBackend() });
  const at = wrapped.args.lastIndexOf('serve');
  assert.deepEqual(wrapped.args.slice(at), ['serve', '--trust-workspace']);
  if (sandboxBackend() === 'none') {
    assert.equal(wrapped.sandboxed, false);
    assert.equal(wrapped.command, '/fake/muse');
  } else {
    assert.equal(wrapped.sandboxed, true);
    assert.notEqual(wrapped.command, '/fake/muse');
    assert.ok(wrapped.args.includes('/fake/muse'));
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

test('a seatbelt profile parses and confines writes', () => {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return;
  const root = join(tmpdir(), `muse-sb-${process.pid}`);
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
