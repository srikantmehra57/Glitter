import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-lib-'));
let sequence = 0;
async function bundle(entry) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const { groupAgentRuns, classifyTool, messageRewindBoundary } = await bundle('apps/desktop/src/lib/agent.ts');
const { parseUnifiedDiff, dropHunk, unquoteDiffPath, wordChanges, splitDiffLines, reviewTarget } = await bundle('apps/desktop/src/lib/diff.ts');
const { normalizeDockWidth, dockWidthBounds, clampDockWidth, sidebarWidthFor, sidebarWidthBounds, normalizeSidebarWidth } = await bundle('apps/desktop/src/lib/reviewLayout.ts');
const { composePrompt, shortHash, threadStatusLines, worktreeRemovalNote } = await bundle('apps/desktop/src/lib/format.ts');
const { classifyError, describeError, authRequired, isGrantError } = await bundle('apps/desktop/src/lib/errors.ts');
const { SessionMemoryPersistence, normalizeMemory, normalizeDraft, persistableDrafts, rememberPrompt, SESSION_MEMORY_VERSION } = await bundle('apps/desktop/src/lib/sessionMemory.ts');
const { resolveMuseBin } = await bundle('packages/glitter-bridge/src/detect.ts');
const { agentEnabled, DEFAULT_ENABLED_AGENTS, DEFAULT_SETTINGS, skillScopeArg } = await bundle('apps/desktop/src/lib/types.ts');
const { settingsFields } = await bundle('apps/desktop/src/lib/settingsPersistence.ts');
const { resolveTheme, shellOpacity, normalizeTranslucency } = await bundle('apps/desktop/src/lib/theme.ts');
const { rekeyThreadState, projectDraftForAgent } = await bundle('apps/desktop/src/lib/agentSwitch.ts');
const { mcpServerNameProblem, mcpServerSummary, parseMcpArguments, parseMcpKeyValues } = await bundle('apps/desktop/src/lib/mcpConfig.ts');

test('groups transcript items into agent runs by turnId', () => {
  const runs = groupAgentRuns([
    { itemId: 'u', kind: 'userMessage', status: 'completed', text: 'Fix auth', turnId: 't1' },
    { itemId: 'r', kind: 'reasoning', status: 'completed', text: 'Inspect the session store', turnId: 't1' },
    { itemId: 'tool', kind: 'toolCall', status: 'completed', tool: 'read_file', args: '{"path":"src/app.ts"}', turnId: 't1' },
    { itemId: 'a', kind: 'agentMessage', status: 'completed', text: 'Updated refresh handling.', turnId: 't1' },
  ], { activeTurnId: null });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].steps.length, 4);
  assert.equal(runs[0].steps[2].kind, 'read');
  assert.equal(runs[0].steps[2].path, 'src/app.ts');
  assert.equal(runs[0].status, 'completed');
});

test('keeps the latest run running when the thread is still working', () => {
  const runs = groupAgentRuns([
    { itemId: 'u', kind: 'userMessage', status: 'completed', text: 'Summarize this' },
  ], { threadRunning: true });
  assert.equal(runs[0].status, 'running');
});

test('marks a finished turn as cancelled from lastOutcome', () => {
  const runs = groupAgentRuns([
    { itemId: 'u', kind: 'userMessage', status: 'completed', text: 'Go', turnId: 't1' },
    { itemId: 'a', kind: 'agentMessage', status: 'completed', text: 'Halfway', turnId: 't1' },
  ], { lastTurnId: 't1', lastOutcome: 'cancelled' });
  assert.equal(runs[0].status, 'cancelled');
});

test('marks the active turn as running and waiting', () => {
  const runs = groupAgentRuns([
    { itemId: 'u', kind: 'userMessage', status: 'completed', text: 'Go', turnId: 'live' },
    { itemId: 't', kind: 'toolCall', status: 'inProgress', tool: 'bash', args: '{"command":"npm test"}', turnId: 'live' },
  ], { activeTurnId: 'live', waiting: true });
  assert.equal(runs[0].status, 'waiting');
  assert.equal(classifyTool('bash', 'userShell'), 'command');
});

test('a stale active turn id cannot resurrect a settled thread', () => {
  const runs = groupAgentRuns([
    { itemId: 'u', kind: 'userMessage', status: 'completed', text: 'Go', turnId: 'stale' },
    { itemId: 't', kind: 'toolCall', status: 'cancelled', tool: 'bash', turnId: 'stale' },
  ], { activeTurnId: 'stale', lastTurnId: 'stale', lastOutcome: 'cancelled', threadRunning: false });
  assert.equal(runs[0].status, 'cancelled');
});

test('composePrompt prefixes file references without inventing text', () => {
  assert.equal(composePrompt('Fix auth', [{ path: 'src/app.ts' }]), '@src/app.ts\n\nFix auth');
  assert.equal(composePrompt('', [{ path: 'README.md' }]), '@README.md');
  assert.equal(composePrompt('Hello'), 'Hello');
});

test('message rewind keeps the preceding turn and only treats complete history as the first message', () => {
  const items = [
    { itemId: 'u1', kind: 'userMessage', status: 'completed', turnId: 't1' },
    { itemId: 'a1', kind: 'agentMessage', status: 'completed', turnId: 't1' },
    { itemId: 'u2', kind: 'userMessage', status: 'completed', turnId: 't2' },
    { itemId: 'a2', kind: 'agentMessage', status: 'completed', turnId: 't2' },
  ];
  assert.deepEqual(messageRewindBoundary({ items }, 'u2'), { turnId: 't2', lastTurnId: 't1' });
  assert.deepEqual(messageRewindBoundary({ items, historyExhausted: true }, 'u1'), { turnId: 't1' });
  assert.match(messageRewindBoundary({ items, historyExhausted: false }, 'u1').error, /Load earlier messages/);
  assert.match(messageRewindBoundary({ items, historyFailed: true }, 'u2').error, /History is incomplete/);
  assert.match(messageRewindBoundary({ items, viewGap: { state: 'failed' } }, 'u2').error, /History is incomplete/);
});

test('message rewind refuses unconfirmed, live, or within-turn boundaries', () => {
  const user = { itemId: 'u', kind: 'userMessage', status: 'completed', turnId: 't2' };
  for (const patch of [{ optimistic: true }, { turnId: undefined }, { turnId: 'local:u' }, { turnId: 'history' }]) {
    assert.match(messageRewindBoundary({ items: [{ ...user, ...patch }], historyExhausted: true }, 'u').error, /no confirmed turn boundary/);
  }
  const first = { itemId: 'u1', kind: 'userMessage', status: 'completed', turnId: 't1' };
  assert.match(messageRewindBoundary({ items: [{ ...first, turnId: undefined }, user], historyExhausted: true }, 'u').error, /preceding message/);
  assert.match(messageRewindBoundary({ items: [{ ...first, status: 'inProgress' }, user] }, 'u').error, /completed boundary/);
  assert.match(messageRewindBoundary({ items: [{ ...first, turnId: 't2' }, user] }, 'u').error, /first message of this run/);
});

test('Last turn review uses the latest completed canonical turn and never falls back past an unavailable snapshot', () => {
  const snapshot = { snapshotId: 'snap-1', state: 'ready' };
  const thread = { sessionId: 's', workspacePath: '/repo', lastTurnId: 't1', activeTurnId: 't2', items: [{ turnId: 't2', text: 'Live' }], snapshots: { t1: snapshot } };
  const state = { reviewScope: 'lastTurn', reviewBase: '', selectedWorkspaceId: 'w', selectedSessionId: 's', workspaces: [{ id: 'w', path: '/repo', grantId: 'g' }], threads: [thread] };
  const target = reviewTarget(state);
  assert.deepEqual(target.request, { scope: 'lastTurn', sessionId: 's', snapshotId: 'snap-1' });
  assert.equal(reviewTarget({ ...state, threads: [{ ...thread, items: [{ turnId: 't2', text: 'More live output' }] }] }).key, target.key);
  const unavailable = { ...thread, activeTurnId: null, lastTurnId: 't2', snapshots: { t1: snapshot, t2: { snapshotId: 'snap-2', state: 'unavailable', reason: 'Capture failed' } } };
  assert.equal(reviewTarget({ ...state, threads: [unavailable] }).request, undefined);
  assert.equal(reviewTarget({ ...state, threads: [unavailable] }).notice, 'Capture failed');
  const historical = { ...thread, lastTurnId: undefined, items: [{ turnId: 't1', text: 'Earlier' }, { turnId: 't2', text: 'Live' }] };
  assert.deepEqual(reviewTarget({ ...state, threads: [historical] }).request, target.request);
});

test('review identities fence workspace grants, threads, scope, base and snapshot availability', () => {
  const state = { reviewScope: 'branch', reviewBase: 'main', selectedWorkspaceId: 'w', selectedSessionId: 's', workspaces: [{ id: 'w', path: '/repo', grantId: 'g' }], threads: [] };
  const key = reviewTarget(state).key;
  for (const patch of [{ reviewBase: 'other' }, { reviewScope: 'staged' }, { selectedSessionId: 'other' }, { workspaces: [{ id: 'w', path: '/repo', grantId: 'new' }] }]) assert.notEqual(reviewTarget({ ...state, ...patch }).key, key);
  assert.deepEqual(reviewTarget(state).request, { scope: 'branch', base: 'main' });
  assert.equal(reviewTarget({ ...state, reviewBase: '' }).request, undefined);
  assert.match(reviewTarget({ ...state, reviewScope: 'lastTurn' }).notice, /Choose a thread/);
});

test('parses unified diffs per file', () => {
  const { files } = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`);
  assert.equal(files[0].path, 'src/a.ts');
  assert.equal(files[0].lines.filter((line) => line.type === 'add').length, 1);
});

test('dropHunk removes only the indexed block of the named file', () => {
  const diff = 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-x\n+y\n';
  const dropped = dropHunk(diff, 'f.txt', 0);
  assert.ok(!dropped.includes('@@ -1 +1 @@') && dropped.includes('@@ -10 +10 @@'));
  assert.ok(dropped.includes('diff --git a/f.txt b/f.txt'));
  assert.equal(dropHunk(diff, 'other.txt', 0), diff);
  assert.equal(dropHunk(diff, 'f.txt', 9), diff);
});

test('classifies auth and host failures', () => {
  assert.equal(classifyError('not logged in: run /login').code, 'auth');
  assert.equal(classifyError('Muse connection closed. Reconnect from Settings.').code, 'host');
  assert.equal(authRequired({ params: { error: { kind: 'authRequired', message: 'login' } } }), true);
});

test('grant failures match on both renderer and native wording', () => {
  // ENG-ARCH-001/DES-UX-004: needsGrant delegates to isGrantError, and the
  // recovery CTA only appears when the stored error still satisfies it — so
  // both sides of the IPC seam must land in the one grant matcher.
  assert.equal(isGrantError('This folder is not granted. Re-open it with Open workspace to restore access.'), true);
  assert.equal(isGrantError('Unknown workspace grant. Re-open the folder to restore access.'), true);
  assert.equal(isGrantError('Workspace folder no longer exists'), true);
  assert.equal(isGrantError('permission denied'), false);
  const classified = classifyError(new Error('Unknown workspace grant. Re-open the folder to restore access.'));
  assert.equal(classified.code, 'grant');
  assert.match(classified.detail, /Unknown workspace grant/, 'the native reason survives classification');
  assert.equal(
    isGrantError(describeError('Could not open the thread', new Error('Unknown workspace grant. Re-open the folder to restore access.'))),
    true,
    'the presented sentence must still satisfy the needsGrant matcher',
  );
});

test('session memory round-trips titles and archives without secrets', async () => {
  const saved = {};
  const persistence = new SessionMemoryPersistence({
    get: async (key) => saved[key],
    set: async (key, value) => { saved[key] = value; },
    save: async () => {},
  });
  await persistence.save(normalizeMemory({
    selectedWorkspaceId: 'w',
    selectedSessionId: 's',
    threadMeta: { s: { title: 'Auth refresh', customTitle: true, pinned: true } },
    drafts: { 'thread:s': { text: 'continue', images: [] } },
  }));
  const loaded = await persistence.load();
  assert.equal(loaded.threadMeta.s.title, 'Auth refresh');
  assert.equal(loaded.drafts['thread:s'].text, 'continue');
  assert.equal(JSON.stringify(loaded).includes('museApiKey'), false);
});

test('draft image bytes never enter the settings document, but their references do', async () => {
  // ENG-DATA-003/ENG-PERF-002: four 10 MiB attachments as base64 push
  // glitter.json past the 48 MiB IPC limit and freeze ALL persistence.
  const image = { mediaType: 'image/png', base64Data: 'a'.repeat(1024), name: 'shot.png' };
  const saved = {};
  const persistence = new SessionMemoryPersistence({
    get: async (key) => saved[key],
    set: async (key, value) => { saved[key] = value; },
    save: async () => {},
  });
  // Even a caller that hands over byteful drafts cannot write them to disk.
  await persistence.save(normalizeMemory({ drafts: { 'workspace:w': { text: 'with shot', images: [image] } } }));
  const written = saved.sessionMemory;
  assert.equal(JSON.stringify(written).includes('base64Data'), false, 'no base64 field anywhere in the persisted drafts');
  assert.deepEqual(written.drafts['workspace:w'].images, []);
  assert.deepEqual(written.drafts['workspace:w'].droppedImages, [{ mediaType: 'image/png', name: 'shot.png' }]);
  // Hydration keeps the reference so the banner can name what to re-attach.
  const loaded = await persistence.load();
  assert.equal(loaded.drafts['workspace:w'].text, 'with shot');
  assert.deepEqual(loaded.drafts['workspace:w'].images, []);
  assert.deepEqual(loaded.drafts['workspace:w'].droppedImages, [{ mediaType: 'image/png', name: 'shot.png' }]);
});

test('draft normalization keeps in-memory shape honest across document versions', () => {
  // Legacy `{ text, images: [] }` drafts and malformed entries normalize
  // without throwing; a byteful image written by an older build still restores.
  const image = { mediaType: 'image/png', base64Data: 'aaaa', name: 'old.png' };
  assert.deepEqual(normalizeDraft({ text: 'hi', images: [] }), { text: 'hi', images: [] });
  assert.deepEqual(normalizeDraft(null), { text: '', images: [] });
  assert.deepEqual(normalizeDraft('junk'), { text: '', images: [] });
  const kept = normalizeDraft({ text: 'x', images: [image] });
  assert.equal(kept.images.length, 1);
  assert.equal(kept.images[0].base64Data, 'aaaa');
  // Reference-shaped entries (bytes stripped by a save) land in droppedImages.
  const refsOnly = normalizeDraft({ text: 'x', images: [{ mediaType: 'image/png', name: 'gone.png' }] });
  assert.deepEqual(refsOnly.images, []);
  assert.deepEqual(refsOnly.droppedImages, [{ mediaType: 'image/png', name: 'gone.png' }]);
  // persistableDrafts is the write boundary: images out, references merged in.
  const persisted = persistableDrafts({ 'thread:s': { text: 'd', images: [image], refs: [{ path: 'a.ts' }] } });
  assert.deepEqual(persisted['thread:s'].images, []);
  assert.deepEqual(persisted['thread:s'].droppedImages, [{ mediaType: 'image/png', name: 'old.png' }]);
  assert.deepEqual(persisted['thread:s'].refs, [{ path: 'a.ts' }]);
});

test('session memory keeps its version and will not replace a newer document', async () => {
  assert.equal(normalizeMemory(undefined).version, SESSION_MEMORY_VERSION);
  assert.equal(normalizeMemory({ drafts: {} }).version, SESSION_MEMORY_VERSION);
  const newer = normalizeMemory({ version: SESSION_MEMORY_VERSION + 1, drafts: { 'thread:s': { text: 'from the future', images: [] } } });
  assert.equal(newer.version, SESSION_MEMORY_VERSION + 1);
  assert.equal(newer.drafts['thread:s'].text, 'from the future');

  const saved = {
    sessionMemory: {
      version: SESSION_MEMORY_VERSION + 1,
      drafts: { 'thread:s': { text: 'from the future', images: [] } },
      futureOnly: { keep: true },
    },
  };
  const persistence = new SessionMemoryPersistence({
    get: async (key) => saved[key],
    set: async (key, value) => { saved[key] = value; },
    save: async () => {},
  });
  const loaded = await persistence.load();
  assert.equal(loaded.version, SESSION_MEMORY_VERSION + 1);
  await assert.rejects(
    () => persistence.save(normalizeMemory({ drafts: { 'thread:s': { text: 'downgrade', images: [] } } })),
    /version 2/,
  );
  assert.equal(saved.sessionMemory.version, SESSION_MEMORY_VERSION + 1);
  assert.equal(saved.sessionMemory.futureOnly.keep, true);
  assert.equal(saved.sessionMemory.drafts['thread:s'].text, 'from the future');
});

test('deleted archived threads stay forgotten in session memory', async () => {
  const saved = {};
  const persistence = new SessionMemoryPersistence({
    get: async (key) => saved[key],
    set: async (key, value) => { saved[key] = value; },
    save: async () => {},
  });
  await persistence.save(normalizeMemory({
    threadMeta: { gone: { title: 'Old', archived: true, deleted: true } },
  }));
  const loaded = await persistence.load();
  assert.equal(loaded.threadMeta.gone.deleted, true);
  assert.equal(loaded.threadMeta.gone.archived, true);
});

test('custom muse paths in temp dirs are rejected', () => {
  assert.equal(resolveMuseBin('/tmp/muse'), null);
  assert.equal(resolveMuseBin('/tmp/muse-audit-probe.sh'), null);
});

test('muse resolution checks the canonical target, not the link string', async () => {
  const { mkdtemp, mkdir, rm, symlink, writeFile, chmod, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // Non-temp link dir inside the repo (cleaned up); target inside temp.
  // Absolute: relative symlink targets resolve against the link's own dir.
  const outer = join(process.cwd(), 'tests', 'fixtures', `muse-link-${process.pid}`);
  await mkdir(outer, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), 'muse-resolve-'));
  try {
    const target = join(work, 'real-muse');
    await writeFile(target, '#!/bin/sh\necho hi\n');
    await chmod(target, 0o755);
    const link = join(outer, 'muse');
    await symlink(target, link);
    // The link string is non-temp and well-named, but its target is temp.
    assert.equal(resolveMuseBin(link), null);
    // A well-named non-temp target resolves even behind a misnamed link.
    await rm(link, { force: true });
    const real = join(outer, 'muse');
    await writeFile(real, '#!/bin/sh\necho hi\n');
    await chmod(real, 0o755);
    const alias = join(outer, 'launcher');
    await symlink(real, alias);
    assert.equal(resolveMuseBin(alias), await realpath(real));
    assert.equal(resolveMuseBin(join(work, 'missing')), null);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(outer, { recursive: true, force: true });
  }
});

test('OpenCode is off by default and can be toggled in persisted settings', () => {
  assert.equal(DEFAULT_ENABLED_AGENTS.opencode, false);
  assert.equal(agentEnabled({}, 'opencode'), false);
  assert.equal(agentEnabled({}, 'grok'), false);
  assert.equal(agentEnabled({ enabledAgents: { opencode: true } }, 'opencode'), true);
  const saved = settingsFields({ ...DEFAULT_SETTINGS, enabledAgents: { grok: false } });
  assert.equal(saved.enabledAgents.opencode, false);
  assert.equal(saved.enabledAgents.grok, false);
  assert.equal(saved.enabledAgents.muse, true);
  assert.equal(saved.acpUnisolatedConsent, false);
  assert.equal(settingsFields({ ...DEFAULT_SETTINGS, acpUnisolatedConsent: true }).acpUnisolatedConsent, true);
  assert.equal(settingsFields({ ...DEFAULT_SETTINGS, hideAgentCapabilities: true }).hideAgentCapabilities, true);
  assert.equal(settingsFields({ ...DEFAULT_SETTINGS, hideAgentCapabilities: 'true' }).hideAgentCapabilities, false);
  assert.equal(settingsFields(DEFAULT_SETTINGS).contributorMode, undefined, 'upgrades preserve the CLI preference');
  for (const contributorMode of ['on', 'off']) assert.equal(settingsFields({ ...DEFAULT_SETTINGS, contributorMode }).contributorMode, contributorMode);
  assert.equal(settingsFields({ ...DEFAULT_SETTINGS, contributorMode: 'auto' }).contributorMode, undefined);
  assert.equal(DEFAULT_SETTINGS.accentColor, 'ember');
  assert.equal(DEFAULT_SETTINGS.accentSidebar, false);
  const themed = settingsFields({ ...DEFAULT_SETTINGS, accentColor: 'green', accentSidebar: true });
  assert.equal(themed.accentColor, 'green');
  assert.equal(themed.accentSidebar, true);
});

test('the theme engine resolves appearance settings to root attributes and the shell opacity', () => {
  const base = { theme: 'system', accentColor: 'ember', accentSidebar: false, sidebarTranslucency: 50 };
  const desktop = { prefersDark: true, windowMaterial: true, reducedTransparency: false };
  const resolved = resolveTheme(base, desktop);
  assert.deepEqual(resolved.attributes, { theme: 'dark', accent: 'ember', sidebarAccent: 'false', translucent: 'true' });
  assert.equal(resolved.properties['--shell-opacity'], '0.56');
  // The native window follows the setting, not the resolved scheme: `system` hands the choice back to the OS.
  assert.equal(resolved.windowAppearance, 'system');
  assert.equal(resolveTheme({ ...base, theme: 'light' }, desktop).attributes.theme, 'light');
  assert.equal(resolveTheme({ ...base, theme: 'light' }, desktop).windowAppearance, 'light');
  assert.equal(resolveTheme({ ...base, accentSidebar: true, accentColor: 'teal' }, desktop).attributes.sidebarAccent, 'true');
  // Solid by choice, with nothing behind the page, or when the OS asks for it: the shell stays opaque.
  for (const [settings, environment] of [
    [{ ...base, sidebarTranslucency: 0 }, desktop],
    [base, { ...desktop, windowMaterial: false }],
    [base, { ...desktop, reducedTransparency: true }],
  ]) {
    const solid = resolveTheme(settings, environment);
    assert.equal(solid.attributes.translucent, 'false');
    assert.equal(solid.properties['--shell-opacity'], '1');
  }
});

test('sidebar translucency is clamped, defaulted and never fades the shell out entirely', () => {
  assert.equal(DEFAULT_SETTINGS.sidebarTranslucency, 50);
  assert.equal(normalizeTranslucency(undefined), 50);
  assert.equal(normalizeTranslucency('80'), 50);
  assert.equal(normalizeTranslucency(Number.NaN), 50);
  assert.equal(normalizeTranslucency(-20), 0);
  assert.equal(normalizeTranslucency(140), 100);
  assert.equal(normalizeTranslucency(33.6), 34);
  assert.equal(shellOpacity(0), 100);
  assert.equal(shellOpacity(100), 12);
  assert.ok(shellOpacity(25) > shellOpacity(75));
  // Settings saved before the option existed take the default; a saved value survives.
  const { sidebarTranslucency: _absent, ...older } = DEFAULT_SETTINGS;
  assert.equal(settingsFields(older).sidebarTranslucency, 50);
  assert.equal(settingsFields({ ...DEFAULT_SETTINGS, sidebarTranslucency: 85 }).sidebarTranslucency, 85);
});

test('shortHash truncates digests and leaves short text alone', () => {
  assert.equal(shortHash('sha256:df5e43fed1bd4c9a7c7358e2a3e69c67'), 'sha256:df5e43fed1bd…');
  assert.equal(shortHash('abc123'), 'abc123');
  assert.equal(shortHash('z'.repeat(40)), `${'z'.repeat(24)}…`);
  assert.equal(shortHash(null), '');
});

test('skill list scopes map to the enable/disable scope argument', () => {
  assert.equal(skillScopeArg('bundled'), 'built-in');
  assert.equal(skillScopeArg('built-in'), 'built-in');
  assert.equal(skillScopeArg('user'), 'user');
  assert.equal(skillScopeArg('project'), 'project');
  assert.equal(skillScopeArg('plugin'), 'plugin');
  assert.equal(skillScopeArg('  Bundled '), 'built-in');
  assert.equal(skillScopeArg('marketplace'), null);
  assert.equal(skillScopeArg(''), null);
});

test('switching agents rebinds the current thread and does not keep the previous agent on the project draft', () => {
  const previous = {
    sessionId: 'oc-1',
    agentId: 'opencode',
    workspacePath: '/ws',
    title: 'hi',
    updatedAt: '2026-09-19T00:00:00Z',
    status: 'idle',
    unread: false,
    items: [{ itemId: 'u', kind: 'userMessage', status: 'completed', text: 'hi' }],
    config: { agentId: 'opencode', modelId: 'opencode/mimo-v2.5-free' },
  };
  const next = {
    ...previous,
    sessionId: 'grok-9',
    agentId: 'grok',
    config: { agentId: 'grok', modelId: 'grok-4.6' },
    configNotice: 'Now using Grok',
  };
  const state = rekeyThreadState({
    threads: [previous],
    drafts: {
      'project:w': { text: '', images: [], refs: [], config: { agentId: 'opencode', modelId: 'opencode/mimo-v2.5-free' } },
      'thread:oc-1': { text: 'follow up', images: [], refs: [], config: { agentId: 'opencode' } },
    },
    threadMeta: { 'oc-1': { title: 'hi', agentId: 'opencode' } },
    selectedWorkspaceId: 'w',
    selectedSessionId: 'oc-1',
  }, 'oc-1', next);
  assert.equal(state.selectedSessionId, 'grok-9');
  assert.equal(state.threads[0].agentId, 'grok');
  assert.equal(state.threads[0].items[0].text, 'hi');
  assert.equal(state.drafts['project:w'].config.agentId, 'grok');
  assert.equal(state.drafts['project:w'].config.modelId, undefined);
  assert.equal(state.drafts['thread:grok-9'].text, 'follow up');
  assert.equal(state.drafts['thread:oc-1'], undefined);
  assert.equal(state.threadMeta['grok-9'].agentId, 'grok');
  assert.equal(projectDraftForAgent({}, 'w', 'muse')['project:w'].config.agentId, undefined);
});

test('prompt history normalizes older saves and keeps the last 50 per workspace', () => {
  assert.deepEqual(normalizeMemory(undefined).promptHistory, {});
  let history = {};
  for (let n = 0; n < 55; n++) history = rememberPrompt(history, 'one', `prompt ${n}`);
  assert.equal(history.one.length, 50);
  assert.equal(history.one[0], 'prompt 5');
  assert.equal(rememberPrompt(history, 'one', '  prompt 54  '), history);
  assert.equal(rememberPrompt(history, 'one', '  '), history);
  history = rememberPrompt(history, 'two', 'separate prompt');
  assert.deepEqual(history.two, ['separate prompt']);
  const loaded = normalizeMemory({ promptHistory: { one: history.one, two: [null, 1, '', 'kept'], bad: 'no' } });
  assert.deepEqual(loaded.promptHistory.two, ['kept']);
  assert.deepEqual(loaded.promptHistory.bad, []);
});

test('settings navigation survives memory persistence and invalid or older saves fall back to Models', async () => {
  let saved;
  const memory = new SessionMemoryPersistence({ get: async () => saved, set: async (_key, value) => { saved = value; }, save: async () => {} });
  assert.equal((await memory.load()).settingsTab, 'Models');
  await memory.save(normalizeMemory({ settingsTab: 'About' }));
  assert.equal((await memory.load()).settingsTab, 'About');
  assert.equal(normalizeMemory({ settingsTab: 'Missing' }).settingsTab, 'Models');
  assert.equal(normalizeMemory({ settingsTab: null }).settingsTab, 'Models');
});

test('dock width normalizes saved values and stays in bounds on screen', () => {
  // Saved fallback: missing, non-finite, and odd-typed values get the default.
  assert.equal(normalizeDockWidth(undefined), 360);
  assert.equal(normalizeDockWidth(NaN), 360);
  assert.equal(normalizeDockWidth('wide'), 360);
  assert.equal(normalizeDockWidth('412'), 412, 'a numeric string normalizes');
  assert.equal(normalizeDockWidth(80), 300, 'saved clamp floor');
  assert.equal(normalizeDockWidth(5000), 1600, 'saved clamp ceiling');
  // The 1440px reference window: 60% = 864, room check = 1440-264-336 = 840.
  assert.deepEqual(dockWidthBounds(1440, sidebarWidthFor(1440, false)), { min: 300, max: 840 });
  // A collapsed sidebar frees exactly the columns it surrendered.
  assert.deepEqual(dockWidthBounds(1440, sidebarWidthFor(1440, true)), { min: 300, max: 864 });
  // The max never drops below the min, even on an absurdly small window.
  assert.deepEqual(dockWidthBounds(400, 240), { min: 300, max: 300 });
  // Resize targets clamp to the live bounds, not the stored preference.
  assert.equal(clampDockWidth(360, 1440, 264), 360);
  assert.equal(clampDockWidth(1200, 1440, 264), 840);
  assert.equal(clampDockWidth(360 + 96, 1440, 264), 456);
  // Window shrinking does not clamp the saved preference itself.
  assert.equal(normalizeDockWidth(840), 840);
});

test('a dragged sidebar width is clamped to the window and frees or takes dock room', () => {
  assert.equal(normalizeSidebarWidth(undefined), null, 'older saves keep the default');
  assert.equal(normalizeSidebarWidth('300'), null);
  assert.equal(normalizeSidebarWidth(40), 220);
  assert.equal(normalizeSidebarWidth(9000), 480);
  // Without a saved width the stylesheet's two defaults stand.
  assert.equal(sidebarWidthFor(1440, false), 264);
  assert.equal(sidebarWidthFor(1100, false, null), 240);
  assert.equal(sidebarWidthFor(1440, false, 320), 320);
  assert.equal(sidebarWidthFor(1440, true, 320), 8, 'collapsed ignores the saved width');
  // A narrow window caps the sidebar at 40% without rewriting the preference.
  assert.deepEqual(sidebarWidthBounds(800), { min: 220, max: 320 });
  assert.equal(sidebarWidthFor(800, false, 480), 320);
  assert.deepEqual(sidebarWidthBounds(400), { min: 220, max: 220 });
  assert.deepEqual(dockWidthBounds(1440, sidebarWidthFor(1440, false, 400)), { min: 300, max: 704 });
});

test('session memory round-trips the dock width', async () => {
  let saved;
  const memory = new SessionMemoryPersistence({ get: async () => saved, set: async (_key, value) => { saved = value; }, save: async () => {} });
  assert.equal((await memory.load()).dockWidth, 360, 'older saves get the default');
  await memory.save(normalizeMemory({ dockWidth: 520 }));
  assert.equal((await memory.load()).dockWidth, 520);
  await memory.save({ ...saved, dockWidth: 40 });
  assert.equal((await memory.load()).dockWidth, 300, 'a hand-edited save is clamped, not trusted');
});

test('quoted diff paths parse to the real filename for tab identity', () => {
  const { files } = parseUnifiedDiff(`diff --git "a/docs/caf\\303\\251.md" "b/docs/caf\\303\\251.md"
new file mode 100644
--- /dev/null
+++ "b/docs/caf\\303\\251.md"
@@ -0,0 +1,1 @@
+hi
diff --git "a/weird\\tname.txt" "b/weird\\tname.txt"
new file mode 100644
--- /dev/null
+++ "b/weird\\tname.txt"
@@ -0,0 +1,1 @@
+x
diff --git a/plain space/file.txt b/plain space/file.txt
new file mode 100644
--- /dev/null
+++ b/plain space/file.txt
@@ -0,0 +1,1 @@
+y
`);
  assert.deepEqual(files.map((file) => file.path), ['docs/café.md', 'weird\tname.txt', 'plain space/file.txt']);
  // Raw header lines are preserved byte-for-byte for copy/export/discard.
  assert.equal(files[0].header[0], 'diff --git "a/docs/caf\\303\\251.md" "b/docs/caf\\303\\251.md"');
  assert.equal(unquoteDiffPath('plain'), 'plain');
  assert.equal(unquoteDiffPath('with\\\\back'), 'with\\back');
});

test('hunk headers drive old/new line numbers, meta never numbers', () => {
  const { files } = parseUnifiedDiff(`diff --git a/f.txt b/f.txt
--- a/f.txt
+++ b/f.txt
@@ -7,2 +10,3 @@ title
 ctx
-gone
+here
+more
\\ No newline at end of file
@@ -20 +24,2 @@
-a
+b
@@ -40,0 +50,1 @@
+fresh
`);
  const [first, second, third] = files[0].lines.filter((line) => line.type === 'hunk');
  assert.equal(first.text, '@@ -7,2 +10,3 @@ title');
  const rows = files[0].lines;
  // ctx counts on both sides; del on old only; add on new only.
  assert.deepEqual({ old: rows[1].oldLine, now: rows[1].newLine }, { old: 7, now: 10 });
  assert.deepEqual({ old: rows[2].oldLine, now: rows[2].newLine }, { old: 8, now: undefined });
  assert.deepEqual({ old: rows[3].oldLine, now: rows[3].newLine }, { old: undefined, now: 11 });
  assert.deepEqual({ old: rows[4].oldLine, now: rows[4].newLine }, { old: undefined, now: 12 });
  // The no-newline marker is a meta row with no numbers.
  assert.equal(rows[5].type, 'meta');
  assert.equal(rows[5].oldLine, undefined);
  // The second hunk resets numbering from its own header.
  assert.equal(rows[7].type, 'del');
  assert.equal(rows[7].oldLine, 20);
  assert.equal(rows[8].newLine, 24);
  assert.equal(rows[10].newLine, 50);
  assert.ok(!rows.some((line) => line.type === 'ctx' && line.text === ' '),
    'no invented blank context line appears');
});

test('new and deleted file hunk headers with zero counts parse cleanly', () => {
  const { files } = parseUnifiedDiff(`diff --git a/n.txt b/n.txt
new file mode 100644
--- /dev/null
+++ b/n.txt
@@ -0,0 +1,2 @@
+one
+two
diff --git a/g.txt b/g.txt
deleted file mode 100644
--- a/g.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`);
  assert.equal(files[0].path, 'n.txt');
  assert.equal(files[0].lines[1].newLine, 1);
  assert.equal(files[0].lines[2].newLine, 2);
  // Deletion identities resolve from the --- a/ side.
  assert.equal(files[1].path, 'g.txt');
  assert.equal(files[1].lines[1].oldLine, 1);
  // Rename-only blocks name themselves via `rename to`.
  const renamed = parseUnifiedDiff(`diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
`);
  assert.equal(renamed.files[0].path, 'new.txt');
});

test('each FileDiff patch is the verbatim raw text for copy/export', () => {
  const diff = `diff --git a/a.txt b/a.txt
index 111..222 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
\\ No newline at end of file
`;
  const { files } = parseUnifiedDiff(diff);
  assert.equal(files[0].patch, diff);
});

test('wordChanges marks only the changed token', () => {
  const { before, after } = wordChanges('const v = 1;', 'const v = 2;');
  assert.deepEqual(before, [{ start: 10, end: 11 }]);
  assert.deepEqual(after, [{ start: 10, end: 11 }]);
  assert.deepEqual(wordChanges('same line', 'same line'), { before: [], after: [] });
  // Whitespace and punctuation tokenize distinctly from words.
  const mixed = wordChanges('hello world', 'hello\tworld');
  assert.ok(mixed.before.length && mixed.after.length);
  // Huge inputs fall back to prefix/suffix bounds without quadratic work.
  const long = 'x'.repeat(5000);
  const capped = wordChanges(long, `y${long}`);
  assert.deepEqual(capped.before, []);
  assert.deepEqual(capped.after, [{ start: 0, end: 1 }]);
});

test('splitDiffLines pairs del/add runs and pads the shorter side', () => {
  const lines = [
    { type: 'hunk', text: '@@ -1,3 +1,2 @@' },
    { type: 'del', text: '-alpha', oldLine: 1 },
    { type: 'del', text: '-beta', oldLine: 2 },
    { type: 'add', text: '+gamma', newLine: 1 },
    { type: 'ctx', text: ' tail', oldLine: 3, newLine: 2 },
  ];
  const rows = splitDiffLines(lines);
  assert.equal(rows[0].meta.text, '@@ -1,3 +1,2 @@');
  // First del pairs with the add; the extra del gets an empty right cell.
  assert.equal(rows[1].left.text, '-alpha');
  assert.equal(rows[1].right.text, '+gamma');
  assert.equal(rows[2].left.text, '-beta');
  assert.equal(rows[2].right, undefined);
  // Context spans both sides; input order/text is untouched.
  assert.equal(rows[3].left.text, ' tail');
  assert.equal(rows[3].right.text, ' tail');
  assert.deepEqual(lines.map((line) => line.type), ['hunk', 'del', 'del', 'add', 'ctx']);
});

test('ambiguous and malformed diff paths resolve gracefully', () => {
  // A directory literally named `dir b/` must not confuse the b/ separator.
  const { files } = parseUnifiedDiff(`diff --git a/dir b/name.txt b/dir b/name.txt
new file mode 100644
--- /dev/null
+++ b/dir b/name.txt
@@ -0,0 +1 @@
+hi
`);
  assert.equal(files[0].path, 'dir b/name.txt');
  // A name containing the ` b/` (or `+ b/`) separator itself resolves via +++.
  const odd = parseUnifiedDiff(`diff --git a/x + b/tail.txt b/x + b/tail.txt
new file mode 100644
--- /dev/null
+++ b/x + b/tail.txt
@@ -0,0 +1 @@
+hi
`);
  assert.equal(odd.files[0].path, 'x + b/tail.txt');
  // Malformed escapes survive literally instead of producing NUL bytes.
  assert.equal(unquoteDiffPath('bad\\u12 path'), 'bad\\u12 path');
  assert.equal(unquoteDiffPath('trailing\\'), 'trailing\\');
  assert.equal(unquoteDiffPath('odd\\path'), 'odd\\path');
});

// Review fix: hunk content that looks like a file header stays code — it must
// not be consumed as metadata, lose its line number, or redirect identity.
test('lines inside a hunk are never file headers', async () => {
  const { parseUnifiedDiff, dropHunk } = await bundle('apps/desktop/src/lib/diff.ts', {});
  const diff = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,4 +1,4 @@
 keep
--- b/not-a-file.txt
+++counter;
 tail
`;
  const { files } = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'a.txt', 'in-hunk ---/+++ lines must not redirect identity');
  const del = files[0].lines.find((line) => line.text === '--- b/not-a-file.txt');
  const add = files[0].lines.find((line) => line.text === '+++counter;');
  assert.equal(del.type, 'del');
  assert.equal(del.oldLine, 2);
  assert.equal(add.type, 'add');
  assert.equal(add.newLine, 2);
  const ctx = files[0].lines.filter((line) => line.type === 'ctx');
  assert.deepEqual(ctx.map((line) => line.oldLine), [1, 3]);
  // A stray non-context line inside a hunk is meta and numbers nothing.
  const { files: stray } = parseUnifiedDiff(`diff --git a/a.txt b/a.txt
@@ -1 +1 @@
-old
unexpected text
+new
`);
  const meta = stray[0].lines.find((line) => line.text === 'unexpected text');
  assert.equal(meta.type, 'meta');
  assert.equal(meta.oldLine, undefined);
  assert.equal(stray[0].lines.find((line) => line.text === '+new').newLine, 1);
  // dropHunk uses the same gated identity and still targets the real file.
  const dropped = dropHunk(diff, 'a.txt', 0);
  assert.ok(!dropped.includes('@@'), 'the hunk was removed');
  assert.ok(dropped.includes('+++ b/a.txt'), 'the real header survives');
});

// Review fix: a multi-file diff's patches concatenate back to the input,
// including the boundary newline between files.
test('file patches preserve boundary newlines', async () => {
  const { parseUnifiedDiff } = await bundle('apps/desktop/src/lib/diff.ts', {});
  const diff = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-a
+b
diff --git a/c.txt b/c.txt
--- a/c.txt
+++ b/c.txt
@@ -1 +1 @@
-c
+d
`;
  const { files } = parseUnifiedDiff(diff);
  assert.equal(files.length, 2);
  assert.equal(files[0].patch + files[1].patch, diff);
  // Same result when the input has no final newline.
  const bare = diff.slice(0, -1);
  const again = parseUnifiedDiff(bare);
  assert.equal(again.files[0].patch + again.files[1].patch, bare);
  // Blank separator lines before the next `diff --git` belong to the
  // previous file's slice — one, two and three LFs all round-trip.
  const fileB = `diff --git a/c.txt b/c.txt
--- a/c.txt
+++ b/c.txt
@@ -1 +1 @@
-c
+d
`;
  const fileA = diff.slice(0, diff.indexOf('diff --git a/c.txt'));
  for (const extras of ['', '\n', '\n\n']) {
    const separated = fileA + extras + fileB;
    const { files: joined } = parseUnifiedDiff(separated);
    assert.equal(joined.map((f) => f.patch).join(''), separated, `separator ${JSON.stringify(extras)}`);
    const noTail = separated.slice(0, -1);
    const { files: joinedBare } = parseUnifiedDiff(noTail);
    assert.equal(joinedBare.map((f) => f.patch).join(''), noTail);
  }
  // A header-only (empty) first file also keeps its exact slice.
  const headerOnly = `diff --git a/empty.txt b/empty.txt
new file mode 100644
--- /dev/null
+++ b/empty.txt
` + fileB;
  const { files: ho } = parseUnifiedDiff(headerOnly);
  assert.equal(ho.map((f) => f.patch).join(''), headerOnly);
  // A capped parse keeps the consumed slice as an exact prefix.
  const capped = parseUnifiedDiff(diff, 5);
  assert.ok(capped.truncated);
  assert.ok(diff.startsWith(capped.files[0].patch), 'capped patch is an exact prefix');
  assert.ok(capped.files[0].patch.endsWith('\n'));
  // And an empty diff yields no files at all.
  assert.deepEqual(parseUnifiedDiff(''), { files: [], truncated: false });
});

// Review fix: the oversized fallback must never split a surrogate pair —
// two emoji sharing a high surrogate still mark whole.
test('wordChanges never bisects a surrogate pair', async () => {
  const { wordChanges } = await bundle('apps/desktop/src/lib/diff.ts', {});
  // Over the 4096-char text cap: common prefix, differing emoji.
  const pad = 'a'.repeat(4100);
  const marked = wordChanges(`${pad}\u{1F680}`, `${pad}\u{1F682}`);
  assert.deepEqual(marked.before, [{ start: 4100, end: 4102 }], 'the whole emoji is one marked range');
  assert.equal(`${pad}\u{1F680}`.slice(marked.before[0].start, marked.before[0].end), '\u{1F680}');
  // Over the 256-token cap the same path applies.
  const tokens = 't '.repeat(300);
  const again = wordChanges(`${tokens}\u{1F680}`, `${tokens}\u{1F682}`);
  assert.equal(`${tokens}\u{1F680}`.slice(again.before[0].start, again.before[0].end), '\u{1F680}');
  // Reconstruction is exact.
  const before = `${pad}\u{1F680} tail`;
  const after = `${pad}\u{1F682} tail`;
  const res = wordChanges(before, after);
  assert.equal(before.slice(res.before[0].start, res.before[0].end), '\u{1F680}');
  assert.equal(after.slice(res.after[0].start, res.after[0].end), '\u{1F682}');
});

test('deleting threads names a worktree only when its last thread goes', () => {
  const worktree = (grantId, branch) => ({ grantId, branch, path: `/worktrees/${grantId}`, base: 'main', workspaceId: 'w' });
  const threads = [
    { sessionId: 'a', worktree: worktree('g1', 'muse/one') },
    { sessionId: 'a-fork', worktree: worktree('g1', 'muse/one') },
    { sessionId: 'b', worktree: worktree('g2', 'muse/two') },
    { sessionId: 'local' },
  ];
  assert.equal(worktreeRemovalNote(threads, ['local']), '');
  assert.equal(worktreeRemovalNote(threads, ['a']), '', 'a fork still uses the worktree');
  assert.match(worktreeRemovalNote(threads, ['a', 'a-fork']), /the worktree on branch muse\/one, including any uncommitted changes/);
  assert.match(worktreeRemovalNote(threads, ['a', 'a-fork', 'b', 'local']), /2 worktrees \(muse\/one, muse\/two\)/);
});

test('thread status lists only what the agent reported', () => {
  assert.deepEqual(threadStatusLines({ sessionId: 's1' }, 'Muse'), ['Session: s1', 'Agent: Muse']);
  assert.deepEqual(threadStatusLines({
    sessionId: 's1', config: { modelId: 'muse-spark' }, context: { usedTokens: 50_000, windowTokens: 200_000 }, usage: { totalTokens: 1_200_000, outputTokens: 4000 },
    hostBranch: 'main', worktree: { grantId: 'g', path: '/w', branch: 'muse/one', base: 'main', workspaceId: 'w' },
  }, 'Muse'), ['Session: s1', 'Agent: Muse', 'Model: muse-spark', 'Context: 50K of 200K tokens (25%)', 'Tokens this session: 1.2M (4K output)', 'Worktree: muse/one, started from main']);
  assert.deepEqual(threadStatusLines({
    sessionId: 's1', context: { usedTokens: 100000, windowTokens: 200000, cacheReadTokens: 80000, cacheWriteTokens: 500 },
  }, 'Harness'), ['Session: s1', 'Agent: Harness', 'Context: 100K of 200K tokens (50%)', 'Cache: 80K read, 500 written']);
});

test('palette rows keep section order, lead with recents and hide files until a search', async () => {
  const { paletteRows, rememberCommand } = await bundle('apps/desktop/src/lib/palette.ts');
  const items = [
    { id: 'new', label: 'New thread', section: 'Actions' },
    { id: 'theme', label: 'Use light theme', section: 'Actions', keywords: 'appearance' },
    { id: 't1', label: 'Fix login', section: 'Threads', matched: true },
    { id: 'f1', label: 'Add to thread · a.ts', section: 'Files', matched: true },
    { id: 'settings-Models', label: 'Settings · Models', section: 'Settings' },
  ];
  const shape = (rows) => rows.map((row) => `${row.section}:${row.item.id}`);
  assert.deepEqual(shape(paletteRows(items, '', ['theme', 'gone'])), ['Recent:theme', 'Actions:new', 'Threads:t1', 'Settings:settings-Models']);
  assert.deepEqual(shape(paletteRows(items, 'appearance', ['theme'])), ['Actions:theme', 'Threads:t1', 'Files:f1']);
  assert.deepEqual(shape(paletteRows(items.map((item) => ({ ...item, matched: item.matched == null ? undefined : false })), 'settings models')), ['Settings:settings-Models']);
  assert.deepEqual(rememberCommand(['a', 'b', 'c', 'd', 'e'], 'c'), ['c', 'a', 'b', 'd', 'e']);
  assert.deepEqual(rememberCommand(['a', 'b', 'c', 'd', 'e'], 'f'), ['f', 'a', 'b', 'c', 'd']);
});

test('find in thread matches messages only, in transcript order', async () => {
  const { findMatches } = await bundle('apps/desktop/src/lib/find.ts');
  const step = (id, kind, detail) => ({ id, kind, detail });
  const runs = [
    { id: 'r1', steps: [step('u1', 'user', 'Fix the Login page'), step('t1', 'command', 'grep login src'), step('m1', 'message', 'The login form is fixed.')] },
    { id: 'r2', steps: [step('u2', 'user', 'Thanks'), step('m2', 'message', 'Anything else about LOGIN?')] },
  ];
  assert.deepEqual(findMatches(runs, '  login '), [{ runId: 'r1', itemId: 'u1' }, { runId: 'r1', itemId: 'm1' }, { runId: 'r2', itemId: 'm2' }]);
  assert.deepEqual(findMatches([{ id: 'r1', steps: [step('m1', 'message', 'login once and login twice')] }], 'login'), [{ runId: 'r1', itemId: 'm1' }, { runId: 'r1', itemId: 'm1' }]);
  assert.deepEqual(findMatches(runs, 'grep'), [], 'collapsed tool steps are not searched');
  assert.deepEqual(findMatches(runs, '   '), []);
});

test('the shortcut table has distinct defaults, and rebinding refuses conflicts and reserved chords', async () => {
  const lib = await bundle('apps/desktop/src/lib/shortcuts.ts');
  const defaults = lib.SHORTCUT_IDS.map((id) => lib.REMAPPABLE[id].chord);
  assert.equal(new Set(defaults).size, defaults.length);
  for (const id of lib.SHORTCUT_IDS) assert.equal(lib.bindingProblem(id, lib.REMAPPABLE[id].chord), null, id);
  assert.equal(lib.REMAPPABLE.find.chord, 'mod+KeyF'); assert.equal(lib.REMAPPABLE['search-threads'].chord, 'mod+shift+KeyF');

  const key = (code, mods = {}) => ({ metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, code, ...mods });
  assert.equal(lib.chordOf(key('KeyF')), 'mod+KeyF');
  assert.equal(lib.chordOf(key('BracketRight', { shiftKey: true })), 'mod+shift+BracketRight');
  assert.equal(lib.chordOf(key('KeyA', { metaKey: false, ctrlKey: true, altKey: true })), 'mod+alt+KeyA');
  assert.equal(lib.chordOf(key('KeyF', { metaKey: false })), null, 'no platform modifier, no chord');
  assert.equal(lib.chordOf(key('ShiftLeft', { shiftKey: true })), null, 'a bare modifier is not a chord');
  assert.equal(lib.chordOf({ ...key('KeyE', { metaKey: false, ctrlKey: true, altKey: true }), getModifierState: (name) => name === 'AltGraph' }), null, 'AltGr text entry is left alone');

  assert.equal(lib.actionFor('mod+KeyF'), 'find');
  const overrides = { find: 'mod+KeyU' };
  assert.equal(lib.actionFor('mod+KeyU', overrides), 'find');
  assert.equal(lib.actionFor('mod+KeyF', overrides), undefined, 'the old chord is released');
  assert.match(lib.bindingProblem('find', 'mod+KeyK'), /already used by Command palette/);
  assert.equal(lib.bindingProblem('palette', 'mod+KeyF', overrides), null, 'a released chord can be taken');
  for (const reserved of ['mod+KeyC', 'mod+KeyV', 'mod+KeyQ', 'mod+Digit3', 'mod+KeyY', 'mod+Backspace', 'mod+KeyG', 'mod+Tab']) assert.match(lib.bindingProblem('find', reserved), /reserved/, reserved);
  assert.match(lib.bindingProblem('find', 'shift+KeyF'), /Use ⌘ or Ctrl/);

  assert.equal(lib.chordLabel('mod+shift+KeyF', true), '⌘⇧F'); assert.equal(lib.chordLabel('mod+alt+KeyA', true), '⌘⌥A');
  assert.equal(lib.chordLabel('mod+shift+BracketRight', false), 'Ctrl+Shift+]'); assert.equal(lib.chordLabel('mod+Equal', true), '⌘+');
  assert.equal(lib.chordAccelerator('mod+shift+alt+BracketLeft'), 'CmdOrCtrl+Shift+Alt+['); assert.equal(lib.chordAccelerator('mod+Equal'), 'CmdOrCtrl+=');
  assert.deepEqual(lib.menuAccelerators({ find: 'mod+KeyU', model: 'mod+shift+KeyU' }), { 'find-in-thread': 'CmdOrCtrl+U' }, 'only actions with a menu item reach the menu');
  assert.equal(lib.shortcutForMenu('command-palette'), 'palette'); assert.equal(lib.menuOwned('archive'), false);

  assert.deepEqual(lib.normalizeShortcutOverrides({ find: 'mod+KeyU', palette: 'mod+KeyU', archive: 'mod+KeyC', bogus: 'mod+KeyU', model: 'nonsense', effort: 'mod+shift+KeyE' }), { find: 'mod+KeyU' });
  assert.deepEqual(lib.normalizeShortcutOverrides({ find: 'mod+KeyK', palette: 'mod+KeyF' }), { find: 'mod+KeyK', palette: 'mod+KeyF' }, 'a saved swap survives');
  assert.deepEqual(lib.normalizeShortcutOverrides('x'), {});
});

test('file tree nests folders first and badges follow porcelain status', async () => {
  const { buildFileTree, statusBadge, formatBytes } = await bundle('apps/desktop/src/lib/fileTree.ts');
  const tree = buildFileTree(['README.md', 'src/b.ts', 'src/lib/a.ts', 'src/a.ts', 'docs/x.md']);
  const shape = (nodes) => nodes.map((node) => node.children ? { [node.path]: shape(node.children) } : node.path);
  assert.deepEqual(shape(tree), [{ docs: ['docs/x.md'] }, { src: [{ 'src/lib': ['src/lib/a.ts'] }, 'src/a.ts', 'src/b.ts'] }, 'README.md']);
  assert.deepEqual(['??', ' M', 'M ', 'A ', ' D', 'R '].map(statusBadge), ['U', 'M', 'M', 'A', 'D', 'R']);
  assert.deepEqual([512, 2048, 3 * 1024 * 1024].map(formatBytes), ['512 B', '2 KB', '3 MB']);
});

test('line comments quote their hunk and compose into one ordered prompt', async () => {
  const { commentContext, commentTarget, composeLineComments } = await bundle('apps/desktop/src/lib/lineComments.ts');
  const line = (type, text, oldLine, newLine) => ({ type, text, oldLine, newLine });
  const lines = [line('hunk', '@@ -1,5 +1,5 @@'), line('ctx', ' a', 1, 1), line('ctx', ' b', 2, 2), line('del', '-old', 3), line('add', '+new', undefined, 3), line('ctx', ' c', 4, 4), line('ctx', ' d', 5, 5)];
  assert.deepEqual(commentTarget(lines[3]), { line: 3, removed: true });
  assert.deepEqual(commentTarget(lines[4]), { line: 3, removed: false });
  assert.equal(commentTarget(lines[0]), null);
  assert.equal(commentContext('@@ -1,5 +1,5 @@', lines, lines[4]), '@@ -1,5 +1,5 @@\n b\n-old\n+new\n c\n d');
  const prompt = composeLineComments([
    { id: '2', path: 'src/b.ts', line: 9, removed: false, context: '@@ x @@\n+const s = `a ``` b`;', text: ' rename this ' },
    { id: '1', path: 'src/a.ts', line: 3, removed: true, context: '@@ y @@\n-old', text: 'why removed?' },
  ]);
  assert.match(prompt, /^Please address these review comments/);
  assert.ok(prompt.indexOf('1. src/a.ts:3 (removed line) — why removed?') < prompt.indexOf('2. src/b.ts:9 — rename this'));
  assert.ok(prompt.includes('````diff\n@@ x @@\n+const s = `a ``` b`;\n````'), 'a longer fence keeps quoted backticks from closing the block');
});

test('thread change counts sum only the uncommitted files that thread edited', async () => {
  const { threadChangeCounts } = await bundle('apps/desktop/src/lib/agent.ts');
  const edit = (itemId, path) => ({ itemId, kind: 'toolCall', status: 'completed', tool: 'write_file', args: JSON.stringify({ path }) });
  const items = [edit('1', '/repo/src/a.ts'), edit('2', 'src/b.ts'), { itemId: '3', kind: 'toolCall', status: 'completed', tool: 'read_file', args: JSON.stringify({ path: 'src/c.ts' }) }];
  const files = [{ path: 'src/a.ts', added: 4, removed: 1 }, { path: 'src/b.ts', added: 2, removed: 0 }, { path: 'src/c.ts', added: 9, removed: 9 }];
  const counts = threadChangeCounts(items, '/repo', files);
  assert.deepEqual([counts.added, counts.removed], [6, 1]);
  assert.equal(threadChangeCounts(items, '/repo', files), counts, 'the same transcript and snapshot reuse the answer');
  assert.deepEqual(threadChangeCounts(items, '/repo', []), { added: 0, removed: 0 });
  assert.deepEqual(threadChangeCounts([], '/repo', files), { added: 0, removed: 0 });
});

test('zoom steps through fixed levels and saved values are bounded', async () => {
  const { stepZoom, normalizeZoom } = await bundle('apps/desktop/src/lib/zoom.ts');
  assert.equal(stepZoom(1, 1), 1.1); assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(2, 1), 2); assert.equal(stepZoom(0.5, -1), 0.5);
  assert.equal(stepZoom(1.2, 1), 1.25, 'an off-grid value moves to the next level');
  assert.deepEqual([undefined, 'big', NaN, 9, 0.1, 1.5].map(normalizeZoom), [1, 1, 1, 1, 1, 1.5]);
});

test('inline code links only to indexed files, and saved comments are sanitized', async () => {
  const { indexedPath } = await bundle('apps/desktop/src/lib/fileTree.ts');
  const paths = ['src/app.ts', 'README.md'];
  const rel = (raw) => raw.startsWith('/repo/') ? raw.slice(6) : raw.startsWith('/') ? null : raw.replace(/^\.\//, '');
  assert.equal(indexedPath('src/app.ts', paths, rel), 'src/app.ts');
  assert.equal(indexedPath(' ./src/app.ts:12:3 ', paths, rel), 'src/app.ts');
  assert.equal(indexedPath('/repo/README.md', paths, rel), 'README.md');
  for (const text of ['a/b', 'user.name', '/etc/passwd', 'src/app.ts and more', '', 'x'.repeat(400)]) assert.equal(indexedPath(text, paths, rel), null, text);
  assert.equal(indexedPath('src/app.ts', undefined, rel), null);
  const { normalizeLineComments } = await bundle('apps/desktop/src/lib/lineComments.ts');
  const good = { id: '1', path: 'a.ts', line: 3, removed: false, context: '@@', text: 'Fix' };
  assert.deepEqual(normalizeLineComments({ 'thread:s': [good, { id: 2 }, null, { ...good, line: 'x' }], junk: 'no', empty: [] }), { 'thread:s': [good] });
  assert.deepEqual(normalizeLineComments([good]), {});
});

test('MCP arguments honour quotes and an unfinished quote is refused', () => {
  assert.deepEqual(parseMcpArguments(''), []);
  assert.deepEqual(parseMcpArguments('   '), []);
  assert.deepEqual(parseMcpArguments('-y @scope/server .'), ['-y', '@scope/server', '.']);
  assert.deepEqual(parseMcpArguments('-y "a folder/server" \'second value\''), ['-y', 'a folder/server', 'second value']);
  assert.deepEqual(parseMcpArguments('""'), ['']);
  assert.deepEqual(parseMcpArguments('C:\\\\Program\\\\x "C:\\\\Program Files"'), ['C:\\Program\\x', 'C:\\Program Files']);
  assert.throws(() => parseMcpArguments('"unfinished'), /inside a double quote/);
  assert.throws(() => parseMcpArguments("'unfinished"), /inside a single quote/);
});

test('MCP env and header lines keep names and refuse malformed or repeated keys', () => {
  assert.deepEqual(parseMcpKeyValues('', 'env'), {});
  assert.deepEqual(parseMcpKeyValues('# comment\n\n GITHUB_TOKEN = token-one \nLOG_LEVEL=debug', 'env'), { GITHUB_TOKEN: 'token-one', LOG_LEVEL: 'debug' });
  assert.deepEqual(parseMcpKeyValues('Authorization: Bearer one\nX-Trace=two:three', 'headers'), { Authorization: 'Bearer one', 'X-Trace': 'two:three' });
  assert.throws(() => parseMcpKeyValues('NO_EQUALS', 'env'), /Line 1: use NAME=value/);
  assert.throws(() => parseMcpKeyValues('9BAD=value', 'env'), /not a valid variable name/);
  assert.throws(() => parseMcpKeyValues('Bad Header: value', 'headers'), /not a valid header name/);
  assert.throws(() => parseMcpKeyValues('TOKEN=', 'env'), /give TOKEN a value/);
  assert.throws(() => parseMcpKeyValues('A=1\nA=2', 'env'), /A is listed twice/);
  assert.throws(() => parseMcpKeyValues('__proto__=1\n__proto__=2', 'env'), /__proto__ is listed twice/);
  const protoParsed = parseMcpKeyValues('__proto__=foo', 'env');
  assert.equal(protoParsed.__proto__, 'foo');
  assert.equal(Object.prototype.hasOwnProperty.call(protoParsed, '__proto__'), true);
  assert.equal(Object.prototype.foo, undefined);
});

test('MCP names and row summaries match what the bridge writes', () => {
  assert.equal(mcpServerNameProblem('docs'), null);
  assert.equal(mcpServerNameProblem('team.docs_2-test'), null);
  assert.match(mcpServerNameProblem(''), /Give the server a name/);
  assert.match(mcpServerNameProblem('two words'), /letters, digits, dots/);
  assert.match(mcpServerNameProblem('-leading'), /letters, digits, dots/);
  assert.match(mcpServerNameProblem('x'.repeat(65)), /at most 64/);
  assert.equal(mcpServerSummary({ name: 'docs', source: 'workspace', transport: 'stdio', command: 'npx', args: 2, envKeys: ['TOKEN'], headerKeys: [] }), 'npx · 2 arguments · 1 env');
  assert.equal(mcpServerSummary({ name: 'docs', source: 'workspace', transport: 'stdio', command: 'node', args: 1, envKeys: [], headerKeys: [] }), 'node · 1 argument');
  assert.equal(mcpServerSummary({ name: 'search', source: 'home', transport: 'http', url: 'https://example.test/mcp', args: 0, envKeys: [], headerKeys: ['Authorization'] }), 'https://example.test/mcp · 1 header');
});

