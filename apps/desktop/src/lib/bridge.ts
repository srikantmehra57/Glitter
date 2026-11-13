import { diagnostics } from "../../../../packages/glitter-harness/src/redaction";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./format";
import { log } from "./logger";
import { MOCK_FILES, MOCK_GIT, MOCK_GIT_GRAPH, MOCK_MODELS, MOCK_THREADS, mockAddMarketplace, mockGitReview, mockGithubInspect, mockGithubInstall, mockLibraryList, mockMarketplaceAvatars, mockRefreshMarketplace, mockRemoveMarketplace, mockRemovePlugin, mockSetPluginEnabled, mockThreads, mockWorkspaceFile, mockWorktree } from "./mock";
import type { ProviderStatus } from "./providers";
export type { ProviderStatus } from "./providers";
import type { DiagnosticsSnapshot, EditorChoice, SupportPaths, ThemeMode, BrowserControlResult, BrowserFrame, BrowserStateEvent } from "./types";
import type { AgentId, AgentSessionConfig, ApprovalRequest, CatalogEntry, CatalogInstallResult, CatalogList, CatalogRemoveResult, GithubPreview, MarketplaceSource, PluginInstallOutcome, PluginLibrary, PluginUpdate, ContextUsage, Detection, DroppedFile, GitBranch, GitGraph, GoalState, HarnessMcpConfig, HarnessMcpConfigServer, HarnessMcpReview, HarnessMcpScope, HarnessMcpServerInput, ModelCall, PlanItem, PullRequest, GitReview, GitReviewRequest, GitSnapshot, SessionConfig, SessionMetadata, SnapshotRestore, ThreadWorktree, TokenUsage, TranscriptItem, TurnSnapshot, UserInputRequest, WorkspaceFile, WorktreeRemoval, OrchestratorProbeResult, OrchestratorRole, OrchestratorRoute } from "./types";

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
  /** One model call the Harness made in the running turn. The app keeps them as that turn's trajectory. */
  modelCall: { sessionId: string; turnId: string; call: ModelCall };
  /** A routed turn's decision, emitted before its first stage starts. */
  route: { sessionId: string; turnId: string; route: OrchestratorRoute };
  /** `turnEnded`: the questions ended the turn (Harness), so the thread is idle until they are answered. */
  userInputs: { sessionId: string; requests: UserInputRequest[]; turnEnded?: boolean };
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
  browserState: BrowserStateEvent;
  browserFrame: BrowserFrame;
  /** `cause: "userInput"`: the agent continued on its own after a question was answered, not from the queue. */
  turnStarted: { sessionId: string; turnId: string; cause?: "userInput" };
  turnCompleted: { sessionId: string; turnId: string; outcome: { kind: string; params?: { terminal?: string; reason?: string; error?: { kind?: string; message: string; code?: string; status?: number } } }; viewCursor?: string };
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
            waiter.reject(new Error("The agent connection closed. Reconnect from Settings."));
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

/** Preview keeps MCP management state in memory, so adding and removing works without a host. */
let previewMcpConfig: HarnessMcpConfig = {
  servers: [
    { name: "preview-docs", source: "workspace", transport: "stdio", command: "npx", args: 2, envKeys: ["DOCS_TOKEN"], headerKeys: [] },
    { name: "preview-search", source: "home", transport: "http", url: "https://mcp.example.dev/search", args: 0, envKeys: [], headerKeys: ["Authorization"] },
  ],
  error: null,
};
let previewMcpConsent: { trusted: boolean; configurationDigest?: string } = { trusted: false };
const previewMcpDigest = () => `preview:${previewMcpConfig.servers.map((server) => `${server.source}:${server.name}:${server.transport}:${server.command ?? server.url ?? ""}:${server.args}:${server.envKeys.join(",")}:${server.headerKeys.join(",")}`).join("|")}`;
const previewMcpReview = (): HarnessMcpReview => {
  const configurationDigest = previewMcpDigest();
  return {
    trusted: previewMcpConsent.trusted,
    current: previewMcpConsent.configurationDigest === configurationDigest,
    hasWorkspaceConfig: previewMcpConfig.servers.some((server) => server.source === "workspace"),
    configurationDigest,
  };
};

/** Preview store state lives in memory, so install and remove round-trip without the desktop shell. */
const PREVIEW_CATALOG: CatalogEntry[] = [
  { id: "code-review", kind: "skill", name: "Code review", summary: "Review a diff for correctness, security and missing tests.", description: "Find the defects that matter, with a file and line, the failure mode, and a concrete fix.", tags: ["quality", "git"], version: 1, skills: ["code-review"], servers: [], scope: "user", requiresWorkspace: false, commands: [], installed: false, installedParts: 0, totalParts: 1 },
  { id: "commit-message", kind: "skill", name: "Commit message", summary: "Write a Conventional Commits message from the staged change.", description: "Reads the staged diff, picks the right type, and writes an imperative subject plus a why-focused body.", tags: ["git", "everyday"], version: 1, skills: ["commit-message"], servers: [], scope: "user", requiresWorkspace: false, commands: [], installed: false, installedParts: 0, totalParts: 1 },
  { id: "test-first", kind: "skill", name: "Test first", summary: "One failing test, the smallest fix, then cleanup.", description: "A disciplined TDD loop for new behavior and bug fixes.", tags: ["testing"], version: 1, skills: ["test-first"], servers: [], scope: "user", requiresWorkspace: false, commands: [], installed: false, installedParts: 0, totalParts: 1 },
  { id: "daily-driver", kind: "plugin", name: "Daily driver", summary: "Review, commit and open a PR with one consistent voice.", description: "The three skills used on every change, plus sequential thinking for plans that need room.", tags: ["git", "everyday"], version: 1, skills: ["code-review", "commit-message"], servers: ["sequential-thinking"], scope: "user", requiresWorkspace: false, commands: ["npx -y @modelcontextprotocol/server-sequential-thinking"], installed: false, installedParts: 0, totalParts: 3 },
  { id: "filesystem", kind: "mcp", name: "Filesystem", summary: "Read and write files inside this workspace.", description: "The reference filesystem server. It can only touch the workspace it was installed for.", tags: ["files", "workspace"], version: 1, skills: [], servers: ["filesystem"], scope: "workspace", requiresWorkspace: true, commands: ["npx -y @modelcontextprotocol/server-filesystem <workspace>"], installed: false, installedParts: 0, totalParts: 1 },
];
const previewCatalogInstalled = new Set<string>();

function previewCatalogList(): CatalogList {
  return {
    entries: PREVIEW_CATALOG.map((entry) => {
      const parts = [...entry.skills, ...entry.servers];
      const installedParts = parts.filter((part) => previewCatalogInstalled.has(part)).length;
      return { ...entry, installedParts, installed: parts.length > 0 && installedParts === parts.length };
    }),
    skillsRoot: "~/.agents/skills",
    error: null,
  };
}

function mockBridge(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "detect":
      return { agents: [{ id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "Add an API key for a model provider in Settings → Providers.", authenticated: true }] } satisfies Detection;
    case "listSessions":
      return {
        sessions: MOCK_THREADS.map((thread) => ({
          sessionId: thread.sessionId,
          workspaceRoot: params.workspaceRoot ?? thread.workspacePath,
          updatedAt: thread.updatedAt,
          status: thread.status === "running" ? "running" : "idle",
          turnCount: thread.items.length,
          modelId: "anthropic/claude-sonnet-5",
          activeTurnId: thread.activeTurnId ?? null,
        })),
        nextCursor: null,
      };
    case "listModels":
      return { models: MOCK_MODELS, source: "preview" };
    case "browserOpen":
    case "browserControl":
    case "browserClose":
      return {
        state: { status: "closed", url: "", title: "", viewport: { width: 1100, height: 760 } },
        text: "Browser control needs the desktop app with a real workspace.",
      } satisfies BrowserControlResult;
    case "startHost":
      return { started: true, agentId: "harness", isolation: { env: "minimal", osSandbox: "enforced", platform: "darwin", consentRequired: false } };
    case "startSession":
      return { sessionId: `preview-${Date.now()}` };
    case "sendTurn":
      return { turnId: `turn-${Date.now()}` };
    case "decideApproval":
    case "cancelTurn":
    case "stopHost":
      return { ok: true };
    case "readChildSession":
      return {
        session: { sessionId: params.sessionId },
        history: { items: [
          { itemId: "mock-child-u1", kind: "userMessage", status: "completed", text: "Audit the composer for focus traps." },
          { itemId: "mock-child-a1", kind: "agentMessage", status: "completed", text: "Checked every dialog: focus stays inside while open." },
        ] },
        pendingRequests: [],
        viewCursor: "mock-cursor",
      };
    case "setModel":
    case "setOrchestrator":
      return { commandId: "mock-cmd", status: "accepted" };
    case "setApprovalMode":
      return { commandId: "mock-cmd", status: "accepted", effectiveMode: { mode: params.mode } };
    case "suggest":
      return { text: JSON.stringify([
        { title: "Wire up the new feature", prompt: "Implement the next pending piece of the current task and keep it consistent with the existing patterns." },
        { title: "Review recent changes", prompt: "Review my uncommitted changes for bugs, edge cases, and anything to clean up before committing." },
        { title: "Add coverage for new code", prompt: "Find the code changed most recently that lacks tests and add meaningful coverage." },
        { title: "Tidy the workspace", prompt: "Look for dead code, stale TODOs, or inconsistencies in this codebase and clean them up." },
      ]) };
    case "listSkills":
      return { skills: [{ selector: "review", displayName: "Review", description: "Review the working tree", source: "user" }] };
    case "harnessMcp":
      return { servers: previewMcpConfig.servers.map(({ name, transport }) => ({ name, transport, tools: 3 })), error: previewMcpConfig.error };
    case "harnessMcpConfig":
      return previewMcpConfig;
    case "harnessRules":
      return { problems: [] };
    case "testModel": {
      // A preview model answers after a short, varied wait; a "busy" one shows the failure path.
      const modelId = String(params.modelId ?? "");
      return new Promise((resolve, reject) => setTimeout(() => {
        if (/kimi/i.test(modelId)) reject(bridgeError("The provider is overloaded. Try again shortly.", "SERVER", true));
        else resolve({ latencyMs: 640 + (modelId.length % 9) * 97, firstTokenMs: 410 + (modelId.length % 5) * 60, reply: "ready" });
      }, 500 + (modelId.length % 7) * 140));
    }
    case "orchestratorProbe": {
      // The preview answers each role's fixed check without a provider; a "kimi" model shows the failure path.
      const role = String(params.role ?? "") as OrchestratorRole;
      const providerId = String(params.providerId ?? "");
      const modelId = String(params.modelId ?? "");
      return new Promise((resolve, reject) => setTimeout(() => {
        if (/kimi/i.test(modelId)) reject(bridgeError("The model did not return the format the check asks for.", "SERVER", true));
        else resolve({
          role, providerId, modelId, probeVersion: 1, status: "passed",
          detail: role === "router" ? "Strict router JSON verified." : role === "lead" ? "Plan format verified." : "Builder tool use and edit verified.",
          capabilities: role === "builder" || role === "small" ? ["tools"] : [],
          checkedAt: Date.now(),
        } satisfies OrchestratorProbeResult);
      }, 420 + (modelId.length % 6) * 90));
    }
    case "harnessMcpAddServer": {
      const scope = params.scope as HarnessMcpScope;
      const server = params.server as HarnessMcpServerInput;
      if (previewMcpConfig.servers.some((row) => row.name === server.name)) throw new Error(`The MCP config already defines a server named “${server.name}”.`);
      const row: HarnessMcpConfigServer = {
        name: server.name,
        source: scope,
        transport: server.transport,
        ...(server.command ? { command: server.command } : {}),
        ...(server.url ? { url: server.url } : {}),
        args: server.args?.length ?? 0,
        envKeys: Object.keys(server.env ?? {}).sort(),
        headerKeys: Object.keys(server.headers ?? {}).sort(),
      };
      previewMcpConfig = { servers: [...previewMcpConfig.servers, row].sort((a, b) => a.name.localeCompare(b.name)), error: null };
      return previewMcpConfig;
    }
    case "harnessMcpRemoveServer":
      previewMcpConfig = { ...previewMcpConfig, servers: previewMcpConfig.servers.filter((row) => !(row.name === params.name && row.source === params.scope)) };
      return previewMcpConfig;
    case "catalogList":
      return previewCatalogList();
    case "catalogInstall": {
      const entry = PREVIEW_CATALOG.find((row) => row.id === params.entryId);
      if (!entry) throw new Error("That extension is not in the bundled catalog.");
      if (entry.requiresWorkspace && !params.grantId) throw new Error("Open a workspace before installing this extension.");
      const result: CatalogInstallResult = { installedSkills: [], installedServers: [], skipped: [], errors: [] };
      for (const id of entry.skills) {
        if (previewCatalogInstalled.has(id)) result.skipped.push(id);
        else { previewCatalogInstalled.add(id); result.installedSkills.push(id); }
      }
      for (const id of entry.servers) {
        if (previewCatalogInstalled.has(id)) result.skipped.push(id);
        else { previewCatalogInstalled.add(id); result.installedServers.push(id); }
      }
      return result;
    }
    case "catalogRemove": {
      const entry = PREVIEW_CATALOG.find((row) => row.id === params.entryId);
      if (!entry) throw new Error("That extension is not in the bundled catalog.");
      const result: CatalogRemoveResult = { removed: [], skipped: [], errors: [] };
      for (const id of [...entry.skills, ...entry.servers]) {
        if (!previewCatalogInstalled.delete(id)) result.skipped.push(id);
        else result.removed.push(id);
      }
      return result;
    }
    default:
      return {};
  }
}

export async function gitSnapshot(grantId: string): Promise<GitSnapshot> {
  if (!isTauri()) return MOCK_GIT;
  return invoke<GitSnapshot>("git_snapshot", { grantId });
}

export async function gitGraph(grantId: string): Promise<GitGraph> {
  if (!isTauri()) return MOCK_GIT_GRAPH;
  return invoke<GitGraph>("git_graph", { grantId });
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

/** Commit staged changes, optionally including every non-ignored unstaged/new file; returns a fresh snapshot. */
export async function gitCommit(grantId: string, message: string, includeUnstaged = false): Promise<GitSnapshot> {
  if (!isTauri()) throw new Error("Committing needs the desktop app.");
  return invoke<GitSnapshot>("git_commit", { grantId, message, includeUnstaged });
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

/** Preserve a pre-keychain Muse key before its obsolete settings field is removed. */
export async function preserveLegacyMuseKey(value: string): Promise<void> {
  if (isTauri()) await invoke<void>("preserve_legacy_muse_key", { value });
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
  if (!isTauri()) return { path: "/Users/you/Glitter", grantId: "preview" };
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

/** What the renderer may know about a model provider's saved credential: never the key itself. */

/** One custom or saved provider credential as the preview holds it in memory. */
type PreviewCredential = { key?: string; baseUrl?: string; name?: string; wire?: string };

/** The browser preview keeps provider setup in memory, so the Providers page can be exercised without a keychain. */
const previewProviders = new Map<string, PreviewCredential>();
const previewStatusRow = (id: string, saved: PreviewCredential | undefined): ProviderStatus => {
  const wire = saved?.wire === "anthropic" || saved?.wire === "openai" ? saved.wire : null;
  return { id, configured: Boolean(saved), keyHint: saved?.key ? `••••${saved.key.slice(-4)}` : null, baseUrl: saved?.baseUrl ?? null, name: saved?.name ?? null, wire };
};
const previewStatus = (ids: readonly string[]): ProviderStatus[] => {
  const rows = ids.map((id) => previewStatusRow(id, previewProviders.get(id)));
  for (const id of [...previewProviders.keys()].filter((id) => /^custom-\d{1,4}$/.test(id)).sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)))) {
    rows.push(previewStatusRow(id, previewProviders.get(id)));
  }
  return rows;
};
/** The preview mints custom ids the way the keychain does, so the page behaves the same without one. */
function previewMintCustom(): string {
  let n = 1;
  while (previewProviders.has(`custom-${n}`)) n += 1;
  return `custom-${n}`;
}

export async function providerKeysGet(ids: readonly string[]): Promise<ProviderStatus[]> {
  if (!isTauri()) return previewStatus(ids);
  return invoke<ProviderStatus[]>("provider_keys_get");
}

/** Save, replace or remove one provider's key. `custom` creates a new custom endpoint (name, wire, address, optional key); a `custom-N` id edits it. Answers the masked list. */
export async function providerKeySet(ids: readonly string[], provider: string, change: { key?: string; baseUrl?: string; name?: string; wire?: string; clear?: boolean }): Promise<ProviderStatus[]> {
  if (!isTauri()) {
    if (change.clear) previewProviders.delete(provider);
    else if (provider === "custom") {
      const id = previewMintCustom();
      previewProviders.set(id, { key: change.key, baseUrl: change.baseUrl, name: change.name, wire: change.wire });
    } else {
      const previous = previewProviders.get(provider) ?? {};
      const urlChanged = change.baseUrl != null && change.baseUrl !== previous.baseUrl;
      previewProviders.set(provider, { ...previous, ...(change.key ? { key: change.key } : urlChanged ? { key: undefined } : {}), ...(change.baseUrl ? { baseUrl: change.baseUrl } : {}), ...(change.name ? { name: change.name } : {}), ...(change.wire ? { wire: change.wire } : {}) });
    }
    return previewStatus(ids);
  }
  return invoke<ProviderStatus[]>("provider_key_set", { provider, key: change.key ?? null, baseUrl: change.baseUrl ?? null, name: change.name ?? null, wire: change.wire ?? null, clear: change.clear ?? null });
}

/** Reveal the app-log directory; resolves the current file's path for the notice. */
export async function openLogFolder(): Promise<string> {
  if (!isTauri()) throw new Error("The log folder needs the desktop app.");
  return invoke<string>("open_log_folder");
}

/** App-owned support paths. Harness is the only agent with a canonical session log. */
export async function supportPaths(sessionId?: string): Promise<SupportPaths> {
  if (!isTauri()) throw new Error("Support paths need the desktop app.");
  return invoke<SupportPaths>("support_paths", { sessionId });
}

/** Open Glitter's own settings document with the OS default JSON editor. */
export async function openConfigFile(): Promise<void> {
  if (!isTauri()) throw new Error("The config file needs the desktop app.");
  await invoke<void>("open_config_file");
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

/** Native MCP review never returns config values; its digest binds approval to what was reviewed. */
export async function reviewMcp(grantId: string): Promise<HarnessMcpReview> {
  if (!isTauri()) return previewMcpReview();
  return invoke<HarnessMcpReview>("review_mcp", { grantId });
}

export async function consentMcp(grantId: string, approve: boolean, expectedDigest?: string): Promise<void> {
  if (!isTauri()) {
    const configurationDigest = previewMcpDigest();
    if (approve && expectedDigest !== configurationDigest) throw new Error("The MCP configuration changed. Review it again before approving.");
    previewMcpConsent = { trusted: approve, ...(approve ? { configurationDigest } : {}) };
    return;
  }
  await invoke<void>("consent_mcp", { grantId, approve, expectedDigest: expectedDigest ?? null });
}

/** The bundled extension store. Installation is native: no CLI and no network. */
export async function catalogList(grantId: string | undefined): Promise<CatalogList> {
  if (!isTauri()) return previewCatalogList();
  return invoke<CatalogList>("catalog_list", { grantId: grantId ?? "" });
}

export async function catalogInstall(entryId: string, grantId: string | undefined): Promise<CatalogInstallResult> {
  if (!isTauri()) return mockBridge("catalogInstall", { entryId, grantId: grantId ?? "" }) as CatalogInstallResult;
  return invoke<CatalogInstallResult>("catalog_install", { entryId, grantId: grantId ?? "" });
}

export async function catalogRemove(entryId: string, grantId: string | undefined): Promise<CatalogRemoveResult> {
  if (!isTauri()) return mockBridge("catalogRemove", { entryId, grantId: grantId ?? "" }) as CatalogRemoveResult;
  return invoke<CatalogRemoveResult>("catalog_remove", { entryId, grantId: grantId ?? "" });
}

/**
 * Plugins and marketplaces from GitHub. The native side builds the clone URL,
 * fetches one commit and reads it; install uses what that preview fetched.
 */
export async function githubInspect(source: string, plugin?: string | null): Promise<GithubPreview> {
  if (!isTauri()) return mockGithubInspect(source, plugin);
  return invoke<GithubPreview>("github_inspect", { source, plugin: plugin ?? null });
}

export async function githubInstall(token: string, selected?: string[] | null): Promise<PluginInstallOutcome> {
  if (!isTauri()) return mockGithubInstall(token, selected);
  return invoke<PluginInstallOutcome>("github_install", { token, selected: selected ?? null });
}

/** Drop a preview the user closed without installing. */
export async function githubDiscard(token: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("github_discard", { token });
}

export async function libraryList(): Promise<PluginLibrary> {
  if (!isTauri()) return mockLibraryList();
  return invoke<PluginLibrary>("library_list", {});
}

export async function librarySetEnabled(id: string, enabled: boolean): Promise<PluginInstallOutcome> {
  if (!isTauri()) return mockSetPluginEnabled(id, enabled);
  return invoke<PluginInstallOutcome>("library_set_enabled", { id, enabled });
}

export async function libraryRemove(id: string): Promise<string[]> {
  if (!isTauri()) return mockRemovePlugin(id);
  return invoke<string[]>("library_remove", { id });
}

export async function libraryCheckUpdates(): Promise<PluginUpdate[]> {
  if (!isTauri()) return [];
  return invoke<PluginUpdate[]>("library_check_updates", {});
}

export async function marketplaceAdd(token: string): Promise<MarketplaceSource> {
  if (!isTauri()) return mockAddMarketplace(token);
  return invoke<MarketplaceSource>("marketplace_add", { token });
}

export async function marketplaceRefresh(id: string): Promise<MarketplaceSource> {
  if (!isTauri()) return mockRefreshMarketplace(id);
  return invoke<MarketplaceSource>("marketplace_refresh", { id });
}

/** Fetch the avatars of the repositories the sources' listings live in; returns how many arrived. */
export async function marketplaceAvatars(): Promise<number> {
  if (!isTauri()) return mockMarketplaceAvatars();
  return invoke<number>("marketplace_avatars", {});
}

export async function marketplaceRemove(id: string): Promise<void> {
  if (!isTauri()) { mockRemoveMarketplace(id); return; }
  await invoke("marketplace_remove", { id });
}

export async function trustPreview(grantId: string): Promise<import("./types").TrustPreview> {
  if (!isTauri()) {
    return {
      skills: [{ name: "/preview-skill", description: "Preview placeholder: real workspace skills appear in the desktop app." }],
      rules: { path: "AGENTS.md", excerpt: "# Preview rules\n\nThe desktop app shows this workspace's AGENTS.md here.", truncated: false },
    };
  }
  return invoke<import("./types").TrustPreview>("trust_preview", { grantId });
}


export { MOCK_FILES, mockThreads, mockWorkspaceFile, mockWorktree };
