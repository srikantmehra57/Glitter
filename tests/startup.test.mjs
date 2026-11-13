import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-startup-'));
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
/** Let queued microtasks and immediates run so awaited store work can advance. */
const settle = async (rounds = 8) => { for (let i = 0; i < rounds; i += 1) await new Promise(setImmediate); };
async function until(predicate, label) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.fail(`timed out waiting for ${label}`);
}

const replacements = {
  './bridge': `export const credentialGet=async()=>globalThis.testInvoke ? globalThis.testInvoke('credential_get') : null;
    export const credentialSet=async(value)=>{ if (globalThis.testInvoke) return globalThis.testInvoke('credential_set',{value}); };
    export const acpConsentGet=async()=>globalThis.testInvoke ? globalThis.testInvoke('acp_isolation_consent_get') : false;
    export const acpConsentSet=async(consented)=>{ if (globalThis.testInvoke) return globalThis.testInvoke('acp_isolation_consent_set',{consented}); };
    export const openLogFolder=async()=>globalThis.testInvoke ? globalThis.testInvoke('open_log_folder') : '/preview/logs/app.log';
    export const providerKeysGet=async(ids)=>ids.map((id)=>({id,configured:false,keyHint:null,baseUrl:null}));
    export const persistStoreDocument=async()=>{};
    export const repairStoreDocument=async()=>({status:'ok'});
    export const bridge=(...args)=>globalThis.storeBridge(...args);
    export const gitReview=async(...args)=>globalThis.readReview?.(...args) ?? {files:[],diff:"",truncated:false};
    export const gitSnapshot=async()=>({branch:'main',dirty:false,files:[],diff:'',truncated:false});
    export const gitGraph=async(...args)=>globalThis.readGitGraph?.(...args) ?? {graph:'',truncated:false};
    export const verifyGrants=async(entries)=>entries.map((entry)=>({id:entry.id,ok:true,path:entry.path}));
    export const removeGrant=async()=>{};
    export const onBridgeEvent=(handler)=>{globalThis.storeEvent=handler;return ()=>{}};
    export const onWindowCloseRequested=()=>()=>{};
    export const pickFolder=async()=>null;export const mockThreads=()=>[];
    export const readDroppedPaths=async()=>[];
    export const agentIdentities=async()=>[];export const confirmAgentBin=async()=>{throw new Error('preview')};
    export const gitDiscardFiles=async()=>({});export const gitDiscardAll=async()=>({});export const gitDiscardHunk=async()=>({});export const turnSnapshots=async(...args)=>globalThis.listSnapshots?.(...args) ?? [];
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
    export const gitInit=async()=>({});
    export const gitStage=async()=>({});export const gitCommit=async()=>({});
    export const trustPreview=async()=>({ skills: [], rules: null });
    export const listWorkspaceFiles=async()=>[];
    export const cliLogout=async()=>{};export const pluginList=async()=>[];export const skillList=async()=>[];
    export const catalogList=async()=>({entries:[],skillsRoot:'',error:null});export const catalogInstall=async()=>({installedSkills:[],installedServers:[],skipped:[],errors:[]});export const catalogRemove=async()=>({removed:[],skipped:[],errors:[]});export const githubInstall=async()=>({id:'',skills:[],commands:[],servers:[],problems:[]});export const libraryList=async()=>({plugins:[],marketplaces:[],pluginsRoot:'',problems:[]});export const librarySetEnabled=async()=>({id:'',skills:[],commands:[],servers:[],problems:[]});export const libraryRemove=async()=>[];export const libraryCheckUpdates=async()=>[];export const marketplaceAdd=async()=>({});export const marketplaceRefresh=async()=>({});export const marketplaceRemove=async()=>{};
    export const projectInit=async()=>'';export const enterpriseStatus=async()=>({ generation: null, sources: [] });
    export const pickPluginBundle=async()=>null;export const pluginInstall=async()=>{};
    export const pickSkillSource=async()=>null;export const skillInstall=async()=>'';export const skillImport=async()=>'';export const skillUninstall=async()=>'';`,
  '@tauri-apps/plugin-store': `export class LazyStore { async entries(){ return Object.entries(globalThis.persistedData ?? {}); } async get(key){ return globalThis.persistedData?.[key]; } async set(key, value){ globalThis.persistedData = { ...globalThis.persistedData, [key]: value }; } async save(){} }`,
  '@tauri-apps/api/core': `export const invoke = async (command) => command === 'acp_isolation_consent_get' ? false : command === 'credential_get' ? null : undefined;`,
  '@tauri-apps/plugin-notification': `export const isPermissionGranted=async()=>true;export const requestPermission=async()=>"granted";export const sendNotification=()=>{};`,
};

const POSTURE = { ephemeralSessions: false, disableWrite: false, disableShell: false, sandboxNetwork: 'proxy-only' };
const MUSE = { id: 'muse', name: 'Muse', protocol: 'msp', found: true, authenticated: true, path: '/bin/muse', version: '1.0.0', verified: true, signIn: '' };
const detected = { found: true, path: '/bin/muse', version: '1.0.0', authenticated: true, agents: [MUSE] };
const session = (sessionId, root = '/repo') => ({ sessionId, workspaceRoot: root, updatedAt: '2026-09-29T00:00:00.000Z', status: 'idle' });

async function bootedStore({ workspaces, selectedWorkspaceId = null, selectedSessionId = null } = {}) {
  globalThis.window = { __TAURI_INTERNALS__: {}, setTimeout, clearTimeout, matchMedia: () => ({ matches: false }) };
  globalThis.document = { documentElement: { dataset: {}, style: { setProperty(name, value) { this[name] = value; } } } };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.persistedData = {
    settings: { workspaces: workspaces ?? [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }] },
    sessionMemory: { version: 1, selectedWorkspaceId, selectedSessionId, drafts: {}, threadMeta: {}, dockOpen: true, sidebarCollapsed: false, subscriptionUsage: null },
  };
  const calls = [];
  globalThis.storeBridge = async (method, params) => {
    calls.push([method, params]);
    if (method === 'detect') { await globalThis.detectGate?.promise; return detected; }
    if (method === 'status') return { running: true, trustWorkspace: false, posture: POSTURE };
    if (method === 'startHost') return { trustWorkspace: params.trustWorkspace === true, posture: { ...POSTURE, ephemeralSessions: params.noSessionLog === true, disableWrite: params.disableWrite === true, disableShell: params.disableShell === true, sandboxNetwork: typeof params.sandboxNetwork === 'string' ? params.sandboxNetwork : POSTURE.sandboxNetwork, contributorMode: params.contributorMode } };
    if (method === 'listSessions') return { sessions: globalThis.sessionRows ?? [], nextCursor: null };
    if (method === 'listModels') { await globalThis.modelsGate?.promise; return { models: globalThis.modelRows ?? [] }; }
    if (method === 'startSession') return { sessionId: 'new-1' };
    return {};
  };
  const module = await bundle('apps/desktop/src/lib/store.ts', replacements);
  module.bindBridgeEvents();
  return { store: module.useAppStore, calls };
}
const count = (calls, method) => calls.filter(([name]) => name === method).length;

test('the window is ready and the last workspace selected before agent detection finishes', async () => {
  globalThis.detectGate = deferred();
  globalThis.sessionRows = [session('s1')];
  const { store, calls } = await bootedStore({ selectedWorkspaceId: 'w', selectedSessionId: 's1' });
  const hydration = store.getState().hydrate();
  await until(() => store.getState().ready, 'ready');
  // Detection has not answered, yet the UI is up with its selection restored.
  assert.equal(store.getState().detectionChecked, false);
  assert.equal(store.getState().booting, true);
  assert.equal(store.getState().restoringSession, 's1', 'the thread pane knows which session is coming back');
  assert.equal(store.getState().selectedWorkspaceId, 'w');
  assert.deepEqual(store.getState().threads, [], 'no thread list until agents are known');
  assert.equal(count(calls, 'listSessions'), 0, 'nothing is listed against an undetected agent set');
  globalThis.detectGate.resolve();
  await hydration;
  const state = store.getState();
  assert.equal(state.booting, false);
  assert.equal(state.restoringSession, null);
  assert.equal(state.detectionChecked, true);
  assert.deepEqual(state.threads.map((thread) => thread.sessionId), ['s1']);
  assert.equal(state.selectedSessionId, 's1', 'the previously open thread is reopened once it can be');
  globalThis.detectGate = undefined;
});

test('a user who navigates during boot is not pulled back to the old thread', async () => {
  globalThis.detectGate = deferred();
  globalThis.sessionRows = [session('s1'), session('s2', '/other')];
  const { store } = await bootedStore({
    workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }, { id: 'w2', path: '/other', name: 'other', grantId: 'g2' }],
    selectedWorkspaceId: 'w', selectedSessionId: 's1',
  });
  const hydration = store.getState().hydrate();
  await until(() => store.getState().ready, 'ready');
  const picking = store.getState().selectWorkspace('w2');
  globalThis.detectGate.resolve();
  await Promise.all([hydration, picking]);
  assert.equal(store.getState().selectedWorkspaceId, 'w2', 'the user\'s choice stands');
  assert.equal(store.getState().selectedSessionId, null, 'the old thread was not reopened over it');
  assert.equal(store.getState().booting, false);
  globalThis.detectGate = undefined;
});

test('a workspace expanded before detection settles still lists its threads afterwards', async () => {
  globalThis.detectGate = deferred();
  globalThis.sessionRows = [session('a'), session('b')];
  const { store, calls } = await bootedStore();
  store.setState({ workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false });
  const detecting = store.getState().refreshDetection();
  const listing = store.getState().loadWorkspaceThreads('w');
  await settle();
  assert.deepEqual(store.getState().threadsLoading, ['w'], 'the sidebar shows loading from the first moment');
  assert.equal(count(calls, 'listSessions'), 0);
  globalThis.detectGate.resolve();
  await Promise.all([detecting, listing]);
  assert.deepEqual(store.getState().threads.map((thread) => thread.sessionId), ['a', 'b']);
  assert.deepEqual(store.getState().threadsLoading, [], 'the loading marker is cleared');
  globalThis.detectGate = undefined;
});

test('overlapping listings of one workspace clear their loading markers one at a time', async () => {
  globalThis.detectGate = deferred();
  globalThis.sessionRows = [session('a')];
  const { store } = await bootedStore();
  store.setState({ workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false });
  const detecting = store.getState().refreshDetection();
  const first = store.getState().loadWorkspaceThreads('w');
  const second = store.getState().loadWorkspaceThreads('w');
  await settle();
  assert.deepEqual(store.getState().threadsLoading, ['w', 'w']);
  globalThis.detectGate.resolve();
  await Promise.all([detecting, first, second]);
  assert.deepEqual(store.getState().threadsLoading, []);
  globalThis.detectGate = undefined;
});

test('starting a thread waits for detection so it picks an agent that exists', async () => {
  globalThis.detectGate = deferred();
  const { store, calls } = await bootedStore();
  store.setState({ workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false });
  const detecting = store.getState().refreshDetection();
  const starting = store.getState().createThread();
  await settle();
  assert.equal(count(calls, 'startSession'), 0, 'no session is started against an unknown agent set');
  globalThis.detectGate.resolve();
  await Promise.all([detecting, starting]);
  assert.equal(count(calls, 'startSession'), 1);
  assert.equal(store.getState().selectedSessionId, 'new-1');
  globalThis.detectGate = undefined;
});

test('switching workspace while the first message waits on detection is not overwritten', async () => {
  globalThis.detectGate = deferred();
  const { store, calls } = await bootedStore();
  store.setState({
    workspaces: [
      { id: 'w', path: '/repo', name: 'repo', grantId: 'g1' },
      { id: 'other', path: '/other', name: 'other', grantId: 'g2' },
    ],
    selectedWorkspaceId: 'w',
    preview: false,
  });
  const detecting = store.getState().refreshDetection();
  const starting = store.getState().createThread();
  await settle();
  const switching = store.getState().selectWorkspace('other');
  await settle();
  globalThis.detectGate.resolve();
  await Promise.all([detecting, starting, switching]);
  assert.equal(store.getState().selectedWorkspaceId, 'other');
  assert.equal(store.getState().selectedSessionId, null);
  assert.equal(count(calls, 'startSession'), 0, 'no session is created in the folder the user left');
  globalThis.detectGate = undefined;
});

// "New thread" used to start a CLI session on click, so opening one and
// changing your mind left an empty "New thread" row and a live session behind.
test('a new thread is only a draft until the first send starts its session', async () => {
  const { store, calls } = await bootedStore();
  const opened = { sessionId: 's1', workspacePath: '/repo', title: 'Earlier', updatedAt: '2026-09-29T00:00:00.000Z', status: 'idle', unread: false, items: [], opened: true };
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }], selectedWorkspaceId: 'w', selectedSessionId: 's1', preview: false,
    detection: detected, agents: [MUSE], detectionChecked: true, threads: [opened],
    drafts: { 'project:w': { text: 'left over', images: [], config: { agentId: 'opencode' } } },
  });
  const focus = store.getState().composerFocus;
  await store.getState().newThread();
  let state = store.getState();
  assert.equal(count(calls, 'startSession'), 0, 'no session for a thread nobody has written in');
  assert.equal(state.selectedSessionId, null, 'the workspace draft is the new thread');
  assert.equal(state.threads.length, 1, 'and no sidebar row appears for it');
  assert.equal(state.composer, 'left over', 'the workspace draft text comes back');
  assert.equal(state.drafts['project:w'].config, undefined, 'a new thread starts from the defaults, not an old draft\'s agent');
  assert.equal(state.composerFocus, focus + 1, 'the composer is asked for focus');
  store.setState({ composer: 'Fix the login bug' });
  await store.getState().sendPrompt();
  state = store.getState();
  assert.equal(count(calls, 'startSession'), 1, 'the first send starts the session');
  assert.equal(state.selectedSessionId, 'new-1');
  assert.ok(state.threads.some((thread) => thread.sessionId === 'new-1'));
});

for (const { explicit, draftAgent } of [{ explicit: false, draftAgent: 'harness' }, { explicit: true, draftAgent: 'harness' }, { explicit: false, draftAgent: 'opencode' }]) {
  test(`a manual draft model overrides ${explicit ? 'explicit' : 'inherited'} Orchestrator on the first send from ${draftAgent}`, async () => {
    const { store, calls } = await bootedStore();
    const model = { modelId: 'anthropic/claude-haiku', providerId: 'anthropic', reasoningEfforts: ['low', 'high'] };
    const orchestrator = { goal: 'balanced', models: { lead: { modelId: 'anthropic/claude-opus' }, builder: model } };
    globalThis.modelRows = [model];
    try {
      store.setState({
        workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false,
        agents: [{ ...MUSE, id: 'harness', protocol: 'native' }], enabledAgents: { harness: true, opencode: false }, defaultAgentId: 'harness', detectionChecked: true,
        defaultEffort: 'high', modelsAgentId: 'harness', models: [model],
        orchestratorEnabled: true, orchestratorModels: orchestrator.models,
        drafts: { 'project:w': { text: '', images: [], config: { agentId: draftAgent, effort: 'high', ...(explicit ? { orchestrator } : {}) } } },
      });
      await store.getState().setSessionConfig({ approvalMode: 'auto' });
      assert.deepEqual(store.getState().drafts['project:w'].config.orchestrator, explicit ? orchestrator : undefined);
      await store.getState().setSessionConfig({ modelId: model.modelId, providerId: model.providerId });
      await settle();
      assert.equal(store.getState().drafts['project:w'].config.orchestrator, null);
      assert.equal(store.getState().orchestratorEnabled, true);
      assert.equal(count(calls, 'startSession'), 0);
      store.setState({ composer: 'Explain this function' });
      assert.equal(await store.getState().sendPrompt(), true);
      const starts = calls.filter(([method]) => method === 'startSession');
      assert.equal(starts.length, 1);
      assert.equal(starts[0][1].modelId, model.modelId);
      assert.equal(starts[0][1].reasoningEffort, 'high');
      assert.equal(starts[0][1].approvalMode, 'auto');
      assert.equal(Object.hasOwn(starts[0][1], 'orchestrator'), false);
    } finally {
      await settle();
      globalThis.modelRows = undefined;
    }
  });
}

test('a draft goal change keeps Orchestrator enabled without changing its manual model', async () => {
  const { store } = await bootedStore();
  const orchestrator = { goal: 'cost', models: { lead: { modelId: 'anthropic/claude-opus' }, builder: { modelId: 'anthropic/claude-haiku' } } };
  store.setState({ selectedWorkspaceId: 'w', defaultAgentId: 'harness', enabledAgents: { harness: true }, drafts: { 'project:w': { text: '', images: [], config: { agentId: 'harness', modelId: 'anthropic/claude-sonnet', orchestrator } } } });
  await store.getState().setSessionConfig({ orchestrator: { ...orchestrator, goal: 'output' } });
  const config = store.getState().drafts['project:w'].config;
  assert.deepEqual(config.orchestrator, { ...orchestrator, goal: 'output' });
  assert.equal(config.modelId, 'anthropic/claude-sonnet');
});

test('an image-only first send carries its images into the pending card', async () => {
  const { store } = await bootedStore();
  const image = { mediaType: 'image/png', base64Data: 'AA==', name: 'shot.png' };
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false,
    detection: detected, agents: [MUSE], detectionChecked: true, threads: [], selectedSessionId: null,
    images: [image],
  });
  const sending = store.getState().sendPrompt();
  const pending = store.getState().pendingSend;
  assert.equal(pending?.text, '', 'an image-only send has no text to show');
  assert.deepEqual(pending?.images, [image], 'the pending card shows what was sent, not an empty bubble');
  assert.equal(store.getState().composer, '');
  assert.equal(store.getState().images.length, 0, 'the composer gives up the images to the pending card');
  await sending;
  assert.equal(store.getState().pendingSend, null);
});

test('startHost asks the bridge once, then trusts a host that already matches', async () => {
  globalThis.modelRows = [{ modelId: 'muse-spark', providerId: 'meta' }];
  const { store, calls } = await bootedStore();
  store.setState({ workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false });
  await store.getState().startHost(true);
  assert.equal(count(calls, 'startHost'), 1);
  const statusCalls = count(calls, 'status');
  const modelCalls = count(calls, 'listModels');
  await store.getState().startHost();
  await store.getState().startHost();
  assert.equal(count(calls, 'status'), statusCalls, 'no status round trip for a host the renderer knows is running');
  assert.equal(count(calls, 'startHost'), 1, 'and no restart');
  assert.equal(count(calls, 'listModels'), modelCalls, 'the catalog is not refetched when nothing moved');
  // A changed posture is not "already matching": the host must be told.
  store.setState({ disableShell: true });
  await store.getState().startHost();
  assert.equal(count(calls, 'startHost'), 2, 'a posture change still restarts the host');
  // After the host dies the renderer no longer trusts what it held.
  globalThis.storeEvent('hostExit', { kind: 'crash' });
  assert.equal(store.getState().hostInfo, null);
  await store.getState().startHost();
  assert.ok(count(calls, 'status') > statusCalls, 'a host that exited is checked again');
  globalThis.modelRows = undefined;
});

test('a shared host start revalidates trust for every waiter', async () => {
  const { store, calls } = await bootedStore();
  store.setState({
    workspaces: [
      { id: 'trusted', path: '/trusted', name: 'trusted', grantId: 'gt', trusted: true },
      { id: 'untrusted', path: '/untrusted', name: 'untrusted', grantId: 'gu', trusted: false },
    ],
    selectedWorkspaceId: 'trusted', preview: false, hostInfo: null, hostTrust: null,
  });
  const gate = deferred();
  let running = false;
  let hostTrust = false;
  globalThis.storeBridge = async (method, params) => {
    calls.push([method, params]);
    if (method === 'status') return { running, trustWorkspace: hostTrust, posture: POSTURE };
    if (method === 'startHost') {
      if (!running) await gate.promise;
      running = true;
      hostTrust = params.trustWorkspace === true;
      return { trustWorkspace: hostTrust, posture: POSTURE };
    }
    if (method === 'listModels') return { models: [] };
    return {};
  };
  const first = store.getState().startHost();
  await settle();
  store.setState({ selectedWorkspaceId: 'untrusted' });
  const second = store.getState().startHost();
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(calls.filter(([method]) => method === 'startHost').map(([, params]) => params.trustWorkspace), [true, false], 'the untrusted waiter cannot use the trusted host');
  assert.equal(store.getState().hostTrust, false);
});

test('concurrent model refreshes share one listing and never blank a picker that already has models', async () => {
  globalThis.modelsGate = deferred();
  globalThis.modelRows = [{ modelId: 'next', providerId: 'meta' }];
  const { store, calls } = await bootedStore();
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false,
    models: [{ modelId: 'shown', providerId: 'meta' }], modelsAgentId: 'muse',
  });
  const first = store.getState().refreshModels();
  const second = store.getState().refreshModels();
  await settle();
  assert.equal(count(calls, 'listModels'), 1, 'two callers, one round trip');
  assert.equal(store.getState().modelsLoading, false, 'models already on screen stay usable while refreshing');
  assert.deepEqual(store.getState().models.map((model) => model.modelId), ['shown']);
  globalThis.modelsGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(store.getState().models.map((model) => model.modelId), ['next']);
  assert.equal(store.getState().modelsLoading, false);
  globalThis.modelsGate = undefined;
  globalThis.modelRows = undefined;
});

test('a model listing that lands late cannot replace a newer catalog in the cache', async () => {
  const { store, calls } = await bootedStore();
  const thread = (sessionId) => ({ sessionId, agentId: 'grok', workspacePath: '/repo', status: 'idle', opened: true, unread: false, items: [], config: { agentId: 'grok' } });
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false,
    threads: [thread('s1'), thread('s2')], selectedSessionId: 's1', models: [], modelsAgentId: 'grok',
  });
  const gates = new Map();
  const previous = globalThis.storeBridge;
  globalThis.storeBridge = async (method, params) => {
    if (method !== 'listModels' || params.agentId !== 'grok') return previous(method, params);
    calls.push([method, params]);
    const gate = deferred();
    gates.set(params.sessionId, gate);
    await gate.promise;
    return { models: [{ modelId: params.sessionId === 's1' ? 'old' : 'new', providerId: 'grok' }] };
  };
  try {
    const first = store.getState().refreshModels();
    store.setState({ selectedSessionId: 's2' });
    const second = store.getState().refreshModels();
    await settle();
    assert.deepEqual([...gates.keys()], ['s1', 's2'], 'one listing per session, both in flight');
    gates.get('s2').resolve();
    await second;
    assert.deepEqual(store.getState().models.map((model) => model.modelId), ['new']);
    gates.get('s1').resolve();
    await first;
    assert.deepEqual(store.getState().models.map((model) => model.modelId), ['new'], 'the late answer never reaches the picker');
    // Leave the agent and come back: the cache feeds the picker while the fresh listing loads.
    store.setState({ selectedSessionId: null });
    await store.getState().refreshModels();
    assert.equal(store.getState().modelsAgentId, 'muse');
    store.setState({ selectedSessionId: 's1' });
    const back = store.getState().refreshModels();
    await settle();
    assert.deepEqual(store.getState().models.map((model) => model.modelId), ['new'], 'the cache kept the newer catalog, not the late one');
    gates.get('s1').resolve();
    await back;
  } finally { globalThis.storeBridge = previous; }
});

test('an explicit catalog refresh reaches the agent and a failed refresh preserves usable models', async () => {
  const { store, calls } = await bootedStore();
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false,
    selectedSessionId: 'grok-1', threads: [{ sessionId: 'grok-1', agentId: 'grok', workspacePath: '/repo', status: 'idle', opened: true, items: [] }],
    modelsAgentId: 'grok', models: [{ modelId: 'grok-4.7', providerId: 'grok' }],
  });
  const previous = globalThis.storeBridge;
  globalThis.storeBridge = async (method, params) => {
    if (method === 'listModels') { calls.push([method, params]); throw new Error('Authentication required'); }
    return previous(method, params);
  };
  try {
    await store.getState().refreshModels(true);
    const request = calls.find(([method]) => method === 'listModels')[1];
    assert.equal(request.agentId, 'grok');
    assert.equal(request.refresh, true);
    assert.deepEqual(store.getState().models.map((model) => model.modelId), ['grok-4.7']);
    assert.match(store.getState().modelsError, /Authentication required/);
    assert.equal(store.getState().modelsLoading, false);
  } finally { globalThis.storeBridge = previous; }
});

test('Muse loads the global model catalog while ACP catalogs remain session-scoped', async () => {
  globalThis.modelRows = [{ modelId: 'muse-spark-1.3', providerId: 'meta' }];
  const { store, calls } = await bootedStore();
  const base = { sessionId: 's1', workspacePath: '/repo', title: 'Thread', updatedAt: new Date().toISOString(), status: 'idle', unread: false, items: [], opened: true };
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false,
    threads: [base], selectedSessionId: 's1', models: [], modelsAgentId: null,
  });
  await store.getState().refreshModels();
  const muse = calls.filter(([method]) => method === 'listModels').at(-1)[1];
  assert.equal(muse.agentId, 'muse');
  assert.equal(muse.sessionId, undefined);

  store.setState({ threads: [{ ...base, agentId: 'grok', config: { agentId: 'grok' } }], models: [], modelsAgentId: null });
  await store.getState().refreshModels();
  const acp = calls.filter(([method]) => method === 'listModels').at(-1)[1];
  assert.equal(acp.agentId, 'grok');
  assert.equal(acp.sessionId, 's1');
  globalThis.modelRows = undefined;
});

test('Settings can query the fresh global defaults catalog without replacing a conversation catalog', async () => {
  globalThis.modelRows = [{ modelId: 'muse-wonder-1.0', providerId: 'meta' }];
  const { store, calls } = await bootedStore();
  const grok = [{ modelId: 'grok-4.7', providerId: 'grok' }];
  store.setState({ preview: false, modelsAgentId: 'grok', models: grok, selectedSessionId: 's1', threads: [{ sessionId: 's1', agentId: 'grok' }] });
  try {
    const rows = await store.getState().loadModelCatalog('muse');
    assert.deepEqual(rows, globalThis.modelRows);
    const params = calls.find(([method]) => method === 'listModels')[1];
    assert.equal(params.agentId, 'muse');
    assert.equal(params.sessionId, undefined);
    assert.equal(params.refresh, true);
    assert.equal(store.getState().models, grok);
    assert.equal(store.getState().modelsAgentId, 'grok');
  } finally { globalThis.modelRows = undefined; }
});

test('with nothing to show yet, the first model refresh does report loading', async () => {
  globalThis.modelsGate = deferred();
  globalThis.modelRows = [{ modelId: 'first', providerId: 'meta' }];
  const { store } = await bootedStore();
  store.setState({ workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false });
  const refreshing = store.getState().refreshModels();
  await settle();
  assert.equal(store.getState().modelsLoading, true);
  globalThis.modelsGate.resolve();
  await refreshing;
  assert.equal(store.getState().modelsLoading, false);
  assert.equal(store.getState().models.length, 1);
  globalThis.modelsGate = undefined;
  globalThis.modelRows = undefined;
});

test('detection failure still settles the app: it is shown, and reports the failure', async () => {
  const { store } = await bootedStore({ selectedWorkspaceId: 'w' });
  globalThis.storeBridge = async (method) => { if (method === 'detect') throw new Error('sidecar missing'); return {}; };
  await store.getState().hydrate();
  const state = store.getState();
  assert.equal(state.ready, true);
  assert.equal(state.booting, false);
  assert.equal(state.detectionChecked, true, 'a failed check is still a finished check');
  assert.match(state.error, /Startup failed: sidecar missing/);
});
