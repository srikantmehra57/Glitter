import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-delta-batching-'));
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

const storeReplacements = {
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
    export const gitInit=async()=>globalThis.discardedGit;
    export const trustPreview=async()=>globalThis.trustPreviewResult ?? { skills: [], rules: null };
    export const listWorkspaceFiles=async()=>globalThis.fileIndexPaths ?? [];
    export const cliLogout=async()=>{globalThis.cliLoggedOut=true;};
    export const pluginList=async()=>globalThis.pluginEntries ?? [];
    export const skillList=async()=>globalThis.skillEntries ?? [];
    export const projectInit=async(...args)=>globalThis.runProjectInit(...args);
    export const enterpriseStatus=async()=>globalThis.enterpriseFixture ?? { generation: null, sources: [] };
    export const pickPluginBundle=async()=>globalThis.pickedBundle ?? null;
    export const pluginInstall=async(path)=>{globalThis.installedBundles.push(path);};
    export const pickSkillSource=async()=>globalThis.pickedSkill ?? null;
    export const skillInstall=async(path)=>{globalThis.installedSkills.push(path);return 'installed';};
    export const skillImport=async(from,dryRun)=>{globalThis.importCalls.push([from,dryRun]);return dryRun?'preview':'done';};
    export const skillUninstall=async(id)=>{globalThis.uninstalledSkills.push(id);return 'removed';};`,
};
async function frontendStore() {
  globalThis.window = { setTimeout, clearTimeout, matchMedia: () => ({ matches: false }) };
  globalThis.document = { documentElement: { dataset: {}, style: { setProperty(name, value) { this[name] = value; } } } };
  globalThis.storeBridge = async () => ({});
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  const module = await bundle('apps/desktop/src/lib/store.ts', storeReplacements);
  module.bindBridgeEvents();
  return {
    store: module.useAppStore,
    flushDeltasForTest: module.flushDeltasForTest,
    flushFrames: () => { for (const fn of frames.splice(0)) fn(); },
  };
}
const thread = (id, items = []) => ({ sessionId: id, workspacePath: '/repo', title: 'Old', status: 'running', unread: false, items });

test('deltas for an existing item apply once per frame, concatenated in order', async () => {
  const { store, flushFrames } = await frontendStore();
  store.setState({
    selectedSessionId: 's1',
    threads: [thread('s1', [{ itemId: 'i1', kind: 'agentMessage', status: 'inProgress', text: '' }])],
  });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  globalThis.storeEvent('delta', { sessionId: 's1', itemId: 'i1', delta: 'Hello' });
  globalThis.storeEvent('delta', { sessionId: 's1', itemId: 'i1', delta: ', ' });
  globalThis.storeEvent('delta', { sessionId: 's1', itemId: 'i1', delta: 'world' });
  assert.equal(notifications, 0);
  assert.equal(store.getState().threads[0].items[0].text, '');
  flushFrames();
  assert.equal(notifications, 1);
  assert.equal(store.getState().threads[0].items[0].text, 'Hello, world');
  unsubscribe();
});

test('deltas buffered before the item event land through pendingDeltas', async () => {
  const { store } = await frontendStore();
  store.setState({ selectedSessionId: 's1', threads: [thread('s1')] });
  globalThis.storeEvent('delta', { sessionId: 's1', itemId: 'i1', delta: 'early ' });
  globalThis.storeEvent('delta', { sessionId: 's1', itemId: 'i1', delta: 'text' });
  // The item event flushes the buffer synchronously, then applyItem merges it in.
  globalThis.storeEvent('item', { sessionId: 's1', item: { itemId: 'i1', kind: 'agentMessage', status: 'inProgress' } });
  assert.equal(store.getState().threads[0].items[0].text, 'early text');
});

test('a non-delta event applies buffered deltas before it is handled', async () => {
  const { store } = await frontendStore();
  store.setState({
    selectedSessionId: 's1',
    threads: [thread('s1', [{ itemId: 'i1', kind: 'agentMessage', status: 'inProgress', text: '' }])],
  });
  const seen = [];
  const unsubscribe = store.subscribe((state) => {
    seen.push({ text: state.threads[0].items[0].text, title: state.threads[0].title });
  });
  globalThis.storeEvent('delta', { sessionId: 's1', itemId: 'i1', delta: 'streamed' });
  globalThis.storeEvent('sessionTitle', { sessionId: 's1', title: 'New title' });
  assert.deepEqual(seen, [
    { text: 'streamed', title: 'Old' },
    { text: 'streamed', title: 'New title' },
  ]);
  unsubscribe();
});

test('output deltas append to visibleOutput, unknown fields are ignored', async () => {
  const { store, flushFrames, flushDeltasForTest } = await frontendStore();
  store.setState({
    selectedSessionId: 's1',
    threads: [thread('s1', [{ itemId: 'i1', kind: 'toolCall', status: 'inProgress' }])],
  });
  globalThis.storeEvent('delta', { sessionId: 's1', itemId: 'i1', delta: 'out1', field: 'output' });
  globalThis.storeEvent('delta', { sessionId: 's1', itemId: 'i1', delta: '+out2', field: 'output' });
  globalThis.storeEvent('delta', { sessionId: 's1', itemId: 'i1', delta: 'ignored', field: 'reasoning' });
  flushDeltasForTest();
  const item = store.getState().threads[0].items[0];
  assert.equal(item.visibleOutput, 'out1+out2');
  assert.equal(item.text, undefined);
  // The manual frame queue still holds the scheduled flush; it is a no-op now.
  flushFrames();
  assert.equal(store.getState().threads[0].items[0].visibleOutput, 'out1+out2');
});
