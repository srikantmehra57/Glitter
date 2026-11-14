import { create } from "zustand";
import { estimateTurnTokens, planAnchorFor, relativeToWorkspace, stepFromItem } from "./agent";
import { readTokenSpeed, recordTokenSpeed } from "./tokenSpeed";
import { LazyStore } from "@tauri-apps/plugin-store";
import { SettingsPersistence, settingsFields } from "./settingsPersistence";
import { effectiveProtectedPaths, normalizeHarnessRules } from "./permissionRules";
import { composeLineComments, LINE_COMMENT_LIMIT, type LineComment } from "./lineComments";
import { rememberCommand } from "./palette";
import { menuAccelerators } from "./shortcuts";
import { buildSuggestionPrompt, cheapestModel, parseSuggestions, suggestionSignature, SUGGESTION_BRIDGE_TIMEOUT_MS, SUGGESTION_BUDGET_MS, SUGGESTION_MIN_GAP_MS, SUGGESTION_TTL_MS } from "./suggestions";
import { stepZoom } from "./zoom";
import { asLedger, compact, EMPTY_LEDGER, recordTurn, turnEntry, type UsageLedger } from "./usageLedger";
import { persistableDrafts, rememberPrompt, NewerSessionMemoryError, SessionMemoryPersistence, SESSION_MEMORY_VERSION, type Draft, type SessionMemory, type ThreadMeta } from "./sessionMemory";
import { bridge, catalogInstall, catalogList, catalogRemove, githubInstall, libraryCheckUpdates, libraryList, libraryRemove, librarySetEnabled, marketplaceAdd, marketplaceAvatars, marketplaceRefresh, marketplaceRemove, gitCommit, gitDiscardAll, gitDiscardFiles, gitDiscardHunk, gitGraph as readGitGraph, gitInit, gitReview, gitBranches, gitPull, gitPullRequest, gitPush, gitSnapshot, gitStage, gitSwitch, gitWorktreeCreate, gitWorktreeHandoff, gitWorktreeRemove, turnSnapshots, restoreTurnSnapshot, forgetTurnSnapshots, listWorkspaceFiles, listProviderModels, modelLibraryList, modelLibraryPut, modelLibraryRemove, MOCK_FILES, mockThreads, mockWorkspaceFile, mockWorktree, providerKeysGet, readWorkspaceFile, onBridgeEvent, onWindowCloseRequested, persistStoreDocument, preserveLegacyMuseKey, pickFolder, readDroppedPaths, removeGrant, repairStoreDocument, setInterfaceZoom, setWindowAppearance, setMenuShortcuts, setWorkspaceTrust, trustPreview, verifyGrants, type BridgeEventPayloads } from "./bridge";
import { MOCK_AGENTS, MOCK_GIT, MOCK_GIT_GRAPH, MOCK_MODELS, mockGitReview } from "./mock";
import { KEYED_PROVIDER_IDS, type ProviderStatus } from "./providers";
import { clampTier, modelFor, tiersFor } from "./effort";
import { orchestratorStart } from "./orchestrator";
import { dropHunk, parseUnifiedDiff, reviewTarget } from "./diff";
import { MAX_DROP_FILES, MAX_IMAGE_BYTES, refPathForDrop } from "./drop";
import { describeError, isGrantError, timeoutUnknown } from "./errors";
import { log } from "./logger";
import { commitDraftPrompt, commitSubjectFromReply, parseSkillInvocation } from "./composerText";
import { continuationPrompt } from "./continuation";
import { composePrompt, humanizeToolName, isMacPlatform, isTauri, nextAttentionThread, timeFilterCutoff, titleFromText, uid, untitledThreadTitle, workspaceName } from "./format";
import { notify, shouldNotify } from "./notify";
import { DOCK_DEFAULT_WIDTH, normalizeDockWidth, normalizeSidebarWidth } from "./reviewLayout";
import { resolveTheme, type ThemeSettings } from "./theme";
import {
  DEFAULT_SETTINGS,
  approvalModeForAgent,
  type AgentId,
  type AgentInfo,
  type AgentSessionConfig,
  type ApprovalRequest,
  type Detection,
  type GitSnapshot,
  type GitGraph,
  type GitReview,
  type ReviewScope,
  type PlanItem,
  type Settings,
  type Thread,
  type TranscriptItem,
  type DockTab,
  type GitBranch,
  type PullRequest,
  type ThreadWorktree,
  type WorkspaceFile,
  type Workspace,
  type ComposerImage, type ContextRef, type HostInfo, type Model, type ModelTestResult, type SessionConfig, type SessionMetadata, type SessionPreview, type UserModelEntry,
  type UserInputResponse, type TokenUsage, type SubagentResult, type Suggestion, type TrustPreview, type SkillRow, type HarnessMcpStatus, type HarnessMcpConfig, type HarnessMcpScope, type HarnessMcpServerInput, type CatalogEntry, type CatalogInstallResult, type CatalogRemoveResult, type MarketplaceSource, type PluginInstallOutcome, type PluginLibrary, type PluginUpdate, type SettingsTab, type BrowserControlInput, type BrowserControlResult, type BrowserFrame, type BrowserState, type BrowserStateEvent, type OrchestratorModel, type OrchestratorProbeResult, type OrchestratorRole, type OrchestratorShape,
} from "./types";

const persist = isTauri() ? new LazyStore("glitter.json", { autoSave: false, defaults: {} }) : null;
/**
 * `tauri-plugin-store` saves with a bare truncate-and-write, so a crash mid-save
 * can leave `glitter.json` half-written — silently destroying every draft
 * and thread title. Keep the plugin as the in-memory cache and reader, but route
 * saves through the native atomic writer (temp file + rename + `.bak`).
 */
const persistentStore: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<unknown>; save(): Promise<unknown> } | null = persist ? {
  get: <T,>(key: string) => persist.get<T>(key),
  set: (key: string, value: unknown) => persist.set(key, value),
  save: async () => {
    const entries = await persist.entries<unknown>();
    await persistStoreDocument(JSON.stringify(Object.fromEntries(entries)));
  },
} : null;

const settingsPersistence = persistentStore ? new SettingsPersistence(persistentStore, preserveLegacyMuseKey) : null;
const memoryPersistence = new SessionMemoryPersistence(persistentStore, typeof localStorage === "undefined" ? null : localStorage);
const pendingDeltas = new Map<string, { at: number; text?: string; output?: string }>();
/** A stashed delta whose `item` never landed is orphaned after this long. */
const DELTA_STASH_TTL_MS = 120_000;
let memoryTimer: ReturnType<typeof setTimeout> | null = null;
const previewTimers = new Map<string, number>();
let hostStart: Promise<boolean> | null = null;
let hydration: Promise<void> | null = null;
/** The rules the running bridge was last told. A new process starts with none, so an exit clears this. */
let harnessRulesApplied: string | null = null;
let harnessRulesGeneration = 0;
let harnessRulesQueue: Promise<void> = Promise.resolve();
/**
 * The newest agent detection still running. The UI no longer waits for it at
 * launch, so anything that needs to know which agents exist (listing threads,
 * choosing an agent for a new one) awaits this first instead of acting on a
 * detection that has not happened yet.
 */
let detectionInFlight: Promise<void> | null = null;
const detectionSettled = () => detectionInFlight?.catch(() => {}) ?? Promise.resolve();
/** A model listing already on its way for this agent/session; a second caller shares it. */
let modelsInFlight: { key: string; promise: Promise<void> } | null = null;
/** The last catalog each agent listed. Switching to a thread on another agent shows it at once while the fresh listing loads. */
const modelCatalogs = new Map<AgentId, Model[]>();
/** Listings started per agent, and the listing that wrote the cached catalog. Two threads
 *  on one agent can list concurrently, and a slower older answer must not win the cache. */
const modelListings = new Map<AgentId, number>();
const modelCatalogAt = new Map<AgentId, number>();
/** Modes the agent offers a new session (build, plan), as its catalog reported them. */
export type AgentModes = { modes: NonNullable<AgentSessionConfig["modes"]>; defaultMode?: string };
async function readModelCatalog(agentId: AgentId, preview: boolean, sessionId?: string, refresh = false, modelId?: string): Promise<{ models: Model[]; modes?: AgentModes }> {
  if (preview) return { models: MOCK_MODELS, modes: { modes: HARNESS_MODES, defaultMode: "build" } };
  // A draft names its picked model, so the agent reports that model's effort levels before any session exists.
  const result = await bridge<{ models: Model[]; modes?: AgentModes["modes"]; defaultMode?: string }>("listModels", { agentId, sessionId, ...(refresh ? { refresh: true } : {}), ...(modelId && !sessionId ? { modelId } : {}) });
  return { models: result.models ?? [], ...(result.modes?.length ? { modes: { modes: result.modes, defaultMode: result.defaultMode } } : {}) };
}
let selectionVersion = 0;
let gitVersion = 0;
let gitGraphVersion = 0;
let reviewVersion = 0;
let modelVersion = 0;
/** Coalesced Changes-pane refresh: one debounce timer, armed with the
 * workspace/grant it was scheduled for, plus a flag for a read owed while
 * `gitLoading` is mid-flight. */
const GIT_REFRESH_DEBOUNCE_MS = 750;
let gitRefreshTimer: ReturnType<typeof setTimeout> | null = null;
/** A refresh owed to one workspace/grant while it is mid-read or mid-write. */
let gitRefreshPending: { workspaceId: string; grantId: string | null } | null = null;
/** In-flight git mutations per workspace+grant: a read must not land on a
 *  write's answer, and an older write must not overwrite a newer one. */
const gitWrites = new Map<string, { count: number; latest: number }>();
const gitWriteKey = (workspaceId: string, grantId: string | null) => `${workspaceId}${grantId ?? ""}`;
const gitWriteCount = (workspaceId: string, grantId: string | null) => gitWrites.get(gitWriteKey(workspaceId, grantId))?.count ?? 0;
function cancelScheduledGitRefresh() {
  if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
  gitRefreshTimer = null;
  gitRefreshPending = null;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * describeError's output may not end in a sentence stop (unrecognized causes
 * keep their own wording); append one more recovery sentence without leaving
 * a stray or doubled period.
 */
const sentenceAfter = (text: string, sentence: string) => {
  const trimmed = text.trimEnd();
  return `${trimmed}${/[.!?]$/.test(trimmed) ? " " : ". "}${sentence}`;
};

/** Fire the refresh a workspace/grant is owed — only if it is still selected. */
function firePendingGitRefresh() {
  const owed = gitRefreshPending;
  gitRefreshPending = null;
  if (!owed) return;
  const state = useAppStore.getState();
  const current = activeWorkspace(state);
  if (!current || current.id !== owed.workspaceId || (current.grantId ?? null) !== owed.grantId) return;
  if (state.gitLoading || gitWriteCount(owed.workspaceId, owed.grantId)) { gitRefreshPending = owed; return; }
  state.scheduleGitRefresh();
}

/**
 * Run one grant-scoped git mutation. A scheduled refresh is cancelled and the
 * write registered under its workspace+grant so schedulers defer and reads
 * raced by it are superseded. The returned snapshot applies only while the
 * workspace/grant+selection still match AND this write is the latest one for
 * it — stale answers never move the global version or another workspace's
 * state. When the workspace/grant is still selected but no write's answer
 * landed, a fresh read is owed once the last write ends.
 */
async function runGitMutation(
  workspace: { id: string; grantId?: string | null },
  selection: number,
  call: () => Promise<GitSnapshot>,
  after?: () => void,
): Promise<void> {
  cancelScheduledGitRefresh();
  // The token doubles as the write's request identity and the "latest"
  // marker; bumping the version here invalidates reads already in flight.
  const token = ++gitVersion;
  const grantId = workspace.grantId ?? null;
  const key = gitWriteKey(workspace.id, grantId);
  const entry = gitWrites.get(key) ?? { count: 0, latest: 0 };
  entry.count += 1;
  entry.latest = token;
  gitWrites.set(key, entry);
  /** The captured workspace/grant is still the selected one. */
  const current = () => {
    const state = useAppStore.getState();
    const live = activeWorkspace(state);
    return state.selectedWorkspaceId === workspace.id
      && live?.id === workspace.id
      && (live?.grantId ?? null) === grantId;
  };
  /** Applies only when nothing newer displaced the write: same workspace,
   *  same grant, same selection generation, and this is the latest write. */
  const applies = () => current()
    && selection === selectionVersion
    && gitWrites.get(key)?.latest === token;
  ++gitGraphVersion;
  useAppStore.setState({ gitLoading: true, gitError: null, review: null, reviewError: null, gitGraph: null, gitGraphLoading: null, gitGraphError: null });
  let applied = false;
  try {
    const git = await call();
    if (applies()) {
      // Reads that started while this write ran raced its result — invalidate
      // them before the write's authoritative snapshot lands. A stale answer
      // from another workspace/grant/selection never advances the version.
      ++gitVersion;
      useAppStore.setState({ git, gitError: null, gitLoading: false });
      applied = true;
      after?.();
    }
  } finally {
    const live = gitWrites.get(key);
    if (live) {
      live.count -= 1;
      if (live.count <= 0) gitWrites.delete(key);
    }
    // Clear the spinner only while this write still owns it: the workspace
    // and grant match and nothing newer (read or write) started since.
    if (!applied && current() && token === gitVersion) useAppStore.setState({ gitLoading: false });
    if (!gitWrites.get(key)) {
      if (!applied && current()) {
        // Nothing landed for the still-selected workspace/grant (a selection
        // hop, a superseded or a failed write): owe it one fresh read, kept
        // pending while a current read is in flight.
        if (useAppStore.getState().gitLoading) gitRefreshPending = { workspaceId: workspace.id, grantId };
        else useAppStore.getState().scheduleGitRefresh();
      } else {
        firePendingGitRefresh();
      }
    }
  }
}

const draftKey = (state: Pick<AppStore, "selectedSessionId" | "selectedWorkspaceId">) => state.selectedSessionId ? `thread:${state.selectedSessionId}` : `project:${state.selectedWorkspaceId}`;
const defaults = (state: Pick<Settings, "defaultModel" | "defaultProviderId" | "defaultApprovalMode" | "defaultEffort">): SessionConfig => ({
  agentId: "harness",
  ...(state.defaultModel.trim() ? { modelId: state.defaultModel.trim(), providerId: state.defaultProviderId } : {}),
  approvalMode: state.defaultApprovalMode,
  effort: state.defaultEffort,
});
/** The built-in harness's modes, as its bridge reports them (`harness/host.ts`). */
const HARNESS_MODES = [
  { value: "build", name: "Build", description: "Reads, edits files and runs commands, within the permission mode." },
  { value: "plan", name: "Plan", description: "Reads the workspace and plans. File edits are refused." },
];
const metadataConfig = (session: SessionMetadata, effort: SessionConfig["effort"]): SessionConfig => ({
  ...(session.modelId ? { modelId: session.modelId, providerId: session.providerId ?? undefined } : {}),
  approvalMode: session.approvalMode?.mode,
  effort,
});
function switchDraft(state: AppStore, workspaceId: string | null, sessionId: string | null) {
  const drafts = { ...state.drafts, [draftKey(state)]: { ...state.drafts[draftKey(state)], text: state.composer, images: state.images, refs: state.contextRefs } };
  const target = draftKey({ selectedWorkspaceId: workspaceId, selectedSessionId: sessionId });
  return { drafts, selectedWorkspaceId: workspaceId, selectedSessionId: sessionId, composer: drafts[target]?.text ?? "", images: drafts[target]?.images ?? [], contextRefs: drafts[target]?.refs ?? [] };
}

type AppStore = Settings & {
  ready: boolean;
  /**
   * The UI is up but the last session is still being restored in the background
   * (agent detection, host start, thread listing, reopening the last thread).
   * Surfaces that would otherwise read as "nothing found" show a loading state.
   */
  booting: boolean;
  /** The session id being reopened by the background restore, so its pane can say so instead of offering a blank thread. */
  restoringSession: string | null;
  /** Agent detection has settled at least once, whether it found anything or failed. */
  detectionChecked: boolean;
  preview: boolean;
  detection: Detection | null;
  /** Provider keychain status: connected built-ins, and the custom endpoints with their names. */
  providerStatus: ProviderStatus[] | null;
  /** The Providers page's read error; other surfaces fall back to ids alone. */
  providerStatusError: string | null;
  /** Re-read the provider keychain status (connection, key hint, custom names and wires). */
  refreshProviders: () => Promise<void>;
  /** The model library: the entries the user added, as the harness persists them. */
  modelLibrary: UserModelEntry[] | null;
  /** The model library's read error; the page shows it instead of an empty list. */
  modelLibraryError: string | null;
  /** Read the library and refresh the models the pickers list from it. */
  refreshModelLibrary: () => Promise<void>;
  /** Add or update one library entry; the answer becomes the library. */
  putModelEntry: (entry: Omit<UserModelEntry, "source" | "addedAt">) => Promise<void>;
  /** Remove one library entry by its full `provider/model` id. */
  removeModelEntry: (modelId: string) => Promise<void>;
  /** One provider's own listing for the add-model dialog's suggestions. */
  fetchProviderModels: (providerId: string, refresh?: boolean) => Promise<Model[]>;
  /** What the agent process reported when it started; null while it is not running. */
  hostInfo: HostInfo | null;
  /** Session-list time filter (`updatedAfter`) and all-workspace listing. */
  listSince: null | "day" | "week" | "month";
  showAllWorkspaces: boolean;
  setListSince: (value: null | "day" | "week" | "month") => void;
  setShowAllWorkspaces: (value: boolean) => void;
  /** Trust decision dialog state for one workspace. */
  trustDialog: { workspaceId: string; loading: boolean; error: string | null; preview: TrustPreview | null } | null;
  openTrustDialog: (workspaceId: string, prefetched?: TrustPreview) => Promise<void>;
  closeTrustDialog: () => void;
  /** First-open trust prompt: previews a workspace's skills/rules and opens the trust dialog once. */
  promptWorkspaceTrust: (workspaceId: string) => Promise<void>;
  /** File paths for @-mentions in the selected workspace (git ls-files / bounded walk). */
  fileIndex: { workspaceId: string; paths: string[]; loadedAt: number } | null;
  /** Debounced (2s) index refresh, rate-limited to one fetch per 10s. */
  refreshFileIndex: (workspaceId?: string) => void;
  /** Predicted starters for the empty state, generated for `workspaceId` from the state at `signature`. */
  suggestions: { workspaceId: string; signature: string; items: Suggestion[]; at: number; agentId?: AgentId } | null;
  /** Regenerate predicted suggestions when the selected workspace's state changed; signature-cached and rate-limited. */
  refreshSuggestions: (force?: boolean) => Promise<void>;
  /** The file open in the Files tab's read-only viewer. */
  fileView: { path: string; loading: boolean; file?: WorkspaceFile; error?: string } | null;
  /** Open a workspace file in the viewer. Takes a workspace-relative path, or an absolute one inside the workspace. */
  openFile: (path: string) => Promise<void>;
  closeFile: () => void;
  confirmDialog: { title: string; body?: string; confirmLabel: string; danger: boolean; info?: boolean; resolve: (ok: boolean) => void } | null;
  /** `info` makes it an acknowledgement: one button, no Cancel. */
  confirm: (options: { title: string; body?: string; confirmLabel?: string; danger?: boolean; info?: boolean }) => Promise<boolean>;
  resolveConfirm: (ok: boolean) => void;
  confirmTrust: () => Promise<void>;
  untrustWorkspace: (workspaceId: string) => Promise<void>;
  openLastThread: () => Promise<void>;
  /** Refresh the session skill catalog (`skill/list`). */
  refreshSkills: (sessionId?: string) => Promise<void>;
  /** The Harness's own MCP generation for the thread's workspace; null until loaded. */
  harnessMcp: HarnessMcpStatus | null;
  harnessMcpLoading: string | null;
  harnessMcpError: string | null;
  refreshHarnessMcp: (sessionId: string, refresh?: boolean) => Promise<void>;
  /** The config rows behind `harnessMcp`, including servers the parser refused; null until loaded. */
  harnessMcpConfig: HarnessMcpConfig | null;
  harnessMcpConfigLoading: string | null;
  harnessMcpConfigError: string | null;
  refreshHarnessMcpConfig: (sessionId: string) => Promise<void>;
  /** Write a server to the workspace or home config, then reconnect the generation. */
  addHarnessMcpServer: (sessionId: string, scope: HarnessMcpScope, server: HarnessMcpServerInput) => Promise<void>;
  /** Remove a server from the file that defines it, then reconnect the generation. */
  removeHarnessMcpServer: (sessionId: string, scope: HarnessMcpScope, name: string) => Promise<void>;
  /** The bundled extension store: curated skills, MCP servers and skill bundles, installed without a CLI. */
  catalogEntries: CatalogEntry[];
  /** Where store-installed skills land, for the store's footnote. */
  catalogSkillsRoot: string | null;
  catalogLoading: boolean;
  catalogError: string | null;
  refreshCatalog: () => Promise<void>;
  /** Install one entry, then refresh the store and, when a Harness thread is open, its skills and MCP generation. */
  installCatalogEntry: (id: string, sessionId?: string) => Promise<CatalogInstallResult>;
  removeCatalogEntry: (id: string, sessionId?: string) => Promise<CatalogRemoveResult>;
  /** Plugins installed from GitHub and the marketplaces added as sources (`library_list`). */
  library: PluginLibrary | null;
  libraryLoading: boolean;
  libraryError: string | null;
  /** Installed plugins and sources whose branch on GitHub has moved on. */
  libraryUpdates: PluginUpdate[];
  refreshLibrary: () => Promise<void>;
  /** Install what a GitHub preview fetched, then refresh the library, the store and an open Harness thread. */
  installLibraryPlugin: (token: string, selected?: string[] | null, sessionId?: string) => Promise<PluginInstallOutcome>;
  setLibraryPluginEnabled: (id: string, enabled: boolean, sessionId?: string) => Promise<PluginInstallOutcome>;
  removeLibraryPlugin: (id: string, sessionId?: string) => Promise<string[]>;
  addMarketplace: (token: string) => Promise<MarketplaceSource>;
  refreshMarketplace: (id: string) => Promise<MarketplaceSource>;
  removeMarketplace: (id: string) => Promise<void>;
  checkLibraryUpdates: () => Promise<PluginUpdate[]>;
  /** The agent as detection last reported it. */
  agents: AgentInfo[];
  settingsOpen: boolean;
  /** Last visited Settings tab, also used by explicit navigation links. */
  settingsTab: SettingsTab;
  /** When set, Usage filters its trajectory to this thread and offers an all-threads reset. */
  trajectoryThreadId: string | null;
  openThreadTrajectory: (sessionId: string) => void;
  clearThreadTrajectory: () => void;
  /** Bumped to ask the composer for focus (a new thread is a composer draft). */
  composerFocus: number;
  /** Bumped to ask the thread header to start its inline title edit. */
  titleEditRequest: number;
  requestTitleEdit: () => void;
  dockOpen: boolean;
  dockTab: DockTab;
  /** Persisted preferred dock width; the rendered width clamps to the window. */
  dockWidth: number;
  /** Interface zoom of the desktop window; 1 is actual size. */
  zoom: number;
  /** Step the zoom in (1) or out (-1), or reset it (0). */
  zoomBy: (direction: 1 | -1 | 0) => void;
  /** Transient: the Changes pane takes the whole main area until closed. */
  dockExpanded: boolean;
  selectedWorkspaceId: string | null;
  selectedSessionId: string | null;
  threads: Thread[];
  /** Workspaces whose session listing is in flight; the sidebar shows a loading note. */
  threadsLoading: string[];
  git: GitSnapshot | null;
  gitGraph: { key: string; data: GitGraph } | null;
  gitGraphLoading: string | null;
  gitGraphError: { key: string; message: string } | null;
  reviewScope: ReviewScope;
  reviewBase: string;
  review: { key: string; data: GitReview } | null;
  reviewLoading: string | null;
  reviewError: { key: string; message: string } | null;
  setReviewScope: (scope: ReviewScope) => void;
  setReviewBase: (base: string) => void;
  refreshReview: () => Promise<void>;
  models: Model[];
  modelsLoading: boolean;
  modelsError: string | null;
  /** The agent's session modes from its catalog, so a draft can offer them before a session exists. */
  agentModes: Partial<Record<AgentId, AgentModes>>;
  gitLoading: boolean;
  gitError: string | null;
  starting: boolean;
  submitting: boolean;
  drafts: Record<string, Draft>;
  promptHistory: Record<string, string[]>;
  threadMeta: Record<string, ThreadMeta>;
  threadSearch: string;
  /** The sidebar's search field is shown: opened from its icon, the shortcut or the palette. */
  threadSearchOpen: boolean;
  sidebarCollapsed: boolean;
  /** Persisted dragged sidebar width; null is the default. The rendered width clamps to the window. */
  sidebarWidth: number | null;
  paletteOpen: boolean;
  offline: boolean;
  inspectorTab: DockTab;
  showArchived: boolean;
  refreshModels: (refresh?: boolean) => Promise<void>;
  loadModelCatalog: (agentId: AgentId) => Promise<Model[]>;
  /** An agent's catalog from cache when one is held, for the picker's other providers. */
  /** One short request to a Harness model, timed. The model Test in Settings. */
  testModel: (agentId: AgentId, model: Model) => Promise<ModelTestResult>;
  /** One role's fixed capability check against the Harness model Settings assigned it. */
  probeOrchestratorRole: (role: OrchestratorRole, model: OrchestratorModel, options?: { refresh?: boolean }) => Promise<OrchestratorProbeResult>;
  setSessionConfig: (patch: Partial<SessionConfig>) => Promise<void>;
  dismissError: () => void;
  dismissPersistNotice: () => void;
  composer: string;
  images: ComposerImage[];
  contextRefs: ContextRef[];
  addContextRefs: (refs: ContextRef[]) => void;
  removeContextRef: (id: string) => void;
  retryLast: () => Promise<void>;
  continueThread: () => Promise<void>;
  /** Leave an interrupted turn stopped. Does not send a message or replay work. */
  stopRecovery: () => void;
  error: string | null;
  /** REC-002: local persistence failed, or the settings file was recovered after corruption. */
  persistNotice: string | null;
  hydrate: () => Promise<void>;
  save: () => Promise<void>;
  commitSettings: (patch: Partial<Settings>) => Promise<void>;
  /** Rules the harness could not read at the last apply. It ignores them and says why. */
  harnessRuleProblems: string[];
  harnessRulesError: string | null;
  /** Tell the harness host the saved rules. Rejects so a thread cannot run without them. */
  applyHarnessRules: (force?: boolean) => Promise<void>;
  refreshDetection: () => Promise<void>;
  startHost: (restart?: boolean) => Promise<void>;
  chooseProject: () => Promise<void>;
  addWorkspace: (path: string, grantId?: string | null) => Promise<void>;
  removeWorkspace: (id: string) => void;
  renameThread: (sessionId: string, title: string) => void;
  pinThread: (sessionId: string) => void;
  setThreadUnread: (sessionId: string, unread: boolean) => void;
  /** Swap sidebar positions with a neighbouring thread. */
  swapThreadOrder: (sessionId: string, otherId: string) => void;
  /** Persist a drag-reordered thread list; ids are given in the order they now appear. */
  reorderThreads: (sessionIds: string[]) => void;
  archiveThread: (sessionId: string, archived?: boolean) => void;
  deleteThread: (sessionId: string) => void;
  compactThread: () => Promise<void>;
  /** Child drill-down: a delegated child's result and transcript (`readChildSession`). */
  childSession: { sessionId: string; itemId: string; title: string; loading: boolean; error: string | null; result: SubagentResult | null; items: TranscriptItem[] } | null;
  openChild: (sessionId: string, itemId: string) => Promise<void>;
  closeChild: () => void;
  setThreadSearch: (value: string) => void;
  /** Show or hide the sidebar's search field; opening also expands a collapsed sidebar. Closing clears the query. */
  setThreadSearchOpen: (open: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  /** The terminal side panel beside the thread; it shares the panel space with Changes. */
  terminalOpen: boolean;
  setTerminalOpen: (open: boolean) => void;
  /** The shared Chromium side panel. Frames are transient and never persisted. */
  browserOpen: boolean;
  browserState: BrowserState | null;
  browserFrame: BrowserFrame | null;
  browserBusy: boolean;
  browserError: string | null;
  setBrowserOpen: (open: boolean) => void;
  openBrowser: (url?: string, viewport?: { width: number; height: number }) => Promise<void>;
  controlBrowser: (input: BrowserControlInput) => Promise<BrowserControlResult | null>;
  closeBrowser: () => Promise<void>;
  /** The find bar over the open thread. `findFocus` bumps on every request so an open bar takes focus again. */
  findOpen: boolean;
  findFocus: number;
  setFindOpen: (open: boolean) => void;
  /** Open the nth thread of the selected workspace in sidebar order (0-based). */
  selectThreadAt: (index: number) => Promise<void>;
  /** Step to the next (1) or previous (-1) thread of the selected workspace, wrapping. */
  selectAdjacentThread: (delta: 1 | -1) => Promise<void>;
  /** Palette commands run lately, most recent first. */
  recentCommands: string[];
  noteCommand: (id: string) => void;
  setOffline: (offline: boolean) => void;
  setShowArchived: (show: boolean) => void;
  setInspectorTab: (tab: DockTab) => void;
  selectWorkspace: (id: string) => Promise<void>;
  loadWorkspaceThreads: (id: string) => Promise<void>;
  selectThread: (sessionId: string) => Promise<void>;
  /** Open the workspace draft; no session exists until the first send. */
  newThread: () => Promise<void>;
  /** Start a session for the workspace draft now. The first send calls this. */
  /** Starts a session for the workspace draft and resolves to its id, or null when it could not start. */
  createThread: () => Promise<string | null>;
  /** A first message waiting for its session to start, shown in place of the empty new-thread view. */
  pendingSend: { workspaceId: string; text: string; images: ComposerImage[] } | null;
  /** Open the next thread, in sidebar order, that waits on an approval or an answer. */
  selectNextAttentionThread: () => Promise<void>;
  refreshTurnSnapshots: (sessionId: string) => Promise<void>;
  restoreSnapshot: (sessionId: string, turnId: string, options?: { confirmed?: boolean }) => Promise<boolean>;
  sendPrompt: (options?: { resetTaskState?: boolean; disposition?: "queue" | "steer" | "replace"; shape?: OrchestratorShape }) => Promise<boolean>;
  stopTurn: () => Promise<void>;
  unqueueTurn: (turnId: string) => Promise<void>;
  decide: (approvalId: string, choiceId: string, feedback?: string) => Promise<void>;
  pickApprovalScope: (approvalId: string, choiceId: string) => void;
  reclaimApprovalFeedback: (sessionId: string, id: string) => void;
  respondUserInput: (sessionId: string, userInputId: string, response: UserInputResponse) => Promise<void>;
  refreshGit: () => Promise<void>;
  refreshGitGraph: () => Promise<void>;
  /** Coalesce a Changes-pane refresh: armed sources (edit completions, window
   * focus) debounce into a single read instead of one per event. */
  scheduleGitRefresh: () => void;
  /** Initialize git inside the selected workspace after user confirmation. */
  initializeGit: () => Promise<void>;
  discardGitFiles: (paths: string[]) => Promise<void>;
  discardGitHunk: (path: string, hunk: number) => Promise<void>;
  discardAllGit: () => Promise<void>;
  stageGitFiles: (paths: string[], stage: boolean) => Promise<void>;
  commitGit: (message: string, includeUnstaged?: boolean) => Promise<void>;
  /** Diff line comments not yet sent, per thread (or per workspace draft). Saved with session memory. */
  lineComments: Record<string, LineComment[]>;
  addLineComment: (comment: Omit<LineComment, "id">) => void;
  removeLineComment: (id: string) => void;
  /** Send pending comments as one prompt, steering a running Harness turn. */
  sendLineComments: () => Promise<void>;
  /** Apply the open worktree thread's changes to its workspace folder, after a confirm. */
  handoffWorktree: () => Promise<void>;
  /** Local branches of the folder in view, loaded when the branch menu opens. */
  branches: GitBranch[] | null;
  refreshBranches: () => Promise<void>;
  switchBranch: (branch: string, create: boolean) => Promise<void>;
  /** Fast-forward the current branch to its upstream. */
  pullBranch: () => Promise<void>;
  /** Push the current branch. Returns where it went. */
  pushBranch: () => Promise<{ branch: string; remote: string }>;
  /** The current branch's pull request; null until asked for. */
  pullRequest: PullRequest | null;
  pullRequestLoading: boolean;
  refreshPullRequest: (create?: boolean) => Promise<void>;
  /** A commit subject drafted by the agent, for the owning dialog to pick up. */
  commitDraft: { text: string; seq: number; sessionId: string } | null;
  /** The thread whose running turn is drafting a commit message. */
  commitDrafting: string | null;
  draftCommitMessage: (includeUnstaged?: boolean) => Promise<void>;
  /** Every finished turn's tokens, per agent, provider and model (see lib/usageLedger.ts). */
  usageLedger: UsageLedger;
  clearUsageHistory: () => void;
  attachImages: (files: FileList | File[]) => Promise<void>;
  attachDroppedPaths: (paths: string[]) => Promise<void>;
  clearImages: () => void;
  setComposer: (value: string) => void;
  /** Start the workspace's next new thread in its own worktree (`null` for Local). An empty base is the current branch. */
  setDraftWorktree: (worktree: { base: string } | null) => void;
  viewer: { images: ComposerImage[]; index: number } | null;
  openViewer: (images: ComposerImage[], index?: number) => void;
  closeViewer: () => void;
  stepViewer: (delta: number) => void;
  setSettingsOpen: (open: boolean, tab?: SettingsTab) => void;
  setDockOpen: (open: boolean) => void;
  setDockTab: (tab: DockTab) => void;
  setDockWidth: (width: number) => void;
  setSidebarWidth: (width: number | null) => void;
  setDockExpanded: (expanded: boolean) => void;
  /** Explicitly opened diff tabs; null means the dock auto-shows the first file. */
  diffTabs: string[] | null;
  diffActive: string | null;
  openFileDiff: (path: string, keepScope?: boolean) => void;
  closeFileDiff: (path: string) => void;
  setActiveDiff: (path: string | null) => void;
  enterPreview: () => void;
  exitPreview: () => Promise<void>;
};

type PreviewSnapshot = Pick<AppStore, "workspaces" | "selectedWorkspaceId" | "selectedSessionId" | "threads" | "drafts" | "composer" | "images" | "contextRefs" | "git">;
let previewSnapshot: PreviewSnapshot | null = null;

/** Newest approval takes the slot; the displaced one waits (stack order). */
function parkApproval(thread: Thread, request: ApprovalRequest): Thread {
  if (thread.pendingApproval && thread.pendingApproval.approvalId !== request.approvalId) {
    return { ...thread, pendingApproval: request, queuedApprovals: [...(thread.queuedApprovals ?? []), thread.pendingApproval] };
  }
  return { ...thread, pendingApproval: request };
}

/** Clear the slot and surface the newest waiter, if any. */
function advanceApprovals(thread: Thread): Thread {
  const queued = [...(thread.queuedApprovals ?? [])];
  const next = queued.pop() ?? null;
  return { ...thread, pendingApproval: next, queuedApprovals: queued };
}

/** Drop one approval wherever it sits (resolved elsewhere), advancing the slot when hit. */
function dropApproval(thread: Thread, approvalId: string): { thread: Thread; slotted: boolean } {
  const queued = (thread.queuedApprovals ?? []).filter((item) => item.approvalId !== approvalId);
  if (thread.pendingApproval?.approvalId !== approvalId) return { thread: { ...thread, queuedApprovals: queued }, slotted: false };
  const next = queued[queued.length - 1] ?? null;
  return { thread: { ...thread, pendingApproval: next, queuedApprovals: next ? queued.slice(0, -1) : queued }, slotted: true };
}


function countsForTokenSpeed(item: TranscriptItem): boolean {
  return item.kind === "agentMessage" || item.kind === "reasoning";
}

function applyItem(thread: Thread, incoming: TranscriptItem): Thread {
  const buffered = pendingDeltas.get(incoming.itemId);
  if (buffered) {
    pendingDeltas.delete(incoming.itemId);
    incoming = {
      ...incoming,
      text: incoming.text || buffered.text,
      visibleOutput: incoming.visibleOutput || buffered.output,
    };
  }
  const index = thread.items.findIndex((item) => item.itemId === incoming.itemId);
  const items = index >= 0
    ? thread.items.map((item, i) => (i === index ? { ...item, ...incoming } : item))
    : [...thread.items, incoming];
  const user = items.find((item) => item.kind === "userMessage" && item.text);
  // The first generated chunk arrives on the item itself; later chunks are deltas.
  // Completed items are history or a closing snapshot, never new generated text.
  const startsStream = index < 0 && thread.status === "running" && countsForTokenSpeed(incoming) && (incoming.status === "inProgress" || incoming.status === "running");
  const tokenSpeed = startsStream ? recordTokenSpeed(thread.tokenSpeed, incoming.text ?? "", Date.now()) : thread.tokenSpeed;
  return {
    ...thread,
    items,
    tokenSpeed,
    updatedAt: new Date().toISOString(),
    title: thread.customTitle ? thread.title : user?.text ? titleFromText(user.text) : thread.title,
  };
}

function scheduleMemory(get: () => AppStore) {
  if (memoryTimer) clearTimeout(memoryTimer);
  memoryTimer = setTimeout(() => { void persistMemory(get()); }, 200);
}

/** Composer drafts persist on a slower cadence than thread metadata — per-keystroke saves are wasteful. */
let draftTimer: ReturnType<typeof setTimeout> | null = null;

// @-mention file index: debounced refresh, capped at one fetch per 10s.
const FILE_INDEX_DEBOUNCE_MS = 2000;
const FILE_INDEX_MIN_GAP_MS = 10_000;
/** Predicted starters per workspace, keyed by the state signature that produced them. */
const suggestionCache = new Map<string, { signature: string; items: Suggestion[]; at: number }>();
let suggestInFlight: Promise<void> | null = null;
/** A newer snapshot arrived while a run was in flight. One follow-up runs when it finishes. */
let suggestFollowUp: { force: boolean } | null = null;
/** Incomplete snapshots (git or the file index still loading) must not become the cached signature. This only spaces those attempts. */
const incompleteSuggestAt = new Map<string, number>();
/** Bumped per run so a stale answer never lands over a newer workspace's state. */
let suggestRunId = 0;
let fileIndexTimer: ReturnType<typeof setTimeout> | null = null;
let fileIndexLastFetch = 0;
function scheduleDraft(get: () => AppStore) {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { draftTimer = null; void persistMemory(get()); }, 1000);
}

/** Persist now and drop the pending debounce, so a later fire cannot re-save a cleared composer. */
function flushDraft(get: () => AppStore) {
  if (!draftTimer) return;
  clearTimeout(draftTimer);
  draftTimer = null;
  void persistMemory(get());
}

/**
 * Persist now and drop BOTH pending debounces. Wired to the window's teardown
 * signals (pagehide/beforeunload/visibility-hidden and the native
 * close-requested): the 200ms/1000ms debounce timers would otherwise die with
 * the page and the session's last keystrokes would never land on disk. The
 * write itself is best-effort — the webview may be gone before the IPC reply,
 * but the request is posted while it still can be.
 */
function flushPersistedMemory(get: () => AppStore) {
  if (memoryTimer) { clearTimeout(memoryTimer); memoryTimer = null; }
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
  void persistMemory(get());
}

/** The usage ledger is its own document key, saved on its own short debounce. */
const LEDGER_KEY = "usageLedger";
let ledgerTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLedger(get: () => AppStore) {
  if (ledgerTimer) clearTimeout(ledgerTimer);
  ledgerTimer = setTimeout(() => {
    ledgerTimer = null;
    const state = get();
    if (state.preview) return;
    if (persistentStore) void persistentStore.set(LEDGER_KEY, state.usageLedger).then(() => persistentStore.save()).catch((error) => log.warn("usage.save_failed", { error: String(error) }));
    else try { localStorage.setItem(`glitter.${LEDGER_KEY}`, JSON.stringify(state.usageLedger)); } catch { /* no storage: the record lives for this session */ }
  }, 1500);
}

/**
 * Count a thread's finished turn in the usage ledger. A later call for the
 * same turn (usage that lands after the turn ended) updates the entry in
 * place and keeps its original time.
 */
function recordUsage(get: () => AppStore, set: (patch: Partial<AppStore>) => void, sessionId: string) {
  const state = get();
  if (state.preview) return;
  const thread = state.threads.find((item) => item.sessionId === sessionId);
  if (!thread || thread.status === "running") return;
  const entry = turnEntry(thread);
  if (!entry) return;
  const existing = state.usageLedger.turns.find((turn) => turn.key === entry.key);
  // Late reports can add duration, cache or trajectory detail even when the totals match.
  set({ usageLedger: recordTurn(state.usageLedger, existing ? { ...entry, at: existing.at } : entry) });
  scheduleLedger(get);
}

/**
 * Discover shows a listing from another repository with that owner's avatar.
 * The native side fetches the missing ones in the background, once per new or
 * refreshed source, and the library is read again when they arrive.
 */
let listingAvatarsTried = false;
async function fetchListingAvatars(get: () => AppStore) {
  if (listingAvatarsTried) return;
  listingAvatarsTried = true;
  try {
    if (await marketplaceAvatars() > 0) await get().refreshLibrary();
  } catch (error) {
    log.warn("library.avatars_failed", { error: message(error) });
  }
}

async function persistMemory(state: AppStore) {
  if (state.preview) return;
  const threadMeta: Record<string, ThreadMeta> = { ...state.threadMeta };
  for (const thread of state.threads) {
    threadMeta[thread.sessionId] = {
      ...threadMeta[thread.sessionId],
      title: thread.title,
      agentId: thread.agentId,
      customTitle: thread.customTitle,
      pinned: thread.pinned,
      order: thread.order,
      archived: thread.archived,
      unread: thread.unread,
      lastStatus: thread.status,
      lastOutcome: thread.lastOutcome,
      forkedFrom: thread.forkedFrom ?? undefined,
      worktree: thread.worktree,
      deleted: undefined,
    };
  }
  const memory: SessionMemory = {
    version: SESSION_MEMORY_VERSION,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    // Image bytes never enter the document: the live ComposerImage stays in
    // memory for the send path, while the save keeps only name/type refs.
    drafts: persistableDrafts({ ...state.drafts, [draftKey(state)]: { text: state.composer, images: state.images, refs: state.contextRefs, config: state.drafts[draftKey(state)]?.config } }),
    threadMeta,
    promptHistory: state.promptHistory,
    lineComments: state.lineComments,
    recentCommands: state.recentCommands,
    settingsTab: state.settingsTab,
    dockOpen: state.dockOpen,
    dockWidth: state.dockWidth,
    zoom: state.zoom,
    sidebarCollapsed: state.sidebarCollapsed,
    sidebarWidth: state.sidebarWidth,
  };
  try {
    await memoryPersistence.save(memory);
    notePersistResult(true);
  }
  catch (error) {
    log.warn("memory.save_failed", { error: String(error) });
    if (error instanceof NewerSessionMemoryError) {
      noteVersionRefuse();
      return;
    }
    notePersistResult(false);
  }
}

let persistFailures = 0;

const PERSIST_FAILURE_NOTICE = "Drafts and thread titles are not being saved locally. Changes made now may be lost.";
const VERSION_REFUSE_NOTICE = "Your saved drafts and thread titles were written by a newer version of Glitter. This copy is leaving that file unchanged.";

/**
 * REC-002: a save failure must be visible. The composer promises drafts are
 * kept locally, and that promise must not survive the moment it stops being
 * true. The banner appears on the first failure and clears on the next success
 * — but only when the current banner is that failure one: a recovered-document
 * or detached-attachment notice reports something else and must not be wiped
 * by the first routine write landing after hydrate.
 */
function notePersistResult(ok: boolean) {
  persistFailures = ok ? 0 : persistFailures + 1;
  if (ok) {
    if (useAppStore.getState().persistNotice === PERSIST_FAILURE_NOTICE) useAppStore.setState({ persistNotice: null });
  } else if (persistFailures === 1) {
    useAppStore.setState({ persistNotice: PERSIST_FAILURE_NOTICE });
  }
}

/** One notice per launch. A dismissed notice stays dismissed, and a recovery banner is left in place. */
let versionRefuseNoted = false;
function noteVersionRefuse() {
  if (versionRefuseNoted) return;
  const current = useAppStore.getState().persistNotice;
  if (current && current !== VERSION_REFUSE_NOTICE) return;
  versionRefuseNoted = true;
  useAppStore.setState({ persistNotice: VERSION_REFUSE_NOTICE });
}

/** Host session name first, then the last title we saw. */
function listedTitle(session: SessionMetadata, meta?: ThreadMeta): string {
  // Durable `name` is authoritative; derived `title` is the host's display
  // heuristic for sessions without an allocated name (SS2.14.1).
  const name = session.name?.trim() || session.title?.trim();
  if (name) return titleFromText(name);
  return meta?.title?.trim() || untitledThreadTitle(session.updatedAt);
}

function applyMeta(thread: Thread, meta?: ThreadMeta, sessionStatus?: string): Thread {
  if (!meta) return thread;
  const interrupted = meta.lastStatus === "running" && sessionStatus !== "running";
  return {
    ...thread,
    title: meta.customTitle && meta.title ? meta.title : thread.title,
    customTitle: meta.customTitle,
    pinned: meta.pinned,
    order: meta.order ?? thread.order,
    archived: meta.archived,
    unread: meta.unread ?? thread.unread,
    lastOutcome: interrupted ? "interrupted" : meta.lastOutcome,
    forkedFrom: meta.forkedFrom ?? thread.forkedFrom,
    worktree: meta.worktree ?? thread.worktree,
  };
}

/**
 * Reconcile persisted workspaces against the native grant store via
 * verify-only checks (the native side never lists grants). A workspace keeps
 * its grant only when the id is live for the same directory; anything else
 * becomes ungranted (visible, but session/git/open operations fail until the
 * folder is re-opened through the native picker). Verified workspaces heal
 * their stored path to the canonical root, so re-opening re-attaches instead
 * of duplicating.
 */
async function reconcileGrants(workspaces: Workspace[]): Promise<{ workspaces: Workspace[]; dropped: number }> {
  if (!isTauri()) return { workspaces, dropped: 0 };
  const claimed = workspaces.filter((workspace) => workspace.grantId).map((workspace) => ({ id: workspace.grantId as string, path: workspace.path }));
  let verdicts: Array<{ id: string; ok: boolean; path?: string | null }> = [];
  try { verdicts = await verifyGrants(claimed); }
  catch { return { workspaces: workspaces.map((workspace) => ({ ...workspace, grantId: null })), dropped: claimed.length }; }
  const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  let dropped = 0;
  const next = workspaces.map((workspace) => {
    if (!workspace.grantId) return workspace;
    const verdict = byId.get(workspace.grantId);
    if (verdict?.ok) return verdict.path && verdict.path !== workspace.path ? { ...workspace, path: verdict.path, name: workspaceName(verdict.path) } : workspace;
    dropped += 1;
    return { ...workspace, grantId: null };
  });
  return { workspaces: next, dropped };
}

/** Output tokens spent since the turn started; undefined when the agent doesn't report usage. */
export function turnTokens(thread: Pick<Thread, "usage" | "turnStartOutput">): number | undefined {
  const now = thread.usage?.outputTokens;
  return now == null ? undefined : Math.max(0, now - (thread.turnStartOutput ?? 0));
}

/** Prompt tokens spent since the turn started; undefined when the agent doesn't report usage. */
export function turnPromptTokens(thread: Pick<Thread, "usage" | "turnStartPrompt">): number | undefined {
  const now = thread.usage?.promptTokens;
  return now == null ? undefined : Math.max(0, now - (thread.turnStartPrompt ?? 0));
}

const cacheTokens = (usage?: TokenUsage | null) => (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);

/** Cached prompt tokens read or written since the turn started; providers that cache count them apart from the prompt. */
function turnCacheTokens(thread: Pick<Thread, "usage" | "turnStartCache">): number {
  return Math.max(0, cacheTokens(thread.usage) - (thread.turnStartCache ?? 0));
}

/** Usage can land just after turnCompleted; fold it into the finished turn's count. */
function withLateUsage(thread: Thread): Thread {
  if (thread.status === "running" || !thread.turnStats || thread.turnStartOutput == null) return thread;
  const outputTokens = turnTokens(thread);
  const inputTokens = thread.turnStartPrompt == null ? undefined : turnPromptTokens(thread);
  const cachedTokens = thread.turnStartCache == null ? 0 : turnCacheTokens(thread);
  const outputChanged = !!outputTokens && outputTokens !== thread.turnStats.outputTokens;
  const inputChanged = inputTokens != null && inputTokens !== thread.turnStats.inputTokens;
  const cacheChanged = cachedTokens !== (thread.turnStats.cachedTokens ?? 0);
  if (!outputChanged && !inputChanged && !cacheChanged) return thread;
  return { ...thread, turnStats: { ...thread.turnStats, ...(outputChanged && outputTokens ? { outputTokens, estimated: false } : {}), ...(inputChanged ? { inputTokens } : {}), cachedTokens: cachedTokens || undefined } };
}

/** Error text the renderer keys on to offer a one-click folder re-open. */
export const UNGRANTED_ERROR = "This folder is not granted. Re-open it with Open workspace to restore access.";
// The matcher lives on the shared wording contract (errors.ts): the native
// store reports grants in its own voice ("Unknown workspace grant"), which the
// old "is not granted" substring check never matched — the CTA stayed hidden.
export const needsGrant = (text: string | null | undefined) => isGrantError(text);

/** Errors whose fix is picking a folder; the banner pairs them with the Open workspace button. */
export const needsWorkspace = (text: string | null | undefined) =>
  Boolean(text && /add a (project|workspace) folder first|open a (project|workspace) before sending/i.test(text));

/**
 * The settings document remembers which workspaces the user trusted; the native
 * record is what the agent obeys. Carry a remembered "trusted" across to it so a
 * workspace trusted before the agent honoured trust keeps its rules and skills.
 * It only raises trust: Stop trusting lowers it, explicitly, through its own call.
 */
async function mirrorWorkspaceTrust(workspaces: Workspace[]): Promise<void> {
  await Promise.allSettled(workspaces.filter((workspace) => workspace.trusted === true && workspace.grantId).map((workspace) => setWorkspaceTrust(workspace.grantId as string, true)));
}

/**
 * List one workspace's sessions from every ready agent and fold them into the
 * thread list. Shared by selecting a workspace and by merely expanding one in
 * the tree; `quiet` keeps a background expansion from raising banners that
 * belong to the workspace the user is actually looking at.
 */
async function listWorkspaceThreads(
  get: () => AppStore,
  set: (patch: Partial<AppStore>) => void,
  workspace: Workspace,
  current: () => boolean,
  quiet: boolean,
) {
  const fail = (text: string) => { if (!quiet) set({ error: text }); };
  if (!workspace.grantId && isTauri()) { fail(UNGRANTED_ERROR); return; }
  // "Loading threads…" shows from the first moment, including while the agent
  // detection this depends on is still finishing at launch.
  set({ threadsLoading: [...get().threadsLoading, workspace.id] });
  let ready: AgentInfo[] = [];
  let listings: PromiseSettledResult<{ agentId: AgentId; sessions: SessionMetadata[] }>[] = [];
  try {
    await detectionSettled();
    ready = readyAgents(get());
    if (!ready.length) {
      fail("The agent is not ready yet. Add a model provider key in Settings → Models & providers.");
      return;
    }
    // The listing is 200 rows × 10 pages with the time filter, across every
    // workspace when the all-projects view is on.
    const updatedAfter = get().listSince ? timeFilterCutoff(get().listSince as "day" | "week" | "month") : undefined;
    listings = await Promise.allSettled(ready.map(async (agent) => {
      const all = get().showAllWorkspaces;
      const { sessions, truncated } = await listWorkspaceSessions(all ? null : workspace, agent.id, 10, undefined, { updatedAfter });
      if (truncated) log.warn("sessions.truncated", { agent: agent.id, workspace: all ? "(all)" : workspace.path, pages: 10 });
      return { agentId: agent.id, sessions };
    }));
  } finally {
    // Remove this call's entry only: a second listing of the same workspace may still be running.
    const loading = get().threadsLoading.slice();
    const at = loading.indexOf(workspace.id);
    if (at >= 0) loading.splice(at, 1);
    set({ threadsLoading: loading });
  }
  // The agent files a worktree thread under the worktree's root, so the listing
  // above never returns it. Each known worktree is listed through its own
  // grant, which also binds its sessions natively.
  const worktrees = new Map<string, { worktree: ThreadWorktree; agentId: AgentId }>();
  if (workspace.grantId) {
    for (const meta of Object.values(get().threadMeta)) {
      const agentId: AgentId = "harness";
      if (meta.worktree && !meta.deleted && meta.worktree.workspaceId === workspace.id && ready.some((agent) => agent.id === agentId)) worktrees.set(`${meta.worktree.grantId} ${agentId}`, { worktree: meta.worktree, agentId });
    }
  }
  const worktreeSessions = await Promise.all([...worktrees.values()].map(async ({ worktree, agentId }) => {
    try { return { worktree, agentId, sessions: (await listWorkspaceSessions(worktree, agentId, 2)).sessions }; }
    catch (error) {
      log.warn("worktree.sessions.unavailable", { agent: agentId, error: message(error) });
      return { worktree, agentId, sessions: [] };
    }
  }));
  if (!current()) return;
  const threads = [...get().threads];
  const roots = new Set(get().workspaces.map((item) => item.path));
  // The listing is 200 rows per page across up to 10 pages, and a workspace can
  // hold a lot of threads: membership against the array is quadratic, which cost
  // ~10ms per open at a thousand threads and two thousand sessions.
  const listed = new Set(threads.map((thread) => thread.sessionId));
  for (const listing of listings) {
    if (listing.status === "rejected") {
      fail(describeError("Could not load workspace threads", listing.reason));
      continue;
    }
    const agentId = listing.value.agentId;
    for (const session of listing.value.sessions) {
      // All-workspace rows for folders never registered have no grant path;
      // they cannot be opened, so they never become threads.
      if (session.workspaceRoot && !roots.has(session.workspaceRoot)) continue;
      const meta = get().threadMeta[session.sessionId];
      if (meta?.deleted || listed.has(session.sessionId)) continue;
      listed.add(session.sessionId);
      threads.push(applyMeta({ sessionId: session.sessionId, agentId, workspacePath: session.workspaceRoot ?? workspace.path, title: listedTitle(session, meta), order: Date.parse(session.updatedAt ?? "") || Date.now(), updatedAt: session.updatedAt ?? new Date().toISOString(), status: session.status === "running" ? "running" : "idle", unread: false, items: [], activeTurnId: session.activeTurnId, config: { ...metadataConfig(session, undefined), agentId } }, meta, session.status));
    }
  }
  for (const { worktree, agentId, sessions } of worktreeSessions) {
    for (const session of sessions) {
      const meta = get().threadMeta[session.sessionId];
      // Only threads this app put in the worktree: its record is what ties the
      // session to this workspace.
      if (!meta?.worktree || meta.deleted || listed.has(session.sessionId)) continue;
      listed.add(session.sessionId);
      threads.push(applyMeta({ sessionId: session.sessionId, agentId, workspacePath: workspace.path, worktree, title: listedTitle(session, meta), order: Date.parse(session.updatedAt ?? "") || Date.now(), updatedAt: session.updatedAt ?? new Date().toISOString(), status: session.status === "running" ? "running" : "idle", unread: false, items: [], activeTurnId: session.activeTurnId, config: { ...metadataConfig(session, undefined), agentId } }, meta, session.status));
    }
  }
  set({ threads });
  scheduleMemory(get);
  void get().refreshModels();
}

/**
 * The instant part of opening a workspace: the selection, its draft, and the
 * git/file reads it needs all work without the host, so they start at once. The
 * thread listing (which needs agents detected and the host running) follows.
 */
function beginWorkspaceSelection(
  get: () => AppStore,
  set: (patch: Partial<AppStore>) => void,
  id: string,
): { workspace: Workspace; version: number } | null {
  const workspace = get().workspaces.find((item) => item.id === id);
  if (!workspace) return null;
  const version = ++selectionVersion;
  ++reviewVersion;
  ++gitGraphVersion;
  set({ ...switchDraft(get(), id, null), error: null, git: null, gitGraph: null, gitGraphLoading: null, gitGraphError: null, fileView: null, branches: null, pullRequest: null, reviewBase: "", review: null, reviewError: null, reviewLoading: null, diffTabs: null, diffActive: null, browserState: null, browserFrame: null, browserBusy: false, browserError: null });
  void get().refreshGit();
  void get().refreshFileIndex(id);
  return { workspace, version };
}


function finishTurn(thread: Thread, turnId?: string): Partial<Thread> {
  if (thread.turnStartedAt == null) return { tokenSpeed: undefined };
  const finishedAt = Date.now();
  const reported = turnTokens(thread);
  const estimate = estimateTurnTokens(thread.items);
  const outputTokens = reported || estimate || undefined;
  const inputTokens = turnPromptTokens(thread) || undefined;
  const cachedTokens = turnCacheTokens(thread) || undefined;
  const tokensPerSecond = readTokenSpeed(thread.tokenSpeed, finishedAt)?.tokensPerSecond;
  return {
    turnStats: { turnId, durationMs: finishedAt - thread.turnStartedAt, outputTokens, inputTokens, cachedTokens, estimated: !reported && Boolean(estimate), tokensPerSecond },
    turnStartedAt: undefined,
    tokenSpeed: undefined,
  };
}

function settlePlan(plan: PlanItem[] | undefined, outcome: "cancelled" | "failed" | "interrupted") {
  if (!plan) return plan;
  return plan.map((item) => item.status !== "inProgress" ? item : { ...item, status: outcome === "failed" ? "failed" as const : "cancelled" as const });
}

function settleItems(items: TranscriptItem[], outcome: "cancelled" | "failed" | "interrupted", includeAgents = false) {
  const status = outcome === "failed" ? "failed" : "cancelled";
  return items.map((item) => item.status !== "inProgress" || (!includeAgents && (item.kind === "workflow" || item.kind === "subagent")) ? item : { ...item, status });
}

/** Settle one stale turn's in-progress items (e.g. a replaced turn whose completion arrives after its successor started). */
function settleTurnItems(items: TranscriptItem[], turnId: string, terminal?: string) {
  const status = terminal === "failed" ? "failed" : "cancelled";
  return items.map((item) => item.turnId !== turnId || item.status !== "inProgress" ? item : { ...item, status });
}

/**
 * Drain a stashed config patch against the session that stashed it. The
 * in-flight apply can settle after the user switched threads; re-entering
 * through the selected thread would push the stash into whichever thread is
 * on screen, so the drain is pinned to the originating session instead.
 */
async function drainSessionConfig(get: () => AppStore, set: (patch: Partial<AppStore>) => void, sessionId: string, patch: Partial<SessionConfig>) {
  const state = get();
  const target = state.threads.find((item) => item.sessionId === sessionId);
  if (!target || state.starting || state.submitting || target.status === "running" || target.opening) return;
  await applyThreadConfig(get, set, target, patch);
}

/** Apply a config patch to one open thread's session, live in the store. */
async function applyThreadConfig(get: () => AppStore, set: (patch: Partial<AppStore>) => void, thread: Thread, patch: Partial<SessionConfig>) {
  const state = get();
  const sessionId = thread.sessionId;
  const update = (changes: Partial<Thread>) => set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, ...changes } : item) });
  const drainStash = () => {
    const stashed = get().threads.find((item) => item.sessionId === sessionId)?.pendingConfig;
    if (stashed) {
      update({ pendingConfig: undefined });
      void drainSessionConfig(get, set, sessionId, stashed);
    }
  };
  const agentId = "harness" as const;
  // Applies are a serialized round-trip. Changes made while one is in flight
  // merge into a trailing call instead of being dropped, so a scrubbed value
  // is never silently lost.
  if (thread.configPending) { update({ pendingConfig: { ...thread.pendingConfig, ...patch } }); return; }
  update({ configPending: true, configNotice: undefined, error: null });
  try {
    if (!state.preview && !thread.opened) throw new Error("Open this thread successfully before changing its settings.");
    let applied: AgentSessionConfig | undefined;
    // Enabling Orchestrator fixes the model and effort to its role settings,
    // so the manual controls wait for the next switch back.
    const enabling = patch.orchestrator != null;
    if (patch.orchestrator !== undefined) applied = (await bridge<{ agentConfig?: AgentSessionConfig }>("setOrchestrator", { agentId, sessionId, orchestrator: patch.orchestrator })).agentConfig;
    if (!enabling) {
      if (patch.modelId !== undefined) {
        // A manual model pick leaves Orchestrator first: role models are Settings.
        if (thread.config?.orchestrator) await bridge("setOrchestrator", { agentId, sessionId, orchestrator: null });
        applied = (await bridge<{ agentConfig?: AgentSessionConfig }>("setModel", { agentId, sessionId, modelId: patch.modelId })).agentConfig ?? applied;
      }
      if (patch.effort !== undefined) applied = (await bridge<{ agentConfig?: AgentSessionConfig }>("setSessionOption", { agentId, sessionId, option: "effort", value: patch.effort })).agentConfig ?? applied;
      if (patch.mode !== undefined) applied = (await bridge<{ agentConfig?: AgentSessionConfig }>("setSessionOption", { agentId, sessionId, option: "mode", value: patch.mode })).agentConfig ?? applied;
    }
    // The Harness enforces the app's permission modes itself.
    if (patch.approvalMode !== undefined) patch = { ...patch, approvalMode: (await bridge<{ effectiveMode?: { mode: SessionConfig["approvalMode"] } }>("setApprovalMode", { agentId, sessionId, mode: approvalModeForAgent(agentId, patch.approvalMode) })).effectiveMode?.mode ?? approvalModeForAgent(agentId, patch.approvalMode) };
    const latest = get().threads.find((item) => item.sessionId === sessionId);
    update({ config: fitEffort({ ...latest?.config, ...patch, ...agentConfigPatch(applied), agentId }, get().models), ...(applied?.modes ? { modes: applied.modes } : {}) });
    if (patch.modelId !== undefined) void get().refreshModels();
  } catch (error) {
    update({ error: describeError("Settings unchanged", error) });
  } finally {
    update({ configPending: false });
    drainStash();
  }
}

/**
 * After plugins change on disk: the store's installed marks, the library, and
 * an open Harness thread's skills and MCP servers all read those files again.
 */
async function afterExtensionChange(get: () => AppStore, sessionId?: string) {
  await Promise.all([get().refreshLibrary(), get().refreshCatalog()]);
  const thread = sessionId ? get().threads.find((item) => item.sessionId === sessionId) : undefined;
  if (sessionId && thread) {
    await get().refreshSkills(sessionId);
    await get().refreshHarnessMcp(sessionId, true);
  }
}

export const useAppStore = create<AppStore>((set, get) => ({
  ...DEFAULT_SETTINGS,
  ready: false,
  booting: false,
  restoringSession: null,
  detectionChecked: false,
  preview: false,
  detection: null,
  providerStatus: null,
  providerStatusError: null,
  modelLibrary: null,
  modelLibraryError: null,
  hostInfo: null,
  listSince: null,
  showAllWorkspaces: false,
  agents: [],
  harnessMcp: null,
  harnessMcpLoading: null,
  harnessMcpError: null,
  harnessMcpConfig: null,
  harnessMcpConfigLoading: null,
  harnessMcpConfigError: null,
  harnessRuleProblems: [],
  harnessRulesError: null,
  catalogEntries: [],
  catalogSkillsRoot: null,
  catalogLoading: false,
  catalogError: null,
  library: null,
  libraryLoading: false,
  libraryError: null,
  libraryUpdates: [],
  settingsOpen: false,
  settingsTab: "Models & providers",
  trajectoryThreadId: null,
  composerFocus: 0,
  titleEditRequest: 0,
  requestTitleEdit: () => set({ titleEditRequest: get().titleEditRequest + 1 }),
  dockOpen: true,
  dockTab: "changes",
  dockWidth: DOCK_DEFAULT_WIDTH,
  zoom: 1,
  dockExpanded: false,
  inspectorTab: "changes",
  selectedWorkspaceId: null,
  selectedSessionId: null,
  threads: [],
  threadsLoading: [],
  threadMeta: {},
  threadSearch: "",
  threadSearchOpen: false,
  sidebarCollapsed: false,
  sidebarWidth: null,
  paletteOpen: false,
  offline: typeof navigator !== "undefined" ? navigator.onLine === false : false,
  showArchived: false,
  git: null,
  gitGraph: null,
  gitGraphLoading: null,
  gitGraphError: null,
  reviewScope: "all",
  reviewBase: "",
  review: null,
  reviewLoading: null,
  reviewError: null,
  diffTabs: null,
  diffActive: null,
  models: [],
  modelsLoading: false,
  modelsError: null,
  agentModes: {},
  gitLoading: false,
  gitError: null,
  usageLedger: EMPTY_LEDGER,
  clearUsageHistory: () => {
    set({ usageLedger: EMPTY_LEDGER });
    scheduleLedger(get);
  },
  starting: false,
  submitting: false,
  pendingSend: null,
  drafts: {},
  promptHistory: {},
  composer: "",
  images: [],
  contextRefs: [],
  error: null,
  persistNotice: null,
  dismissPersistNotice: () => set({ persistNotice: null }),
  dismissError: () => set({ error: null, threads: get().threads.map((thread) => thread.sessionId === get().selectedSessionId ? { ...thread, error: null } : thread) }),

  hydrate: async () => {
    if (hydration) return hydration;
    hydration = (async () => {
      try {
        // Recover before reading. `tauri-plugin-store` hands back nothing useful
        // for a truncated file, which used to look like an empty state and then
        // get overwritten on the next save — silently losing every draft.
        try {
          const repair = await repairStoreDocument();
          if (repair.status === "restored") {
            set({ persistNotice: `Your saved drafts and thread titles were recovered from a backup (${repair.restoredFrom ?? "backup"}). Anything saved after that point was lost.` });
            log.warn("store.restored", { from: repair.restoredFrom, quarantined: repair.quarantinedTo });
          } else if (repair.status === "quarantined") {
            set({ persistNotice: "Your saved drafts and thread titles could not be read and were set aside (glitter.json.corrupt). Glitter started with empty local state." });
            log.warn("store.quarantined", { file: repair.quarantinedTo });
          }
        } catch (error) {
          log.warn("store.repair_failed", { error: String(error) });
        }
        // The two persisted documents are independent reads, so they overlap.
        const [memory, saved] = await Promise.all([
          memoryPersistence.load(),
          settingsPersistence ? settingsPersistence.load() : Promise.resolve(null),
        ]);
        let coerced = false;
        if (saved) {
          // `allowAll` is a per-thread composer choice, never a durable default:
          // a stored value (older build or hand-edited file) is clamped on load.
          // Full access is a per-thread choice. A saved Ask-me is Ask.
          if (saved.defaultApprovalMode === "allowAll" || saved.defaultApprovalMode === "promptUnmatched") {
            log.info("settings.approval_default_coerced");
            saved.defaultApprovalMode = "onRequest";
            coerced = true;
          }
          set({ ...DEFAULT_SETTINGS, ...saved, threadMeta: memory.threadMeta, drafts: memory.drafts, promptHistory: memory.promptHistory, lineComments: memory.lineComments, recentCommands: memory.recentCommands, settingsTab: memory.settingsTab, dockOpen: memory.dockOpen, dockWidth: memory.dockWidth, zoom: memory.zoom, sidebarCollapsed: memory.sidebarCollapsed, sidebarWidth: memory.sidebarWidth });
        } else {
          set({ threadMeta: memory.threadMeta, drafts: memory.drafts, promptHistory: memory.promptHistory, lineComments: memory.lineComments, recentCommands: memory.recentCommands, settingsTab: memory.settingsTab, dockOpen: memory.dockOpen, dockWidth: memory.dockWidth, zoom: memory.zoom, sidebarCollapsed: memory.sidebarCollapsed, sidebarWidth: memory.sidebarWidth });
        }
        // Attachment bytes were never written to the settings document: a
        // draft that came back with only image references must say so, or the
        // user silently sends text where they remember attaching a screenshot.
        const detachedImages = Object.values(memory.drafts).reduce((count, draft) => count + (draft.droppedImages?.length ?? 0), 0);
        if (detachedImages && !get().persistNotice) {
          set({ persistNotice: `${detachedImages} image ${detachedImages === 1 ? "attachment was" : "attachments were"} not kept across the restart. Re-attach ${detachedImages === 1 ? "it" : "them"} before sending.` });
        }
        if (get().zoom !== 1) void setInterfaceZoom(get().zoom).catch(() => {});
        if (Object.keys(get().shortcutOverrides ?? {}).length) void setMenuShortcuts(menuAccelerators(get().shortcutOverrides ?? {})).catch(() => {});
        try {
          const storedLedger = persistentStore ? await persistentStore.get<unknown>(LEDGER_KEY) : JSON.parse(localStorage.getItem(`glitter.${LEDGER_KEY}`) ?? "null");
          set({ usageLedger: compact(asLedger(storedLedger)) });
        } catch { /* an unreadable ledger starts empty */ }
        applyTheme(get());
        const reconciled = await reconcileGrants(get().workspaces);
        const ungranted = reconciled.workspaces.filter((workspace) => !workspace.grantId);
        const healed = reconciled.workspaces !== get().workspaces;
        if (healed) set({ workspaces: reconciled.workspaces });
        if (ungranted.length && isTauri()) {
          set({ error: `${ungranted.length} ${ungranted.length === 1 ? "folder needs" : "folders need"} to be re-opened to restore access after a security upgrade. Use Open workspace and pick the folder again.` });
        }
        if (healed || coerced) void get().save();
        // Before any thread is resumed, so the first turn already sees the user's decision.
        await mirrorWorkspaceTrust(get().workspaces);

        // Everything above is local. From here on the app can be shown: what
        // remains — agent detection, starting the agent process,
        // listing threads, reopening the last one — takes as long as it takes,
        // and used to hold the whole window on a boot screen until it finished.
        // Detection starts first so listing and sending can wait on it. Provider
        // status (custom endpoint names included) is a cheap local read.
        const detecting = get().refreshDetection();
        detecting.catch(() => {});
        void get().refreshProviders();
        // The model library backs every picker; it also refreshes the models.
        void get().refreshModelLibrary();
        // Selection, draft and the changes dock need nothing from the host.
        const restoreId = memory.selectedWorkspaceId && get().workspaces.some((workspace) => workspace.id === memory.selectedWorkspaceId)
          ? memory.selectedWorkspaceId
          : get().workspaces[0]?.id;
        const begun = restoreId ? beginWorkspaceSelection(get, set, restoreId) : null;
        set({ ready: true, booting: begun != null, restoringSession: begun ? memory.selectedSessionId : null });
        try {
          await detecting;
          if (!isTauri()) await get().refreshModels();
          if (begun && restoreId) {
            // A listing is applied whenever its workspace is still the open one;
            // reopening a thread only if the user has not navigated on their own.
            await listWorkspaceThreads(get, set, begun.workspace, () => get().selectedWorkspaceId === begun.workspace.id, false);
            void get().promptWorkspaceTrust(restoreId);
            if (memory.selectedSessionId && selectionVersion === begun.version && get().threads.some((thread) => thread.sessionId === memory.selectedSessionId)) {
              await get().selectThread(memory.selectedSessionId);
            }
          }
        } finally {
          set({ booting: false, restoringSession: null });
        }
      } catch (error) {
        set({ error: sentenceAfter(describeError("Startup failed", error), "Open Settings to reconnect.") });
      } finally {
        applyTheme(get());
        set({ ready: true, booting: false, restoringSession: null });
      }
    })();
    return hydration;
  },

  save: async () => {
    if (!settingsPersistence || get().preview) return;
    try {
      await settingsPersistence.save(settingsFields(get()));
    } catch (error) {
      set({ error: describeError("Could not save settings", error) });
    }
  },

  commitSettings: async (patch) => {
    // Apply before the first await: a later change must build its complete
    // settings document from this patch, not from the pre-change state.
    set({ ...patch });
    // Begin applying a rule change before persistence yields: a concurrent send
    // must wait for this change, even while the settings file is being saved.
    const rulesUpdate = "harnessRules" in patch || "protectedPaths" in patch
      ? get().applyHarnessRules(true).catch((error) => { set({ error: describeError("Could not apply the permission rules", error) }); })
      : null;
    const settings = settingsFields(get());
    applyTheme(settings);
    // A failed write must not reject into a `void` call site (which would leave
    // the toggle looking inert with no explanation). Surface it and still apply
    // the patch, so the control responds and the next successful save heals it.
    if (settingsPersistence && !get().preview) {
      try { await settingsPersistence.save(settings); }
      catch (error) { set({ error: describeError("Could not save settings", error) }); }
    }
    // The native menu holds its own copy of the accelerators.
    if ("shortcutOverrides" in patch) void setMenuShortcuts(menuAccelerators(settings.shortcutOverrides ?? {})).catch((error) => log.warn("shortcuts.menu_failed", { error: message(error) }));
    if (rulesUpdate) await rulesUpdate;
    // Only the workspace draft shows the chips. A toggle from an open thread
    // must not start a suggestion turn in the background.
    if (patch.suggestionsEnabled === true && get().selectedSessionId == null && !get().restoringSession) void get().refreshSuggestions(true);
    else if (patch.suggestionsEnabled === false) set({ suggestions: null });
  },

  applyHarnessRules: async (force = false) => {
    if (get().preview) return;
    if (force) harnessRulesApplied = null;
    const apply = async () => {
      try {
        for (;;) {
          const generation = harnessRulesGeneration;
          const rules = normalizeHarnessRules(get().harnessRules);
          const protectedPaths = effectiveProtectedPaths(get().protectedPaths);
          const signature = JSON.stringify([rules, protectedPaths]);
          if (harnessRulesApplied === signature) return;
          const result = await bridge<{ problems?: string[] }>("harnessRules", { agentId: "harness", rules, protectedPaths });
          if (generation !== harnessRulesGeneration) throw new Error("The agent connection restarted while applying rules.");
          harnessRulesApplied = signature;
          // Settings may have changed while the bridge was answering. Install
          // the newest snapshot before releasing any waiting session or send.
          if (JSON.stringify([normalizeHarnessRules(get().harnessRules), effectiveProtectedPaths(get().protectedPaths)]) !== signature) continue;
          set({ harnessRuleProblems: result.problems ?? [], harnessRulesError: null });
          return;
        }
      } catch (error) {
        harnessRulesApplied = null;
        set({ harnessRulesError: sentenceAfter(describeError("Could not apply permission rules", error), "Open threads may still use the previous rules. Stop a running turn or retry.") });
        throw error;
      }
    };
    const operation = harnessRulesQueue.then(apply);
    harnessRulesQueue = operation.catch(() => {});
    await operation;
  },

  refreshProviders: async () => {
    try {
      set({ providerStatus: await providerKeysGet(KEYED_PROVIDER_IDS), providerStatusError: null });
    } catch (error) {
      // Pickers fall back to ids alone; the Providers page shows the error.
      set({ providerStatusError: describeError("Could not read saved providers", error) });
    }
  },

  refreshModelLibrary: async () => {
    try {
      const { entries } = await modelLibraryList();
      set({ modelLibrary: entries, modelLibraryError: null });
      // A saved default that predates the library keeps working: add it once, quietly.
      const state = get();
      const split = (modelId: string | undefined) => {
        if (!modelId || !modelId.includes("/")) return null;
        const slash = modelId.indexOf("/");
        return { providerId: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
      };
      const keyOf = (entry: { providerId: string; model: string }) => `${entry.providerId}/${entry.model}`;
      const known = new Set(entries.map(keyOf));
      const wanted = [split(state.defaultModel), ...Object.values(state.orchestratorModels ?? {}).map((role) => split(role?.modelId)), split(state.suggestionsModelId)].filter((entry): entry is { providerId: string; model: string } => Boolean(entry));
      for (const entry of wanted) {
        if (known.has(keyOf(entry))) continue;
        known.add(keyOf(entry));
        const added = { ...entry, source: "migrated" as const, addedAt: new Date().toISOString() };
        const saved = await modelLibraryPut(added);
        set({ modelLibrary: saved.entries });
      }
      void get().refreshModels();
    } catch (error) {
      set({ modelLibraryError: describeError("Could not load the model library", error) });
    }
  },

  putModelEntry: async (entry) => {
    const { entries } = await modelLibraryPut(entry);
    set({ modelLibrary: entries, modelLibraryError: null });
    void get().refreshModels();
  },

  removeModelEntry: async (modelId) => {
    const { entries } = await modelLibraryRemove(modelId);
    set({ modelLibrary: entries, modelLibraryError: null });
    void get().refreshModels();
  },

  fetchProviderModels: async (providerId, refresh = false) => {
    const { models } = await listProviderModels(providerId, refresh);
    return models;
  },

  refreshDetection: async () => {
    const run = (async () => {
      const detection = await bridge<Detection>("detect", {});
      set({ detection, agents: detection.agents ?? get().agents });
    })();
    detectionInFlight = run;
    try {
      await run;
    } finally {
      if (detectionInFlight === run) detectionInFlight = null;
      set({ detectionChecked: true });
    }
  },

  chooseProject: async () => {
    try {
      set({ error: null });
      const picked = await pickFolder();
      if (!picked) return;
      await get().addWorkspace(picked.path, picked.grantId);
      // A grant that never reached the keyring dies with the process; say so
      // now rather than letting the folder go ungranted at the next launch.
      if (picked.warning) set({ error: `Access to this folder could not be saved: ${picked.warning}` });
    } catch (error) {
      set({ error: describeError("Could not open the folder", error) });
    }
  },

  startHost: async (restart = false) => {
    // The Harness runs inside the agent process, so starting it only confirms
    // the process is up and reports how its commands are isolated. The renderer
    // hears about every exit (`bridgeExit`), so what it holds is current.
    if (!restart && get().hostInfo) return;
    if (!hostStart) hostStart = (async (): Promise<boolean> => {
      const started = await bridge<HostInfo>("startHost", { agentId: "harness" });
      set({ hostInfo: { isolation: started.isolation ?? null } });
      return true;
    })().finally(() => { hostStart = null; });
    await hostStart;
    if (!get().models.length) await get().refreshModels();
  },

  loadModelCatalog: async () => {
    return (await readModelCatalog("harness", get().preview, undefined, true)).models;
  },

  testModel: async (_agentId, model) => {
    return bridge<ModelTestResult>("testModel", { agentId: "harness", modelId: model.modelId }, { timeoutMs: 45_000 });
  },

  probeOrchestratorRole: async (role, model, options) => {
    const providerId = model.providerId ?? (model.modelId.includes("/") ? model.modelId.slice(0, model.modelId.indexOf("/")) : "");
    if (!providerId) throw new Error(`${model.modelId} does not name a provider.`);
    return bridge<OrchestratorProbeResult>("orchestratorProbe", { agentId: "harness", role, providerId, modelId: model.modelId, ...(options?.refresh ? { refresh: true } : {}) });
  },

  refreshModels: async (refresh = false) => {
    const agentId: AgentId = "harness";
    if (get().preview) {
      const catalog = await readModelCatalog(agentId, true);
      set({ models: catalog.models, modelsError: null, modelsLoading: false, ...(catalog.modes ? { agentModes: { ...get().agentModes, [agentId]: catalog.modes } } : {}) });
      return;
    }
    const thread = currentThread(get());
    const sessionId = thread?.sessionId;
    const draftModel = !thread ? activeConfig(get()).modelId : undefined;
    // Callers overlap constantly (starting the agent, opening a thread, a model
    // event); one listing per session is enough for all of them.
    const key = `${sessionId ?? ""}\u0000${refresh}\u0000${draftModel ?? ""}`;
    if (modelsInFlight?.key === key) return modelsInFlight.promise;
    const version = ++modelVersion;
    const listing = (modelListings.get(agentId) ?? 0) + 1;
    modelListings.set(agentId, listing);
    // Models already on screen stay there while the refresh runs: blanking the
    // picker to "Loading…" on every thread switch made it flicker and go
    // unclickable for the length of a round trip.
    const known = get().models.length ? get().models : modelCatalogs.get(agentId) ?? [];
    const showing = known.length > 0;
    set({ modelsLoading: !showing, modelsError: null, ...(!get().models.length ? { models: known } : {}) });
    const run = (async () => {
      try {
        // An empty answer is meaningful now — the library holds only what the user
        // added — so an empty list is shown as-is, not re-probed.
        const { models, modes } = await readModelCatalog(agentId, false, sessionId, refresh, draftModel);
        if (modes) set({ agentModes: { ...get().agentModes, [agentId]: modes } });
        // Only a listing newer than whatever wrote the cache may replace it: a
        // Rescan and a thread switch can overlap, and answers arrive out of order.
        if (listing > (modelCatalogAt.get(agentId) ?? 0)) {
          modelCatalogs.set(agentId, models);
          modelCatalogAt.set(agentId, listing);
        }
        if (version === modelVersion) set({ models });
      } catch (error) {
        if (version === modelVersion) set({ ...(showing ? {} : { models: [] }), modelsError: describeError("Could not load models", error) });
      } finally {
        if (version === modelVersion) set({ modelsLoading: false });
      }
    })();
    modelsInFlight = { key, promise: run };
    try {
      await run;
    } finally {
      if (modelsInFlight?.promise === run) modelsInFlight = null;
    }
  },

  setSessionConfig: async (patch) => {
    const state = get();
    const thread = currentThread(state);
    if (state.starting || state.submitting || thread?.status === "running" || thread?.opening || thread?.snapshotPending || thread?.rewindPending) return;
    if (!thread) {
      const key = draftKey(state);
      const previous = state.drafts[key]?.config ?? defaults(state);
      const next = fitEffort({ ...previous, ...patch }, state.models);
      if (patch.modelId !== undefined && patch.orchestrator == null) next.orchestrator = null;
      next.approvalMode = approvalModeForAgent("harness", next.approvalMode);
      set({ drafts: { ...state.drafts, [key]: { text: state.composer, images: state.images, refs: state.contextRefs, config: next } } });
      // A newly picked model is described, so its effort levels show before the thread exists.
      if (patch.modelId) void get().refreshModels();
      return;
    }
    await applyThreadConfig(get, set, thread, patch);
  },

  addWorkspace: async (path, grantId = null) => {
    const norm = (value: string) => value.replace(/[/\\]+$/, "");
    const existing = get().workspaces.find((item) => norm(item.path) === norm(path));
    // Re-opening an ungranted folder re-attaches its native grant in place.
    if (existing) {
      if (grantId && (existing.grantId !== grantId || existing.path !== path)) {
        set({ workspaces: get().workspaces.map((item) => item.id === existing.id ? { ...item, path, name: workspaceName(path), grantId } : item) });
        await get().save();
        await mirrorWorkspaceTrust(get().workspaces);
      }
      await get().selectWorkspace(existing.id);
      return;
    }
    // Stored path may be non-canonical where the picked one is canonical
    // (symlinked parents, /tmp aliases): ask native whether the picked grant
    // covers an existing ungranted entry, and merge instead of duplicating.
    if (grantId && isTauri()) {
      const candidates = get().workspaces.filter((item) => !item.grantId);
      if (candidates.length) {
        try {
          const verdicts = await verifyGrants(candidates.map((item) => ({ id: grantId, path: item.path })));
          const hit = candidates[verdicts.findIndex((verdict) => verdict.ok)];
          if (hit) {
            set({ workspaces: get().workspaces.map((item) => item.id === hit.id ? { ...item, path, name: workspaceName(path), grantId } : item) });
            await get().save();
            await mirrorWorkspaceTrust(get().workspaces);
            await get().selectWorkspace(hit.id);
            return;
          }
        } catch { /* fall through to a fresh entry */ }
      }
    }
    const workspace: Workspace = { id: uid(), path, name: workspaceName(path), grantId };
    set({ workspaces: [...get().workspaces, workspace] });
    await get().save();
    await get().selectWorkspace(workspace.id);
  },

  removeWorkspace: (id) => {
    const removed = get().workspaces.find((workspace) => workspace.id === id);
    const removedThreads = get().threads.filter((thread) => removed?.path === thread.workspacePath);
    const stopped = cancelThreadTurns(removedThreads);
    releaseThreadSessions(removedThreads.map((thread) => thread.sessionId), stopped);
    if (removed?.grantId) void removeGrant(removed.grantId).catch(() => {});
    const workspaces = get().workspaces.filter((workspace) => workspace.id !== id);
    const threadMeta = { ...get().threadMeta };
    for (const thread of removedThreads) threadMeta[thread.sessionId] = { ...threadMeta[thread.sessionId], deleted: true, archived: true };
    ++selectionVersion;
    set({ workspaces, ...(get().selectedWorkspaceId === id ? switchDraft(get(), workspaces[0]?.id ?? null, null) : {}), threads: get().threads.filter((thread) => workspaces.some((workspace) => workspace.path === thread.workspacePath)), threadMeta });
    void get().save();
    void persistMemory(get());
    void get().refreshGit();
  },

  renameThread: (sessionId, title) => {
    const next = title.replace(/\s+/g, " ").trim();
    if (!next) return;
    // The agent keeps no name of its own: the local title is the truth.
    set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, title: next, customTitle: true } : item) });
    scheduleMemory(get);
  },

  pinThread: (sessionId) => {
    set({ threads: get().threads.map((thread) => thread.sessionId === sessionId ? { ...thread, pinned: !thread.pinned } : thread) });
    scheduleMemory(get);
  },

  setThreadUnread: (sessionId, unread) => {
    set({ threads: get().threads.map((thread) => thread.sessionId === sessionId ? { ...thread, unread } : thread) });
    scheduleMemory(get);
  },

  swapThreadOrder: (sessionId, otherId) => {
    const threads = get().threads;
    const a = threads.find((thread) => thread.sessionId === sessionId);
    const b = threads.find((thread) => thread.sessionId === otherId);
    if (!a || !b) return;
    const aOrder = a.order ?? 0;
    const bOrder = b.order ?? 0;
    // Equal keys can't be swapped; nudge the moved thread just past its neighbour instead.
    const nextA = aOrder === bOrder ? bOrder + (threads.indexOf(a) > threads.indexOf(b) ? 1 : -1) : bOrder;
    const nextB = aOrder === bOrder ? bOrder : aOrder;
    set({ threads: threads.map((thread) => thread.sessionId === sessionId ? { ...thread, order: nextA } : thread.sessionId === otherId ? { ...thread, order: nextB } : thread) });
    scheduleMemory(get);
  },

  reorderThreads: (sessionIds) => {
    // Order keys sort descending, so walking the dropped list downward and
    // handing out decreasing keys reproduces exactly what the user sees.
    const base = Date.now();
    const orders = new Map(sessionIds.map((sessionId, index) => [sessionId, base - index]));
    set({ threads: get().threads.map((thread) => orders.has(thread.sessionId) ? { ...thread, order: orders.get(thread.sessionId) } : thread) });
    scheduleMemory(get);
  },

  archiveThread: (sessionId, archived = true) => {
    const selected = get().selectedSessionId === sessionId;
    const scope = activeWorkspace(get())?.grantId;
    // Archiving hides a thread from the sidebar but keeps it, so a live turn is
    // deliberately left running: it still streams into the transcript and its
    // approval cards stay answerable while the thread is restored.
    set({
      threads: get().threads.map((thread) => thread.sessionId === sessionId ? { ...thread, archived } : thread),
      ...(selected && archived ? switchDraft(get(), get().selectedWorkspaceId, null) : {}),
    });
    scheduleMemory(get);
    rescope(get, set, scope);
  },

  deleteThread: (sessionId) => {
    const selected = get().selectedSessionId === sessionId;
    const scope = activeWorkspace(get())?.grantId;
    // The host keeps running the turn whether or not this app still lists the
    // thread, so it has to be stopped here: a deleted thread has nowhere to show
    // an approval, and the agent would keep spending the user's quota invisibly.
    const removed = get().threads.find((thread) => thread.sessionId === sessionId);
    const stopped = cancelThreadTurns(removed ? [removed] : []);
    const owner = threadScope(get(), removed);
    const forgotten = owner?.grantId && !get().preview ? forgetTurnSnapshots(owner.grantId, sessionId).catch(() => {}) : Promise.resolve();
    releaseThreadSessions([sessionId], stopped);
    // A worktree goes with its last thread. Forks share their source's worktree,
    // so it stays while any other thread still lives there. Removal waits for
    // the stop and the snapshot cleanup, which both still need the grant.
    const worktree = removed?.worktree;
    if (worktree && !get().preview && !get().threads.some((thread) => thread.sessionId !== sessionId && thread.worktree?.grantId === worktree.grantId)) {
      void Promise.all([stopped, forgotten]).then(() => gitWorktreeRemove(worktree.grantId)).then((result) => {
        if (result.branchKept && result.branch) set({ error: `Worktree removed. Branch ${result.branch} was kept because it has commits that are not on another branch.` });
      }, (error) => set({ error: describeError("The thread was deleted, but its worktree could not be removed", error) }));
    }
    const drafts = { ...get().drafts };
    delete drafts[`thread:${sessionId}`];
    const lineComments = { ...get().lineComments };
    delete lineComments[`thread:${sessionId}`];
    const next = selected ? switchDraft(get(), get().selectedWorkspaceId, null) : null;
    set({
      lineComments,
      threads: get().threads.filter((thread) => thread.sessionId !== sessionId),
      drafts,
      threadMeta: { ...get().threadMeta, [sessionId]: { ...get().threadMeta[sessionId], deleted: true, archived: true } },
      ...(next ?? {}),
    });
    scheduleMemory(get);
    rescope(get, set, scope);
  },

  compactThread: async () => {
    const thread = currentThread(get());
    if (!thread || get().preview || thread.status === "running") return;
    set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, notice: { level: "info", message: "Compacting context…", key: "compacting" } } : item) });
    try {
      const result = await bridge<{ status: string; reason?: string }>("compactSession", { agentId: "harness", sessionId: thread.sessionId });
      if (result.status === "noop") {
        const reason = result.reason === "no_compactable_history" ? "no compactable history yet" : result.reason ?? "nothing to do";
        set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, notice: { level: "info", message: `Already compact: ${reason}.` } } : item) });
        return;
      }
    } catch (error) {
      set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, ...(item.notice?.key === "compacting" ? { notice: null } : {}), error: describeError("Could not compact the thread", error) } : item) });
    }
  },

  childSession: null,

  openChild: async (sessionId, itemId) => {
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    const item = thread?.items.find((entry) => entry.itemId === itemId);
    if (!thread || !item || item.kind !== "subagent" || !item.childSessionId) return;
    const title = item.objective || "Subagent";
    set({ childSession: { sessionId, itemId, title, loading: true, error: null, result: item.result ?? null, items: [] } });
    try {
      const snapshot = await bridge<SessionPreview>("readChildSession", { agentId: "harness", sessionId, childSessionId: item.childSessionId, excludeItems: false });
      if (get().childSession?.itemId !== itemId) return;
      set({ childSession: { sessionId, itemId, title, loading: false, error: null, result: item.result ?? null, items: snapshot?.history?.items ?? [] } });
    } catch (error) {
      if (get().childSession?.itemId !== itemId) return;
      set({ childSession: { sessionId, itemId, title, loading: false, error: describeError("Could not read the child transcript", error), result: item.result ?? null, items: [] } });
    }
  },

  closeChild: () => set({ childSession: null }),

  setListSince: (value) => set({ listSince: value }),
  setShowAllWorkspaces: (value) => set({ showAllWorkspaces: value }),

  trustDialog: null,
  confirmDialog: null,
  fileIndex: null,
  suggestions: null,
  confirm: (options) => new Promise<boolean>((resolve) => {
    // A second request replaces the first — treat it as cancelled.
    get().confirmDialog?.resolve(false);
    set({ confirmDialog: { title: options.title, body: options.body, confirmLabel: options.confirmLabel ?? "Confirm", danger: options.danger ?? false, ...(options.info ? { info: true } : {}), resolve } });
  }),
  resolveConfirm: (ok) => {
    const dialog = get().confirmDialog;
    if (!dialog) return;
    set({ confirmDialog: null });
    dialog.resolve(ok);
  },
  openTrustDialog: async (workspaceId, prefetched) => {
    const workspace = get().workspaces.find((item) => item.id === workspaceId);
    if (!workspace || !workspace.grantId) return;
    if (prefetched) {
      set({ trustDialog: { workspaceId, loading: false, error: null, preview: prefetched } });
      return;
    }
    set({ trustDialog: { workspaceId, loading: true, error: null, preview: null } });
    try {
      const preview = await trustPreview(workspace.grantId);
      if (get().trustDialog?.workspaceId !== workspaceId) return;
      set({ trustDialog: { workspaceId, loading: false, error: null, preview } });
    } catch (error) {
      if (get().trustDialog?.workspaceId !== workspaceId) return;
      set({ trustDialog: { workspaceId, loading: false, error: describeError("Could not preview trusted content", error), preview: null } });
    }
  },

  closeTrustDialog: () => set({ trustDialog: null }),

  // First-open trust prompt: preview the workspace's skills/rules once. If
  // there's anything to trust, open the dialog with the fetched preview;
  // either way trustPrompted is persisted so cancel never re-asks.
  promptWorkspaceTrust: async (workspaceId) => {
    const workspace = get().workspaces.find((item) => item.id === workspaceId);
    if (!workspace || workspace.trusted === true || workspace.trustPrompted === true || !workspace.grantId || get().preview) return;
    const markPrompted = () => {
      set({ workspaces: get().workspaces.map((item) => item.id === workspaceId ? { ...item, trustPrompted: true } : item) });
      void get().save();
    };
    try {
      const preview = await trustPreview(workspace.grantId);
      markPrompted();
      if (preview.skills.length > 0 || preview.rules) await get().openTrustDialog(workspaceId, preview);
    } catch {
      markPrompted();
    }
  },

  fileView: null,
  closeFile: () => set({ fileView: null }),
  openFile: async (raw) => {
    const workspace = activeWorkspace(get());
    if (!workspace) return;
    const path = relativeToWorkspace(raw, workspace.path);
    set({ dockOpen: true, terminalOpen: false, browserOpen: false, dockTab: "files", inspectorTab: "files" });
    scheduleMemory(get);
    if (!path) { set({ fileView: { path: raw, loading: false, error: "That file is outside this workspace, so it cannot be shown here." } }); return; }
    if (!workspace.grantId && isTauri() && !get().preview) { set({ fileView: { path, loading: false, error: UNGRANTED_ERROR } }); return; }
    const pending = { path, loading: true };
    set({ fileView: pending });
    // The answer belongs to this request only: another file, a closed viewer
    // or a different folder in view all leave it unused.
    const owns = () => get().fileView === pending && (activeWorkspace(get())?.grantId ?? null) === (workspace.grantId ?? null);
    try {
      const file = get().preview ? mockWorkspaceFile(path) : await readWorkspaceFile(workspace.grantId ?? "preview", path);
      if (owns()) set({ fileView: { path, loading: false, file } });
    } catch (error) {
      if (owns()) set({ fileView: { path, loading: false, error: describeError("Could not open the file", error) } });
    }
  },

  refreshFileIndex: (workspaceId) => {
    const id = workspaceId ?? get().selectedWorkspaceId;
    if (!id) return;
    if (get().preview) { set({ fileIndex: { workspaceId: id, paths: MOCK_FILES, loadedAt: Date.now() } }); return; }
    const workspace = id === get().selectedWorkspaceId ? activeWorkspace(get()) : get().workspaces.find((item) => item.id === id);
    if (!workspace?.grantId) return;
    const grantId = workspace.grantId;
    if (fileIndexTimer) clearTimeout(fileIndexTimer);
    const wait = Math.max(FILE_INDEX_DEBOUNCE_MS, FILE_INDEX_MIN_GAP_MS - (Date.now() - fileIndexLastFetch));
    fileIndexTimer = setTimeout(() => {
      fileIndexTimer = null;
      fileIndexLastFetch = Date.now();
      void listWorkspaceFiles(grantId).then((paths) => {
        if (get().selectedWorkspaceId === id && activeWorkspace(get())?.grantId === grantId) set({ fileIndex: { workspaceId: id, paths, loadedAt: Date.now() } });
      }, (error) => log.warn("files.index.failed", { error: message(error) }));
    }, wait);
  },

  // Predicted starters on the empty state, opt-in via Settings → General. One
  // read-only turn on a quiet host: context is metadata only (paths, branch,
  // thread titles — never file contents), the reply must be strict JSON, and
  // results cache per workspace keyed to the state that produced them.
  refreshSuggestions: async (force = false) => {
    const state = get();
    const workspace = currentWorkspace(state);
    if (!workspace || state.offline || !state.suggestionsEnabled) return;
    if (suggestInFlight) {
      suggestFollowUp = { force: Boolean(suggestFollowUp?.force || force) };
      return suggestInFlight;
    }

    if (state.preview) {
      const preview: Suggestion[] = [
        { title: "Wire up the new feature", prompt: "Implement the next pending piece of the current task and keep it consistent with the existing patterns." },
        { title: "Review recent changes", prompt: "Review my uncommitted changes for bugs, edge cases, and anything to clean up before committing." },
        { title: "Add coverage for new code", prompt: "Find the code changed most recently that lacks tests and add meaningful coverage." },
        { title: "Tidy the workspace", prompt: "Look for dead code, stale TODOs, or inconsistencies in this codebase and clean them up." },
      ];
      set({ suggestions: { workspaceId: workspace.id, signature: "preview", items: preview, at: Date.now(), agentId: "harness" } });
      return;
    }

    const threads = state.threads
      .filter((thread) => thread.workspacePath === workspace.path)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((thread) => ({ title: thread.title, updatedAt: thread.updatedAt, lastOutcome: thread.lastOutcome, percentComplete: thread.goal?.percentComplete }));
    // A mid-refresh snapshot can still describe the previous workspace; leave it
    // out and the next trigger regenerates once it lands. Git or the file index
    // still loading is not a snapshot worth caching: the follow-up would
    // otherwise be served the git-less result for the whole rate-limit gap.
    const indexed = state.fileIndex?.workspaceId === workspace.id ? state.fileIndex : null;
    const gitPending = state.gitLoading;
    const snapshotComplete = !gitPending && indexed !== null;
    const git = gitPending ? null : state.git;
    const input = {
      workspace,
      git,
      files: indexed?.paths ?? [],
      threads,
      prompts: state.promptHistory[workspace.id] ?? [],
    };
    const signature = suggestionSignature(input);
    const cached = suggestionCache.get(workspace.id);
    const fresh = cached && cached.signature === signature && Date.now() - cached.at < SUGGESTION_TTL_MS;
    if (!force && fresh) {
      set({ suggestions: { workspaceId: workspace.id, signature, items: cached.items, at: cached.at } });
      return;
    }
    // Within the rate-limit gap, serve a complete cache rather than fetch again.
    if (!force && cached && snapshotComplete && Date.now() - cached.at < SUGGESTION_MIN_GAP_MS) {
      set({ suggestions: { workspaceId: workspace.id, signature: cached.signature, items: cached.items, at: cached.at } });
      return;
    }
    if (!snapshotComplete && !force && Date.now() - (incompleteSuggestAt.get(workspace.id) ?? 0) < SUGGESTION_MIN_GAP_MS) return;
    if (!workspace.grantId) return;

    const agentId: AgentId = "harness";
    if (!readyAgents(state).length) return;

    // Model: the user's override, else the cheapest entry in the agent's
    // catalog; when the catalog can't be read, the agent's own default runs.
    let modelId = state.suggestionsModelId?.trim() || undefined;
    let providerId: string | undefined;
    try {
      const catalog = modelCatalogs.get(agentId) ?? (await readModelCatalog(agentId, false, undefined, false)).models;
      // A fill only for an empty slot: a catalog that landed meanwhile is newer.
      if (!modelCatalogs.has(agentId)) modelCatalogs.set(agentId, catalog);
      const pick = cheapestModel(catalog);
      if (!modelId) modelId = pick?.modelId;
      providerId = catalog.find((model) => model.modelId === modelId)?.providerId;
    } catch (error) {
      log.warn("suggest.catalog.failed", { error: message(error) });
    }

    const runId = ++suggestRunId;
    const prompt = buildSuggestionPrompt(input);
    suggestInFlight = (async () => {
      try {
        const result = await bridge<{ text?: string }>("suggest", {
          agentId,
          grantId: workspace.grantId,
          prompt,
          timeoutMs: SUGGESTION_BUDGET_MS,
          ...(modelId ? { modelId } : {}),
          ...(providerId ? { providerId } : {}),
        }, { timeoutMs: SUGGESTION_BRIDGE_TIMEOUT_MS });
        const items = parseSuggestions(result.text ?? "");
        if (!items.length) return;
        const entry = { signature, items, at: Date.now() };
        if (snapshotComplete) suggestionCache.set(workspace.id, entry);
        else incompleteSuggestAt.set(workspace.id, entry.at);
        if (runId === suggestRunId && currentWorkspace(get())?.id === workspace.id && get().suggestionsEnabled) {
          set({ suggestions: { workspaceId: workspace.id, ...entry, agentId } });
        }
      } catch (error) {
        log.warn("suggest.failed", { error: message(error) });
        if (!snapshotComplete) incompleteSuggestAt.set(workspace.id, Date.now());
      }
    })().finally(() => {
      suggestInFlight = null;
      const again = suggestFollowUp;
      suggestFollowUp = null;
      if (again && get().suggestionsEnabled) void get().refreshSuggestions(again.force);
    });
    return suggestInFlight;
  },

  confirmTrust: async () => {
    const dialog = get().trustDialog;
    if (!dialog || !dialog.preview) return;
    const workspace = get().workspaces.find((item) => item.id === dialog.workspaceId);
    if (!workspace) return;
    // The decision counts once the native side holds it; if it cannot, say so and stay untrusted.
    if (workspace.grantId) {
      try { await setWorkspaceTrust(workspace.grantId, true); } catch (error) { set({ error: describeError("Could not trust this workspace", error) }); return; }
    }
    set({ workspaces: get().workspaces.map((item) => item.id === workspace.id ? { ...item, trusted: true } : item), trustDialog: null });
    scheduleMemory(get);
    // Trust lives in the settings document; without a save the next launch
    // runs untrusted again with no dialog to re-trust.
    void get().save();
    // Trusting the selected workspace restarts a running untrusted host.
    if (workspace.id === get().selectedWorkspaceId && get().hostInfo) {
      try { await get().startHost(); } catch (error) { set({ error: describeError("Could not reconnect", error) }); }
    }
  },

  untrustWorkspace: async (workspaceId) => {
    const workspace = get().workspaces.find((item) => item.id === workspaceId);
    if (!workspace?.trusted) return;
    // Untrusting must reach the native record or the agent keeps loading the folder's rules.
    if (workspace.grantId) {
      try { await setWorkspaceTrust(workspace.grantId, false); } catch (error) { set({ error: describeError("Could not stop trusting this workspace", error) }); return; }
    }
    set({ workspaces: get().workspaces.map((item) => item.id === workspaceId ? { ...item, trusted: false } : item) });
    scheduleMemory(get);
    void get().save();
    if (workspaceId === get().selectedWorkspaceId && get().hostInfo) {
      try { await get().startHost(); } catch (error) { set({ error: describeError("Could not reconnect", error) }); }
    }
  },

  refreshSkills: async (sessionId?: string) => {
    const id = sessionId ?? currentThread(get())?.sessionId;
    const thread = get().threads.find((item) => item.sessionId === id);
    if (!id || !thread || get().preview) return;
    try {
      const catalog = await bridge<{ skills?: SkillRow[] }>("listSkills", { sessionId: id, agentId: thread.agentId });
      set({ threads: get().threads.map((item) => item.sessionId === id ? { ...item, skills: catalog.skills ?? [] } : item) });
    } catch (error) {
      log.warn("skills.refresh.failed", { error: message(error) });
    }
  },

  refreshHarnessMcp: async (sessionId, refresh = false) => {
    if (get().harnessMcpLoading === sessionId) return;
    set({ harnessMcpLoading: sessionId, harnessMcp: { servers: [], error: null }, harnessMcpError: null });
    try {
      const status = await bridge<HarnessMcpStatus>("harnessMcp", { sessionId, agentId: "harness", ...(refresh ? { refresh: true } : {}) });
      if (currentThread(get())?.sessionId === sessionId) set({ harnessMcp: { servers: status.servers ?? [], error: status.error ?? null } });
    } catch (error) {
      if (currentThread(get())?.sessionId === sessionId) set({ harnessMcpError: describeError("Could not load the Harness MCP servers", error) });
    } finally {
      if (get().harnessMcpLoading === sessionId && currentThread(get())?.sessionId === sessionId) set({ harnessMcpLoading: null });
    }
  },

  refreshHarnessMcpConfig: async (sessionId) => {
    if (get().harnessMcpConfigLoading === sessionId) return;
    set({ harnessMcpConfigLoading: sessionId, harnessMcpConfig: { servers: [], error: null }, harnessMcpConfigError: null });
    try {
      const config = await bridge<HarnessMcpConfig>("harnessMcpConfig", { sessionId, agentId: "harness" });
      if (currentThread(get())?.sessionId === sessionId) set({ harnessMcpConfig: { servers: config.servers ?? [], error: config.error ?? null } });
    } catch (error) {
      if (currentThread(get())?.sessionId === sessionId) set({ harnessMcpConfigError: describeError("Could not load the Harness MCP configuration", error) });
    } finally {
      if (get().harnessMcpConfigLoading === sessionId && currentThread(get())?.sessionId === sessionId) set({ harnessMcpConfigLoading: null });
    }
  },

  addHarnessMcpServer: async (sessionId, scope, server) => {
    const config = await bridge<HarnessMcpConfig>("harnessMcpAddServer", { sessionId, agentId: "harness", scope, server });
    if (currentThread(get())?.sessionId === sessionId) set({ harnessMcpConfig: { servers: config.servers ?? [], error: config.error ?? null }, harnessMcpConfigError: null });
    await get().refreshHarnessMcp(sessionId, true);
  },

  removeHarnessMcpServer: async (sessionId, scope, name) => {
    const config = await bridge<HarnessMcpConfig>("harnessMcpRemoveServer", { sessionId, agentId: "harness", scope, name });
    if (currentThread(get())?.sessionId === sessionId) set({ harnessMcpConfig: { servers: config.servers ?? [], error: config.error ?? null }, harnessMcpConfigError: null });
    await get().refreshHarnessMcp(sessionId, true);
  },

  refreshCatalog: async () => {
    if (get().catalogLoading) return;
    set({ catalogLoading: true, catalogError: null });
    try {
      const listed = await catalogList(currentWorkspace(get())?.grantId ?? undefined);
      set({ catalogEntries: listed.entries ?? [], catalogSkillsRoot: listed.skillsRoot ?? null, catalogError: listed.error });
    } catch (error) {
      set({ catalogError: describeError("Could not load the extension store", error) });
    } finally {
      set({ catalogLoading: false });
    }
  },

  installCatalogEntry: async (id, sessionId) => {
    const result = await catalogInstall(id, currentWorkspace(get())?.grantId ?? undefined);
    await get().refreshCatalog();
    const thread = sessionId ? get().threads.find((item) => item.sessionId === sessionId) : undefined;
    if (sessionId && thread) {
      await get().refreshSkills(sessionId);
      await get().refreshHarnessMcp(sessionId, true);
    }
    return result;
  },

  removeCatalogEntry: async (id, sessionId) => {
    const result = await catalogRemove(id, currentWorkspace(get())?.grantId ?? undefined);
    await get().refreshCatalog();
    const thread = sessionId ? get().threads.find((item) => item.sessionId === sessionId) : undefined;
    if (sessionId && thread) {
      await get().refreshSkills(sessionId);
      await get().refreshHarnessMcp(sessionId, true);
    }
    return result;
  },

  refreshLibrary: async () => {
    if (get().libraryLoading) return;
    set({ libraryLoading: true, libraryError: null });
    try {
      const library = await libraryList();
      set({ library, libraryError: library.problems.length ? library.problems.join(" ") : null });
      if (library.avatarsPending) void fetchListingAvatars(get);
    } catch (error) {
      set({ libraryError: describeError("Could not read your plugins", error) });
    } finally {
      set({ libraryLoading: false });
    }
  },

  installLibraryPlugin: async (token, selected, sessionId) => {
    const outcome = await githubInstall(token, selected);
    await afterExtensionChange(get, sessionId);
    set({ libraryUpdates: get().libraryUpdates.filter((update) => update.id !== outcome.id) });
    return outcome;
  },

  setLibraryPluginEnabled: async (id, enabled, sessionId) => {
    const outcome = await librarySetEnabled(id, enabled);
    await afterExtensionChange(get, sessionId);
    return outcome;
  },

  removeLibraryPlugin: async (id, sessionId) => {
    const problems = await libraryRemove(id);
    set({ libraryUpdates: get().libraryUpdates.filter((update) => !(update.kind === "plugin" && update.id === id)) });
    await afterExtensionChange(get, sessionId);
    return problems;
  },

  addMarketplace: async (token) => {
    const source = await marketplaceAdd(token);
    listingAvatarsTried = false;
    await get().refreshLibrary();
    return source;
  },

  refreshMarketplace: async (id) => {
    const source = await marketplaceRefresh(id);
    listingAvatarsTried = false;
    set({ libraryUpdates: get().libraryUpdates.filter((update) => !(update.kind === "marketplace" && update.id === id)) });
    await get().refreshLibrary();
    return source;
  },

  removeMarketplace: async (id) => {
    await marketplaceRemove(id);
    await get().refreshLibrary();
  },

  checkLibraryUpdates: async () => {
    const updates = await libraryCheckUpdates();
    set({ libraryUpdates: updates });
    return updates;
  },

  openLastThread: async () => {
    const state = get();
    const pool = state.showAllWorkspaces ? state.threads : state.threads.filter((thread) => thread.workspacePath === currentWorkspace(state)?.path);
    const last = pool.filter((thread) => !thread.archived).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    if (last) await get().selectThread(last.sessionId);
  },

  setThreadSearch: (value) => set({ threadSearch: value }),
  setThreadSearchOpen: (open) => {
    if (open && get().sidebarCollapsed) get().setSidebarCollapsed(false);
    set(open ? { threadSearchOpen: true } : { threadSearchOpen: false, threadSearch: "" });
  },
  setSidebarCollapsed: (collapsed) => { set({ sidebarCollapsed: collapsed }); scheduleMemory(get); },
  setSidebarWidth: (width) => { set({ sidebarWidth: normalizeSidebarWidth(width) }); scheduleMemory(get); },
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  terminalOpen: false,
  setTerminalOpen: (open) => set({ terminalOpen: open, ...(open ? { dockOpen: false, dockExpanded: false, browserOpen: false } : {}) }),
  browserOpen: false,
  browserState: null,
  browserFrame: null,
  browserBusy: false,
  browserError: null,
  setBrowserOpen: (open) => set({ browserOpen: open, ...(open ? { dockOpen: false, dockExpanded: false, terminalOpen: false } : {}) }),
  openBrowser: async (url, viewport) => {
    const scope = activeWorkspace(get());
    get().setBrowserOpen(true);
    if (!scope?.grantId) {
      set({ browserError: "Open a workspace to use Browser." });
      return;
    }
    const root = scope.path;
    const current = () => activeWorkspace(get())?.path === root;
    set({ browserBusy: true, browserError: null });
    try {
      const result = await bridge<BrowserControlResult>("browserOpen", { grantId: scope.grantId, ...(url ? { url } : {}), ...(viewport ?? {}) });
      if (current()) set({ browserState: result.state, browserError: null });
    } catch (error) {
      if (current()) set({ browserError: describeError("Could not open Browser", error) });
    } finally {
      if (current()) set({ browserBusy: false });
    }
  },
  controlBrowser: async (input) => {
    const scope = activeWorkspace(get());
    if (!scope?.grantId) {
      set({ browserError: "Open a workspace to use Browser." });
      return null;
    }
    const root = scope.path;
    const current = () => activeWorkspace(get())?.path === root;
    const busy = ["navigate", "back", "forward", "reload"].includes(input.action);
    if (busy) set({ browserBusy: true });
    try {
      const result = await bridge<BrowserControlResult>("browserControl", { ...input, grantId: scope.grantId });
      if (current()) set({
        browserState: result.state,
        browserError: null,
        ...(result.image ? { browserFrame: { workspaceRoot: root, mediaType: result.image.mediaType, data: result.image.data, url: result.state.url, sequence: (get().browserFrame?.sequence ?? 0) + 1 } } : {}),
      });
      return result;
    } catch (error) {
      if (current()) set({ browserError: describeError("Browser action failed", error) });
      return null;
    } finally {
      if (busy && current()) set({ browserBusy: false });
    }
  },
  closeBrowser: async () => {
    const scope = activeWorkspace(get());
    const root = scope?.path;
    if (!scope?.grantId || !root) {
      get().setBrowserOpen(false);
      set({ browserState: null, browserFrame: null });
      return;
    }
    try {
      await bridge<BrowserControlResult>("browserClose", { grantId: scope.grantId });
      if (activeWorkspace(get())?.path === root) set({ browserState: null, browserFrame: null, browserError: null, browserBusy: false });
      get().setBrowserOpen(false);
    } catch (error) {
      if (activeWorkspace(get())?.path === root) set({ browserError: describeError("Could not close Browser", error) });
    }
  },
  findOpen: false,
  findFocus: 0,
  setFindOpen: (open) => set({ findOpen: open, findFocus: get().findFocus + 1 }),
  selectThreadAt: async (index) => {
    const target = workspaceThreads(get())[index];
    if (target && target.sessionId !== get().selectedSessionId) await get().selectThread(target.sessionId);
  },
  selectAdjacentThread: async (delta) => {
    const ordered = workspaceThreads(get());
    if (!ordered.length) return;
    const at = ordered.findIndex((thread) => thread.sessionId === get().selectedSessionId);
    const target = ordered[at < 0 ? (delta > 0 ? 0 : ordered.length - 1) : (at + delta + ordered.length) % ordered.length];
    if (target.sessionId !== get().selectedSessionId) await get().selectThread(target.sessionId);
  },
  recentCommands: [],
  noteCommand: (id) => { set({ recentCommands: rememberCommand(get().recentCommands, id) }); scheduleMemory(get); },
  setOffline: (offline) => set({ offline }),
  setShowArchived: (show) => set({ showArchived: show }),
  setInspectorTab: (tab) => set({ inspectorTab: tab, dockTab: tab }),

  selectWorkspace: async (id) => {
    const begun = beginWorkspaceSelection(get, set, id);
    if (!begun) return;
    if (get().preview) { await get().refreshModels(); return; }
    // The listing is applied while its workspace is still the open one. Tying it
    // to the selection *version* dropped it whenever the user did anything else
    // meanwhile (even starting a thread), leaving the sidebar without its threads.
    await listWorkspaceThreads(get, set, begun.workspace, () => get().selectedWorkspaceId === id, false);
    void get().promptWorkspaceTrust(id);
  },

  // Expanding a workspace in the tree fills its thread list without stealing
  // the selection, so several workspaces can stay open side by side.
  loadWorkspaceThreads: async (id) => {
    const workspace = get().workspaces.find((item) => item.id === id);
    if (!workspace || get().preview || !workspace.grantId) return;
    // A background expansion only fills a list, so it stays valid however the
    // selection moves — until the workspace itself is removed.
    await listWorkspaceThreads(get, set, workspace, () => get().workspaces.some((item) => item.id === id), true);
  },

  selectThread: async (sessionId) => {
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    if (!thread) return;
    const workspace = get().workspaces.find((item) => item.path === thread.workspacePath);
    if (!workspace) return;
    const workspaceChanged = get().selectedWorkspaceId !== workspace.id;
    const scope = activeWorkspace(get())?.grantId;
    ++selectionVersion;
    ++reviewVersion;
    set({ ...switchDraft(get(), workspace.id, sessionId), error: null, review: null, reviewError: null, reviewLoading: null, ...(workspaceChanged || get().reviewScope === "lastTurn" ? { diffTabs: null, diffActive: null } : {}), ...(workspaceChanged ? { git: null, gitError: null, gitGraph: null, gitGraphLoading: null, gitGraphError: null, reviewBase: "" } : {}), threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, unread: false } : item) });
    scheduleMemory(get);
    if (workspaceChanged) void get().refreshGit();
    else rescope(get, set, scope);
    if (get().preview || thread.opening) return;
    if (thread.opened) {
      void get().refreshTurnSnapshots(sessionId);
      if (!get().models.length) void get().refreshModels();
      return;
    }
    // Same fail-closed rule as every other session entry point: a stale
    // native binding must not let an ungranted workspace keep opening threads.
    const home = threadScope(get(), thread) ?? workspace;
    if (!home.grantId && isTauri()) {
      set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, error: UNGRANTED_ERROR } : item) });
      return;
    }
    const update = (patch: Partial<Thread>) => set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, ...patch } : item) });
    update({ opening: true, error: null });
    try {
      await get().applyHarnessRules();
      const opened = await bridge<{ agentConfig?: AgentSessionConfig; alreadyOpen?: boolean }>("resumeSession", { agentId: "harness", sessionId });
      // A reopened thread keeps the app's permission mode.
      const approvalMode = approvalModeForAgent("harness", thread.config?.approvalMode);
      if (approvalMode) await bridge("setApprovalMode", { agentId: "harness", sessionId, mode: approvalMode }).catch(() => {});
      void get().refreshTurnSnapshots(sessionId);
      update({ opened: true, config: { ...thread.config, ...agentConfigPatch(opened.agentConfig), agentId: "harness", ...(approvalMode ? { approvalMode } : {}) }, modes: opened.agentConfig?.modes ?? thread.modes });
      // The picker keeps showing the last catalog meanwhile; opening does not wait on it.
      if (get().selectedSessionId === sessionId) void get().refreshModels();
    } catch (error) {
      update({ error: describeError("Could not open the thread", error), opened: false });
    } finally { update({ opening: false }); }
  },

  newThread: async () => {
    if (get().starting) return;
    const workspace = currentWorkspace(get());
    if (!workspace) { set({ error: "Add a workspace folder first." }); return; }
    if (!workspace.grantId && isTauri() && !get().preview) { set({ error: UNGRANTED_ERROR }); return; }
    // A new thread is the workspace draft until its first send starts the
    // session (sendPrompt → createThread). Starting one here left an empty
    // "New thread" row and a live CLI session behind whenever nothing was sent.
    // The version bump also stops a launch restore from pulling the user back.
    ++selectionVersion;
    const scope = activeWorkspace(get())?.grantId;
    if (get().selectedSessionId) {
      const projectKey = `project:${workspace.id}`;
      const next = switchDraft(get(), workspace.id, null);
      // Like a fresh session, the draft starts from the defaults rather than
      // whatever agent or model an earlier draft left behind.
      set({ ...next, drafts: { ...next.drafts, [projectKey]: { ...next.drafts[projectKey], text: next.composer, images: next.images, config: undefined } }, error: null });
      scheduleMemory(get);
      if (!get().models.length) void get().refreshModels();
      rescope(get, set, scope);
    }
    set({ restoringSession: null, composerFocus: get().composerFocus + 1 });
  },

  selectNextAttentionThread: async () => {
    const state = get();
    const rank = new Map(state.workspaces.map((workspace, index) => [workspace.path, index]));
    const ordered = state.threads
      .filter((thread) => !thread.archived && rank.has(thread.workspacePath))
      .sort((a, b) => rank.get(a.workspacePath)! - rank.get(b.workspacePath)! || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.order ?? 0) - (a.order ?? 0));
    const next = nextAttentionThread(ordered, state.selectedSessionId);
    if (next && next.sessionId !== state.selectedSessionId) await get().selectThread(next.sessionId);
  },

  createThread: async () => {
    // Which agent a new thread uses depends on detection; at launch it may still be running.
    // Capture the workspace before that wait. A switch during it used to be
    // overwritten: the version bump happened afterwards, so the new session
    // was created in whichever folder was current and the user was pulled onto it.
    const workspace = currentWorkspace(get());
    if (!workspace) { set({ error: "Add a workspace folder first." }); return null; }
    const versionBeforeDetection = selectionVersion;
    if (detectionInFlight) await detectionSettled();
    if (selectionVersion !== versionBeforeDetection) return null;
    if (get().starting) return null;
    if (get().selectedWorkspaceId !== workspace.id) return null;
    if (!workspace.grantId && isTauri() && !get().preview) { set({ error: UNGRANTED_ERROR }); return null; }
    const version = ++selectionVersion;
    const scope = activeWorkspace(get())?.grantId;
    const sourceKey = draftKey(get());
    const fromProject = !get().selectedSessionId;
    const config = fromProject ? get().drafts[sourceKey]?.config ?? defaults(get()) : defaults(get());
    set({ starting: true, error: null });
    const agentId: AgentId = "harness";
    const approvalMode = approvalModeForAgent(agentId, config.approvalMode);
    try {
      let thread: Thread;
      const existingCount = get().threads.filter((t) => t.workspacePath === workspace.path && /^(New thread|Untitled thread)/.test(t.title)).length;
      const title = existingCount === 0 ? "New thread" : `New thread ${existingCount + 1}`;
      // The worktree exists before the session does, so the agent starts in it.
      // A session that then fails to start takes its empty worktree with it.
      const wanted = fromProject ? get().drafts[sourceKey]?.worktree : undefined;
      const made = !wanted ? undefined : get().preview ? mockWorktree(wanted.base) : await gitWorktreeCreate(workspace.grantId ?? "preview", wanted.base);
      const worktree: ThreadWorktree | undefined = made && { grantId: made.grantId, path: made.path, branch: made.branch, base: made.base, workspaceId: workspace.id };
      const notice = made?.warning ? { notice: { level: "warning" as const, message: made.warning } } : {};
      if (get().preview) {
        thread = { sessionId: `preview-${uid()}`, agentId, workspacePath: workspace.path, worktree, title, order: Date.now(), updatedAt: new Date().toISOString(), status: "idle", unread: false, items: [], opened: true, config: { ...config, agentId, mode: "build" }, modes: HARNESS_MODES, ...notice };
      } else {
        // Only hand over a model the catalog listed.
        const ownModel = get().models.some((model) => model.modelId === config.modelId);
        const mode = config.mode ?? get().agentModes[agentId]?.defaultMode;
        // Orchestrator replaces the manual model and effort. A draft switched in
        // the composer carries its own answer; otherwise Settings decides.
        const orchestrator = config.orchestrator !== undefined ? config.orchestrator ?? undefined : orchestratorStart(get());
        await get().applyHarnessRules();
        let opened: { sessionId: string; agentConfig?: AgentSessionConfig };
        try {
          opened = await bridge<{ sessionId: string; agentConfig?: AgentSessionConfig }>("startSession", { agentId, grantId: worktree?.grantId ?? workspace.grantId ?? undefined, ...(orchestrator ? { orchestrator } : { modelId: ownModel ? config.modelId : undefined, reasoningEffort: config.effort }), ...(mode ? { mode } : {}), ...(approvalMode ? { approvalMode } : {}) });
        } catch (error) {
          if (worktree) await gitWorktreeRemove(worktree.grantId).catch(() => {});
          throw error;
        }
        thread = { sessionId: opened.sessionId, agentId, workspacePath: workspace.path, worktree, title, order: Date.now(), updatedAt: new Date().toISOString(), status: "idle", unread: false, items: [], opened: true, config: { ...config, ...agentConfigPatch(opened.agentConfig), ...(approvalMode ? { approvalMode } : {}), agentId }, modes: opened.agentConfig?.modes, ...notice };
      }
      const opened = { sessionId: thread.sessionId };
      set({ threads: [thread, ...get().threads] });
      scheduleMemory(get);
      if (version === selectionVersion) {
        const draft = { text: get().composer, images: get().images, refs: get().contextRefs, config };
        set(switchDraft(get(), workspace.id, opened.sessionId));
        // The Local or Worktree choice stays with the workspace for the next new thread.
        if (fromProject) set({ composer: draft.text, images: draft.images, contextRefs: draft.refs ?? [], drafts: { ...get().drafts, [sourceKey]: { text: "", images: [], refs: [], config, worktree: get().drafts[sourceKey]?.worktree }, [`thread:${opened.sessionId}`]: draft } });
        rescope(get, set, scope);
      }
      return opened.sessionId;
    } catch (error) {
      set({ error: sentenceAfter(describeError("Could not start the thread", error), "Your draft is unchanged.") });
      return null;
    } finally { set({ starting: false }); }
  },

  refreshTurnSnapshots: async (sessionId) => {
    const state = get();
    const thread = state.threads.find((item) => item.sessionId === sessionId);
    const workspace = threadScope(state, thread);
    if (!thread || thread.snapshotPending || state.preview || !workspace?.grantId) return;
    const held = thread.snapshots;
    try {
      const snapshots = await turnSnapshots(workspace.grantId, sessionId);
      if (threadScope(get(), thread)?.grantId !== workspace.grantId) return;
      set({ threads: get().threads.map((item) => item.sessionId === sessionId && !item.snapshotPending && item.snapshots === held ? { ...item, snapshots: Object.fromEntries(snapshots.filter((snapshot) => snapshot.turnId).map((snapshot) => [snapshot.turnId!, snapshot])) } : item) });
    } catch { /* Old or unavailable checkpoints never prevent opening a thread. */ }
  },

  restoreSnapshot: async (sessionId, turnId, options) => {
    const state = get();
    const thread = state.threads.find((item) => item.sessionId === sessionId);
    const workspace = threadScope(state, thread);
    const snapshot = thread?.snapshots?.[turnId];
    if (!thread || !workspace || !snapshot || !["ready", "undone"].includes(snapshot.state) || thread.snapshotPending || thread.rewindPending && !options?.confirmed || state.submitting || thread.status === "running") return false;
    const reapply = snapshot.state === "undone";
    const verb = reapply ? "Reapply" : "Undo";
    let restored = false;
    const update = (patch: Partial<Thread>) => set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, ...patch } : item) });
    update({ snapshotPending: turnId, snapshotError: undefined });
    try {
      const confirmed = options?.confirmed || await state.confirm({ title: `${verb} this turn’s ${snapshot.files.length} file change${snapshot.files.length === 1 ? "" : "s"}?`, body: "This restores the saved file contents and keeps the thread history. Changes made by shell commands or another app during the turn cannot be separated from the agent’s edits. Every affected file must still match the saved state; otherwise nothing is restored.", confirmLabel: verb });
      if (!confirmed) return false;
      const live = get().threads.find((item) => item.sessionId === sessionId);
      if (!live || live.status === "running" || get().submitting || get().selectedSessionId !== sessionId || get().selectedWorkspaceId !== workspace.id || threadScope(get(), live)?.grantId !== workspace.grantId || live.snapshots?.[turnId] !== snapshot) return false;
      if (state.preview) {
        update({ snapshots: { ...live.snapshots, [turnId]: { ...snapshot, state: reapply ? "ready" : "undone" } }, notice: { level: "info", message: "Preview — no workspace files were changed." } });
        return true;
      }
      if (!workspace.grantId) throw new Error(UNGRANTED_ERROR);
      const selection = selectionVersion;
      await runGitMutation(workspace, selection, async () => {
        const result = await restoreTurnSnapshot(workspace.grantId!, sessionId, snapshot.snapshotId, reapply);
        if (result.conflicts.length) throw new Error(`Files changed since the saved state: ${result.conflicts.slice(0, 8).join(", ")}${result.conflicts.length > 8 ? ` and ${result.conflicts.length - 8} more` : ""}. Nothing was restored.`);
        restored = true;
        const current = get().threads.find((item) => item.sessionId === sessionId);
        if (current?.snapshots?.[turnId] === snapshot) update({ snapshots: { ...current.snapshots, [turnId]: result.snapshot } });
        return gitSnapshot(workspace.grantId!);
      });
      get().refreshFileIndex();
    } catch (error) { update({ snapshotError: { turnId, message: describeError(restored ? "Files restored; Changes could not refresh" : `${verb} failed`, error) } }); }
    finally { update({ snapshotPending: undefined }); }
    return restored;
  },

  sendPrompt: async (options) => {
    const initial = get();
    const active = currentThread(initial);
    if (initial.starting || initial.submitting || active?.opening || active?.configPending || active?.snapshotPending || active?.rewindPending) return false;
    // Harness accepts busy sends; preview keeps the Stop-to-send lock.
    const busySend = active?.status === "running" && !initial.preview;
    if (active?.status === "running" && !busySend) return false;
    if (!currentWorkspace(initial)) { set({ error: "Open a workspace before sending." }); return false; }
    const text = initial.composer.trim();
    const images = initial.images;
    const refs = initial.contextRefs;
    if (!text && !images.length && !refs.length) return false;
    const payload = composePrompt(text, refs);
    // Persist the draft now: a pending debounce firing mid-send would be fine
    // (it reads get() at fire time), but this guarantees it lands before the
    // composer is cleared on success.
    flushDraft(get);
    set({ submitting: true, error: null });
    let sessionId = initial.selectedSessionId;
    // The composer empties the moment the message is sent, not when the agent
    // acknowledges it: starting a session or a turn can take seconds, and text
    // left sitting there reads as a send that did not happen. The message is
    // held here and put back if it turns out it never went. Busy sends and the
    // shell escape keep their own text-matched retry handling.
    const sourceKey = draftKey(initial);
    const held = !busySend ? { text: initial.composer, images, refs } : null;
    let delivered = false;
    if (held) {
      set({ composer: "", images: [], contextRefs: [], drafts: { ...initial.drafts, [sourceKey]: { ...initial.drafts[sourceKey], text: "", images: [], refs: [] } }, ...(!sessionId && initial.selectedWorkspaceId ? { pendingSend: { workspaceId: initial.selectedWorkspaceId, text: text || payload, images } } : {}) });
    }
    const putBack = () => {
      if (!held || delivered) return;
      const key = sessionId ? `thread:${sessionId}` : sourceKey;
      const live = get();
      if (draftKey(live) === key) {
        if (!live.composer && !live.images.length && !live.contextRefs.length) set({ composer: held.text, images: held.images, contextRefs: held.refs });
      } else if (!live.drafts[key]?.text && !live.drafts[key]?.images?.length) {
        set({ drafts: { ...live.drafts, [key]: { ...live.drafts[key], text: held.text, images: held.images, refs: held.refs } } });
      }
      scheduleMemory(get);
    };
    try {
      if (!sessionId) {
        // The session belongs to this send even if the user has moved to another
        // thread while it started: the message follows it there instead of being
        // stranded in the workspace draft.
        sessionId = held ? await get().createThread().finally(() => set({ pendingSend: null })) : await get().createThread();
      }
      if (!sessionId) return false;
      const thread = get().threads.find((item) => item.sessionId === sessionId);
      if (!thread?.opened && !get().preview) throw new Error("Thread is not open. Select it again to reconnect before sending.");
      await get().applyHarnessRules();
      // A leading `/selector` invokes a session skill for real: the typed
      // spelling matches the catalog verbatim (unknown stays plain text),
      // and the invocation travels as a structured skill part.
      const invocation = parseSkillInvocation(text);
      const skill = thread && invocation
        ? (thread.skills ?? []).find((row) => row.selector.replace(/^\//, "").toLowerCase() === invocation.selector.replace(/^\//, "").toLowerCase())
        : undefined;
      const skillPart = skill ? { selector: skill.selector, ...(invocation!.args ? { arguments: invocation!.args } : {}) } : undefined;
      if (busySend && thread) {
        await sendBusyTurn(sessionId, options?.disposition ?? "queue", skillPart ? composePrompt("", refs) : payload, text, images, skillPart, thread.agentId, options?.shape);
        return true;
      }
      const previousOutcome = thread?.lastOutcome;
      const userItem: TranscriptItem = { itemId: uid(), kind: "userMessage", status: "completed", text: text || payload, images, refs, recordedAt: new Date().toISOString(), optimistic: !get().preview, ...(get().preview ? { turnId: `preview-turn-${uid()}` } : {}) };
      set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...applyItem(item, userItem), status: "running", error: null, activeTurnId: get().preview ? userItem.turnId : null, cancelRequested: false, activity: "working", lastOutcome: undefined, recoveryDismissed: false, turnStartedAt: Date.now(), turnStartOutput: item.usage?.outputTokens ?? 0, turnStartPrompt: item.usage?.promptTokens ?? 0, turnStartCache: cacheTokens(item.usage), turnStats: undefined, tokenSpeed: undefined, turnCalls: [], ...(options?.resetTaskState ? { plan: undefined, planAnchor: undefined, goal: null } : {}) } : item) });
      try {
        if (get().preview) {
          const id = sessionId;
          previewTimers.set(id, window.setTimeout(() => {
            previewTimers.delete(id);
            set({ threads: get().threads.map((item) => item.sessionId === id && item.status === "running" ? { ...applyItem(item, { itemId: uid(), kind: "agentMessage", status: "completed", turnId: userItem.turnId, recordedAt: new Date().toISOString(), text: "Preview response — open the desktop app and add a provider key to work in a real workspace." }), status: "idle", lastTurnId: userItem.turnId, lastOutcome: "completed", activeTurnId: null, unread: get().selectedSessionId !== id, activity: undefined } : item) });
          }, 1600));
        } else {
          const result = await bridge<{ turnId: string; deduped?: boolean }>("sendTurn", { agentId: "harness", sessionId, text: skillPart ? composePrompt("", refs) : payload, reasoningEffort: thread?.config?.effort, images: images.map(({ mediaType, base64Data }) => ({ mediaType, base64Data })), ...(skillPart ? { skill: skillPart } : {}), ...(options?.shape ? { forcedShape: options.shape } : {}) });
          const latest = get().threads.find((item) => item.sessionId === sessionId);
          if (latest?.status === "running" && latest.lastTurnId !== result.turnId) {
            set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, activeTurnId: result.turnId, pendingTurnKey: null, notice: result.deduped ? { level: "info", message: "Resumed the pending turn instead of sending a duplicate." } : item.notice } : item) });
            if (latest.cancelRequested) await cancelSession(sessionId, result.turnId);
          } else {
            set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, pendingTurnKey: null } : item) });
          }
        }
        recordPrompt(initial.selectedWorkspaceId, text);
        delivered = true;
      } catch (error) {
        // The classified reason (host detail + recovery) belongs on screen —
        // the title alone used to answer "what happened" with "Send failed".
        set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, items: item.items.filter((entry) => entry.itemId !== userItem.itemId), status: "error", activeTurnId: null, pendingTurnKey: null, cancelRequested: false, activity: undefined, error: describeError("Send failed", error), lastOutcome: previousOutcome } : item) });
        // The catalog moved under us: refresh it so the next pick is real.
        if ((error as Error & { code?: string })?.code === "skillNotFound") void get().refreshSkills(sessionId).catch(() => {});
      }
    } catch (error) { set({ error: describeError("Send failed", error) }); }
    finally { putBack(); set({ submitting: false }); }
    return delivered;
  },

  stopTurn: async () => {
    const thread = currentThread(get());
    if (!thread || thread.status !== "running" || thread.cancelRequested) return;
    set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, cancelRequested: true, error: null,
      approvalFeedback: item.approvalFeedback?.map((entry) => entry.state === "queued" ? { ...entry, state: "failed" as const, error: "Turn stopped. Feedback was not sent." } : entry),
    } : item) });
    if (get().preview) {
      window.clearTimeout(previewTimers.get(thread.sessionId));
      previewTimers.delete(thread.sessionId);
      set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? {
        ...item,
        ...finishTurn(item, item.activeTurnId ?? item.lastTurnId),
        status: "idle",
        lastOutcome: "cancelled",
        activeTurnId: null,
        lastTurnId: item.activeTurnId ?? item.lastTurnId,
        pendingApproval: null,
        queuedApprovals: [],
        cancelRequested: false,
        activity: undefined,
        plan: settlePlan(item.plan, "cancelled"),
        items: settleItems(item.items, "cancelled", true),
      } : item) });
    } else {
      // Stop drains the queue too: queued turns would otherwise launch the
      // moment the active turn dies, contradicting the user's stop.
      const queued = thread.queuedTurns ?? [];
      if (queued.length) {
        await Promise.allSettled(queued.map((entry) => bridge("unqueueTurn", { sessionId: thread.sessionId, turnId: entry.turnId, agentId: thread.agentId })));
        set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, queuedTurns: [] } : item) });
      }
      await cancelSession(thread.sessionId, thread.activeTurnId ?? undefined);
      // If the stop never reached the host (cancel delivery failed, no terminal event coming),
      // don't strand the thread: park it idle with the key retained so the next send dedupes.
      const stuck = get().threads.find((item) => item.sessionId === thread.sessionId);
      if (stuck?.status === "running" && !stuck.cancelRequested) {
        const parked = stuck.pendingTurnKey
          ? "Stop may not have reached the agent. Retry is safe — it resumes the pending turn."
          : "Stop may not have reached the agent. Check the thread before retrying.";
        set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, status: "idle", activity: undefined, error: parked, notice: null } : item) });
      }
    }
  },

  unqueueTurn: async (turnId) => {
    const thread = currentThread(get());
    if (!thread || get().preview) return;
    if (!(thread.queuedTurns ?? []).some((entry) => entry.turnId === turnId)) return;
    try {
      await bridge("unqueueTurn", { sessionId: thread.sessionId, turnId, agentId: thread.agentId });
      set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, queuedTurns: (item.queuedTurns ?? []).filter((entry) => entry.turnId !== turnId) } : item) });
    } catch (error) {
      // A failed reclaim usually means the turn already launched: its
      // turnStarted event promotes it, so the entry is left to reconcile.
      set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, notice: { level: "warning", message: describeError("Could not reclaim the queued turn", error) } } : item) });
    }
  },

  pickApprovalScope: (approvalId, choiceId) => {
    set({ threads: get().threads.map((item) => item.pendingApproval?.approvalId === approvalId ? { ...item, approvalScope: { approvalId, choiceId } } : item) });
  },

  decide: async (approvalId, choiceId, feedback) => {
    const thread = get().threads.find((item) => item.pendingApproval?.approvalId === approvalId || item.queuedApprovals?.some((queued) => queued.approvalId === approvalId));
    if (!thread || thread.approvalPending || thread.cancelRequested) return;
    const approval = [thread.pendingApproval, ...(thread.queuedApprovals ?? [])].find((request) => request?.approvalId === approvalId);
    const choice = approval?.availableChoices.find((option) => option.choiceId === choiceId);
    if (!choice || (approval?.expiresAt != null && approval.expiresAt <= Date.now())) return;
    const explanation = choice.decision.startsWith("denied") ? feedback?.trim() : undefined;
    const update = (patch: Partial<Thread>) => set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, ...patch } : item) });
    const settle = () => set({ threads: get().threads.map((item) => {
      if (item.sessionId !== thread.sessionId) return item;
      return item.pendingApproval?.approvalId === approvalId ? advanceApprovals(item) : dropApproval(item, approvalId).thread;
    }) });
    update({ approvalPending: true, error: null });
    try {
      if (!choice.decision.startsWith("denied")) await get().applyHarnessRules();
      if (!get().preview) await bridge("decideApproval", { approvalId, choiceId, sessionId: thread.sessionId });
      settle();
      if (explanation) {
        set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? {
          ...item, approvalFeedback: [...(item.approvalFeedback ?? []), { id: uid(), text: explanation, state: "queued" as const }],
        } : item) });
        await deliverApprovalFeedback(thread.sessionId);
      }
    } catch (error) {
      if (/no (longer )?pending approval/i.test(message(error))) {
        // Decided elsewhere (or already settled): drop it and surface the next waiter.
        set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...dropApproval(item, approvalId).thread, notice: { level: "info", message: "That approval was already resolved." } } : item) });
      } else update({ error: sentenceAfter(describeError("Approval failed", error), "Try again or stop the turn.") });
    }
    finally { update({ approvalPending: false }); }
  },

  reclaimApprovalFeedback: (sessionId, id) => {
    const state = get();
    const thread = state.threads.find((item) => item.sessionId === sessionId);
    const feedback = thread?.approvalFeedback?.find((entry) => entry.id === id);
    if (!feedback || feedback.state === "sending") return;
    const key = `thread:${sessionId}`;
    const selected = state.selectedSessionId === sessionId;
    const draft = selected ? { text: state.composer, images: state.images, refs: state.contextRefs } : state.drafts[key];
    const text = [draft?.text, feedback.text].filter(Boolean).join("\n\n");
    set({ ...(selected ? { composer: text } : {}),
      drafts: { ...state.drafts, [key]: { ...state.drafts[key], ...draft, text, images: draft?.images ?? [] } },
      threads: state.threads.map((item) => item.sessionId === sessionId ? { ...item, approvalFeedback: item.approvalFeedback?.filter((entry) => entry.id !== id) } : item),
    });
    scheduleMemory(get);
  },

  respondUserInput: async (sessionId, userInputId, response) => {
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    if (!thread || thread.userInputPending || !thread.userInputs?.some((request) => request.userInputId === userInputId)) return;
    const update = (patch: Partial<Thread>) => set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, ...patch } : item) });
    update({ userInputPending: userInputId, error: null });
    try {
      await get().applyHarnessRules();
      if (!get().preview) await bridge("respondUserInput", { sessionId, userInputId, response });
      update({ userInputs: get().threads.find((item) => item.sessionId === sessionId)?.userInputs?.filter((request) => request.userInputId !== userInputId) });
    } catch (error) { update({ error: sentenceAfter(describeError("Could not respond", error), "Your answer is retained; retry or cancel the question.") }); }
    finally { update({ userInputPending: undefined }); }
  },

  setReviewScope: (scope) => {
    ++reviewVersion;
    set({ reviewScope: scope, review: null, reviewError: null, reviewLoading: null, diffTabs: null, diffActive: null });
  },
  setReviewBase: (base) => {
    ++reviewVersion;
    set({ reviewBase: base.trim(), review: null, reviewError: null, reviewLoading: null, diffTabs: null, diffActive: null });
  },
  refreshReview: async () => {
    const state = get();
    const version = ++reviewVersion;
    const target = reviewTarget(state);
    const workspace = activeWorkspace(state);
    if (state.reviewScope === "all" || !workspace || !target.request || state.gitLoading) {
      set({ review: null, reviewLoading: null, reviewError: null }); return;
    }
    if (!workspace.grantId && isTauri() && !state.preview) {
      set({ review: null, reviewLoading: null, reviewError: { key: target.key, message: UNGRANTED_ERROR } }); return;
    }
    const selection = selectionVersion;
    const gitReadVersion = gitVersion;
    const owns = () => version === reviewVersion && selection === selectionVersion && gitReadVersion === gitVersion && target.key === reviewTarget(get()).key;
    set({ review: null, reviewLoading: target.key, reviewError: null });
    try {
      const data = state.preview ? mockGitReview(target.request) : await gitReview(workspace.grantId ?? "preview", target.request);
      if (owns()) set({ review: { key: target.key, data } });
    } catch (error) {
      if (owns()) set({ reviewError: { key: target.key, message: describeError("Could not load the review", error) } });
    } finally {
      if (version === reviewVersion) set({ reviewLoading: null });
    }
  },

  refreshGit: async () => {
    // An explicit read supersedes anything the debounce armed — otherwise the
    // trailing timer would fire a second, identical read right behind this one.
    cancelScheduledGitRefresh();
    ++gitGraphVersion;
    if (get().preview) { set({ git: MOCK_GIT, gitError: null, gitLoading: false, gitGraph: null, gitGraphLoading: null, gitGraphError: null }); return; }
    const version = ++gitVersion;
    const workspace = activeWorkspace(get());
    if (!workspace) { set({ git: null, gitError: null, gitLoading: false, gitGraph: null, gitGraphLoading: null, gitGraphError: null }); return; }
    if (!workspace.grantId && isTauri()) { set({ git: null, gitError: UNGRANTED_ERROR, gitLoading: false, gitGraph: null, gitGraphLoading: null, gitGraphError: null }); return; }
    const grantId = workspace.grantId ?? null;
    // A read applies only while the workspace, grant and request version are
    // all still current — a grant re-issue or a newer call owns the answer.
    const owns = () => version === gitVersion
      && get().selectedWorkspaceId === workspace.id
      && (activeWorkspace(get())?.grantId ?? null) === grantId;
    set({ gitLoading: true, gitError: null, gitGraphLoading: null });
    try {
      const git = await gitSnapshot(grantId ?? "preview");
      if (owns()) set({ git, gitGraph: null, gitGraphError: null });
    } catch (error) {
      if (owns()) set({ git: null, gitError: describeError("Could not load the changes", error) });
    } finally {
      if (owns()) set({ gitLoading: false });
      // An edit completed while this read was in flight: the snapshot it just
      // missed is owed another look once the debounce settles.
      firePendingGitRefresh();
    }
  },

  refreshGitGraph: async () => {
    const state = get();
    const version = ++gitGraphVersion;
    const selection = selectionVersion;
    const workspace = activeWorkspace(state);
    if (!workspace) { set({ gitGraph: null, gitGraphLoading: null, gitGraphError: null }); return; }
    const grantId = workspace.grantId ?? null;
    const key = `${workspace.id}\u0000${grantId ?? ""}`;
    if (!grantId && isTauri() && !state.preview) {
      set({ gitGraph: null, gitGraphLoading: null, gitGraphError: { key, message: UNGRANTED_ERROR } }); return;
    }
    const owns = () => version === gitGraphVersion
      && selection === selectionVersion
      && get().selectedWorkspaceId === workspace.id
      && (activeWorkspace(get())?.grantId ?? null) === grantId;
    set({ gitGraphLoading: key, gitGraphError: null });
    try {
      const data = state.preview ? MOCK_GIT_GRAPH : await readGitGraph(grantId ?? "preview");
      if (owns()) set({ gitGraph: { key, data } });
    } catch (error) {
      if (owns()) set({ gitGraph: null, gitGraphError: { key, message: describeError("Could not load the Git graph", error) } });
    } finally {
      if (version === gitGraphVersion) set({ gitGraphLoading: null });
    }
  },

  scheduleGitRefresh: () => {
    const state = get();
    if (state.preview) return;
    const workspace = activeWorkspace(state);
    if (!workspace) return;
    const workspaceId = workspace.id;
    const grantId = workspace.grantId ?? null;
    if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
    gitRefreshTimer = setTimeout(() => {
      gitRefreshTimer = null;
      const live = get();
      const current = activeWorkspace(live);
      // The armed read only runs if the workspace and grant it was scheduled
      // for are still the selected ones — a switch quietly drops it.
      if (live.preview || !current || current.id !== workspaceId || (current.grantId ?? null) !== grantId) return;
      if (live.gitLoading || gitWriteCount(workspaceId, grantId)) {
        // Never lose an edit that landed mid-read or mid-write: queue one
        // follow-up, owned by the workspace/grant it was armed for.
        gitRefreshPending = { workspaceId, grantId };
        return;
      }
      void get().refreshGit();
    }, GIT_REFRESH_DEBOUNCE_MS);
  },

  initializeGit: async () => {
    const workspace = activeWorkspace(get());
    if (!workspace) return;
    if (!workspace.grantId && isTauri()) throw new Error(UNGRANTED_ERROR);
    await runGitMutation(workspace, selectionVersion, () => gitInit(workspace.grantId ?? "preview"));
  },

  discardGitFiles: async (paths) => {
    const state = get();
    const workspace = activeWorkspace(state);
    if (!paths.length) return;
    // Preview discards demo rows locally; the dock re-renders from state.
    if (state.preview && state.git) {
      const dropped = new Set(paths);
      const files = state.git.files.filter((file) => !dropped.has(file.path));
      set({ git: { ...state.git, files, dirty: files.length > 0 } });
      pruneDiffTabs(dropped);
      return;
    }
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error(UNGRANTED_ERROR);
    await runGitMutation(workspace, selectionVersion, () => gitDiscardFiles(workspace.grantId ?? "preview", paths), () => pruneDiffTabs(new Set(paths)));
  },

  discardGitHunk: async (path, hunk) => {
    const state = get();
    const workspace = activeWorkspace(state);
    if (state.preview && state.git) {
      set({ git: { ...state.git, diff: dropHunk(state.git.diff, path, hunk) } });
      return;
    }
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error(UNGRANTED_ERROR);
    await runGitMutation(workspace, selectionVersion, () => gitDiscardHunk(workspace.grantId ?? "preview", path, hunk));
  },

  stageGitFiles: async (paths, stage) => {
    const state = get();
    const workspace = activeWorkspace(state);
    if (!paths.length) return;
    if (state.preview && state.git) {
      const picked = new Set(paths);
      const files = state.git.files.map((file) => {
        if (!picked.has(file.path)) return file;
        const index = stage ? (file.status === "??" ? "A" : "M") : " ";
        return { ...file, status: `${index}${file.status.slice(1)}` };
      });
      set({ git: { ...state.git, files } });
      return;
    }
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error(UNGRANTED_ERROR);
    await runGitMutation(workspace, selectionVersion, () => gitStage(workspace.grantId ?? "preview", paths, stage));
  },

  commitGit: async (message, includeUnstaged = false) => {
    const state = get();
    const workspace = activeWorkspace(state);
    if (state.preview && state.git) {
      const files = includeUnstaged ? [] : state.git.files.filter((file) => file.status[0] === " " || file.status[0] === "?");
      ++gitGraphVersion;
      set({ git: { ...state.git, files, dirty: files.length > 0 }, gitGraph: null, gitGraphLoading: null, gitGraphError: null });
      return;
    }
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error(UNGRANTED_ERROR);
    await runGitMutation(workspace, selectionVersion, () => gitCommit(workspace.grantId ?? "preview", message, includeUnstaged));
  },

  lineComments: {},
  addLineComment: (comment) => {
    const key = draftKey(get());
    set({ lineComments: { ...get().lineComments, [key]: [...(get().lineComments[key] ?? []), { ...comment, id: uid() }].slice(-LINE_COMMENT_LIMIT) } });
    scheduleMemory(get);
  },
  removeLineComment: (id) => {
    const key = draftKey(get());
    set({ lineComments: { ...get().lineComments, [key]: (get().lineComments[key] ?? []).filter((comment) => comment.id !== id) } });
    scheduleMemory(get);
  },
  sendLineComments: async () => {
    const state = get();
    const key = draftKey(state);
    const comments = state.lineComments[key] ?? [];
    if (!comments.length) return;
    const thread = currentThread(state);
    const running = thread?.status === "running";
    if (running && state.preview) throw new Error("Stop the running turn first. The preview cannot take a message mid-turn.");
    if (state.submitting || state.starting) throw new Error("Another message is being sent. Try again in a moment.");
    // The comments travel through the normal send path, which reads the
    // composer. The user's own draft is set aside and put back afterwards.
    const text = composeLineComments(comments);
    const held = { composer: state.composer, images: state.images, contextRefs: state.contextRefs };
    set({ composer: text, images: [], contextRefs: [] });
    let sent = false;
    try { sent = await get().sendPrompt(running ? { disposition: "steer" } : undefined); }
    finally {
      const drafts = { ...get().drafts, [key]: { ...get().drafts[key], text: held.composer, images: held.images, refs: held.contextRefs } };
      if (draftKey(get()) === key) set({ ...held, drafts });
      else set({ drafts });
      if (sent) {
        const lineComments = { ...get().lineComments };
        delete lineComments[key];
        set({ lineComments });
      }
      scheduleMemory(get);
    }
    if (get().lineComments[key]) throw new Error(currentThread(get())?.error ?? get().error ?? "The comments were not sent. They are still here.");
  },
  handoffWorktree: async () => {
    const state = get();
    const thread = currentThread(state);
    const worktree = thread?.worktree;
    const workspace = currentWorkspace(state);
    if (!thread || !worktree || !workspace) return;
    const note = (level: "info" | "warning", text: string) => set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, notice: { level, message: text } } : item) });
    if (thread.status === "running") { note("warning", "Wait for the running turn to finish, then apply its changes."); return; }
    const confirmed = await state.confirm({ title: `Apply this worktree’s changes to ${workspace.name}?`, body: "Its commits and uncommitted edits are applied to the workspace folder as uncommitted changes. If any part does not apply cleanly, nothing there changes. The worktree and its branch are kept.", confirmLabel: "Apply to Local" });
    if (!confirmed) return;
    if (state.preview) { note("info", "Preview — no files were changed."); return; }
    try {
      const { files } = await gitWorktreeHandoff(worktree.grantId);
      note("info", files ? `Applied ${files} file${files === 1 ? "" : "s"} to ${workspace.name} as uncommitted changes. Open a Local thread to review them.` : "This worktree has no changes to apply.");
    } catch (error) { note("warning", describeError("Could not apply the changes", error)); }
  },
  branches: null,
  refreshBranches: async () => {
    const workspace = activeWorkspace(get());
    if (!workspace || (!workspace.grantId && isTauri() && !get().preview)) { set({ branches: [] }); return; }
    const grantId = workspace.grantId ?? null;
    try {
      const branches = await gitBranches(grantId ?? "preview");
      if ((activeWorkspace(get())?.grantId ?? null) === grantId) set({ branches });
    } catch (error) {
      log.warn("git.branches.failed", { error: message(error) });
      if ((activeWorkspace(get())?.grantId ?? null) === grantId) set({ branches: [] });
    }
  },
  switchBranch: async (branch, create) => {
    const state = get();
    const workspace = activeWorkspace(state);
    if (state.preview && state.git) { set({ git: { ...state.git, branch }, branches: null }); return; }
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error(UNGRANTED_ERROR);
    await runGitMutation(workspace, selectionVersion, () => gitSwitch(workspace.grantId ?? "preview", branch, create), () => {
      // Another branch means other files, another diff and another pull request.
      pruneDiffTabs(null);
      set({ branches: null, pullRequest: null, fileView: null });
      get().refreshFileIndex();
    });
  },
  pullBranch: async () => {
    const workspace = activeWorkspace(get());
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error(UNGRANTED_ERROR);
    await runGitMutation(workspace, selectionVersion, () => gitPull(workspace.grantId ?? "preview"), () => {
      set({ fileView: null });
      get().refreshFileIndex();
    });
  },
  pushBranch: async () => {
    const workspace = activeWorkspace(get());
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error(UNGRANTED_ERROR);
    const pushed = await gitPush(workspace.grantId ?? "preview");
    set({ branches: null });
    return pushed;
  },
  pullRequest: null,
  pullRequestLoading: false,
  refreshPullRequest: async (create = false) => {
    const workspace = activeWorkspace(get());
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error(UNGRANTED_ERROR);
    const grantId = workspace.grantId ?? null;
    set({ pullRequestLoading: true });
    try {
      const pullRequest = await gitPullRequest(grantId ?? "preview", create);
      if ((activeWorkspace(get())?.grantId ?? null) !== grantId) return;
      set({ pullRequest });
      const thread = currentThread(get());
      if (create && pullRequest.url && thread) {
        const checks = pullRequest.checks && pullRequest.checks !== "none" ? ` Checks: ${pullRequest.checks}.` : "";
        set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, notice: { level: "info", message: `Pull request #${pullRequest.number ?? ""} opened: ${pullRequest.url}.${checks}` } } : item) });
      }
    } finally { set({ pullRequestLoading: false }); }
  },
  commitDraft: null,
  commitDrafting: null,
  draftCommitMessage: async (includeUnstaged = false) => {
    const thread = currentThread(get());
    if (!thread) throw new Error("Open a thread first. The agent drafts the message in the thread.");
    if (thread.status === "running" || get().submitting) throw new Error("Wait for the running turn to finish, then draft the message.");
    if (get().composer.trim() || get().images.length || get().contextRefs.length) throw new Error("Send or clear your draft in the composer first, so it is not replaced.");
    set({ composer: commitDraftPrompt(includeUnstaged), images: [], contextRefs: [], commitDrafting: thread.sessionId });
    await get().sendPrompt();
    // Nothing was sent (a lock, an error): no reply is coming to wait for.
    if (get().threads.find((item) => item.sessionId === thread.sessionId)?.status !== "running") set({ commitDrafting: null });
  },

  discardAllGit: async () => {
    const state = get();
    const workspace = activeWorkspace(state);
    if (state.preview) {
      if (state.git) set({ git: { ...state.git, files: [], dirty: false, diff: "", truncated: false } });
      pruneDiffTabs(null);
      return;
    }
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error(UNGRANTED_ERROR);
    await runGitMutation(workspace, selectionVersion, () => gitDiscardAll(workspace.grantId ?? "preview"), () => pruneDiffTabs(null));
  },

  attachImages: async (files) => {
    const key = draftKey(get());
    try {
      const selected = Array.from(files);
      if (selected.some((file) => !file.type.startsWith("image/") || file.size === 0)) throw new Error("Choose non-empty image files.");
      if (selected.some((file) => file.size > MAX_IMAGE_BYTES)) throw new Error("Images must be 10 MB or smaller in this client.");
      const images = await Promise.all(selected.map((file) => new Promise<ComposerImage>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const base64Data = String(reader.result ?? "").split(",")[1];
          if (!base64Data) { reject(new Error(`Could not read ${file.name}`)); return; }
          resolve({ mediaType: file.type, base64Data, name: file.name });
        };
        reader.onerror = () => reject(reader.error);
        reader.onabort = () => reject(new Error("Image loading cancelled"));
        reader.readAsDataURL(file);
      })));
      const state = get();
      if (draftKey(state) === key) set({ images: [...state.images, ...images] });
      else {
        const draft = state.drafts[key] ?? { text: "", images: [] };
        set({ drafts: { ...state.drafts, [key]: { ...draft, images: [...draft.images, ...images] } } });
      }
    } catch (error) { set({ error: describeError("Attachment failed", error) }); }
  },

  attachDroppedPaths: async (paths) => {
    const key = draftKey(get());
    const root = activeWorkspace(get())?.path;
    try {
      const candidates = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
      if (!candidates.length) return;
      const inspected = await readDroppedPaths(candidates);
      const inlined = inspected.filter((file) => file.mediaType && file.base64Data);
      // Missing files (error, no media type, not a dir) are skipped; image
      // failures keep their media type and land as references instead.
      const referenced = inspected.filter((file) => !(file.mediaType && file.base64Data) && (!file.error || file.mediaType || file.isDir));
      const images: ComposerImage[] = inlined.map((file) => ({ mediaType: file.mediaType!, base64Data: file.base64Data!, name: file.name }));
      const refs: ContextRef[] = referenced.map((file) => ({ id: uid(), kind: file.isDir ? "folder" : "file", path: refPathForDrop(file.path, root) }));
      const state = get();
      if (draftKey(state) === key) {
        const seen = new Set(state.contextRefs.map((ref) => ref.path));
        set({ images: [...state.images, ...images], contextRefs: [...state.contextRefs, ...refs.filter((ref) => ref.path && !seen.has(ref.path))] });
      } else {
        const draft = state.drafts[key] ?? { text: "", images: [] };
        const seen = new Set(draft.refs?.map((ref) => ref.path) ?? []);
        set({ drafts: { ...state.drafts, [key]: { ...draft, images: [...draft.images, ...images], refs: [...(draft.refs ?? []), ...refs.filter((ref) => ref.path && !seen.has(ref.path))] } } });
      }
      const notices = inspected.filter((file) => file.error).map((file) => `${file.name}: ${file.error}`);
      if (candidates.length > MAX_DROP_FILES) notices.push(`Only the first ${MAX_DROP_FILES} files were attached.`);
      if (notices.length) set({ error: notices.slice(0, 3).join(" ") + (notices.length > 3 ? ` (+${notices.length - 3} more)` : "") });
      scheduleMemory(get);
    } catch (error) { set({ error: describeError("Attachment failed", error) }); }
  },

  clearImages: () => set({ images: [] }),
  addContextRefs: (refs) => {
    const seen = new Set(get().contextRefs.map((ref) => ref.path));
    const next = refs.filter((ref) => ref.path && !seen.has(ref.path));
    if (!next.length) return;
    set({ contextRefs: [...get().contextRefs, ...next] });
    scheduleMemory(get);
  },
  removeContextRef: (id) => {
    set({ contextRefs: get().contextRefs.filter((ref) => ref.id !== id) });
    scheduleMemory(get);
  },
  retryLast: async () => {
    const thread = currentThread(get());
    if (!thread || thread.status === "running" || get().submitting) return;
    const last = [...thread.items].reverse().find((item) => item.kind === "userMessage");
    if (!last?.text && !last?.images?.length && !last?.refs?.length) return;
    set({ composer: last.text ?? "", images: last.images ?? [], contextRefs: last.refs ?? [] });
    await get().sendPrompt({ resetTaskState: true });
  },
  continueThread: async () => {
    const thread = currentThread(get());
    if (!thread || thread.status === "running" || get().submitting || thread.recoveryDismissed) return;
    set({ composer: continuationPrompt(thread.agentId, thread.lastOutcome), images: [], contextRefs: [] });
    await get().sendPrompt();
  },
  stopRecovery: () => {
    const thread = currentThread(get());
    if (!thread || thread.status === "running" || thread.lastOutcome !== "interrupted" || thread.recoveryDismissed) return;
    set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, recoveryDismissed: true } : item) });
    scheduleMemory(get);
  },
  setComposer: (value) => { set({ composer: value }); scheduleDraft(get); },
  setDraftWorktree: (worktree) => {
    const id = get().selectedWorkspaceId;
    if (!id) return;
    const key = `project:${id}`;
    const draft = get().drafts[key] ?? { text: "", images: [] };
    set({ drafts: { ...get().drafts, [key]: { ...draft, worktree: worktree ? { base: worktree.base.trim().slice(0, 256) } : undefined } } });
    scheduleMemory(get);
  },
  viewer: null,
  openViewer: (images, index = 0) => set({ viewer: images.length ? { images, index: Math.min(Math.max(index, 0), images.length - 1) } : null }),
  closeViewer: () => set({ viewer: null }),
  stepViewer: (delta) => set((state) => state.viewer ? { viewer: { images: state.viewer.images, index: (state.viewer.index + delta + state.viewer.images.length) % state.viewer.images.length } } : {}),
  openThreadTrajectory: (sessionId) => {
    if (!get().threads.some((thread) => thread.sessionId === sessionId)) return;
    set({ settingsOpen: true, settingsTab: "Usage", trajectoryThreadId: sessionId });
    scheduleMemory(get);
  },
  clearThreadTrajectory: () => set({ trajectoryThreadId: null }),
  setSettingsOpen: (open, tab) => {
    set({ settingsOpen: open, trajectoryThreadId: null, ...(tab ? { settingsTab: tab } : {}) });
    if (tab) scheduleMemory(get);
  },
  setDockOpen: (open) => { set({ dockOpen: open, ...(open ? { terminalOpen: false, browserOpen: false } : { dockExpanded: false }) }); scheduleMemory(get); },
  setDockTab: (tab) => set({ dockTab: tab, inspectorTab: tab }),
  setDockWidth: (width) => { set({ dockWidth: normalizeDockWidth(width) }); scheduleMemory(get); },
  zoomBy: (direction) => {
    const zoom = direction === 0 ? 1 : stepZoom(get().zoom, direction);
    if (zoom === get().zoom) return;
    set({ zoom });
    scheduleMemory(get);
    void setInterfaceZoom(zoom).catch((error) => log.warn("zoom.failed", { error: message(error) }));
  },
  setDockExpanded: (expanded) => set({ dockExpanded: expanded }),
  openFileDiff: (path, keepScope = false) => {
    const state = get();
    if (!keepScope && state.reviewScope !== "all") get().setReviewScope("all");
    const live = get();
    const data = live.reviewScope === "all" ? live.git : live.review?.key === reviewTarget(live).key ? live.review.data : null;
    const first = data?.diff ? parseUnifiedDiff(data.diff).files[0]?.path : undefined;
    const base = live.diffTabs ?? (live.reviewScope !== "all" ? data?.files.map((file) => file.path) ?? [] : first ? [first] : []);
    set({
      diffTabs: base.includes(path) ? base : [...base, path],
      diffActive: path,
      dockOpen: true,
      terminalOpen: false,
      browserOpen: false,
      inspectorTab: "diff",
      dockTab: "diff",
    });
  },
  closeFileDiff: (path) => {
    const state = get();
    const data = state.reviewScope === "all" ? state.git : state.review?.key === reviewTarget(state).key ? state.review.data : null;
    const first = data?.diff ? parseUnifiedDiff(data.diff).files[0]?.path : undefined;
    const base = state.diffTabs ?? (state.reviewScope !== "all" ? data?.files.map((file) => file.path) ?? [] : first ? [first] : []);
    const remaining = base.filter((entry) => entry !== path);
    const active = state.diffActive === path
      ? remaining[Math.min(Math.max(base.indexOf(path), 0), remaining.length - 1)] ?? null
      : state.diffActive;
    set({ diffTabs: remaining, diffActive: active });
  },
  setActiveDiff: (path) => set({ diffActive: path }),

  exitPreview: async () => {
    if (!get().preview) return;
    for (const timer of previewTimers.values()) window.clearTimeout(timer);
    previewTimers.clear();
    const snapshot = previewSnapshot;
    previewSnapshot = null;
    ++selectionVersion;
    ++gitVersion;
    ++modelVersion;
    modelsInFlight = null;
    set({ preview: false, error: null, models: [], ...(snapshot ?? { workspaces: [], selectedWorkspaceId: null, selectedSessionId: null, threads: [], drafts: {}, composer: "", images: [], contextRefs: [], git: null }) });
    try {
      await get().refreshDetection();
      if (readyAgents(get()).length && currentWorkspace(get())) await get().startHost();
    } catch (error) {
      set({ error: sentenceAfter(describeError("Could not reconnect", error), "Open Settings to try again.") });
    }
  },

  enterPreview: () => {
    if (!get().preview) {
      const { workspaces, selectedWorkspaceId, selectedSessionId, threads, drafts, composer, images, contextRefs, git } = get();
      previewSnapshot = { workspaces, selectedWorkspaceId, selectedSessionId, threads, drafts, composer, images, contextRefs, git };
    }
    const workspace: Workspace = {
      id: "preview",
      path: "/Users/you/Glitter",
      name: "Glitter",
      grantId: "preview",
    };
    const threads = mockThreads().map((thread) => ({ ...thread, agentId: "harness" as const, config: { ...defaults(get()), ...thread.config, agentId: "harness" as const }, opened: true }));
    set({
      preview: true,
      agents: MOCK_AGENTS,
      workspaces: [workspace],
      selectedWorkspaceId: workspace.id,
      threads,
      selectedSessionId: threads[0]?.sessionId ?? null,
      composer: "",
      images: [],
      contextRefs: [],
      error: null,
      git: MOCK_GIT,
    });
    void get().refreshGit();
    void get().refreshModels();
  },
}));

/**
 * The macOS desktop window is transparent over its own material, so the shell
 * can show it. `?material` gives the dev preview the same controls.
 */
export function hasWindowMaterial(): boolean {
  return (isTauri() && isMacPlatform()) || Boolean(import.meta.env?.DEV && new URLSearchParams(window.location.search).has("material"));
}

let windowAppearance: Settings["theme"] | null = null;

/** Put the resolved theme (see lib/theme.ts) on the document root and the native window. */
export function applyTheme(settings: ThemeSettings) {
  const windowMaterial = hasWindowMaterial();
  // The media queries are only asked when their answer can change the result.
  const resolved = resolveTheme(settings, {
    prefersDark: settings.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches,
    windowMaterial,
    reducedTransparency: windowMaterial && window.matchMedia("(prefers-reduced-transparency: reduce)").matches,
  });
  const root = document.documentElement;
  Object.assign(root.dataset, resolved.attributes);
  for (const [name, value] of Object.entries(resolved.properties)) root.style.setProperty(name, value);
  if (windowAppearance !== resolved.windowAppearance) {
    windowAppearance = resolved.windowAppearance;
    // A failed call must be retried by the next apply, not remembered as done.
    void setWindowAppearance(resolved.windowAppearance).catch((error) => { windowAppearance = null; log.warn("theme.window_appearance_failed", { error: message(error) }); });
  }
}

/**
 * The host already ended this turn, but its end never reached the app (e.g. across a reconnect),
 * so the thread still looks busy. Settle it locally instead of reporting an error.
 */
/**
 * ARCH-003: one definition of "this thread lost its host". The connection-loss
 * path and the per-agent-exit path must clear exactly the same pending
 * interaction state. They had drifted: `agentExit` forgot `pendingTurnKey` and
 * `approvalPending`, so an agent dying mid-approval left a phantom approval on
 * screen with nothing to resolve it.
 */
const ABANDONED: Partial<Thread> = {
  opened: false,
  opening: false,
  activeTurnId: null,
  pendingTurnKey: null,
  pendingApproval: null,
  queuedApprovals: [],
  userInputs: [],
  userInputPending: undefined,
  approvalPending: false,
  cancelRequested: false,
  activity: undefined,
  tokenSpeed: undefined,
  configPending: false,
  pendingConfig: undefined,
};

function abandonThread(thread: Thread, extra: Partial<Thread> = {}): Thread {
  if (thread.status !== "running") return { ...thread, ...ABANDONED, ...extra };
  return {
    ...thread,
    ...finishTurn(thread, thread.activeTurnId ?? undefined),
    ...ABANDONED,
    status: "error",
    lastOutcome: "interrupted" as const,
    lastTurnId: thread.activeTurnId ?? thread.lastTurnId,
    plan: settlePlan(thread.plan, "interrupted"),
    items: settleItems(thread.items, "interrupted", true),
    ...extra,
  };
}

function settleEndedTurn(sessionId: string, turnId?: string | null) {
  useAppStore.setState((state) => ({ threads: state.threads.map((thread) => thread.sessionId !== sessionId || thread.status !== "running" ? thread : {
    ...thread,
    ...finishTurn(thread, turnId ?? thread.activeTurnId ?? undefined),
    status: "idle",
    activeTurnId: null,
    lastTurnId: turnId ?? thread.activeTurnId ?? thread.lastTurnId,
    lastOutcome: thread.cancelRequested ? "cancelled" : thread.lastOutcome,
    cancelRequested: false,
    activity: undefined,
    pendingApproval: null,
    queuedApprovals: [],
    userInputs: [],
    error: null,
    plan: thread.cancelRequested ? settlePlan(thread.plan, "cancelled") : thread.plan,
    items: thread.cancelRequested ? settleItems(thread.items, "cancelled") : settleItems(thread.items, "interrupted"),
  }) }));
  scheduleMemory(useAppStore.getState);
}



/**
 * Send while a Harness turn runs. Queue parks the input for launch,
 * steer folds it into the running turn, replace interrupts and starts over.
 * Runs under sendPrompt's submitting guard; clears the draft on success.
 */
async function sendBusyTurn(sessionId: string, disposition: "queue" | "steer" | "replace", payload: string, text: string, images: ComposerImage[], skill?: { selector: string; arguments?: string }, agentId?: AgentId, shape?: OrchestratorShape) {
  const state = useAppStore.getState();
  const thread = state.threads.find((item) => item.sessionId === sessionId);
  if (!thread) return;
  const key = `thread:${sessionId}`;
  // Retries reuse the unsettled key (and the replace bubble) so the host dedupes.
  const keptOptimistic = thread.pendingTurnKey
    ? [...(thread.items ?? [])].reverse().find((item) => item.kind === "userMessage" && item.optimistic && item.text === (text || payload))
    : undefined;
  // Queue/steer retries reuse the unsettled key outright (no bubble to match);
  // replace requires the matching bubble so a reworded prompt sends fresh.
  const turnKey = thread.pendingTurnKey && (disposition !== "replace" || keptOptimistic) ? thread.pendingTurnKey : uid();
  const patch = (part: Partial<Thread>) => useAppStore.setState({ threads: useAppStore.getState().threads.map((item) => item.sessionId === sessionId ? { ...item, ...part } : item) });
  // Pre-replace turn state, so a failed `replace` can roll back exactly what it
  // changed instead of leaving a thread stuck "running" with no active turn.
  const before = { status: thread.status, activeTurnId: thread.activeTurnId, lastOutcome: thread.lastOutcome, turnStartedAt: thread.turnStartedAt, activity: thread.activity, tokenSpeed: thread.tokenSpeed, turnStats: thread.turnStats };
  let replaceItem: TranscriptItem | undefined;
  const clearDraft = () => {
    recordPrompt(state.workspaces.find((workspace) => workspace.path === thread.workspacePath)?.id, text);
    const live = useAppStore.getState();
    const selected = live.selectedSessionId === sessionId;
    const draft = selected ? { text: live.composer, images: live.images, refs: live.contextRefs } : live.drafts[key];
    if (draft?.text.trim() === text && draft.images === images) {
      useAppStore.setState({ ...(selected ? { composer: "", images: [], contextRefs: [] } : {}), drafts: { ...live.drafts, [key]: { ...live.drafts[key], text: "", images: [], refs: [] } } });
    }
  };
  const fail = (error: unknown, fallback: string) => {
    if (timeoutUnknown(error)) {
      // The submit may have landed without its acknowledgement: keep the key
      // so a retry dedupes instead of doubling (queue/replace only — a steer
      // has no idempotency key, so it only warns).
      patch(disposition === "steer"
        ? { notice: { level: "warning", message: "No acknowledgement yet — the steer may still have landed." } }
        : { pendingTurnKey: turnKey, notice: { level: "warning", message: "No acknowledgement yet — retry safely; a duplicate will not send." } });
      return;
    }
    if (disposition === "replace" && replaceItem) {
      // A definitive failure means the replace never reached the host: drop the
      // optimistic bubble and restore the prior turn state (mirrors the
      // non-busy send path's rollback) rather than showing a message as sent.
      const dropId = replaceItem.itemId;
      useAppStore.setState((current) => ({
        threads: current.threads.map((item) => item.sessionId === sessionId ? {
          ...item,
          items: item.items.filter((entry) => entry.itemId !== dropId),
          ...before,
          pendingTurnKey: null,
          cancelRequested: false,
          error: describeError(fallback, error),
        } : item),
      }));
      return;
    }
    patch({ error: describeError(fallback, error) });
  };
  try {
    if (disposition === "steer") {
      await bridge<{ turnId: string }>("steerTurn", { sessionId, agentId: thread.agentId, text: payload, reasoningEffort: thread.config?.effort ?? state.defaultEffort, images: images.map(({ mediaType, base64Data }) => ({ mediaType, base64Data })) });
      patch({ notice: { level: "info", message: "Steered into the running turn." }, error: null });
      clearDraft();
      return;
    }
    if (disposition === "replace") {
      const userItem: TranscriptItem = keptOptimistic ?? { itemId: uid(), kind: "userMessage", status: "completed", text: text || payload, images, refs: state.contextRefs, recordedAt: new Date().toISOString(), optimistic: true };
      replaceItem = userItem;
      patch({ ...applyItem(thread, userItem), error: null, activeTurnId: null, cancelRequested: false, activity: "working", lastOutcome: undefined, turnStartedAt: Date.now(), turnStartOutput: thread.usage?.outputTokens ?? 0, turnStartPrompt: thread.usage?.promptTokens ?? 0, turnStartCache: cacheTokens(thread.usage), turnStats: undefined, tokenSpeed: undefined, turnCalls: [] });
    }
    const result = await bridge<{ turnId: string; disposition?: string; deduped?: boolean }>("sendTurn", { sessionId, agentId: thread.agentId, text: payload, reasoningEffort: thread.config?.effort ?? state.defaultEffort, images: images.map(({ mediaType, base64Data }) => ({ mediaType, base64Data })), clientTurnId: turnKey, ifBusy: disposition, ...(skill ? { skill } : {}), ...(agentId === "harness" && shape ? { forcedShape: shape } : {}) });
    const latest = useAppStore.getState().threads.find((item) => item.sessionId === sessionId);
    if (disposition === "replace" || result.disposition === "started") {
      // Running treatment: the fresh turn owns the thread now. A completion
      // for the superseded turn is ignored via the activeTurnId guard.
      patch({ activeTurnId: result.turnId, pendingTurnKey: null, notice: result.deduped ? { level: "info", message: "Resumed the pending turn instead of sending a duplicate." } : null });
      if (latest?.cancelRequested) await cancelSession(sessionId, result.turnId);
    } else if (result.deduped && latest?.activeTurnId === result.turnId) {
      // Retry dedupe against the already-running turn: nothing to track.
      patch({ pendingTurnKey: null });
    } else {
      patch({ queuedTurns: [...(latest?.queuedTurns ?? []), { turnId: result.turnId, text: text || payload }], pendingTurnKey: null, notice: { level: "info", message: "Queued — runs when the current turn finishes." } });
    }
    clearDraft();
  } catch (error) {
    // The verb names the gesture the user made, so the surfaced sentence tells
    // them which action failed rather than just that a send did.
    fail(error, disposition === "steer" ? "Could not steer the turn" : disposition === "replace" ? "Could not replace the turn" : "Could not queue the message");
  }
}

/** Send only after a denial is acknowledged, scoped to its original thread. */
async function deliverApprovalFeedback(sessionId: string): Promise<void> {
  const state = useAppStore.getState();
  const thread = state.threads.find((item) => item.sessionId === sessionId);
  if (!thread || thread.cancelRequested || (!thread.opened && !state.preview) || thread.approvalFeedback?.some((entry) => entry.state === "sending")) return;
  const feedback = thread.approvalFeedback?.find((entry) => entry.state === "queued");
  if (!feedback) return;
  // Preview has no busy-send. Harness can steer a denial into the running turn.
  if (state.preview && thread.status === "running") return;
  const patch = (update: (current: Thread) => Thread) => useAppStore.setState((current) => ({ threads: current.threads.map((item) => item.sessionId === sessionId ? update(item) : item) }));
  patch((current) => ({ ...current, approvalFeedback: current.approvalFeedback?.map((entry) => entry.id === feedback.id ? { ...entry, state: "sending" } : entry) }));
  let started = false;
  let before: Partial<Thread> = {};
  try {
    await useAppStore.getState().applyHarnessRules();
    let steered = false;
    if (thread.status === "running" && !state.preview) {
      try {
        await bridge("steerTurn", { sessionId, agentId: thread.agentId, text: feedback.text });
        steered = true;
      } catch (error) {
        // A steer has no idempotency key. An uncertain result must never fall
        // through to another send, which could duplicate the explanation.
        if (timeoutUnknown(error)) throw error;
      }
    }
    if (!steered) {
      const live = useAppStore.getState().threads.find((item) => item.sessionId === sessionId);
      if (!live || live.cancelRequested || live.lastOutcome === "cancelled") throw new Error("Turn stopped. Feedback was not sent.");
      started = live.status !== "running";
      before = { status: live.status, activeTurnId: live.activeTurnId, lastOutcome: live.lastOutcome, activity: live.activity, turnStartedAt: live.turnStartedAt, turnStartOutput: live.turnStartOutput, turnStartPrompt: live.turnStartPrompt, turnStartCache: live.turnStartCache, tokenSpeed: live.tokenSpeed, turnStats: live.turnStats };
      if (started) patch((current) => ({ ...current, status: "running", activeTurnId: null, lastOutcome: undefined, activity: "working", turnStartedAt: Date.now(), turnStartOutput: current.usage?.outputTokens ?? 0, turnStartPrompt: current.usage?.promptTokens ?? 0, turnStartCache: cacheTokens(current.usage), turnStats: undefined, tokenSpeed: undefined, turnCalls: [] }));
      const result = await bridge<{ turnId: string; disposition?: string }>("sendTurn", {
        sessionId, agentId: live.agentId, text: feedback.text,
        clientTurnId: feedback.id, ifBusy: "queue" as const,
      });
      patch((current) => current.lastTurnId === result.turnId ? current : result.disposition === "queued"
        ? { ...current, queuedTurns: [...(current.queuedTurns ?? []), { turnId: result.turnId, text: feedback.text }] }
        : { ...current, status: "running", activeTurnId: result.turnId });
      const latest = useAppStore.getState().threads.find((item) => item.sessionId === sessionId);
      if (latest?.cancelRequested || latest?.lastOutcome === "cancelled") {
        if (result.disposition === "queued") {
          await bridge("unqueueTurn", { sessionId, agentId: live.agentId, turnId: result.turnId });
          patch((current) => ({ ...current, queuedTurns: current.queuedTurns?.filter((entry) => entry.turnId !== result.turnId) }));
        } else await cancelSession(sessionId, result.turnId);
      }
    }
    patch((current) => ({ ...current, approvalFeedback: current.approvalFeedback?.filter((entry) => entry.id !== feedback.id), notice: { level: "info", message: steered ? "Denied. Feedback sent to the running turn." : "Denied. Feedback sent." } }));
    recordPrompt(state.workspaces.find((workspace) => workspace.path === thread.workspacePath)?.id, feedback.text);
  } catch (error) {
    const uncertain = timeoutUnknown(error);
    patch((current) => ({ ...current,
      ...(started && !uncertain && current.status === "running" && !current.activeTurnId ? before : {}),
      approvalFeedback: current.approvalFeedback?.map((entry) => entry.id === feedback.id ? { ...entry, state: uncertain ? "uncertain" : "failed", error: uncertain ? "No acknowledgement. Feedback may already have arrived; check the thread before resending." : describeError("Feedback was not sent", error) } : entry),
    }));
  }
  // Process another queued denial, if this agent can currently accept it.
  await deliverApprovalFeedback(sessionId);
}

function recordPrompt(workspaceId: string | null | undefined, text: string) {
  if (!workspaceId) return;
  const state = useAppStore.getState();
  const promptHistory = rememberPrompt(state.promptHistory, workspaceId, text);
  if (promptHistory === state.promptHistory) return;
  useAppStore.setState({ promptHistory });
  scheduleMemory(useAppStore.getState);
}

/**
 * Stop the live turns of the named threads. The host keeps running a turn whether or
 * not this app still lists the thread, so removing one locally would leave it spending
 * quota invisibly — and its next approval would arrive for a session nothing can answer.
 */
function cancelThreadTurns(threads: Thread[]): Promise<unknown> {
  return Promise.all(threads.filter((thread) => thread.status === "running").map((thread) => cancelSession(thread.sessionId, thread.activeTurnId ?? undefined)));
}

/**
 * Release sessions the app no longer needs. The bridge holds one per open thread and
 * nothing else ever drops it, so deleting threads would otherwise grow its session maps
 * for the process's lifetime. Reopening the thread resumes it again.
 */
function releaseThreadSessions(sessionIds: string[], stopped: Promise<unknown> = Promise.resolve()) {
  void stopped.finally(() => {
    for (const sessionId of sessionIds) void bridge("closeSession", { sessionId }).catch(() => {});
  });
}

async function cancelSession(sessionId: string, turnId?: string) {
  try {
    const answer = await bridge<{ status?: string } | undefined>("cancelTurn", { agentId: useAppStore.getState().threads.find((thread) => thread.sessionId === sessionId)?.agentId, sessionId, ...(turnId ? { turnId } : {}) });
    // The turn's end always arrives as its own event; this only says so when it has not yet. `stopping` means a tool is
    // still running, so the thread stays on Stopping, says why, and nothing is declared finished early.
    if (answer?.status === "stopping") {
      useAppStore.setState((state) => ({ threads: state.threads.map((thread) => thread.sessionId === sessionId && thread.status === "running" ? { ...thread, notice: { level: "info" as const, message: "Still stopping: a command or tool is taking a moment to end." } } : thread) }));
    }
  } catch (error) {
    if (/already_terminal|already (?:ended|completed|finished)|not running|no active turn/i.test(message(error))) { settleEndedTurn(sessionId, turnId); return; }
    useAppStore.setState((state) => ({ threads: state.threads.map((thread) => thread.sessionId === sessionId ? { ...thread, cancelRequested: false, error: sentenceAfter(describeError("Stop failed", error), "Try Stop again.") } : thread) }));
  }
}

/**
 * Token-speed `delta` streams are buffered per session/item and applied once per
 * frame instead of one `setState` (and transcript re-render) per token. Any
 * other event flushes the buffer synchronously first, so it never observes a
 * stale item.
 */
const deltaBuffer = new Map<string, Map<string, { text: string; output: string }>>();
let deltaFlushScheduled = false;

function bufferDelta(data: { sessionId: string; itemId: string; delta: string; field?: string }) {
  const field = !data.field || data.field === "text" ? "text" as const : data.field === "output" ? "output" as const : null;
  if (!field) return;
  let session = deltaBuffer.get(data.sessionId);
  if (!session) deltaBuffer.set(data.sessionId, session = new Map());
  const entry = session.get(data.itemId) ?? { text: "", output: "" };
  entry[field] += data.delta;
  session.set(data.itemId, entry);
  if (deltaFlushScheduled) return;
  deltaFlushScheduled = true;
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => flushDeltas());
  else setTimeout(flushDeltas, 16);
}

function flushDeltas() {
  deltaFlushScheduled = false;
  if (!deltaBuffer.size) return;
  const buffered = [...deltaBuffer];
  deltaBuffer.clear();
  const selected = useAppStore.getState().selectedSessionId;
  for (const [sessionId, deltas] of buffered) {
    useAppStore.setState((state) => {
      const thread = state.threads.find((item) => item.sessionId === sessionId);
      if (!thread) return state;
      let items = thread.items;
      let tokenSpeed = thread.tokenSpeed;
      let touched = false;
      for (const [itemId, delta] of deltas) {
        const index = items.findIndex((item) => item.itemId === itemId);
        if (index < 0) {
          // The `item` event has not landed yet; hold the text for applyItem.
          // Entries whose item never lands (a dropped frame behind a gap
          // rebuild) must not accumulate: drop stashes older than any turn.
          for (const [stale, entry] of pendingDeltas) {
            if (Date.now() - entry.at > DELTA_STASH_TTL_MS) pendingDeltas.delete(stale);
          }
          const pending = pendingDeltas.get(itemId) ?? { at: Date.now() };
          if (delta.text) pending.text = `${pending.text ?? ""}${delta.text}`;
          if (delta.output) pending.output = `${pending.output ?? ""}${delta.output}`;
          pendingDeltas.set(itemId, pending);
          continue;
        }
        touched = true;
        const streamedItem = items[index];
        if (delta.text && thread.status === "running" && countsForTokenSpeed(streamedItem)) tokenSpeed = recordTokenSpeed(tokenSpeed, delta.text, Date.now());
        items = items.map((item, at) => at !== index ? item : {
          ...item,
          ...(delta.text ? { text: `${item.text ?? ""}${delta.text}` } : {}),
          ...(delta.output ? { visibleOutput: `${item.visibleOutput ?? ""}${delta.output}` } : {}),
        });
      }
      if (!touched) return state;
      return { threads: state.threads.map((item) => item.sessionId === sessionId ? { ...item, unread: selected !== sessionId, items, tokenSpeed } : item) };
    });
  }
}

/** Test hook: apply buffered stream deltas without waiting a frame. */
export function flushDeltasForTest() {
  flushDeltas();
}

export function bindBridgeEvents() {
  const unbind = onBridgeEvent((event, payload) => {
    if (event === "delta") {
      bufferDelta(payload as BridgeEventPayloads["delta"]);
      return;
    }
    // Non-delta events observe the stream as of now: apply any buffered deltas first.
    flushDeltas();
    const store = useAppStore.getState();
    const update = (sessionId: string, transform: (thread: Thread) => Thread) => useAppStore.setState((state) => ({ threads: state.threads.map((thread) => thread.sessionId === sessionId ? transform(thread) : thread) }));
    // OS notifications never carry prompt text, output, or args — Notification
    // Center persists them. The event is the headline; the body says which
    // thread and workspace it belongs to, so a glance carries the context.
    const maybeNotify = (sessionId: string, title: string, detail?: string) => {
      const state = useAppStore.getState();
      const thread = state.threads.find((thread) => thread.sessionId === sessionId);
      const body = [detail, thread?.title, thread ? workspaceName(thread.workspacePath) : ""].filter(Boolean).join(" · ") || "Glitter";
      const focused = typeof document !== "undefined" && typeof document.hasFocus === "function" ? document.hasFocus() : true;
      if (shouldNotify({ enabled: state.notifications !== false, focused, selected: sessionId === state.selectedSessionId, preview: state.preview })) void notify(title, body);
    };
    if (event === "hostExit" || event === "bridgeExit" || event === "connectionError" || event === "hostStopping") {
      ++modelVersion;
      modelsInFlight = null;
      harnessRulesApplied = null;
      harnessRulesGeneration += 1;
      // The Harness runs inside the agent process, so its exit ends every
      // session; a stopping notice comes before the exit itself.
      const exited = event === "hostExit" || event === "bridgeExit";
      const detail = (payload as BridgeEventPayloads["bridgeExit"] | undefined)?.error;
      const closed = exited ? `The agent stopped${detail ? `: ${detail}` : ""}. Select a thread to reconnect; drafts are retained.` : null;
      useAppStore.setState({ ...(closed ? { error: closed } : {}), ...(exited ? { hostInfo: null, threads: store.threads.map((thread) => abandonThread(thread)) } : {}) });
      scheduleMemory(useAppStore.getState);
    }
    if (event === "agentNotice") {
      const data = payload as BridgeEventPayloads["agentNotice"];
      update(data.sessionId, (thread) => ({ ...thread, notice: data.message ? { level: data.level ?? "info", message: data.message } : null }));
    }
    if (event === "sessionTitle") {
      const data = payload as BridgeEventPayloads["sessionTitle"];
      update(data.sessionId, (thread) => thread.customTitle ? thread : { ...thread, title: titleFromText(data.title) });
      scheduleMemory(useAppStore.getState);
    }
    if (event === "sessionName") {
      const data = payload as BridgeEventPayloads["sessionName"];
      update(data.sessionId, (thread) => thread.customTitle ? thread : { ...thread, title: titleFromText(data.name) });
      scheduleMemory(useAppStore.getState);
    }
    if (event === "sessionRow") {
      const data = payload as BridgeEventPayloads["sessionRow"];
      const row = data.session;
      if (row?.sessionId) {
        const known = store.threads.some((thread) => thread.sessionId === row.sessionId);
        const workspacePath = store.workspaces.find((workspace) => workspace.path === row.workspaceRoot)?.path;
        if (!known && workspacePath && !store.threadMeta[row.sessionId]?.deleted) {
          // A session this renderer never listed (created by another client):
          // insert a lightweight unopened thread so the stream actually surfaces it.
          useAppStore.setState((state) => state.threads.some((thread) => thread.sessionId === row.sessionId) ? state : ({
            threads: [...state.threads, {
              sessionId: row.sessionId, workspacePath, title: listedTitle(row), order: Date.now(),
              updatedAt: row.updatedAt ?? new Date().toISOString(),
              status: row.status === "running" ? "running" : "idle",
              unread: state.selectedSessionId !== row.sessionId, items: [],
              activeTurnId: row.activeTurnId ?? null, config: metadataConfig(row, state.defaultEffort),
            }],
          }));
          scheduleMemory(useAppStore.getState);
          // Bind the streamed row natively so an immediate open succeeds: the
          // trust boundary only resumes sessions learned from an authorized list.
          const grantId = useAppStore.getState().workspaces.find((workspace) => workspace.path === workspacePath)?.grantId;
          if (grantId) void listWorkspaceSessions({ path: workspacePath, grantId }, undefined, 1).catch(() => {});
        } else {
          update(row.sessionId, (thread) => ({
            ...thread,
            ...(thread.customTitle || !row.name?.trim() ? {} : { title: titleFromText(row.name) }),
            ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
            ...(typeof row.activeTurnId !== "undefined" ? { activeTurnId: row.activeTurnId } : {}),
          }));
          scheduleMemory(useAppStore.getState);
        }
      }
    }
    if (event === "sessionStatus") {
      const data = payload as BridgeEventPayloads["sessionStatus"];
      update(data.sessionId, (thread) => {
        // `error` threads need explicit recovery (retry/reselect): a delayed or
        // duplicate `running` event must not revive a settled failure.
        if (data.status === "running") return thread.status === "error" ? thread : { ...thread, status: "running" };
        // Never downgrade local optimism: a send awaiting its turn id looks
        // idle to the host for a beat. Unknown states (notLoaded, future) stay local.
        if (data.status === "idle" && !thread.activeTurnId && !thread.pendingTurnKey && thread.status !== "error") return { ...thread, status: "idle" };
        return thread;
      });
    }
    if (event === "sessionModel") {
      const data = payload as BridgeEventPayloads["sessionModel"];
      update(data.sessionId, (thread) => ({ ...thread, config: { ...thread.config, modelId: data.modelId, providerId: data.providerId ?? thread.config?.providerId } }));
      if (store.selectedSessionId === data.sessionId) void useAppStore.getState().refreshModels();
    }
    if (event === "sessionApprovalMode") {
      const data = payload as BridgeEventPayloads["sessionApprovalMode"];
      update(data.sessionId, (thread) => {
        // The app owns the mode. A provider echoing its own value must not replace it.
        const owned = approvalModeForAgent(thread.agentId, thread.config?.approvalMode);
        if (owned && data.mode !== owned) return thread;
        return { ...thread, config: { ...thread.config, approvalMode: approvalModeForAgent(thread.agentId, data.mode) ?? data.mode } };
      });
    }
    if (event === "sessionEffort") {
      const data = payload as BridgeEventPayloads["sessionEffort"];
      update(data.sessionId, (thread) => ({ ...thread, config: { ...thread.config, effort: data.effort } }));
    }
    if (event === "approvalUpdated") {
      const data = payload as BridgeEventPayloads["approvalUpdated"];
      const sessionId = data.sessionId ?? store.threads.find((thread) => thread.pendingApproval?.approvalId === data.approvalId || thread.queuedApprovals?.some((queued) => queued.approvalId === data.approvalId))?.sessionId;
      if (sessionId) update(sessionId, (thread) => thread.pendingApproval?.approvalId === data.approvalId
        ? { ...thread, pendingApproval: { ...thread.pendingApproval, availableChoices: data.availableChoices } }
        : { ...thread, queuedApprovals: (thread.queuedApprovals ?? []).map((queued) => queued.approvalId === data.approvalId ? { ...queued, availableChoices: data.availableChoices } : queued) });
    }
    if (event === "approvalResolved") {
      const data = payload as BridgeEventPayloads["approvalResolved"];
      const sessionId = data.sessionId ?? store.threads.find((thread) => thread.pendingApproval?.approvalId === data.approvalId || thread.queuedApprovals?.some((queued) => queued.approvalId === data.approvalId))?.sessionId;
      if (sessionId) update(sessionId, (thread) => {
        const dropped = dropApproval(thread, data.approvalId);
        return dropped.slotted ? { ...dropped.thread, approvalPending: false, notice: { level: "info", message: "That approval was resolved elsewhere." } } : dropped.thread;
      });
    }
    if (event === "agentConfig") {
      const data = payload as BridgeEventPayloads["agentConfig"];
      const prior = store.threads.find((thread) => thread.sessionId === data.sessionId)?.config;
      update(data.sessionId, (thread) => ({ ...thread, config: { ...thread.config, ...agentConfigPatch(data.config), agentId: thread.agentId }, modes: data.config.modes ?? thread.modes }));
      // An effort echo changes nothing the catalog offers, so only a model or
      // mode change justifies a refresh.
      const shifted = (data.config.modelId !== undefined && data.config.modelId !== prior?.modelId) || (data.config.mode !== undefined && data.config.mode !== prior?.mode);
      if (store.selectedSessionId === data.sessionId && shifted) void useAppStore.getState().refreshModels();
    }
    if (event === "sessionFacts" || event === "usage") {
      const data = payload as BridgeEventPayloads["sessionFacts"];
      update(data.sessionId, (thread) => withLateUsage({ ...thread, plan: data.plan ?? thread.plan, planAnchor: data.plan ? planAnchorFor(thread, data.plan) : thread.planAnchor, goal: data.goal ?? thread.goal, context: data.context !== undefined ? data.context : thread.context, usage: data.usage ?? thread.usage, hostBranch: data.branch ?? thread.hostBranch }));
      // Usage reported after the turn ended replaces that turn's estimate in the ledger.
      if (data.usage) recordUsage(useAppStore.getState, useAppStore.setState, data.sessionId);
    }
    if (event === "modelCall") {
      const data = payload as BridgeEventPayloads["modelCall"];
      // The turn's own calls, gathered until it finishes and the ledger counts them.
      update(data.sessionId, (thread) => ({ ...thread, turnCalls: [...(thread.turnCalls ?? []), data.call] }));
    }
    if (event === "route") {
      const data = payload as BridgeEventPayloads["route"];
      // Kept per turn, so each receipt can name the shape it ran even after later turns or a resume.
      update(data.sessionId, (thread) => ({ ...thread, routes: { ...(thread.routes ?? {}), [data.turnId]: data.route } }));
    }
    if (event === "userInputs") {
      const data = payload as BridgeEventPayloads["userInputs"];
      update(data.sessionId, (thread) => ({ ...thread, userInputs: data.requests, userInputVersion: (thread.userInputVersion ?? 0) + 1, unread: store.selectedSessionId !== data.sessionId, ...(data.requests.length && !data.turnEnded ? { status: "running", activeTurnId: data.requests[0].turnId } : {}) }));
    }
    if (event === "item") {
      const data = payload as BridgeEventPayloads["item"];
      update(data.sessionId, (thread) => {
        let incoming = data.item;
        const prior = thread.items.find((item) => item.itemId === incoming.itemId);
        if (incoming.kind === "userMessage") {
          const optimistic = [...thread.items].reverse().find((item) => item.optimistic && item.kind === "userMessage" && item.text === incoming.text)
            ?? [...thread.items].reverse().find((item) => item.optimistic && item.kind === "userMessage");
          if (optimistic) {
            thread = { ...thread, items: thread.items.filter((item) => item !== optimistic) };
            incoming = { ...incoming, images: optimistic.images };
          }
          incoming = { ...incoming, recordedAt: incoming.recordedAt ?? optimistic?.recordedAt ?? new Date().toISOString() };
        }
        if (incoming.kind === "agentMessage" && incoming.status === "completed" && !incoming.recordedAt) {
          incoming = { ...incoming, recordedAt: prior?.recordedAt ?? new Date().toISOString() };
        }
        const next = applyItem(thread, incoming);
        // An edit-kind step that just completed may have changed files on
        // disk. Only the transition counts — repeated updates to an already
        // completed item, failed edits, and other workspaces don't schedule.
        const merged = prior ? { ...prior, ...incoming } : incoming;
        const step = stepFromItem(merged);
        if (step.kind === "edit" && step.status === "completed" && !merged.failureReason
          && (prior ? stepFromItem(prior).status !== "completed" : true)
          && sharesActiveScope(store, thread)) {
          void useAppStore.getState().scheduleGitRefresh();
        }
        // A terminal compaction item settles a manual compact gesture.
        const compacted = incoming.kind === "compaction" && incoming.status !== "inProgress" && thread.notice?.key === "compacting";
        return { ...next, ...(compacted ? { notice: null } : {}), unread: store.selectedSessionId !== data.sessionId && !thread.opening, activity: thread.status === "running" ? incoming.kind === "agentMessage" ? "composing" : "working" : undefined };
      });
    }
    if (event === "approval") {
      const request = payload as BridgeEventPayloads["approval"];
      update(request.sessionId, (thread) => ({ ...parkApproval(thread, request), activeTurnId: request.turnId, status: "running", unread: store.selectedSessionId !== request.sessionId }));
      maybeNotify(request.sessionId, "Approval needed", humanizeToolName(request.toolName));
    }
    if (event === "approvalError") {
      const data = payload as BridgeEventPayloads["approvalError"];
      const sessionId = data.sessionId ?? store.threads.find((thread) => thread.pendingApproval?.approvalId === data.approvalId || thread.queuedApprovals?.some((queued) => queued.approvalId === data.approvalId))?.sessionId;
      if (sessionId) update(sessionId, (thread) => {
        const settled = thread.pendingApproval?.approvalId === data.approvalId ? advanceApprovals(thread) : dropApproval(thread, data.approvalId).thread;
        return { ...settled, approvalPending: false, error: `Approval ${data.kind}: ${data.error ?? "decision could not be delivered"}.${data.kind === "submitFailed" ? " The approval will reappear if it is still needed." : " Stop or reconnect to recover."}` };
      });
    }
    if (event === "turnRetry") {
      const data = payload as BridgeEventPayloads["turnRetry"];
      update(data.sessionId, (thread) => thread.activeTurnId && thread.activeTurnId !== data.turnId ? thread : ({
        ...thread,
        retry: { turnId: data.turnId, attempt: data.attempt ?? 1, maxAttempts: data.maxAttempts ?? 1, reason: data.reason ?? "retrying", retryAt: Date.now() + Math.max(0, data.retryDelayMs ?? 0) },
      }));
    }
    if (event === "viewHealth") {
      const data = payload as BridgeEventPayloads["viewHealth"];
      // v1 emits only `Unavailable`; anything else clears the degraded flag.
      update(data.sessionId, (thread) => ({ ...thread, viewHealth: data.health === "Unavailable" ? { health: data.health, ...(data.noneReason ? { noneReason: data.noneReason } : {}) } : null }));
    }
    if (event === "viewGap") {
      const data = payload as BridgeEventPayloads["viewGap"];
      update(data.sessionId, (thread) => ({ ...thread, viewGap: { after: data.after, next: data.next, state: "filling" as const } }));
    }
    if (event === "viewGapHealed") {
      const data = payload as BridgeEventPayloads["viewGapHealed"];
      update(data.sessionId, (thread) => thread.viewGap?.after === data.after && thread.viewGap?.next === data.next ? { ...thread, viewGap: null } : thread);
    }
    if (event === "skillChanged") {
      const data = payload as BridgeEventPayloads["skillChanged"];
      void useAppStore.getState().refreshSkills(data.sessionId).catch(() => {});
    }
    if (event === "accountChanged") {
      void useAppStore.getState().refreshDetection().catch(() => {});
    }
    if (event === "browserState") {
      const data = payload as BrowserStateEvent;
      if (activeWorkspace(store)?.path !== data.workspaceRoot) return;
      useAppStore.setState({
        browserState: data,
        browserError: data.error ?? null,
        ...(data.status === "closed" ? { browserFrame: null, browserBusy: false } : {}),
        ...(data.reveal ? { browserOpen: true, terminalOpen: false, dockOpen: false, dockExpanded: false } : {}),
      });
    }
    if (event === "browserFrame") {
      const data = payload as BrowserFrame;
      if (activeWorkspace(store)?.path !== data.workspaceRoot) return;
      if (store.browserFrame && data.sequence <= store.browserFrame.sequence) return;
      useAppStore.setState({ browserFrame: data });
    }
    if (event === "turnError") {
      const data = payload as BridgeEventPayloads["turnError"];
      const stopped = data.code === "interrupted" || data.code === "cancelled";
      if (!stopped) maybeNotify(data.sessionId, "Turn failed");
      update(data.sessionId, (thread) => ({ ...thread, ...finishTurn(thread, data.turnId), status: stopped ? "idle" : "error", error: stopped ? null : data.error ?? "Turn stream failed", retry: null, activeTurnId: null, pendingTurnKey: null, plan: stopped ? settlePlan(thread.plan, "cancelled") : settlePlan(thread.plan, "failed"), items: stopped ? settleItems(thread.items, "cancelled", true) : settleItems(thread.items, "failed"), pendingApproval: null, queuedApprovals: [], userInputs: [], userInputPending: undefined, cancelRequested: false, activity: undefined, lastTurnId: data.turnId, ...(stopped ? { lastOutcome: "cancelled" as const } : {}) }));
      if (store.commitDrafting === data.sessionId) useAppStore.setState({ commitDrafting: null });
    }
    if (event === "gapError") {
      const data = payload as BridgeEventPayloads["gapError"];
      const guidance = data.reason === "noConnection"
        ? "Live updates cannot reach this thread. Reconnect to restore them."
        : data.reason === "pageStalled"
          ? "History replay stalled while recovering dropped events. Retry the rebuild."
          : "Some live events were dropped and recovery failed. Retry the rebuild.";
      update(data.sessionId, (thread) => ({
        ...thread,
        ...finishTurn(thread, data.turnId),
        status: "error",
        error: guidance,
        retry: null,
        viewGap: data.after && data.next ? { after: data.after, next: data.next, state: "failed" as const, ...(data.reason ? { reason: data.reason } : {}) } : thread.viewGap && { ...thread.viewGap, state: "failed" as const, ...(data.reason ? { reason: data.reason } : {}) },
        activeTurnId: null,
        pendingTurnKey: null,
        plan: settlePlan(thread.plan, "failed"),
        items: settleItems(thread.items, "failed"),
        pendingApproval: null,
        queuedApprovals: [],
        userInputs: [],
        userInputPending: undefined,
        cancelRequested: false,
        activity: undefined,
        lastTurnId: data.turnId,
      }));
    }
    if (event === "turnSnapshot") {
      const snapshot = payload as BridgeEventPayloads["turnSnapshot"];
      if (snapshot.turnId) update(snapshot.sessionId, (thread) => ({ ...thread, snapshots: { ...thread.snapshots, [snapshot.turnId!]: snapshot } }));
    }
    if (event === "turnStarted") {
      const data = payload as BridgeEventPayloads["turnStarted"];
      update(data.sessionId, (thread) => {
        if (data.cause !== "userInput" && !(thread.queuedTurns ?? []).some((entry) => entry.turnId === data.turnId)) return thread;
        return { ...thread, status: "running", activeTurnId: data.turnId, cancelRequested: false, activity: "working", lastOutcome: undefined, turnStartedAt: Date.now(), turnStartOutput: thread.usage?.outputTokens ?? 0, turnStartPrompt: thread.usage?.promptTokens ?? 0, turnStartCache: cacheTokens(thread.usage), turnStats: undefined, tokenSpeed: undefined, turnCalls: [], queuedTurns: (thread.queuedTurns ?? []).filter((entry) => entry.turnId !== data.turnId), notice: null };
      });
    }
    if (event === "turnCompleted") {
      const data = payload as BridgeEventPayloads["turnCompleted"];
      if (data.outcome.kind === "unqueued") {
        // Authoritative removal of a reclaimed queued turn: no status change.
        update(data.sessionId, (thread) => ({ ...thread, queuedTurns: (thread.queuedTurns ?? []).filter((entry) => entry.turnId !== data.turnId) }));
        return;
      }
      // A finished turn may have touched files — re-index @-mentions for the
      // selected workspace (debounced and rate-limited inside refreshFileIndex).
      const completedThread = store.threads.find((thread) => thread.sessionId === data.sessionId);
      const selectedWorkspace = store.workspaces.find((item) => item.id === store.selectedWorkspaceId);
      if (completedThread && selectedWorkspace && sharesActiveScope(store, completedThread)) useAppStore.getState().refreshFileIndex();
      const terminal = data.outcome.params?.terminal;
      const cancelled = terminal === "cancelled";
      const failed = !cancelled && (data.outcome.kind !== "completed" || terminal !== "completed");
      if (store.commitDrafting === data.sessionId) {
        const reply = cancelled || failed ? undefined : [...(store.threads.find((thread) => thread.sessionId === data.sessionId)?.items ?? [])].reverse().find((item) => item.kind === "agentMessage" && item.turnId === data.turnId)?.text;
        const text = commitSubjectFromReply(reply ?? "");
        useAppStore.setState({ commitDrafting: null, ...(text ? { commitDraft: { text, seq: (store.commitDraft?.seq ?? 0) + 1, sessionId: data.sessionId } } : {}) });
      }
      if (!cancelled) maybeNotify(data.sessionId, failed ? "Turn failed" : "Turn finished");
      update(data.sessionId, (thread) => thread.activeTurnId && thread.activeTurnId !== data.turnId ? { ...thread, items: settleTurnItems(thread.items, data.turnId, terminal), queuedTurns: (thread.queuedTurns ?? []).filter((entry) => entry.turnId !== data.turnId), ...(thread.retry?.turnId === data.turnId ? { retry: null } : {}), ...(data.viewCursor ? { resumeCursor: data.viewCursor } : {}) } : ({
        ...thread,
        ...finishTurn(thread, data.turnId),
        retry: null,
        ...(data.viewCursor ? { resumeCursor: data.viewCursor } : {}),
        status: failed ? "error" : "idle",
        queuedTurns: (thread.queuedTurns ?? []).filter((entry) => entry.turnId !== data.turnId),
        error: failed ? data.outcome.params?.error?.message ?? data.outcome.params?.reason ?? `Turn ended: ${data.outcome.kind} (${terminal ?? "outcome unknown"})` : cancelled ? null : thread.error,
        lastOutcome: cancelled ? "cancelled" : failed ? "failed" : "completed",
        plan: cancelled ? settlePlan(thread.plan, "cancelled") : failed ? settlePlan(thread.plan, "failed") : thread.plan,
        items: cancelled ? settleItems(thread.items, "cancelled", true) : failed ? settleItems(thread.items, "failed") : thread.items,
        activeTurnId: null,
        pendingTurnKey: null,
        lastTurnId: data.turnId,
        pendingApproval: null,
        queuedApprovals: [],
        userInputs: [],
        userInputPending: undefined,
        approvalPending: false,
        cancelRequested: false,
        activity: undefined,
        unread: store.selectedSessionId !== data.sessionId,
      }));
      recordUsage(useAppStore.getState, useAppStore.setState, data.sessionId);
      if (!cancelled && !failed) void deliverApprovalFeedback(data.sessionId);
      else update(data.sessionId, (thread) => ({ ...thread, approvalFeedback: thread.approvalFeedback?.map((entry) => entry.state === "queued" ? { ...entry, state: "failed" as const, error: "Turn ended. Feedback was not sent." } : entry) }));
      scheduleMemory(useAppStore.getState);
      if (sharesActiveScope(store, store.threads.find((thread) => thread.sessionId === data.sessionId))) void store.refreshGit();
      if (failed && /model access is disabled/i.test(data.outcome.params?.error?.message ?? "")) void useAppStore.getState().refreshModels();
    }
  });
  // The draft/memory debounces never fire once the window is gone: flush the
  // pending save on every teardown signal the webview still honours (pagehide,
  // beforeunload, going hidden) plus the native close-requested, which on
  // macOS is the only one guaranteed to arrive before the webview dies.
  const flushOnTeardown = () => flushPersistedMemory(useAppStore.getState);
  const onVisibilityChange = () => { if (document.visibilityState === "hidden") flushOnTeardown(); };
  if (typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", flushOnTeardown);
    window.addEventListener("beforeunload", flushOnTeardown);
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  const unbindCloseRequested = onWindowCloseRequested(flushOnTeardown);
  return () => {
    // A queued refresh must not fire after the app tears down its bridge.
    cancelScheduledGitRefresh();
    unbind();
    unbindCloseRequested();
    if (typeof window.removeEventListener === "function") {
      window.removeEventListener("pagehide", flushOnTeardown);
      window.removeEventListener("beforeunload", flushOnTeardown);
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

export function currentWorkspace(state: Pick<AppStore, "workspaces" | "selectedWorkspaceId">): Workspace | undefined {
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
}

/**
 * Where one thread's session and files live: its own worktree, or the workspace
 * folder. The result is the owning workspace with the root and grant to use.
 */
function threadScope(state: Pick<AppStore, "workspaces">, thread: Pick<Thread, "workspacePath" | "worktree"> | undefined): Workspace | undefined {
  return inWorktree(thread && state.workspaces.find((item) => item.path === thread.workspacePath), thread?.worktree);
}

/** A workspace with a worktree's root and grant swapped in, or the workspace itself when there is none. */
export function inWorktree(workspace: Workspace | undefined, worktree: ThreadWorktree | undefined): Workspace | undefined {
  // An ungranted workspace takes its worktrees with it: the native side revokes
  // them together, and a thread must not outlive the folder it belongs to.
  return workspace && worktree ? { ...workspace, path: worktree.path, grantId: workspace.grantId ? worktree.grantId : null } : workspace;
}

/**
 * The selected workspace as the open thread sees it. Changes, review, the file
 * index and opened files follow a worktree thread into its worktree.
 */
export function activeWorkspace(state: Pick<AppStore, "workspaces" | "selectedWorkspaceId" | "threads" | "selectedSessionId">): Workspace | undefined {
  const workspace = currentWorkspace(state);
  const thread = currentThread(state);
  return workspace && thread?.worktree && thread.workspacePath === workspace.path ? threadScope(state, thread) : workspace;
}

/** Whether a thread writes to the same folder the open view is showing. */
function sharesActiveScope(state: Pick<AppStore, "workspaces" | "selectedWorkspaceId" | "threads" | "selectedSessionId">, thread: Thread | undefined): boolean {
  const active = activeWorkspace(state);
  return Boolean(thread && active && thread.workspacePath === currentWorkspace(state)?.path && threadScope(state, thread)?.path === active.path);
}

/**
 * After the selection moved, re-read what depends on the folder in view if that
 * folder changed. Switching between a worktree thread and its workspace keeps
 * the workspace selected, so nothing else would refresh Changes or @-mentions.
 */
function rescope(get: () => AppStore, set: (patch: Partial<AppStore>) => void, from: string | null | undefined) {
  if ((activeWorkspace(get())?.grantId ?? null) === (from ?? null)) return;
  ++reviewVersion;
  ++gitGraphVersion;
  set({ git: null, gitError: null, gitGraph: null, gitGraphLoading: null, gitGraphError: null, reviewBase: "", review: null, reviewError: null, reviewLoading: null, diffTabs: null, diffActive: null, fileView: null, branches: null, pullRequest: null });
  void get().refreshGit();
  get().refreshFileIndex();
}

/** The selected workspace's threads as the sidebar lists them: pinned first, then newest position first. */
function workspaceThreads(state: Pick<AppStore, "threads" | "workspaces" | "selectedWorkspaceId">): Thread[] {
  const path = currentWorkspace(state)?.path;
  return state.threads
    .filter((thread) => thread.workspacePath === path && !thread.archived)
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.order ?? 0) - (a.order ?? 0));
}

/** Drop discarded paths from the open diff tabs (null clears all). */
function pruneDiffTabs(dropped: Set<string> | null) {
  const state = useAppStore.getState();
  if (!state.diffTabs && !state.diffActive) return;
  const remaining = dropped ? (state.diffTabs ?? []).filter((entry) => !dropped.has(entry)) : [];
  const active = state.diffActive && (dropped === null || dropped.has(state.diffActive))
    ? (remaining[0] ?? null)
    : state.diffActive;
  useAppStore.setState({ diffTabs: state.diffTabs ? remaining : state.diffTabs, diffActive: active });
}

/**
 * One bounded `session/list` walk shared by workspace opens and the quiet-turn
 * reconcile. Follows `nextCursor` up to `maxPages`, optionally stopping early
 * once `stopWhen` is satisfied. Reports truncation so callers can warn instead
 * of silently dropping sessions past the bound.
 */
async function listWorkspaceSessions(workspace: Pick<Workspace, "path" | "grantId"> | null, agentId: string | undefined, maxPages: number, stopWhen?: (all: SessionMetadata[]) => boolean, options?: { updatedAfter?: string }) {
  const sessions: SessionMetadata[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < maxPages; page += 1) {
    // The grant id authorizes the call; the native side injects the canonical
    // root. A null workspace lists every workspace grantlessly (metadata
    // only); those rows bind to no grant until a scoped listing binds them.
    const listed = await bridge<{ sessions?: SessionMetadata[]; nextCursor?: string | null }>("listSessions", {
      agentId,
      limit: 200,
      ...(workspace?.grantId ? { grantId: workspace.grantId } : {}),
      ...(cursor ? { cursor } : {}),
      ...(options?.updatedAfter ? { updatedAfter: options.updatedAfter } : {}),
    });
    sessions.push(...(listed.sessions ?? []));
    cursor = listed.nextCursor ?? undefined;
    if (!cursor || stopWhen?.(sessions)) break;
    if (page === maxPages - 1) truncated = true;
  }
  return { sessions, truncated };
}

/** The agent when it can take work: it ships with the app and is ready once a provider has a key. */
export function readyAgents(state: Pick<AppStore, "agents">): AgentInfo[] {
  return state.agents.filter((agent) => agent.found && agent.authenticated);
}

function agentConfigPatch(config?: AgentSessionConfig): Partial<SessionConfig> {
  if (!config) return {};
  return {
    ...(config.modelId ? { modelId: config.modelId, providerId: config.modelId.includes("/") ? config.modelId.split("/")[0] : undefined } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    ...(config.mode ? { mode: config.mode } : {}),
    ...("orchestrator" in config ? { orchestrator: config.orchestrator ?? null } : {}),
  };
}

/** Keeps the effort inside the tiers the selected model supports. */
function fitEffort(config: SessionConfig, models: Model[]): SessionConfig {
  if (!config.effort) return config;
  return { ...config, effort: clampTier(config.effort, tiersFor(modelFor(models, config))) };
}

/** The config the composer shows: the thread's, else this workspace's draft, else defaults. */
export function activeConfig(state: Pick<AppStore, "threads" | "selectedSessionId" | "drafts" | "selectedWorkspaceId" | "defaultModel" | "defaultProviderId" | "defaultApprovalMode" | "defaultEffort">): SessionConfig {
  return currentThread(state)?.config ?? state.drafts[`project:${state.selectedWorkspaceId}`]?.config ?? defaults(state);
}

export function currentThread(state: Pick<AppStore, "threads" | "selectedSessionId">): Thread | undefined {
  return state.threads.find((thread) => thread.sessionId === state.selectedSessionId);
}
