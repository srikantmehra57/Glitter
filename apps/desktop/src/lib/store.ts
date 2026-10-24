import { create } from "zustand";
import { estimateTurnTokens, mergeHistoryItems, messageRewindBoundary, planAnchorFor, relativeToWorkspace, stepFromItem } from "./agent";
import { LazyStore } from "@tauri-apps/plugin-store";
import { SettingsPersistence, settingsFields } from "./settingsPersistence";
import { composeLineComments, LINE_COMMENT_LIMIT, type LineComment } from "./lineComments";
import { rememberCommand } from "./palette";
import { menuAccelerators } from "./shortcuts";
import { buildSuggestionPrompt, cheapestModel, parseSuggestions, suggestionSignature, SUGGESTION_BRIDGE_TIMEOUT_MS, SUGGESTION_BUDGET_MS, SUGGESTION_MIN_GAP_MS, SUGGESTION_TTL_MS } from "./suggestions";
import { stepZoom } from "./zoom";
import { asLedger, compact, EMPTY_LEDGER, recordTurn, turnEntry, type UsageLedger } from "./usageLedger";
import { persistableDrafts, rememberPrompt, NewerSessionMemoryError, SessionMemoryPersistence, SESSION_MEMORY_VERSION, type Draft, type SessionMemory, type ThreadMeta } from "./sessionMemory";
import { acpConsentGet, acpConsentSet, agentIdentities, bridge, catalogInstall, catalogList, catalogRemove, cliLogout, confirmAgentBin, credentialGet, credentialSet, enterpriseStatus, gitCommit, gitDiscardAll, gitDiscardFiles, gitDiscardHunk, gitInit, gitReview, gitBranches, gitPull, gitPullRequest, gitPush, gitSnapshot, gitStage, gitSwitch, gitWorktreeCreate, gitWorktreeHandoff, gitWorktreeRemove, turnSnapshots, restoreTurnSnapshot, forgetTurnSnapshots, listWorkspaceFiles, MOCK_FILES, mockThreads, mockWorkspaceFile, mockWorktree, providerKeysGet, readWorkspaceFile, onBridgeEvent, onWindowCloseRequested, persistStoreDocument, pickFolder, pickPluginBundle, pickSkillSource, pluginInstall, pluginList, projectInit, readDroppedPaths, removeGrant, repairStoreDocument, setInterfaceZoom, setWindowAppearance, setMenuShortcuts, skillImport, skillInstall, skillList, skillUninstall, trustPreview, verifyGrants, type BridgeEventPayloads } from "./bridge";
import { MOCK_AGENT_MODELS, MOCK_AGENTS, MOCK_GIT, MOCK_MODELS, mockGitReview } from "./mock";
import { PROVIDER_IDS, type ProviderStatus } from "./providers";
import { clampTier, modelFor, tiersFor } from "./effort";
import { dropHunk, parseUnifiedDiff, reviewTarget } from "./diff";
import { MAX_DROP_FILES, MAX_IMAGE_BYTES, refPathForDrop } from "./drop";
import { authRequired, describeError, isGrantError, timeoutUnknown } from "./errors";
import { log } from "./logger";
import { COMMIT_DRAFT_PROMPT, commitSubjectFromReply, parseShellEscape, parseSkillInvocation } from "./composerText";
import { composePrompt, humanizeToolName, isMacPlatform, isTauri, nextAttentionThread, timeFilterCutoff, titleFromText, uid, untitledThreadTitle, workspaceName } from "./format";
import { notify, shouldNotify } from "./notify";
import { DOCK_DEFAULT_WIDTH, normalizeDockWidth, normalizeSidebarWidth } from "./reviewLayout";
import { rekeyThreadState } from "./agentSwitch";
import { resolveTheme, type ThemeSettings } from "./theme";
import {
  AGENT_LABELS,
  DEFAULT_SETTINGS,
  agentEnabled,
  approvalModeForAgent,
  type AgentId,
  type AgentIdentity,
  type AgentInfo,
  type AgentSessionConfig,
  type ApprovalRequest,
  type Detection,
  type GitSnapshot,
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
  type CliUpdateOutcome, type CliUpdateStatus, type ComposerImage, type ContextRef, type HostCompat, type HostInfo, type Model, type ModelTestResult, type SessionConfig, type SessionMetadata, type SessionOpening, type SessionPreview,
  type UserInputResponse, type GoalState, type ContextUsage, type TokenUsage, type SubscriptionUsage, type SubagentResult, type Suggestion, type TrustPreview, type SkillRow, type McpServer, type HarnessMcpStatus, type HarnessMcpConfig, type HarnessMcpScope, type HarnessMcpServerInput, type CatalogEntry, type CatalogInstallResult, type CatalogRemoveResult, type PluginEntry, type SkillEntry, type HostPosture, type EnterpriseStatus, type SettingsTab,
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

const settingsPersistence = persistentStore ? new SettingsPersistence(persistentStore, {
  get: credentialGet,
  set: credentialSet,
}) : null;
const memoryPersistence = new SessionMemoryPersistence(persistentStore, typeof localStorage === "undefined" ? null : localStorage);
const pendingDeltas = new Map<string, { at: number; text?: string; output?: string }>();
/** A stashed delta whose `item` never landed is orphaned after this long. */
const DELTA_STASH_TTL_MS = 120_000;
let memoryTimer: ReturnType<typeof setTimeout> | null = null;
const previewTimers = new Map<string, number>();
let hostStart: Promise<boolean> | null = null;
let hydration: Promise<void> | null = null;
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
/** Modes an ACP agent offers a new session (OpenCode: build, plan), as its catalog reported them. */
export type AgentModes = { modes: NonNullable<AgentSessionConfig["modes"]>; defaultMode?: string };
async function readModelCatalog(agentId: AgentId, preview: boolean, sessionId?: string, refresh = false, modelId?: string): Promise<{ models: Model[]; modes?: AgentModes }> {
  if (preview) return { models: agentId === "muse" ? MOCK_MODELS : MOCK_AGENT_MODELS[agentId] ?? [], ...(agentId === "opencode" ? { modes: { modes: OPENCODE_MODES, defaultMode: "build" } } : agentId === "harness" ? { modes: { modes: HARNESS_MODES, defaultMode: "build" } } : {}) };
  // A draft names its picked model, so the agent reports that model's effort levels before any session exists.
  const result = await bridge<{ models: Model[]; modes?: AgentModes["modes"]; defaultMode?: string }>("listModels", { agentId, sessionId, ...(refresh ? { refresh: true } : {}), ...(modelId && !sessionId ? { modelId } : {}) });
  return { models: result.models ?? [], ...(result.modes?.length ? { modes: { modes: result.modes, defaultMode: result.defaultMode } } : {}) };
}
let selectionVersion = 0;
let gitVersion = 0;
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
/** Sources with a `forkSession` in flight. `session/fork` is not idempotent. */
const forking = new Set<string>();
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
  useAppStore.setState({ gitLoading: true, gitError: null, review: null, reviewError: null });
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

/** Validate a `usage/read` / `usage/changed` payload; malformed or absent snapshots become null. */
function asSubscriptionUsage(value: unknown): SubscriptionUsage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const window = record.window as Record<string, unknown> | null;
  const weekly = record.weekly as Record<string, unknown> | null;
  if (!window || typeof window !== "object" || !weekly || typeof weekly !== "object") return null;
  if (typeof record.tier !== "string" || !record.tier.trim()) return null;
  const required = [record.observedAtMs, window.usedPercent, window.resetsAtMs, weekly.usedPercent, weekly.resetsAtMs];
  if (!required.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  const duration = window.windowDurationMins;
  return {
    observedAtMs: record.observedAtMs as number,
    tier: (record.tier as string).trim(),
    window: {
      usedPercent: window.usedPercent as number,
      resetsAtMs: window.resetsAtMs as number,
      ...(typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? { windowDurationMins: duration } : {}),
    },
    weekly: { usedPercent: weekly.usedPercent as number, resetsAtMs: weekly.resetsAtMs as number },
  };
}
/** "Thread settings updated" style confirmations fade after a few seconds. */
const noticeTokens = new Map<string, number>();
function scheduleConfigNoticeClear(sessionId: string, notice: string, delay = 4000) {
  // Keyed per thread: a second notice must not strand the first thread's clear.
  const token = (noticeTokens.get(sessionId) ?? 0) + 1;
  noticeTokens.set(sessionId, token);
  window.setTimeout(() => {
    if (noticeTokens.get(sessionId) !== token) return;
    useAppStore.setState((state) => ({
      threads: state.threads.map((thread) => thread.sessionId === sessionId && thread.configNotice === notice ? { ...thread, configNotice: undefined } : thread),
    }));
  }, delay);
}
const draftKey = (state: Pick<AppStore, "selectedSessionId" | "selectedWorkspaceId">) => state.selectedSessionId ? `thread:${state.selectedSessionId}` : `project:${state.selectedWorkspaceId}`;
const defaults = (state: Pick<Settings, "defaultAgentId" | "defaultModel" | "defaultProviderId" | "defaultApprovalMode" | "defaultEffort" | "enabledAgents">): SessionConfig => ({
  ...(state.defaultAgentId && state.defaultAgentId !== "muse" && agentEnabled(state, state.defaultAgentId) ? { agentId: state.defaultAgentId } : {}),
  ...(state.defaultModel.trim() ? { modelId: state.defaultModel.trim(), providerId: state.defaultProviderId } : {}),
  approvalMode: state.defaultApprovalMode,
  effort: state.defaultEffort,
});
function samePosture(a: HostPosture, b: HostPosture): boolean {
  return a.ephemeralSessions === b.ephemeralSessions && a.disableWrite === b.disableWrite && a.disableShell === b.disableShell && a.sandboxNetwork === b.sandboxNetwork && a.contributorMode === b.contributorMode;
}
/** The built-in harness's modes, as its bridge reports them (`harness/host.ts`). */
const HARNESS_MODES = [
  { value: "build", name: "Build", description: "Reads, edits files and runs commands, within the permission mode." },
  { value: "plan", name: "Plan", description: "Reads the workspace and plans. File edits are refused." },
];
const OPENCODE_MODES = [
  { value: "build", name: "build", description: "The default agent. Executes tools based on configured permissions." },
  { value: "plan", name: "plan", description: "Plan mode. Disallows all edit tools." },
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
  /** Last CLI release-channel check; null until the first check settles. */
  cliUpdate: CliUpdateStatus | null;
  cliUpdateLoading: boolean;
  cliUpdateError: string | null;
  cliUpdateAt: number | null;
  /** An explicit CLI update run is in flight. */
  cliUpdating: boolean;
  /** Last explicit update outcome, for the sidebar popover; cleared by the next check. */
  cliUpdateResult: CliUpdateOutcome | null;
  /** Live `muse serve` handshake facts; null when the host is not running. */
  hostInfo: HostInfo | null;
  /** Trust class the running host was constructed with; null while stopped. */
  hostTrust: boolean | null;
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
  /** Agent-config setup dialog: dry-run preview, then scaffold with conflict handling. */
  initDialog: { workspaceId: string; loading: boolean; error: string | null; preview: string | null; conflict: boolean; done: boolean } | null;
  openInitDialog: (workspaceId: string) => Promise<void>;
  closeInitDialog: () => void;
  runInit: (force: boolean) => Promise<void>;
  untrustWorkspace: (workspaceId: string) => Promise<void>;
  openLastThread: () => Promise<void>;
  /** Refresh the session skill catalog (`skill/list`). */
  refreshSkills: (sessionId?: string) => Promise<void>;
  /** Host-configured MCP servers (`mcpServers` verb); host-global, not per session. */
  mcpServers: McpServer[];
  mcpLoading: boolean;
  mcpError: string | null;
  refreshMcpServers: () => Promise<void>;
  /** The Harness's own MCP generation for the thread's workspace; null until loaded. */
  harnessMcp: HarnessMcpStatus | null;
  harnessMcpLoading: boolean;
  harnessMcpError: string | null;
  refreshHarnessMcp: (sessionId: string, refresh?: boolean) => Promise<void>;
  /** The config rows behind `harnessMcp`, including servers the parser refused; null until loaded. */
  harnessMcpConfig: HarnessMcpConfig | null;
  harnessMcpConfigLoading: boolean;
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
  /** Plugin inventory (`plugin_list`); `availableShown` selects marketplace-available rows. */
  pluginEntries: PluginEntry[];
  pluginsAvailableShown: boolean;
  pluginsLoading: boolean;
  pluginsError: string | null;
  refreshPlugins: (available?: boolean) => Promise<void>;
  /** Pick a bundle folder and install it, then show the installed inventory. */
  installPlugin: () => Promise<void>;
  /** CLI skill inventory (`skill_list`) for lifecycle management. */
  skillEntries: SkillEntry[];
  skillsLoading: boolean;
  skillsError: string | null;
  refreshManagedSkills: () => Promise<void>;
  /** Pick a bundle folder and install it, then refresh the inventory. */
  installSkill: () => Promise<void>;
  /** Import skills from another agent; dry runs return the preview text. */
  importSkills: (from: "claude" | "codex", dryRun: boolean) => Promise<string>;
  /** Uninstall a skill by id, then refresh the inventory. */
  uninstallSkill: (id: string) => Promise<void>;
  /** Enterprise configuration status (`config status`); null until loaded. */
  enterprise: EnterpriseStatus | null;
  enterpriseLoading: boolean;
  enterpriseError: string | null;
  refreshEnterprise: () => Promise<void>;
  /** Agent CLIs detected on this machine. */
  agents: AgentInfo[];
  /** Native ACP binary identities (canonical path, pin/drift state). */
  agentIdentities: AgentIdentity[];
  /** Which agent `models` belongs to. */
  modelsAgentId: AgentId;
  settingsOpen: boolean;
  /** Last visited Settings tab, also used by explicit navigation links. */
  settingsTab: SettingsTab;
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
  /** Each ACP agent's session modes from its catalog, so a draft can offer them before a session exists. */
  agentModes: Partial<Record<AgentId, AgentModes>>;
  gitLoading: boolean;
  gitError: string | null;
  subscriptionUsage: SubscriptionUsage | null;
  subscriptionUsageLoading: boolean;
  subscriptionUsageError: string | null;
  subscriptionUsageAt: number | null;
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
  peekModelCatalog: (agentId: AgentId) => Promise<Model[]>;
  /** One short request to a Harness model, timed. Settings → Models' Test. */
  testModel: (agentId: AgentId, model: Model) => Promise<ModelTestResult>;
  /** Pick a model from another agent's provider: switch the thread's agent, then its model. */
  chooseAgentModel: (agentId: AgentId, model: Model) => Promise<void>;
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
  error: string | null;
  /** REC-002: local persistence failed, or the settings file was recovered after corruption. */
  persistNotice: string | null;
  hydrate: () => Promise<void>;
  save: () => Promise<void>;
  commitSettings: (patch: Partial<Settings>) => Promise<void>;
  refreshDetection: () => Promise<void>;
  /** Compare the installed CLI against its release channel (hourly unless forced). */
  refreshCliUpdate: (force?: boolean) => Promise<void>;
  /** Run the launcher's synchronous update, then re-detect and re-check. */
  updateCli: () => Promise<void>;
  /** Remove CLI + desktop credentials, close sessions, and re-detect auth. */
  signOut: () => Promise<void>;
  refreshAgentIdentities: () => Promise<void>;
  confirmAgentBin: (agentId: AgentId) => Promise<void>;
  startHost: (restart?: boolean) => Promise<void>;
  chooseProject: () => Promise<void>;
  addWorkspace: (path: string, grantId?: string | null) => Promise<void>;
  removeWorkspace: (id: string) => void;
  renameThread: (sessionId: string, title: string) => void;
  pinThread: (sessionId: string) => void;
  /** Swap sidebar positions with a neighbouring thread. */
  swapThreadOrder: (sessionId: string, otherId: string) => void;
  /** Persist a drag-reordered thread list; ids are given in the order they now appear. */
  reorderThreads: (sessionIds: string[]) => void;
  archiveThread: (sessionId: string, archived?: boolean) => void;
  deleteThread: (sessionId: string) => void;
  forkThread: (sessionId?: string, lastTurnId?: string, options?: { select?: boolean; firstMessage?: boolean; clientRequestId?: string }) => Promise<string | undefined>;
  rewindMessage: (sessionId: string, itemId: string, text: string, resetFiles?: boolean) => Promise<boolean>;
  compactThread: () => Promise<void>;
  /** Read-only session preview (metadata + recent transcript; never attaches). */
  previewSession: { sessionId: string; title: string; loading: boolean; error: string | null; snapshot: SessionPreview | null } | null;
  openPreview: (sessionId: string) => Promise<void>;
  closePreview: () => void;
  /** Full stored tool output (`item/readOutput` pages, concatenated). */
  outputViewer: { sessionId: string; itemId: string; title: string; loading: boolean; error: string | null; encoding: "utf8" | "base64"; mediaType: string; content: string; byteLen: number; complete: boolean } | null;
  openOutput: (sessionId: string, itemId: string) => Promise<void>;
  closeOutput: () => void;
  /** Child lifecycle/messaging (`subagent/*`); throws unless the host accepts. */
  controlSubagent: (sessionId: string, subagentId: string, action: string, extra?: { body?: string; reason?: string }) => Promise<void>;
  /** Foreground/background tool-task control (`task/*`); throws unless accepted. */
  controlTask: (sessionId: string, action: string, taskId?: string) => Promise<void>;
  /** Workflow-run control (`workflow/*`); throws unless accepted. */
  controlWorkflow: (sessionId: string, workflowRunId: string, action: string, child?: { childId: string; attempt: number }) => Promise<void>;
  /** Session-goal control (`goal/*`); resolves the ack (a `turnId` names the goal-driving turn). */
  controlGoal: (sessionId: string, action: string, objective?: string) => Promise<{ turnId?: string }>;
  /** Child drill-down: result envelope plus the child transcript via `session/read` (harness: `readChildSession`). */
  childSession: { sessionId: string; itemId: string; title: string; loading: boolean; error: string | null; result: SubagentResult | null; items: TranscriptItem[]; consumed: boolean; consumable: boolean } | null;
  openChild: (sessionId: string, itemId: string) => Promise<void>;
  consumeChild: () => Promise<void>;
  closeChild: () => void;
  /** Fetch one more older-history chunk past the held cursor and prepend it. */
  loadOlderHistory: () => Promise<void>;
  /** Rebuild the transcript after a failed fill or history load (re-resume). */
  rebuildThread: () => Promise<void>;
  setThreadSearch: (value: string) => void;
  /** Show or hide the sidebar's search field; opening also expands a collapsed sidebar. Closing clears the query. */
  setThreadSearchOpen: (open: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  /** The terminal pane below the composer. */
  terminalOpen: boolean;
  setTerminalOpen: (open: boolean) => void;
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
  /** Bind this thread (or the workspace draft) to another agent CLI. */
  switchThreadAgent: (agentId: AgentId) => Promise<void>;
  refreshTurnSnapshots: (sessionId: string) => Promise<void>;
  restoreSnapshot: (sessionId: string, turnId: string, options?: { confirmed?: boolean }) => Promise<boolean>;
  sendPrompt: (options?: { resetTaskState?: boolean; disposition?: "queue" | "steer" | "replace" }) => Promise<void>;
  stopTurn: () => Promise<void>;
  unqueueTurn: (turnId: string) => Promise<void>;
  decide: (approvalId: string, choiceId: string, feedback?: string) => Promise<void>;
  pickApprovalScope: (approvalId: string, choiceId: string) => void;
  reclaimApprovalFeedback: (sessionId: string, id: string) => void;
  respondUserInput: (sessionId: string, userInputId: string, response: UserInputResponse) => Promise<void>;
  refreshGit: () => Promise<void>;
  /** Coalesce a Changes-pane refresh: armed sources (edit completions, window
   * focus) debounce into a single read instead of one per event. */
  scheduleGitRefresh: () => void;
  /** Initialize git inside the selected workspace after user confirmation. */
  initializeGit: () => Promise<void>;
  discardGitFiles: (paths: string[]) => Promise<void>;
  discardGitHunk: (path: string, hunk: number) => Promise<void>;
  discardAllGit: () => Promise<void>;
  stageGitFiles: (paths: string[], stage: boolean) => Promise<void>;
  commitGit: (message: string) => Promise<void>;
  /** Diff line comments not yet sent, per thread (or per workspace draft). Saved with session memory. */
  lineComments: Record<string, LineComment[]>;
  addLineComment: (comment: Omit<LineComment, "id">) => void;
  removeLineComment: (id: string) => void;
  /** Send every pending comment as one prompt: a new turn, or a steer when a Muse turn is running. */
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
  /** A commit subject drafted by the agent, for the commit box to pick up. */
  commitDraft: { text: string; seq: number } | null;
  /** The thread whose running turn is drafting a commit message. */
  commitDrafting: string | null;
  draftCommitMessage: () => Promise<void>;
  refreshSubscriptionUsage: (force?: boolean) => Promise<void>;
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
  /** Device-code prompt from an in-flight `muse login`; null when no sign-in is running. */
  loginPrompt: { url: string; code: string } | null;
  loginBusy: boolean;
  loginError: string | null;
  startLogin: () => Promise<void>;
  cancelLogin: () => Promise<void>;
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

/** Rename generations (per session) so only the latest settlement wins; plus the in-flight set for host-name racing. */
const renameGeneration = new Map<string, number>();
const renameInflight = new Set<string>();

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
  return {
    ...thread,
    items,
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
    subscriptionUsage: state.subscriptionUsage,
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

/** Host session name first (Muse names sessions from the first prompt), then the last title we saw. */
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
  const cachedTokens = turnCacheTokens(thread);
  // The ledger's input total includes the separately-reported cache, just as finishTurn's does.
  const combinedInput = inputTokens == null ? undefined : inputTokens + cachedTokens;
  const outputChanged = !!outputTokens && outputTokens !== thread.turnStats.outputTokens;
  const inputChanged = combinedInput != null && combinedInput !== thread.turnStats.inputTokens;
  const cacheChanged = cachedTokens !== (thread.turnStats.cachedTokens ?? 0);
  if (!outputChanged && !inputChanged && !cacheChanged) return thread;
  return { ...thread, turnStats: { ...thread.turnStats, ...(outputChanged && outputTokens ? { outputTokens, estimated: false } : {}), ...(inputChanged ? { inputTokens: combinedInput } : {}), cachedTokens: cachedTokens || undefined } };
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
      fail("No agent is ready yet. Add a model provider key in Settings → Providers, or sign in to an agent CLI.");
      return;
    }
    // Every ready agent contributes its sessions; one failing never blocks the
    // rest. Muse lists at 200 rows × 10 pages with the time filter, across
    // every workspace when the all-projects view is on.
    const updatedAfter = get().listSince ? timeFilterCutoff(get().listSince as "day" | "week" | "month") : undefined;
    listings = await Promise.allSettled(ready.map(async (agent) => {
      if (agent.id === "muse") await get().startHost();
      const all = agent.id === "muse" && get().showAllWorkspaces;
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
  // The CLI files a worktree thread under the worktree's root, so the listing
  // above never returns it. Each known worktree is listed through its own
  // grant, which also binds its sessions natively.
  const worktrees = new Map<string, { worktree: ThreadWorktree; agentId: AgentId }>();
  if (workspace.grantId) {
    for (const meta of Object.values(get().threadMeta)) {
      const agentId = (meta.agentId ?? "muse") as AgentId;
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
  for (const [index, listing] of listings.entries()) {
    if (listing.status === "rejected") {
      if (ready[index].id === "muse") fail(describeError("Could not load workspace", listing.reason));
      else log.warn("agent.sessions.unavailable", { agent: ready[index].id, error: message(listing.reason) });
      continue;
    }
    const agentId = listing.value.agentId === "muse" ? undefined : listing.value.agentId;
    for (const session of listing.value.sessions) {
      // All-workspace rows for folders never registered have no grant path;
      // they cannot be opened, so they never become threads.
      if (session.workspaceRoot && !roots.has(session.workspaceRoot)) continue;
      const meta = get().threadMeta[session.sessionId];
      if (meta?.deleted || listed.has(session.sessionId)) continue;
      listed.add(session.sessionId);
      threads.push(applyMeta({ sessionId: session.sessionId, agentId, workspacePath: session.workspaceRoot ?? workspace.path, title: listedTitle(session, meta), order: Date.parse(session.updatedAt ?? "") || Date.now(), updatedAt: session.updatedAt ?? new Date().toISOString(), status: session.status === "running" ? "running" : "idle", unread: false, items: [], activeTurnId: session.activeTurnId, config: { ...metadataConfig(session, agentId ? undefined : get().defaultEffort), ...(agentId ? { agentId } : {}) } }, meta, session.status));
    }
  }
  for (const { worktree, agentId: listedAgent, sessions } of worktreeSessions) {
    const agentId = listedAgent === "muse" ? undefined : listedAgent;
    for (const session of sessions) {
      const meta = get().threadMeta[session.sessionId];
      // Only threads this app put in the worktree: its record is what ties the
      // session to this workspace.
      if (!meta?.worktree || meta.deleted || listed.has(session.sessionId)) continue;
      listed.add(session.sessionId);
      threads.push(applyMeta({ sessionId: session.sessionId, agentId, workspacePath: workspace.path, worktree, title: listedTitle(session, meta), order: Date.parse(session.updatedAt ?? "") || Date.now(), updatedAt: session.updatedAt ?? new Date().toISOString(), status: session.status === "running" ? "running" : "idle", unread: false, items: [], activeTurnId: session.activeTurnId, config: { ...metadataConfig(session, agentId ? undefined : get().defaultEffort), ...(agentId ? { agentId } : {}) } }, meta, session.status));
    }
  }
  set({ threads });
  scheduleMemory(get);
  if (!ready.some((agent) => agent.id === "muse")) void get().refreshModels();
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
  set({ ...switchDraft(get(), id, null), error: null, git: null, fileView: null, branches: null, pullRequest: null, reviewBase: "", review: null, reviewError: null, reviewLoading: null, diffTabs: null, diffActive: null });
  void get().refreshGit();
  void get().refreshFileIndex(id);
  return { workspace, version };
}

/**
 * Settle every Muse thread for a host restart: the dead host held their
 * sessions, turns, approvals, and questions, so all of it unwinds to idle
 * with the transcripts kept and a notice on the open thread.
 */
function settleHostRestart(get: () => AppStore, set: (patch: Partial<AppStore>) => void, messageText: string) {
  const selected = get().selectedSessionId;
  set({
    threads: get().threads.map((thread) => thread.agentId ? thread : {
      ...thread,
      opened: false,
      opening: false,
      status: "idle",
      activeTurnId: null,
      pendingTurnKey: null,
      queuedTurns: [],
      pendingApproval: null,
      queuedApprovals: [],
      userInputs: [],
      userInputPending: undefined,
      cancelRequested: false,
      activity: undefined,
      retry: null,
      viewGap: null,
      plan: settlePlan(thread.plan, "cancelled"),
      items: settleItems(thread.items, "cancelled", true),
      ...(thread.sessionId === selected ? { notice: { level: "info" as const, message: messageText } } : {}),
    }),
  });
}

function finishTurn(thread: Thread, turnId?: string): Partial<Thread> {
  if (thread.turnStartedAt == null) return {};
  const reported = turnTokens(thread);
  const estimate = estimateTurnTokens(thread.items);
  const outputTokens = reported || estimate || undefined;
  const inputTokens = turnPromptTokens(thread) || undefined;
  const cachedTokens = turnCacheTokens(thread) || undefined;
  return { turnStats: { turnId, durationMs: Date.now() - thread.turnStartedAt, outputTokens, inputTokens, cachedTokens, estimated: !reported && Boolean(estimate) }, turnStartedAt: undefined };
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
  if (thread.agentId) {
    const agentId = thread.agentId;
    // ACP applies are a serialized round-trip (~2s on Grok). Changes made
    // while one is in flight merge into a trailing call instead of being
    // dropped, so a scrubbed value is never silently lost.
    if (thread.configPending) { update({ pendingConfig: { ...thread.pendingConfig, ...patch } }); return; }
    update({ configPending: true, configNotice: undefined, error: null });
    try {
      let applied: AgentSessionConfig | undefined;
      if (patch.modelId !== undefined) applied = (await bridge<{ agentConfig?: AgentSessionConfig }>("setModel", { agentId, sessionId, modelId: patch.modelId })).agentConfig;
      if (patch.effort !== undefined) applied = (await bridge<{ agentConfig?: AgentSessionConfig }>("setSessionOption", { agentId, sessionId, option: "effort", value: patch.effort })).agentConfig ?? applied;
      if (patch.mode !== undefined) applied = (await bridge<{ agentConfig?: AgentSessionConfig }>("setSessionOption", { agentId, sessionId, option: "mode", value: patch.mode })).agentConfig ?? applied;
      // The built-in agent enforces the app's permission modes itself; for an agent CLI the bridge answers its permission requests by the mode.
      if (patch.approvalMode !== undefined) patch = { ...patch, approvalMode: (await bridge<{ effectiveMode?: { mode: SessionConfig["approvalMode"] } }>("setApprovalMode", { agentId, sessionId, mode: approvalModeForAgent(agentId, patch.approvalMode) })).effectiveMode?.mode ?? approvalModeForAgent(agentId, patch.approvalMode) };
      const latest = get().threads.find((item) => item.sessionId === sessionId);
      update({ config: { ...latest?.config, ...patch, ...agentConfigPatch(applied), agentId }, ...(applied?.modes ? { modes: applied.modes } : {}) });
      if (patch.modelId !== undefined) void get().refreshModels();
    } catch (error) {
      update({ error: describeError("Settings unchanged", error) });
    } finally {
      update({ configPending: false });
      drainStash();
    }
    return;
  }
  // A pending apply merges further picks into a trailing call instead of
  // dropping them, so a scrubbed value is never silently lost.
  if (thread.configPending) { update({ pendingConfig: { ...thread.pendingConfig, ...patch } }); return; }
  const config = fitEffort({ ...(thread.config ?? defaults(state)), ...patch }, state.models);
  config.approvalMode = approvalModeForAgent(thread.agentId, config.approvalMode);
  update({ configPending: true, configNotice: undefined, error: null });
  try {
    if (!state.preview) {
      if (!thread.opened) throw new Error("Open this thread successfully before changing its settings.");
      if (patch.modelId !== undefined) {
        const result = await bridge<{ status: string }>("setModel", { sessionId, modelId: config.modelId, providerId: config.providerId });
        if (result.status !== "accepted") throw new Error("Model change was not accepted.");
      }
      if (patch.approvalMode !== undefined) {
        const result = await bridge<{ status: string; effectiveMode: { mode: SessionConfig["approvalMode"] } }>("setApprovalMode", { sessionId, mode: config.approvalMode });
        if (result.status !== "accepted") throw new Error("Approval change was not accepted.");
        config.approvalMode = result.effectiveMode.mode;
      }
      if (patch.effort !== undefined && config.effort) {
        const result = await bridge<{ status: string }>("setReasoningEffort", { sessionId, reasoningEffort: config.effort });
        if (result.status !== "accepted") throw new Error("Effort change was not accepted.");
      }
    }
    update({ config });
  } catch (error) {
    update({ error: describeError("Settings unchanged", error) });
  } finally {
    update({ configPending: false });
    drainStash();
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
  cliUpdate: null,
  cliUpdateLoading: false,
  cliUpdateError: null,
  cliUpdateAt: null,
  cliUpdating: false,
  cliUpdateResult: null,
  hostInfo: null,
  hostTrust: null,
  listSince: null,
  showAllWorkspaces: false,
  agents: [],
  agentIdentities: [],
  mcpServers: [],
  mcpLoading: false,
  mcpError: null,
  harnessMcp: null,
  harnessMcpLoading: false,
  harnessMcpError: null,
  harnessMcpConfig: null,
  harnessMcpConfigLoading: false,
  harnessMcpConfigError: null,
  catalogEntries: [],
  catalogSkillsRoot: null,
  catalogLoading: false,
  catalogError: null,
  pluginEntries: [],
  pluginsAvailableShown: false,
  pluginsLoading: false,
  pluginsError: null,
  skillEntries: [],
  skillsLoading: false,
  skillsError: null,
  enterprise: null,
  enterpriseLoading: false,
  enterpriseError: null,
  modelsAgentId: "muse",
  settingsOpen: false,
  settingsTab: "Models",
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
  subscriptionUsage: null,
  usageLedger: EMPTY_LEDGER,
  clearUsageHistory: () => {
    set({ usageLedger: EMPTY_LEDGER });
    scheduleLedger(get);
  },
  subscriptionUsageLoading: false,
  subscriptionUsageError: null,
  subscriptionUsageAt: null,
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
  loginPrompt: null,
  loginBusy: false,
  loginError: null,
  dismissPersistNotice: () => set({ persistNotice: null }),
  dismissError: () => set({ error: null, threads: get().threads.map((thread) => thread.sessionId === get().selectedSessionId ? { ...thread, error: null } : thread) }),

  startLogin: async () => {
    if (get().loginBusy || get().preview) return;
    set({ loginBusy: true, loginError: null, loginPrompt: null });
    try {
      const prompt = await bridge<{ url: string; code: string }>("startLogin", { museBin: get().museBin || undefined });
      if (!prompt?.url || !prompt?.code) throw new Error("Muse did not show a sign-in code.");
      set({ loginPrompt: { url: prompt.url, code: prompt.code } });
    } catch (error) {
      set({ loginError: describeError("Could not sign in", error), loginPrompt: null });
    } finally {
      set({ loginBusy: false });
    }
  },
  cancelLogin: async () => {
    set({ loginPrompt: null, loginError: null });
    try { await bridge("cancelLogin"); }
    catch (error) { log.warn("login cancel failed", { error: message(error) }); }
  },

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
        // The two persisted documents and the ACP consent gate are independent
        // reads (the settings read also hits the keychain), so they overlap.
        const [memory, saved, consented] = await Promise.all([
          memoryPersistence.load(),
          settingsPersistence ? settingsPersistence.load() : Promise.resolve(null),
          settingsPersistence && isTauri()
            ? acpConsentGet().then((value) => value === true, () => false)
            : Promise.resolve(null),
        ]);
        let coerced = false;
        if (saved) {
          // `allowAll` is a per-thread composer choice, never a durable default:
          // a stored value (older build or hand-edited file) is clamped on load.
          if (saved.defaultApprovalMode === "allowAll" || saved.defaultApprovalMode === "guarded") {
            log.info("settings.approval_default_coerced");
            saved.defaultApprovalMode = "promptUnmatched";
            coerced = true;
          }
          set({ ...DEFAULT_SETTINGS, ...saved, threadMeta: memory.threadMeta, drafts: memory.drafts, promptHistory: memory.promptHistory, lineComments: memory.lineComments, recentCommands: memory.recentCommands, settingsTab: memory.settingsTab, dockOpen: memory.dockOpen, dockWidth: memory.dockWidth, zoom: memory.zoom, sidebarCollapsed: memory.sidebarCollapsed, sidebarWidth: memory.sidebarWidth });
          if (consented !== null) set({ acpUnisolatedConsent: consented });
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
        const restored = asSubscriptionUsage(memory.subscriptionUsage);
        const expired = restored != null && restored.window.resetsAtMs < Date.now() && restored.weekly.resetsAtMs < Date.now();
        if (restored && !expired) set({ subscriptionUsage: restored, subscriptionUsageAt: restored.observedAtMs });
        applyTheme(get());
        const reconciled = await reconcileGrants(get().workspaces);
        const ungranted = reconciled.workspaces.filter((workspace) => !workspace.grantId);
        const healed = reconciled.workspaces !== get().workspaces;
        if (healed) set({ workspaces: reconciled.workspaces });
        if (ungranted.length && isTauri()) {
          set({ error: `${ungranted.length} ${ungranted.length === 1 ? "folder needs" : "folders need"} to be re-opened to restore access after a security upgrade. Use Open workspace and pick the folder again.` });
        }
        if (healed || coerced) void get().save();

        // Everything above is local. From here on the app can be shown: what
        // remains — agent detection (which spawns CLIs), starting the host,
        // listing threads, reopening the last one — takes as long as it takes,
        // and used to hold the whole window on a boot screen until it finished.
        // Detection starts first so listing and sending can wait on it. Provider
        // status (custom endpoint names included) is a cheap local read.
        const detecting = get().refreshDetection();
        detecting.catch(() => {});
        void get().refreshProviders();
        // Selection, draft and the changes dock need nothing from the host.
        const restoreId = memory.selectedWorkspaceId && get().workspaces.some((workspace) => workspace.id === memory.selectedWorkspaceId)
          ? memory.selectedWorkspaceId
          : get().workspaces[0]?.id;
        const begun = restoreId ? beginWorkspaceSelection(get, set, restoreId) : null;
        set({ ready: true, booting: begun != null, restoringSession: begun ? memory.selectedSessionId : null });
        try {
          await detecting;
          const detected = get().detection;
          if (detected?.path && !get().museBin) {
            set({ museBin: detected.path });
            void get().save();
          }
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
    const settings = settingsFields({ ...get(), ...patch });
    // A failed write must not reject into a `void` call site (which would leave
    // the toggle looking inert with no explanation). Surface it and still apply
    // the patch, so the control responds and the next successful save heals it.
    if (settingsPersistence && !get().preview) {
      try { await settingsPersistence.save(settings); }
      catch (error) { set({ error: describeError("Could not save settings", error) }); }
    }
    if (isTauri() && !get().preview) {
      try { await acpConsentSet(settings.acpUnisolatedConsent === true); }
      catch { /* native gate stays at its last durable value */ }
    }
    set({ ...patch, enabledAgents: settings.enabledAgents, acpUnisolatedConsent: settings.acpUnisolatedConsent === true });
    applyTheme(settings);
    // The native menu holds its own copy of the accelerators.
    if ("shortcutOverrides" in patch) void setMenuShortcuts(menuAccelerators(settings.shortcutOverrides ?? {})).catch((error) => log.warn("shortcuts.menu_failed", { error: message(error) }));
    const next = get();
    if (next.defaultAgentId && !agentEnabled(next, next.defaultAgentId)) set({ defaultAgentId: undefined });
    // A disabled agent is "hidden from the composer", not deleted: the open
    // thread and its drafts stay exactly where the user left them. Sidebar
    // filtering owns hiding the row; clearing the selection here used to wipe
    // the thread the user was looking at.

    // Only the workspace draft shows the chips. A toggle from an open thread
    // must not start a suggestion turn in the background.
    if (patch.suggestionsEnabled === true && get().selectedSessionId == null && !get().restoringSession) void get().refreshSuggestions(true);
    else if (patch.suggestionsEnabled === false) set({ suggestions: null });
    const projectKey = `project:${get().selectedWorkspaceId}`;
    const project = get().drafts[projectKey];
    if (project?.config?.agentId && !agentEnabled(get(), project.config.agentId)) {
      set({ drafts: { ...get().drafts, [projectKey]: { ...project, config: { ...project.config, agentId: undefined } } } });
    }
  },

  refreshProviders: async () => {
    try {
      set({ providerStatus: await providerKeysGet(PROVIDER_IDS), providerStatusError: null });
    } catch (error) {
      // Pickers fall back to ids alone; the Providers page shows the error.
      set({ providerStatusError: describeError("Could not read saved providers", error) });
    }
  },

  refreshDetection: async () => {
    const run = (async () => {
      const detection = await bridge<Detection>("detect", {
        museBin: get().museBin || undefined,
        museApiKey: get().museApiKey.trim() || undefined,
        museAuthMode: get().museAuthMode,
      });
      set({ detection, agents: detection.agents ?? get().agents });
      // Identities only feed the Settings agent rows; nothing waits on them.
      void get().refreshAgentIdentities();
      // A quiet hourly channel check behind every detection; the sidebar row
      // appears only when a newer release is actually on the channel.
      if (detection.found && !get().preview && !get().offline) void get().refreshCliUpdate();
    })();
    detectionInFlight = run;
    try {
      await run;
    } finally {
      if (detectionInFlight === run) detectionInFlight = null;
      set({ detectionChecked: true });
    }
  },

  refreshCliUpdate: async (force) => {
    const state = get();
    // No guard against a running update: the launcher writes state atomically,
    // so a check racing a swap reads the old or the new release, never garbage.
    if (state.preview || state.cliUpdateLoading) return;
    // Same cadence as the launcher's own background check; an explicit
    // "check again" always goes through.
    if (!force && state.cliUpdateAt && Date.now() - state.cliUpdateAt < 60 * 60_000) return;
    if (!force && !state.detection?.found) return;
    set({ cliUpdateLoading: true, cliUpdateError: null, cliUpdateResult: null });
    try {
      const status = await bridge<CliUpdateStatus>("checkCliUpdate", { museBin: get().museBin || undefined });
      set({ cliUpdate: status, cliUpdateAt: Date.now() });
    } catch (error) {
      set({ cliUpdateError: describeError("Could not check for an update", error) });
    } finally {
      set({ cliUpdateLoading: false });
    }
  },

  updateCli: async () => {
    const state = get();
    if (state.preview || state.cliUpdating || state.cliUpdateLoading) return;
    set({ cliUpdating: true, cliUpdateError: null, cliUpdateResult: null });
    try {
      // Past the bridge's 5-minute update budget, with room for the round trip.
      const outcome = await bridge<CliUpdateOutcome>("updateCli", { museBin: get().museBin || undefined }, { timeoutMs: 330_000 });
      // The launcher swapped binaries under us: re-probe the version (the
      // bridge dropped its cached print) and confirm the channel state. The
      // outcome lands last so the re-check cannot clear it before it shows.
      try {
        await get().refreshDetection();
      } catch {
        // Detection already surfaces its own state; the update itself landed.
      }
      await get().refreshCliUpdate(true);
      set({ cliUpdateResult: outcome });
    } catch (error) {
      set({ cliUpdateError: describeError("Could not update the CLI", error) });
    } finally {
      set({ cliUpdating: false });
    }
  },

  signOut: async () => {
    try {
      set({ error: null });
      await cliLogout(get().museBin || undefined);
      if (settingsPersistence && !get().preview) {
        await settingsPersistence.save(settingsFields({ ...get(), museApiKey: "" }));
      }
      set({ museApiKey: "", hostInfo: null, hostTrust: null });
      settleHostRestart(get, set, "Signed out. Sessions are closed; sign back in to continue.");
      await get().refreshDetection();
    } catch (error) {
      set({ error: describeError("Could not finish signing out", error) });
    }
  },

  refreshAgentIdentities: async () => {
    try {
      set({ agentIdentities: await agentIdentities() });
    } catch {
      // Display-only: a failed lookup leaves the last known identities.
    }
  },

  confirmAgentBin: async (agentId) => {
    const identity = await confirmAgentBin(agentId);
    set({ agentIdentities: [...get().agentIdentities.filter((item) => item.agentId !== agentId), identity] });
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
    if (!hostStart) hostStart = (async (): Promise<boolean> => {
      const museApiKey = get().museApiKey.trim() || undefined;
      const museAuthMode = get().museAuthMode;
      const trustWorkspace = currentWorkspace(get())?.trusted === true;
      const posture = { ephemeralSessions: get().ephemeralSessions, disableWrite: get().disableWrite, disableShell: get().disableShell, sandboxNetwork: get().sandboxNetwork, contributorMode: get().contributorMode };
      // Nearly every call finds the host already running the way it is wanted. The
      // renderer hears about every exit (`hostExit`, `bridgeExit`), so what it holds
      // is current: asking the bridge again would cost a round trip per thread open.
      const running = get().hostInfo;
      if (!restart && running?.posture && get().hostTrust === trustWorkspace && samePosture(running.posture, posture)) return false;
      const result = await bridge<{ running?: boolean; compat?: HostCompat; trustWorkspace?: boolean; posture?: HostPosture | null }>("status", { museApiKey, museAuthMode });
      // A running host of the wrong trust class restarts: skills and rules
      // must never mix classes on one host.
      const wrongTrust = result.running && result.trustWorkspace !== undefined && result.trustWorkspace !== trustWorkspace;
      // Posture is also host-construction: a running host built with
      // different flags restarts so the settings always describe the host.
      const runningPosture = result.posture ?? get().hostInfo?.posture ?? null;
      const wrongPosture = result.running && runningPosture !== null && !samePosture(runningPosture, posture);
      if (restart || wrongTrust || wrongPosture || !result.running) {
        if (wrongTrust) settleHostRestart(get, set, "The host restarted: workspace trust changed.");
        if (wrongPosture) settleHostRestart(get, set, runningPosture?.contributorMode !== posture.contributorMode
          ? "The host restarted: Contributor mode changed." : "The host restarted: sandbox posture changed.");
        const started = await bridge<HostInfo>("startHost", {
          museBin: get().museBin || get().detection?.path || undefined,
          museApiKey,
          museAuthMode,
          trustWorkspace,
          noSessionLog: posture.ephemeralSessions,
          disableWrite: posture.disableWrite,
          disableShell: posture.disableShell,
          sandboxNetwork: posture.sandboxNetwork,
          contributorMode: posture.contributorMode,
        });
        set({ hostInfo: started, hostTrust: started.trustWorkspace ?? trustWorkspace });
        return true;
      } else if (result.compat && !get().hostInfo?.compat) {
        set({ hostInfo: { ...get().hostInfo, compat: result.compat }, hostTrust: result.trustWorkspace ?? get().hostTrust });
      } else if (get().hostTrust === null && result.trustWorkspace !== undefined) {
        set({ hostTrust: result.trustWorkspace });
      }
      return false;
    })().finally(() => { hostStart = null; });
    const started = await hostStart;
    // The catalog only moves when the host does (or was never fetched for this agent).
    if (started || !get().models.length || get().modelsAgentId !== activeAgentId(get())) await get().refreshModels();
  },

  loadModelCatalog: async (agentId) => {
    return (await readModelCatalog(agentId, get().preview, undefined, true)).models;
  },

  peekModelCatalog: async (agentId) => {
    if (get().modelsAgentId === agentId && get().models.length) return get().models;
    const held = modelCatalogs.get(agentId);
    if (held?.length) return held;
    return (await readModelCatalog(agentId, get().preview)).models;
  },

  testModel: async (agentId, model) => {
    // Only the built-in agent calls a provider itself; a CLI agent's model would need a session.
    if (agentId !== "harness") throw new Error(`${AGENT_LABELS[agentId]} models are tested by opening a thread on them.`);
    return bridge<ModelTestResult>("testModel", { agentId, modelId: model.modelId }, { timeoutMs: 45_000 });
  },

  chooseAgentModel: async (agentId, model) => {
    if (activeAgentId(get()) !== agentId) {
      await get().switchThreadAgent(agentId);
      // The switch can be refused (a turn started, the agent is off) or fail; then the model stays too.
      if (activeAgentId(get()) !== agentId) return;
    }
    await get().setSessionConfig({ modelId: model.modelId, providerId: model.providerId });
  },

  refreshModels: async (refresh = false) => {
    if (get().preview) {
      const agentId = activeAgentId(get());
      const catalog = await readModelCatalog(agentId, true);
      set({ models: catalog.models, modelsError: null, modelsLoading: false, modelsAgentId: agentId, ...(catalog.modes ? { agentModes: { ...get().agentModes, [agentId]: catalog.modes } } : {}) });
      return;
    }
    const agentId = activeAgentId(get());
    const thread = currentThread(get());
    const sessionId = agentId !== "muse" && thread && thread.agentId === agentId ? thread.sessionId : undefined;
    const draftModel = agentId !== "muse" && !thread ? activeConfig(get()).modelId : undefined;
    // Callers overlap constantly (starting the host, opening a thread, a model
    // event); one listing per agent and session is enough for all of them.
    const key = `${agentId}\u0000${sessionId ?? ""}\u0000${refresh}\u0000${draftModel ?? ""}`;
    if (modelsInFlight?.key === key) return modelsInFlight.promise;
    const version = ++modelVersion;
    const listing = (modelListings.get(agentId) ?? 0) + 1;
    modelListings.set(agentId, listing);
    // Models already on screen for this agent stay there while the refresh runs:
    // blanking the picker to "Loading…" on every thread switch made it flicker
    // and go unclickable for the length of a round trip.
    const known = get().modelsAgentId === agentId ? get().models : modelCatalogs.get(agentId) ?? [];
    const showing = known.length > 0;
    set({ modelsLoading: !showing, modelsError: null, ...(get().modelsAgentId !== agentId ? { models: known, modelsAgentId: agentId } : {}) });
    const run = (async () => {
      try {
        let { models, modes } = await readModelCatalog(agentId, false, sessionId, refresh, draftModel);
        // An agent that lists nothing from its cache gets one fresh probe before the picker says so.
        if (!refresh && !models.length) ({ models, modes } = await readModelCatalog(agentId, false, sessionId, true, draftModel));
        if (modes) set({ agentModes: { ...get().agentModes, [agentId]: modes } });
        // Only a listing newer than whatever wrote the cache may replace it: a
        // Rescan and a thread switch can overlap, and answers arrive out of order.
        if (listing > (modelCatalogAt.get(agentId) ?? 0)) {
          modelCatalogs.set(agentId, models);
          modelCatalogAt.set(agentId, listing);
        }
        if (version === modelVersion) set({ models, modelsAgentId: agentId });
      } catch (error) {
        if (version === modelVersion) set({ ...(showing ? {} : { models: [] }), modelsError: describeError(`Could not load ${get().agents.find((agent) => agent.id === agentId)?.name ?? agentId} models`, error) });
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

  refreshSubscriptionUsage: async (force) => {
    const state = get();
    if (state.subscriptionUsageLoading) return;
    if (!force && state.subscriptionUsageAt && Date.now() - state.subscriptionUsageAt < 60_000) return;
    set({ subscriptionUsageLoading: true, subscriptionUsageError: null });
    try {
      // Usage is read from the Muse host. A cold app has never started one, so
      // without this the read fails until some other action happens to boot it.
      if (!state.preview && readyAgents(get()).some((agent) => agent.id === "muse")) await get().startHost();
      const result = await bridge<{ usage?: unknown }>("usage", {});
      set({ subscriptionUsage: asSubscriptionUsage(result?.usage ?? null), subscriptionUsageAt: Date.now() });
      scheduleMemory(get);
    } catch (error) {
      set({ subscriptionUsageError: describeError("Could not load subscription usage", error) });
    } finally {
      set({ subscriptionUsageLoading: false });
    }
  },

  setSessionConfig: async (patch) => {
    const state = get();
    const thread = currentThread(state);
    if (state.starting || state.submitting || thread?.status === "running" || thread?.opening || thread?.snapshotPending || thread?.rewindPending) return;
    if (!thread) {
      const key = draftKey(state);
      const previous = state.drafts[key]?.config ?? defaults(state);
      const switching = patch.agentId && patch.agentId !== (previous.agentId ?? preferredAgent(state));
      // A new agent brings its own models and effort tiers; drop the old agent's picks.
      const next = switching ? { ...previous, agentId: patch.agentId, modelId: undefined, providerId: undefined, effort: undefined, mode: undefined } : fitEffort({ ...previous, ...patch }, state.models);
      next.approvalMode = approvalModeForAgent(next.agentId ?? preferredAgent(state), next.approvalMode);
      set({ drafts: { ...state.drafts, [key]: { text: state.composer, images: state.images, refs: state.contextRefs, config: next } } });
      // A new agent lists its own models; a newly picked third-party model is
      // described, so its effort levels show before the thread exists.
      if (switching || (patch.modelId && (next.agentId ?? preferredAgent(state)) !== "muse")) void get().refreshModels();
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
    void cancelThreadTurns(removedThreads);
    releaseThreadSessions(removedThreads.map((thread) => thread.sessionId));
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
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    // ACP agents and preview drafts have no durable name: the local title is the truth.
    if (!thread || thread.agentId || get().preview) {
      set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, title: next, customTitle: true } : item) });
      scheduleMemory(get);
      return;
    }
    const previous = { title: thread.title, customTitle: thread.customTitle };
    const generation = (renameGeneration.get(sessionId) ?? 0) + 1;
    renameGeneration.set(sessionId, generation);
    renameInflight.add(sessionId);
    const current = () => renameGeneration.get(sessionId) === generation;
    set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, title: next, customTitle: true, notice: null } : item) });
    scheduleMemory(get);
    void bridge<{ name?: string; status?: string }>("renameSession", { sessionId, name: next }).then(
      (result) => {
        if (!current()) return;
        renameInflight.delete(sessionId);
        // The host normalizes; the canonical name wins and the local override
        // clears so later host-side renames (other clients, first-naming) flow in.
        // Without a settled name (RecoveryPending arm) the optimistic text stays
        // until the deferred `session/nameChanged` lands — now unblocked.
        const canonical = result.name?.trim() || next;
        set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, title: titleFromText(canonical), customTitle: false, notice: null } : item) });
        scheduleMemory(get);
      },
      (error) => {
        if (!current()) return;
        renameInflight.delete(sessionId);
        set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, title: previous.title, customTitle: previous.customTitle, notice: { level: "warning", message: describeError("Could not rename the thread", error) } } : item) });
        scheduleMemory(get);
      },
    );
  },

  pinThread: (sessionId) => {
    set({ threads: get().threads.map((thread) => thread.sessionId === sessionId ? { ...thread, pinned: !thread.pinned } : thread) });
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
      ...(selected && archived ? { selectedSessionId: null, composer: "", images: [], contextRefs: [] } : {}),
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
    releaseThreadSessions([sessionId]);
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
    set({
      lineComments,
      threads: get().threads.filter((thread) => thread.sessionId !== sessionId),
      drafts,
      threadMeta: { ...get().threadMeta, [sessionId]: { ...get().threadMeta[sessionId], deleted: true, archived: true } },
      ...(selected ? { selectedSessionId: null, composer: "", images: [], contextRefs: [] } : {}),
    });
    scheduleMemory(get);
    rescope(get, set, scope);
  },

  forkThread: async (sessionId, lastTurnId, options) => {
    const state = get();
    const source = state.threads.find((item) => item.sessionId === (sessionId ?? state.selectedSessionId));
    if (!source || source.agentId || source.rewindPending && options?.select !== false) return;
    // Single-flight: `session/fork` is not idempotent, so a double-click on Fork
    // would otherwise create one duplicate fork session per click.
    if (forking.has(source.sessionId)) return;
    forking.add(source.sessionId);
    try {
      // Cut points must be real server turn ids: local/history groupings fork whole.
      const cut = lastTurnId && !lastTurnId.startsWith("local:") && lastTurnId !== "history" ? lastTurnId : undefined;
      const workspace = threadScope(state, source);
      set({ threads: get().threads.map((item) => item.sessionId === source.sessionId ? { ...item, error: null } : item) });
      let forked: SessionOpening & { items?: TranscriptItem[]; historyCursor?: string | null; historyExhausted?: boolean; historyFailed?: boolean; forkedFrom?: { cutExplicit?: boolean } };
      if (state.preview) {
        let end = source.items.length;
        if (cut) { end = 0; source.items.forEach((item, index) => { if (item.turnId === cut) end = index + 1; }); }
        forked = { sessionId: `preview-${uid()}`, items: options?.firstMessage ? [] : source.items.slice(0, end).map((item) => ({ ...item })), historyExhausted: source.historyExhausted, forkedFrom: { cutExplicit: Boolean(cut) } };
      } else if (options?.firstMessage) {
        if (!workspace?.grantId) throw new Error(UNGRANTED_ERROR);
        await get().startHost();
        forked = { ...await bridge<SessionOpening>("startSession", { grantId: workspace.grantId, modelId: source.config?.modelId, providerId: source.config?.providerId, approvalMode: approvalModeForAgent(undefined, source.config?.approvalMode), ...(options.clientRequestId ? { clientRequestId: options.clientRequestId } : {}) }), items: [], historyExhausted: true };
      } else {
        forked = await bridge<typeof forked>("forkSession", { sessionId: source.sessionId, ...(cut ? { lastTurnId: cut } : {}), ...(options?.clientRequestId ? { clientRequestId: options.clientRequestId } : {}) });
      }
      if (!forked.sessionId) throw new Error("Muse did not return a thread. Your edited message is unchanged.");
      const now = new Date().toISOString();
      const title = `${source.title} (fork)`;
      const metadata = forked.opening?.result.session;
      const thread: Thread = {
        sessionId: forked.sessionId, workspacePath: source.workspacePath, worktree: source.worktree, title, customTitle: true, order: Date.now(), updatedAt: now, status: "idle", unread: false,
        items: forked.items ?? [], opened: Boolean(options?.firstMessage), config: options?.firstMessage && metadata ? metadataConfig(metadata, source.config?.effort ?? state.defaultEffort) : { ...source.config },
        historyCursor: forked.historyCursor ?? null, historyExhausted: forked.historyExhausted ?? false, historyFailed: forked.historyFailed ?? !forked.items,
        forkedFrom: { sessionId: source.sessionId, title: source.title, ...(cut && forked.forkedFrom?.cutExplicit ? { cutTurnId: cut } : {}), ...(options?.firstMessage ? { firstMessage: true } : {}) },
        notice: { level: "info", message: options?.firstMessage ? `Edited from ${source.title}. Started with no earlier messages.` : `Forked from ${source.title}.` },
      };
      // A create retry can return a session already learned from an event or an
      // earlier acknowledgement. Keep live items and never add a duplicate row.
      set({ threads: get().threads.some((item) => item.sessionId === thread.sessionId)
        ? get().threads.map((item) => item.sessionId === thread.sessionId ? { ...thread, ...item, title: item.customTitle ? item.title : thread.title, customTitle: true, items: mergeHistoryItems(item.items, thread.items, { sameWindow: true }), historyCursor: thread.historyCursor, historyExhausted: thread.historyExhausted, historyFailed: thread.historyFailed, forkedFrom: thread.forkedFrom } : item)
        : [...get().threads, thread] });
      scheduleMemory(get);
      if (options?.select !== false) await get().selectThread(forked.sessionId);
      return forked.sessionId;
    } catch (error) {
      set({ threads: get().threads.map((item) => item.sessionId === source.sessionId ? { ...item, error: describeError("Could not fork the thread", error) } : item) });
    } finally {
      forking.delete(source.sessionId);
    }
  },

  rewindMessage: async (sessionId, itemId, value, resetFiles = false) => {
    const state = get();
    const source = state.threads.find((thread) => thread.sessionId === sessionId);
    const workspace = state.workspaces.find((item) => item.path === source?.workspacePath);
    const text = value.trim();
    if (!source || source.agentId || !workspace || !text || state.selectedSessionId !== sessionId || state.selectedWorkspaceId !== workspace.id || state.starting || state.submitting || source.status === "running" || source.opening || source.configPending || source.snapshotPending || source.rewindPending || source.queuedTurns?.length || forking.has(sessionId)) return false;
    const update = (patch: Partial<Thread>) => set({ threads: get().threads.map((thread) => thread.sessionId === sessionId ? { ...thread, ...patch } : thread) });
    const boundary = messageRewindBoundary(source, itemId);
    if ("error" in boundary) { update({ rewindError: { itemId, message: boundary.error } }); return false; }
    const original = source.items.find((item) => item.itemId === itemId)!;
    const held = source.rewindAttempt;
    const attempt = held?.itemId === itemId && held.text === text && held.resetFiles === resetFiles ? { ...held } : { itemId, text, resetFiles, requestId: uid(), sessionId: undefined, filesReset: false };
    const snapshot = source.snapshots?.[boundary.turnId];
    const version = selectionVersion;
    const stillSelected = () => {
      const live = get().threads.find((thread) => thread.sessionId === sessionId);
      return selectionVersion === version && get().selectedSessionId === sessionId && get().selectedWorkspaceId === workspace.id && get().workspaces.find((item) => item.id === workspace.id)?.grantId === workspace.grantId && live?.items.find((item) => item.itemId === itemId) === original && !live.agentId && live.status !== "running" && !live.configPending && !live.opening && !get().starting && !get().submitting;
    };
    update({ rewindPending: itemId, rewindError: undefined });
    try {
      if (resetFiles && !attempt.filesReset) {
        if (!snapshot || snapshot.state !== "ready" || !snapshot.files.length) throw new Error("This turn has no restorable file snapshot. Uncheck Reset files too to fork the message only.");
        const confirmed = await state.confirm({ title: `Reset this turn’s ${snapshot.files.length} file change${snapshot.files.length === 1 ? "" : "s"} and send?`, body: "Only the edited turn’s saved files are reset. Other later file changes remain. Every affected file must still match its saved end state; otherwise nothing is restored or sent. Shell or other-app changes during that turn cannot be separated from the agent’s edits. The original thread is kept.", confirmLabel: "Reset and send" });
        if (!confirmed || !stillSelected()) return false;
      }
      update({ rewindAttempt: attempt });
      const forkId = attempt.sessionId ?? await get().forkThread(sessionId, boundary.lastTurnId, { select: false, firstMessage: !boundary.lastTurnId, clientRequestId: attempt.requestId });
      if (!forkId) throw new Error(get().threads.find((thread) => thread.sessionId === sessionId)?.error ?? "Could not create the fork. Your edited message is unchanged.");
      attempt.sessionId = forkId;
      update({ rewindAttempt: { ...attempt } });
      const fork = get().threads.find((thread) => thread.sessionId === forkId);
      if (!fork) { update({ rewindAttempt: undefined }); throw new Error("The fork was removed. Try again to create a new fork."); }
      const key = `thread:${forkId}`;
      const saved = get().drafts[key];
      if (saved?.text && saved.text !== text) throw new Error("The fork already has a different draft. Open that thread to continue; neither draft was sent.");
      set({ drafts: { ...get().drafts, [key]: { text, images: original.images ?? [], refs: original.refs ?? [], config: fork.config } } });
      scheduleMemory(get);
      const keepDraft = () => set({ threads: get().threads.map((thread) => thread.sessionId === forkId ? { ...thread, notice: { level: "info", key: "rewind-draft", message: `Edited prompt saved as a draft. Open this thread to send.${attempt.filesReset ? " The edited turn’s files were reset." : ""}` } } : thread) });
      const removedTurns = new Set(source.items.slice(source.items.indexOf(original)).map((item) => item.turnId).filter(Boolean));
      if (boundary.lastTurnId && (fork.forkedFrom?.cutTurnId !== boundary.lastTurnId || fork.historyFailed || !fork.items.length || fork.items.some((item) => item.turnId && removedTurns.has(item.turnId)))) throw new Error("Muse did not confirm the requested history cut. The edit is saved in the fork; no revised prompt was sent.");
      // Navigation while the RPC is pending keeps the edit as a fork draft. It
      // must not pull the user back, overwrite another draft, or reset files.
      if (!stillSelected()) { keepDraft(); return false; }
      if (resetFiles && !attempt.filesReset) {
        if (get().threads.find((thread) => thread.sessionId === sessionId)?.snapshots?.[boundary.turnId] !== snapshot) throw new Error("The saved file state changed. Review it before trying Reset files too again.");
        const restored = await get().restoreSnapshot(sessionId, boundary.turnId, { confirmed: true });
        if (!restored) throw new Error(get().threads.find((thread) => thread.sessionId === sessionId)?.snapshotError?.message ?? "Files were not reset. The edit is saved in the fork; no revised prompt was sent.");
        attempt.filesReset = true;
        update({ rewindAttempt: { ...attempt } });
        if (!stillSelected()) { keepDraft(); return false; }
      }
      update({ rewindPending: undefined });
      const forkSelection = selectionVersion + 1;
      await get().selectThread(forkId);
      const live = get();
      const liveFork = live.threads.find((thread) => thread.sessionId === forkId);
      if (selectionVersion !== forkSelection || live.selectedSessionId !== forkId || live.selectedWorkspaceId !== workspace.id || live.workspaces.find((item) => item.id === workspace.id)?.grantId !== workspace.grantId || live.composer.trim() !== text || live.images !== live.drafts[key]?.images || live.contextRefs !== live.drafts[key]?.refs || !liveFork || liveFork.status === "running" || !liveFork.opened && !live.preview) { keepDraft(); return false; }
      if (liveFork.notice?.key === "rewind-draft") set({ threads: get().threads.map((thread) => thread.sessionId === forkId ? { ...thread, notice: null } : thread) });
      await get().sendPrompt({ resetTaskState: true });
      // Once a revised turn exists, another edit of the source is a new fork,
      // not a retry that appends to this already-used fork.
      const sent = get().threads.find((thread) => thread.sessionId === forkId);
      if (sent && sent.items.length > fork.items.length) update({ rewindAttempt: undefined });
      return true;
    } catch (error) {
      update({ rewindError: { itemId, message: describeError("Edit and rewind failed", error) } });
      if (attempt.sessionId && get().drafts[`thread:${attempt.sessionId}`]?.text === text) set({ threads: get().threads.map((thread) => thread.sessionId === attempt.sessionId ? { ...thread, notice: { level: "warning", key: "rewind-draft", message: sentenceAfter(describeError("Edit and rewind failed", error), "The edited prompt is saved as a draft.") } } : thread) });
      return false;
    } finally { update({ rewindPending: undefined }); }
  },

  compactThread: async () => {
    const thread = currentThread(get());
    if (!thread || thread.agentId || get().preview || thread.status === "running") return;
    try {
      const result = await bridge<{ status: string; reason?: string }>("compactSession", { sessionId: thread.sessionId });
      if (result.status === "noop") {
        const reason = result.reason === "no_compactable_history" ? "no compactable history yet" : result.reason ?? "nothing to do";
        set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, notice: { level: "info", message: `Already compact: ${reason}.` } } : item) });
        return;
      }
      set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, notice: { level: "info", message: "Compacting context…", key: "compacting" } } : item) });
    } catch (error) {
      set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, error: describeError("Could not compact the thread", error) } : item) });
    }
  },

  previewSession: null,

  openPreview: async (sessionId) => {
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    if (!thread || thread.agentId || get().preview) return;
    set({ previewSession: { sessionId, title: thread.title, loading: true, error: null, snapshot: null } });
    try {
      const snapshot = await bridge<SessionPreview>("readSession", { sessionId, excludeItems: false });
      if (get().previewSession?.sessionId !== sessionId) return;
      set({ previewSession: { sessionId, title: thread.title, loading: false, error: null, snapshot } });
    } catch (error) {
      if (get().previewSession?.sessionId !== sessionId) return;
      set({ previewSession: { sessionId, title: thread.title, loading: false, error: describeError("Could not preview the thread", error), snapshot: null } });
    }
  },

  closePreview: () => set({ previewSession: null }),

  outputViewer: null,

  openOutput: async (sessionId, itemId) => {
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    const item = thread?.items.find((entry) => entry.itemId === itemId);
    const ref = item?.outputRef;
    if (!thread || !item || !ref || ref.availability !== "available") return;
    const title = item.commandText || item.tool || "Tool output";
    set({ outputViewer: { sessionId, itemId, title, loading: true, error: null, encoding: "utf8", mediaType: ref.mediaType ?? "text/plain", content: "", byteLen: ref.byteLen, complete: true } });
    try {
      type Page = { offsetBytes: number; byteLen: number; eof: boolean; encoding: "utf8" | "base64"; mediaType: string; content: string };
      const chunks: string[] = [];
      let offset = 0;
      let encoding: "utf8" | "base64" = "utf8";
      let mediaType = ref.mediaType ?? "text/plain";
      let complete = true;
      // Server pages top out at 6 MiB; four pages (24 MiB) bound one viewing.
      for (let page = 0; page < 4; page += 1) {
        const result = await bridge<Page>("readOutput", { sessionId, itemId, outputRef: ref.id, offsetBytes: offset });
        encoding = result.encoding;
        mediaType = result.mediaType;
        chunks.push(result.content);
        offset = result.offsetBytes + result.byteLen;
        if (result.eof) break;
        if (page === 3) complete = false;
      }
      if (get().outputViewer?.itemId !== itemId) return;
      set({ outputViewer: { sessionId, itemId, title, loading: false, error: null, encoding, mediaType, content: chunks.join(""), byteLen: ref.byteLen, complete } });
    } catch (error) {
      if (get().outputViewer?.itemId !== itemId) return;
      set({ outputViewer: { sessionId, itemId, title, loading: false, error: describeError("Could not read the full output", error), encoding: "utf8", mediaType: ref.mediaType ?? "text/plain", content: "", byteLen: ref.byteLen, complete: true } });
    }
  },

  closeOutput: () => set({ outputViewer: null }),

  controlSubagent: async (sessionId, subagentId, action, extra) => {
    const result = await bridge<{ status: string }>("subagentControl", { sessionId, subagentId, action, ...(extra?.body !== undefined ? { body: extra.body } : {}), ...(extra?.reason !== undefined ? { reason: extra.reason } : {}) });
    if (result.status !== "accepted") throw new Error("The host did not accept that control.");
  },

  controlTask: async (sessionId, action, taskId) => {
    const result = await bridge<{ status: string }>("taskControl", { sessionId, action, ...(taskId !== undefined ? { taskId } : {}) });
    if (result.status !== "accepted") throw new Error("The host did not accept that control.");
  },

  controlWorkflow: async (sessionId, workflowRunId, action, child) => {
    const result = await bridge<{ status: string }>("workflowControl", { sessionId, workflowRunId, action, ...(child ? { childId: child.childId, attempt: child.attempt } : {}) });
    if (result.status !== "accepted") throw new Error("The host did not accept that control.");
  },

  controlGoal: async (sessionId, action, objective) => {
    const result = await bridge<{ status: string; turnId?: string }>("goalControl", { sessionId, action, ...(objective !== undefined ? { objective } : {}) });
    if (result.status !== "accepted") throw new Error("The host did not accept that control.");
    return { ...(result.turnId ? { turnId: result.turnId } : {}) };
  },

  childSession: null,

  openChild: async (sessionId, itemId) => {
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    const item = thread?.items.find((entry) => entry.itemId === itemId);
    if (!thread || !item || item.kind !== "subagent" || !item.childSessionId) return;
    const title = item.objective || "Subagent";
    // A harness child has no subagent lifecycle, so its result needs no
    // consuming gesture; an ACP child's result does.
    const consumable = Boolean(item.subagentId);
    set({ childSession: { sessionId, itemId, title, loading: true, error: null, result: item.result ?? null, items: [], consumed: false, consumable } });
    try {
      const snapshot = thread.agentId === "harness"
        ? await bridge<SessionPreview>("readChildSession", { agentId: "harness", sessionId, childSessionId: item.childSessionId, excludeItems: false })
        : await bridge<SessionPreview>("readSession", { sessionId: item.childSessionId, excludeItems: false });
      if (get().childSession?.itemId !== itemId) return;
      set({ childSession: { sessionId, itemId, title, loading: false, error: null, result: item.result ?? null, items: snapshot?.history?.items ?? [], consumed: false, consumable } });
    } catch (error) {
      if (get().childSession?.itemId !== itemId) return;
      set({ childSession: { sessionId, itemId, title, loading: false, error: describeError("Could not read the child transcript", error), result: item.result ?? null, items: [], consumed: false, consumable } });
    }
  },

  consumeChild: async () => {
    const viewing = get().childSession;
    const thread = get().threads.find((item) => item.sessionId === viewing?.sessionId);
    const subagentId = thread?.items.find((entry) => entry.itemId === viewing?.itemId)?.subagentId;
    if (!viewing || !subagentId) return;
    await get().controlSubagent(viewing.sessionId, subagentId, "readResult");
    if (get().childSession?.itemId === viewing.itemId) set({ childSession: { ...viewing, consumed: true } });
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
  initDialog: null,

  openInitDialog: async (workspaceId) => {
    const workspace = get().workspaces.find((item) => item.id === workspaceId);
    if (!workspace || !workspace.grantId) return;
    set({ initDialog: { workspaceId, loading: true, error: null, preview: null, conflict: false, done: false } });
    try {
      const preview = await projectInit(workspace.grantId, get().museBin || get().detection?.path || undefined, true, false);
      if (get().initDialog?.workspaceId !== workspaceId) return;
      set({ initDialog: { workspaceId, loading: false, error: null, preview, conflict: false, done: false } });
    } catch (error) {
      if (get().initDialog?.workspaceId !== workspaceId) return;
      set({ initDialog: { workspaceId, loading: false, error: describeError("Could not preview the agent config", error), preview: null, conflict: false, done: false } });
    }
  },

  closeInitDialog: () => set({ initDialog: null }),

  runInit: async (force) => {
    const dialog = get().initDialog;
    if (!dialog || !dialog.preview || dialog.loading || dialog.done) return;
    const workspace = get().workspaces.find((item) => item.id === dialog.workspaceId);
    if (!workspace?.grantId) return;
    set({ initDialog: { ...dialog, loading: true, error: null } });
    try {
      // The CLI reports conflicts on stdout with exit 0, so the conflict
      // is parsed from the message rather than the status.
      const output = await projectInit(workspace.grantId, get().museBin || get().detection?.path || undefined, false, force);
      if (get().initDialog?.workspaceId !== dialog.workspaceId) return;
      if (/already exists/i.test(output)) {
        set({ initDialog: { ...dialog, loading: false, error: null, conflict: true } });
      } else {
        set({ initDialog: { ...dialog, loading: false, error: null, conflict: false, done: true } });
      }
    } catch (error) {
      if (get().initDialog?.workspaceId !== dialog.workspaceId) return;
      set({ initDialog: { ...dialog, loading: false, error: describeError("Project setup failed", error) } });
    }
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
      const preview = await trustPreview(workspace.grantId, get().museBin || get().detection?.path || undefined);
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
      const preview = await trustPreview(workspace.grantId, get().museBin || get().detection?.path || undefined);
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
    set({ dockOpen: true, dockTab: "files", inspectorTab: "files" });
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
      set({ suggestions: { workspaceId: workspace.id, signature: "preview", items: preview, at: Date.now(), agentId: "muse" } });
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

    const ready = readyAgents(state);
    const agentId = state.suggestionsAgentId && ready.some((agent) => agent.id === state.suggestionsAgentId) ? state.suggestionsAgentId : preferredAgent(state);
    if (!ready.some((agent) => agent.id === agentId)) return;

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
          ...(agentId === "muse" ? {
            museBin: get().museBin || get().detection?.path || undefined,
            museApiKey: get().museApiKey.trim() || undefined,
            museAuthMode: get().museAuthMode,
            contributorMode: get().contributorMode,
          } : {}),
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
    if (!id || !thread || !supportsSkills(thread.agentId) || get().preview) return;
    try {
      const catalog = await bridge<{ skills?: SkillRow[] }>("listSkills", { sessionId: id, agentId: thread.agentId });
      set({ threads: get().threads.map((item) => item.sessionId === id ? { ...item, skills: catalog.skills ?? [] } : item) });
    } catch (error) {
      log.warn("skills.refresh.failed", { error: message(error) });
    }
  },

  refreshMcpServers: async () => {
    if (get().mcpLoading) return;
    set({ mcpLoading: true, mcpError: null });
    try {
      const catalog = await bridge<{ servers?: McpServer[] }>("mcpServers", {});
      set({ mcpServers: catalog.servers ?? [] });
    } catch (error) {
      set({ mcpError: describeError("Could not load MCP servers", error) });
    } finally {
      set({ mcpLoading: false });
    }
  },

  refreshHarnessMcp: async (sessionId, refresh = false) => {
    if (get().harnessMcpLoading) return;
    set({ harnessMcpLoading: true, harnessMcpError: null });
    try {
      const status = await bridge<HarnessMcpStatus>("harnessMcp", { sessionId, agentId: "harness", ...(refresh ? { refresh: true } : {}) });
      set({ harnessMcp: { servers: status.servers ?? [], error: status.error ?? null } });
    } catch (error) {
      set({ harnessMcpError: describeError("Could not load the Harness MCP servers", error) });
    } finally {
      set({ harnessMcpLoading: false });
    }
  },

  refreshHarnessMcpConfig: async (sessionId) => {
    if (get().harnessMcpConfigLoading) return;
    set({ harnessMcpConfigLoading: true, harnessMcpConfigError: null });
    try {
      const config = await bridge<HarnessMcpConfig>("harnessMcpConfig", { sessionId, agentId: "harness" });
      set({ harnessMcpConfig: { servers: config.servers ?? [], error: config.error ?? null } });
    } catch (error) {
      set({ harnessMcpConfigError: describeError("Could not load the Harness MCP configuration", error) });
    } finally {
      set({ harnessMcpConfigLoading: false });
    }
  },

  addHarnessMcpServer: async (sessionId, scope, server) => {
    const config = await bridge<HarnessMcpConfig>("harnessMcpAddServer", { sessionId, agentId: "harness", scope, server });
    set({ harnessMcpConfig: { servers: config.servers ?? [], error: config.error ?? null }, harnessMcpConfigError: null });
    await get().refreshHarnessMcp(sessionId, true);
  },

  removeHarnessMcpServer: async (sessionId, scope, name) => {
    const config = await bridge<HarnessMcpConfig>("harnessMcpRemoveServer", { sessionId, agentId: "harness", scope, name });
    set({ harnessMcpConfig: { servers: config.servers ?? [], error: config.error ?? null }, harnessMcpConfigError: null });
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
    if (sessionId && thread?.agentId === "harness") {
      await get().refreshSkills(sessionId);
      await get().refreshHarnessMcp(sessionId, true);
    }
    return result;
  },

  removeCatalogEntry: async (id, sessionId) => {
    const result = await catalogRemove(id, currentWorkspace(get())?.grantId ?? undefined);
    await get().refreshCatalog();
    const thread = sessionId ? get().threads.find((item) => item.sessionId === sessionId) : undefined;
    if (sessionId && thread?.agentId === "harness") {
      await get().refreshSkills(sessionId);
      await get().refreshHarnessMcp(sessionId, true);
    }
    return result;
  },

  refreshPlugins: async (available = false) => {
    if (get().pluginsLoading) return;
    set({ pluginsLoading: true, pluginsError: null, pluginsAvailableShown: available });
    try {
      set({ pluginEntries: await pluginList(get().museBin || undefined, available) });
    } catch (error) {
      set({ pluginsError: describeError("Could not load plugins", error) });
    } finally {
      set({ pluginsLoading: false });
    }
  },

  refreshManagedSkills: async () => {
    if (get().skillsLoading) return;
    set({ skillsLoading: true, skillsError: null });
    try {
      set({ skillEntries: await skillList(currentWorkspace(get())?.grantId ?? undefined, get().museBin || undefined) });
    } catch (error) {
      set({ skillsError: describeError("Could not load the managed skills", error) });
    } finally {
      set({ skillsLoading: false });
    }
  },

  installSkill: async () => {
    if (get().skillsLoading) return;
    set({ skillsLoading: true, skillsError: null });
    try {
      const picked = await pickSkillSource();
      if (!picked) return;
      await skillInstall(picked, get().museBin || undefined);
      set({ skillEntries: await skillList(currentWorkspace(get())?.grantId ?? undefined, get().museBin || undefined) });
    } catch (error) {
      set({ skillsError: describeError("Could not install the skill", error) });
    } finally {
      set({ skillsLoading: false });
    }
  },

  importSkills: async (from, dryRun) => {
    const output = await skillImport(from, dryRun, get().museBin || undefined);
    if (!dryRun) await get().refreshManagedSkills();
    return output;
  },

  uninstallSkill: async (id) => {
    if (get().skillsLoading) return;
    set({ skillsLoading: true, skillsError: null });
    try {
      await skillUninstall(id, get().museBin || undefined);
      set({ skillEntries: await skillList(currentWorkspace(get())?.grantId ?? undefined, get().museBin || undefined) });
    } catch (error) {
      set({ skillsError: describeError("Could not remove the skill", error) });
    } finally {
      set({ skillsLoading: false });
    }
  },

  installPlugin: async () => {
    if (get().pluginsLoading) return;
    set({ pluginsLoading: true, pluginsError: null });
    try {
      const picked = await pickPluginBundle();
      if (!picked) return;
      await pluginInstall(picked, get().museBin || undefined);
      set({ pluginEntries: await pluginList(get().museBin || undefined, false), pluginsAvailableShown: false });
    } catch (error) {
      set({ pluginsError: describeError("Could not install the plugin", error) });
    } finally {
      set({ pluginsLoading: false });
    }
  },

  refreshEnterprise: async () => {
    if (get().enterpriseLoading) return;
    set({ enterpriseLoading: true, enterpriseError: null });
    try {
      set({ enterprise: await enterpriseStatus(get().museBin || undefined) });
    } catch (error) {
      set({ enterpriseError: describeError("Could not read the managed configuration", error) });
    } finally {
      set({ enterpriseLoading: false });
    }
  },

  openLastThread: async () => {
    const state = get();
    const pool = state.showAllWorkspaces ? state.threads : state.threads.filter((thread) => thread.workspacePath === currentWorkspace(state)?.path);
    const last = pool.filter((thread) => !thread.archived).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    if (last) await get().selectThread(last.sessionId);
  },

  loadOlderHistory: async () => {
    const thread = currentThread(get());
    if (!thread || thread.agentId || thread.historyLoading || thread.historyExhausted || !thread.historyCursor || get().preview) return;
    const sessionId = thread.sessionId;
    const cursor = thread.historyCursor;
    const update = (patch: Partial<Thread>) => set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, ...patch } : item) });
    update({ historyLoading: true });
    try {
      const chunk = await bridge<{ items: TranscriptItem[]; nextCursor: string | null; exhausted: boolean }>("pageHistory", { sessionId, cursor });
      const latest = get().threads.find((item) => item.sessionId === sessionId);
      if (!latest || latest.historyCursor !== cursor) return;
      update({ items: mergeHistoryItems(latest.items, chunk.items), historyCursor: chunk.nextCursor, historyExhausted: chunk.exhausted });
    } catch (error) {
      update({ error: describeError("Could not load older history", error) });
    } finally {
      update({ historyLoading: false });
    }
  },

  rebuildThread: async () => {
    const thread = currentThread(get());
    if (!thread || thread.agentId || thread.opening || get().preview) return;
    const sessionId = thread.sessionId;
    const update = (patch: Partial<Thread>) => set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, ...patch } : item) });
    update({ opening: true, error: null, historyFailed: false });
    try {
      // The live stream never detached, so the rebuild is a backfill: the
      // newest chunk replays the durable log and the merge keeps held items
      // winning, so only the missing ones land.
      const chunk = await bridge<{ items: TranscriptItem[]; nextCursor: string | null; exhausted: boolean }>("pageHistory", { sessionId });
      const latest = get().threads.find((item) => item.sessionId === sessionId);
      if (latest) update({ items: mergeHistoryItems(latest.items, chunk.items), historyCursor: chunk.nextCursor, historyExhausted: chunk.exhausted, viewGap: null, status: "idle" });
    } catch (error) {
      update({ error: describeError("Could not rebuild the thread", error) });
    } finally {
      update({ opening: false });
    }
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
  setTerminalOpen: (open) => set({ terminalOpen: open }),
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
    set({ ...switchDraft(get(), workspace.id, sessionId), error: null, review: null, reviewError: null, reviewLoading: null, ...(workspaceChanged || get().reviewScope === "lastTurn" ? { diffTabs: null, diffActive: null } : {}), ...(workspaceChanged ? { git: null, gitError: null, reviewBase: "" } : {}), threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, unread: false } : item) });
    scheduleMemory(get);
    if (workspaceChanged) void get().refreshGit();
    else rescope(get, set, scope);
    if (get().preview || thread.opening) return;
    if (thread.opened) {
      void get().refreshTurnSnapshots(sessionId);
      // An open thread on another agent needs that agent's catalog; nothing else asks for it.
      if (get().modelsAgentId !== activeAgentId(get())) void get().refreshModels();
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
    if (thread.agentId) {
      try {
        const opened = await bridge<{ agentConfig?: AgentSessionConfig; alreadyOpen?: boolean }>("resumeSession", { agentId: thread.agentId, sessionId });
        // A reopened thread keeps the permission mode it was left in, on any agent.
        if (thread.config?.approvalMode) await bridge("setApprovalMode", { agentId: thread.agentId, sessionId, mode: approvalModeForAgent(thread.agentId, thread.config.approvalMode) }).catch(() => {});
        void get().refreshTurnSnapshots(sessionId);
        update({ opened: true, config: { ...thread.config, ...agentConfigPatch(opened.agentConfig), agentId: thread.agentId }, modes: opened.agentConfig?.modes ?? thread.modes });
        // The picker keeps showing the last catalog meanwhile; opening does not wait on it.
        if (get().selectedSessionId === sessionId) void get().refreshModels();
      } catch (error) {
        update({ error: describeError("Could not open the thread", error), opened: false });
      } finally { update({ opening: false }); }
      return;
    }
    try {
      await get().startHost();
      const resume = (cursor?: string | null) => bridge<SessionOpening & { facts?: { plan?: PlanItem[]; goal?: GoalState | null; context?: ContextUsage | null; usage?: TokenUsage | null; branch?: string | null }; historyCursor?: string | null; historyExhausted?: boolean; historyFailed?: boolean; viewCursor?: string }>("resumeSession", { sessionId, ...(cursor ? { cursor } : {}) });
      let opened: Awaited<ReturnType<typeof resume>>;
      try {
        opened = await resume(get().threads.find((item) => item.sessionId === sessionId)?.resumeCursor);
      } catch (error) {
        // All-workspace rows bind to no grant; a grant-scoped listing binds
        // this one, then the open retries exactly once.
        if (!/not connected to an open workspace/.test(message(error))) throw error;
        await listWorkspaceSessions(home, undefined, 10, (all) => all.some((session) => session.sessionId === sessionId));
        opened = await resume();
      }
      const session = opened.opening?.result.session;
      const latest = get().threads.find((item) => item.sessionId === sessionId);
      const unchanged = latest?.status === thread.status && latest?.activeTurnId === thread.activeTurnId && latest?.lastTurnId === thread.lastTurnId;
      if (latest?.userInputVersion === thread.userInputVersion) update({ userInputs: opened.userInputs ?? [] });
      update({
        opened: true,
        ...(opened.viewCursor ? { resumeCursor: opened.viewCursor } : {}),
        ...(opened.facts ? { plan: opened.facts.plan, goal: opened.facts.goal, context: opened.facts.context, usage: opened.facts.usage, hostBranch: opened.facts.branch } : {}),
        ...(session && !opened.alreadyOpen ? { config: metadataConfig(session, thread.config?.effort ?? get().defaultEffort), ...(unchanged ? { status: session.status === "running" ? "running" : session.status === "idle" ? "idle" : latest.status, activeTurnId: session.activeTurnId ?? null, lastOutcome: session.status === "running" ? latest?.lastOutcome : latest?.lastOutcome === "interrupted" ? undefined : latest?.lastOutcome } : {}) } : {}),
        ...(!opened.alreadyOpen ? { historyCursor: opened.historyCursor ?? null, historyExhausted: opened.historyExhausted ?? true, historyFailed: opened.historyFailed ?? false, viewGap: null } : {}),
      });
      if (get().selectedSessionId === sessionId) void get().refreshModels();
      void get().refreshSkills(sessionId).catch(() => {});
      void get().refreshTurnSnapshots(sessionId);
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
      if (get().modelsAgentId !== activeAgentId(get())) void get().refreshModels();
      rescope(get, set, scope);
    }
    set({ restoringSession: null, composerFocus: get().composerFocus + 1 });
  },

  selectNextAttentionThread: async () => {
    const state = get();
    const rank = new Map(state.workspaces.map((workspace, index) => [workspace.path, index]));
    const ordered = state.threads
      .filter((thread) => !thread.archived && rank.has(thread.workspacePath) && agentEnabled(state, thread.agentId ?? "muse"))
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
    const agentId = (config.agentId && agentEnabled(get(), config.agentId) ? config.agentId : undefined) ?? preferredAgent(get());
    const approvalMode = approvalModeForAgent(agentId, config.approvalMode);
    try {
      let thread: Thread;
      const existingCount = get().threads.filter((t) => t.workspacePath === workspace.path && /^(New thread|Untitled thread)/.test(t.title)).length;
      const title = existingCount === 0 ? "New thread" : `New thread ${existingCount + 1}`;
      if (agentId !== "muse" && get().preview) {
        const modes = agentId === "opencode" ? OPENCODE_MODES : agentId === "harness" ? HARNESS_MODES : undefined;
        thread = { sessionId: `preview-${uid()}`, agentId, workspacePath: workspace.path, title, order: Date.now(), updatedAt: new Date().toISOString(), status: "idle", unread: false, items: [], opened: true, config: { ...config, agentId, ...(modes ? { mode: "build" } : {}) }, modes };
      } else if (agentId !== "muse") {
        // Only hand over a model the agent itself listed; a Muse default means nothing to OpenCode.
        // Gated OpenCode `*-free` rows fail on this account — let the bridge pick a usable default.
        const ownModel = get().modelsAgentId === agentId && get().models.some((model) => model.modelId === config.modelId);
        const gated = agentId === "opencode" && /(?:^|[/:])[^/]*-free$/i.test(config.modelId ?? "");
        const mode = config.mode ?? get().agentModes[agentId]?.defaultMode;
        const opened = await bridge<{ sessionId: string; agentConfig?: AgentSessionConfig }>("startSession", { agentId, grantId: workspace.grantId ?? undefined, modelId: ownModel && !gated ? config.modelId : undefined, reasoningEffort: config.effort, ...(mode ? { mode } : {}), ...(approvalMode ? { approvalMode } : {}) });
        thread = { sessionId: opened.sessionId, agentId, workspacePath: workspace.path, title, order: Date.now(), updatedAt: new Date().toISOString(), status: "idle", unread: false, items: [], opened: true, config: { ...config, ...agentConfigPatch(opened.agentConfig), ...(approvalMode ? { approvalMode } : {}), agentId }, modes: opened.agentConfig?.modes };
      } else {
        if (!get().preview) await get().startHost();
        // The worktree exists before the session does, so the CLI starts in it.
        // A session that then fails to start takes its empty worktree with it.
        const wanted = fromProject ? get().drafts[sourceKey]?.worktree : undefined;
        const made = !wanted ? undefined : get().preview ? mockWorktree(wanted.base) : await gitWorktreeCreate(workspace.grantId ?? "preview", wanted.base);
        const worktree: ThreadWorktree | undefined = made && { grantId: made.grantId, path: made.path, branch: made.branch, base: made.base, workspaceId: workspace.id };
        let opened: { sessionId: string } | SessionOpening;
        try {
          opened = get().preview ? { sessionId: `preview-${uid()}` } : await bridge<SessionOpening>("startSession", { grantId: worktree?.grantId ?? workspace.grantId ?? undefined, approvalMode, modelId: config.modelId || undefined, providerId: config.providerId || undefined });
        } catch (error) {
          if (worktree && !get().preview) await gitWorktreeRemove(worktree.grantId).catch(() => {});
          throw error;
        }
        const metadata = "opening" in opened ? opened.opening?.result.session : undefined;
        thread = { sessionId: opened.sessionId, workspacePath: workspace.path, worktree, title, order: Date.now(), updatedAt: new Date().toISOString(), status: "idle", unread: false, items: [], opened: true, config: metadata ? metadataConfig(metadata, config.effort) : { ...config, approvalMode }, ...(made?.warning ? { notice: { level: "warning" as const, message: made.warning } } : {}) };
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

  switchThreadAgent: async (agentId) => {
    const state = get();
    if (state.starting || state.submitting) return;
    if (!agentEnabled(state, agentId)) return;
    const thread = currentThread(state);
    if (thread && (thread.status === "running" || thread.configPending || thread.opening || thread.snapshotPending || thread.rewindPending)) return;
    // `commitSettings` reports its own write failures through the error banner,
    // so a rejected save cannot silently skip the switch it was meant to persist.
    await get().commitSettings({ defaultAgentId: agentId });
    if (!thread) {
      await get().setSessionConfig({ agentId });
      return;
    }
    if ((thread.agentId ?? "muse") === agentId) return;
    const workspace = activeWorkspace(get());
    if (!workspace) return;
    const previousId = thread.sessionId;
    const previousName = state.agents.find((agent) => agent.id === (thread.agentId ?? "muse"))?.name ?? thread.agentId ?? "Muse";
    const nextName = state.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
    const approvalMode = approvalModeForAgent("muse", thread.config?.approvalMode);
    set({ starting: true, error: null });
    try {
      let next: Thread;
      if (agentId !== "muse" && get().preview) {
        const modes = agentId === "opencode" ? OPENCODE_MODES : undefined;
        next = { ...thread, agentId, opened: true, modes, config: { agentId, ...(modes ? { mode: "build" } : {}) }, error: null, notice: null, status: "idle", configPending: false, pendingConfig: undefined, configNotice: `Now using ${nextName}` };
      } else if (agentId !== "muse") {
        const opened = await bridge<{ sessionId: string; agentConfig?: AgentSessionConfig }>("startSession", { agentId, grantId: workspace.grantId ?? undefined });
        next = {
          ...thread,
          sessionId: opened.sessionId,
          agentId,
          opened: true,
          opening: false,
          config: { ...agentConfigPatch(opened.agentConfig), agentId },
          modes: opened.agentConfig?.modes,
          error: null,
          notice: null,
          status: "idle",
          configPending: false,
          pendingConfig: undefined,
          configNotice: `Now using ${nextName}`,
        };
      } else if (get().preview) {
        next = { ...thread, agentId: undefined, modes: undefined, config: { approvalMode, effort: thread.config?.effort }, error: null, notice: null, status: "idle", opened: true, configPending: false, pendingConfig: undefined, configNotice: `Now using ${nextName}` };
      } else {
        await get().startHost();
        const opened = await bridge<SessionOpening>("startSession", { grantId: workspace.grantId ?? undefined, approvalMode });
        next = {
          ...thread,
          sessionId: opened.sessionId,
          agentId: undefined,
          opened: true,
          opening: false,
          config: { approvalMode },
          modes: undefined,
          error: null,
          notice: null,
          status: "idle",
          configPending: false,
          pendingConfig: undefined,
          configNotice: `Now using ${nextName}`,
        };
      }
      if (thread.items.length) {
        next = { ...next, notice: { level: "info", message: `Switched to ${nextName}. Earlier messages stay visible; ${nextName} does not have the ${previousName} history.` } };
      }
      // Saved file states belong to the original native session, even when
      // its messages remain visible after switching agents.
      next = { ...next, snapshots: undefined, snapshotPending: undefined, snapshotError: undefined, rewindPending: undefined, rewindError: undefined, rewindAttempt: undefined };
      set(rekeyThreadState(get(), previousId, next));
      if (next.configNotice) scheduleConfigNoticeClear(next.sessionId, next.configNotice);
      scheduleMemory(get);
      await get().refreshModels();
    } catch (error) {
      set({ error: sentenceAfter(describeError(`Could not switch to ${nextName}`, error), `This thread is still on ${previousName}.`) });
    } finally {
      set({ starting: false });
    }
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
    if (initial.starting || initial.submitting || active?.opening || active?.configPending || active?.snapshotPending || active?.rewindPending) return;
    // Busy sends are Muse and Harness. ACP agents and preview keep the Stop-to-send lock.
    const busySend = active?.status === "running" && acceptsBusySend(active.agentId) && !initial.preview;
    if (active?.status === "running" && !busySend) return;
    if (!currentWorkspace(initial)) { set({ error: "Open a workspace before sending." }); return; }
    const text = initial.composer.trim();
    const images = initial.images;
    const refs = initial.contextRefs;
    if (!text && !images.length && !refs.length) return;
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
    const held = !busySend && !parseShellEscape(text) ? { text: initial.composer, images, refs } : null;
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
      if (!sessionId) return;
      const thread = get().threads.find((item) => item.sessionId === sessionId);
      if (!thread?.opened && !get().preview) throw new Error("Thread is not open. Select it again to reconnect before sending.");
      // A leading `!command` is the TUI shell escape: it runs in the session's
      // workspace via `session/userShell` and streams back as a `userShell`
      // transcript item. Shells are not turn-scoped, so the escape bypasses
      // the busy queue, skills, and optimistic turn state entirely.
      const shell = parseShellEscape(text);
      if (shell) {
        if (thread?.agentId) throw new Error(`Shell escape is a Muse feature; this thread runs on ${thread.agentId}.`);
        if (images.length || refs.length) throw new Error("Shell escape cannot carry images or references. Remove them, or send as a prompt.");
        if (!get().preview && !(get().hostInfo?.compat?.granted ?? []).includes("userShell")) {
          throw new Error("User shells are unavailable: the host did not grant the userShell capability. Reconnect from Settings.");
        }
        await bridge("userShell", { sessionId, commandText: shell.command });
        recordPrompt(initial.selectedWorkspaceId, text);
        const live = get();
        const shellKey = `thread:${sessionId}`;
        if (live.selectedSessionId === sessionId && live.composer.trim() === text) {
          set({ composer: "", images: [], contextRefs: [], drafts: { ...live.drafts, [shellKey]: { ...live.drafts[shellKey], text: "", images: [], refs: [] } } });
        }
        return;
      }
      // A leading `/selector` invokes a session skill for real: the typed
      // spelling matches the catalog verbatim (unknown stays plain text),
      // and the invocation travels as a structured skill part.
      const invocation = parseSkillInvocation(text);
      const skill = thread && supportsSkills(thread.agentId) && invocation
        ? (thread.skills ?? []).find((row) => row.selector.replace(/^\//, "").toLowerCase() === invocation.selector.replace(/^\//, "").toLowerCase())
        : undefined;
      const skillPart = skill ? { selector: skill.selector, ...(invocation!.args ? { arguments: invocation!.args } : {}) } : undefined;
      if (busySend && thread) {
        await sendBusyTurn(sessionId, options?.disposition ?? "queue", skillPart ? composePrompt("", refs) : payload, text, images, skillPart);
        return;
      }
      const previousOutcome = thread?.lastOutcome;
      // Idempotency keys are a Muse/MSP feature (ACP agents reject overlapping sends themselves).
      const keyed = !thread?.agentId;
      // A retry of a send whose result was unknown reuses its key AND its optimistic bubble
      // (matched by text, so a reworded prompt still sends fresh instead of dropping words).
      const keptOptimistic = keyed && thread?.pendingTurnKey
        ? [...(thread?.items ?? [])].reverse().find((item) => item.kind === "userMessage" && item.optimistic && item.text === (text || payload))
        : undefined;
      const turnKey = keptOptimistic && thread?.pendingTurnKey ? thread.pendingTurnKey : uid();
      const userItem: TranscriptItem = keptOptimistic ?? { itemId: uid(), kind: "userMessage", status: "completed", text: text || payload, images, refs, optimistic: !get().preview, ...(get().preview ? { turnId: `preview-turn-${uid()}` } : {}) };
      set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...applyItem(item, userItem), status: "running", error: null, activeTurnId: get().preview ? userItem.turnId : null, cancelRequested: false, activity: "working", lastOutcome: undefined, turnStartedAt: Date.now(), turnStartOutput: item.usage?.outputTokens ?? 0, turnStartPrompt: item.usage?.promptTokens ?? 0, turnStartCache: cacheTokens(item.usage), turnStats: undefined, turnCalls: [], ...(options?.resetTaskState ? { plan: undefined, planAnchor: undefined, goal: null } : {}) } : item) });
      try {
        if (get().preview) {
          const id = sessionId;
          previewTimers.set(id, window.setTimeout(() => {
            previewTimers.delete(id);
            set({ threads: get().threads.map((item) => item.sessionId === id && item.status === "running" ? { ...applyItem(item, { itemId: uid(), kind: "agentMessage", status: "completed", turnId: userItem.turnId, text: "Preview response — connect the Muse CLI to work in a real workspace." }), status: "idle", lastTurnId: userItem.turnId, lastOutcome: "completed", activeTurnId: null, unread: get().selectedSessionId !== id, activity: undefined } : item) });
          }, 1600));
        } else {
          const result = await bridge<{ turnId: string; deduped?: boolean }>("sendTurn", { agentId: thread?.agentId, sessionId, text: skillPart ? composePrompt("", refs) : payload, reasoningEffort: thread?.config?.effort ?? (thread?.agentId ? undefined : initial.defaultEffort), images: images.map(({ mediaType, base64Data }) => ({ mediaType, base64Data })), ...(keyed ? { clientTurnId: turnKey } : {}), ...(skillPart ? { skill: skillPart } : {}) });
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
        if (keyed && timeoutUnknown(error)) {
          // The message is on screen as a pending bubble that Retry resends.
          delivered = true;
          // The turn may have started without the acknowledgement reaching us: stay running so
          // its streamed events still land, keep the key so a later retry dedupes, and let Stop work.
          set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, pendingTurnKey: turnKey, notice: { level: "warning", message: "No acknowledgement yet — the turn may still be running. Stop, then retry safely." } } : item) });
        } else {
          // The classified reason (host detail + recovery) belongs on screen —
          // the title alone used to answer "what happened" with "Send failed".
          set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, items: item.items.filter((entry) => entry.itemId !== userItem.itemId), status: "error", activeTurnId: null, pendingTurnKey: null, cancelRequested: false, activity: undefined, error: describeError("Send failed", error), lastOutcome: previousOutcome } : item) });
          // The catalog moved under us: refresh it so the next pick is real.
          if ((error as Error & { code?: string })?.code === "skillNotFound") void get().refreshSkills(sessionId).catch(() => {});
        }
      }
    } catch (error) { set({ error: describeError("Send failed", error) }); }
    finally { putBack(); set({ submitting: false }); }
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
      if (queued.length && acceptsBusySend(thread.agentId)) {
        await Promise.allSettled(queued.map((entry) => bridge("unqueueTurn", { sessionId: thread.sessionId, turnId: entry.turnId, agentId: thread.agentId })));
        set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, queuedTurns: [] } : item) });
      }
      await cancelSession(thread.sessionId, thread.activeTurnId ?? undefined);
      // If the stop never reached the host (cancel delivery failed, no terminal event coming),
      // don't strand the thread: park it idle with the key retained so the next send dedupes.
      const stuck = get().threads.find((item) => item.sessionId === thread.sessionId);
      if (stuck?.status === "running" && !stuck.cancelRequested) {
        const parked = stuck.pendingTurnKey
          ? "Stop may not have reached Muse. Retry is safe — it resumes the pending turn."
          : "Stop may not have reached Muse. Check the thread before retrying.";
        set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, status: "idle", activity: undefined, error: parked, notice: null } : item) });
      }
    }
  },

  unqueueTurn: async (turnId) => {
    const thread = currentThread(get());
    if (!thread || !acceptsBusySend(thread.agentId) || get().preview) return;
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
    if (get().preview) { set({ git: MOCK_GIT, gitError: null, gitLoading: false }); return; }
    const version = ++gitVersion;
    const workspace = activeWorkspace(get());
    if (!workspace) { set({ git: null, gitError: null, gitLoading: false }); return; }
    if (!workspace.grantId && isTauri()) { set({ git: null, gitError: UNGRANTED_ERROR, gitLoading: false }); return; }
    const grantId = workspace.grantId ?? null;
    // A read applies only while the workspace, grant and request version are
    // all still current — a grant re-issue or a newer call owns the answer.
    const owns = () => version === gitVersion
      && get().selectedWorkspaceId === workspace.id
      && (activeWorkspace(get())?.grantId ?? null) === grantId;
    set({ gitLoading: true, gitError: null });
    try {
      const git = await gitSnapshot(grantId ?? "preview");
      if (owns()) set({ git });
    } catch (error) {
      if (owns()) set({ git: null, gitError: describeError("Could not load the changes", error) });
    } finally {
      if (owns()) set({ gitLoading: false });
      // An edit completed while this read was in flight: the snapshot it just
      // missed is owed another look once the debounce settles.
      firePendingGitRefresh();
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

  commitGit: async (message) => {
    const state = get();
    const workspace = activeWorkspace(state);
    if (state.preview && state.git) {
      const files = state.git.files.filter((file) => file.status[0] === " " || file.status[0] === "?");
      set({ git: { ...state.git, files, dirty: files.length > 0 } });
      return;
    }
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error(UNGRANTED_ERROR);
    await runGitMutation(workspace, selectionVersion, () => gitCommit(workspace.grantId ?? "preview", message));
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
    if (running && (!acceptsBusySend(thread?.agentId) || state.preview)) throw new Error("Stop the running turn first. This agent cannot take a message mid-turn.");
    if (state.submitting || state.starting) throw new Error("Another message is being sent. Try again in a moment.");
    // The comments travel through the normal send path, which reads the
    // composer. The user's own draft is set aside and put back afterwards.
    const text = composeLineComments(comments);
    const held = { composer: state.composer, images: state.images, contextRefs: state.contextRefs };
    const workspaceId = state.selectedWorkspaceId;
    set({ composer: text, images: [], contextRefs: [] });
    try { await get().sendPrompt(running ? { disposition: "steer" } : undefined); }
    finally {
      const sent = get().composer !== text;
      if (get().selectedWorkspaceId === workspaceId) set(held);
      if (sent) {
        const lineComments = { ...get().lineComments };
        delete lineComments[key];
        set({ lineComments });
        scheduleMemory(get);
      }
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
  draftCommitMessage: async () => {
    const thread = currentThread(get());
    if (!thread) throw new Error("Open a thread first. The agent drafts the message in the thread.");
    if (thread.status === "running" || get().submitting) throw new Error("Wait for the running turn to finish, then draft the message.");
    if (get().composer.trim() || get().images.length || get().contextRefs.length) throw new Error("Send or clear your draft in the composer first, so it is not replaced.");
    set({ composer: COMMIT_DRAFT_PROMPT, images: [], contextRefs: [], commitDrafting: thread.sessionId });
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
    if (!thread || thread.status === "running" || get().submitting) return;
    set({ composer: "Continue from the last interruption. Finish remaining work.", images: [], contextRefs: [] });
    await get().sendPrompt();
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
  setSettingsOpen: (open, tab) => {
    set({ settingsOpen: open, ...(tab ? { settingsTab: tab } : {}) });
    if (tab) scheduleMemory(get);
  },
  setDockOpen: (open) => { set({ dockOpen: open, ...(open ? {} : { dockExpanded: false }) }); scheduleMemory(get); },
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
      if (get().detection?.found && get().detection?.authenticated && currentWorkspace(get())) await get().startHost();
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
    // The last demo thread shows how a thread from another installed agent looks.
    const threads = mockThreads().map((thread, index, all) => index === all.length - 1 && all.length > 1
      ? { ...thread, agentId: "grok" as const, config: { agentId: "grok" as const, modelId: "grok-4.6", effort: "high" as const }, opened: true }
      : { ...thread, config: defaults(get()), opened: true });
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
 * Safety net for a missed turn end: while a Muse thread looks busy but has been quiet for a
 * while, ask the host whether its session is actually idle.
 */
let reconcileInFlight: Promise<void> | null = null;

export function reconcileRunningThreads(): Promise<void> {
  if (reconcileInFlight) return reconcileInFlight;
  const inFlight = (async () => {
    const state = useAppStore.getState();
    if (state.preview) return;
    const quiet = state.threads.filter((thread) => !thread.agentId && thread.status === "running" && !thread.opening && !thread.pendingApproval && !thread.queuedApprovals?.length && !thread.userInputs?.length && Date.now() - Date.parse(thread.updatedAt) > 20000);
    // Sessions are listed per folder, and a worktree thread lives in its own.
    const homes = new Map<string, { grantId?: string | null; wanted: Set<string> }>();
    for (const thread of quiet) {
      const home = threadScope(state, thread);
      const path = home?.path ?? thread.workspacePath;
      homes.set(path, { grantId: home?.grantId, wanted: (homes.get(path)?.wanted ?? new Set<string>()).add(thread.sessionId) });
    }
    for (const [path, { grantId, wanted }] of homes) {
      if (isTauri() && !grantId) continue;
      try {
        const { sessions } = await listWorkspaceSessions({ path, grantId }, undefined, 5, (all) => [...wanted].every((id) => all.some((session) => session.sessionId === id)));
        for (const session of sessions) {
          const thread = quiet.find((item) => item.sessionId === session.sessionId);
          if (thread && session.status === "idle" && !session.activeTurnId) settleEndedTurn(thread.sessionId, thread.activeTurnId);
        }
      } catch { /* host busy or restarting; the next pass retries */ }
    }
  })();
  const tracked = inFlight.finally(() => { reconcileInFlight = null; });
  reconcileInFlight = tracked;
  return tracked;
}

/** Muse and Harness have skills: a session catalog, and `/name` sent as a skill part. ACP agents do not. */
export function supportsSkills(agentId: string | undefined): boolean {
  return !agentId || agentId === "harness";
}

/** Muse and Harness accept a follow-up while a turn runs. ACP agents and preview do not. */
export function acceptsBusySend(agentId: string | undefined): boolean {
  return !agentId || agentId === "harness";
}

/**
 * Send while a turn runs (Muse and Harness). Queue parks the input for launch,
 * steer folds it into the running turn, replace interrupts and starts over.
 * Runs under sendPrompt's submitting guard; clears the draft on success.
 */
async function sendBusyTurn(sessionId: string, disposition: "queue" | "steer" | "replace", payload: string, text: string, images: ComposerImage[], skill?: { selector: string; arguments?: string }) {
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
  const before = { status: thread.status, activeTurnId: thread.activeTurnId, lastOutcome: thread.lastOutcome, turnStartedAt: thread.turnStartedAt, activity: thread.activity, turnStats: thread.turnStats };
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
      const userItem: TranscriptItem = keptOptimistic ?? { itemId: uid(), kind: "userMessage", status: "completed", text: text || payload, images, refs: state.contextRefs, optimistic: true };
      replaceItem = userItem;
      patch({ ...applyItem(thread, userItem), error: null, activeTurnId: null, cancelRequested: false, activity: "working", lastOutcome: undefined, turnStartedAt: Date.now(), turnStartOutput: thread.usage?.outputTokens ?? 0, turnStartPrompt: thread.usage?.promptTokens ?? 0, turnStartCache: cacheTokens(thread.usage), turnStats: undefined, turnCalls: [] });
    }
    const result = await bridge<{ turnId: string; disposition?: string; deduped?: boolean }>("sendTurn", { sessionId, agentId: thread.agentId, text: payload, reasoningEffort: thread.config?.effort ?? state.defaultEffort, images: images.map(({ mediaType, base64Data }) => ({ mediaType, base64Data })), clientTurnId: turnKey, ifBusy: disposition, ...(skill ? { skill } : {}) });
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
  // ACP and preview have no busy-send. Harness can steer a denial into the running turn.
  if ((!acceptsBusySend(thread.agentId) || state.preview) && thread.status === "running") return;
  const patch = (update: (current: Thread) => Thread) => useAppStore.setState((current) => ({ threads: current.threads.map((item) => item.sessionId === sessionId ? update(item) : item) }));
  patch((current) => ({ ...current, approvalFeedback: current.approvalFeedback?.map((entry) => entry.id === feedback.id ? { ...entry, state: "sending" } : entry) }));
  let started = false;
  let before: Partial<Thread> = {};
  try {
    let steered = false;
    if (acceptsBusySend(thread.agentId) && thread.status === "running" && !state.preview) {
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
      before = { status: live.status, activeTurnId: live.activeTurnId, lastOutcome: live.lastOutcome, activity: live.activity, turnStartedAt: live.turnStartedAt, turnStartOutput: live.turnStartOutput, turnStartPrompt: live.turnStartPrompt, turnStartCache: live.turnStartCache, turnStats: live.turnStats };
      if (started) patch((current) => ({ ...current, status: "running", activeTurnId: null, lastOutcome: undefined, activity: "working", turnStartedAt: Date.now(), turnStartOutput: current.usage?.outputTokens ?? 0, turnStartPrompt: current.usage?.promptTokens ?? 0, turnStartCache: cacheTokens(current.usage), turnStats: undefined, turnCalls: [] }));
      const result = await bridge<{ turnId: string; disposition?: string }>("sendTurn", {
        sessionId, agentId: live.agentId, text: feedback.text,
        ...(acceptsBusySend(live.agentId) ? { clientTurnId: feedback.id, ifBusy: "queue" as const } : {}),
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
  return Promise.all(threads.filter((thread) => thread.status === "running" && thread.activeTurnId).map((thread) => cancelSession(thread.sessionId, thread.activeTurnId ?? undefined)));
}

/**
 * Release sessions the app no longer needs. The bridge holds one per open thread and
 * nothing else ever drops it, so deleting threads would otherwise grow its session maps
 * for the process's lifetime. Reopening the thread resumes it again.
 */
function releaseThreadSessions(sessionIds: string[]) {
  for (const sessionId of sessionIds) void bridge("closeSession", { sessionId }).catch(() => {});
}

async function cancelSession(sessionId: string, turnId?: string) {
  try { await bridge("cancelTurn", { agentId: useAppStore.getState().threads.find((thread) => thread.sessionId === sessionId)?.agentId, sessionId, ...(turnId ? { turnId } : {}) }); }
  catch (error) {
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
        items = items.map((item, at) => at !== index ? item : {
          ...item,
          ...(delta.text ? { text: `${item.text ?? ""}${delta.text}` } : {}),
          ...(delta.output ? { visibleOutput: `${item.visibleOutput ?? ""}${delta.output}` } : {}),
        });
      }
      if (!touched) return state;
      return { threads: state.threads.map((item) => item.sessionId === sessionId ? { ...item, unread: selected !== sessionId, items } : item) };
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
      const payloadInfo = payload as BridgeEventPayloads["hostExit"] | undefined;
      const closed = event === "hostStopping" ? null : payloadInfo?.kind === "crash"
        ? `Muse exited unexpectedly${payloadInfo.exitCode != null ? ` (${payloadInfo.exitCode})` : ""}. Open Settings to reconnect; drafts are retained.`
        : "Muse connection closed. Open Settings to reconnect; drafts are retained.";
      modelCatalogs.delete("muse");
      useAppStore.setState({ error: closed, ...(event === "hostStopping" ? {} : { hostInfo: null }), ...(store.modelsAgentId === "muse" ? { models: [], modelsLoading: false } : {}), threads: store.threads.map((thread) => thread.agentId ? thread : abandonThread(thread)) });
      scheduleMemory(useAppStore.getState);
    }
    if (event === "agentExit") {
      const data = payload as BridgeEventPayloads["agentExit"];
      const name = store.agents.find((agent) => agent.id === data.agentId)?.name ?? data.agentId;
      useAppStore.setState({ threads: store.threads.map((thread) => thread.agentId !== data.agentId ? thread : abandonThread(thread, { notice: null, ...(thread.sessionId === store.selectedSessionId ? { error: `${name} stopped${data.error ? `: ${data.error}` : ""}. Select the thread again to reconnect.` } : {}) })) });
    }
    if (event === "agentNotice") {
      const data = payload as BridgeEventPayloads["agentNotice"];
      update(data.sessionId, (thread) => ({ ...thread, notice: data.message ? { level: data.level ?? "info", message: data.message } : null }));
    }
    if (event === "loginDone") {
      useAppStore.setState({ loginPrompt: null, loginError: null });
      void useAppStore.getState().refreshDetection();
    }
    if (event === "loginError") {
      const data = payload as BridgeEventPayloads["loginError"];
      useAppStore.setState({ loginPrompt: null, loginError: data?.error ?? "Sign-in failed." });
    }
    if (event === "sessionTitle") {
      const data = payload as BridgeEventPayloads["sessionTitle"];
      update(data.sessionId, (thread) => thread.customTitle ? thread : { ...thread, title: titleFromText(data.title) });
      scheduleMemory(useAppStore.getState);
    }
    if (event === "sessionName") {
      const data = payload as BridgeEventPayloads["sessionName"];
      // In-flight renames accept the host name (the deferred RecoveryPending
      // name would otherwise be dropped by the optimistic customTitle).
      update(data.sessionId, (thread) => thread.customTitle && !renameInflight.has(data.sessionId) ? thread : { ...thread, title: titleFromText(data.name) });
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
      update(data.sessionId, (thread) => ({ ...thread, config: { ...thread.config, approvalMode: data.mode } }));
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
      // listModels is a serialized bridge round-trip on ACP agents (~1s on
      // Grok). An effort echo changes nothing the catalog offers, so only a
      // model or mode move justifies the refresh.
      const shifted = (data.config.modelId !== undefined && data.config.modelId !== prior?.modelId) || (data.config.mode !== undefined && data.config.mode !== prior?.mode);
      if (store.selectedSessionId === data.sessionId && shifted) void useAppStore.getState().refreshModels();
    }
    if (event === "sessionFacts" || event === "usage") {
      const data = payload as BridgeEventPayloads["sessionFacts"];
      update(data.sessionId, (thread) => withLateUsage({ ...thread, plan: data.plan ?? thread.plan, planAnchor: data.plan ? planAnchorFor(thread, data.plan) : thread.planAnchor, goal: data.goal ?? thread.goal, context: data.context ?? thread.context, usage: data.usage ?? thread.usage, hostBranch: data.branch ?? thread.hostBranch }));
      // Usage reported after the turn ended replaces that turn's estimate in the ledger.
      if (data.usage) recordUsage(useAppStore.getState, useAppStore.setState, data.sessionId);
    }
    if (event === "modelCall") {
      const data = payload as BridgeEventPayloads["modelCall"];
      // The turn's own calls, gathered until it finishes and the ledger counts them.
      update(data.sessionId, (thread) => ({ ...thread, turnCalls: [...(thread.turnCalls ?? []), data.call] }));
    }
    if (event === "usageChanged") {
      const usage = asSubscriptionUsage(payload);
      if (usage) {
        useAppStore.setState({ subscriptionUsage: usage, subscriptionUsageAt: Date.now(), subscriptionUsageError: null });
        scheduleMemory(useAppStore.getState);
      }
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
    if (event === "turnError") {
      const data = payload as BridgeEventPayloads["turnError"];
      const stopped = data.code === "interrupted" || data.code === "cancelled";
      if (!stopped) maybeNotify(data.sessionId, "Turn failed");
      update(data.sessionId, (thread) => ({ ...thread, ...finishTurn(thread, data.turnId), status: stopped ? "idle" : "error", error: stopped ? null : data.error ?? "Turn stream failed", retry: null, activeTurnId: null, pendingTurnKey: null, plan: stopped ? settlePlan(thread.plan, "cancelled") : settlePlan(thread.plan, "failed"), items: stopped ? settleItems(thread.items, "cancelled", true) : settleItems(thread.items, "failed"), pendingApproval: null, queuedApprovals: [], userInputs: [], userInputPending: undefined, cancelRequested: false, activity: undefined, lastTurnId: data.turnId, ...(stopped ? { lastOutcome: "cancelled" as const } : {}) }));
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
        return { ...thread, status: "running", activeTurnId: data.turnId, cancelRequested: false, activity: "working", lastOutcome: undefined, turnStartedAt: Date.now(), turnStartOutput: thread.usage?.outputTokens ?? 0, turnStartPrompt: thread.usage?.promptTokens ?? 0, turnStartCache: cacheTokens(thread.usage), turnStats: undefined, turnCalls: [], queuedTurns: (thread.queuedTurns ?? []).filter((entry) => entry.turnId !== data.turnId), notice: null };
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
      const auth = !store.threads.find((thread) => thread.sessionId === data.sessionId)?.agentId && authRequired(data.outcome);
      const cancelled = terminal === "cancelled";
      const failed = !cancelled && (data.outcome.kind !== "completed" || terminal !== "completed");
      if (store.commitDrafting === data.sessionId) {
        const reply = cancelled || failed ? undefined : [...(store.threads.find((thread) => thread.sessionId === data.sessionId)?.items ?? [])].reverse().find((item) => item.kind === "agentMessage" && item.turnId === data.turnId)?.text;
        const text = commitSubjectFromReply(reply ?? "");
        useAppStore.setState({ commitDrafting: null, ...(text ? { commitDraft: { text, seq: (store.commitDraft?.seq ?? 0) + 1 } } : {}) });
      }
      if (!cancelled) maybeNotify(data.sessionId, failed || auth ? "Turn failed" : "Turn finished");
      update(data.sessionId, (thread) => thread.activeTurnId && thread.activeTurnId !== data.turnId ? { ...thread, items: settleTurnItems(thread.items, data.turnId, terminal), queuedTurns: (thread.queuedTurns ?? []).filter((entry) => entry.turnId !== data.turnId), ...(thread.retry?.turnId === data.turnId ? { retry: null } : {}), ...(data.viewCursor ? { resumeCursor: data.viewCursor } : {}) } : ({
        ...thread,
        ...finishTurn(thread, data.turnId),
        retry: null,
        ...(data.viewCursor ? { resumeCursor: data.viewCursor } : {}),
        status: failed || auth ? "error" : "idle",
        queuedTurns: (thread.queuedTurns ?? []).filter((entry) => entry.turnId !== data.turnId),
        error: auth ? "Muse needs a sign-in. Add an API key in Settings. The draft is kept." : failed ? data.outcome.params?.error?.message ?? data.outcome.params?.reason ?? `Turn ended: ${data.outcome.kind} (${terminal ?? "outcome unknown"})` : cancelled ? null : thread.error,
        lastOutcome: auth ? "failed" : cancelled ? "cancelled" : failed ? "failed" : "completed",
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
      if (!cancelled && !failed && !auth) void deliverApprovalFeedback(data.sessionId);
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
  set({ git: null, gitError: null, reviewBase: "", review: null, reviewError: null, reviewLoading: null, diffTabs: null, diffActive: null, fileView: null, branches: null, pullRequest: null });
  void get().refreshGit();
  get().refreshFileIndex();
}

/** The selected workspace's threads as the sidebar lists them: pinned first, then newest position first. */
function workspaceThreads(state: Pick<AppStore, "threads" | "workspaces" | "selectedWorkspaceId" | "enabledAgents">): Thread[] {
  const path = currentWorkspace(state)?.path;
  return state.threads
    .filter((thread) => thread.workspacePath === path && !thread.archived && agentEnabled(state, thread.agentId ?? "muse"))
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

/** Agents that can take work right now (Muse also needs its API key; disabled providers are skipped). */
export function readyAgents(state: Pick<AppStore, "agents" | "detection" | "enabledAgents">): AgentInfo[] {
  const agents = state.agents.length ? state.agents : state.detection ? [{ id: "muse", name: "Muse", protocol: "msp", found: state.detection.found, path: state.detection.path, version: state.detection.version, verified: true, signIn: "", authenticated: state.detection.authenticated } as AgentInfo] : [];
  // Muse needs its credential and the harness a provider key; ACP agents report sign-in on connect.
  return agents.filter((agent) => agent.found && agentEnabled(state, agent.id) && ((agent.id !== "muse" && agent.id !== "harness") || agent.authenticated));
}

/** The agent new threads use: the saved default when ready, else the built-in harness, else Muse, else the first ready agent. */
export function preferredAgent(state: Pick<AppStore, "agents" | "detection" | "enabledAgents" | "defaultAgentId">): AgentId {
  const ready = readyAgents(state);
  if (state.defaultAgentId && ready.some((agent) => agent.id === state.defaultAgentId)) return state.defaultAgentId;
  // With nothing ready yet (before detection, or with no key or CLI set up) the
  // app keeps addressing Muse, as every pre-detection path expects.
  return ready.find((agent) => agent.id === "harness")?.id ?? ready.find((agent) => agent.id === "muse")?.id ?? ready[0]?.id ?? "muse";
}

/** The agent behind the composer: the open thread's, else the draft's choice. */
export function activeAgentId(state: Pick<AppStore, "threads" | "selectedSessionId" | "drafts" | "selectedWorkspaceId" | "enabledAgents" | "agents" | "detection" | "defaultAgentId">): AgentId {
  const thread = currentThread(state);
  if (thread) return thread.agentId ?? "muse";
  const draftId = state.drafts[`project:${state.selectedWorkspaceId}`]?.config?.agentId;
  if (draftId && agentEnabled(state, draftId)) return draftId;
  return preferredAgent(state);
}

function agentConfigPatch(config?: AgentSessionConfig): Partial<SessionConfig> {
  if (!config) return {};
  return { ...(config.modelId ? { modelId: config.modelId, providerId: config.modelId.includes("/") ? config.modelId.split("/")[0] : undefined } : {}), ...(config.effort ? { effort: config.effort } : {}), ...(config.mode ? { mode: config.mode } : {}) };
}

/** Keeps the effort inside the tiers the selected model supports. */
function fitEffort(config: SessionConfig, models: Model[]): SessionConfig {
  if (!config.effort) return config;
  return { ...config, effort: clampTier(config.effort, tiersFor(modelFor(models, config), config.agentId)) };
}

/** The config the composer shows: the thread's, else this workspace's draft, else defaults. */
export function activeConfig(state: Pick<AppStore, "threads" | "selectedSessionId" | "drafts" | "selectedWorkspaceId" | "defaultAgentId" | "defaultModel" | "defaultProviderId" | "defaultApprovalMode" | "defaultEffort" | "enabledAgents">): SessionConfig {
  return currentThread(state)?.config ?? state.drafts[`project:${state.selectedWorkspaceId}`]?.config ?? defaults(state);
}

export function currentThread(state: Pick<AppStore, "threads" | "selectedSessionId">): Thread | undefined {
  return state.threads.find((thread) => thread.sessionId === state.selectedSessionId);
}
