import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The renderer half of the device-code sign-in had no coverage: tests/login.test.mjs
// pins the bridge's emission and tests/bridge-dispatch.test.mjs the transport, but
// nothing consumed the store side. A renamed 'loginDone' handler string or a
// dropped loginBusy reset passed every gate while the panel stayed on
// "Waiting for Muse…" forever.
const temporary = await mkdtemp(join(tmpdir(), 'muse-login-store-'));
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

const storeReplacements = {
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
    export const onWindowCloseRequested=()=>()=>{};
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
    export const catalogList=async()=>({entries:[],skillsRoot:'',error:null});export const catalogInstall=async()=>({installedSkills:[],installedServers:[],skipped:[],errors:[]});export const catalogRemove=async()=>({removed:[],skipped:[],errors:[]});
    export const projectInit=async()=>({});
    export const enterpriseStatus=async()=>({ generation: null, sources: [] });
    export const pickPluginBundle=async()=>null;export const pluginInstall=async()=>{};
    export const pickSkillSource=async()=>null;export const skillInstall=async()=>'installed';
    export const skillImport=async()=>'done';export const skillUninstall=async()=>'removed';`,
};

async function frontendStore(tauri = true) {
  globalThis.window = { setTimeout, clearTimeout, matchMedia: () => ({ matches: false }), ...(tauri ? { __TAURI_INTERNALS__: {} } : {}) };
  globalThis.document = { documentElement: { dataset: {}, style: { setProperty(name, value) { this[name] = value; } } } };
  globalThis.storeBridge = async () => ({});
  globalThis.discardCalls = [];
  const module = await bundle('apps/desktop/src/lib/store.ts', storeReplacements);
  module.bindBridgeEvents();
  return module.useAppStore;
}

const PROMPT = { url: 'https://muse.example/device', code: 'WXYZ-1234' };

test('startLogin sends the configured binary and holds the returned code on screen', async () => {
  const store = await frontendStore();
  const calls = [];
  globalThis.storeBridge = async (method, params) => { calls.push([method, params]); return method === 'startLogin' ? PROMPT : {}; };
  store.setState({ museBin: '/usr/local/bin/muse', preview: false });

  await store.getState().startLogin();

  assert.deepEqual(calls, [['startLogin', { museBin: '/usr/local/bin/muse' }]]);
  assert.deepEqual(store.getState().loginPrompt, PROMPT);
  assert.equal(store.getState().loginBusy, false);
  assert.equal(store.getState().loginError, null);
});

test('a sign-in already waiting cannot be doubled, and preview never starts one', async () => {
  const store = await frontendStore();
  const waiting = deferred();
  const calls = [];
  globalThis.storeBridge = async (method, params) => { calls.push(method); return method === 'startLogin' ? waiting.promise : {}; };

  const starting = store.getState().startLogin();
  assert.equal(store.getState().loginBusy, true, 'the button reads "Waiting for Muse…" while the code is fetched');
  await store.getState().startLogin();
  waiting.resolve(PROMPT);
  await starting;
  assert.deepEqual(calls, ['startLogin'], 'a second click during the wait must not spawn another login');
  assert.equal(store.getState().loginBusy, false);
  assert.deepEqual(store.getState().loginPrompt, PROMPT);

  store.setState({ preview: true });
  await store.getState().startLogin();
  assert.deepEqual(calls, ['startLogin'], 'the browser preview never shells out for a login');
});

test('a failed sign-in surfaces the error and releases the busy state', async () => {
  const store = await frontendStore();
  globalThis.storeBridge = async () => { throw new Error('muse is not installed'); };
  await store.getState().startLogin();
  assert.equal(store.getState().loginError, 'Could not sign in: muse is not installed');
  assert.equal(store.getState().loginBusy, false);
  assert.equal(store.getState().loginPrompt, null);

  // An answer missing its url or code is an error, not a half-rendered panel.
  globalThis.storeBridge = async () => ({ url: 'https://muse.example/device' });
  await store.getState().startLogin();
  assert.equal(store.getState().loginError, 'Could not sign in: Muse did not show a sign-in code.');
  assert.equal(store.getState().loginBusy, false);
});

test('cancelling sign-in clears the prompt and releases the CLI even when it refuses', async () => {
  const store = await frontendStore();
  const calls = [];
  globalThis.storeBridge = async (method) => { calls.push(method); throw new Error('already finished'); };
  store.setState({ loginPrompt: PROMPT, loginError: 'stale' });

  await store.getState().cancelLogin();

  assert.deepEqual(calls, ['cancelLogin'], 'the CLI attempt is cancelled server-side, not just hidden');
  assert.equal(store.getState().loginPrompt, null);
  assert.equal(store.getState().loginError, null, 'cancelling is not an error to show');
});

test('loginDone clears the prompt and re-detects the now-signed-in agent', async () => {
  const store = await frontendStore();
  const calls = [];
  globalThis.storeBridge = async (method) => { calls.push(method); return method === 'detect' ? { found: true, authenticated: true, agents: [] } : {}; };
  store.setState({ loginPrompt: PROMPT, loginError: 'earlier failure', preview: false });

  globalThis.storeEvent('loginDone', {});
  await new Promise(setImmediate);

  assert.equal(store.getState().loginPrompt, null);
  assert.equal(store.getState().loginError, null);
  assert.equal(calls[0], 'detect', 'a completed sign-in re-reads the agent so the account state refreshes');
});

test('loginError drops the prompt and keeps the message for the alert slot', async () => {
  const store = await frontendStore();
  globalThis.storeBridge = async () => ({});
  store.setState({ loginPrompt: PROMPT });

  globalThis.storeEvent('loginError', { error: 'The code expired — start again.' });
  assert.equal(store.getState().loginPrompt, null);
  assert.equal(store.getState().loginError, 'The code expired — start again.');

  globalThis.storeEvent('loginError', {});
  assert.equal(store.getState().loginError, 'Sign-in failed.', 'a bare failure event still explains itself');
});
