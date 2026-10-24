import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-regressions-'));
after(() => rm(temporary, { recursive: true, force: true }));
let sequence = 0;
async function bundle(entry, replacements = {}) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
    plugins: [{ name: 'test-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(replacements, path) ? { path, namespace: 'test-boundary' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, ({ path }) => ({ contents: replacements[path] }));
    } }],
  });
  return import(pathToFileURL(outfile).href);
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const { SettingsPersistence } = await bundle('apps/desktop/src/lib/settingsPersistence.ts');
const { DEFAULT_SETTINGS, THINKING_ORBS } = await bundle('apps/desktop/src/lib/types.ts');
function persistenceFixture(saved = {}, secure = null) {
  const state = { saved, secure, writes: [], failKey: false, failSave: false };
  const persistence = new SettingsPersistence({
    get: async () => state.saved,
    set: async (_, value) => { state.buffer = value; },
    save: async () => { if (state.failSave) throw new Error('disk full'); state.saved = state.buffer; state.writes.push('settings'); },
  }, {
    get: async () => state.secure,
    set: async (value) => { if (state.failKey) throw new Error('locked'); state.secure = value || null; state.writes.push('credential'); },
  });
  return { state, persistence };
}

test('thinking orb choices survive saving and loading, and older or malformed settings use automatic', async () => {
  const { persistence } = persistenceFixture();
  assert.equal((await persistence.load()).thinkingOrb, 'auto');
  for (const thinkingOrb of THINKING_ORBS) {
    await persistence.save({ ...DEFAULT_SETTINGS, thinkingOrb });
    assert.equal((await persistence.load()).thinkingOrb, thinkingOrb);
  }
  for (const thinkingOrb of ['unknown-orb', null, 7, {}]) {
    assert.equal((await persistenceFixture({ thinkingOrb }).persistence.load()).thinkingOrb, 'auto');
  }
});

test('legacy key migrates before JSON is scrubbed, preserving other settings', async () => {
  const { state, persistence } = persistenceFixture({ museApiKey: 'old-test-key', theme: 'light', workspaces: [{ id: 'a', path: '/a' }] });
  const settings = await persistence.load();
  assert.equal(settings.museApiKey, 'old-test-key');
  assert.equal(settings.theme, 'light');
  assert.equal(settings.accentColor, 'ember');
  assert.equal(settings.accentSidebar, false);
  assert.equal(state.secure, 'old-test-key');
  assert.equal('museApiKey' in state.saved, false);
  assert.deepEqual(state.writes, ['credential', 'settings']);
  assert.equal(state.saved.workspaces[0].path, '/a');
});
test('locked credential store preserves legacy key and does not rewrite JSON', async () => {
  const { state, persistence } = persistenceFixture({ museApiKey: 'legacy-test' });
  state.failKey = true;
  await assert.rejects(persistence.load(), /locked/);
  assert.equal(state.saved.museApiKey, 'legacy-test');
  assert.deepEqual(state.writes, []);
  state.failKey = false;
  await persistence.load();
  assert.equal(state.secure, 'legacy-test');
  assert.equal('museApiKey' in state.saved, false);
});
test('existing secure key wins over an obsolete legacy key', async () => {
  const { state, persistence } = persistenceFixture({ museApiKey: 'obsolete-test' }, 'secure-test');
  assert.equal((await persistence.load()).museApiKey, 'secure-test');
  assert.deepEqual(state.writes, ['settings']);
});
test('save excludes credentials and serializes key changes and deletion', async () => {
  const { state, persistence } = persistenceFixture();
  await persistence.load();
  await Promise.all([
    persistence.save({ ...DEFAULT_SETTINGS, museApiKey: 'first-test' }),
    persistence.save({ ...DEFAULT_SETTINGS, museApiKey: 'second-test', theme: 'light' }),
  ]);
  assert.equal(state.secure, 'second-test');
  assert.equal(state.saved.theme, 'light');
  assert.equal(JSON.stringify(state.saved).includes('second-test'), false);
  await persistence.save({ ...DEFAULT_SETTINGS, museApiKey: '' });
  assert.equal(state.secure, null);
  assert.equal('museApiKey' in state.saved, false);
});
test('failed public settings write rolls back a credential change', async () => {
  const { state, persistence } = persistenceFixture({}, 'previous-test');
  await persistence.load(); state.failSave = true;
  await assert.rejects(persistence.save({ ...DEFAULT_SETTINGS, museApiKey: 'next-test' }), /disk full/);
  assert.equal(state.secure, 'previous-test');
});
test('masked credential store never writes the mask over the real key', async () => {
  const MASK = '••••••••';
  const state = { saved: {}, secure: 'previous-test', writes: [], failSave: false };
  const persistence = new SettingsPersistence({
    get: async () => state.saved,
    set: async (_, value) => { state.buffer = value; },
    save: async () => { if (state.failSave) throw new Error('disk full'); state.saved = state.buffer; state.writes.push('settings'); },
  }, {
    // Native `credential_get` returns only the mask when a key exists.
    get: async () => (state.secure ? MASK : null),
    set: async (value) => { state.secure = value || null; state.writes.push('credential'); },
  });
  assert.equal((await persistence.load()).museApiKey, MASK);
  // A failed public write leaves the real credential untouched (no mask rollback).
  state.failSave = true;
  await assert.rejects(persistence.save({ ...DEFAULT_SETTINGS, museApiKey: 'next-test' }), /disk full/);
  assert.equal(state.secure, 'previous-test');
  assert.deepEqual(state.writes, []);
  // Saving the mask itself means "unchanged": no credential write.
  state.failSave = false;
  await persistence.save({ ...DEFAULT_SETTINGS, museApiKey: MASK });
  assert.equal(state.secure, 'previous-test');
  assert.deepEqual(state.writes, ['settings']);
});

const nativeReplacements = {
  '@tauri-apps/api/core': 'export const invoke=(...args)=>globalThis.testInvoke(...args);',
  '@tauri-apps/api/event': 'export const listen=async (_,handler)=>{globalThis.nativeEvent=handler;return ()=>{}};',
};
async function frontendBridge() {
  globalThis.window = { __TAURI_INTERNALS__: {}, setTimeout, clearTimeout };
  return bundle('apps/desktop/src/lib/bridge.ts', nativeReplacements);
}
test('intentional restart retains start request, invalidates old operations, and accepts success', async () => {
  const { bridge } = await frontendBridge();
  const requests = [];
  globalThis.testInvoke = async (_, args) => { requests.push(args); };
  const pendingTurn = bridge('sendTurn').then(() => 'unexpected', error => error.message);
  const restart = bridge('startHost');
  await new Promise(setImmediate);
  globalThis.nativeEvent({ payload: { type: 'event', event: 'hostStopping', payload: {} } });
  const request = requests.find(item => item.method === 'startHost');
  globalThis.nativeEvent({ payload: { id: request.id, ok: true, result: { server: 'replacement' } } });
  assert.match(await pendingTurn, /connection closed/);
  assert.deepEqual(await restart, { server: 'replacement' });
});
test('unexpected host death rejects a pending restart too', async () => {
  const { bridge } = await frontendBridge();
  globalThis.testInvoke = async () => {};
  const result = assert.rejects(bridge('startHost'), /connection closed/);
  await new Promise(setImmediate);
  globalThis.nativeEvent({ payload: { type: 'event', event: 'hostExit', payload: {} } });
  await result;
});

// ENG-QUAL-002: one malformed event or buggy handler must not escape the
// listener and silently desync every handler that follows it.
test('a throwing bridge event handler is logged and cannot poison the stream', async () => {
  const bridgeModule = await frontendBridge();
  globalThis.testInvoke = async () => {};
  const seen = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    bridgeModule.onBridgeEvent(() => { throw new Error('handler bug'); });
    bridgeModule.onBridgeEvent((event) => { seen.push(event); });
    await new Promise(setImmediate);
    globalThis.nativeEvent({ payload: { type: 'event', event: 'sessionStatus', payload: { sessionId: 's', status: 'idle' } } });
    globalThis.nativeEvent({ payload: { type: 'event', event: 'sessionTitle', payload: { sessionId: 's', title: 'x' } } });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(seen, ['sessionStatus', 'sessionTitle'], 'the stream survives and later handlers still run');
  assert.ok(warnings.some((line) => line.includes('bridge.event.handler_failed')), 'the dropped event is diagnosable in the log');
});

const storeReplacements = {
  './bridge': `export const credentialGet=async()=>globalThis.testInvoke ? globalThis.testInvoke('credential_get') : null;
    export const credentialSet=async(value)=>{ if (globalThis.testInvoke) return globalThis.testInvoke('credential_set',{value}); };
    export const acpConsentGet=async()=>globalThis.testInvoke ? globalThis.testInvoke('acp_isolation_consent_get') : false;
    export const acpConsentSet=async(consented)=>{ if (globalThis.testInvoke) return globalThis.testInvoke('acp_isolation_consent_set',{consented}); };
    export const openLogFolder=async()=>globalThis.testInvoke ? globalThis.testInvoke('open_log_folder') : '/preview/logs/app.log';
    export const providerKeysGet=async(ids)=>ids.map((id)=>({id,configured:false,keyHint:null,baseUrl:null}));
    export const persistStoreDocument=async(...args)=>globalThis.persistStoreDocument?.(...args);
    export const repairStoreDocument=async()=>globalThis.storeRepair ?? {status:'ok'};
    export const bridge=(...args)=>globalThis.storeBridge(...args);
    export const gitReview=async(...args)=>globalThis.readReview?.(...args) ?? {files:[],diff:"",truncated:false};
    export const gitSnapshot=(grantId)=>globalThis.readGit(grantId);
    export const verifyGrants=async()=>[];export const removeGrant=async()=>{};
    export const onBridgeEvent=(handler)=>{globalThis.storeEvent=handler;return ()=>{}};
    export const onWindowCloseRequested=()=>()=>{};
    export const pickFolder=async()=>null;export const mockThreads=()=>[];
    export const readDroppedPaths=async()=>globalThis.droppedPaths ?? [];
    export const agentIdentities=async()=>[];export const confirmAgentBin=async()=>{throw new Error('preview')};
    export const gitDiscardFiles=async()=>globalThis.discardedGit;export const gitDiscardAll=async()=>globalThis.discardedGit;
    export const gitDiscardHunk=async(...args)=>{globalThis.hunkCalls.push(args);return globalThis.discardedGit;};
    export const gitStage=async(...args)=>{globalThis.stageCalls.push(args);return globalThis.discardedGit;};
    export const gitCommit=async(...args)=>{globalThis.commitCalls.push(args);return globalThis.discardedGit;};
    export const turnSnapshots=async(...args)=>globalThis.listSnapshots?.(...args) ?? [];
    export const restoreTurnSnapshot=async(...args)=>globalThis.restoreSnapshot?.(...args);
    export const forgetTurnSnapshots=async()=>{};
    export const gitWorktreeCreate=async(...args)=>globalThis.createWorktree?.(...args) ?? {grantId:'wt-grant',path:'/worktrees/a',branch:'muse/a',base:'main'};
    export const gitWorktreeRemove=async(...args)=>globalThis.removeWorktree?.(...args) ?? {branch:null,branchKept:false};
    export const MOCK_FILES=[];export const mockWorkspaceFile=(path)=>({path,content:'demo',size:4,truncated:false});
    export const readWorkspaceFile=async(...args)=>globalThis.readFile(...args);
    export const gitBranches=async(...args)=>globalThis.listBranches?.(...args) ?? [];export const gitSwitch=async(...args)=>globalThis.switchBranch(...args);
    export const gitPush=async(...args)=>globalThis.pushBranch(...args);export const gitPullRequest=async(...args)=>globalThis.readPullRequest(...args);
    export const setInterfaceZoom=async(level)=>{(globalThis.zoomCalls??=[]).push(level);};
    export const setWindowAppearance=async(theme)=>{(globalThis.appearanceCalls??=[]).push(theme);};
    export const gitPull=async(...args)=>globalThis.pullBranch(...args);export const gitWorktreeHandoff=async(...args)=>globalThis.handoffWorktree(...args);
    export const setMenuShortcuts=async(map)=>{(globalThis.menuShortcutCalls??=[]).push(map);};
    export const mockWorktree=(base)=>({grantId:'preview-worktree',path:'/preview/worktree',branch:'muse/preview',base:base||'main'});
    export const gitInit=async(...args)=>{globalThis.initCalls.push(args);return globalThis.discardedGit;};
    export const trustPreview=async()=>globalThis.trustPreviewResult ?? { skills: [], rules: null };
    export const listWorkspaceFiles=async()=>globalThis.fileIndexPaths ?? [];
    export const cliLogout=async()=>{globalThis.cliLoggedOut=true;};
    export const pluginList=async()=>globalThis.pluginEntries ?? [];
    export const skillList=async()=>globalThis.skillEntries ?? [];
    export const catalogList=async()=>({entries:[],skillsRoot:'',error:null});export const catalogInstall=async()=>({installedSkills:[],installedServers:[],skipped:[],errors:[]});export const catalogRemove=async()=>({removed:[],skipped:[],errors:[]});
    export const projectInit=async(...args)=>globalThis.runProjectInit(...args);
    export const enterpriseStatus=async()=>globalThis.enterpriseFixture ?? { generation: null, sources: [] };
    export const pickPluginBundle=async()=>globalThis.pickedBundle ?? null;
    export const pluginInstall=async(path)=>{globalThis.installedBundles.push(path);};
    export const pickSkillSource=async()=>globalThis.pickedSkill ?? null;
    export const skillInstall=async(path)=>{globalThis.installedSkills.push(path);return 'installed';};
    export const skillImport=async(from,dryRun)=>{globalThis.importCalls.push([from,dryRun]);return dryRun?'preview':'done';};
    export const skillUninstall=async(id)=>{globalThis.uninstalledSkills.push(id);return 'removed';};`,
};
async function frontendStore(extra = {}, tauri = false) {
  globalThis.window = { setTimeout, clearTimeout, matchMedia: () => ({ matches: false }), ...(tauri ? { __TAURI_INTERNALS__: {} } : {}) };
  globalThis.document = { documentElement: { dataset: {}, style: { setProperty(name, value) { this[name] = value; } } } };
  globalThis.storeBridge = async () => ({});
  const module = await bundle('apps/desktop/src/lib/store.ts', { ...storeReplacements, ...extra });
  module.bindBridgeEvents();
  return module.useAppStore;
}
const thread = (id, path) => ({ sessionId: id, workspacePath: path, items: [], opened: true, status: 'idle' });
test('removing and re-adding a project does not restore its old sessions', async () => {
  const store = await frontendStore();
  globalThis.storeBridge = async (method) => method === 'listSessions' ? {
    sessions: [
      { sessionId: 'old-1', workspaceRoot: '/repo', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle' },
      { sessionId: 'old-2', workspaceRoot: '/repo', updatedAt: '2026-01-02T00:00:00.000Z', status: 'idle' },
    ],
  } : {};
  store.setState({
    workspaces: [{ id: 'old', path: '/repo', name: 'repo' }, { id: 'keep', path: '/keep', name: 'keep' }],
    selectedWorkspaceId: 'old', preview: false,
    threads: [thread('old-1', '/repo'), thread('old-2', '/repo'), thread('keep-1', '/keep')],
    threadMeta: {},
    agents: [{ id: 'opencode', name: 'OpenCode', protocol: 'acp', found: true, path: '/bin/opencode', version: '1', verified: true, signIn: '', authenticated: true }],
    enabledAgents: { muse: false, opencode: true },
  });

  store.getState().removeWorkspace('old');
  assert.deepEqual(store.getState().threads.map((item) => item.sessionId), ['keep-1']);
  await store.getState().addWorkspace('/repo');

  assert.deepEqual(store.getState().threads.map((item) => item.sessionId), ['keep-1']);
});
test('discarding files applies the fresh snapshot and prunes open diff tabs', async () => {
  const store = await frontendStore();
  globalThis.discardedGit = { branch: 'main', dirty: true, files: [{ path: 'keep.txt', status: 'M', added: 1, removed: 0 }], diff: '', truncated: false };
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false,
    diffTabs: ['drop.txt', 'keep.txt'], diffActive: 'drop.txt',
  });
  await store.getState().discardGitFiles(['drop.txt']);
  const state = store.getState();
  assert.deepEqual(state.git.files.map((file) => file.path), ['keep.txt']);
  assert.deepEqual(state.diffTabs, ['keep.txt']);
  assert.equal(state.diffActive, 'keep.txt');
  await store.getState().discardAllGit();
  assert.deepEqual(store.getState().diffTabs, []);
  assert.equal(store.getState().diffActive, null);
});
test('discarding a hunk forwards path and index and applies the fresh snapshot', async () => {
  const store = await frontendStore();
  globalThis.hunkCalls = [];
  globalThis.discardedGit = { branch: 'main', dirty: true, files: [{ path: 'keep.txt', status: 'M', added: 1, removed: 0 }], diff: '', truncated: false };
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false });
  await store.getState().discardGitHunk('keep.txt', 2);
  assert.deepEqual(globalThis.hunkCalls, [['g1', 'keep.txt', 2]]);
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['keep.txt']);
});
test('staging and committing forward args and apply the fresh snapshot', async () => {
  const store = await frontendStore();
  globalThis.stageCalls = [];
  globalThis.commitCalls = [];
  globalThis.discardedGit = { branch: 'main', dirty: false, files: [], diff: '', truncated: false };
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false });
  await store.getState().stageGitFiles(['a.txt'], true);
  await store.getState().stageGitFiles(['b.txt'], false);
  assert.deepEqual(globalThis.stageCalls, [['g1', ['a.txt'], true], ['g1', ['b.txt'], false]]);
  await store.getState().commitGit('ship it');
  assert.deepEqual(globalThis.commitCalls, [['g1', 'ship it']]);
  assert.equal(store.getState().git.dirty, false);
});
test('sign out removes credentials, closes sessions, and re-detects', async () => {
  const store = await frontendStore();
  globalThis.cliLoggedOut = false;
  const seen = [];
  globalThis.storeBridge = async (method) => { seen.push(method); return method === 'detect' ? { found: true, authenticated: false } : {}; };
  store.setState({
    museApiKey: 'secret-test', hostInfo: { version: 'x' }, hostTrust: true, preview: false,
    threads: [{ ...thread('s1', '/repo'), status: 'running', activeTurnId: 't0' }], selectedSessionId: 's1',
  });
  await store.getState().signOut();
  const state = store.getState();
  assert.equal(globalThis.cliLoggedOut, true);
  assert.equal(state.museApiKey, '');
  assert.equal(state.hostInfo, null);
  assert.equal(state.hostTrust, null);
  assert.equal(state.threads[0].opened, false);
  assert.equal(state.threads[0].status, 'idle');
  assert.deepEqual(state.detection, { found: true, authenticated: false });
  assert.ok(seen.includes('detect'));
});
test('shell escape routes to userShell and clears the composer without a turn', async () => {
  const store = await frontendStore();
  const calls = [];
  globalThis.storeBridge = async (method, params) => { calls.push([method, params]); return { commandId: 'cmd-1', status: 'accepted' }; };
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo') }], hostInfo: { compat: { granted: ['userShell'] } },
    composer: '!git status --short', images: [], contextRefs: [],
  });
  await store.getState().sendPrompt();
  assert.deepEqual(calls, [['userShell', { sessionId: 's1', commandText: 'git status --short' }]]);
  const state = store.getState();
  assert.equal(state.composer, '');
  assert.equal(state.threads[0].status, 'idle');
  assert.deepEqual(state.threads[0].items, []);
});
test('shell escape fails closed on foreign agents and missing grants', async () => {
  const store = await frontendStore();
  globalThis.storeBridge = async () => { throw new Error('must not call'); };
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo'), agentId: 'opencode' }], hostInfo: { compat: { granted: ['userShell'] } },
    composer: '!ls', images: [], contextRefs: [],
  });
  await store.getState().sendPrompt();
  assert.match(store.getState().error, /Muse feature/);
  store.setState({ threads: [{ ...thread('s1', '/repo') }], hostInfo: { compat: { granted: [] } }, error: null });
  await store.getState().sendPrompt();
  assert.match(store.getState().error, /did not grant/);
});
test('plugin inventory refresh stores entries and tracks the available tab', async () => {
  const store = await frontendStore();
  globalThis.pluginEntries = [{ id: 'acme', version: '1.2', description: 'Tools', enabled: true }];
  await store.getState().refreshPlugins();
  const state = store.getState();
  assert.deepEqual(state.pluginEntries, globalThis.pluginEntries);
  assert.equal(state.pluginsAvailableShown, false);
  assert.equal(state.pluginsError, null);
  await store.getState().refreshPlugins(true);
  assert.equal(store.getState().pluginsAvailableShown, true);
});
test('managed skill inventory refresh stores entries and surfaces failures', async () => {
  const store = await frontendStore();
  globalThis.skillEntries = [{ id: 'bundled:git', name: 'git', description: 'Git help', scope: 'bundled', activation: 'on' }];
  await store.getState().refreshManagedSkills();
  assert.deepEqual(store.getState().skillEntries, globalThis.skillEntries);
  assert.equal(store.getState().skillsError, null);
});
test('project setup previews, scaffolds, and surfaces conflicts', async () => {
  const store = await frontendStore();
  globalThis.runProjectInit = async (grantId, museBin, dryRun, force) => {
    assert.equal(grantId, 'g1');
    if (dryRun) return '# Preview AGENTS.md';
    return force ? 'Wrote AGENTS.md' : 'AGENTS.md already exists. Pass --force to replace it, or --dry-run to preview.';
  };
  store.setState({ workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }], preview: false });
  await store.getState().openInitDialog('w');
  assert.equal(store.getState().initDialog.preview, '# Preview AGENTS.md');
  await store.getState().runInit(false);
  assert.equal(store.getState().initDialog.conflict, true);
  assert.equal(store.getState().initDialog.done, false);
  await store.getState().runInit(true);
  assert.equal(store.getState().initDialog.done, true);
  store.getState().closeInitDialog();
  assert.equal(store.getState().initDialog, null);
});
test('startHost forwards posture and restarts on posture drift', async () => {
  const store = await frontendStore();
  const calls = [];
  const defaultPosture = { ephemeralSessions: false, disableWrite: false, disableShell: false, sandboxNetwork: 'proxy-only' };
  globalThis.storeBridge = async (method, params) => {
    calls.push([method, params]);
    if (method === 'status') return { running: true, trustWorkspace: false, posture: defaultPosture };
    if (method === 'startHost') {
      return {
        trustWorkspace: false,
        posture: { ephemeralSessions: params.noSessionLog === true, disableWrite: params.disableWrite === true, disableShell: params.disableShell === true, sandboxNetwork: params.sandboxNetwork },
      };
    }
    if (method === 'listModels') return { models: [] };
    return {};
  };
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false,
    threads: [{ ...thread('s1', '/repo'), status: 'idle' }], selectedSessionId: 's1',
    ephemeralSessions: true, disableWrite: false, disableShell: true, sandboxNetwork: 'restricted',
  });
  await store.getState().startHost();
  const start = calls.find(([method]) => method === 'startHost');
  assert.deepEqual([start[1].noSessionLog, start[1].disableWrite, start[1].disableShell, start[1].sandboxNetwork], [true, false, true, 'restricted']);
  assert.deepEqual(store.getState().hostInfo.posture, { ephemeralSessions: true, disableWrite: false, disableShell: true, sandboxNetwork: 'restricted' });
  assert.match(store.getState().threads[0].notice.message, /posture changed/);
});
test('enterprise refresh stores generation and plane states', async () => {
  const store = await frontendStore();
  globalThis.enterpriseFixture = { generation: 'sha256:abc', sources: [{ plane: 'policy', sourceClass: 'system_file', state: 'active' }] };
  await store.getState().refreshEnterprise();
  assert.deepEqual(store.getState().enterprise, globalThis.enterpriseFixture);
  assert.equal(store.getState().enterpriseError, null);
});
test('plugin install picks a bundle, installs, and shows installed inventory', async () => {
  const store = await frontendStore();
  globalThis.installedBundles = [];
  globalThis.pickedBundle = '/bundles/acme';
  globalThis.pluginEntries = [{ id: 'acme', version: '1.0', description: 'New', enabled: false }];
  store.setState({ pluginsAvailableShown: true });
  await store.getState().installPlugin();
  assert.deepEqual(globalThis.installedBundles, ['/bundles/acme']);
  assert.equal(store.getState().pluginsAvailableShown, false);
  assert.equal(store.getState().pluginEntries[0].id, 'acme');
  globalThis.pickedBundle = null;
  globalThis.installedBundles = [];
  await store.getState().installPlugin();
  assert.deepEqual(globalThis.installedBundles, []);
});
test('skill install picks a folder, installs, and refreshes the inventory', async () => {
  const store = await frontendStore();
  globalThis.installedSkills = [];
  globalThis.pickedSkill = '/skills/acme';
  globalThis.skillEntries = [{ id: 'user:acme', name: 'acme', description: '', scope: 'user', activation: 'on' }];
  await store.getState().installSkill();
  assert.deepEqual(globalThis.installedSkills, ['/skills/acme']);
  assert.equal(store.getState().skillEntries[0].id, 'user:acme');
  globalThis.pickedSkill = null;
  globalThis.installedSkills = [];
  await store.getState().installSkill();
  assert.deepEqual(globalThis.installedSkills, []);
});
test('skill import previews without refreshing and refreshes on import', async () => {
  const store = await frontendStore();
  globalThis.importCalls = [];
  globalThis.skillEntries = [];
  assert.equal(await store.getState().importSkills('codex', true), 'preview');
  assert.deepEqual(globalThis.importCalls, [['codex', true]]);
  assert.equal(await store.getState().importSkills('claude', false), 'done');
  assert.deepEqual(globalThis.importCalls, [['codex', true], ['claude', false]]);
});
test('skill uninstall removes by id and refreshes the inventory', async () => {
  const store = await frontendStore();
  globalThis.uninstalledSkills = [];
  globalThis.skillEntries = [];
  await store.getState().uninstallSkill('user:acme');
  assert.deepEqual(globalThis.uninstalledSkills, ['user:acme']);
  assert.deepEqual(store.getState().skillEntries, []);
});
test('MCP catalog refresh stores servers and surfaces failures', async () => {
  const store = await frontendStore();
  globalThis.storeBridge = async () => ({ servers: [{ name: 'docs', transport: 'streamableHttp', oauth: true }] });
  await store.getState().refreshMcpServers();
  assert.deepEqual(store.getState().mcpServers, [{ name: 'docs', transport: 'streamableHttp', oauth: true }]);
  assert.equal(store.getState().mcpError, null);
  globalThis.storeBridge = async () => { throw new Error('host down'); };
  await store.getState().refreshMcpServers();
  assert.equal(store.getState().mcpError, 'Could not load MCP servers: host down');
  assert.equal(store.getState().mcpLoading, false);
});
test('busy sends queue behind the running turn and promote at launch', async () => {
  const store = await frontendStore();
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo'), status: 'running', activeTurnId: 't0', usage: { outputTokens: 10 } }],
    composer: 'later', images: [], contextRefs: [],
  });
  globalThis.storeBridge = async (method, params) => {
    assert.equal(method, 'sendTurn');
    assert.equal(params.ifBusy, 'queue');
    return { turnId: 't1', disposition: 'queued' };
  };
  await store.getState().sendPrompt({ disposition: 'queue' });
  let current = store.getState().threads[0];
  assert.deepEqual(current.queuedTurns, [{ turnId: 't1', text: 'later' }]);
  assert.equal(current.status, 'running');
  assert.equal(current.activeTurnId, 't0');
  assert.equal(store.getState().composer, '');
  globalThis.storeEvent('turnStarted', { sessionId: 's1', turnId: 't1' });
  current = store.getState().threads[0];
  assert.deepEqual(current.queuedTurns ?? [], []);
  assert.equal(current.activeTurnId, 't1');
  assert.equal(current.status, 'running');
});

test('unqueued completions drop the entry without failing the thread', async () => {
  const store = await frontendStore();
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo'), status: 'running', activeTurnId: 't0', queuedTurns: [{ turnId: 't1', text: 'later' }] }],
  });
  globalThis.storeEvent('turnCompleted', { sessionId: 's1', turnId: 't1', outcome: { kind: 'unqueued' } });
  const current = store.getState().threads[0];
  assert.deepEqual(current.queuedTurns ?? [], []);
  assert.equal(current.status, 'running');
  assert.equal(current.error ?? null, null);
});

test('stale completions settle only their own turn items', async () => {
  const store = await frontendStore();
  store.setState({
    threads: [{ ...thread('s1', '/repo'), status: 'running', activeTurnId: 't-new', items: [
      { itemId: 'old-tool', kind: 'toolCall', status: 'inProgress', turnId: 't-old' },
      { itemId: 'new-tool', kind: 'toolCall', status: 'inProgress', turnId: 't-new' },
    ] }],
  });
  globalThis.storeEvent('turnCompleted', { sessionId: 's1', turnId: 't-old', outcome: { kind: 'completed', params: { terminal: 'cancelled' } } });
  const current = store.getState().threads[0];
  assert.equal(current.status, 'running');
  assert.equal(current.activeTurnId, 't-new');
  assert.deepEqual(current.items.map((item) => item.status), ['cancelled', 'inProgress']);
});

test('forkThread branches, selects the fork, and records provenance', async () => {
  const store = await frontendStore();
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo'), title: 'Source', opened: true, config: { modelId: 'm' } }],
  });
  globalThis.storeBridge = async (method) => {
    if (method === 'forkSession') return { sessionId: 'fork-1', forkedFrom: { sourceSessionId: 's1', cutExplicit: false } };
    if (method === 'resumeSession') return { alreadyOpen: true };
    if (method === 'listModels') return { models: [] };
    return {};
  };
  await store.getState().forkThread('s1');
  const state = store.getState();
  assert.equal(state.selectedSessionId, 'fork-1');
  const fork = state.threads.find((item) => item.sessionId === 'fork-1');
  assert.equal(fork.title, 'Source (fork)');
  assert.deepEqual(fork.forkedFrom, { sessionId: 's1', title: 'Source' });
  assert.equal(fork.opened, true);
});

test('forkThread passes real turn cut points and forks whole for local groupings', async () => {
  const store = await frontendStore();
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo'), title: 'Source', opened: true, config: {} }],
  });
  const forks = [];
  globalThis.storeBridge = async (method, params) => {
    if (method === 'forkSession') { forks.push(params); return { sessionId: `fork-${forks.length}`, forkedFrom: { sourceSessionId: 's1' } }; }
    if (method === 'resumeSession') return { alreadyOpen: true };
    if (method === 'listModels') return { models: [] };
    return {};
  };
  await store.getState().forkThread('s1', 'turn-9');
  await store.getState().forkThread('s1', 'local:abc');
  assert.deepEqual(forks, [{ sessionId: 's1', lastTurnId: 'turn-9' }, { sessionId: 's1' }]);
});
test('compactThread reports noop reasons and clears its notice at terminal', async () => {
  const store = await frontendStore();
  store.setState({
    selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo'), status: 'idle' }],
  });
  globalThis.storeBridge = async () => ({ status: 'noop', reason: 'no_compactable_history' });
  await store.getState().compactThread();
  assert.match(store.getState().threads[0].notice.message, /no compactable history yet/);
  globalThis.storeBridge = async () => ({ status: 'admitted' });
  await store.getState().compactThread();
  assert.equal(store.getState().threads[0].notice.key, 'compacting');
  globalThis.storeEvent('item', { sessionId: 's1', item: { itemId: 'c1', kind: 'compaction', status: 'completed' } });
  assert.equal(store.getState().threads[0].notice, null);
});

test('openPreview reads without attaching and closePreview clears', async () => {
  const store = await frontendStore();
  store.setState({
    selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo'), title: 'Source', opened: false }, { ...thread('s2', '/repo'), title: 'Other', opened: false }],
  });
  globalThis.storeBridge = async (method, params) => {
    assert.equal(method, 'readSession');
    assert.equal(params.excludeItems, false);
    return { session: { sessionId: 's2', status: 'idle' }, history: { items: [] }, pendingRequests: [], viewCursor: 'v' };
  };
  await store.getState().openPreview('s2');
  const preview = store.getState().previewSession;
  assert.equal(preview.title, 'Other');
  assert.equal(preview.loading, false);
  assert.equal(preview.snapshot.session.status, 'idle');
  assert.equal(store.getState().threads.find((item) => item.sessionId === 's2').opened, false);
  store.getState().closePreview();
  assert.equal(store.getState().previewSession, null);
});

test('preview discard filters demo rows locally without a backend', async () => {
  const store = await frontendStore();
  store.setState({
    preview: true,
    git: { branch: 'main', dirty: true, files: [{ path: 'a.txt', status: 'M', added: 1, removed: 0 }, { path: 'b.txt', status: '??', added: 0, removed: 0 }], diff: 'd', truncated: false },
    diffTabs: ['a.txt', 'b.txt'], diffActive: 'a.txt',
  });
  await store.getState().discardGitFiles(['a.txt']);
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['b.txt']);
  assert.equal(store.getState().git.dirty, true);
  assert.deepEqual(store.getState().diffTabs, ['b.txt']);
  await store.getState().discardAllGit();
  assert.deepEqual(store.getState().git.files, []);
  assert.equal(store.getState().git.dirty, false);
});
test('cross-project thread selection clears stale Git immediately and ignores a late response', async () => {
  const store = await frontendStore();
  const reads = { ga: deferred(), gb: deferred() };
  globalThis.readGit = grantId => reads[grantId].promise;
  store.setState({ workspaces: [{ id: 'a', path: '/a', grantId: 'ga' }, { id: 'b', path: '/b', grantId: 'gb' }], selectedWorkspaceId: 'a',
    git: { diff: 'old A' }, threads: [thread('a-thread', '/a'), thread('b-thread', '/b')] });
  await store.getState().selectThread('b-thread');
  assert.equal(store.getState().git, null);
  await store.getState().selectThread('a-thread');
  reads.gb.resolve({ diff: 'B' }); await new Promise(setImmediate);
  assert.equal(store.getState().git, null);
  reads.ga.resolve({ diff: 'new A' }); await new Promise(setImmediate);
  assert.equal(store.getState().git.diff, 'new A');
});
test('ungranted workspaces fail closed before any session call', async () => {
  const store = await frontendStore();
  globalThis.window.__TAURI_INTERNALS__ = {};
  try {
    const calls = [];
    globalThis.storeBridge = async (method, params) => { calls.push([method, params]); return {}; };
    store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: null }], error: null });
    await store.getState().selectWorkspace('w');
    assert.match(store.getState().error ?? '', /not granted/);
    assert.deepEqual(calls, []);
  } finally { delete globalThis.window.__TAURI_INTERNALS__; }
});

test('re-opening a folder re-attaches its native grant in place', async () => {
  const store = await frontendStore();
  globalThis.window.__TAURI_INTERNALS__ = {};
  try {
    globalThis.storeBridge = async () => ({});
    store.setState({ workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: null }] });
    await store.getState().addWorkspace('/repo', 'wg-reattached');
    const workspace = store.getState().workspaces.find((item) => item.id === 'w');
    assert.equal(workspace.grantId, 'wg-reattached');
    assert.equal(store.getState().workspaces.length, 1);
    assert.equal(store.getState().selectedWorkspaceId, 'w');
  } finally { delete globalThis.window.__TAURI_INTERNALS__; }
});

test('opening a thread in an ungranted workspace fails closed', async () => {
  const store = await frontendStore();
  globalThis.window.__TAURI_INTERNALS__ = {};
  try {
    const calls = [];
    globalThis.storeBridge = async (method, params) => { calls.push([method, params]); return {}; };
    store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: null }], threads: [{ ...thread('s', '/repo'), opened: false }] });
    await store.getState().selectThread('s');
    assert.match(store.getState().threads[0].error ?? '', /not granted/);
    assert.equal(store.getState().threads[0].opened, false);
    assert.deepEqual(calls, []);
  } finally { delete globalThis.window.__TAURI_INTERNALS__; }
});

test('quiet-turn reconcile skips ungranted workspaces', async () => {
  const module = await bundle('apps/desktop/src/lib/store.ts', storeReplacements);
  const store = module.useAppStore;
  globalThis.window.__TAURI_INTERNALS__ = {};
  try {
    const calls = [];
    globalThis.storeBridge = async (method, params) => { calls.push([method, params]); return { sessions: [] }; };
    store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: null }],
      threads: [{ ...thread('s', '/repo'), status: 'running', updatedAt: new Date(Date.now() - 60000).toISOString() }] });
    await module.reconcileRunningThreads();
    assert.deepEqual(calls, []);
  } finally { delete globalThis.window.__TAURI_INTERNALS__; }
});

test('host retirement invalidates opened sessions without a spurious connection error', async () => {
  const store = await frontendStore();
  store.setState({ threads: [{ ...thread('s', '/a'), status: 'running', activeTurnId: 'turn', plan: [{ id: 'p', text: 'Work', status: 'inProgress' }], items: [{ itemId: 'tool', kind: 'toolCall', status: 'inProgress', turnId: 'turn' }], userInputs: [{ userInputId: 'q' }] }] });
  globalThis.storeEvent('hostStopping', {});
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().threads[0].opened, false);
  assert.equal(store.getState().threads[0].activeTurnId, null);
  assert.equal(store.getState().threads[0].lastTurnId, 'turn');
  assert.equal(store.getState().threads[0].lastOutcome, 'interrupted');
  assert.equal(store.getState().threads[0].plan[0].status, 'cancelled');
  assert.equal(store.getState().threads[0].items[0].status, 'cancelled');
  assert.deepEqual(store.getState().threads[0].userInputs, []);
});

test('preview cancellation settles the turn, plan, and running agents together', async () => {
  const store = await frontendStore();
  store.setState({ preview: true, selectedSessionId: 's', threads: [{ ...thread('s', '/a'), status: 'running', activeTurnId: 'turn', turnStartedAt: Date.now() - 1000,
    plan: [{ id: 'p', text: 'Work', status: 'inProgress' }],
    items: [
      { itemId: 'u', kind: 'userMessage', status: 'completed', turnId: 'turn', text: 'Go' },
      { itemId: 'w', kind: 'workflow', status: 'inProgress', turnId: 'turn', children: [{ childId: 'a', attempt: 1, status: 'started' }] },
      { itemId: 't', kind: 'toolCall', status: 'inProgress', turnId: 'turn' },
    ], pendingApproval: { approvalId: 'a' } }] });
  await store.getState().stopTurn();
  const settled = store.getState().threads[0];
  assert.equal(settled.status, 'idle');
  assert.equal(settled.activeTurnId, null);
  assert.equal(settled.lastTurnId, 'turn');
  assert.equal(settled.lastOutcome, 'cancelled');
  assert.equal(settled.pendingApproval, null);
  assert.equal(settled.plan[0].status, 'cancelled');
  assert.deepEqual(settled.items.map(item => item.status), ['completed', 'cancelled', 'cancelled']);
});
const question = (id = 'q', sessionId = 's') => ({ sessionId, userInputId: id, turnId: 't', viewCursor: 'opaque', questions: [{ id: 'choice', header: 'Choose', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], selection: { mode: 'single' } }] });
test('failed question response preserves pending questions; success removes only its own question', async () => {
  const store = await frontendStore();
  store.setState({ threads: [thread('s', '/a')] });
  globalThis.storeEvent('userInputs', { sessionId: 's', requests: [question(), question('q2')] });
  globalThis.storeBridge = async () => { throw new Error('offline'); };
  await store.getState().respondUserInput('s', 'q', { action: 'cancel' });
  assert.equal(store.getState().threads[0].userInputs.length, 2);
  assert.match(store.getState().threads[0].error, /offline/);
  globalThis.storeBridge = async () => ({ status: 'accepted' });
  await store.getState().respondUserInput('s', 'q', { action: 'cancel' });
  assert.deepEqual(store.getState().threads[0].userInputs.map(x => x.userInputId), ['q2']);
});

test('a question that ended the turn leaves the thread idle, and the answer turn shows it running', async () => {
  const store = await frontendStore();
  store.setState({ threads: [{ ...thread('s', '/a'), agentId: 'harness', lastTurnId: 't' }] });
  globalThis.storeEvent('userInputs', { sessionId: 's', requests: [question()], turnEnded: true });
  let current = store.getState().threads[0];
  assert.equal(current.userInputs.length, 1);
  assert.equal(current.status, 'idle', 'nothing is running while the question waits');
  assert.equal(current.activeTurnId, undefined);
  globalThis.storeEvent('turnStarted', { sessionId: 's', turnId: 't2' });
  assert.equal(store.getState().threads[0].status, 'idle', 'an unknown turn that is not an answer is ignored, as before');
  globalThis.storeEvent('turnStarted', { sessionId: 's', turnId: 't2', cause: 'userInput' });
  current = store.getState().threads[0];
  assert.equal(current.status, 'running');
  assert.equal(current.activeTurnId, 't2');
  // A Muse question arrives mid-turn and keeps marking the thread running.
  store.setState({ threads: [thread('m', '/a')] });
  globalThis.storeEvent('userInputs', { sessionId: 'm', requests: [question('q', 'm')] });
  assert.equal(store.getState().threads[0].status, 'running');
});

const { UserInputRelay, observeNotifications } = await bundle('packages/glitter-bridge/src/user-input.ts');
const notification = (method, params) => ({ jsonrpc: '2.0', method, params });
test('question relay preserves simultaneous sessions and does not revive settled requests', () => {
  const relay = new UserInputRelay(() => {});
  relay.notify(notification('userInput/requested', question()));
  relay.notify(notification('userInput/requested', question('q', 'other')));
  relay.notify(notification('userInput/settled', { sessionId: 's', userInputId: 'q' }));
  relay.notify(notification('userInput/requested', question()));
  assert.equal(relay.requests('s').length, 0);
  assert.equal(relay.requests('other').length, 1);
});
test('resume reads do not erase newer questions or resurrect questions settled in flight', () => {
  const relay = new UserInputRelay(() => {});
  const version = relay.version('s');
  relay.notify(notification('userInput/requested', question('new')));
  relay.notify(notification('userInput/settled', { sessionId: 's', userInputId: 'old' }));
  relay.restore('s', [question('old')], version);
  assert.deepEqual(relay.requests('s').map(x => x.userInputId), ['new']);
  relay.restore('s', [], relay.version('s'));
  assert.deepEqual(relay.requests('s'), []);
});
test('terminal turns clear their questions while preserving other turns', () => {
  const relay = new UserInputRelay(() => {});
  relay.notify(notification('userInput/requested', question()));
  relay.notify(notification('userInput/requested', { ...question('q2'), turnId: 't2' }));
  relay.notify(notification('turn/completed', { sessionId: 's', turnId: 't' }));
  assert.deepEqual(relay.requests('s').map(x => x.userInputId), ['q2']);
});
test('notification adapter preserves SDK routing and private receiver bindings', () => {
  class Connection {
    #value = 7;
    get value() { return this.#value; }
    request() { return this.#value; }
    onNotification(callback) { this.handler = callback; }
  }
  const connection = new Connection(); const observed = [];
  const adapter = observeNotifications(connection, event => observed.push(['observer', event.method]));
  adapter.onNotification(event => observed.push(['sdk', event.method]));
  connection.handler(notification('userInput/requested', question()));
  assert.deepEqual(observed, [['sdk', 'userInput/requested'], ['observer', 'userInput/requested']]);
  assert.equal(adapter.value, 7); assert.equal(adapter.request(), 7);
});

async function fakeHost(t) {
  const hosts = [];
  const events = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    if (typeof chunk === 'string' && chunk.startsWith('{"type":"event"')) { events.push(JSON.parse(chunk)); return true; }
    return originalWrite.call(this, chunk, ...args);
  };
  t.after(() => { process.stdout.write = originalWrite; });
  globalThis.fakeSdk = {
    spawn() {
      const exit = deferred();
      const current = { exit, requests: [], commands: [], pending: [] };
      current.connection = {
        onNotification(handler) { current.notify = handler; },
        request: async (method, params) => { current.requests.push([method, params]); return { userInputs: current.pending }; },
        command: async (method, params) => { current.commands.push([method, params]); return { status: 'accepted' }; },
      };
      current.spawned = { child: { exit: exit.promise }, connection: current.connection, initializeResult: { serverInfo: {}, sessionDurability: 'durable' } };
      hosts.push(current);
      return { initialize: async () => current.spawned };
    },
    MuseClient: class {
      constructor(connection, { host }) { this.host = host; connection.onNotification(() => {}); }
      async close() { this.host.child.exit; hosts.find(item => item.spawned === this.host).exit.resolve({ code: 0 }); await Promise.resolve(); }
      async resumeSession({ sessionId }) { return { sessionId, onApproval() {}, onApprovalError() {}, onGapError() {}, opening: { verb: 'session/resume', result: { session: { sessionId, activeTurnId: null }, history: { items: [] } } } }; }
    },
  };
  const { MuseHost } = await bundle('packages/glitter-bridge/src/host.ts', {
    '@muse-code/sdk': 'export const spawnMspConnection=(...args)=>globalThis.fakeSdk.spawn(...args); export const MuseClient=globalThis.fakeSdk.MuseClient; export const readSessionDurability=()=>({kind:"durable"}); export const EXPECTED_SCHEMA_FINGERPRINT="sha256:fake-pin";',
    './detect.js': 'export const resolveMuseBin=()=>"/fake/muse"; export const detectMuse=()=>({found:true}); export const museEnv=base=>({...base});',
  });
  return { host: new MuseHost(), hosts, events };
}
test('host restart emits retirement without emitting a crash from the old process', async t => {
  const { host, hosts, events } = await fakeHost(t);
  await host.start(); await host.start();
  assert.equal(hosts.length, 2);
  assert.deepEqual(events.map(event => event.event), ['hostStopping']);
  hosts[1].exit.resolve({ code: 1 }); await new Promise(setImmediate);
  assert.equal(events.at(-1).event, 'hostExit');
  assert.equal((await host.status()).running, false);
});
test('host restores questions on resume and sends answer, clarification and cancellation commands', async t => {
  const { host, hosts } = await fakeHost(t);
  await host.start();
  const server = hosts[0];
  server.pending = [question()];
  const resumed = await host.resumeSession({ sessionId: 's' });
  assert.deepEqual(resumed.userInputs, [question()]);
  assert.equal(server.requests[0][0], 'approval/listPending');
  const answers = [{ questionId: 'choice', selectedLabel: 'A' }];
  await host.respondUserInput({ sessionId: 's', userInputId: 'q', response: { action: 'answer', answers } });
  await host.respondUserInput({ sessionId: 's', userInputId: 'q', response: { action: 'clarify', text: 'Consider C' } });
  await host.respondUserInput({ sessionId: 's', userInputId: 'q', response: { action: 'cancel' } });
  assert.deepEqual(server.commands.map(([method]) => method), ['userInput/answer', 'userInput/clarify', 'userInput/cancel']);
  assert.deepEqual(server.commands[0][1].answers, answers);
  assert.deepEqual(server.commands[1][1].clarification, { format: 'text', content: 'Consider C' });
  server.notify(notification('userInput/settled', { sessionId: 's', userInputId: 'q' }));
  await assert.rejects(host.respondUserInput({ sessionId: 's', userInputId: 'q', response: { action: 'cancel' } }), /no longer pending/);
  await host.stop();
});

// Exercise the actual component handlers with a minimal deterministic hook host.
// Browser smoke checks cover native dialog/keyboard rendering separately.
test('first selection of an untrusted workspace prompts trust exactly once', async () => {
  const store = await frontendStore();
  globalThis.storeBridge = async () => ({});
  globalThis.readGit = async () => ({ branch: 'main', dirty: false, files: [], diff: '', truncated: false });
  globalThis.trustPreviewResult = { skills: [{ name: '/deploy', description: 'Deploys' }], rules: null };
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g', trusted: false }], preview: false });
  await store.getState().selectWorkspace('w');
  await new Promise(setImmediate);
  assert.equal(store.getState().trustDialog?.workspaceId, 'w');
  assert.deepEqual(store.getState().trustDialog?.preview, globalThis.trustPreviewResult);
  assert.equal(store.getState().workspaces[0].trustPrompted, true);
  // Re-selecting after dismissing does not reopen the dialog.
  store.getState().closeTrustDialog();
  await store.getState().selectWorkspace('w');
  await new Promise(setImmediate);
  assert.equal(store.getState().trustDialog, null);
});

test('an untrusted workspace with nothing to trust marks prompted silently', async () => {
  const store = await frontendStore();
  globalThis.storeBridge = async () => ({});
  globalThis.readGit = async () => ({ branch: 'main', dirty: false, files: [], diff: '', truncated: false });
  globalThis.trustPreviewResult = { skills: [], rules: null };
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g' }], preview: false });
  await store.getState().selectWorkspace('w');
  await new Promise(setImmediate);
  assert.equal(store.getState().trustDialog, null);
  assert.equal(store.getState().workspaces[0].trustPrompted, true);
});

test('confirm resolves with the answer and a second confirm cancels the first', async () => {
  const store = await frontendStore();
  const first = store.getState().confirm({ title: 'Delete thread?' });
  assert.equal(store.getState().confirmDialog?.title, 'Delete thread?');
  assert.equal(store.getState().confirmDialog?.confirmLabel, 'Confirm');
  assert.equal(store.getState().confirmDialog?.danger, false);
  store.getState().resolveConfirm(true);
  assert.equal(await first, true);
  assert.equal(store.getState().confirmDialog, null);
  const second = store.getState().confirm({ title: 'One' });
  const third = store.getState().confirm({ title: 'Two' });
  assert.equal(await second, false, 'a new confirm resolves the pending one as cancelled');
  store.getState().resolveConfirm(false);
  assert.equal(await third, false);
});

test('hydrate clamps a persisted per-thread-only approval default', async () => {
  for (const [mode, expected] of [['allowAll', 'onRequest'], ['promptUnmatched', 'onRequest'], ['guarded', 'guarded']]) {
    globalThis.persistedData = { settings: { defaultApprovalMode: mode } };
    const store = await frontendStore({
      '@tauri-apps/plugin-store': `export class LazyStore { async entries(){ return Object.entries(globalThis.persistedData ?? {}); } async get(key){ return globalThis.persistedData?.[key]; } async set(key, value){ globalThis.persistedData = { ...globalThis.persistedData, [key]: value }; } async save(){ throw new Error('the non-atomic plugin writer must not be used'); } }`,
      '@tauri-apps/api/core': `export const invoke = async (command) => command === 'acp_isolation_consent_get' ? false : command === 'credential_get' ? null : undefined;`,
      '@tauri-apps/plugin-notification': `export const isPermissionGranted=async()=>true;export const requestPermission=async()=>"granted";export const sendNotification=()=>{};`,
    }, true);
    await store.getState().hydrate();
    assert.equal(store.getState().defaultApprovalMode, expected, `${mode} hydrates to ${expected}`);
  }
});

function hooks() {
  const values = []; let cursor = 0; const effects = [];
  return {
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return values[i] ??= { current: initial }; },
    useEffect(callback, dependencies) { const i = cursor++; if (!values[i] || dependencies.some((value, j) => value !== values[i][j])) { values[i] = dependencies; effects.push(callback); } },
    render(Component, props) { cursor = 0; const tree = Component(props); for (const effect of effects.splice(0)) effect(); return tree; },
  };
}
function nodes(element) {
  if (!element || typeof element !== 'object') return [];
  const children = Array.isArray(element.props?.children) ? element.props.children.flat(Infinity) : [element.props?.children];
  return [element, ...children.flatMap(nodes)];
}
async function settingsComponent() {
  const runtime = hooks(); globalThis.componentHooks = runtime;
  const commits = [];
  const state = { ...DEFAULT_SETTINGS, models: [], agents: [], settingsOpen: true, settingsTab: "Models", preview: false, hostInfo: null,
    setSettingsOpen: (value, tab) => { state.settingsOpen = value; if (tab) state.settingsTab = tab; },
    loadModelCatalog: async () => state.models,
    agentIdentities: [], refreshAgentIdentities: async () => {},
    commitSettings: async patch => { commits.push(patch); Object.assign(state, patch); },
    startHost: async () => { state.restarts = (state.restarts ?? 0) + 1; },
  };
  globalThis.componentState = state;
  const { SettingsModal } = await bundle('apps/desktop/src/components/SettingsModal.tsx', {
    'react/jsx-runtime': 'export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;export const Fragment=Symbol.for("react.fragment");',
    react: 'export const useState=(...args)=>globalThis.componentHooks.useState(...args); export const useRef=(...args)=>globalThis.componentHooks.useRef(...args); export const useEffect=(...args)=>globalThis.componentHooks.useEffect(...args); export const useId=(()=>{let n=0;return()=>`id-${++n}`})(); export const useDeferredValue=(value)=>value; export const lazy=(load)=>{const component=()=>null;component.load=load;return component;}; export const Suspense=(props)=>props.children ?? null;',
    'zustand/react/shallow': 'export const useShallow=(selector)=>selector;',
    '../lib/store': 'export const useAppStore=()=>globalThis.componentState;useAppStore.getState=()=>globalThis.componentState;export const applyTheme=()=>{};export const hasWindowMaterial=()=>false;export const currentThread=()=>undefined;export const currentWorkspace=()=>undefined;export const preferredAgent=()=>"muse";',
    '../lib/bridge': 'export const openLogFolder=async()=>"/preview/logs/app.log";export const diagnosticsSnapshot=async()=>({os:"browser-preview",arch:"",logTail:[]});export const providerKeysGet=async(ids)=>ids.map((id)=>({id,configured:false,keyHint:null,baseUrl:null}));export const providerKeySet=async()=>[];export const openUrl=async()=>{};',
    'lucide-react': 'const I=()=>null;export const Activity=I,Archive=I,ArchiveRestore=I,ArrowLeft=I,Bot=I,ChartNoAxesColumn=I,Check=I,ChevronDown=I,Command=I,Cpu=I,Eye=I,EyeOff=I,ExternalLink=I,FilePlus=I,FolderOpen=I,Info=I,KeyRound=I,LoaderCircle=I,Lock=I,MessagesSquare=I,Minus=I,Monitor=I,Moon=I,Palette=I,PanelLeft=I,Plug=I,Plus=I,Puzzle=I,RefreshCw=I,Search=I,Settings2=I,ShieldAlert=I,ShieldCheck=I,Sun=I,Trash2=I,TriangleAlert=I,X=I;',
    './SelectMenu': 'export const SelectMenu=()=>null;',
    './AgentPicker': 'export const AgentMark=()=>null;export const ProviderMark=()=>null;export const ModelIcon=()=>null;',
    './ExtensionsView': 'export const ExtensionsView=()=>null;',
    './ModelLibrary': 'export const ModelLibrary=()=>null;',
    './UsageView': 'export const UsageView=()=>null;',
    './LoginPanel': 'export const LoginPanel=()=>null;',
  });
  const render = () => runtime.render(SettingsModal);
  render(); render();
  return { state, commits, render };
}
test('Settings saves preferences as they change, and Cancel discards only a pending connection setting', async () => {
  const { state, commits, render } = await settingsComponent();
  let tree = nodes(render());
  assert.ok(!tree.some(node => node.type === 'button' && node.props.children === 'Cancel'), 'nothing is pending, so there is nothing to cancel');
  tree.find(node => node.props?.['aria-label'] === 'Permissions').props.onClick();
  tree = nodes(render());
  tree.find(node => typeof node.type === 'function' && node.props?.draft && node.props?.onChange).props.onChange({ defaultApprovalMode: 'denyUnmatched' });
  await new Promise(setImmediate);
  assert.deepEqual(commits, [{ defaultApprovalMode: 'denyUnmatched' }]);
  tree = nodes(render());
  // Muse's connection lives on the Agents page.
  tree.find(node => node.props?.['aria-label'] === 'Agents').props.onClick();
  tree = nodes(render());
  tree.find(node => node.props?.id === 'muse-bin').props.onChange({ target: { value: '/other/muse' } });
  tree.find(node => node.props?.['aria-label'] === 'Theme').props.onClick();
  tree = nodes(render());
  const theme = tree.find(node => typeof node.type === 'function' && node.props?.draft && node.props?.onChange);
  nodes(theme.type(theme.props)).filter(node => node.props?.role === 'radio')[1].props.onClick();
  await new Promise(setImmediate);
  tree = nodes(render());
  tree.find(node => node.type === 'button' && node.props.children === 'Cancel').props.onClick();
  assert.equal(state.settingsOpen, false);
  assert.equal(state.defaultApprovalMode, 'denyUnmatched'); assert.equal(state.theme, 'light');
  assert.equal(state.museBin, '', 'the binary path waits for a restart and is dropped on Cancel');
  assert.ok(commits.every(patch => !('museBin' in patch)));
  assert.equal(state.restarts ?? 0, 0);
});
test('Settings restarts a running host only for a posture change, after an explicit save', async () => {
  const { state, commits, render } = await settingsComponent();
  state.hostInfo = { posture: { ephemeralSessions: false, disableWrite: false, disableShell: false, sandboxNetwork: 'proxy-only' } };
  let tree = nodes(render());
  tree.find(node => node.props?.['aria-label'] === 'Permissions').props.onClick();
  tree = nodes(render());
  const panel = () => nodes(render()).find(node => typeof node.type === 'function' && node.props?.draft && node.props?.onChange);
  panel().props.onChange({ defaultApprovalMode: 'denyUnmatched' });
  await new Promise(setImmediate);
  assert.equal(state.restarts ?? 0, 0, 'a preference never restarts the host');
  panel().props.onChange({ ephemeralSessions: true });
  await new Promise(setImmediate);
  assert.equal(state.ephemeralSessions, false, 'a posture change is not applied until it is saved');
  tree = nodes(render());
  tree.find(node => node.type === 'button' && node.props.children === 'Save & restart connection').props.onClick();
  await new Promise(setImmediate);
  assert.equal(commits.at(-1).ephemeralSessions, true);
  assert.ok(!('defaultApprovalMode' in commits.at(-1)), 'the restart save carries host settings only');
  assert.equal(state.restarts, 1);
  assert.equal(state.settingsOpen, false);
});
test('A failed Settings save is shown and keeps the dialog open', async () => {
  const { state, render } = await settingsComponent();
  state.commitSettings = async () => { throw new Error('credential store locked'); };
  let tree = nodes(render());
  tree.find(node => node.props?.['aria-label'] === 'Theme').props.onClick();
  tree = nodes(render());
  const theme = tree.find(node => typeof node.type === 'function' && node.props?.draft && node.props?.onChange);
  nodes(theme.type(theme.props)).filter(node => node.props?.role === 'radio')[1].props.onClick();
  await new Promise(setImmediate);
  assert.equal(state.settingsOpen, true);
  assert.ok(nodes(render()).some(node => node.props?.role === 'status' && String(node.props.children).includes('credential store locked')));
  tree.find(node => node.props?.['aria-label'] === 'Permissions').props.onClick();
  tree = nodes(render());
  tree.find(node => typeof node.type === 'function' && node.props?.draft && node.props?.onChange).props.onChange({ disableShell: true });
  tree = nodes(render());
  tree.find(node => node.type === 'button' && node.props.children === 'Save & restart connection').props.onClick();
  await new Promise(setImmediate);
  assert.equal(state.settingsOpen, true);
  assert.equal(state.disableShell, false);
});

async function questionComponent(request) {
  const runtime = hooks(); globalThis.componentHooks = runtime;
  const sent = [];
  globalThis.componentState = { respondUserInput: (...args) => sent.push(args) };
  const { UserInputCard } = await bundle('apps/desktop/src/components/UserInputCard.tsx', {
    react: 'export const useState=(...args)=>globalThis.componentHooks.useState(...args); export const useRef=(...args)=>globalThis.componentHooks.useRef(...args); export const useEffect=(...args)=>globalThis.componentHooks.useEffect(...args); export const useId=(()=>{let n=0;return()=>`id-${++n}`})();',
    'react/jsx-runtime': 'export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;export const Fragment=Symbol.for("react.fragment");',
    '../lib/store': 'export const useAppStore=(selector)=>selector(globalThis.componentState);',
  });
  return { sent, render: () => runtime.render(UserInputCard, { request, disabled: false }) };
}
test('question form validates all questions and emits single, multiple and free-text answers', async () => {
  const request = question();
  request.questions.push({ id: 'multi', header: 'Pick two', question: 'Which two?', options: [{ label: 'C' }, { label: 'D' }], selection: { mode: 'multiple', minSelections: 2, maxSelections: 2 } });
  request.questions.push({ id: 'text', header: 'Explain', question: 'Why?', options: [], selection: { mode: 'single' } });
  const { sent, render } = await questionComponent(request);
  let tree = nodes(render());
  const submit = () => nodes(render()).find(node => node.type === 'button' && node.props.children === 'Send answers').props.onClick();
  submit(); assert.equal(sent.length, 0);
  tree.find(node => node.type === 'input' && node.props.type === 'radio').props.onChange({ target: { checked: true } });
  tree = nodes(render());
  tree.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  submit(); assert.equal(sent.length, 0);
  tree = nodes(render());
  tree.filter(node => node.type === 'input' && node.props.type === 'checkbox')[1].props.onChange({ target: { checked: true } });
  tree.find(node => node.type === 'textarea').props.onChange({ target: { value: 'Because it works' } });
  submit();
  assert.deepEqual(sent, [['s', 'q', { action: 'answer', answers: [
    { questionId: 'choice', selectedLabel: 'A' },
    { questionId: 'multi', selectedLabels: ['C', 'D'] },
    { questionId: 'text', freeText: 'Because it works' },
  ] }]]);
});
test('question form offers clarification and decline independently of required answers', async () => {
  const { sent, render } = await questionComponent(question());
  nodes(render()).find(node => node.type === 'button' && node.props.children === 'Let me explain').props.onClick();
  let tree = nodes(render());
  assert.equal(tree.find(node => node.type === 'button' && node.props.children === 'Send explanation').props.disabled, true);
  tree.find(node => node.type === 'textarea').props.onChange({ target: { value: 'Consider a third option' } });
  tree = nodes(render());
  tree.find(node => node.type === 'button' && node.props.children === 'Send explanation').props.onClick();
  tree.find(node => node.type === 'button' && node.props.children === 'Decline to answer').props.onClick();
  assert.deepEqual(sent.map(args => args[2]), [{ action: 'clarify', text: 'Consider a third option' }, { action: 'cancel' }]);
});

test('workflow reconciled envelope renders as a summary, not raw JSON', async () => {
  const { parseWorkflowMessage, agentCounts } = await bundle('apps/desktop/src/lib/agent.ts');
  const payload = { type: 'workflow_launch_reconciled', launch_admitted: true,
    final_summary: { status: 'completed', summary: JSON.stringify({ complete: true, evidence: ['wrote docs/release-readiness.md'], unresolved: ['open_url scheme validation'] }) },
    latest_failure: null,
    agents_activity: [{ agent: 'a1', tool_calls: 47, duration_ms: 207249 }, { agent: 'a2', tool_calls: 38, duration_ms: 224644 }] };
  const message = `<workflow-launch-reconciled>${JSON.stringify(payload)}</workflow-launch-reconciled>`;
  const outcome = parseWorkflowMessage(message);
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(outcome.evidence, ['wrote docs/release-readiness.md']);
  assert.deepEqual(outcome.unresolved, ['open_url scheme validation']);
  assert.equal(outcome.activity.get('a1').durationMs, 207249);
  assert.ok(!outcome.text.includes('{'));
  assert.equal(parseWorkflowMessage('<x-y>not json</x-y>').text, '');
  assert.equal(parseWorkflowMessage('All done.').text, 'All done.');
  const children = [{ childId: 'a1', attempt: 1, status: 'started' }, { childId: 'a2', attempt: 1, status: 'queued' }];
  assert.deepEqual(agentCounts({ kind: 'workflow', status: 'completed', message, children }).states, ['completed', 'completed']);
  assert.deepEqual(agentCounts({ kind: 'workflow', status: 'completed', message: 'done', children }).states, ['cancelled', 'cancelled']);
});

// React rejects a component that renders more hooks than it did last time
// (error #310). ReviewDock once returned null for a closed dock *before* two
// useMemo calls, so opening the Changes dock crashed the whole window.
test('no component calls a hook after an early return', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
  const hook = /\buse(State|Effect|LayoutEffect|Memo|Ref|Callback|Id|AppStore|SyncExternalStore)\s*\(/;
  const componentStart = /^(export )?(default )?function [A-Za-z]|^(export )?const [A-Z][A-Za-z]*\s*[:=].*=>\s*\{/;
  const offenders = [];
  for (const file of walk('apps/desktop/src')) {
    const lines = readFileSync(file, 'utf8').split('\n');
    let inComponent = false, earlyReturn = null;
    lines.forEach((line, index) => {
      if (componentStart.test(line)) { inComponent = true; earlyReturn = null; return; }
      if (!inComponent) return;
      // A bail-out in the component body, guarded or not.
      if (earlyReturn === null && /^ {2}(if \(.*\) )?return\b/.test(line)) earlyReturn = index + 1;
      if (earlyReturn !== null && hook.test(line) && !line.includes('useAppStore.getState')) {
        offenders.push(`${file}:${index + 1} calls a hook after the return on line ${earlyReturn}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

// The renderer→native surface lives in lib/bridge.ts so the mock/preview
// fallback convention covers every command. Callers that invoked Tauri
// directly (credential_get, acp_isolation_consent_*, open_log_folder) skipped
// that seam; they now go through named bridge wrappers. logger.ts and
// haptics.ts are the sanctioned exceptions: bridge.ts imports logger, so a
// logger→bridge edge would be circular, and haptics is a fire-and-forget
// one-liner with no fallback to centralize.
test('only the bridge module and its two sanctioned exceptions invoke Tauri commands', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) && !name.endsWith('.test.tsx') ? [full] : [];
  });
  const sanctioned = new Set(['bridge.ts', 'haptics.ts', 'logger.ts']);
  const offenders = walk('apps/desktop/src')
    .filter(file => !sanctioned.has(file.split('/').pop()))
    .filter(file => /from ['"]@tauri-apps\/api\/core['"]/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
  // The sanctioned set must not quietly grow: it is exactly these three.
  const allowed = walk('apps/desktop/src')
    .filter(file => /from ['"]@tauri-apps\/api\/core['"]/.test(readFileSync(file, 'utf8')))
    .map(file => file.split('/').pop()).sort();
  assert.deepEqual(allowed, ['bridge.ts', 'haptics.ts', 'logger.ts']);
});

// Agent toggles looked dead: every switch rendered disabled with the reason
// only in a `title` attribute, which browsers never show on disabled buttons.
// The reason now renders inline on the row, and the consent gate unlocks the
// third-party toggle so a second ready agent frees the Muse switch.
test('Agent toggles explain consent and last-ready-agent gates, then unlock', async () => {
  const { state, commits, render } = await settingsComponent();
  state.agents = [
    { id: 'muse', name: 'Muse', protocol: 'msp', found: true, path: '/bin/muse', version: '1.3.0', verified: true, signIn: '', authenticated: true },
    { id: 'opencode', name: 'OpenCode', protocol: 'acp', found: true, path: '/bin/opencode', version: '1.18.31', verified: true, signIn: '' },
  ];
  state.agentIdentities = [];
  state.refreshAgentIdentities = async () => {};
  let tree = nodes(render());
  tree.find(node => node.props?.['aria-label'] === 'Agents').props.onClick();
  tree = nodes(render());
  const toggleFor = (label) => tree.find(node => node.type === 'button' && node.props?.['aria-label'] === label);
  assert.equal(toggleFor('Show OpenCode and its threads').props.disabled, true);
  assert.equal(toggleFor('Hide Muse and its threads').props.disabled, true);
  assert.ok(tree.some(node => node.props?.children === 'Hidden — accept the isolation notice above to enable'));
  tree.find(node => node.type === 'input' && node.props?.type === 'checkbox').props.onChange({ target: { checked: true } });
  tree = nodes(render());
  assert.equal(toggleFor('Show OpenCode and its threads').props.disabled, false);
  assert.equal(toggleFor('Hide Muse and its threads').props.disabled, true);
  toggleFor('Show OpenCode and its threads').props.onClick();
  tree = nodes(render());
  assert.equal(toggleFor('Hide Muse and its threads').props.disabled, false);
  assert.equal(toggleFor('Hide OpenCode and its threads').props['aria-checked'], true);
  await new Promise(setImmediate);
  // Agent visibility is a preference: each change is saved as it is made.
  assert.equal(commits[0].acpUnisolatedConsent, true);
  assert.equal(commits.at(-1).enabledAgents.opencode, true);
  assert.equal(commits.at(-1).enabledAgents.muse, true);
  assert.ok(!nodes(render()).some(node => node.type === 'button' && node.props.children === 'Save changes'));
});

// Grok's set_config_option takes ~2s. Scrubbing effort during the apply used to
// drop input and fire two listModels refreshes per echo — seconds of churn per
// detent. Patches now merge into one trailing call, and effort-only echoes skip
// the catalog refresh.
test('ACP config changes coalesce in flight and effort echoes skip listModels', async () => {
  const store = await frontendStore();
  const calls = [];
  const releases = [];
  globalThis.storeBridge = (method, params) => {
    calls.push({ method, params });
    if (method === 'setSessionOption') return new Promise((resolve) => releases.push(resolve));
    // A listing with models: an empty one is asked again, which this test does not count.
    return Promise.resolve(method === 'listModels' ? { models: [{ modelId: 'grok-5' }] } : {});
  };
  store.setState({
    preview: false,
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g' }], selectedWorkspaceId: 'w',
    threads: [{ ...thread('s1', '/repo'), agentId: 'grok', config: { agentId: 'grok', modelId: 'grok-4.6', effort: 'low', mode: 'agent' } }],
    selectedSessionId: 's1', modelsAgentId: 'grok', models: [],
  });
  const first = store.getState().setSessionConfig({ effort: 'high' });
  await new Promise(setImmediate);
  assert.equal(store.getState().threads[0].configPending, true);
  await store.getState().setSessionConfig({ effort: 'medium' });
  await store.getState().setSessionConfig({ effort: 'max' });
  assert.deepEqual(store.getState().threads[0].pendingConfig, { effort: 'max' });
  assert.equal(calls.filter((c) => c.method === 'setSessionOption').length, 1, 'no second call while one is in flight');
  releases.shift()({ agentConfig: { modelId: 'grok-4.6', effort: 'high', mode: 'agent' } });
  await first;
  await new Promise(setImmediate);
  const options = calls.filter((c) => c.method === 'setSessionOption');
  assert.equal(options.length, 2);
  assert.equal(options[1].params.value, 'max', 'the merged stash sends only the newest value');
  releases.shift()({ agentConfig: { modelId: 'grok-4.6', effort: 'max', mode: 'agent' } });
  await new Promise(setImmediate);
  assert.equal(store.getState().threads[0].config.effort, 'max');
  assert.equal(store.getState().threads[0].pendingConfig, undefined);
  globalThis.storeEvent('agentConfig', { sessionId: 's1', config: { modelId: 'grok-4.6', effort: 'high', mode: 'agent' } });
  await new Promise(setImmediate);
  assert.equal(calls.filter((c) => c.method === 'listModels').length, 0, 'effort-only echo skips the refresh');
  globalThis.storeEvent('agentConfig', { sessionId: 's1', config: { modelId: 'grok-5', effort: 'high', mode: 'agent' } });
  await new Promise(setImmediate);
  assert.equal(calls.filter((c) => c.method === 'listModels').length, 1, 'a model move still refreshes the catalog');
});

// The command palette was a scrim div with role="dialog" and no focus trap, so
// Tab walked out of the "modal" into the sidebar and composer behind it and
// focus was dropped to <body> on close. Every other modal is a native dialog.
test('every modal surface is a native dialog that traps focus', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('apps/desktop/src/components/CommandPalette.tsx', 'utf8');
  assert.match(source, /<dialog\b/, 'the palette must be a native dialog, not a scrim div');
  assert.match(source, /showModal\(\)/, 'a native dialog only traps focus once it is shown modally');
  assert.doesNotMatch(source, /role="dialog"/, 'a native dialog needs no hand-rolled dialog role');
  // Focus returns to whatever opened it: closeDialog schedules the shared
  // deferred restore, which skips a newer modal and re-attaches an element
  // left half-focused by top-layer teardown via a real blur/focus transition
  // (DES-INT-003).
  assert.match(source, /closeDialog\(node\)/, 'the palette closes through the shared restore path');
});

// Each modal hand-rolled its own showModal/close. The webviews Tauri runs on do
// not consistently restore focus after close(), so a keyboard user who opened
// Settings from the sidebar gear was dropped onto <body> on close.
test('modal surfaces share one focus-returning dialog hook', async () => {
  const { readFileSync } = await import('node:fs');
  const modals = ['SettingsModal', 'OutputModal', 'SubagentModal', 'PreviewModal', 'InitModal', 'TrustModal'];
  const offenders = [];
  for (const name of modals) {
    const source = readFileSync(`apps/desktop/src/components/${name}.tsx`, 'utf8');
    if (!source.includes('useModalDialog(')) offenders.push(`${name} does not use the shared dialog hook`);
    // A second, hand-rolled open/close effect would race the hook's focus restore.
    if (/showModal\(\)/.test(source)) offenders.push(`${name} still calls showModal itself`);
  }
  assert.deepEqual(offenders, []);
  const hook = readFileSync('apps/desktop/src/lib/dialogFocus.ts', 'utf8');
  assert.match(hook, /addEventListener\("close", restore\)/, 'focus is restored on close, not on open');
  // The app-initiated close path goes through closeDialog — the effect cleanup
  // detaches the close listener first, so restoreDialogFocus must be scheduled
  // from closeDialog itself or it never runs (the dead-composer regression).
  assert.match(hook, /node\.close\(\);[\s\S]{0,220}restoreDialogFocus\(\)/, 'an app-initiated close schedules the shared restore');
  assert.match(hook, /if \(modalOpen\(\)\) return;/, 'a newer modal surface keeps its focus');
  assert.match(hook, /target\.closest\("dialog:not\(\[open\]\)"\)/, 'openers inside a dialog that already closed are skipped');
  // An element already active is left half-focused by top-layer teardown —
  // only a blur followed by a genuinely later focus() re-attaches its input.
  assert.match(hook, /target\.blur\(\);[\s\S]{0,160}setTimeout[\s\S]{0,160}target\.focus\(\)/, 'an already-active opener gets a deferred re-attach');
});

// The shortcut/modal guard probed `dialog[open]` only, but the image viewer
// is a rendered overlay — chords like mod+Y and digit thread jumps mutated
// state invisibly behind it (RA-002). The shared predicate covers both.
test('the modal guard covers non-native modal surfaces too', async () => {
  const { readFileSync } = await import('node:fs');
  const hook = readFileSync('apps/desktop/src/lib/dialogFocus.ts', 'utf8');
  assert.match(hook, /export function modalOpen\(\)/, 'a shared modal predicate exists');
  assert.match(hook, /aria-modal="true"/, 'the predicate sees rendered modal overlays, not just native dialogs');
  const app = readFileSync('apps/desktop/src/App.tsx', 'utf8');
  assert.doesNotMatch(app, /querySelector\("dialog\[open\]"\)/, 'no direct dialog-only probe may remain in the guard paths');
});

// Changes is one review surface; Diff, Files, and Monitor no longer need four
// peer tabs, but the current view still needs an accessible region name.
test('the changes dock names its single review region', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('apps/desktop/src/components/ReviewDock.tsx', 'utf8');
  assert.match(source, /id="dock-panel" role="region" aria-label=\{viewTitle\}/);
  assert.doesNotMatch(source, /role="tablist" aria-label="Changes view"/);
});

// A menu that closed on Tab left focus on the document body, because the
// focused option unmounted. The keyboard user was dropped out of the composer.
test('menus return focus to their trigger when dismissed by keyboard', async () => {
  const { readFileSync } = await import('node:fs');
  // A menu that closed on Tab or Escape left focus on <body>, because the focused
  // option unmounted and the keyboard user was dropped out of the composer.
  const selectMenu = readFileSync('apps/desktop/src/components/SelectMenu.tsx', 'utf8');
  assert.match(selectMenu, /const close = \(\) => \{[\s\S]{0,120}?focus\(\)/, "SelectMenu.close restores focus to the trigger");
  assert.match(selectMenu, /event\.key === "Tab"[\s\S]{0,900}?\.focus\(\)/, "SelectMenu restores focus when Tab dismisses it");
  const modelPicker = readFileSync('apps/desktop/src/components/ModelPicker.tsx', 'utf8');
  for (const key of ["Tab", "Escape"]) {
    assert.match(modelPicker, new RegExp(`event\\.key === "${key}"[\\s\\S]{0,900}?\\.focus\\(\\)`),
      `ModelPicker restores focus when ${key} dismisses it`);
  }
});
