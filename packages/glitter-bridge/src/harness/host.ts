import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { approvalAlive, approvalExpiry, approvalExpiryMono, APPROVAL_TTL_MS, describeIsolation, osSandboxAvailable, type IsolationReport } from "../isolation.js";
import { clipRecency, contextBudget, estimateRequestTokens, fitHistory } from "./context.js";
import type { Grant, Subject } from "./permission/grants.js";
import { runGuards } from "./permission/guards.js";
import { decide, type ApprovalMode, type Verdict } from "./permission/policy.js";
import { SENDS_NONE, TIERS, configuredProviders, effortTiers, providerSpec, resolveProvider, splitModelId, type ProviderCredentials, type ResolvedProvider } from "./providers.js";
import { ExtensionRegistry, type HookEvents, type HookFailure, type HookName, type TurnContext, type TurnContributions } from "./registry.js";
import type { UserInputResponse } from "../protocol.js";
import { McpManager, addMcpServer as writeMcpServer, mcpExtension, readMcpConfig, removeMcpServer as eraseMcpServer, type McpScope, type McpServerInput } from "./mcp.js";
import { DELEGATE_LEAF_PROFILE, DELEGATE_PROFILE, MAX_DELEGATED_STEPS, MAX_DELEGATION_DEPTH, delegationExtension, type DelegationRequest, type DelegationResult } from "./delegation.js";
import { ASK_USER_TOOL, EXIT_PLAN_TOOL, questionRequest, settlement, type Asked, type PendingQuestion } from "./questions.js";
import { discoverSkills, expandInvocation, skillsExtension } from "./skills.js";
import { SessionStore, type DelegationPolicy, type SessionMeta } from "./store.js";
import { BUILTIN_EXTENSION, canonicalize, executeTool, executionMode, prepareTool, repeatReminder, scheduleToolCalls, type PresentationMeta, type ToolKind } from "./tools.js";
import { CONTEXT_WINDOW, ProviderError, isTransientProviderError, isTruncatedStop, streamChat, truncatedToolResult, type AssistantMessage, type ChatMessage, type ContentPart, type SystemPrompt, type ToolCall, type ToolSchema } from "./wire.js";

/**
 * The built-in agent: the app's own harness, driving any provider the user has
 * a key for. It speaks the same bridge events as Muse and the ACP agents
 * (`item`, `delta`, `approval`, `sessionFacts`, `modelCall`, `agentConfig`,
 * `turnCompleted`), so the renderer shows its threads with no special cases.
 */

export const HARNESS_ID = "harness";
export const HARNESS_NAME = "Harness";

type Emit = (event: string, payload: unknown) => void;
type Json = Record<string, unknown>;

export type HarnessModel = {
  modelId: string;
  displayLabel?: string;
  providerId: string;
  description?: string | null;
  contextLimit?: number | null;
  cost?: { input: string; output: string; currency?: string | null } | null;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  effortSource?: "host";
  isDefault?: boolean;
  isActive?: boolean;
};

const MODES = [
  { value: "build", name: "Build", description: "Reads, edits files and runs commands, within the permission mode." },
  { value: "plan", name: "Plan", description: "Reads the workspace and plans. File edits are refused." },
];

const APPROVAL_MODES = new Set<ApprovalMode>(["denyUnmatched", "promptUnmatched", "onRequest", "guarded", "allowAll"]);

const MAX_STEPS = 80;
const RETRIES = 3;
/** Retries stop once this much time has passed since the first attempt, even if attempts remain. */
const RETRY_ELAPSED_MS = 120_000;

/** Whether another attempt is still inside the attempt count and the elapsed cap. */
export function retryBudgetOpen(elapsedMs: number, attempt: number, cap = RETRY_ELAPSED_MS): boolean {
  return attempt <= RETRIES && elapsedMs < cap;
}
const CATALOG_TTL_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 15_000;

/** Known context windows for the default families; others report none. */
function contextWindow(providerId: string, model: string, listed?: number | null): number | null {
  if (listed) return listed;
  const id = model.toLowerCase();
  // A gateway's catalog names each model `vendor/model`, so the vendor decides
  // and what follows the slash is the model the vendor knows it by. Cline and
  // Kilo write xAI as `x-ai` and prefix a rolling alias with `~`.
  const slash = id.indexOf("/");
  const gateway = (providerId === "cline" || providerId === "kilo") && slash > 0;
  const vendor = (gateway ? id.slice(0, slash) : providerId).replace(/^~/, "");
  const name = gateway ? id.slice(slash + 1) : id;
  const family = vendor === "x-ai" ? "xai" : vendor;
  if (family === "anthropic") return 200_000;
  if (family === "openai") return /gpt-5/.test(name) ? 400_000 : /gpt-4\.1/.test(name) ? 1_047_576 : /^o\d/.test(name) ? 200_000 : /gpt-4o/.test(name) ? 128_000 : null;
  if (family === "google") return /gemini/.test(name) ? 1_048_576 : null;
  if (family === "xai") return /grok-4/.test(name) ? 256_000 : /grok-3/.test(name) ? 131_072 : null;
  if (family === "deepseek") return 128_000;
  return null;
}

const NOT_CHAT = /embed|whisper|tts|dall-e|davinci|babbage|moderation|image|audio|realtime|transcribe|search|imagen|veo|aqa|guard|safety|reward|rerank|parse|nvclip|detector|computer-use|sora/i;
/**
 * Rows in Cline's catalog that are not chat. `:batch` has no chat-completions
 * route. Lyria generates music and Nano Banana generates images. The picker
 * must not offer a model a turn would fail on.
 */
const NOT_CLINE_CHAT = /:batch$|nano-banana|lyria/i;
/**
 * Rows in Kilo's catalog that are not chat. Lyria generates music and Nano
 * Banana generates images. A listed model whose parameters omit `tools` cannot
 * run a turn: every turn sends the harness tools.
 */
const NOT_KILO_CHAT = /nano-banana|lyria/i;

/**
 * Every way an approval request can end. Each reaches the model as its own
 * message, so it can tell a refusal from a timeout or from no one to ask.
 */
type ApprovalOutcome =
  | { kind: "allowed"; grant?: Grant }
  | { kind: "rejected" }
  | { kind: "cancelled" }
  | { kind: "expired" }
  /** No channel can answer: the request fails closed instead of waiting. */
  | { kind: "unavailable" };

type Approval = { sessionId: string; turnId: string; choices: Map<string, ApprovalOutcome>; expiresAtMono: number; resolve: (outcome: ApprovalOutcome) => void };

const REFUSALS: Record<Exclude<ApprovalOutcome["kind"], "allowed">, string> = {
  rejected: "The user denied this tool call.",
  cancelled: "The user stopped this turn.",
  expired: "No one answered the approval request within 10 minutes, so the call did not run. Ask the user before trying it again.",
  unavailable: "No one can approve tool calls in this session, so the call was refused. Continue without it, or explain what approval is needed.",
};

type TurnRequest = {
  turnId: string;
  /** What the model receives. */
  text: string;
  /** What the transcript shows, when it differs: a `/skill` the user typed. */
  display?: string;
  images?: Array<{ mediaType: string; base64Data: string }>;
  effort?: string;
};

type SteerRequest = { text: string; images?: Array<{ mediaType: string; base64Data: string }> };

type SkillInvocation = { selector: string; arguments?: string };

type Live = {
  meta: SessionMeta;
  messages: ChatMessage[];
  approvalMode: ApprovalMode;
  /** Commands, prefixes, files and folders the user allowed for the rest of the thread. */
  grants: Grant[];
  prompting: boolean;
  controller: AbortController | null;
  turnId: string;
  counter: number;
  muted?: boolean;
  /** Running totals the providers reported. Prompt tokens are uncached; cache counters are disjoint. */
  usage: { promptTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  /** Follow-ups waiting for the current turn to finish. */
  queue: TurnRequest[];
  /** Messages to fold in at the next tool boundary of the running turn. */
  steering: SteerRequest[];
  /** The running turn is being replaced. Its finish must start the queue even though it was aborted. */
  replacing: boolean;
  /** Identical-call chain. A user message clears it. */
  repeatKey?: string;
  repeatCount: number;
  /** The questions the last turn ended with, until the user settles them. */
  question?: PendingQuestion;
  /** The context-shortening notice has been shown for this session; say it once. */
  contextNotified?: boolean;
};

/** One call's result. A call that asks the user also carries its questions and its transcript item. */
type CallResult = { id: string; name: string; output: string; isError?: boolean; question?: Asked; item?: Json; activate?: readonly string[] };

type HostLimits = {
  idleMs?: number;
  firstEventMs?: number;
  retryElapsedMs?: number;
  /** Test seam: invoked after a call is approved and before it runs. Production leaves it unset. */
  beforeTool?: (name: string) => Promise<void> | void;
  /** False when nothing can answer an approval (a delegated child, a headless run): every request is refused as unavailable. */
  approvalChannel?: boolean;
  /** Test seam: the folder user skills load from. Production uses the OS home folder. */
  homeDir?: string;
};

export class HarnessHost {
  readonly spec = { id: HARNESS_ID, name: HARNESS_NAME };
  private credentials: ProviderCredentials = {};
  private sessions = new Map<string, Live>();
  private approvals = new Map<string, Approval>();
  private catalog: { key: string; at: number; models: HarnessModel[] } | null = null;
  /** The listing in flight and the keys it was started with; a newly added key starts a new one. */
  private catalogLoading: { key: string; run: Promise<HarnessModel[]> } | null = null;
  private readonly emit: Emit;
  private readonly mcp: McpManager;
  /** Tools, prompt sections and hooks. Each turn works from a snapshot taken when it starts. */
  readonly registry = new ExtensionRegistry();

  constructor(emit: Emit, private readonly store = new SessionStore(), private readonly fetchImpl: typeof fetch = fetch, private readonly limits: HostLimits = {}) {
    this.emit = emit;
    this.registry.register(BUILTIN_EXTENSION);
    this.registry.register(delegationExtension(this));
    this.registry.register(skillsExtension(this.homeDir));
    this.mcp = new McpManager(this.homeDir, emit);
    this.registry.register(mcpExtension(this.mcp));
    // With no one to answer, the model is not offered a way to ask, nor a plan review to leave Plan mode by.
    if (this.limits.approvalChannel !== false) this.registry.register({
      id: "questions",
      tools: [ASK_USER_TOOL, (context) => (context.mode === "plan" ? EXIT_PLAN_TOOL : undefined)],
      prompt: [{ placement: "volatile", text: (context) => (context.mode === "plan" && context.delegationDepth === 0 ? "When the plan is ready, present it with exit_plan_mode. Build mode starts only when the user approves it there." : undefined) }],
    });
  }

  /** The native shell injects the keychain's provider keys into every harness request. */
  setCredentials(credentials: ProviderCredentials | undefined) {
    if (credentials) this.credentials = credentials;
  }

  get running() { return true; }
  owns(sessionId: string) { return this.sessions.has(sessionId); }
  ownsApproval(approvalId: string) { return this.approvals.has(approvalId); }

  isolation(): IsolationReport {
    return { ...describeIsolation(process.cwd(), osSandboxAvailable()), consentRequired: false };
  }

  async start() { /* in-process: nothing to spawn */ }

  async stop() {
    for (const approval of this.approvals.values()) approval.resolve({ kind: "cancelled" });
    this.approvals.clear();
    for (const live of this.sessions.values()) live.controller?.abort();
    this.sessions.clear();
    await this.mcp.close();
  }

  // ─── Models ───────────────────────────────────────────────────────────────

  private credentialKey() {
    const hash = createHash("sha256");
    // Name and wire count too: a renamed or retyped custom endpoint changes the catalog.
    for (const [id, credential] of Object.entries(this.credentials).sort(([a], [b]) => a.localeCompare(b))) hash.update(`${id}\u0000${credential.key ?? ""}\u0000${credential.baseUrl ?? ""}\u0000${credential.name ?? ""}\u0000${credential.wire ?? ""}\u0001`);
    return hash.digest("hex");
  }

  private async fetchJson(provider: ResolvedProvider, path: string): Promise<Json> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const headers: Record<string, string> = provider.wire === "anthropic"
        ? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }
        : provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
      const response = await this.fetchImpl(`${provider.root}${path}`, { headers, signal: controller.signal });
      if (!response.ok) {
        const hint = response.status === 401 || response.status === 403 ? " The key was refused." : "";
        throw new Error(`${provider.name} returned ${response.status} listing models.${hint}`);
      }
      return await response.json() as Json;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${provider.name} did not answer in ${LIST_TIMEOUT_MS / 1000}s.`);
      throw error instanceof Error && error.message.startsWith(provider.name) ? error : new Error(`Could not reach ${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async providerModels(provider: ResolvedProvider): Promise<HarnessModel[]> {
    const data = (await this.fetchJson(provider, provider.wire === "anthropic" ? "/models?limit=1000" : "/models")).data;
    const rows = Array.isArray(data) ? data as Json[] : [];
    return rows.map((row): HarnessModel | null => {
      const raw = typeof row.id === "string" ? row.id.replace(/^models\//, "") : "";
      const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters.filter((item): item is string => typeof item === "string") : null;
      const kiloUntooled = provider.id === "kilo" && parameters != null && !parameters.includes("tools");
      if (!raw || NOT_CHAT.test(raw) || (provider.id === "cline" && NOT_CLINE_CHAT.test(raw)) || (provider.id === "kilo" && (NOT_KILO_CHAT.test(raw) || kiloUntooled))) return null;
      const pricing = row.pricing as { prompt?: string; completion?: string } | undefined;
      // A negative price is a sentinel (Kilo's auto routers), not a rate.
      const perMillion = (value?: string) => {
        const amount = Number(value);
        return value != null && Number.isFinite(amount) && amount >= 0 ? String(Math.round(amount * 1_000_000 * 1000) / 1000) : null;
      };
      const tiers = effortTiers(provider.id, raw);
      const listedWindow = typeof row.context_length === "number" ? row.context_length : null;
      return {
        modelId: `${provider.id}/${raw}`,
        displayLabel: typeof row.display_name === "string" ? row.display_name : typeof row.name === "string" ? row.name : raw,
        providerId: provider.id,
        description: provider.name,
        contextLimit: contextWindow(provider.id, raw, listedWindow),
        cost: pricing && perMillion(pricing.prompt) != null ? { input: perMillion(pricing.prompt)!, output: perMillion(pricing.completion) ?? "0", currency: "USD" } : null,
        reasoningEfforts: TIERS.filter((tier) => (tiers as string[]).includes(tier)),
        ...(tiers.length ? { defaultReasoningEffort: tiers.includes("medium") ? "medium" : tiers[Math.floor(tiers.length / 2)] } : {}),
        effortSource: "host",
      };
    }).filter((model): model is HarnessModel => Boolean(model));
  }

  /** A sensible first model: the newest mainstream coding model from the first provider that has one. */
  private markDefault(models: HarnessModel[]): HarnessModel[] {
    const preferences = [/anthropic\/claude-sonnet/, /anthropic\/claude-opus/, /anthropic\/claude/, /openai\/gpt-5(?!.*(nano|mini))/, /openai\/gpt-4\.1$/, /google\/gemini-.*pro/, /xai\/grok-4/, /deepseek\/deepseek-chat/, /nvidia\/moonshotai\/kimi-k[\d.]+$/, /nvidia\/z-ai\/glm-[\d.]+$/, /nvidia\/nvidia\/nemotron-[\d.]+-super/, /./];
    let pick: HarnessModel | undefined;
    for (const pattern of preferences) {
      const hits = models.filter((model) => pattern.test(model.modelId));
      // A gateway's `~vendor/…-latest` alias is a pointer, not a release. Prefer a named model when one matches.
      const named = hits.filter((model) => !model.modelId.includes("/~"));
      const pool = named.length ? named : hits;
      if (pool.length) { pick = pool.sort((a, b) => b.modelId.localeCompare(a.modelId, undefined, { numeric: true }))[0]; break; }
    }
    return models.map((model) => ({ ...model, isDefault: model === pick }));
  }

  private async loadCatalog(refresh: boolean): Promise<HarnessModel[]> {
    const key = this.credentialKey();
    if (!refresh && this.catalog && this.catalog.key === key && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.models;
    if (this.catalogLoading?.key === key && !refresh) return this.catalogLoading.run;
    const providers = configuredProviders(this.credentials);
    if (!providers.length) throw new Error(`${HARNESS_NAME} has no model provider yet. Add an API key in Settings → Providers.`);
    const run = (async () => {
      const results = await Promise.allSettled(providers.map((provider) => this.providerModels(provider)));
      const models = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
      if (!models.length) throw new Error(failures.join(" ") || "No chat models were listed.");
      if (failures.length) this.emit("agentNotice", { level: "warning", message: failures.join(" ") });
      const marked = this.markDefault(models);
      this.catalog = { key, at: Date.now(), models: marked };
      return marked;
    })();
    this.catalogLoading = { key, run };
    try { return await run; } finally { if (this.catalogLoading?.run === run) this.catalogLoading = null; }
  }

  async listModels(sessionId?: string, refresh = false): Promise<{ models: HarnessModel[]; source: string; modes: typeof MODES; defaultMode: string }> {
    const models = await this.loadCatalog(refresh);
    const active = sessionId ? this.sessions.get(sessionId)?.meta.modelId : undefined;
    return { models: active ? models.map((model) => ({ ...model, isActive: model.modelId === active })) : models, source: sessionId ? "session" : "catalog", modes: MODES, defaultMode: "build" };
  }

  private async defaultModel(): Promise<string | undefined> {
    const models = await this.loadCatalog(false).catch(() => []);
    return models.find((model) => model.isDefault)?.modelId ?? models[0]?.modelId;
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────

  private config(live: Live) {
    return { modelId: live.meta.modelId, effort: live.meta.effort, mode: live.meta.mode ?? "build", modes: MODES };
  }

  async listSessions(workspaceRoot?: string) {
    // Delegated children are part of their parent's transcript, not threads of
    // their own, so they never appear in the sidebar.
    const rows = (await this.store.list(workspaceRoot)).filter((meta) => !meta.delegation);
    return { sessions: rows.map((meta) => ({ sessionId: meta.sessionId, name: meta.title, workspaceRoot: meta.workspaceRoot, updatedAt: meta.updatedAt, status: this.sessions.get(meta.sessionId)?.prompting ? "running" : "idle" })) };
  }

  async startSession(options: { workspaceRoot: string; modelId?: string; effort?: string; mode?: string; approvalMode?: string }) {
    if (!options.workspaceRoot) throw new Error("A workspace is required.");
    const modelId = options.modelId && splitModelId(options.modelId).providerId ? options.modelId : await this.defaultModel();
    const now = new Date().toISOString();
    const meta: SessionMeta = { sessionId: `h-${randomUUID()}`, workspaceRoot: options.workspaceRoot, title: null, createdAt: now, updatedAt: now, ...(modelId ? { modelId } : {}), ...(options.effort ? { effort: options.effort } : {}), mode: options.mode === "plan" ? "plan" : "build" };
    await this.store.create(meta);
    const live = this.track(meta, [], options.approvalMode);
    return { sessionId: meta.sessionId, opening: { result: { session: { sessionId: meta.sessionId, workspaceRoot: meta.workspaceRoot, modelId: modelId ?? null, providerId: modelId ? splitModelId(modelId).providerId : null } } }, agentConfig: this.config(live) };
  }

  private track(meta: SessionMeta, messages: ChatMessage[], approvalMode?: string): Live {
    const live: Live = { meta, messages, approvalMode: APPROVAL_MODES.has(approvalMode as ApprovalMode) ? approvalMode as ApprovalMode : "promptUnmatched", grants: [], prompting: false, controller: null, turnId: "idle", counter: 0, usage: { promptTokens: meta.usage?.promptTokens ?? 0, outputTokens: meta.usage?.outputTokens ?? 0, cacheReadTokens: meta.usage?.cacheReadTokens ?? 0, cacheWriteTokens: meta.usage?.cacheWriteTokens ?? 0 }, queue: [], steering: [], replacing: false, repeatCount: 0 };
    this.sessions.set(meta.sessionId, live);
    return live;
  }

  async resumeSession(options: { sessionId: string; workspaceRoot: string; approvalMode?: string }) {
    const open = this.sessions.get(options.sessionId);
    if (open) return { sessionId: options.sessionId, alreadyOpen: true, agentConfig: this.config(open), userInputs: this.openQuestions(open) };
    const meta = await this.store.meta(options.sessionId);
    if (!meta) throw new Error("This thread's history is no longer on this device.");
    if (meta.workspaceRoot !== options.workspaceRoot) throw new Error("That thread belongs to another workspace.");
    const { messages, items, question, delegation } = await this.store.read(options.sessionId);
    // The log is authoritative for a child's scope: if the index lost the
    // stamp, restore it and persist it, never adopt the caller's mode.
    const policy = meta.delegation ?? delegation;
    if (policy && !meta.delegation) {
      meta.delegation = policy;
      meta.mode = policy.planMode ? "plan" : "build";
      await this.store.update(options.sessionId, { delegation: policy, mode: meta.mode });
    }
    const live = this.track(meta, messages, policy ? policy.approvalMode : options.approvalMode);
    // Replay the transcript exactly as it was recorded; nothing runs again.
    live.question = question;
    // The call a pending question belongs to is still open: it completes when the question is answered.
    for (const item of items) this.emit("item", { sessionId: options.sessionId, item: { ...item, status: item.status === "inProgress" && item.itemId !== question?.itemId ? "cancelled" : item.status } });
    this.emitUsage(live);
    return { sessionId: options.sessionId, alreadyOpen: false, opening: { result: { session: { sessionId: options.sessionId, workspaceRoot: meta.workspaceRoot, modelId: meta.modelId ?? null } } }, agentConfig: this.config(live), userInputs: this.openQuestions(live) };
  }

  async closeSession(options: { sessionId: string }) {
    const live = this.sessions.get(options.sessionId);
    live?.controller?.abort();
    this.sessions.delete(options.sessionId);
    return { closed: true };
  }

  private requireLive(sessionId: string) {
    const live = this.sessions.get(sessionId);
    if (!live) throw new Error("Session is not open. Reopen the thread.");
    return live;
  }

  private async changed(live: Live, patch: Partial<SessionMeta>) {
    Object.assign(live.meta, patch);
    await this.store.update(live.meta.sessionId, patch);
    const config = this.config(live);
    if (!live.muted) this.emit("agentConfig", { sessionId: live.meta.sessionId, config });
    return { status: "accepted", agentConfig: config };
  }

  async setModel(options: { sessionId: string; modelId: string }) {
    const live = this.requireLive(options.sessionId);
    if (!splitModelId(options.modelId).providerId) throw new Error("Pick a model from the list.");
    return this.changed(live, { modelId: options.modelId });
  }

  async setEffort(sessionId: string, effort: string) {
    return this.changed(this.requireLive(sessionId), { effort });
  }

  async setMode(sessionId: string, mode: string) {
    const live = this.requireLive(sessionId);
    if (live.meta.delegation) throw new Error("A delegated task keeps the mode it was created with.");
    return this.changed(live, { mode: mode === "plan" ? "plan" : "build" });
  }

  async setOption(sessionId: string, option: string, value: string) {
    if (option === "effort") return this.setEffort(sessionId, value);
    if (option === "mode") return this.setMode(sessionId, value);
    throw new Error(`${HARNESS_NAME} has no ${option} option.`);
  }

  setApprovalMode(sessionId: string, mode: string) {
    const live = this.requireLive(sessionId);
    if (!APPROVAL_MODES.has(mode as ApprovalMode)) throw new Error("Unknown permission mode.");
    // A child's permission was fixed when it was created; widening it here
    // would be exactly the escalation delegation is meant to prevent.
    if (live.meta.delegation) throw new Error("A delegated task keeps the permission mode it was created with.");
    live.approvalMode = mode as ApprovalMode;
    // Widening or narrowing the mode resets thread grants.
    live.grants = [];
    return { status: "accepted", effectiveMode: { mode } };
  }

  // ─── Delegation ───────────────────────────────────────────────────────────

  /** A child below the cap may hand off once more; a child at the cap gets no task tool. */
  canDelegate(context: TurnContext): boolean {
    return (context.delegationDepth ?? 0) < MAX_DELEGATION_DEPTH;
  }

  /**
   * Run one self-contained task in a child session. The child shares this
   * host's turn loop and workspace, but gets the narrowed profile for its
   * depth, a step cap, the parent's permission mode fixed for its life, and no
   * approval channel: anything the mode would ask about is refused.
   */
  async delegate(context: TurnContext, request: DelegationRequest, signal?: AbortSignal): Promise<DelegationResult> {
    const parent = this.requireLive(context.sessionId);
    if (!this.canDelegate(context)) throw new Error("This agent cannot delegate any further.");
    if (request.model && !splitModelId(request.model).providerId) throw new Error("Pick a model from the list.");
    if (signal?.aborted) throw new Error("The user stopped this turn.");
    const depth = (context.delegationDepth ?? 0) + 1;
    const profile = depth >= MAX_DELEGATION_DEPTH ? DELEGATE_LEAF_PROFILE : DELEGATE_PROFILE;
    const planMode = parent.meta.mode === "plan";
    const now = new Date().toISOString();
    const childSessionId = `h-${randomUUID()}`;
    // Stamped in the child's index row and in its own log: the scope is
    // reconstructable from either, and neither is ever widened later.
    const delegation: DelegationPolicy = { parentSessionId: parent.meta.sessionId, depth, profile, approvalMode: parent.approvalMode, planMode };
    const modelId = request.model ?? parent.meta.modelId;
    const meta: SessionMeta = {
      sessionId: childSessionId,
      workspaceRoot: parent.meta.workspaceRoot,
      title: request.description,
      createdAt: now,
      updatedAt: now,
      ...(modelId ? { modelId } : {}),
      ...(parent.meta.effort ? { effort: parent.meta.effort } : {}),
      mode: planMode ? "plan" : "build",
      delegation,
    };
    await this.store.create(meta);
    await this.store.append(childSessionId, [{ type: "delegation", delegation }]);
    const child = this.track(meta, [], delegation.approvalMode);
    child.muted = true;
    const turnId = this.mintTurnId();
    const itemId = this.itemId(parent, "subagent");
    const started = Date.now();
    // The durable catalog lives in the parent's log: a child is discoverable
    // here without opening or waking it.
    this.emitItem(parent, { itemId, kind: "subagent", status: "inProgress", role: "delegate", objective: request.description, childSessionId, readOnly: true, controlStatus: "running", turnId: parent.turnId }, true);
    const user: ChatMessage = { role: "user", content: this.userContent(request.prompt) };
    child.messages.push(user);
    child.turnId = turnId;
    await this.store.append(childSessionId, [{ type: "message", message: user }]);
    this.emitItem(child, { itemId: `${childSessionId}:${turnId}:user`, kind: "userMessage", status: "completed", text: request.prompt, turnId }, true);
    child.prompting = true;
    let run: { outcome: Json; text: string; capped: boolean };
    try {
      run = await this.runTurn(child, turnId, { stepCap: MAX_DELEGATED_STEPS, profileId: profile, signal });
    } finally {
      this.sessions.delete(childSessionId);
    }
    const params = run.outcome.params as { terminal?: string; error?: { message?: string } } | undefined;
    const failed = run.outcome.kind === "failed";
    const stopped = !failed && params?.terminal === "cancelled";
    const error = params?.error?.message ?? "The delegated task failed.";
    const text = failed || stopped ? [run.text, stopped ? "The user stopped this turn." : error].filter(Boolean).join("\n\n") : run.text;
    this.emitItem(parent, {
      itemId,
      kind: "subagent",
      status: stopped ? "cancelled" : failed ? "failed" : "completed",
      role: "delegate",
      objective: request.description,
      childSessionId,
      readOnly: true,
      controlStatus: failed || stopped ? "failed" : "resultReady",
      turnId: parent.turnId,
      durationMs: Date.now() - started,
      ...(failed || stopped
        ? { failureReason: stopped ? "The user stopped this turn." : error }
        : { result: { summary: request.description, text: run.text, artifactRefs: [], evidenceRefs: [] } }),
    }, true);
    return { childSessionId, text, failed: failed || stopped, capped: run.capped };
  }

  /** A delegated child's transcript, read through the parent's session binding. */
  async readChildSession(options: { sessionId: string; childSessionId: string; excludeItems?: boolean }) {
    const child = await this.store.meta(options.childSessionId);
    if (!child?.delegation || child.delegation.parentSessionId !== options.sessionId) throw new Error("That session is not a delegated child of this thread.");
    const { items } = await this.store.read(options.childSessionId);
    return {
      session: { sessionId: child.sessionId, workspaceRoot: child.workspaceRoot, modelId: child.modelId ?? null, title: child.title },
      history: { items: options.excludeItems ? [] : items },
    };
  }

  // ─── Turns ────────────────────────────────────────────────────────────────

  private itemId(live: Live, kind: string) {
    return `${live.meta.sessionId}:${live.turnId}:${kind}:${++live.counter}`;
  }

  private emitUsage(live: Live) {
    if (live.muted) return;
    const { promptTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = live.usage;
    this.emit("sessionFacts", {
      sessionId: live.meta.sessionId,
      usage: {
        promptTokens,
        outputTokens,
        totalTokens: promptTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        ...(cacheReadTokens ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
      },
    });
  }

  private emitItem(live: Live, item: Json, persist = false) {
    // A muted child still writes its transcript: the parent's drill-down reads
    // it from disk, and the log is the durable child catalog.
    if (!live.muted) this.emit("item", { sessionId: live.meta.sessionId, item });
    if (persist) void this.store.append(live.meta.sessionId, [{ type: "item", item }]).catch(() => {});
  }

  /**
   * One model call's own facts, for the app's per-call trajectory. Accounting
   * lives in the app's ledger, so the session log keeps no copy of it.
   */
  private emitCall(live: Live, call: Json) {
    if (live.muted) return;
    this.emit("modelCall", { sessionId: live.meta.sessionId, turnId: live.turnId, call });
  }

  private mintTurnId() {
    return `turn-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  }

  private userContent(text: string, images?: Array<{ mediaType: string; base64Data: string }>): ContentPart[] {
    const content: ContentPart[] = [];
    if (text.trim()) content.push({ type: "text", text });
    for (const image of images ?? []) content.push({ type: "image", mediaType: image.mediaType, data: image.base64Data });
    return content;
  }

  /** Drop in-flight approvals and abort the model call. Does not touch the queue. */
  private stopInFlight(live: Live) {
    for (const [id, approval] of this.approvals) {
      if (approval.sessionId !== live.meta.sessionId) continue;
      approval.resolve({ kind: "cancelled" });
      this.approvals.delete(id);
    }
    live.controller?.abort();
  }

  private get homeDir() { return this.limits.homeDir ?? homedir(); }

  /** Skills the thread's workspace and the home folder provide, as rows the composer and Extensions list. */
  listSkills(options: { sessionId: string }) {
    const live = this.requireLive(options.sessionId);
    return { skills: discoverSkills(live.meta.workspaceRoot, this.homeDir).map((skill) => ({ selector: skill.name, description: skill.description, source: skill.scope })) };
  }

  /** The MCP servers this thread's workspace sees. `refresh` re-reads the config files even when the fingerprint matches. */
  async mcpStatus(options: { sessionId: string; refresh?: boolean }) {
    const live = this.requireLive(options.sessionId);
    await this.mcp.ensure(live.meta.workspaceRoot, options.sessionId, options.refresh === true);
    return this.mcp.status(live.meta.workspaceRoot);
  }

  /** The effective server rows for the Extensions screen, including ones the parser refused. Secret values are never returned. */
  async mcpConfig(options: { sessionId: string }) {
    const live = this.requireLive(options.sessionId);
    return readMcpConfig(live.meta.workspaceRoot, this.homeDir);
  }

  /** Add a server to one config file, then return the effective rows. */
  async addMcpServer(options: { sessionId: string; scope: McpScope; server: McpServerInput }) {
    const live = this.requireLive(options.sessionId);
    await writeMcpServer(live.meta.workspaceRoot, this.homeDir, options.scope, options.server);
    return this.mcpConfig(options);
  }

  /** Remove a server from one config file, then return the effective rows. */
  async removeMcpServer(options: { sessionId: string; scope: McpScope; name: string }) {
    const live = this.requireLive(options.sessionId);
    await eraseMcpServer(live.meta.workspaceRoot, this.homeDir, options.scope, options.name);
    return this.mcpConfig(options);
  }

  async sendTurn(options: { sessionId: string; text: string; reasoningEffort?: string; images?: Array<{ mediaType: string; base64Data: string }>; ifBusy?: "queue" | "steer" | "replace"; skill?: SkillInvocation }) {
    const live = this.requireLive(options.sessionId);
    // A typed `/skill` is expanded now, so a queued turn runs the skill as it was when sent.
    const expanded = options.skill ? expandInvocation(live.meta.workspaceRoot, this.homeDir, options.skill, options.text) : undefined;
    const text = expanded?.content ?? options.text;
    const display = expanded?.display ?? options.text;
    const request = { text, images: options.images, effort: options.reasoningEffort, ...(expanded ? { display } : {}) };
    if (live.prompting) {
      if (options.ifBusy === "queue") {
        const turnId = this.mintTurnId();
        live.queue.push({ turnId, ...request });
        return { turnId, disposition: "queued" as const };
      }
      if (options.ifBusy === "steer") {
        if (!text.trim() && !options.images?.length) throw new Error("A message is required to steer the turn.");
        live.steering.push({ text, images: options.images });
        // The transcript shows it now. The model sees it at the next tool boundary.
        this.emitItem(live, { itemId: `${live.turnId}:steer:${randomUUID().slice(0, 8)}`, kind: "userMessage", status: "completed", text: display, turnId: live.turnId }, true);
        return { turnId: live.turnId, disposition: "steered" as const };
      }
      if (options.ifBusy === "replace") {
        const turnId = this.mintTurnId();
        live.replacing = true;
        live.steering = [];
        live.queue.unshift({ turnId, ...request });
        this.stopInFlight(live);
        return { turnId, disposition: "started" as const };
      }
      throw new Error(`${HARNESS_NAME} is still working on the previous message.`);
    }
    if (options.ifBusy === "steer") throw new Error("There is no running turn to steer into. Send normally to start one.");
    const turnId = this.mintTurnId();
    await this.beginTurn(live, { turnId, ...request }, false);
    return { turnId, disposition: "started" as const };
  }

  /** Fold a message into the running turn. Same admission as `sendTurn` with `ifBusy: "steer"`. */
  steerTurn(options: { sessionId: string; text: string; reasoningEffort?: string; images?: Array<{ mediaType: string; base64Data: string }>; skill?: SkillInvocation }) {
    return this.sendTurn({ ...options, ifBusy: "steer" });
  }

  /** Drop a follow-up that has not started. */
  unqueueTurn(options: { sessionId: string; turnId: string }) {
    const live = this.requireLive(options.sessionId);
    const index = live.queue.findIndex((entry) => entry.turnId === options.turnId);
    if (index < 0) throw new Error("That turn is not queued.");
    live.queue.splice(index, 1);
    this.emit("turnCompleted", { sessionId: options.sessionId, turnId: options.turnId, outcome: { kind: "unqueued" } });
    return { turnId: options.turnId, unqueued: true as const };
  }

  /** Start one turn. `prompting` is set before the first await so a second send cannot slip in. */
  private async beginTurn(live: Live, request: TurnRequest, fromQueue: boolean) {
    live.prompting = true;
    let durable = false;
    const user: ChatMessage = { role: "user", content: this.userContent(request.text, request.images) };
    try {
      live.turnId = request.turnId;
      if (request.effort && request.effort !== live.meta.effort) await this.changed(live, { effort: request.effort });
      // An unanswered question is settled first, so its result sits ahead of this message.
      await this.settleQuestion(live, { action: "superseded" });
      // A steer left over from the previous turn belongs ahead of this prompt.
      await this.flushSteering(live);
      live.messages.push(user);
      this.resetRepeat(live);
      await this.store.append(live.meta.sessionId, [{ type: "message", message: user }]);
      durable = true;
      this.emitItem(live, { itemId: `${request.turnId}:user`, kind: "userMessage", status: "completed", text: request.display ?? request.text, turnId: request.turnId }, true);
      if (!live.meta.title) {
        const title = (request.display ?? request.text).trim().split("\n")[0].slice(0, 80) || "New thread";
        live.meta.title = title;
        void this.store.update(live.meta.sessionId, { title });
        this.emit("sessionTitle", { sessionId: live.meta.sessionId, title });
      } else {
        void this.store.update(live.meta.sessionId, {});
      }
      if (fromQueue) this.emit("turnStarted", { sessionId: live.meta.sessionId, turnId: request.turnId });
      // Sync before the snapshot, so this turn sees the config as it is now. A
      // broken config reports and keeps the previous complete generation.
      await this.mcp.ensure(live.meta.workspaceRoot, live.meta.sessionId);
      void this.runTurn(live, request.turnId);
    } catch (error) {
      if (!durable) {
        const tail = live.messages.at(-1);
        if (tail === user) live.messages.pop();
        live.prompting = false;
      }
      throw error;
    }
  }

  /** Start the next queued follow-up, if the session is still open and idle. */
  private pump(live: Live) {
    if (live.prompting || !this.sessions.has(live.meta.sessionId)) return;
    const next = live.queue.shift();
    if (!next) return;
    void this.beginTurn(live, next, true);
  }

  async cancelTurn(options: { sessionId: string }) {
    const live = this.sessions.get(options.sessionId);
    if (live) {
      live.steering = [];
      this.stopInFlight(live);
    }
    for (let waited = 0; live?.prompting && waited < 3000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    return { status: "terminal" as const };
  }

  decideApproval(options: { approvalId: string; choiceId: string }) {
    const approval = this.approvals.get(options.approvalId);
    if (!approval) throw new Error("No pending approval with that id.");
    if (!approvalAlive(approval.expiresAtMono)) {
      this.approvals.delete(options.approvalId);
      approval.resolve({ kind: "expired" });
      this.emit("approvalAudit", { approvalId: options.approvalId, sessionId: approval.sessionId, turnId: approval.turnId, choiceId: options.choiceId, outcome: "expired" });
      throw new Error("This approval expired. Re-run the turn to request it again.");
    }
    const outcome = approval.choices.get(options.choiceId);
    if (!outcome) throw new Error("That approval choice is not available.");
    this.approvals.delete(options.approvalId);
    approval.resolve(outcome);
    this.emit("approvalAudit", { approvalId: options.approvalId, sessionId: approval.sessionId, turnId: approval.turnId, choiceId: options.choiceId, outcome: "decided" });
    return { decided: true };
  }

  /**
   * The stable half is what a provider can cache: identity, workspace, and project rules.
   * The volatile half is the date and the mode, which may change without rewriting that prefix.
   * Read once per turn so a mid-turn edit of AGENTS.md does not bust the cache on the next step.
   */
  private async systemPrompt(live: Live, turn: TurnContributions): Promise<SystemPrompt> {
    let rules = "";
    try { rules = (await readFile(join(live.meta.workspaceRoot, "AGENTS.md"), "utf8")).slice(0, 20_000); } catch { /* no project rules */ }
    const stable = [
      `You are ${HARNESS_NAME}, a coding agent working in the user's local workspace through tools. You are running inside a desktop app; the user sees your tool calls and replies as they happen.`,
      `Workspace root: ${live.meta.workspaceRoot}. Platform: ${platform()}.`,
      ...turn.prompt.stable,
      "Paths are relative to the workspace root. Tools cannot reach outside it, and the shell cannot write outside it.",
      "The user may refuse a tool call; if so, adjust instead of retrying the same call. Never claim to have run or changed something you did not.",
      "Reply in concise Markdown. When you finish, summarise what changed and anything left to do.",
      rules ? `Project rules from AGENTS.md:\n\n${rules}` : "",
    ].filter(Boolean).join("\n\n");
    const volatile = [
      `Date: ${new Date().toISOString().slice(0, 10)}.`,
      live.meta.mode === "plan" ? "PLAN MODE: do not edit files. Investigate, then reply with a concrete plan the user can approve. Read-only commands are fine." : "",
      ...turn.prompt.volatile,
    ].filter(Boolean).join("\n\n");
    return { stable, volatile };
  }

  /** Move steered messages into the model history. The transcript item was emitted when the steer was accepted. */
  private async flushSteering(live: Live): Promise<boolean> {
    if (!live.steering.length) return false;
    const batch = live.steering.splice(0);
    const records: Array<{ type: "message"; message: ChatMessage }> = [];
    for (const item of batch) {
      const message: ChatMessage = { role: "user", content: this.userContent(item.text, item.images) };
      live.messages.push(message);
      records.push({ type: "message", message });
    }
    await this.store.append(live.meta.sessionId, records);
    this.resetRepeat(live);
    return true;
  }

  /** A user message ends a repeat chain. The next tool call starts a new one. */
  private resetRepeat(live: Live) {
    live.repeatKey = undefined;
    live.repeatCount = 0;
  }

  /**
   * Count this call, including one that will be denied, then return the note
   * to fold onto its result. Never blocks the call.
   */
  private observeRepeat(live: Live, name: string, input: Record<string, unknown>): string | undefined {
    const key = JSON.stringify([name, canonicalize(input)]);
    if (live.repeatKey === key) live.repeatCount += 1;
    else { live.repeatKey = key; live.repeatCount = 1; }
    const args = JSON.stringify(canonicalize(input));
    return repeatReminder(name, live.repeatCount, args);
  }

  private withRepeat(output: string, reminder?: string) {
    return reminder ? `${output}\n\n${reminder}` : output;
  }

  /** Keep a diff small enough to store on the transcript item. The model already has the prose. */
  private itemPresentation(meta: PresentationMeta | undefined): PresentationMeta | undefined {
    if (!meta) return undefined;
    const cap = 32_000;
    const out: PresentationMeta = { kind: meta.kind };
    if (meta.path) out.path = meta.path;
    if (meta.command) out.command = meta.command;
    if (meta.exitCode != null) out.exitCode = meta.exitCode;
    if (meta.truncated) out.truncated = true;
    if (meta.artifactPath) out.artifactPath = meta.artifactPath;
    if (typeof meta.oldText === "string" && meta.oldText.length <= cap) out.oldText = meta.oldText;
    if (typeof meta.newText === "string" && meta.newText.length <= cap) out.newText = meta.newText;
    return out;
  }

  /** Long threads keep their recent tool output in full and shorten older output. */
  private history(live: Live): ChatMessage[] {
    return clipRecency(live.messages);
  }

  /** Ask the user about one call. Thread choices come from the policy, narrowest first. */
  private ask(live: Live, call: ToolCall, kind: ToolKind, subject: Subject, verdict: Extract<Verdict, { kind: "ask" }>): Promise<ApprovalOutcome> {
    // A delegated child has no one to answer: its asks fail closed rather than
    // waiting on a card the app never shows for it.
    if (this.limits.approvalChannel === false || live.meta.delegation) return Promise.resolve({ kind: "unavailable" });
    const approvalId = randomUUID();
    const choices = [
      { choiceId: "allow-once", label: "Allow once", decision: "approved", scope: "once" },
      ...verdict.scopes.map((scope) => ({ choiceId: scope.choiceId, label: scope.label, scopeLabel: scope.scopeLabel, decision: "approved", scope: "session" })),
      { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
    ];
    const outcomes = new Map<string, ApprovalOutcome>([
      ["allow-once", { kind: "allowed" }],
      ...verdict.scopes.map((scope): [string, ApprovalOutcome] => [scope.choiceId, { kind: "allowed", grant: scope.grant }]),
      ["deny", { kind: "rejected" }],
    ]);
    return new Promise((resolve) => {
      this.approvals.set(approvalId, { sessionId: live.meta.sessionId, turnId: live.turnId, choices: outcomes, expiresAtMono: approvalExpiryMono(), resolve });
      const expiry = setTimeout(() => {
        const approval = this.approvals.get(approvalId);
        if (!approval) return;
        this.approvals.delete(approvalId);
        this.emit("approvalResolved", { approvalId, sessionId: live.meta.sessionId });
        this.emit("approvalAudit", { approvalId, sessionId: live.meta.sessionId, turnId: live.turnId, choiceId: null, outcome: "expired" });
        resolve({ kind: "expired" });
      }, APPROVAL_TTL_MS);
      expiry.unref?.();
      this.emit("approval", {
        approvalId,
        sessionId: live.meta.sessionId,
        turnId: live.turnId,
        toolName: call.name,
        rawArgs: JSON.stringify(call.input),
        subject: subject.kind === "mcp"
          ? { kind: "mcp", server: subject.server, tool: subject.tool, path: `${subject.server} › ${subject.tool}`, ...(verdict.risk ? { risk: verdict.risk } : {}) }
          : { kind: kind === "shell" ? "command" : "edit", ...(verdict.risk ? { risk: verdict.risk } : {}) },
        expiresAt: approvalExpiry(),
        availableChoices: choices,
      });
    });
  }

  private toolBase(live: Live, call: ToolCall, input: Record<string, unknown>): Json {
    const path = typeof input.path === "string" ? input.path : undefined;
    const command = typeof input.command === "string" ? input.command : undefined;
    return { itemId: `${live.meta.sessionId}:${live.turnId}:tool:${call.id}`, kind: "toolCall", tool: call.name, turnId: live.turnId, args: JSON.stringify({ ...input, ...(path ? { path } : {}) }), ...(command ? { commandText: command } : {}) };
  }

  /** Record that a call is about to run, before any side effect, so a crash can tell "never started" from "outcome unknown". */
  private async markStarted(live: Live, call: ToolCall) {
    await this.store.append(live.meta.sessionId, [{ type: "toolStarted", id: call.id }]);
    call.started = true;
  }

  /** Run a hook for this turn. A handler that throws becomes a warning; the turn carries on. */
  private async hook<E extends HookName>(turn: TurnContributions, hook: E, payload: HookEvents[E]) {
    this.reportHookFailures(turn, await turn.runHook(hook, payload));
  }

  private reportHookFailures(turn: TurnContributions, failures: HookFailure[]) {
    for (const failure of failures) {
      if (this.sessions.get(turn.context.sessionId)?.muted) continue;
      this.emit("agentNotice", { sessionId: turn.context.sessionId, level: "warning", message: `The ${failure.extensionId} extension failed in ${failure.hook}: ${failure.message}` });
    }
  }

  private async runTurn(live: Live, turnId: string, options: { stepCap?: number; profileId?: string; signal?: AbortSignal } = {}): Promise<{ outcome: Json; text: string; capped: boolean }> {
    const controller = new AbortController();
    const parentSignal = options.signal;
    const linkAbort = () => controller.abort();
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener("abort", linkAbort, { once: true });
    }
    live.controller = controller;
    const sessionId = live.meta.sessionId;
    const stepCap = options.stepCap ?? MAX_STEPS;
    let outcome: Json = { kind: "completed", params: { terminal: "completed" } };
    const cancelled = () => { outcome = { kind: "completed", params: { terminal: "cancelled" } }; };
    let turn: TurnContributions | undefined;
    let text = "";
    let capped = false;
    try {
      // Before the first await, so a registry change made during this turn waits for the next one.
      turn = this.registry.snapshot({ sessionId, turnId, workspaceRoot: live.meta.workspaceRoot, mode: live.meta.mode === "plan" ? "plan" : "build", delegationDepth: live.meta.delegation?.depth ?? 0 }, options.profileId);
      const contributions = turn;
      await this.hook(contributions, "turnStarted", { context: contributions.context });
      // Once per turn: a mid-turn edit of AGENTS.md must not change the cached prefix.
      const system = await this.systemPrompt(live, contributions);
      // Deferred tools (MCP) stay out of every request until tool_search names
      // them; an activated name is advertised for the rest of this turn.
      const active = new Set<string>();
      const offered = () => contributions.schemas.filter((schema) => !contributions.tools.get(schema.name)?.deferred || active.has(schema.name));
      for (let step = 0; step < stepCap; step += 1) {
        if (controller.signal.aborted) { cancelled(); break; }
        // Steering that arrived during tools waits until the results are in the history.
        await this.flushSteering(live);
        if (controller.signal.aborted) { cancelled(); break; }
        const modelId = live.meta.modelId ?? await this.defaultModel();
        if (!modelId) throw new Error(`${HARNESS_NAME} has no model to use. Add a provider key in Settings → Providers.`);
        if (!live.meta.modelId) await this.changed(live, { modelId });
        const { providerId, model } = splitModelId(modelId);
        const provider = resolveProvider(providerId, this.credentials);
        if (!provider) throw new ProviderError(`${providerSpec(providerId)?.name ?? providerId} has no key. Add it in Settings → Providers, or pick another model.`, undefined, "MISSING_CREDENTIAL");
        // The listed window beats the family default, so the catalog is loaded before it is consulted.
        const window = (await this.loadCatalog(false).catch(() => [])).find((row) => row.modelId === modelId)?.contextLimit ?? contextWindow(provider.id, model);
        const { message: reply, stopReason } = await this.callModel(live, provider, modelId, model, system, offered(), controller.signal, window);
        live.messages.push(reply);
        await this.store.append(sessionId, [{ type: "message", message: reply }]);
        // A cut-off reply can carry valid JSON that is still an incomplete tool call. Do not run it.
        if (isTruncatedStop(stopReason) && reply.toolCalls?.length) {
          const results = reply.toolCalls.map((call) => {
            const output = truncatedToolResult(call.name);
            this.emitItem(live, { ...this.toolBase(live, call, call.input), status: "failed", failureReason: output, visibleOutput: output }, true);
            return { id: call.id, name: call.name, output, isError: true as const };
          });
          const message: ChatMessage = { role: "tool", results };
          live.messages.push(message);
          await this.store.append(sessionId, [{ type: "message", message }]);
          if (step === stepCap - 1) {
            capped = true;
            if (!live.muted) this.emit("agentNotice", { sessionId, level: "warning", message: `${HARNESS_NAME} stopped after ${stepCap} steps. Send a message to continue.` });
          }
          continue;
        }
        if (!reply.toolCalls?.length) {
          // A steer that arrived while the model was writing should still be answered.
          if (live.steering.length) continue;
          text = reply.text;
          break;
        }
        const calls = reply.toolCalls;
        const reminders = calls.map((call) => this.observeRepeat(live, call.name, call.input));
        const stopped = (index: number) => ({ id: calls[index].id, name: calls[index].name, output: this.withRepeat("The user stopped this turn.", reminders[index]), isError: true as const });
        const results = await scheduleToolCalls({
          safe: calls.map((call) => executionMode(contributions.tools.get(call.name)) === "concurrent"),
          signal: controller.signal,
          onAborted: stopped,
          run: (index) => {
            if (controller.signal.aborted) return Promise.resolve(stopped(index));
            return this.runToolCall(live, contributions, calls[index], controller.signal, reminders[index]);
          },
        });
        for (const result of results) {
          for (const name of result.activate ?? []) if (contributions.tools.has(name)) active.add(name);
        }
        if (results.some((result) => result.question)) {
          // The turn ends with the questions. Their answer completes this tool message in a new turn.
          await this.parkQuestion(live, turnId, results);
          break;
        }
        const message: ChatMessage = { role: "tool", results };
        live.messages.push(message);
        await this.store.append(sessionId, [{ type: "message", message }]);
        if (step === stepCap - 1) {
          capped = true;
          if (!live.muted) this.emit("agentNotice", { sessionId, level: "warning", message: `${HARNESS_NAME} stopped after ${stepCap} steps. Send a message to continue.` });
        }
      }
      if (controller.signal.aborted) cancelled();
    } catch (error) {
      outcome = controller.signal.aborted
        ? { kind: "completed", params: { terminal: "cancelled" } }
        : { kind: "failed", params: { terminal: "failed", error: { message: error instanceof Error ? error.message : String(error) } } };
    } finally {
      // A steer accepted in the last moment stays in history. Cancel and replace drop what was not flushed.
      if (controller.signal.aborted) live.steering = [];
      else await this.flushSteering(live).catch(() => {});
      // While the turn still holds the session, so no next turn starts before its observers have run.
      const finished = turn ? await turn.runHook("turnFinished", { context: turn.context, outcome }) : [];
      const startNext = live.replacing || !controller.signal.aborted;
      live.replacing = false;
      live.prompting = false;
      live.controller = null;
      void this.store.update(sessionId, {});
      if (!live.muted) this.emit("agentNotice", { sessionId, message: null });
      // After the notice is cleared, or the warning would vanish with it.
      if (turn) this.reportHookFailures(turn, finished);
      if (!live.muted) this.emit("turnCompleted", { sessionId, turnId, outcome });
      // After turnCompleted, which clears a thread's questions in the app. A queued message settles it at once.
      if (!live.muted && live.question?.turnId === turnId) this.emit("userInputs", { sessionId, requests: [questionRequest(sessionId, live.question)], turnEnded: true });
      if (startNext) this.pump(live);
    }
    parentSignal?.removeEventListener("abort", linkAbort);
    return { outcome, text, capped };
  }

  /** One model call, streamed into reasoning and message items, with retries for transient failures. */
  private async callModel(live: Live, provider: ResolvedProvider, modelId: string, model: string, system: SystemPrompt, tools: readonly ToolSchema[], signal: AbortSignal, window: number | null): Promise<{ message: AssistantMessage; stopReason: string }> {
    let effort = live.meta.effort && (live.meta.effort !== "none" || SENDS_NONE.has(provider.id)) ? live.meta.effort : undefined;
    const tiers = effortTiers(provider.id, model) as string[];
    if (effort && !tiers.includes(effort)) effort = undefined;
    const startedAt = Date.now();
    const cap = this.limits.retryElapsedMs ?? RETRY_ELAPSED_MS;
    // The window is only known for catalog and family-known models. Unknown means no fitting: current behaviour, unchanged.
    const budget = window ? contextBudget(window) : null;
    // System prompt and tool schemas never change within a call, so their cost is measured once.
    const fixedTokens = budget ? estimateRequestTokens({ system, messages: [], tools }) : 0;
    // The request view, re-fitted per attempt: a retry after an overflow fits the already-trimmed
    // view again, so each attempt is strictly smaller than the one the provider rejected.
    let view: ChatMessage[] | undefined;
    for (let attempt = 1; ; attempt += 1) {
      const streams: { reasoning?: { itemId: string; text: string }; text?: { itemId: string; text: string } } = {};
      // This call's own counts. Cache fields stay put when a later event omits them.
      const spent = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const attemptAt = Date.now();
      const close = () => {
        for (const kind of ["reasoning", "text"] as const) {
          const open = streams[kind];
          if (open) this.emitItem(live, { itemId: open.itemId, kind: kind === "text" ? "agentMessage" : "reasoning", status: "completed", text: open.text, turnId: live.turnId }, true);
        }
      };
      // Fit the request into the window before sending. Trimming is a request view:
      // the transcript keeps full output, and the model is told what was shortened.
      // `view` persists across attempts, so a retry after an overflow fits the
      // already-trimmed view again — each attempt strictly smaller than the last.
      view ??= this.history(live);
      const fitted = budget ? fitHistory({ messages: view, budget: Math.max(1, budget.input - fixedTokens) }) : { messages: view, trimmed: false, tokens: 0 };
      view = fitted.messages;
      if (fitted.trimmed && !live.muted && !live.contextNotified) {
        live.contextNotified = true;
        this.emit("agentNotice", { sessionId: live.meta.sessionId, level: "info", message: "The thread's history was shortened to fit the model's context window; the full transcript keeps everything." });
      }
      try {
        for await (const event of streamChat({ provider, modelId, system, messages: fitted.messages, tools, effort, signal, timeouts: { idleMs: this.limits.idleMs, firstEventMs: this.limits.firstEventMs }, fetchImpl: this.fetchImpl })) {
          if (event.type === "text" || event.type === "reasoning") {
            const kind = event.type;
            // A reply that switches from thinking to text closes the thinking item first.
            if (kind === "text" && streams.reasoning && !streams.text) {
              const open = streams.reasoning;
              this.emitItem(live, { itemId: open.itemId, kind: "reasoning", status: "completed", text: open.text, turnId: live.turnId }, true);
              streams.reasoning = undefined;
            }
            const open = streams[kind];
            if (!open) {
              const itemId = this.itemId(live, kind === "text" ? "agentMessage" : "reasoning");
              streams[kind] = { itemId, text: event.delta };
              this.emitItem(live, { itemId, kind: kind === "text" ? "agentMessage" : "reasoning", status: "inProgress", text: event.delta, turnId: live.turnId });
            } else {
              open.text += event.delta;
              if (!live.muted) this.emit("delta", { sessionId: live.meta.sessionId, itemId: open.itemId, field: "text", delta: event.delta });
            }
          } else if (event.type === "usage") {
            if (event.inputTokens != null) spent.input = event.inputTokens;
            if (event.outputTokens != null) spent.output = event.outputTokens;
            if (event.cacheReadTokens != null) spent.cacheRead = event.cacheReadTokens;
            if (event.cacheWriteTokens != null) spent.cacheWrite = event.cacheWriteTokens;
            const reportedInput = event.inputTokens != null || event.cacheReadTokens != null || event.cacheWriteTokens != null;
            const window = this.catalog?.models.find((row) => row.modelId === modelId)?.contextLimit ?? contextWindow(provider.id, model);
            if (reportedInput && window && !live.muted) {
              this.emit("sessionFacts", {
                sessionId: live.meta.sessionId,
                context: {
                  usedTokens: spent.input + spent.cacheRead + spent.cacheWrite,
                  windowTokens: window,
                  ...(spent.cacheRead ? { cacheReadTokens: spent.cacheRead } : {}),
                  ...(spent.cacheWrite ? { cacheWriteTokens: spent.cacheWrite } : {}),
                },
              });
            }
          } else if (event.type === "done") {
            close();
            if (spent.input || spent.output || spent.cacheRead || spent.cacheWrite) {
              live.usage = {
                promptTokens: live.usage.promptTokens + spent.input,
                outputTokens: live.usage.outputTokens + spent.output,
                cacheReadTokens: live.usage.cacheReadTokens + spent.cacheRead,
                cacheWriteTokens: live.usage.cacheWriteTokens + spent.cacheWrite,
              };
              this.emitUsage(live);
              void this.store.update(live.meta.sessionId, { usage: live.usage });
            }
            this.emitCall(live, {
              at: attemptAt,
              providerId: provider.id,
              modelId,
              ...(effort ? { effort } : {}),
              inputTokens: spent.input + spent.cacheRead + spent.cacheWrite,
              cachedTokens: spent.cacheRead + spent.cacheWrite,
              outputTokens: spent.output,
              ...(event.stopReason ? { stopReason: event.stopReason } : {}),
              durationMs: Date.now() - attemptAt,
              // Only a retried call says so: the first attempt is the normal case.
              ...(attempt > 1 ? { attempt } : {}),
              toolCalls: event.message.toolCalls?.length ?? 0,
            });
            return { message: event.message, stopReason: event.stopReason };
          }
        }
        close();
        throw new ProviderError(`${provider.name} ended the reply early.`);
      } catch (error) {
        close();
        if (signal.aborted) throw error;
        const status = error instanceof ProviderError ? error.status : undefined;
        const message = error instanceof Error ? error.message : String(error);
        // A model that rejects the reasoning setting gets one retry without it.
        if (effort && status === 400 && /thinking|reasoning|effort|budget/i.test(message)) {
          effort = undefined;
          if (!live.muted) this.emit("agentNotice", { sessionId: live.meta.sessionId, level: "info", message: `${model} does not accept that effort level; continuing without it.` });
          continue;
        }
        // An input overflow cannot be retried as-is: the bytes are the problem. The provider's
        // real count is higher than our estimate (that is why it overflowed), so the refit is
        // not budget-driven: every result that is not a skeleton yet becomes one, which is
        // strictly smaller no matter what any tokenizer says. A view already at the bottom
        // fails at once, which keeps the overflow code non-retryable in effect; ordinary
        // transient errors keep their backoff and their budget.
        const overflow = error instanceof ProviderError && (error.code === "CONTEXT_WINDOW_EXCEEDED" || (error.status === 400 && CONTEXT_WINDOW.test(message)));
        if (overflow) {
          const tighter = budget ? fitHistory({ messages: view, budget: 1 }) : null;
          if (tighter?.trimmed) {
            view = tighter.messages;
            if (!live.muted) this.emit("agentNotice", { sessionId: live.meta.sessionId, level: "warning", message: `${message} Shortening the thread's history further and retrying.` });
            continue;
          }
          throw error;
        }
        const transient = error instanceof ProviderError ? isTransientProviderError(error) : true;
        if (transient && retryBudgetOpen(Date.now() - startedAt, attempt, cap)) {
          const wait = Math.min(20_000, 1500 * 2 ** (attempt - 1));
          if (!live.muted) this.emit("agentNotice", { sessionId: live.meta.sessionId, level: "warning", message: `${message} Retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 1} of ${RETRIES + 1}).` });
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, wait);
            signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true });
          });
          continue;
        }
        throw error;
      }
    }
  }

  private async runToolCall(live: Live, turn: TurnContributions, call: ToolCall, signal: AbortSignal, reminder?: string): Promise<CallResult> {
    const noted = (output: string) => this.withRepeat(output, reminder);
    const definition = turn.tools.get(call.name);
    if (!definition) {
      const output = noted(`Unknown tool: ${call.name}`);
      this.emitItem(live, { ...this.toolBase(live, call, call.input), status: "failed", failureReason: output, visibleOutput: output }, true);
      return { id: call.id, name: call.name, output, isError: true };
    }
    const kind = definition.kind;
    const prepared = await prepareTool(definition, live.meta.workspaceRoot, call.input);
    if (prepared.error) {
      const output = noted(prepared.error);
      this.emitItem(live, { ...this.toolBase(live, call, prepared.input), status: "failed", failureReason: output, visibleOutput: output }, true);
      return { id: call.id, name: call.name, output, isError: true };
    }
    // The card and the handler share this object. The assistant message is already on disk with the same fields.
    const frozen = prepared.input;
    call.input = frozen;
    const base = this.toolBase(live, call, frozen);
    // Plan bookkeeping shows as the plan card, not as a step. A delegated task
    // shows as its child card, which `delegate` writes with the same turn.
    if (kind !== "plan" && kind !== "delegate") this.emitItem(live, { ...base, status: "inProgress" });
    let subject: Subject | undefined;
    try { subject = definition.subject?.(live.meta.workspaceRoot, frozen) ?? { kind: "none" }; } catch { /* refused below */ }
    // Guards first, in every mode: the policy below never sees a call they refused.
    const refusal = subject ? runGuards(turn.guards, { toolName: call.name, kind, subject }) : "A permission check failed, so this call was refused.";
    const verdict: Verdict = refusal || !subject ? { kind: "deny", reason: refusal ?? "" } : decide({ kind, subject, mode: live.approvalMode, planMode: live.meta.mode === "plan", grants: live.grants });
    if (verdict.kind === "deny") {
      const output = noted(verdict.reason);
      this.emitItem(live, { ...base, status: "failed", failureReason: output, visibleOutput: output }, true);
      return { id: call.id, name: call.name, output, isError: true };
    }
    if (verdict.kind === "ask") {
      const outcome = await this.ask(live, call, kind, subject ?? { kind: "none" }, verdict);
      if (outcome.kind !== "allowed") {
        const output = noted(REFUSALS[outcome.kind]);
        this.emitItem(live, { ...base, status: outcome.kind === "cancelled" ? "cancelled" : "failed", failureReason: output, visibleOutput: output }, true);
        return { id: call.id, name: call.name, output, isError: true };
      }
      if (outcome.grant) live.grants.push(outcome.grant);
    }
    if (this.limits.beforeTool) await this.limits.beforeTool(call.name);
    const observed = { id: call.id, name: call.name, input: frozen };
    await this.hook(turn, "toolStarting", { context: turn.context, call: observed });
    if (signal.aborted) {
      const output = noted("The user stopped this turn.");
      this.emitItem(live, { ...base, status: "cancelled", failureReason: output, visibleOutput: output }, true);
      return { id: call.id, name: call.name, output, isError: true };
    }
    await this.markStarted(live, call);
    // Frozen before observers see it: a hook cannot rewrite what the model or the card receives.
    const result = Object.freeze(await executeTool(definition, live.meta.workspaceRoot, frozen, signal, { canRead: true }));
    await this.hook(turn, "toolFinished", { context: turn.context, call: observed, outcome: result });
    const output = noted(result.output);
    const visible = noted(result.display ?? result.output);
    if (result.question) return { id: call.id, name: call.name, output: "", question: result.question, item: base };
    if (result.plan) {
      if (!live.muted) this.emit("sessionFacts", { sessionId: live.meta.sessionId, plan: result.plan.map((todo, index) => ({ id: `plan-${index}`, text: todo.content, status: todo.status === "in_progress" ? "inProgress" : todo.status })) });
      return { id: call.id, name: call.name, output };
    }
    const presentation = this.itemPresentation(result.presentation);
    if (kind !== "delegate") this.emitItem(live, {
      ...base,
      status: result.isError ? "failed" : "completed",
      visibleOutput: visible,
      ...(presentation ? { presentation } : {}),
      ...(presentation?.truncated ? { truncated: true } : {}),
      ...(result.exitCode != null ? { exitCode: result.exitCode } : {}),
      ...(result.isError ? { failureReason: visible.split("\n")[0].slice(0, 300) } : {}),
    }, true);
    return { id: call.id, name: call.name, output, ...(result.isError ? { isError: true } : {}), ...(result.activate?.length ? { activate: result.activate } : {}) };
  }

  /** The question this thread is waiting on, as the app's card renders it. */
  private openQuestions(live: Live) {
    return live.question ? [questionRequest(live.meta.sessionId, live.question)] : [];
  }

  /** Record that a turn ended asking the user. Only the first ask in a batch stands. */
  private async parkQuestion(live: Live, turnId: string, results: CallResult[]) {
    const asked = results.findIndex((result) => result.question);
    const refusal = "Only one set of questions can wait at a time. Ask them together in one ask_user call.";
    for (const [index, result] of results.entries()) {
      if (index === asked || !result.question) continue;
      if (result.item) this.emitItem(live, { ...result.item, status: "failed", failureReason: refusal, visibleOutput: refusal }, true);
      results[index] = { id: result.id, name: result.name, output: refusal, isError: true };
    }
    const ask = results[asked];
    const pending: PendingQuestion = {
      userInputId: `q-${randomUUID()}`,
      turnId,
      callId: ask.id,
      toolName: ask.name,
      itemId: String(ask.item?.itemId ?? ""),
      item: ask.item ?? {},
      questions: ask.question?.questions ?? [],
      ...(ask.question?.intent ? { intent: ask.question.intent } : {}),
      results: results.map(({ id, name, output, isError }) => ({ id, name, output, ...(isError ? { isError } : {}) })),
    };
    live.question = pending;
    // The open card is written too: in-progress items are not persisted, and a reopened thread must still show it.
    await this.store.append(live.meta.sessionId, [{ type: "item", item: { ...pending.item, status: "inProgress" } }, { type: "question", question: pending }]);
  }

  /**
   * Complete the pending question's tool message from how the user settled it.
   * Throws, changing nothing, when the answers do not fit the questions.
   */
  private async settleQuestion(live: Live, response: UserInputResponse | { action: "superseded" }) {
    const pending = live.question;
    if (!pending) return undefined;
    const settled = settlement(pending, response);
    const message: ChatMessage = { role: "tool", results: pending.results.map((result) => (result.id === pending.callId ? { id: result.id, name: result.name, output: settled.output } : result)) };
    live.question = undefined;
    live.messages.push(message);
    await this.store.append(live.meta.sessionId, [{ type: "message", message }, { type: "questionSettled", userInputId: pending.userInputId }]);
    this.emitItem(live, { ...pending.item, status: "completed", visibleOutput: settled.summary }, true);
    this.emit("userInputs", { sessionId: live.meta.sessionId, requests: [] });
    return settled;
  }

  /** The user settled the question the last turn ended with: record it, then continue in a new turn. */
  async respondUserInput(options: { sessionId: string; userInputId: string; response: UserInputResponse }) {
    const live = this.requireLive(options.sessionId);
    if (live.question?.userInputId !== options.userInputId) throw new Error("This question is no longer pending. Reopen the thread to refresh it.");
    if (live.prompting) throw new Error(`${HARNESS_NAME} is still working. Answer when the turn ends.`);
    // Claimed before the first await, so a message sent meanwhile queues behind this turn.
    live.prompting = true;
    let turnId: string | undefined;
    try {
      const settled = await this.settleQuestion(live, options.response);
      // An approved plan leaves Plan mode before the next turn's snapshot, so edits are allowed in it.
      if (settled?.leavePlanMode) await this.changed(live, { mode: "build" });
      if (settled?.continueTurn) {
        turnId = this.mintTurnId();
        live.turnId = turnId;
        // Plan feedback is the user's own message: it goes in as one, and the transcript shows it.
        if (settled.feedback) {
          const message: ChatMessage = { role: "user", content: this.userContent(settled.feedback) };
          live.messages.push(message);
          await this.store.append(live.meta.sessionId, [{ type: "message", message }]);
          this.emitItem(live, { itemId: `${turnId}:user`, kind: "userMessage", status: "completed", text: settled.feedback, turnId }, true);
        }
      }
    } catch (error) {
      live.prompting = false;
      throw error;
    }
    if (!turnId) {
      // A plan kept without feedback waits for the user's next message, and costs no model call.
      live.prompting = false;
      this.pump(live);
      return { status: "accepted" as const, userInputId: options.userInputId };
    }
    this.resetRepeat(live);
    this.emit("turnStarted", { sessionId: live.meta.sessionId, turnId, cause: "userInput" });
    void this.runTurn(live, turnId);
    return { status: "accepted" as const, userInputId: options.userInputId, turnId };
  }

  /**
   * One tool-less, off-transcript completion for predictive suggestions. It
   * reads no files: the prompt carries the workspace facts the app chose.
   */
  async suggest(options: { workspaceRoot: string; prompt: string; modelId?: string; timeoutMs?: number }) {
    const modelId = options.modelId && splitModelId(options.modelId).providerId ? options.modelId : await this.defaultModel();
    if (!modelId) throw new Error(`${HARNESS_NAME} has no model for suggestions.`);
    const { providerId } = splitModelId(modelId);
    const provider = resolveProvider(providerId, this.credentials);
    if (!provider) throw new ProviderError(`${providerSpec(providerId)?.name ?? providerId} has no key.`, undefined, "MISSING_CREDENTIAL");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
    timer.unref?.();
    let text = "";
    try {
      for await (const event of streamChat({ provider, modelId, system: { stable: "Answer exactly in the format requested. Do not use tools.", volatile: "" }, messages: [{ role: "user", content: [{ type: "text", text: options.prompt }] }], tools: [], signal: controller.signal, fetchImpl: this.fetchImpl })) {
        if (event.type === "text") text += event.delta;
      }
    } finally {
      clearTimeout(timer);
    }
    return { text };
  }

  /**
   * Settings → Models' Test: a one-word, tool-less, off-transcript request, so
   * a busy or retired model shows up before a thread depends on it. The reply
   * is cut to a short line; only the timing and that line come back.
   */
  async testModel(options: { modelId: string; timeoutMs?: number }) {
    const { providerId } = splitModelId(options.modelId);
    if (!providerId) throw new Error(`${options.modelId} does not name a provider.`);
    const provider = resolveProvider(providerId, this.credentials);
    if (!provider) throw new ProviderError(`${providerSpec(providerId)?.name ?? providerId} has no key.`, undefined, "MISSING_CREDENTIAL");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    timer.unref?.();
    const started = Date.now();
    let firstTokenMs: number | null = null;
    let text = "";
    try {
      for await (const event of streamChat({ provider, modelId: options.modelId, system: { stable: "Reply with one word.", volatile: "" }, messages: [{ role: "user", content: [{ type: "text", text: "Reply with the word: ready" }] }], tools: [], signal: controller.signal, fetchImpl: this.fetchImpl })) {
        if ((event.type === "text" || event.type === "reasoning") && firstTokenMs === null) firstTokenMs = Date.now() - started;
        if (event.type === "text") text += event.delta;
      }
    } catch (error) {
      if (controller.signal.aborted) throw new ProviderError(`No reply within ${Math.round((options.timeoutMs ?? 30_000) / 1000)} seconds.`, undefined, "TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return { latencyMs: Date.now() - started, firstTokenMs, reply: text.trim().replace(/\s+/g, " ").slice(0, 80) };
  }
}
