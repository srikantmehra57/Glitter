import { diagnostics } from "../../../../packages/muse-bridge/src/redaction";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./format";
import { log } from "./logger";
import { MOCK_FILES, MOCK_GIT, MOCK_MODELS, MOCK_THREADS, mockGitReview, mockThreads, mockWorkspaceFile, mockWorktree } from "./mock";
import type { DiagnosticsSnapshot, EditorChoice, ThemeMode } from "./types";
import type { AgentId, AgentIdentity, AgentSessionConfig, ApprovalRequest, CliUpdateOutcome, CliUpdateStatus, ContextUsage, Detection, DroppedFile, EnterpriseStatus, GitBranch, GoalState, PlanItem, PullRequest, GitReview, GitReviewRequest, GitSnapshot, SessionConfig, SessionMetadata, SnapshotRestore, ThreadWorktree, TokenUsage, TranscriptItem, TurnSnapshot, UserInputRequest, WorkspaceFile, WorktreeRemoval, PluginDetail, PluginEntry, SkillDetail, SkillEntry } from "./types";

/**
 * The payload each bridge event carries, declared once here instead of being
 * re-guessed inline at every `payload as …` site in the store. protocol.ts
 * types the wire `payload` as `unknown`; this map is the renderer's half of
 * the contract, so a shape drift has exactly one place to land.
 */
export interface BridgeEventPayloads {
  delta: { sessionId: string; itemId: string; delta: string; field?: string };
  hostExit: { kind?: string; exitCode?: number; error?: string };
  bridgeExit: { kind?: string; exitCode?: number; error?: string };
  hostStopping: { kind?: string; exitCode?: number; error?: string };
  connectionError: { kind?: string; exitCode?: number; error?: string };
  agentExit: { agentId: AgentId; error?: string | null };
  agentNotice: { sessionId: string; level?: "info" | "warning"; message: string | null };
  loginError: { error?: string };
  sessionTitle: { sessionId: string; title: string };
  sessionName: { sessionId: string; name: string };
  sessionRow: { session: SessionMetadata };
  sessionStatus: { sessionId: string; status: string };
  sessionModel: { sessionId: string; modelId: string; providerId?: string };
  sessionApprovalMode: { sessionId: string; mode: SessionConfig["approvalMode"] };
  sessionEffort: { sessionId: string; effort: SessionConfig["effort"] };
  approvalUpdated: { sessionId?: string; approvalId: string; availableChoices: ApprovalRequest["availableChoices"] };
  approvalResolved: { sessionId?: string; approvalId: string };
  agentConfig: { sessionId: string; config: AgentSessionConfig };
  sessionFacts: { sessionId: string; plan?: PlanItem[]; goal?: GoalState | null; context?: ContextUsage | null; usage?: TokenUsage | null; branch?: string | null };
  userInputs: { sessionId: string; requests: UserInputRequest[] };
  item: { sessionId: string; item: TranscriptItem };
  approval: ApprovalRequest;
  approvalError: { sessionId?: string; approvalId: string; kind: string; error?: string };
  turnRetry: { sessionId: string; turnId: string; attempt?: number; maxAttempts?: number; reason?: string; retryDelayMs?: number };
  viewHealth: { sessionId: string; health: string; noneReason?: string };
  viewGap: { sessionId: string; after: string; next: string };
  viewGapHealed: { sessionId: string; after: string; next: string };
  skillChanged: { sessionId: string };
  turnError: { sessionId: string; turnId?: string; error?: string; code?: string };
  gapError: { sessionId: string; turnId?: string; error?: string; reason?: string; after?: string; next?: string };
  turnSnapshot: TurnSnapshot;
  turnStarted: { sessionId: string; turnId: string };
  turnCompleted: { sessionId: string; turnId: string; outcome: { kind: string; params?: { terminal?: string; reason?: string; error?: { kind?: string; message: string } } }; viewCursor?: string };
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const pending = new Map<string, Pending>();
let listener: Promise<void> | null = null;
const eventHandlers = new Set<(event: string, payload: unknown) => void>();

function isEvent(value: unknown): value is { type: "event"; event: string; payload: unknown } {
  return Boolean(
    value && typeof value === "object"
    && (value as { type?: string }).type === "event"
    && typeof (value as { event?: unknown }).event === "string",
  );
}

function isResponse(value: unknown): value is { id: string; ok: boolean; result?: unknown; error?: string; code?: string; retryable?: boolean } {
  return Boolean(value && typeof value === "object" && "id" in (value as object) && "ok" in (value as object));
}

/** A bridge failure that kept the host's structure: message plus MSP kind and retryability. */
export type BridgeError = Error & { code?: string; retryable?: boolean };

export function bridgeError(message: string, code?: string, retryable?: boolean): BridgeError {
  const error = new Error(message) as BridgeError;
  if (code) error.code = code;
  if (retryable !== undefined) error.retryable = retryable;
  return error;
}

/** Events worth a diagnostic line. Checked for every streamed frame, so it is a set, not an array built per event. */
const LOGGED_EVENTS = new Set(["hostExit", "bridgeExit", "hostStopping", "connectionError", "turnCompleted", "turnError", "approvalError", "gapError", "loginDone", "loginError"]);

async function ensureListener() {
  if (!isTauri()) return;
  if (!listener) {
    listener = listen<unknown>("bridge-line", (event) => {
      const value = event.payload;
      if (isEvent(value)) {
        if (LOGGED_EVENTS.has(value.event)) {
          log[value.event.toLowerCase().includes("error") || value.event === "hostExit" || value.event === "bridgeExit" ? "warn" : "info"](`bridge.event.${value.event}`);
        }
        if (value.event === "hostExit" || value.event === "bridgeExit" || value.event === "hostStopping") {
          for (const [id, waiter] of pending) {
            if (value.event === "hostStopping" && ["startHost", "stopHost"].includes(waiter.method)) continue;
            waiter.reject(new Error("Muse connection closed. Reconnect from Settings."));
            pending.delete(id);
          }
        }
        for (const handler of eventHandlers) {
          // A handler throwing on a malformed event must not kill the dispatch
          // or poison the stream listener — the desync would be silent
          // otherwise. Log it so the dropped event is diagnosable.
          try {
            handler(value.event, value.payload);
          } catch (error) {
            log.warn("bridge.event.handler_failed", { event: value.event, error: String(error) });
          }
        }
      } else if (isResponse(value) && value.id) {
        const waiter = pending.get(value.id);
        if (!waiter) return;
        pending.delete(value.id);
        if (value.ok) waiter.resolve(value.result);
        else waiter.reject(bridgeError(value.error || "Bridge error", typeof value.code === "string" ? value.code : undefined, typeof value.retryable === "boolean" ? value.retryable : undefined));
      }
    }).then(() => {}).catch((error) => {
      listener = null;
      throw error;
    });
  }
  await listener;
}

export function onBridgeEvent(handler: (event: string, payload: unknown) => void): () => void {
  eventHandlers.add(handler);
  void ensureListener().catch((error) => handler("connectionError", { error: String(error) }));
  return () => { eventHandlers.delete(handler); };
}

export async function bridge<T = unknown>(method: string, params: Record<string, unknown> = {}, options?: { timeoutMs?: number }): Promise<T> {
  if (!isTauri()) return mockBridge(method, params) as T;
  await ensureListener();
  const id = crypto.randomUUID();
  log.debug("bridge.request", { method });
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      const timeout = new Error(`${method} timed out. Its result is unknown; check before retrying.`) as Error & { code?: string };
      timeout.code = "timeout-unknown";
      log.warn("bridge.timeout", { method });
      reject(timeout);
    }, options?.timeoutMs ?? 120_000);
    pending.set(id, {
      method,
      resolve: (value) => { window.clearTimeout(timer); log.debug("bridge.response", { method }); resolve(value as T); },
      reject: (error) => { window.clearTimeout(timer); log.warn("bridge.failure", { method, error: String(error) }); reject(error); },
    });
    void invoke("bridge_request", { id, method, params }).catch((error) => {
      pending.get(id)?.reject(new Error(diagnostics.text(String(error))));
      pending.delete(id);
    });
  });
}

function mockBridge(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "detect":
    case "status": {
      const apiKeyAvailable = Boolean(typeof params.museApiKey === "string" && params.museApiKey.trim());
      const activeAuth = params.museAuthMode === "subscription" ? null : apiKeyAvailable ? "apiKey" : null;
      return {
        found: false,
        path: null,
        version: null,
        authenticated: activeAuth !== null,
        method: activeAuth === "apiKey" ? "META_API_KEY" : null,
        activeAuth,
        subscriptionAvailable: false,
        apiKeyAvailable,
        running: false,
      } satisfies Detection;
    }
    case "listSessions":
      return {
        sessions: MOCK_THREADS.map((thread) => ({
          sessionId: thread.sessionId,
          workspaceRoot: params.workspaceRoot ?? thread.workspacePath,
          updatedAt: thread.updatedAt,
          status: thread.status === "running" ? "running" : "idle",
          turnCount: thread.items.length,
          modelId: "muse-spark-1.2",
          activeTurnId: thread.activeTurnId ?? null,
        })),
        nextCursor: null,
      };
    case "listModels":
      return { models: MOCK_MODELS, providerId: "meta", profileId: null, source: "preview" };
    case "usage":
      return {};
    case "startHost":
      return {
        server: { name: "preview", version: "0.0.0" },
        durability: params.noSessionLog === true ? "ephemeral" : "durable",
        trustWorkspace: params.trustWorkspace === true,
        posture: {
          ephemeralSessions: params.noSessionLog === true,
          disableWrite: params.disableWrite === true,
          disableShell: params.disableShell === true,
          sandboxNetwork: typeof params.sandboxNetwork === "string" ? params.sandboxNetwork : "proxy-only",
        },
      };
    case "startSession":
      return { sessionId: `preview-${Date.now()}` };
    case "sendTurn":
      return { turnId: `turn-${Date.now()}` };
    case "decideApproval":
    case "cancelTurn":
    case "stopHost":
      return { ok: true };
    case "readOutput": {
      const line = "✓ preview spec passes\n";
      const content = line.repeat(64).slice(0, 2048);
      return { offsetBytes: 0, byteLen: content.length, eof: true, encoding: "utf8", mediaType: "text/plain", content };
    }
    case "readSession":
      return {
        session: { sessionId: params.sessionId },
        history: { items: [
          { itemId: "mock-child-u1", kind: "userMessage", status: "completed", text: "Audit the composer for focus traps." },
          { itemId: "mock-child-a1", kind: "agentMessage", status: "completed", text: "Checked every dialog: focus stays inside while open." },
        ] },
        pendingRequests: [],
        viewCursor: "mock-cursor",
      };
    case "subagentControl":
    case "taskControl":
    case "workflowControl":
    case "goalControl":
    case "userShell":
    case "setReasoningEffort":
    case "setModel":
      return { commandId: "mock-cmd", status: "accepted" };
    case "setApprovalMode":
      return { commandId: "mock-cmd", status: "accepted", effectiveMode: { mode: params.mode } };
    case "renameSession":
      return { sessionId: params.sessionId, name: params.name };
    case "suggest":
      return { text: JSON.stringify([
        { title: "Wire up the new feature", prompt: "Implement the next pending piece of the current task and keep it consistent with the existing patterns." },
        { title: "Review recent changes", prompt: "Review my uncommitted changes for bugs, edge cases, and anything to clean up before committing." },
        { title: "Add coverage for new code", prompt: "Find the code changed most recently that lacks tests and add meaningful coverage." },
        { title: "Tidy the workspace", prompt: "Look for dead code, stale TODOs, or inconsistencies in this codebase and clean them up." },
      ]) };
    case "listSkills":
      return { skills: [{ selector: "review", displayName: "Review", description: "Review the working tree", source: "user" }] };
    case "mcpServers":
      return { servers: [{ name: "preview-docs", transport: "streamableHttp", oauth: true }] };
    case "checkCliUpdate":
      return { available: false, current: null, latest: null, urgency: "none", notification: "", channel: "muse-stable" } satisfies CliUpdateStatus;
    case "updateCli":
      return { updated: false, from: null, to: null, version: null } satisfies CliUpdateOutcome;
    default:
      return {};
  }
}

export async function gitSnapshot(grantId: string): Promise<GitSnapshot> {
  if (!isTauri()) return MOCK_GIT;
  return invoke<GitSnapshot>("git_snapshot", { grantId });
}

export async function gitReview(grantId: string, request: GitReviewRequest): Promise<GitReview> {
  if (!isTauri()) return mockGitReview(request);
  return invoke<GitReview>("git_review", { grantId, request });
}

/** Metadata only; checkpoint bytes never cross into the renderer. */
export async function turnSnapshots(grantId: string, sessionId: string): Promise<TurnSnapshot[]> {
  if (!isTauri()) return Object.values(MOCK_THREADS.find((thread) => thread.sessionId === sessionId)?.snapshots ?? {});
  return invoke<TurnSnapshot[]>("turn_snapshots", { grantId, sessionId });
}

export async function restoreTurnSnapshot(grantId: string, sessionId: string, snapshotId: string, reapply: boolean): Promise<SnapshotRestore> {
  if (!isTauri()) throw new Error("Restoring files needs the desktop app.");
  return invoke<SnapshotRestore>("turn_snapshot_restore", { grantId, sessionId, snapshotId, reapply });
}

export async function forgetTurnSnapshots(grantId: string, sessionId: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>("turn_snapshots_forget", { grantId, sessionId });
}

/** Repo-relative paths for @-mentions: `git ls-files` in repos, bounded walk elsewhere. */
export async function listWorkspaceFiles(grantId: string): Promise<string[]> {
  if (!isTauri()) return MOCK_FILES;
  return invoke<string[]>("list_workspace_files", { grantId });
}

/** Discard working-tree changes for repo-relative paths; returns a fresh snapshot. */
export async function gitDiscardFiles(grantId: string, paths: string[]): Promise<GitSnapshot> {
  if (!isTauri()) throw new Error("Discarding changes needs the desktop app.");
  return invoke<GitSnapshot>("git_discard_files", { grantId, paths });
}

/** Discard one hunk of a tracked file (the file is unstaged first); returns a fresh snapshot. */
export async function gitDiscardHunk(grantId: string, path: string, hunk: number): Promise<GitSnapshot> {
  if (!isTauri()) throw new Error("Discarding changes needs the desktop app.");
  return invoke<GitSnapshot>("git_discard_hunk", { grantId, path, hunk });
}

/** Stage or unstage paths; returns a fresh snapshot. */
export async function gitStage(grantId: string, paths: string[], stage: boolean): Promise<GitSnapshot> {
  if (!isTauri()) throw new Error("Staging changes needs the desktop app.");
  return invoke<GitSnapshot>("git_stage", { grantId, paths, stage });
}

/** Commit staged changes; returns a fresh snapshot. */
export async function gitCommit(grantId: string, message: string): Promise<GitSnapshot> {
  if (!isTauri()) throw new Error("Committing needs the desktop app.");
  return invoke<GitSnapshot>("git_commit", { grantId, message });
}

/** Discard every uncommitted change (tracked restores, untracked removals, ignored kept). */
export async function gitDiscardAll(grantId: string): Promise<GitSnapshot> {
  if (!isTauri()) throw new Error("Discarding changes needs the desktop app.");
  return invoke<GitSnapshot>("git_discard_all", { grantId });
}

/** Initialize git inside the granted folder (files untouched, nothing committed). */
export async function gitInit(grantId: string): Promise<GitSnapshot> {
  if (!isTauri()) return { ...MOCK_GIT, repository: true };
  return invoke<GitSnapshot>("git_init", { grantId });
}

export type TerminalEvent = { id: string; kind: "output"; data: Uint8Array } | { id: string; kind: "exit"; code: number | null };

/** Start the user's shell on a PTY in the granted folder. Returns the terminal's id. */
export async function terminalOpen(grantId: string, cols: number, rows: number): Promise<string> {
  if (!isTauri()) throw new Error("The terminal needs the desktop app.");
  return invoke<string>("terminal_open", { grantId, cols, rows });
}

export async function terminalWrite(id: string, data: string): Promise<void> {
  if (isTauri()) await invoke("terminal_write", { id, data });
}

export async function terminalResize(id: string, cols: number, rows: number): Promise<void> {
  if (isTauri()) await invoke("terminal_resize", { id, cols, rows });
}

export async function terminalClose(id: string): Promise<void> {
  if (isTauri()) await invoke("terminal_close", { id });
}

declare global {
  // ES2025's native base64 decode. The tsconfig pins ES2021 libs, so the
  // member is declared optional here: recent system webviews have it, older
  // ones take the `atob` path below.
  interface Uint8ArrayConstructor {
    fromBase64?(base64: string): Uint8Array;
  }
}

/**
 * Decode one `terminal-output` payload. Output stays bytes — a flushed chunk
 * can still end mid-character, so it is a `Uint8Array` for xterm rather than
 * a decoded string.
 */
const decodeTerminalOutput = (data: string): Uint8Array =>
  typeof Uint8Array.fromBase64 === "function"
    ? Uint8Array.fromBase64(data)
    : Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));

/** Output and exit events for every terminal. Output is bytes: a chunk can end mid-character. */
export function onTerminalEvent(handler: (event: TerminalEvent) => void): () => void {
  if (!isTauri()) return () => {};
  const output = listen<{ id: string; data: string }>("terminal-output", (event) => {
    handler({ id: event.payload.id, kind: "output", data: decodeTerminalOutput(event.payload.data) });
  });
  const exit = listen<{ id: string; code: number | null }>("terminal-exit", (event) => handler({ id: event.payload.id, kind: "exit", code: event.payload.code ?? null }));
  return () => { void output.then((off) => off()); void exit.then((off) => off()); };
}

/** Tell the native menu which accelerators the user rebound (menu item id → accelerator). */
export async function setMenuShortcuts(accelerators: Record<string, string>): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_menu_shortcuts", { accelerators });
}

/**
 * Give the desktop window the interface's appearance, so the material behind a
 * translucent sidebar is the light or dark one the theme expects. `system` hands
 * the choice back to the OS.
 */
export async function setWindowAppearance(theme: ThemeMode): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_window_appearance", { theme });
}

/** Set the desktop window's zoom. The browser preview keeps the browser's own zoom. */
export async function setInterfaceZoom(level: number): Promise<void> {
  if (!isTauri()) return;
  await invoke("set_interface_zoom", { level });
}

/**
 * The window's close has been requested but the webview is still alive — the
 * last moment the renderer can write state. `beforeunload`/`pagehide` are not
 * reliably delivered before a WKWebView is destroyed on macOS, so this native
 * signal is the dependable half of the teardown story.
 */
export function onWindowCloseRequested(handler: () => void): () => void {
  if (!isTauri()) return () => {};
  const pending = listen("tauri://close-requested", () => handler());
  return () => { void pending.then((off) => off()); };
}

/** Local branches, most recently committed first. */
export async function gitBranches(grantId: string): Promise<GitBranch[]> {
  if (!isTauri()) return [{ name: MOCK_GIT.branch, current: true, upstream: `origin/${MOCK_GIT.branch}` }, { name: "feature/review-pane", current: false }, { name: "fix/approval-copy", current: false }];
  return invoke<GitBranch[]>("git_branches", { grantId });
}

/** Switch to a local branch, or create one from the current commit. */
export async function gitSwitch(grantId: string, branch: string, create: boolean): Promise<GitSnapshot> {
  if (!isTauri()) return { ...MOCK_GIT, branch };
  return invoke<GitSnapshot>("git_switch", { grantId, branch, create });
}

/** Push the current branch with the user's own git credentials. */
export async function gitPush(grantId: string): Promise<{ branch: string; remote: string }> {
  if (!isTauri()) throw new Error("Pushing needs the desktop app.");
  return invoke("git_push", { grantId });
}

/** Fast-forward the current branch to its upstream. Diverged history is refused, never merged. */
export async function gitPull(grantId: string): Promise<GitSnapshot> {
  if (!isTauri()) throw new Error("Pulling needs the desktop app.");
  return invoke<GitSnapshot>("git_pull", { grantId });
}

/** Read the current branch's pull request, or create it first, through the user's `gh`. */
export async function gitPullRequest(grantId: string, create: boolean): Promise<PullRequest> {
  if (!isTauri()) return { unavailable: "Pull requests need the desktop app." };
  return invoke<PullRequest>("git_pull_request", { grantId, create });
}

/** One workspace file for the read-only viewer: bounded, text only, confined to the grant. */
export async function readWorkspaceFile(grantId: string, path: string): Promise<WorkspaceFile> {
  if (!isTauri()) return mockWorkspaceFile(path);
  return invoke<WorkspaceFile>("read_workspace_file", { grantId, path });
}

/** Create a worktree of the granted repository on a new branch. An empty base starts from the current branch. */
export async function gitWorktreeCreate(grantId: string, base: string): Promise<Omit<ThreadWorktree, "workspaceId"> & { warning?: string }> {
  if (!isTauri()) return mockWorktree(base);
  return invoke("git_worktree_create", { grantId, base: base || null });
}

/** Apply a worktree's changes to the workspace folder it came from, all or nothing. */
export async function gitWorktreeHandoff(grantId: string): Promise<{ files: number; snapshot: GitSnapshot }> {
  if (!isTauri()) return { files: 0, snapshot: MOCK_GIT };
  return invoke("git_worktree_handoff", { grantId });
}

/** Remove an app-made worktree with its uncommitted files and revoke its grant. */
export async function gitWorktreeRemove(grantId: string): Promise<WorktreeRemoval> {
  if (!isTauri()) return { branch: null, branchKept: false };
  return invoke<WorktreeRemoval>("git_worktree_remove", { grantId });
}

/** Inspect native OS drop paths (images come back with base64 bytes). */
export async function readDroppedPaths(paths: string[]): Promise<DroppedFile[]> {
  if (!isTauri()) return [];
  return invoke<DroppedFile[]>("read_dropped_files", { paths });
}

/** What `repairStoreDocument` found when it inspected the settings file. */
export type StoreRepair = {
  status: "ok" | "restored" | "quarantined" | "empty";
  restoredFrom?: string | null;
  quarantinedTo?: string | null;
};

/**
 * Persist the settings document atomically (temp file + rename, previous copy
 * kept as `.bak`). `tauri-plugin-store`'s own `save()` truncates in place, so a
 * crash mid-write can destroy every draft and thread title.
 */
export async function persistStoreDocument(json: string): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("persist_store_atomic", { json });
}

/**
 * Make the settings file safe to read before hydration. An unreadable file is
 * quarantined and the newest complete backup restored. Preview is a no-op.
 */
export async function repairStoreDocument(): Promise<StoreRepair> {
  if (!isTauri()) return { status: "ok" };
  return invoke<StoreRepair>("repair_store_document");
}

export type PickedFolder = { path: string; grantId: string; warning?: string };

export async function pickFolder(): Promise<PickedFolder | null> {
  if (!isTauri()) return { path: "/Users/you/Muse Code", grantId: "preview" };
  try {
    const picked = await invoke<{ path?: string; grantId?: string; warning?: string }>("pick_folder");
    if (!picked?.path || !picked.grantId) return null;
    return { path: picked.path, grantId: picked.grantId, warning: picked.warning };
  } catch {
    // The plugin-dialog fallback cannot mint a native grant, so it fails
    // closed: without a grant id the folder authorizes nothing.
    return null;
  }
}

export type GrantVerdict = { id: string; ok: boolean; path?: string | null };

/**
 * Verify-only reconciliation: submit the (id, path) pairs this renderer
 * holds; the native side confirms each without ever listing the grant set.
 */
export async function verifyGrants(entries: Array<{ id: string; path: string }>): Promise<GrantVerdict[]> {
  if (!isTauri()) return [];
  return invoke<GrantVerdict[]>("verify_grants", { entries });
}

export async function removeGrant(grantId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("remove_grant", { grantId });
}

export async function agentIdentities(): Promise<AgentIdentity[]> {
  if (!isTauri()) return [];
  return invoke<AgentIdentity[]>("agent_identities");
}

/** Trust the binary currently on disk for an agent (resolves natively; never nominates a path). */
export async function confirmAgentBin(agentId: string): Promise<AgentIdentity> {
  if (!isTauri()) throw new Error("Agent confirmation needs the desktop app.");
  return invoke<AgentIdentity>("confirm_agent_bin", { agentId });
}

/**
 * The two keychain verbs settings persistence needs. Values never pass
 * through the settings document — they go straight to the OS credential
 * store. Preview has no keychain, so reads answer `null` and writes no-op.
 */
export async function credentialGet(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("credential_get");
}

export async function credentialSet(value: string): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("credential_set", { value });
}

/** What the renderer may know about a model provider's saved credential: never the key itself. */
export type ProviderStatus = { id: string; configured: boolean; keyHint: string | null; baseUrl: string | null };

/** The browser preview keeps provider setup in memory, so the Providers page can be exercised without a keychain. */
const previewProviders = new Map<string, { key?: string; baseUrl?: string }>();
const previewStatus = (ids: readonly string[]): ProviderStatus[] => ids.map((id) => {
  const saved = previewProviders.get(id);
  return { id, configured: Boolean(saved), keyHint: saved?.key ? `••••${saved.key.slice(-4)}` : null, baseUrl: saved?.baseUrl ?? null };
});

export async function providerKeysGet(ids: readonly string[]): Promise<ProviderStatus[]> {
  if (!isTauri()) return previewStatus(ids);
  return invoke<ProviderStatus[]>("provider_keys_get");
}

/** Save, replace or remove one provider's key (and, for local or custom endpoints, its address). Answers the masked list. */
export async function providerKeySet(ids: readonly string[], provider: string, change: { key?: string; baseUrl?: string; clear?: boolean }): Promise<ProviderStatus[]> {
  if (!isTauri()) {
    if (change.clear) previewProviders.delete(provider);
    else previewProviders.set(provider, { ...previewProviders.get(provider), ...(change.key ? { key: change.key } : {}), ...(change.baseUrl ? { baseUrl: change.baseUrl } : {}) });
    return previewStatus(ids);
  }
  return invoke<ProviderStatus[]>("provider_key_set", { provider, key: change.key ?? null, baseUrl: change.baseUrl ?? null, clear: change.clear ?? null });
}

/** The native ACP-isolation consent flag lives beside the keychain, not in the settings document. */
export async function acpConsentGet(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("acp_isolation_consent_get");
}

export async function acpConsentSet(consented: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("acp_isolation_consent_set", { consented });
}

/** Reveal the app-log directory; resolves the current file's path for the notice. */
export async function openLogFolder(): Promise<string> {
  if (!isTauri()) throw new Error("The log folder needs the desktop app.");
  return invoke<string>("open_log_folder");
}

export async function diagnosticsSnapshot(): Promise<DiagnosticsSnapshot> {
  if (!isTauri()) return { os: "browser-preview", arch: "", logTail: [] };
  return invoke<DiagnosticsSnapshot>("diagnostics_snapshot");
}

/** Open a workspace file in the system's default app, or in the editor chosen in Settings. */
export async function openPath(path: string, grantId: string, editor: EditorChoice = "default") {
  if (!isTauri()) return;
  await invoke("open_path", { path, grantId, editor });
}

export async function openUrl(url: string) {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("open_url", { url });
}

/**
 * Save fetched full output through a native save dialog. In preview mode
 * (no Tauri) the browser downloads the file instead.
 */
export async function saveOutputText(fileName: string, content: string, base64: boolean): Promise<string | null> {
  if (!isTauri()) {
    const bytes = base64 ? Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(content);
    const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return fileName;
  }
  return invoke<string | null>("save_output_text", { fileName, content, base64 });
}

export async function mcpLogin(server: string, museBin?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("mcp_login", { server, museBin: museBin ?? "" });
}

export async function mcpLogout(server: string, museBin?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("mcp_logout", { server, museBin: museBin ?? "" });
}

export async function cliLogout(museBin?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("cli_logout", { museBin: museBin ?? "" });
}

export async function projectInit(grantId: string, museBin: string | undefined, dryRun: boolean, force: boolean): Promise<string> {
  if (!isTauri()) return "# Preview AGENTS.md\n\nProject setup runs in the desktop app.";
  return invoke<string>("project_init", { grantId, museBin: museBin ?? "", dryRun, force });
}

export async function enterpriseStatus(museBin?: string): Promise<EnterpriseStatus> {
  if (!isTauri()) return { generation: null, sources: [] };
  return invoke<EnterpriseStatus>("enterprise_status", { museBin: museBin ?? "" });
}

export async function skillList(grantId: string | undefined, museBin?: string): Promise<SkillEntry[]> {
  if (!isTauri()) return [{ id: "preview-skill", name: "preview-skill", description: "Preview placeholder skill.", scope: "bundled", activation: "on" }];
  return invoke<SkillEntry[]>("skill_list", { grantId: grantId ?? "", museBin: museBin ?? "" });
}

export async function skillInstall(path: string, museBin?: string): Promise<string> {
  if (!isTauri()) return "Preview install — use the desktop app to install skills.";
  return invoke<string>("skill_install", { path, museBin: museBin ?? "" });
}

export async function skillImport(from: "claude" | "codex", dryRun: boolean, museBin?: string): Promise<string> {
  if (!isTauri()) return "Preview import — use the desktop app to import skills.";
  return invoke<string>("skill_import", { from, dryRun, museBin: museBin ?? "" });
}

export async function pickSkillSource(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("pick_skill_source", {});
}

export async function skillInspect(skill: string, museBin?: string): Promise<SkillDetail> {
  if (!isTauri()) return { id: skill, name: skill, description: "Preview placeholder skill.", scope: "bundled", activation: "on", path: null };
  return invoke<SkillDetail>("skill_inspect", { skill, museBin: museBin ?? "" });
}

export async function skillUninstall(skill: string, museBin?: string): Promise<string> {
  if (!isTauri()) return "Preview uninstall — use the desktop app to uninstall skills.";
  return invoke<string>("skill_uninstall", { skill, museBin: museBin ?? "" });
}

export async function skillSet(skill: string, scope: string, enabled: boolean, grantId: string | undefined, museBin?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("skill_set", { skill, scope, enabled, grantId: grantId ?? "", museBin: museBin ?? "" });
}

export async function pluginList(museBin?: string, available = false): Promise<PluginEntry[]> {
  if (!isTauri()) return [{ id: "preview-plugin", version: "0.1", description: "Preview placeholder plugin.", enabled: true }];
  return invoke<PluginEntry[]>("plugin_list", { museBin: museBin ?? "", available });
}

export async function pluginInspect(id: string, museBin?: string): Promise<PluginDetail> {
  if (!isTauri()) return { id, version: "0.1", description: "Preview placeholder plugin.", capabilities: [{ id: "preview-cap", kind: "tool", description: "Preview capability.", enabled: true }] };
  return invoke<PluginDetail>("plugin_inspect", { id, museBin: museBin ?? "" });
}

export async function pluginReview(id: string, approve: boolean, museBin?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("plugin_review", { id, approve, museBin: museBin ?? "" });
}

export async function pluginInstall(path: string, museBin?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("plugin_install", { path, museBin: museBin ?? "" });
}

export async function pickPluginBundle(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("pick_plugin_bundle", {});
}

export async function trustPreview(grantId: string, museBin?: string): Promise<import("./types").TrustPreview> {
  if (!isTauri()) {
    return {
      skills: [{ name: "/preview-skill", description: "Preview placeholder: real workspace skills appear in the desktop app." }],
      rules: { path: "AGENTS.md", excerpt: "# Preview rules\n\nThe desktop app shows this workspace's AGENTS.md here.", truncated: false },
    };
  }
  return invoke<import("./types").TrustPreview>("trust_preview", { grantId, museBin: museBin ?? "" });
}

export async function exportSession(options: { sessionId: string; title: string; museBin?: string; redacted: boolean; markdown?: boolean }): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("export_session", {
    sessionId: options.sessionId,
    title: options.title,
    museBin: options.museBin ?? "",
    redacted: options.redacted,
    markdown: options.markdown === true,
  });
}

export { MOCK_FILES, mockThreads, mockWorkspaceFile, mockWorktree };
