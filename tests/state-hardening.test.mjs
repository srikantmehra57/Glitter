import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Regression tests for concurrency and optimistic-update defects found in the
// production audit (AUD): stale read resurrecting pre-mutation git state,
// double-submit on a non-idempotent fork, and a failed busy-send leaving an
// unsent message in the transcript.
const temporary = await mkdtemp(join(tmpdir(), 'muse-state-hardening-'));
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
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const storeReplacements = {
  // The atomic saver reads the whole document back through `entries()`, and the
  // plugin's own `save()` is the truncate-and-write we must never fall back to.
  '@tauri-apps/plugin-store': `export class LazyStore { async entries(){ return Object.entries(globalThis.persistedData ?? {}); } async get(key){ return globalThis.persistedData?.[key]; } async set(key, value){ globalThis.persistedData = { ...globalThis.persistedData, [key]: value }; } async save(){ throw new Error('the non-atomic plugin writer must not be used'); } }`,
  './bridge': `export const credentialGet=async()=>globalThis.testInvoke ? globalThis.testInvoke('credential_get') : null;
    export const credentialSet=async(value)=>{ if (globalThis.testInvoke) return globalThis.testInvoke('credential_set',{value}); };
    export const acpConsentGet=async()=>globalThis.testInvoke ? globalThis.testInvoke('acp_isolation_consent_get') : false;
    export const acpConsentSet=async(consented)=>{ if (globalThis.testInvoke) return globalThis.testInvoke('acp_isolation_consent_set',{consented}); };
    export const openLogFolder=async()=>globalThis.testInvoke ? globalThis.testInvoke('open_log_folder') : '/preview/logs/app.log';
    export const persistStoreDocument=async(...args)=>globalThis.persistStoreDocument?.(...args);
    export const repairStoreDocument=async()=>globalThis.storeRepair ?? {status:'ok'};
    export const bridge=(...args)=>globalThis.storeBridge(...args);
    export const gitReview=async(...args)=>globalThis.readReview?.(...args) ?? {files:[],diff:"",truncated:false};
    export const gitSnapshot=(grantId)=>globalThis.readGit(grantId);
    export const verifyGrants=async()=>[];export const removeGrant=async()=>{};
    export const onBridgeEvent=(handler)=>{globalThis.storeEvent=handler;return ()=>{}};
    export const onWindowCloseRequested=(handler)=>{globalThis.closeRequested=handler;return ()=>{if(globalThis.closeRequested===handler)globalThis.closeRequested=undefined}};
    export const pickFolder=async()=>null;export const mockThreads=()=>[];
    export const readDroppedPaths=async()=>globalThis.droppedPaths ?? [];
    export const agentIdentities=async()=>[];export const confirmAgentBin=async()=>{throw new Error('preview')};
    export const gitDiscardFiles=async(...args)=>{globalThis.discardCalls.push(args);return globalThis.mutationGit;};
    export const gitDiscardAll=async()=>globalThis.mutationGit;
    export const gitDiscardHunk=async()=>globalThis.mutationGit;
    export const gitStage=async()=>globalThis.mutationGit;
    export const gitCommit=async()=>globalThis.mutationGit;
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
    export const gitInit=async(...args)=>{globalThis.initCalls.push(args);if(globalThis.initError)throw globalThis.initError;return globalThis.initResult ?? globalThis.mutationGit;};
    export const trustPreview=async()=>({ skills: [], rules: null });
    export const listWorkspaceFiles=async()=>[];
    export const cliLogout=async()=>{};
    export const pluginList=async()=>[];export const skillList=async()=>[];
    export const projectInit=async()=>({});
    export const enterpriseStatus=async()=>({ generation: null, sources: [] });
    export const pickPluginBundle=async()=>null;export const pluginInstall=async()=>{};
    export const pickSkillSource=async()=>null;export const skillInstall=async()=>'installed';
    export const skillImport=async()=>'done';export const skillUninstall=async()=>'removed';`,
};

async function frontendStore(tauri = true, extra = {}) {
  // A tiny event target so teardown listeners (pagehide/beforeunload) can be
  // exercised; nothing dispatches them unless a test does.
  const windowListeners = {};
  globalThis.window = {
    setTimeout, clearTimeout, matchMedia: () => ({ matches: false }),
    addEventListener: (name, handler) => { (windowListeners[name] ??= []).push(handler); },
    removeEventListener: (name, handler) => { windowListeners[name] = (windowListeners[name] ?? []).filter((item) => item !== handler); },
    dispatch: (name) => { for (const handler of windowListeners[name] ?? []) handler({ type: name }); },
    ...(tauri ? { __TAURI_INTERNALS__: {} } : {}),
  };
  const documentListeners = {};
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty(name, value) { this[name] = value; } } },
    visibilityState: 'visible',
    addEventListener: (name, handler) => { (documentListeners[name] ??= []).push(handler); },
    removeEventListener: (name, handler) => { documentListeners[name] = (documentListeners[name] ?? []).filter((item) => item !== handler); },
    dispatch: (name) => { for (const handler of documentListeners[name] ?? []) handler({ type: name }); },
  };
  globalThis.storeBridge = async () => ({});
  globalThis.discardCalls = [];
  const module = await bundle('apps/desktop/src/lib/store.ts', { ...storeReplacements, ...extra });
  module.bindBridgeEvents();
  return module.useAppStore;
}

const git = (files) => ({ branch: 'main', dirty: files.length > 0, files: files.map((path) => ({ path, status: 'M', added: 1, removed: 0 })), diff: '', truncated: false });
/**
 * `scheduleMemory` debounces local persistence at 200ms and returns nothing to
 * await, so a save is observable only after that window. Waiting out a fixed,
 * documented debounce is deterministic; polling or racing would not be.
 */
const flushMemorySave = () => new Promise((resolve) => setTimeout(resolve, 320));

const workspace = (store) => store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false });

const checkpoint = (state = 'ready') => ({ snapshotId: 'snap-1', sessionId: 's1', turnId: 't1', state, files: ['a.txt', 'b.txt'], reason: null, createdAt: 1 });
async function snapshotStore() {
  const store = await frontendStore();
  workspace(store);
  store.setState({ selectedSessionId: 's1', composer: 'Keep my draft', threads: [{ sessionId: 's1', workspacePath: '/repo', title: 'Edits', status: 'idle', opened: true, items: [], snapshots: { t1: checkpoint() } }] });
  globalThis.readGit = () => git([]);
  return store;
}

test('scope changes supersede older review results without replacing Changes data', async () => {
  const store = await snapshotStore(); const older = deferred(); const newer = deferred(); const calls = [];
  const currentGit = git(['all.txt']); store.setState({ git: currentGit });
  globalThis.readReview = (grant, request) => { calls.push({ grant, request }); return request.scope === 'staged' ? older.promise : newer.promise; };
  store.getState().setReviewScope('staged'); const first = store.getState().refreshReview();
  store.getState().setReviewScope('unstaged'); const second = store.getState().refreshReview();
  newer.resolve({ files: [{ path: 'working.txt' }], diff: 'working patch' }); await second;
  older.resolve({ files: [{ path: 'index.txt' }], diff: 'index patch' }); await first;
  assert.deepEqual(calls, [{ grant: 'g1', request: { scope: 'staged' } }, { grant: 'g1', request: { scope: 'unstaged' } }]);
  assert.equal(store.getState().review.data.diff, 'working patch'); assert.equal(store.getState().git, currentGit);
  assert.equal(store.getState().reviewLoading, null);
});

test('a new branch base supersedes a pending comparison and clears the old file tabs', async () => {
  const store = await snapshotStore(); const waiting = deferred(); const calls = [];
  globalThis.readReview = (grant, request) => { calls.push(request); return request.base === 'main' ? waiting.promise : { files: [], diff: 'new base' }; };
  store.setState({ diffTabs: ['old.txt'], diffActive: 'old.txt' });
  store.getState().setReviewScope('branch'); await store.getState().refreshReview();
  assert.equal(calls.length, 0, 'empty base is a chooser state, never a guessed reference');
  store.getState().setReviewBase('main'); const first = store.getState().refreshReview();
  store.getState().setReviewBase('other'); await store.getState().refreshReview();
  waiting.resolve({ files: [], diff: 'old base' }); await first;
  assert.equal(store.getState().review.data.diff, 'new base'); assert.equal(store.getState().diffTabs, null); assert.equal(store.getState().diffActive, null);
});

test('review reads are fenced by navigation, grant replacement and scope selection hops', async () => {
  for (const change of [
    (store) => store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g2' }] }),
    (store) => store.setState({ selectedSessionId: 'other' }),
    (store) => { store.getState().setReviewScope('unstaged'); store.getState().setReviewScope('staged'); },
  ]) {
    const store = await snapshotStore(); const waiting = deferred();
    globalThis.readReview = () => waiting.promise;
    store.getState().setReviewScope('staged'); const reading = store.getState().refreshReview();
    change(store); waiting.resolve({ files: [], diff: 'stale' }); await reading;
    assert.equal(store.getState().review, null); assert.equal(store.getState().reviewLoading, null);
  }
});

test('a Git mutation invalidates a pending scope read and the next read sees the updated index', async () => {
  const store = await snapshotStore(); const waiting = deferred();
  globalThis.readReview = () => waiting.promise; globalThis.mutationGit = git(['a.txt']);
  store.getState().setReviewScope('staged'); const reading = store.getState().refreshReview();
  await store.getState().stageGitFiles(['a.txt'], true);
  waiting.resolve({ files: [], diff: 'stale index' }); await reading;
  assert.equal(store.getState().review, null);
  globalThis.readReview = async () => ({ files: [], diff: 'fresh index' });
  await store.getState().refreshReview(); assert.equal(store.getState().review.data.diff, 'fresh index');
});

test('Last turn review takes the owning session and opaque snapshot id, and missing states never fall back', async () => {
  const store = await snapshotStore(); const calls = [];
  store.setState({ threads: store.getState().threads.map((thread) => ({ ...thread, lastTurnId: 't1' })) });
  globalThis.readReview = async (grant, request) => { calls.push({ grant, request }); return { files: [], diff: 'saved patch' }; };
  store.getState().setReviewScope('lastTurn'); await store.getState().refreshReview();
  assert.deepEqual(calls, [{ grant: 'g1', request: { scope: 'lastTurn', sessionId: 's1', snapshotId: 'snap-1' } }]);
  store.setState({ threads: store.getState().threads.map((thread) => ({ ...thread, lastTurnId: 'missing' })) });
  await store.getState().refreshReview(); assert.equal(calls.length, 1); assert.equal(store.getState().review, null);
});

test('failed scope reads retain no stale patch and retry stays within the chosen scope', async () => {
  const store = await snapshotStore(); store.getState().setReviewScope('staged');
  globalThis.readReview = async () => { throw new Error('index unreadable'); };
  await store.getState().refreshReview(); assert.equal(store.getState().review, null);
  assert.match(store.getState().reviewError.message, /index unreadable/);
  globalThis.readReview = async () => ({ files: [], diff: 'retry patch' });
  await store.getState().refreshReview(); assert.equal(store.getState().review.data.diff, 'retry patch'); assert.equal(store.getState().reviewError, null);
  store.getState().openFileDiff('all.txt');
  assert.equal(store.getState().reviewScope, 'all', 'opening a path from Changes resets to its combined diff');
});

async function rewindStore(patch = {}) {
  const store = await frontendStore(); workspace(store);
  const images = [{ name: 'screen.png', mediaType: 'image/png', base64Data: 'aW1hZ2U=' }];
  const refs = [{ id: 'ref-1', kind: 'file', path: 'src/a.ts' }];
  const items = [
    { itemId: 'u1', kind: 'userMessage', status: 'completed', turnId: 't1', text: 'First prompt' },
    { itemId: 'a1', kind: 'agentMessage', status: 'completed', turnId: 't1', text: 'First reply' },
    { itemId: 'u2', kind: 'userMessage', status: 'completed', turnId: 't2', text: 'Second prompt', images, refs },
    { itemId: 'a2', kind: 'agentMessage', status: 'completed', turnId: 't2', text: 'Second reply' },
    { itemId: 'u3', kind: 'userMessage', status: 'completed', turnId: 't3', text: 'Later prompt' },
    { itemId: 'a3', kind: 'agentMessage', status: 'completed', turnId: 't3', text: 'Later reply' },
  ];
  const snapshot = { ...checkpoint(), turnId: 't2' };
  store.setState({ selectedSessionId: 's1', composer: 'Keep my draft', images: [], contextRefs: [], threads: [{ sessionId: 's1', workspacePath: '/repo', title: 'Source', status: 'idle', opened: true, historyExhausted: true, items, snapshots: { t2: snapshot }, config: { modelId: 'model-1', providerId: 'provider-1', approvalMode: 'ask', effort: 'medium' }, ...patch }] });
  const calls = [];
  globalThis.readGit = () => git([]);
  globalThis.listSnapshots = async () => [];
  const response = { sessionId: 'fork-1', items: items.slice(0, 2), historyExhausted: true, forkedFrom: { cutExplicit: true } };
  globalThis.storeBridge = async (method, params) => {
    calls.push({ method, params });
    if (method === 'forkSession') {
      for (const item of response.items) globalThis.storeEvent('item', { sessionId: response.sessionId, item });
      return response;
    }
    if (method === 'startSession') return { sessionId: 'fresh-1' };
    if (method === 'resumeSession') return { alreadyOpen: true };
    if (method === 'sendTurn') return { turnId: 'edited-turn' };
    if (method === 'listModels') return { models: [] };
    return {};
  };
  return { store, calls, items, images, refs, snapshot, response };
}

test('editing message N forks through N-1, hydrates early history, and sends attachments in the fork', async () => {
  const { store, calls, items, images, refs } = await rewindStore();
  assert.equal(await store.getState().rewindMessage('s1', 'u2', '  Revised prompt  '), true);
  const forkRequest = calls.find((call) => call.method === 'forkSession').params;
  assert.equal(forkRequest.sessionId, 's1'); assert.equal(forkRequest.lastTurnId, 't1');
  assert.ok(forkRequest.clientRequestId);
  const send = calls.find((call) => call.method === 'sendTurn').params;
  assert.equal(send.sessionId, 'fork-1'); assert.equal(send.text, '@src/a.ts\n\nRevised prompt');
  assert.deepEqual(send.images, [{ mediaType: 'image/png', base64Data: 'aW1hZ2U=' }]);
  const state = store.getState(); const source = state.threads.find((thread) => thread.sessionId === 's1');
  const fork = state.threads.find((thread) => thread.sessionId === 'fork-1');
  assert.equal(source.items, items, 'the source history is never edited');
  assert.deepEqual(fork.items.map((item) => item.text), ['First prompt', 'First reply', 'Revised prompt']);
  assert.deepEqual(fork.items[2].images, images); assert.deepEqual(fork.items[2].refs, refs);
  assert.deepEqual(fork.forkedFrom, { sessionId: 's1', title: 'Source', cutTurnId: 't1' });
  assert.equal(state.selectedSessionId, 'fork-1'); assert.equal(state.composer, '');
  assert.equal(state.drafts['thread:s1'].text, 'Keep my draft');
  assert.equal(source.rewindPending, undefined);
  assert.equal(source.rewindAttempt, undefined, 'a successful edit retires the create retry');
});

test('editing the first message creates an empty Muse session with explicit provenance', async () => {
  const { store, calls, items } = await rewindStore();
  assert.equal(await store.getState().rewindMessage('s1', 'u1', 'New opening'), true);
  assert.equal(calls.filter((call) => call.method === 'forkSession').length, 0);
  const start = calls.find((call) => call.method === 'startSession').params;
  assert.equal(start.grantId, 'g1'); assert.equal(start.modelId, 'model-1'); assert.equal(start.providerId, 'provider-1'); assert.equal(start.approvalMode, 'ask'); assert.ok(start.clientRequestId);
  const fork = store.getState().threads.find((thread) => thread.sessionId === 'fresh-1');
  assert.deepEqual(fork.items.map((item) => item.text), ['New opening']);
  assert.equal(fork.forkedFrom.firstMessage, true);
  assert.match(fork.notice.message, /no earlier messages/);
  assert.equal(store.getState().threads.find((thread) => thread.sessionId === 's1').items, items);
});

test('a partially streamed fork keeps canonical order and newer item contents', async () => {
  const { store, calls, response } = await rewindStore();
  globalThis.storeBridge = async (method, params) => {
    calls.push({ method, params });
    if (method === 'forkSession') {
      // The row is learned before the reply but only part of the history has
      // arrived. Treating the whole response as an older page reverses it.
      store.setState({ threads: [...store.getState().threads, { sessionId: 'fork-1', workspacePath: '/repo', title: 'Unnamed', status: 'idle', items: [{ ...response.items[0], text: 'Newer streamed text' }] }] });
      return response;
    }
    if (method === 'resumeSession') return { alreadyOpen: true };
    if (method === 'sendTurn') return { turnId: 'edited-turn' };
    return {};
  };
  assert.equal(await store.getState().rewindMessage('s1', 'u2', 'Edit'), true);
  const fork = store.getState().threads.find((thread) => thread.sessionId === 'fork-1');
  assert.deepEqual(fork.items.map((item) => item.text), ['Newer streamed text', 'First reply', 'Edit']);
  assert.equal(fork.title, 'Source (fork)');
  assert.equal(store.getState().threads.filter((thread) => thread.sessionId === 'fork-1').length, 1);
});

test('editing the source again starts a new fork instead of appending another revision to the used fork', async () => {
  const { store, calls, response } = await rewindStore();
  await store.getState().rewindMessage('s1', 'u2', 'Edit');
  await store.getState().selectThread('s1');
  response.sessionId = 'fork-2';
  await store.getState().rewindMessage('s1', 'u2', 'Edit');
  const requests = calls.filter((call) => call.method === 'forkSession');
  assert.equal(requests.length, 2); assert.notEqual(requests[0].params.clientRequestId, requests[1].params.clientRequestId);
  assert.deepEqual(store.getState().threads.find((thread) => thread.sessionId === 'fork-2').items.map((item) => item.text), ['First prompt', 'First reply', 'Edit']);
});

test('rewind refuses partial history, unconfirmed cuts, and ACP threads without sending', async () => {
  const { store, calls, response } = await rewindStore({ historyExhausted: false });
  assert.equal(await store.getState().rewindMessage('s1', 'u1', 'Edit'), false);
  assert.equal(calls.length, 0); assert.match(store.getState().threads[0].rewindError.message, /Load earlier messages/);
  response.forkedFrom.cutExplicit = false;
  assert.equal(await store.getState().rewindMessage('s1', 'u2', 'Edit'), false);
  assert.equal(calls.filter((call) => call.method === 'sendTurn').length, 0);
  assert.equal(store.getState().selectedSessionId, 's1'); assert.equal(store.getState().composer, 'Keep my draft');
  assert.equal(store.getState().drafts['thread:fork-1'].text, 'Edit');
  assert.match(store.getState().threads[0].rewindError.message, /did not confirm/);
  store.setState({ threads: store.getState().threads.map((thread) => ({ ...thread, agentId: 'opencode' })) });
  const count = calls.length;
  assert.equal(await store.getState().rewindMessage('s1', 'u2', 'Edit'), false); assert.equal(calls.length, count);
});

test('Reset files too cancellation creates no fork, sends nothing, and keeps drafts', async () => {
  const { store, calls, items } = await rewindStore();
  const editing = store.getState().rewindMessage('s1', 'u2', 'Edit', true);
  assert.match(store.getState().confirmDialog.body, /Only the edited turn/);
  assert.equal(await store.getState().rewindMessage('s1', 'u2', 'Edit', true), false, 'double-click is single-flight');
  await store.getState().sendPrompt(); assert.equal(calls.length, 0, 'composer cannot race rewind');
  store.getState().resolveConfirm(false); assert.equal(await editing, false);
  assert.equal(calls.length, 0); assert.equal(store.getState().composer, 'Keep my draft'); assert.equal(store.getState().threads[0].items, items);
  assert.equal(store.getState().threads[0].rewindPending, undefined);
});

test('Reset files too restores only the edited turn before sending in the fork', async () => {
  const { store, calls, snapshot } = await rewindStore();
  globalThis.restoreSnapshot = async (...args) => { calls.push({ method: 'reset', args }); return { snapshot: { ...snapshot, state: 'undone' }, conflicts: [] }; };
  const editing = store.getState().rewindMessage('s1', 'u2', 'Edit', true);
  store.getState().resolveConfirm(true); assert.equal(await editing, true);
  const reset = calls.find((call) => call.method === 'reset');
  assert.deepEqual(reset.args, ['g1', 's1', 'snap-1', false]);
  assert.ok(calls.indexOf(reset) > calls.findIndex((call) => call.method === 'forkSession'));
  assert.ok(calls.indexOf(reset) < calls.findIndex((call) => call.method === 'sendTurn'));
  const source = store.getState().threads.find((thread) => thread.sessionId === 's1');
  assert.equal(source.snapshots.t2.state, 'undone'); assert.equal(source.rewindAttempt, undefined);
});

test('a conflicting reset keeps the fork draft and retry reuses the same fork', async () => {
  const { store, calls, snapshot } = await rewindStore();
  globalThis.restoreSnapshot = async () => ({ snapshot, conflicts: ['a.txt'] });
  const editing = store.getState().rewindMessage('s1', 'u2', 'Edit', true);
  store.getState().resolveConfirm(true); assert.equal(await editing, false);
  assert.equal(store.getState().selectedSessionId, 's1'); assert.equal(store.getState().composer, 'Keep my draft');
  assert.equal(store.getState().drafts['thread:fork-1'].text, 'Edit');
  assert.match(store.getState().threads[0].rewindError.message, /Nothing was restored/);
  assert.equal(calls.filter((call) => call.method === 'sendTurn').length, 0);
  globalThis.restoreSnapshot = async () => ({ snapshot: { ...snapshot, state: 'undone' }, conflicts: [] });
  const retry = store.getState().rewindMessage('s1', 'u2', 'Edit', true);
  store.getState().resolveConfirm(true); assert.equal(await retry, true);
  assert.equal(calls.filter((call) => call.method === 'forkSession').length, 1);
  assert.equal(calls.filter((call) => call.method === 'sendTurn').length, 1);
});

test('navigation during fork creation leaves a draft and prevents reset or send', async () => {
  const { store, calls, response } = await rewindStore();
  const waiting = deferred();
  globalThis.storeBridge = async (method, params) => { calls.push({ method, params }); return method === 'forkSession' ? waiting.promise : {}; };
  let resets = 0; globalThis.restoreSnapshot = async () => { resets += 1; };
  const editing = store.getState().rewindMessage('s1', 'u2', 'Edit', true);
  store.getState().resolveConfirm(true); await new Promise(setImmediate);
  store.setState({ threads: [...store.getState().threads, { sessionId: 'other', workspacePath: '/repo', status: 'idle', opened: true, items: [] }], drafts: { 'thread:other': { text: 'Other draft', images: [] } } });
  await store.getState().selectThread('other');
  waiting.resolve(response); assert.equal(await editing, false);
  assert.equal(store.getState().selectedSessionId, 'other'); assert.equal(store.getState().composer, 'Other draft');
  assert.equal(store.getState().drafts['thread:fork-1'].text, 'Edit'); assert.equal(resets, 0);
  assert.equal(calls.filter((call) => call.method === 'sendTurn').length, 0);
});

test('a failed fork retries the same create key and a failed send retains the fork draft', async () => {
  const { store, calls, response } = await rewindStore();
  let first = true;
  globalThis.storeBridge = async (method, params) => {
    calls.push({ method, params });
    if (method === 'forkSession') { if (first) { first = false; throw new Error('lost acknowledgement'); } return response; }
    if (method === 'resumeSession') return { alreadyOpen: true };
    if (method === 'sendTurn') throw new Error('model unavailable');
    return {};
  };
  assert.equal(await store.getState().rewindMessage('s1', 'u2', 'Edit'), false);
  assert.equal(store.getState().composer, 'Keep my draft');
  assert.equal(await store.getState().rewindMessage('s1', 'u2', 'Edit'), true);
  const requests = calls.filter((call) => call.method === 'forkSession');
  assert.equal(requests[0].params.clientRequestId, requests[1].params.clientRequestId);
  assert.equal(store.getState().selectedSessionId, 'fork-1'); assert.equal(store.getState().composer, 'Edit');
  assert.equal(store.getState().drafts['thread:s1'].text, 'Keep my draft');
  assert.match(store.getState().threads.find((thread) => thread.sessionId === 'fork-1').error, /Send failed/);
});

test('a late snapshot listing cannot replace a newer native snapshot event', async () => {
  const store = await snapshotStore();
  const listing = deferred(); globalThis.listSnapshots = () => listing.promise;
  const reading = store.getState().refreshTurnSnapshots('s1');
  globalThis.storeEvent('turnSnapshot', checkpoint('undone'));
  listing.resolve([checkpoint()]); await reading;
  assert.equal(store.getState().threads[0].snapshots.t1.state, 'undone');
  const replaced = deferred(); globalThis.listSnapshots = () => replaced.promise;
  const second = store.getState().refreshTurnSnapshots('s1');
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g2' }] });
  replaced.resolve([checkpoint()]); await second;
  assert.equal(store.getState().threads[0].snapshots.t1.state, 'undone', 'old grant listings are fenced');
});

test('Undo and Reapply are single-flight and preserve the unsent draft', async () => {
  const store = await snapshotStore();
  const writing = deferred(); const calls = [];
  globalThis.restoreSnapshot = (...args) => { calls.push(args); return writing.promise; };
  let sends = 0; globalThis.storeBridge = async () => { sends += 1; return {}; };
  const undo = store.getState().restoreSnapshot('s1', 't1');
  await store.getState().restoreSnapshot('s1', 't1');
  assert.equal(store.getState().confirmDialog.confirmLabel, 'Undo');
  store.getState().resolveConfirm(true); await new Promise(setImmediate);
  await store.getState().sendPrompt();
  assert.equal(sends, 0, 'a new prompt cannot race the file restore');
  assert.deepEqual(calls, [['g1', 's1', 'snap-1', false]]);
  writing.resolve({ snapshot: checkpoint('undone'), conflicts: [] }); await undo;
  assert.equal(store.getState().threads[0].snapshots.t1.state, 'undone');
  assert.equal(store.getState().composer, 'Keep my draft');
  assert.equal(store.getState().threads[0].snapshotPending, undefined);
  globalThis.restoreSnapshot = async (...args) => { calls.push(args); return { snapshot: checkpoint(), conflicts: [] }; };
  const reapply = store.getState().restoreSnapshot('s1', 't1');
  assert.equal(store.getState().confirmDialog.confirmLabel, 'Reapply');
  store.getState().resolveConfirm(true); await reapply;
  assert.deepEqual(calls[1], ['g1', 's1', 'snap-1', true]);
  assert.equal(store.getState().threads[0].snapshots.t1.state, 'ready');
});

test('a snapshot listing cannot race Undo and hide the resulting Reapply state', async () => {
  const store = await snapshotStore(); const listing = deferred(); const writing = deferred();
  let lists = 0; globalThis.listSnapshots = () => { lists += 1; return listing.promise; };
  globalThis.restoreSnapshot = () => writing.promise;
  const reading = store.getState().refreshTurnSnapshots('s1');
  const undo = store.getState().restoreSnapshot('s1', 't1'); store.getState().resolveConfirm(true);
  await new Promise(setImmediate);
  await store.getState().refreshTurnSnapshots('s1'); assert.equal(lists, 1, 'reads pause during a restore');
  listing.resolve([checkpoint()]); await reading;
  writing.resolve({ snapshot: checkpoint('undone'), conflicts: [] }); await undo;
  assert.equal(store.getState().threads[0].snapshots.t1.state, 'undone', 'the native restore result still matches its descriptor');
  assert.equal(store.getState().threads[0].snapshotError, undefined);
});

test('snapshot conflicts leave the direction unchanged and name the affected files', async () => {
  const store = await snapshotStore(); let reads = 0;
  globalThis.readGit = () => { reads += 1; return git(['later.txt']); };
  globalThis.restoreSnapshot = async () => ({ snapshot: checkpoint(), conflicts: ['b.txt'] });
  const undo = store.getState().restoreSnapshot('s1', 't1'); store.getState().resolveConfirm(true); await undo;
  const thread = store.getState().threads[0];
  assert.equal(thread.snapshots.t1.state, 'ready');
  assert.match(thread.snapshotError.message, /b\.txt.*Nothing was restored/);
  assert.equal(thread.snapshotPending, undefined);
  assert.equal(reads, 0, 'the failed native restore does not claim a fresh git answer');
  await sleep(850); // Settle runGitMutation's recovery read after a failed write.
});

test('snapshot confirmation is cancelled by a new selection, grant, or running turn', async () => {
  for (const change of ['workspace', 'thread', 'grant', 'running', 'cancel']) {
    const store = await snapshotStore(); let writes = 0;
    globalThis.restoreSnapshot = async () => { writes += 1; return { snapshot: checkpoint('undone'), conflicts: [] }; };
    const undo = store.getState().restoreSnapshot('s1', 't1');
    if (change === 'workspace') store.setState({ selectedWorkspaceId: 'elsewhere' });
    if (change === 'thread') store.setState({ selectedSessionId: 's2' });
    if (change === 'grant') store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g2' }] });
    if (change === 'running') store.setState({ threads: store.getState().threads.map((thread) => ({ ...thread, status: 'running' })) });
    store.getState().resolveConfirm(change !== 'cancel'); await undo;
    assert.equal(writes, 0, `${change} must prevent the restore`);
    assert.equal(store.getState().threads[0].snapshotPending, undefined);
  }
});

test('a successful restore with a failed Changes refresh keeps Reapply available', async () => {
  const store = await snapshotStore();
  globalThis.restoreSnapshot = async () => ({ snapshot: checkpoint('undone'), conflicts: [] });
  globalThis.readGit = async () => { throw new Error('Git read failed'); };
  const undo = store.getState().restoreSnapshot('s1', 't1'); store.getState().resolveConfirm(true); await undo;
  assert.equal(store.getState().threads[0].snapshots.t1.state, 'undone');
  assert.match(store.getState().threads[0].snapshotError.message, /Files restored; Changes could not refresh/);
  assert.equal(store.getState().composer, 'Keep my draft');
  await sleep(850);
});

test('a preview fork never inherits snapshot ownership from its source', async () => {
  const store = await snapshotStore(); store.setState({ preview: true });
  await store.getState().forkThread('s1');
  const fork = store.getState().threads.find((thread) => thread.sessionId !== 's1');
  assert.ok(fork); assert.equal(fork.snapshots, undefined);
  assert.equal(store.getState().threads[0].snapshots.t1.sessionId, 's1');
});

test('a git read started before a mutation cannot resurrect pre-mutation state', async () => {
  const store = await frontendStore();
  workspace(store);
  const stale = deferred();
  globalThis.readGit = () => stale.promise;
  globalThis.mutationGit = git(['kept.txt']);

  // A slow snapshot is in flight while the user discards a file.
  const reading = store.getState().refreshGit();
  await sleep(5);
  await store.getState().discardGitFiles(['dropped.txt']);
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['kept.txt']);

  // The stale read lands last: it must be dropped, not applied.
  stale.resolve(git(['dropped.txt', 'kept.txt']));
  await reading;
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['kept.txt']);
  assert.equal(store.getState().gitLoading, false);
});

test('a double-click on fork sends exactly one forkSession', async () => {
  const store = await frontendStore();
  const forks = [];
  globalThis.storeBridge = async (method, args) => {
    if (method === 'forkSession') { forks.push(args); await sleep(20); return { sessionId: `fork-${forks.length}` }; }
    return {};
  };
  store.setState({ threads: [{ sessionId: 's1', workspacePath: '/repo', items: [], opened: true, status: 'idle', title: 'Source' }], selectedSessionId: 's1', preview: false });

  await Promise.all([store.getState().forkThread('s1'), store.getState().forkThread('s1')]);
  assert.equal(forks.length, 1, 'session/fork is not idempotent; a second concurrent call must be dropped');
  const created = store.getState().threads.filter((thread) => thread.sessionId.startsWith('fork-'));
  assert.equal(created.length, 1);
});

test('local saves go through the native atomic writer and never the plugin writer', async () => {
  const store = await frontendStore(true);
  globalThis.persistedData = {};
  // Every `frontendStore` bundles a fresh module, so an earlier test's module can
  // still have a debounced save pending. Drain those before measuring ours.
  await flushMemorySave();
  const writes = [];
  globalThis.persistStoreDocument = async (json) => { writes.push(json); };

  store.getState().setDockOpen(false);
  await flushMemorySave();

  const docs = writes.map((json) => JSON.parse(json));
  assert.equal(docs.length, 1, 'exactly one atomic write for one debounced save');
  assert.ok(docs[0].sessionMemory, 'the whole document is handed to the atomic writer');
  assert.equal(docs[0].sessionMemory.dockOpen, false, 'the payload carries the change that triggered it');
});

test('a failed local save surfaces a banner and the next success clears it', async () => {
  const store = await frontendStore(true);
  globalThis.persistedData = {};
  // Drain saves still pending from earlier bundles before measuring ours.
  await flushMemorySave();
  globalThis.persistStoreDocument = async () => { throw new Error('disk full'); };

  store.getState().setDockOpen(false);
  await flushMemorySave();

  assert.match(store.getState().persistNotice, /not being saved locally/,
    'a silent log line must not stand in for telling the user their drafts are at risk');

  globalThis.persistStoreDocument = async () => {};
  store.getState().setDockOpen(true);
  await flushMemorySave();
  assert.equal(store.getState().persistNotice, null, 'the banner clears once saves succeed again');
});

// RED-BS-001: the draft/memory debounces die with the webview, so quitting used
// to silently lose the last edits. Every teardown signal must flush instead.
test('pagehide flushes the pending draft save before the debounce could fire', async () => {
  const store = await frontendStore(true);
  workspace(store);
  globalThis.persistedData = {};
  await flushMemorySave();
  const writes = [];
  globalThis.persistStoreDocument = async (json) => { writes.push(JSON.parse(json)); };

  store.getState().setComposer('Unsent words');
  globalThis.window.dispatch('pagehide');
  await flushMemorySave();

  assert.equal(writes.at(-1)?.sessionMemory?.drafts?.['project:w']?.text, 'Unsent words',
    'the last draft lands on disk even though its 1000ms debounce never fired');
});

test('the native close-requested signal flushes pending saves on macOS', async () => {
  const store = await frontendStore(true);
  workspace(store);
  globalThis.persistedData = {};
  await flushMemorySave();
  const writes = [];
  globalThis.persistStoreDocument = async (json) => { writes.push(JSON.parse(json)); };
  assert.equal(typeof globalThis.closeRequested, 'function', 'bindBridgeEvents wires the native signal');

  store.getState().setComposer('Typed at the last second');
  globalThis.closeRequested();
  await flushMemorySave();

  assert.equal(writes.at(-1)?.sessionMemory?.drafts?.['project:w']?.text, 'Typed at the last second');
});

test('going hidden flushes the pending save once, without double-writing later', async () => {
  const store = await frontendStore(true);
  workspace(store);
  globalThis.persistedData = {};
  await flushMemorySave();
  const writes = [];
  globalThis.persistStoreDocument = async (json) => { writes.push(JSON.parse(json)); };

  store.getState().setComposer('Before hide');
  globalThis.document.visibilityState = 'hidden';
  globalThis.document.dispatch('visibilitychange');
  await flushMemorySave();

  assert.equal(writes.at(-1)?.sessionMemory?.drafts?.['project:w']?.text, 'Before hide');
  assert.equal(writes.length, 1, 'the cleared debounce cannot fire a second save for the same state');
});

// The recovery/quarantine banner is the only signal after local data loss: the
// native side restores `.bak` or quarantines to `.corrupt` before hydration,
// and hydrate() turns the verdict into persistNotice. `invoke` is stubbed for
// the consent/credential reads hydration performs on the way.
const hydrateStubs = {
  '@tauri-apps/api/core': `export const invoke = async (command) => command === 'acp_isolation_consent_get' ? false : command === 'credential_get' ? null : undefined;`,
  '@tauri-apps/plugin-notification': `export const isPermissionGranted=async()=>true;export const requestPermission=async()=>"granted";export const sendNotification=()=>{};`,
};

test('a restored store document tells the user which backup was used', async () => {
  globalThis.storeRepair = { status: 'restored', restoredFrom: 'muse-desktop.json.bak' };
  globalThis.persistedData = { sessionMemory: { version: 1, drafts: { 'thread:s1': { text: 'Recovered draft', images: [] } } } };
  const store = await frontendStore(true, hydrateStubs);
  try {
    await store.getState().hydrate();
    assert.equal(store.getState().persistNotice,
      'Your saved drafts and thread titles were recovered from a backup (muse-desktop.json.bak). Anything saved after that point was lost.');
    assert.equal(store.getState().drafts['thread:s1'].text, 'Recovered draft', 'the restored document still loads');
    store.getState().dismissPersistNotice();
    assert.equal(store.getState().persistNotice, null);
  } finally {
    globalThis.storeRepair = undefined;
    globalThis.persistedData = {};
  }
});

test('a quarantined store document names the set-aside file and starts empty', async () => {
  globalThis.storeRepair = { status: 'quarantined', quarantinedTo: 'muse-desktop.json.corrupt' };
  globalThis.persistedData = {};
  const store = await frontendStore(true, hydrateStubs);
  try {
    await store.getState().hydrate();
    assert.equal(store.getState().persistNotice,
      'Your saved drafts and thread titles could not be read and were set aside (muse-desktop.json.corrupt). Muse started with empty local state.');
    assert.deepEqual(store.getState().drafts, {}, 'the quarantined document contributes nothing');
  } finally {
    globalThis.storeRepair = undefined;
  }
});

test('a newer session document is left unchanged and the banner says so', async () => {
  globalThis.storeRepair = { status: 'ok' };
  globalThis.persistedData = {
    sessionMemory: {
      version: 99,
      drafts: { 'thread:s1': { text: 'from the future', images: [] } },
      futureOnly: { keep: true },
    },
  };
  const store = await frontendStore(true, hydrateStubs);
  try {
    await store.getState().hydrate();
    assert.equal(store.getState().drafts['thread:s1'].text, 'from the future');
    store.getState().setDockOpen(false);
    await flushMemorySave();
    assert.match(store.getState().persistNotice, /newer Muse Code/);
    assert.doesNotMatch(store.getState().persistNotice ?? '', /not being saved locally/);
    assert.equal(globalThis.persistedData.sessionMemory.version, 99);
    assert.equal(globalThis.persistedData.sessionMemory.futureOnly.keep, true);
    assert.equal(globalThis.persistedData.sessionMemory.drafts['thread:s1'].text, 'from the future');
    store.getState().dismissPersistNotice();
    store.getState().setDockOpen(true);
    await flushMemorySave();
    assert.equal(store.getState().persistNotice, null, 'dismissing the notice keeps it dismissed');
    assert.equal(globalThis.persistedData.sessionMemory.version, 99);
  } finally {
    globalThis.storeRepair = undefined;
    globalThis.persistedData = {};
  }
});

test('an intact store document raises no recovery banner', async () => {
  globalThis.storeRepair = { status: 'ok' };
  globalThis.persistedData = { sessionMemory: { version: 1, drafts: { 'thread:s1': { text: 'Ordinary draft', images: [] } } } };
  const store = await frontendStore(true, hydrateStubs);
  try {
    await store.getState().hydrate();
    assert.equal(store.getState().persistNotice, null);
    assert.equal(store.getState().drafts['thread:s1'].text, 'Ordinary draft');
  } finally {
    globalThis.storeRepair = undefined;
    globalThis.persistedData = {};
  }
});

// ARCH-003: the agent-exit path used to clear a different set of fields than the
// connection-loss path, leaving a phantom approval behind.
test('an agent exit mid-approval clears the pending approval instead of leaving a phantom one', async () => {
  const store = await frontendStore();
  workspace(store);
  store.setState({
    agents: [{ id: 'agent-a', name: 'Agent A', status: 'ready' }],
    threads: [{
      sessionId: 's1', workspacePath: '/repo', items: [], opened: true,
      agentId: 'agent-a', status: 'running', activeTurnId: 't1',
      pendingApproval: { requestId: 'a1', kind: 'exec', summary: 'rm -rf', createdAt: '2026-01-01' },
      approvalPending: true, pendingTurnKey: 'p1', cancelRequested: true, configPending: true,
    }],
    selectedSessionId: 's1',
  });

  globalThis.storeEvent('agentExit', { agentId: 'agent-a', error: 'boom' });

  const thread = store.getState().threads[0];
  assert.equal(thread.pendingApproval, null, 'nothing can resolve it, so it must not stay on screen');
  assert.equal(thread.approvalPending, false);
  assert.equal(thread.pendingTurnKey, null, 'the queued send must not launch after the agent died');
  assert.equal(thread.cancelRequested, false);
  assert.equal(thread.configPending, false);
  assert.equal(thread.status, 'error');
  assert.equal(thread.lastOutcome, 'interrupted');
  assert.match(thread.error, /Agent A stopped: boom/);
});

test('a failed busy-send replaces the optimistic message and settles the thread', async () => {
  const store = await frontendStore();
  globalThis.storeBridge = async (method) => {
    if (method === 'sendTurn') throw new Error('host rejected the turn');
    return {};
  };
  store.setState({
    threads: [{ sessionId: 's1', workspacePath: '/repo', items: [], opened: true, status: 'running', activeTurnId: 't1', title: 'Busy' }],
    selectedSessionId: 's1', preview: false, composer: 'replacement prompt', submitting: false,
  });
  workspace(store);

  await store.getState().sendPrompt({ disposition: 'replace' });
  const thread = store.getState().threads.find((item) => item.sessionId === 's1');
  assert.equal(thread.items.filter((item) => item.kind === 'userMessage').length, 0, 'a message that never reached the host must not stay in the transcript');
  assert.equal(thread.activeTurnId, 't1', 'the still-running turn keeps its identity');
  assert.equal(thread.status, 'running');
  assert.equal(thread.pendingTurnKey, null);
  assert.match(thread.error, /Could not replace the turn: host rejected the turn/,
    'the host reason belongs on screen — the generic "Send failed" used to discard it');
});

// A thread the user deleted keeps its turn on the host: the app is not the
// agent. Nothing could then answer the agent's next approval, and it kept
// spending the user's quota with no thread left to show it.
test('deleting a thread with a running turn stops the turn instead of orphaning it', async () => {
  const store = await frontendStore();
  workspace(store);
  const calls = [];
  globalThis.storeBridge = async (method, args) => { calls.push([method, args]); return {}; };
  store.setState({
    threads: [
      { sessionId: 'running', workspacePath: '/repo', items: [], opened: true, status: 'running', activeTurnId: 't1', title: 'Busy' },
      { sessionId: 'idle', workspacePath: '/repo', items: [], opened: true, status: 'idle', title: 'Quiet' },
    ],
    selectedSessionId: 'idle',
  });

  store.getState().deleteThread('running');
  await sleep(20);

  assert.deepEqual(calls.filter(([method]) => method === 'cancelTurn').length, 1, 'the live turn is cancelled');
  assert.equal(calls[0][0], 'cancelTurn');
  assert.equal(calls[0][1].sessionId, 'running');
  assert.equal(calls[0][1].turnId, 't1');
  assert.equal(store.getState().threads.length, 1);

  // An idle thread must not generate a cancel.
  calls.length = 0;
  store.getState().deleteThread('idle');
  await sleep(20);
  assert.equal(calls.filter(([method]) => method === 'cancelTurn').length, 0, 'nothing was running, so nothing is cancelled');
});

test('removing a workspace stops every running turn it owned', async () => {
  const store = await frontendStore();
  workspace(store);
  const cancelled = [];
  globalThis.storeBridge = async (method, args) => { if (method === 'cancelTurn') cancelled.push(args.sessionId); return {}; };
  store.setState({
    threads: [
      { sessionId: 's1', workspacePath: '/repo', items: [], opened: true, status: 'running', activeTurnId: 't1' },
      { sessionId: 's2', workspacePath: '/repo', items: [], opened: true, status: 'running', activeTurnId: 't2' },
      { sessionId: 's3', workspacePath: '/repo', items: [], opened: true, status: 'idle' },
    ],
    selectedWorkspaceId: 'w', selectedSessionId: null,
  });

  store.getState().removeWorkspace('w');
  await sleep(20);

  assert.deepEqual(cancelled.sort(), ['s1', 's2']);
  assert.equal(store.getState().threads.length, 0);
});

// The bridge holds one SDK session per open thread and nothing else ever drops
// one, so deleting threads (or a whole workspace) grew its session maps for the
// bridge's lifetime. `closeSession` is the verb that ends a session's life.
test('deleting a thread releases its session from the bridge', async () => {
  const store = await frontendStore();
  workspace(store);
  const calls = [];
  globalThis.storeBridge = async (method, args) => { calls.push([method, args]); return {}; };
  store.setState({
    threads: [
      { sessionId: 's1', workspacePath: '/repo', items: [], opened: true, status: 'idle', title: 'One' },
      { sessionId: 's2', workspacePath: '/repo', items: [], opened: true, status: 'idle', title: 'Two' },
    ],
    selectedSessionId: null,
  });

  store.getState().deleteThread('s1');
  await sleep(20);

  assert.deepEqual(calls, [['closeSession', { sessionId: 's1' }]], 'exactly the deleted session is released');
});

test('removing a workspace releases every session it owned', async () => {
  const store = await frontendStore();
  workspace(store);
  const calls = [];
  globalThis.storeBridge = async (method, args) => { calls.push([method, args]); return {}; };
  store.setState({
    threads: [
      { sessionId: 's1', workspacePath: '/repo', items: [], opened: true, status: 'idle' },
      { sessionId: 's2', workspacePath: '/repo', items: [], opened: true, status: 'idle' },
      { sessionId: 's3', workspacePath: '/elsewhere', items: [], opened: true, status: 'idle' },
    ],
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }, { id: 'o', path: '/elsewhere', grantId: 'g2' }],
    selectedWorkspaceId: 'w', selectedSessionId: null,
  });

  store.getState().removeWorkspace('w');
  await sleep(20);

  const closed = calls.filter(([method]) => method === 'closeSession').map(([, args]) => args.sessionId).sort();
  assert.deepEqual(closed, ['s1', 's2'], 'the removed workspace’s sessions go, another workspace’s stay');
});

function feedbackThread(partial = {}) {
  return { sessionId: 's1', workspacePath: '/repo', items: [], opened: true, status: 'running', title: 'Original', activeTurnId: 't1',
    pendingApproval: { approvalId: 'a1', sessionId: 's1', turnId: 't1', toolName: 'bash', availableChoices: [
      { choiceId: 'deny', label: 'Deny', decision: 'denied', scope: 'once' },
      { choiceId: 'allow', label: 'Allow', decision: 'approved', scope: 'once' },
    ] }, ...partial };
}
const completeFeedbackTurn = (terminal = 'completed') => globalThis.storeEvent('turnCompleted', { sessionId: 's1', turnId: 't1', outcome: { kind: 'completed', params: { terminal } } });

async function feedbackStore(partial = {}) {
  const store = await frontendStore();
  workspace(store);
  store.setState({ threads: [feedbackThread(partial)], selectedSessionId: 's1', composer: 'Keep this draft', refreshGit: async () => {}, refreshFileIndex: () => {} });
  return store;
}

test('denial feedback waits for acknowledgement and stays with its original thread', async () => {
  const store = await feedbackStore();
  const denial = deferred();
  const calls = [];
  globalThis.storeBridge = async (method, args) => { calls.push([method, args]); return method === 'decideApproval' ? denial.promise : { turnId: 't1' }; };
  const deciding = store.getState().decide('a1', 'deny', 'Use the existing helper');
  assert.deepEqual(calls.map(([method]) => method), ['decideApproval']);
  store.setState({ selectedSessionId: 's2', composer: 'Other thread draft' });
  denial.resolve({});
  await deciding;
  assert.deepEqual(calls.map(([method]) => method), ['decideApproval', 'steerTurn']);
  assert.equal(calls[1][1].sessionId, 's1');
  assert.equal(calls[1][1].text, 'Use the existing helper');
  assert.equal(store.getState().composer, 'Other thread draft');
  assert.deepEqual(store.getState().promptHistory.w, ['Use the existing helper']);
});

test('a failed denial never sends feedback and keeps the approval retryable', async () => {
  const store = await feedbackStore();
  const calls = [];
  globalThis.storeBridge = async (method) => { calls.push(method); throw new Error('Permission denied'); };
  await store.getState().decide('a1', 'deny', 'Try another approach');
  assert.deepEqual(calls, ['decideApproval']);
  assert.equal(store.getState().threads[0].pendingApproval.approvalId, 'a1');
  assert.equal(store.getState().threads[0].approvalPending, false);
  assert.deepEqual(store.getState().promptHistory, {});
});

test('denial feedback queues through Muse when steering is definitively unavailable', async () => {
  const store = await feedbackStore();
  const calls = [];
  globalThis.storeBridge = async (method, args) => {
    calls.push([method, args]);
    if (method === 'steerTurn') throw new Error('No active turn');
    return { turnId: 't2', disposition: 'queued' };
  };
  await store.getState().decide('a1', 'deny', 'Try another approach');
  assert.deepEqual(calls.map(([method]) => method), ['decideApproval', 'steerTurn', 'sendTurn']);
  assert.equal(calls[2][1].ifBusy, 'queue');
  assert.ok(calls[2][1].clientTurnId);
  assert.deepEqual(store.getState().threads[0].queuedTurns, [{ turnId: 't2', text: 'Try another approach' }]);
  assert.equal(store.getState().composer, 'Keep this draft');
});

test('an uncertain steer is never duplicated and can be reclaimed without replacing a draft', async () => {
  const store = await feedbackStore();
  const calls = [];
  globalThis.storeBridge = async (method) => {
    calls.push(method);
    if (method === 'steerTurn') throw Object.assign(new Error('Request timed out; result is unknown'), { code: 'timeout-unknown' });
    return {};
  };
  await store.getState().decide('a1', 'deny', 'Keep the public API');
  assert.deepEqual(calls, ['decideApproval', 'steerTurn']);
  const feedback = store.getState().threads[0].approvalFeedback[0];
  assert.equal(feedback.state, 'uncertain');
  store.getState().reclaimApprovalFeedback('s1', feedback.id);
  assert.equal(store.getState().composer, 'Keep this draft\n\nKeep the public API');
  assert.deepEqual(store.getState().threads[0].approvalFeedback, []);
});

test('ACP denial feedback waits for completion, then sends once to the original agent', async () => {
  const store = await feedbackStore({ agentId: 'opencode' });
  const calls = [];
  globalThis.storeBridge = async (method, args) => { calls.push([method, args]); return { turnId: 't2' }; };
  await store.getState().decide('a1', 'deny', 'Use a read-only command');
  assert.deepEqual(calls.map(([method]) => method), ['decideApproval']);
  assert.equal(store.getState().threads[0].approvalFeedback[0].state, 'queued');
  completeFeedbackTurn();
  await new Promise(setImmediate);
  assert.deepEqual(calls.map(([method]) => method), ['decideApproval', 'sendTurn']);
  assert.equal(calls[1][1].agentId, 'opencode');
  assert.equal(calls[1][1].sessionId, 's1');
  assert.equal(store.getState().threads[0].activeTurnId, 't2');
  assert.deepEqual(store.getState().threads[0].approvalFeedback, []);
  assert.equal(store.getState().composer, 'Keep this draft');
});

test('stopping an ACP turn keeps its feedback without starting another turn', async () => {
  const store = await feedbackStore({ agentId: 'opencode' });
  const calls = [];
  globalThis.storeBridge = async (method) => { calls.push(method); return {}; };
  await store.getState().decide('a1', 'deny', 'Feedback to keep');
  completeFeedbackTurn('cancelled');
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['decideApproval']);
  assert.equal(store.getState().threads[0].approvalFeedback[0].state, 'failed');
});

test('a completion before the feedback send acknowledgement cannot resurrect a finished turn', async () => {
  const store = await feedbackStore({ agentId: 'opencode' });
  const sending = deferred();
  globalThis.storeBridge = async (method) => method === 'sendTurn' ? sending.promise : {};
  await store.getState().decide('a1', 'deny', 'Check the path');
  completeFeedbackTurn();
  globalThis.storeEvent('turnCompleted', { sessionId: 's1', turnId: 't2', outcome: { kind: 'completed', params: { terminal: 'completed' } } });
  sending.resolve({ turnId: 't2' });
  await new Promise(setImmediate);
  assert.equal(store.getState().threads[0].status, 'idle');
  assert.equal(store.getState().threads[0].activeTurnId, null);
});

test('prompt history records acknowledged sends only, using the originating workspace', async () => {
  const store = await feedbackStore({ status: 'idle', pendingApproval: null, activeTurnId: null });
  globalThis.storeBridge = async () => { throw new Error('Send rejected'); };
  await store.getState().sendPrompt();
  assert.deepEqual(store.getState().promptHistory, {});
  assert.equal(store.getState().composer, 'Keep this draft');
  const ack = deferred();
  globalThis.storeBridge = async () => ack.promise;
  const sending = store.getState().sendPrompt();
  store.setState({ selectedWorkspaceId: 'elsewhere' });
  ack.resolve({ turnId: 't2' });
  await sending;
  assert.deepEqual(store.getState().promptHistory.w, ['Keep this draft']);
  assert.equal(store.getState().promptHistory.elsewhere, undefined);
});

test('Stop during a feedback send also cancels the acknowledged turn', async () => {
  const store = await feedbackStore({ agentId: 'opencode', status: 'idle', activeTurnId: null });
  const ack = deferred();
  const calls = [];
  globalThis.storeBridge = async (method, args) => { calls.push([method, args]); return method === 'sendTurn' ? ack.promise : {}; };
  const deciding = store.getState().decide('a1', 'deny', 'Check the file');
  await new Promise(setImmediate);
  await store.getState().stopTurn();
  ack.resolve({ turnId: 'feedback-turn' });
  await deciding;
  assert.ok(calls.some(([method, args]) => method === 'cancelTurn' && args.turnId === 'feedback-turn'));
});

// C7: file-touching steps refresh the Changes pane through one debounced
// timer, so a burst of edits costs one git read instead of one per item.
const editThread = (path = '/repo') => ({ sessionId: 's1', workspacePath: path, items: [], opened: true, status: 'idle', title: 'Edits' });
const editItem = (sessionId, itemId, status = 'completed', tool = 'write_file', extra = {}) =>
  globalThis.storeEvent('item', { sessionId, item: { itemId, kind: 'toolCall', tool, status, args: '{"path":"a.txt"}', ...extra } });
const waitDebounce = () => sleep(850);

test('completed edits coalesce into one debounced git read', async () => {
  const store = await frontendStore();
  workspace(store);
  let reads = 0;
  globalThis.readGit = () => { reads += 1; return git(['a.txt']); };
  store.setState({ threads: [editThread()], selectedSessionId: 's1' });

  editItem('s1', 'e1');
  editItem('s1', 'e2');
  assert.equal(reads, 0, 'the debounce is still settling');
  await waitDebounce();
  assert.equal(reads, 1, 'two completed edits collapse into one read');

  // A repeated completion for an already-completed edit does not re-arm it.
  editItem('s1', 'e2');
  await waitDebounce();
  assert.equal(reads, 1);
});

test('non-edit, running, failed, and other-workspace items do not schedule a read', async () => {
  const store = await frontendStore();
  workspace(store);
  let reads = 0;
  globalThis.readGit = () => { reads += 1; return git(['a.txt']); };
  store.setState({ threads: [editThread(), { ...editThread('/other'), sessionId: 's2' }], selectedSessionId: 's1' });

  editItem('s1', 'r1', 'completed', 'read_file');
  editItem('s1', 'e1', 'inProgress');
  globalThis.storeEvent('item', { sessionId: 's1', item: { itemId: 'm1', kind: 'agentMessage', status: 'completed', text: 'done' } });
  editItem('s2', 'e9');
  editItem('s1', 'e5', 'completed', 'write_file', { failureReason: 'denied' });
  await waitDebounce();
  assert.equal(reads, 0);
});

test('a workspace switch before the debounce drops the queued read', async () => {
  const store = await frontendStore();
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }, { id: 'w2', path: '/other', grantId: 'g2' }], selectedWorkspaceId: 'w', preview: false });
  let reads = 0;
  globalThis.readGit = () => { reads += 1; return git([]); };
  store.setState({ threads: [editThread()], selectedSessionId: 's1' });

  editItem('s1', 'e1');
  store.setState({ selectedWorkspaceId: 'w2' });
  await waitDebounce();
  assert.equal(reads, 0);
});

test('an edit completing during a git read earns a fresh follow-up read', async () => {
  const store = await frontendStore();
  workspace(store);
  const slow = deferred();
  let reads = 0;
  globalThis.readGit = () => { reads += 1; return reads === 1 ? slow.promise : git(['b.txt']); };
  store.setState({ threads: [editThread()], selectedSessionId: 's1' });

  const reading = store.getState().refreshGit();
  await sleep(5);
  assert.ok(store.getState().gitLoading, 'the read is mid-flight');
  editItem('s1', 'e1');
  await waitDebounce();
  assert.equal(reads, 1, 'the timer saw a busy reader and queued a follow-up instead');
  slow.resolve(git(['a.txt']));
  await reading;
  await waitDebounce();
  assert.equal(reads, 2, 'the owed read ran after the in-flight one finished');
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['b.txt']);
});

test('a manual refresh and a turn completion cancel a queued read', async () => {
  const store = await frontendStore();
  workspace(store);
  let reads = 0;
  globalThis.readGit = () => { reads += 1; return git([]); };
  store.setState({ threads: [editThread()], selectedSessionId: 's1' });

  editItem('s1', 'e1');
  await store.getState().refreshGit();
  assert.equal(reads, 1);
  await waitDebounce();
  assert.equal(reads, 1, 'an explicit read never leaves a trailing duplicate');

  editItem('s1', 'e2');
  globalThis.storeEvent('turnCompleted', { sessionId: 's1', turnId: 't1', outcome: { kind: 'completed', params: { terminal: 'completed' } } });
  await waitDebounce();
  assert.equal(reads, 2, 'the turn-end read fires once, without a trailing timer');
});

test('a stale repository init cannot overwrite a switched workspace', async () => {
  const store = await frontendStore();
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }, { id: 'w2', path: '/other', grantId: 'g2' }], selectedWorkspaceId: 'w', preview: false, git: git(['orig.txt']) });
  globalThis.initCalls = [];
  const slow = deferred();
  globalThis.initResult = slow.promise;
  const init = store.getState().initializeGit();
  await sleep(5);
  store.setState({ selectedWorkspaceId: 'w2' });
  slow.resolve(git(['new.txt']));
  await init;
  globalThis.initResult = undefined;
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['orig.txt'], 'the stale init answer is dropped');
});

test('initialization failures propagate instead of masquerading as clean state', async () => {
  const store = await frontendStore();
  workspace(store);
  globalThis.initCalls = [];
  globalThis.initError = new Error('permission denied');
  await assert.rejects(store.getState().initializeGit(), /permission denied/);
  assert.equal(store.getState().gitLoading, false);
  globalThis.initError = undefined;
  // An ungranted folder refuses before any native call is made.
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: null }], selectedWorkspaceId: 'w' });
  const calls = globalThis.initCalls.length;
  await assert.rejects(store.getState().initializeGit(), /not granted/);
  assert.equal(globalThis.initCalls.length, calls, 'no gitInit call for an ungranted folder');
});

// A git read that STARTS while a write is in flight resolves after the write's
// own authoritative snapshot — it must never overwrite that fresher answer.
test('a read started mid-mutation cannot overwrite the write answer', async () => {
  const store = await frontendStore();
  workspace(store);
  const write = deferred();
  const read = deferred();
  let reads = 0;
  globalThis.readGit = () => { reads += 1; return read.promise; };
  globalThis.mutationGit = write.promise;

  const writing = store.getState().stageGitFiles(['a.txt'], true);
  await sleep(5);
  const reading = store.getState().refreshGit();
  await sleep(5);
  write.resolve(git(['kept.txt']));
  await writing;
  // The racing read lands last — the write's snapshot must win.
  read.resolve(git(['stale.txt']));
  await reading;
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['kept.txt']);
});

// An edit event arriving while a write is in flight schedules a deferred
// follow-up: exactly one read after the write completes.
test('a pending refresh during a write fires once after the write ends', async () => {
  const store = await frontendStore();
  workspace(store);
  const write = deferred();
  let reads = 0;
  globalThis.readGit = () => { reads += 1; return git(['a.txt']); };
  globalThis.mutationGit = write.promise;
  store.setState({ threads: [editThread()], selectedSessionId: 's1' });

  const writing = store.getState().stageGitFiles(['a.txt'], true);
  await sleep(5);
  editItem('s1', 'e1');
  await waitDebounce();
  assert.equal(reads, 0, 'the armed refresh deferred while the write ran');
  write.resolve(git(['fresh.txt']));
  await writing;
  await waitDebounce();
  assert.equal(reads, 1, 'exactly one owed read followed the write');
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['a.txt']);
});

// A failing write still releases the counter so later scheduling works.
test('a failed write releases the scheduler bookkeeping', async () => {
  const store = await frontendStore();
  workspace(store);
  let reads = 0;
  globalThis.readGit = () => { reads += 1; return git(['a.txt']); };
  globalThis.mutationGit = Promise.reject(new Error('stage failed'));
  await assert.rejects(store.getState().stageGitFiles(['a.txt'], true), /stage failed/);
  assert.equal(store.getState().gitLoading, false);

  store.setState({ threads: [editThread()], selectedSessionId: 's1' });
  editItem('s1', 'e1');
  await waitDebounce();
  assert.equal(reads, 1, 'the scheduler recovered after the failed write');
});

// A→B→A (or a grant re-issue) while a write is in flight: the answer applies
// to nothing, since selectionVersion moved.
test('a write finishing across a selection hop applies to nothing', async () => {
  const store = await frontendStore();
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }, { id: 'w2', path: '/other', grantId: 'g2' }], selectedWorkspaceId: 'w', preview: false });
  globalThis.readGit = () => git(['live.txt']);
  const write = deferred();
  globalThis.mutationGit = write.promise;

  const writing = store.getState().stageGitFiles(['a.txt'], true);
  await sleep(5);
  await store.getState().selectWorkspace('w2');
  await store.getState().selectWorkspace('w');
  write.resolve(git(['stale-write.txt']));
  await writing;
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['live.txt'], 'the hopped write answer was dropped');
  // Nothing landed for the re-selected workspace, so one recovery read is
  // owed — await it so no armed timer leaks into the next test.
  await waitDebounce();
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['live.txt']);
  assert.equal(store.getState().gitLoading, false);
});

// An owed refresh armed for workspace A never fires for workspace B.
test('a pending refresh armed for one workspace cannot fire for another', async () => {
  const store = await frontendStore();
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }, { id: 'w2', path: '/other', grantId: 'g2' }], selectedWorkspaceId: 'w', preview: false });
  const reads = [];
  globalThis.readGit = (grant) => { reads.push(grant); return git(['a.txt']); };
  const write = deferred();
  globalThis.mutationGit = write.promise;
  store.setState({ threads: [editThread()], selectedSessionId: 's1' });

  const writing = store.getState().stageGitFiles(['a.txt'], true);
  await sleep(5);
  editItem('s1', 'e1');
  await waitDebounce(); // arms the pending refresh while the write runs
  await store.getState().selectWorkspace('w2');
  write.resolve(git(['alpha.txt']));
  await writing;
  await waitDebounce();
  // Only the select-time read for g2 ran; the armed g1 refresh died with the
  // workspace switch and never fired.
  assert.deepEqual(reads, ['g2'], 'the owed read was dropped with the workspace switch');
});

// A stale write resolving while ANOTHER workspace's read is in flight must not
// bump the version (which would drop B's answer) nor clear B's loading.
test('a stale write finishing during another workspace read has no effect on it', async () => {
  const store = await frontendStore();
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }, { id: 'w2', path: '/other', grantId: 'g2' }], selectedWorkspaceId: 'w', preview: false, git: git(['a.txt']) });
  globalThis.readGit = (grant) => grant === 'g2' ? readB.promise : git(['seed.txt']);
  const writeA = deferred();
  const readB = deferred();
  globalThis.mutationGit = writeA.promise;

  const writing = store.getState().stageGitFiles(['a.txt'], true);
  await sleep(5);
  // Switch to B; its git read starts and stays deferred.
  const selecting = store.getState().selectWorkspace('w2');
  await sleep(5);
  // The stale write resolves first — B's read is still waiting.
  writeA.resolve(git(['stale-write.txt']));
  await writing;
  await selecting;
  assert.equal(store.getState().gitLoading, true, 'B read still in flight keeps the spinner');
  // Now B's read lands: its data must be applied, not dropped by A's bump.
  readB.resolve(git(['b-live.txt']));
  await sleep(5);
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['b-live.txt']);
  assert.equal(store.getState().gitLoading, false);
});

// Same-workspace selection hops (selectThread/new draft) while a write is in
// flight, with no fresh read: the write's answer is dropped, the spinner is
// released, and exactly one recovery read reconciles.
test('a selection hop during a write drops the answer and triggers one recovery read', async () => {
  const store = await frontendStore();
  workspace(store);
  let reads = 0;
  globalThis.readGit = () => { reads += 1; return git(['recovered.txt']); };
  const write = deferred();
  globalThis.mutationGit = write.promise;
  store.setState({ threads: [{ sessionId: 's1', workspacePath: '/repo', title: 'T', status: 'idle', opened: true, items: [], unread: false }], selectedSessionId: 's1' });

  const writing = store.getState().stageGitFiles(['a.txt'], true);
  await sleep(5);
  await store.getState().selectThread('s1');
  write.resolve(git(['write-answer.txt']));
  await writing;
  // The write's snapshot was fenced by the selection hop; it never lands.
  assert.notDeepEqual((store.getState().git?.files ?? []).map((file) => file.path), ['write-answer.txt']);
  await waitDebounce();
  assert.equal(reads, 1, 'exactly one recovery read ran');
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['recovered.txt']);
  assert.equal(store.getState().gitLoading, false);
});

// Newest write wins; the older in-flight write can never overwrite it.
test('an older concurrent write cannot overwrite the newer answer', async () => {
  const store = await frontendStore();
  workspace(store);
  const first = deferred();
  const second = deferred();
  globalThis.readGit = () => git(['final.txt']);
  // Two writes racing on the same workspace: stage then discard. The bridge
  // stub returns whatever `mutationGit` currently is, so swap it per call.
  globalThis.mutationGit = first.promise;
  const writing1 = store.getState().stageGitFiles(['a.txt'], true);
  await sleep(5);
  globalThis.mutationGit = second.promise;
  const writing2 = store.getState().discardGitFiles(['b.txt']);
  await sleep(5);
  // Newest resolves first and applies.
  second.resolve(git(['newest.txt']));
  await writing2;
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['newest.txt']);
  // Oldest resolves second and must be dropped.
  first.resolve(git(['oldest.txt']));
  await writing1;
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['newest.txt'], 'the stale write never landed');
  await waitDebounce();
  assert.equal(store.getState().gitLoading, false);
  // Bookkeeping released: a fresh mutation proceeds normally.
  globalThis.mutationGit = git(['again.txt']);
  await store.getState().stageGitFiles(['c.txt'], true);
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['again.txt']);
});

// A grant re-issue invalidates both pending reads and pending writes for the
// workspace — the old grant's answer never lands.
test('a replaced grant fences pending reads and writes', async () => {
  const store = await frontendStore();
  workspace(store);
  const read = deferred();
  const write = deferred();
  globalThis.readGit = (grant) => grant === 'g1' ? read.promise : git(['after-grant.txt']);
  globalThis.mutationGit = write.promise;

  const reading = store.getState().refreshGit();
  const writing = store.getState().stageGitFiles(['a.txt'], true);
  await sleep(5);
  // The workspace gets a fresh grant mid-flight.
  store.setState({ workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g2' }] });
  read.resolve(git(['old-grant-read.txt']));
  write.resolve(git(['old-grant-write.txt']));
  await reading;
  await writing;
  assert.notDeepEqual((store.getState().git?.files ?? []).map((file) => file.path), ['old-grant-read.txt']);
  assert.notDeepEqual((store.getState().git?.files ?? []).map((file) => file.path), ['old-grant-write.txt']);
  // A read under the new grant lands fine.
  await store.getState().refreshGit();
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['after-grant.txt']);
});

// A1: a worktree thread works in its own checkout through its own grant.
const musePresent = (store) => store.setState({ detection: { found: true, path: '/bin/muse', version: '1', authenticated: true }, hostInfo: null });

test('a worktree draft creates its worktree before the session and moves Changes there', async () => {
  const store = await frontendStore(); workspace(store); musePresent(store);
  const order = []; const reads = [];
  globalThis.createWorktree = async (grant, base) => { order.push(['worktree', grant, base]); return { grantId: 'wt1', path: '/worktrees/one', branch: 'muse/one', base: 'release' }; };
  globalThis.storeBridge = async (method, params) => { if (method === 'startSession') { order.push(['session', params.grantId]); return { sessionId: 's-wt' }; } return {}; };
  globalThis.readGit = (grant) => { reads.push(grant); return git(grant === 'wt1' ? ['in-worktree.txt'] : ['local.txt']); };
  store.getState().setDraftWorktree({ base: ' release ' });
  await store.getState().createThread();
  const thread = store.getState().threads.find((item) => item.sessionId === 's-wt');
  assert.deepEqual(order, [['worktree', 'g1', 'release'], ['session', 'wt1']]);
  assert.deepEqual(thread.worktree, { grantId: 'wt1', path: '/worktrees/one', branch: 'muse/one', base: 'release', workspaceId: 'w' });
  assert.equal(thread.workspacePath, '/repo', 'the thread stays grouped under its workspace');
  await sleep(5);
  assert.equal(reads.at(-1), 'wt1'); assert.deepEqual(store.getState().git.files.map((file) => file.path), ['in-worktree.txt']);
  assert.deepEqual(store.getState().drafts['project:w'].worktree, { base: 'release' }, 'the choice stays for the next new thread');
  // Back on the workspace draft, Changes describes the workspace folder again.
  await store.getState().newThread(); await sleep(5);
  assert.equal(reads.at(-1), 'g1'); assert.deepEqual(store.getState().git.files.map((file) => file.path), ['local.txt']);
  // A mutation on the worktree thread is sent with the worktree's grant.
  await store.getState().selectThread('s-wt'); await sleep(5);
  globalThis.mutationGit = git([]); globalThis.discardCalls = [];
  await store.getState().discardGitFiles(['in-worktree.txt']);
  assert.deepEqual(globalThis.discardCalls, [['wt1', ['in-worktree.txt']]]);
  globalThis.createWorktree = undefined;
});

test('a session that fails to start takes its new worktree with it', async () => {
  const store = await frontendStore(); workspace(store); musePresent(store);
  const removed = [];
  globalThis.removeWorktree = async (grant) => { removed.push(grant); return { branch: 'muse/a', branchKept: false }; };
  globalThis.storeBridge = async (method) => { if (method === 'startSession') throw new Error('host down'); return {}; };
  globalThis.readGit = () => git([]);
  store.setState({ composer: 'Keep this prompt' });
  store.getState().setDraftWorktree({ base: '' });
  await store.getState().createThread();
  assert.deepEqual(removed, ['wt-grant']); assert.equal(store.getState().threads.length, 0);
  assert.match(store.getState().error, /host down/); assert.equal(store.getState().composer, 'Keep this prompt');
  globalThis.removeWorktree = undefined;
});

test('a worktree is removed with its last thread, not while a fork still uses it', async () => {
  const store = await frontendStore(); workspace(store);
  const removed = [];
  globalThis.removeWorktree = async (grant) => { removed.push(grant); return { branch: 'muse/one', branchKept: true }; };
  globalThis.readGit = () => git([]);
  const worktree = { grantId: 'wt1', path: '/worktrees/one', branch: 'muse/one', base: 'main', workspaceId: 'w' };
  const row = (sessionId, extra = {}) => ({ sessionId, workspacePath: '/repo', title: sessionId, status: 'idle', opened: true, items: [], ...extra });
  store.setState({ selectedSessionId: 'a', threads: [row('a', { worktree }), row('local')] });
  globalThis.storeBridge = async (method) => method === 'forkSession' ? { sessionId: 'b', items: [] } : {};
  await store.getState().forkThread('a', undefined, { select: false });
  assert.deepEqual(store.getState().threads.find((item) => item.sessionId === 'b').worktree, worktree, 'a fork shares its source worktree');
  store.getState().deleteThread('a'); await sleep(5);
  assert.deepEqual(removed, []);
  store.getState().deleteThread('local'); await sleep(5);
  assert.deepEqual(removed, [], 'a Local thread never removes anything');
  store.getState().deleteThread('b'); await sleep(5);
  assert.deepEqual(removed, ['wt1']);
  assert.match(store.getState().error, /Branch muse\/one was kept/);
  globalThis.removeWorktree = undefined;
});

test('worktree threads are listed again through their own grant after a relaunch', async () => {
  const store = await frontendStore(); workspace(store); musePresent(store);
  const worktree = { grantId: 'wt1', path: '/worktrees/one', branch: 'muse/one', base: 'main', workspaceId: 'w' };
  store.setState({ threadMeta: { 's-wt': { title: 'Parallel fix', customTitle: true, worktree }, 's-gone': { worktree: { ...worktree, grantId: 'wt2' }, deleted: true }, 's-other': { worktree: { ...worktree, grantId: 'wt3', workspaceId: 'elsewhere' } } } });
  const listed = [];
  globalThis.readGit = () => git([]);
  globalThis.storeBridge = async (method, params) => {
    if (method !== 'listSessions') return {};
    listed.push(params.grantId);
    if (params.grantId === 'wt1') return { sessions: [{ sessionId: 's-wt', workspaceRoot: '/worktrees/one', updatedAt: '2026-10-01T00:00:00Z' }, { sessionId: 's-stranger', workspaceRoot: '/worktrees/one' }] };
    return { sessions: [{ sessionId: 's-local', workspaceRoot: '/repo', title: 'Local work' }] };
  };
  await store.getState().loadWorkspaceThreads('w');
  assert.deepEqual(listed.sort(), ['g1', 'wt1'], 'only this workspace\'s live worktrees are listed');
  const threads = store.getState().threads;
  assert.deepEqual(threads.map((item) => item.sessionId).sort(), ['s-local', 's-wt']);
  const restored = threads.find((item) => item.sessionId === 's-wt');
  assert.deepEqual(restored.worktree, worktree); assert.equal(restored.workspacePath, '/repo'); assert.equal(restored.title, 'Parallel fix');
  assert.equal(threads.find((item) => item.sessionId === 's-local').worktree, undefined);
});

test('thread shortcuts follow sidebar order within the selected workspace', async () => {
  const store = await frontendStore(); workspace(store);
  globalThis.readGit = () => git([]);
  const row = (sessionId, extra = {}) => ({ sessionId, workspacePath: '/repo', title: sessionId, status: 'idle', opened: true, items: [], ...extra });
  store.setState({ threads: [row('old', { order: 1 }), row('new', { order: 3 }), row('pinned', { order: 2, pinned: true }), row('hidden', { order: 9, archived: true }), row('elsewhere', { order: 8, workspacePath: '/other' })] });
  await store.getState().selectThreadAt(0); assert.equal(store.getState().selectedSessionId, 'pinned');
  await store.getState().selectThreadAt(2); assert.equal(store.getState().selectedSessionId, 'old');
  await store.getState().selectThreadAt(7); assert.equal(store.getState().selectedSessionId, 'old', 'an empty slot changes nothing');
  await store.getState().selectAdjacentThread(1); assert.equal(store.getState().selectedSessionId, 'pinned', 'next wraps to the top');
  await store.getState().selectAdjacentThread(-1); assert.equal(store.getState().selectedSessionId, 'old');
  await store.getState().selectAdjacentThread(-1); assert.equal(store.getState().selectedSessionId, 'new');
  store.setState({ selectedSessionId: null });
  await store.getState().selectAdjacentThread(1); assert.equal(store.getState().selectedSessionId, 'pinned', 'from a draft, next opens the first thread');
});

test('the file viewer reads through the folder in view and drops answers it no longer owns', async () => {
  const store = await frontendStore(); workspace(store);
  globalThis.readGit = () => git([]);
  const calls = []; const slow = deferred();
  globalThis.readFile = (grant, path) => { calls.push([grant, path]); return path === 'slow.ts' ? slow.promise : { path, content: `// ${path}`, size: 9, truncated: false }; };
  await store.getState().openFile('/repo/src/a.ts');
  assert.deepEqual(calls, [['g1', 'src/a.ts']], 'an absolute path inside the workspace is sent as a relative one');
  assert.equal(store.getState().fileView.file.content, '// src/a.ts');
  assert.equal(store.getState().inspectorTab, 'files'); assert.equal(store.getState().dockOpen, true);
  await store.getState().openFile('/elsewhere/secret.txt');
  assert.equal(calls.length, 1, 'a path outside the workspace is never requested');
  assert.match(store.getState().fileView.error, /outside this workspace/);
  // A slow read is superseded by the next file, and its late answer is ignored.
  const first = store.getState().openFile('slow.ts');
  await store.getState().openFile('b.ts');
  slow.resolve({ path: 'slow.ts', content: 'late', size: 4, truncated: false }); await first;
  assert.equal(store.getState().fileView.path, 'b.ts'); assert.equal(store.getState().fileView.file.content, '// b.ts');
  // A worktree thread reads from its own checkout.
  store.setState({ selectedSessionId: 's-wt', threads: [{ sessionId: 's-wt', workspacePath: '/repo', title: 'wt', status: 'idle', opened: true, items: [], worktree: { grantId: 'wt1', path: '/worktrees/one', branch: 'muse/one', base: 'main', workspaceId: 'w' } }] });
  await store.getState().openFile('/worktrees/one/c.ts');
  assert.deepEqual(calls.at(-1), ['wt1', 'c.ts']);
  globalThis.readFile = (grant, path) => { throw new Error('gone'); };
  await store.getState().openFile('d.ts');
  assert.match(store.getState().fileView.error, /gone/);
});

test('branch switches and pushes go through the folder in view, and a switch resets what depended on the branch', async () => {
  const store = await frontendStore(); workspace(store);
  globalThis.readGit = () => git([]);
  const calls = [];
  globalThis.listBranches = async (grant) => { calls.push(['list', grant]); return [{ name: 'main', current: true }, { name: 'dev', current: false }]; };
  globalThis.switchBranch = async (grant, branch, create) => { calls.push(['switch', grant, branch, create]); return { ...git([]), branch }; };
  globalThis.pushBranch = async (grant) => { calls.push(['push', grant]); return { branch: 'dev', remote: 'origin' }; };
  globalThis.readPullRequest = async (grant, create) => { calls.push(['pr', grant, create]); return { url: 'https://github.com/o/r/pull/3', number: 3, state: 'OPEN', checks: 'pending' }; };
  await store.getState().refreshBranches();
  assert.deepEqual(store.getState().branches.map((branch) => branch.name), ['main', 'dev']);
  store.setState({ pullRequest: { url: 'https://x/1', number: 1 }, fileView: { path: 'a.ts', loading: false }, diffTabs: ['a.ts'], diffActive: 'a.ts' });
  await store.getState().switchBranch('dev', false);
  assert.equal(store.getState().git.branch, 'dev');
  assert.equal(store.getState().branches, null); assert.equal(store.getState().pullRequest, null); assert.equal(store.getState().fileView, null); assert.equal(store.getState().diffActive, null);
  assert.deepEqual(await store.getState().pushBranch(), { branch: 'dev', remote: 'origin' });
  store.setState({ selectedSessionId: 's1', threads: [{ sessionId: 's1', workspacePath: '/repo', title: 'Work', status: 'idle', opened: true, items: [] }] });
  await store.getState().refreshPullRequest(true);
  assert.equal(store.getState().pullRequest.number, 3);
  assert.match(store.getState().threads[0].notice.message, /Pull request #3 opened: https:\/\/github.com\/o\/r\/pull\/3\. Checks: pending\./);
  assert.deepEqual(calls, [['list', 'g1'], ['switch', 'g1', 'dev', false], ['push', 'g1'], ['pr', 'g1', true]]);
  globalThis.switchBranch = async () => { throw new Error('would be overwritten'); };
  await assert.rejects(store.getState().switchBranch('main', false), /would be overwritten/);
  assert.equal(store.getState().git.branch, 'dev', 'a refused switch leaves the snapshot alone');
});

test('drafting a commit message never replaces a composer draft and fills the box from the reply', async () => {
  const store = await frontendStore(); workspace(store);
  globalThis.readGit = () => git(['a.txt']);
  const sent = [];
  globalThis.storeBridge = async (method, params) => { if (method === 'sendTurn') { sent.push(params.text ?? params.prompt ?? JSON.stringify(params)); return { turnId: 't9' }; } return {}; };
  store.setState({ selectedSessionId: 's1', threads: [{ sessionId: 's1', workspacePath: '/repo', title: 'Work', status: 'idle', opened: true, items: [] }] });
  store.setState({ composer: 'my own draft' });
  await assert.rejects(store.getState().draftCommitMessage(), /Send or clear your draft/);
  assert.equal(store.getState().composer, 'my own draft'); assert.equal(sent.length, 0);
  store.setState({ composer: '' });
  await store.getState().draftCommitMessage();
  assert.equal(sent.length, 1); assert.match(sent[0], /draft a concise commit message/);
  assert.equal(store.getState().commitDrafting, 's1');
  const turnId = store.getState().threads[0].activeTurnId ?? 't9';
  globalThis.storeEvent('item', { sessionId: 's1', item: { itemId: 'm9', kind: 'agentMessage', status: 'completed', text: '```\nFix flaky login test\n\nDetails\n```', turnId } });
  globalThis.storeEvent('turnCompleted', { sessionId: 's1', turnId, outcome: { kind: 'completed', params: { terminal: 'completed' } } });
  assert.equal(store.getState().commitDrafting, null);
  assert.equal(store.getState().commitDraft.text, 'Fix flaky login test');
});

test('line comments are sent as one message without touching the composer draft, and steer a running Muse turn', async () => {
  const store = await frontendStore(); workspace(store);
  globalThis.readGit = () => git(['a.ts']);
  const sent = [];
  let fail = false;
  globalThis.storeBridge = async (method, params) => {
    if (method === 'sendTurn' || method === 'steerTurn') { if (fail) throw new Error('offline'); sent.push([method, JSON.stringify(params)]); return { turnId: 't1' }; }
    return {};
  };
  store.setState({ selectedSessionId: 's1', composer: 'half-written thought', threads: [{ sessionId: 's1', workspacePath: '/repo', title: 'Work', status: 'idle', opened: true, items: [] }] });
  const comment = { path: 'a.ts', line: 4, removed: false, context: '@@ -1 +1 @@\n+x', text: 'Use a constant' };
  store.getState().addLineComment(comment);
  store.getState().addLineComment({ ...comment, line: 9, text: 'And here' });
  assert.equal(store.getState().lineComments['thread:s1'].length, 2);
  store.getState().removeLineComment(store.getState().lineComments['thread:s1'][1].id);
  fail = true;
  await assert.rejects(store.getState().sendLineComments());
  assert.equal(store.getState().lineComments['thread:s1'].length, 1, 'a failed send keeps the comments');
  assert.equal(store.getState().composer, 'half-written thought');
  fail = false;
  store.setState({ error: null, threads: store.getState().threads.map((thread) => ({ ...thread, error: null, status: 'idle', pendingTurnKey: null })) });
  await store.getState().sendLineComments();
  assert.equal(sent.length, 1); assert.equal(sent[0][0], 'sendTurn'); assert.match(sent[0][1], /a\.ts:4 — Use a constant/);
  assert.equal(store.getState().lineComments['thread:s1'], undefined);
  assert.equal(store.getState().composer, 'half-written thought', 'the draft is put back');
  // While a Muse turn runs the comments steer it.
  store.setState({ threads: store.getState().threads.map((thread) => ({ ...thread, status: 'running', activeTurnId: 't1' })) });
  store.getState().addLineComment(comment);
  await store.getState().sendLineComments();
  assert.equal(sent.at(-1)[0], 'steerTurn');
  // An ACP turn cannot take one mid-run; the comments wait.
  store.setState({ threads: store.getState().threads.map((thread) => ({ ...thread, agentId: 'opencode' })) });
  store.getState().addLineComment(comment);
  await assert.rejects(store.getState().sendLineComments(), /Stop the running turn first/);
  assert.equal(store.getState().lineComments['thread:s1'].length, 1);
});

test('zoom changes reach the window once per step and stop at the limits', async () => {
  const store = await frontendStore(); globalThis.zoomCalls = [];
  store.getState().zoomBy(1); store.getState().zoomBy(1); store.getState().zoomBy(0); store.getState().zoomBy(0);
  assert.deepEqual(globalThis.zoomCalls, [1.1, 1.25, 1], 'resetting at actual size does nothing');
  store.setState({ zoom: 2 }); store.getState().zoomBy(1);
  assert.equal(globalThis.zoomCalls.length, 3); assert.equal(store.getState().zoom, 2);
});

test('handoff applies a worktree thread through its own grant, only after a confirm, and reports the outcome on the thread', async () => {
  const store = await frontendStore(); workspace(store);
  globalThis.readGit = () => git([]);
  store.setState({ workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }] });
  const worktree = { grantId: 'wt1', path: '/worktrees/one', branch: 'muse/one', base: 'main', workspaceId: 'w' };
  const row = (extra = {}) => ({ sessionId: 's1', workspacePath: '/repo', title: 'wt', status: 'idle', opened: true, items: [], worktree, ...extra });
  const calls = []; let answer = false;
  globalThis.handoffWorktree = async (grant) => { calls.push(grant); return { files: 2, snapshot: git([]) }; };
  store.setState({ selectedSessionId: 's1', threads: [row()], confirm: async () => answer });
  await store.getState().handoffWorktree();
  assert.deepEqual(calls, [], 'declining the confirm applies nothing');
  answer = true;
  await store.getState().handoffWorktree();
  assert.deepEqual(calls, ['wt1']);
  assert.match(store.getState().threads[0].notice.message, /Applied 2 files to repo as uncommitted changes/);
  globalThis.handoffWorktree = async () => { throw new Error('do not apply cleanly. Nothing was changed.'); };
  await store.getState().handoffWorktree();
  assert.equal(store.getState().threads[0].notice.level, 'warning'); assert.match(store.getState().threads[0].notice.message, /Nothing was changed/);
  store.setState({ threads: [row({ status: 'running' })] });
  calls.length = 0; globalThis.handoffWorktree = async (grant) => { calls.push(grant); return { files: 1, snapshot: git([]) }; };
  await store.getState().handoffWorktree();
  assert.deepEqual(calls, [], 'a running turn is not handed off mid-write');
  store.setState({ threads: [row({ worktree: undefined })] });
  await store.getState().handoffWorktree();
  assert.deepEqual(calls, [], 'a Local thread has nothing to hand off');
});

test('pending line comments survive a relaunch and go with a deleted thread', async () => {
  const store = await frontendStore(); workspace(store);
  globalThis.readGit = () => git([]);
  store.setState({ selectedSessionId: 's1', threads: [{ sessionId: 's1', workspacePath: '/repo', title: 'Work', status: 'idle', opened: true, items: [] }] });
  store.getState().addLineComment({ path: 'a.ts', line: 4, removed: false, context: '@@', text: 'Rename' });
  let document = null;
  globalThis.persistStoreDocument = async (json) => { document = JSON.parse(json); };
  store.getState().addLineComment({ path: 'a.ts', line: 9, removed: true, context: '@@', text: 'And this' });
  await flushMemorySave();
  globalThis.persistStoreDocument = undefined;
  assert.deepEqual(document.sessionMemory.lineComments['thread:s1'].map((comment) => comment.text), ['Rename', 'And this']);
  store.getState().deleteThread('s1');
  assert.equal(store.getState().lineComments['thread:s1'], undefined);
});


// DES-UX-003: hiding an agent hides its sidebar rows — it must not close the
// thread the user is reading or delete its data.
test('disabling an agent keeps the open thread open and its record intact', async () => {
  const store = await frontendStore(true, {
    '@tauri-apps/api/core': `export const invoke = async () => undefined; export const addPluginListener = async () => ({ unregister: () => {} });`,
  });
  workspace(store);
  globalThis.readGit = () => git([]);
  store.setState({
    selectedSessionId: 's1',
    enabledAgents: { grok: true },
    threads: [{ sessionId: 's1', workspacePath: '/repo', title: 'Grok thread', status: 'idle', opened: true, items: [], agentId: 'grok' }],
  });
  await store.getState().commitSettings({ enabledAgents: { grok: false } });
  assert.equal(store.getState().selectedSessionId, 's1', 'the open thread stays open — the user did not ask to lose their place');
  assert.ok(store.getState().threads.some((thread) => thread.sessionId === 's1' && thread.agentId === 'grok'),
    'the thread record survives; only sidebar filtering hides it');
  // Re-enabling does not need the selection to come back — it was never cleared.
  await store.getState().commitSettings({ enabledAgents: { grok: true } });
  assert.equal(store.getState().selectedSessionId, 's1');
});

// ENG-DATA-003: drafts keep image name/type references after a restart but the
// bytes were never written — hydrate must say so instead of implying the
// attachment survived.
test('a draft whose image bytes were stripped on save reports what to re-attach', async () => {
  globalThis.storeRepair = { status: 'ok' };
  globalThis.persistedData = { sessionMemory: { version: 1, drafts: { 'thread:s1': { text: 'with shot', images: [], droppedImages: [{ mediaType: 'image/png', name: 'shot.png' }] } } } };
  const store = await frontendStore(true, hydrateStubs);
  try {
    await store.getState().hydrate();
    assert.match(store.getState().persistNotice, /1 image attachment was not kept across the restart/);
    assert.deepEqual(store.getState().drafts['thread:s1'].images, [], 'no phantom attachment is resurrected');
    // A routine successful save must not wipe the notice: only the failure
    // banner belongs to notePersistResult.
    globalThis.persistStoreDocument = async () => {};
    store.getState().setDockOpen(false);
    await flushMemorySave();
    assert.match(store.getState().persistNotice, /not kept across the restart/);
    store.getState().dismissPersistNotice();
    assert.equal(store.getState().persistNotice, null);
  } finally {
    globalThis.storeRepair = undefined;
    globalThis.persistedData = {};
  }
});
