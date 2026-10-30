import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import { approvalAlive, approvalExpiry, approvalExpiryMono, APPROVAL_TTL_MS, describeIsolation, osSandboxAvailable, type IsolationReport } from "../isolation.js";
import { clipRecency, contextBudget, estimateRequestTokens, fitHistory } from "./context.js";
import type { Grant, Subject } from "./permission/grants.js";
import { runGuards } from "./permission/guards.js";
import { decide, type ApprovalMode, type Verdict } from "./permission/policy.js";
import { SENDS_NONE, TIERS, configuredProviders, defaultEffortTier, effortTiers, providerSpec, resolveProvider, splitModelId, type ProviderCredentials, type ResolvedProvider } from "./providers.js";
import { ExtensionRegistry, type HookEvents, type HookFailure, type HookName, type TurnContext, type TurnContributions } from "./registry.js";
import type { UserInputResponse } from "../protocol.js";
import { McpManager, addMcpServer as writeMcpServer, mcpExtension, readMcpConfig, removeMcpServer as eraseMcpServer, type McpAuthorization, type McpScope, type McpServerInput } from "./mcp.js";
import { DELEGATE_LEAF_PROFILE, DELEGATE_PROFILE, MAX_DELEGATED_STEPS, MAX_DELEGATION_DEPTH, delegationExtension, type DelegationRequest, type DelegationResult } from "./delegation.js";
import { ASK_USER_TOOL, EXIT_PLAN_TOOL, planReviewQuestion, questionRequest, settlement, type Asked, type PendingQuestion } from "./questions.js";
import { discoverSkills, expandInvocation, skillsExtension } from "./skills.js";
import { SessionStore, type BuilderSessionRecord, type DelegationPolicy, type PendingSteer, type SessionMeta } from "./store.js";
import { BUILTIN_EXTENSION, BUILTIN_TOOLS, canonicalize, confine, executeTool, executionMode, prepareTool, repeatReminder, scheduleToolCalls, type PresentationMeta, type ToolKind } from "./tools.js";
import { CONTEXT_WINDOW, ProviderError, isTransientProviderError, isTruncatedStop, streamChat, truncatedToolResult, type AssistantMessage, type ChatMessage, type ContentPart, type ImagePart, type SystemPrompt, type ToolCall, type ToolSchema } from "./wire.js";
import { PROBE_CONTENT, PROBE_DONE, PROBE_FILE, PROBE_VERSION, createProbeStore, findProbe, isProbeRole, probeNeeded, recordProbe, roleCapabilitiesFromProbes, runProbe, type ProbeRequest, type ProbeResponse, type ProbeResult, type ProbeRole, type ProbeStore } from "./orchestrator/probes.js";
import { parseRouterAssessment } from "./orchestrator/assessment.js";
import { catalogCapabilities } from "./orchestrator/capabilities.js";
import { resolveEffortTarget } from "./orchestrator/effort.js";
import { ASK_LEAD_TOOL, LEAD_CONSULT_INSTRUCTIONS, leadConsultPrompt, stuckConsultPrompt } from "./orchestrator/consult.js";
import { parseContextPack, parsePlan, parseReviewNotes, validateBuildReport, type BuildReport, type ContextPack, type OrchestratorPlan, type ReviewNotes } from "./orchestrator/handoffs.js";
import { sanitizeHistory } from "./orchestrator/history.js";
import { continuationAssessment, createRouteRecord, decideRoute, preRoute } from "./orchestrator/policy.js";
import { approvedPlanFromHistory, pendingPlanFromHistory, planMarkdown, type StagedPlan } from "./orchestrator/plan-mode.js";
import { builderInstructions, LEAD_PLAN_INSTRUCTIONS, LEAD_PLAN_READ_INSTRUCTIONS, LEAD_REVIEW_INSTRUCTIONS, leadExecutionNote, leadPlanPrompt, leadPlanReadPrompt, leadPlanRetryPrompt, leadReviewPrompt, repairInstructions } from "./orchestrator/prompts.js";
import { ROUTER_SYSTEM, routerEnvelope, type RouterRecentTurn } from "./orchestrator/router.js";
import { SCOUT_INSTRUCTIONS, scoutPackSummary, scoutPrompt, scoutRetryPrompt } from "./orchestrator/scout.js";
import { normalizeOrchestratorSettings } from "./orchestrator/settings.js";
import { createStuckState, observeStuck, planChecksSignal, rearmStuck, stepLimitSignal, type StuckObservation, type StuckSignal } from "./orchestrator/stuck.js";
import { READ_ONLY_TOOL_NAMES } from "./orchestrator/read.js";
import { neutralEntries, threadBrief } from "./orchestrator/transcript.js";
import { resolveOrchestratorTuning } from "./orchestrator/tuning.js";
import type {
  EffortTarget,
  OrchestratorCapability,
  OrchestratorModel,
  OrchestratorRole,
  OrchestratorSettings,
  OrchestratorShape,
  OrchestratorStage,
  OrchestratorTuning,
  RoutePolicyDecision,
  RouteRecord,
  RouteStageRecord,
  RouterAssessment,
  RouterFailure,
} from "./orchestrator/types.js";

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

type CatalogModel = HarnessModel & { listedReasoning?: boolean };

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

/** Changed-line counts from a common prefix and suffix; a bounded work estimate, not a real diff. */
function lineDelta(oldText: string, newText: string): { added: number; removed: number } {
  const before = oldText ? oldText.split("\n") : [];
  const after = newText ? newText.split("\n") : [];
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return { added: after.length - prefix - suffix, removed: before.length - prefix - suffix };
}

const MAX_PATCH_LINES = 200;
const MAX_REPORT_DIFF_CHARS = 60_000;

/**
 * One hunk around the changed span. It is intentionally a presentation of the
 * edit, not a git patch: enough for the Lead to judge the change, bounded so a
 * large rewrite cannot dominate the review prompt.
 */
function linePatch(path: string, oldText: string, newText: string): string | undefined {
  const before = oldText ? oldText.split("\n") : [];
  const after = newText ? newText.split("\n") : [];
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const oldLines = before.slice(prefix, before.length - suffix);
  const newLines = after.slice(prefix, after.length - suffix);
  if (!oldLines.length && !newLines.length) return undefined;
  const cut = oldLines.length > MAX_PATCH_LINES || newLines.length > MAX_PATCH_LINES;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${prefix + 1},${Math.min(oldLines.length, MAX_PATCH_LINES)} +${prefix + 1},${Math.min(newLines.length, MAX_PATCH_LINES)} @@`,
    ...oldLines.slice(0, MAX_PATCH_LINES).map((line) => `-${line}`),
    ...newLines.slice(0, MAX_PATCH_LINES).map((line) => `+${line}`),
    ...(cut ? ["… (patch shortened)"] : []),
  ].join("\n");
}
const CATALOG_TTL_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 15_000;
/** First-turn role checks get a shorter budget than a Settings-initiated check. */
const ROUTE_PROBE_TIMEOUT_MS = 60_000;
/** Classification is one short call; it must not hold a turn open. */
const ROUTER_TIMEOUT_MS = 30_000;
/** The Lead session is durable but bounded; older exchanges are compacted. */
const MAX_LEAD_SESSION_MESSAGES = 80;
const MAX_LEAD_SESSION_CHARS = 240_000;
/** Image bytes do not count against the text budget; the context fitter still sees the part. */
const IMAGE_SESSION_WEIGHT = 4_000;

function messageWeight(message: ChatMessage): number {
  if (message.role !== "user") return JSON.stringify(message).length;
  return message.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : IMAGE_SESSION_WEIGHT), 0);
}
const ORCHESTRATOR_ROLE_NAME: Record<OrchestratorRole, string> = { lead: "Lead", builder: "Builder", small: "Small-task" };

function unfittableContextError(): ProviderError {
  return new ProviderError(
    "The request cannot fit the model's context window, even after all available history trimming. The full transcript is preserved. Start a new thread or choose a model with a larger context window.",
    undefined,
    "CONTEXT_WINDOW_EXCEEDED",
  );
}

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
  /** This message's override; floors still apply to it. */
  forcedShape?: OrchestratorShape;
};

type SteerRequest = PendingSteer;

type SkillInvocation = { selector: string; arguments?: string };

/** The routed task a pending question belongs to; the answer continues in the same shape. */
type OpenTask = { shape: OrchestratorShape; assessment?: RouterAssessment };

/** The role a routed turn executes as, for one model call's accounting. */
type CallRoute = { routeId: string; role: OrchestratorRole; stage: OrchestratorStage; effort?: string };

/** A plan or review call: its own message list, no transcript items and no thread context reading. */
type CallOptions = { messages?: readonly ChatMessage[]; emitText?: boolean; emitContext?: boolean };

type TurnRoute = {
  record: RouteRecord;
  assessment?: RouterAssessment;
  role: OrchestratorRole;
  stage: OrchestratorStage;
  modelId: string;
  providerId: string;
  effort?: string;
};

type ExecutionStage = {
  role: OrchestratorRole;
  stage: OrchestratorStage;
  model: OrchestratorModel;
  executedShape: OrchestratorShape;
  effort?: string;
};

/** One model stage in a routed turn, with the record row its call reports against. */
type StageRoute = {
  routeId: string;
  record: RouteStageRecord;
  role: OrchestratorRole;
  stage: OrchestratorStage;
  model: OrchestratorModel;
  effort?: string;
};

/** What one tool call changed, as the Builder reports it to the Lead. */
type ToolObservation = {
  path?: string;
  command?: string;
  exitCode?: number;
  oldText?: string;
  newText?: string;
};

type BuildObservations = {
  files: Map<string, { added: number; removed: number }>;
  checks: BuildReport["checks"];
  /** Bounded hunks for the review; never shown as a tool item. */
  patches: string[];
};

/** Durable, user-visible handoff documents in the turn's trajectory. */
type HandoffItemKind = "orchestratorPlan" | "orchestratorContextPack" | "orchestratorBuildReport" | "orchestratorReview" | "orchestratorConsult";

type RouteResolution = {
  record: RouteRecord;
  route?: TurnRoute;
  assessment?: RouterAssessment;
  decision?: RoutePolicyDecision;
  /** Set when the policy found no role that can cover the request. */
  blocked?: string;
};

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
  mcpAuthorization: McpAuthorization;
  /** Set by a routed turn so a delegated child defaults to the model actually running. */
  activeModelId?: string;
  /** Set when a routed turn ends asking a question; its answer keeps the shape. */
  openTask?: OpenTask;
  /** A staged plan waiting in the Plan-mode review card. */
  pendingPlan?: StagedPlan & { itemId?: string };
  /** A staged plan the user approved; the next Build turn executes it without re-planning. */
  approvedPlan?: { plan: OrchestratorPlan; itemId?: string };
  /** The Lead's own durable session for this thread. */
  leadMessages: ChatMessage[];
  /** The current plan's fresh Builder session, kept across a user question. */
  builder?: BuilderSessionRecord;
};

/** One call's result. A call that asks the user also carries its questions and its transcript item. */
type CallResult = { id: string; name: string; output: string; isError?: boolean; question?: Asked; item?: Json; activate?: readonly string[]; images?: ImagePart[]; observation?: ToolObservation };

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
  /** Internal Orchestrator tuning for the evaluator and tests; never exposed in Settings. */
  tuning?: unknown;
};

export class HarnessHost {
  readonly spec = { id: HARNESS_ID, name: HARNESS_NAME };
  private credentials: ProviderCredentials = {};
  private sessions = new Map<string, Live>();
  private approvals = new Map<string, Approval>();
  private catalog: { key: string; at: number; models: CatalogModel[] } | null = null;
  /** The listing in flight and the keys it was started with; a newly added key starts a new one. */
  private catalogLoading: { key: string; run: Promise<CatalogModel[]> } | null = null;
  /** Settings' role checks, kept for this host's lifetime. A failed check stays failed until a refresh. */
  private probes: ProbeStore = createProbeStore();
  /** One live check per role and model, so two Settings views never pay for the same probe. */
  private readonly probeRuns = new Map<string, Promise<ProbeResult>>();
  /** Read-tool capability per model; a failed check is cached for this host's lifetime. */
  private readonly readProbes = new Map<string, Promise<{ ok: boolean; detail: string }>>();
  private readonly emit: Emit;
  private readonly tuning: OrchestratorTuning;
  private readonly mcp: McpManager;
  /** Tools, prompt sections and hooks. Each turn works from a snapshot taken when it starts. */
  readonly registry = new ExtensionRegistry();

  constructor(emit: Emit, private readonly store = new SessionStore(), private readonly fetchImpl: typeof fetch = fetch, private readonly limits: HostLimits = {}, private readonly authorization: (sessionId: string) => McpAuthorization | undefined = () => undefined) {
    this.emit = emit;
    this.tuning = resolveOrchestratorTuning(this.limits.tuning);
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

  private async providerModels(provider: ResolvedProvider): Promise<CatalogModel[]> {
    const data = (await this.fetchJson(provider, provider.wire === "anthropic" ? "/models?limit=1000" : "/models")).data;
    const rows = Array.isArray(data) ? data as Json[] : [];
    return rows.map((row): CatalogModel | null => {
      const raw = typeof row.id === "string" ? row.id.replace(/^models\//, "") : "";
      const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters.filter((item): item is string => typeof item === "string") : null;
      const capabilities = row.capabilities as { reasoning?: unknown } | undefined;
      const listedReasoning = typeof capabilities?.reasoning === "boolean" ? capabilities.reasoning : undefined;
      // OpenRouter names each model's accepted levels. `null` means all gateway
      // levels are accepted; an omitted key means the model exposes no effort
      // selection, so the family fallback must not invent one.
      const reasoning = row.reasoning as { supported_efforts?: unknown; default_effort?: unknown } | undefined;
      const listedEfforts = !reasoning
        ? undefined
        : reasoning.supported_efforts === null
          ? [...TIERS]
          : Array.isArray(reasoning.supported_efforts)
            ? reasoning.supported_efforts.filter((item): item is string => typeof item === "string")
            : [];
      const kiloUntooled = provider.id === "kilo" && parameters != null && !parameters.includes("tools");
      if (!raw || NOT_CHAT.test(raw) || (provider.id === "cline" && NOT_CLINE_CHAT.test(raw)) || (provider.id === "kilo" && (NOT_KILO_CHAT.test(raw) || kiloUntooled))) return null;
      const pricing = row.pricing as { prompt?: string; completion?: string } | undefined;
      // A negative price is a sentinel (Kilo's auto routers), not a rate.
      const perMillion = (value?: string) => {
        const amount = Number(value);
        return value != null && Number.isFinite(amount) && amount >= 0 ? String(Math.round(amount * 1_000_000 * 1000) / 1000) : null;
      };
      const tiers = effortTiers(provider.id, raw, provider.wire, listedReasoning, listedEfforts);
      const listedDefault = typeof reasoning?.default_effort === "string" && (tiers as string[]).includes(reasoning.default_effort) ? reasoning.default_effort : undefined;
      const listedWindow = typeof row.context_length === "number" ? row.context_length : null;
      return {
        modelId: `${provider.id}/${raw}`,
        displayLabel: typeof row.display_name === "string" ? row.display_name : typeof row.name === "string" ? row.name : raw,
        providerId: provider.id,
        description: provider.name,
        contextLimit: contextWindow(provider.id, raw, listedWindow),
        cost: pricing && perMillion(pricing.prompt) != null ? { input: perMillion(pricing.prompt)!, output: perMillion(pricing.completion) ?? "0", currency: "USD" } : null,
        reasoningEfforts: TIERS.filter((tier) => (tiers as string[]).includes(tier)),
        ...(tiers.length ? { defaultReasoningEffort: listedDefault ?? defaultEffortTier(raw, tiers) } : {}),
        effortSource: "host",
        ...(listedReasoning !== undefined ? { listedReasoning } : {}),
      };
    }).filter((model): model is CatalogModel => Boolean(model));
  }

  /** A sensible first model: the newest mainstream coding model from the first provider that has one. */
  private markDefault(models: CatalogModel[]): CatalogModel[] {
    const preferences = [/anthropic\/claude-sonnet/, /anthropic\/claude-opus/, /anthropic\/claude/, /openai\/gpt-5(?!.*(nano|mini))/, /openai\/gpt-4\.1$/, /google\/gemini-.*pro/, /xai\/grok-4/, /deepseek\/deepseek-chat/, /nvidia\/moonshotai\/kimi-k[\d.]+$/, /nvidia\/z-ai\/glm-[\d.]+$/, /nvidia\/nvidia\/nemotron-[\d.]+-super/, /./];
    let pick: CatalogModel | undefined;
    for (const pattern of preferences) {
      const hits = models.filter((model) => pattern.test(model.modelId));
      // A gateway's `~vendor/…-latest` alias is a pointer, not a release. Prefer a named model when one matches.
      const named = hits.filter((model) => !model.modelId.includes("/~"));
      const pool = named.length ? named : hits;
      if (pool.length) { pick = pool.sort((a, b) => b.modelId.localeCompare(a.modelId, undefined, { numeric: true }))[0]; break; }
    }
    return models.map((model) => ({ ...model, isDefault: model === pick }));
  }

  private async loadCatalog(refresh: boolean): Promise<CatalogModel[]> {
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
    const orchestrator = live.meta.orchestrator;
    return {
      modelId: live.meta.modelId,
      effort: live.meta.effort,
      mode: live.meta.mode ?? "build",
      modes: MODES,
      orchestrator: orchestrator
        ? { goal: orchestrator.goal, models: { lead: orchestrator.roles.lead, builder: orchestrator.roles.builder, small: orchestrator.roles.small, router: orchestrator.roles.router } }
        : null,
    };
  }

  async listSessions(workspaceRoot?: string) {
    // Delegated children are part of their parent's transcript, not threads of
    // their own, so they never appear in the sidebar.
    const rows = (await this.store.list(workspaceRoot)).filter((meta) => !meta.delegation);
    return { sessions: rows.map((meta) => ({ sessionId: meta.sessionId, name: meta.title, workspaceRoot: meta.workspaceRoot, updatedAt: meta.updatedAt, status: this.sessions.get(meta.sessionId)?.prompting ? "running" : "idle" })) };
  }

  async startSession(options: { workspaceRoot: string; modelId?: string; effort?: string; mode?: string; approvalMode?: string; mcpAuthorization?: McpAuthorization; orchestrator?: unknown }) {
    if (!options.workspaceRoot) throw new Error("A workspace is required.");
    const normalized = options.orchestrator === undefined ? undefined : normalizeOrchestratorSettings(options.orchestrator);
    if (normalized && !normalized.ok) throw new Error(normalized.errors.join(" "));
    const orchestrator = normalized?.ok ? normalized.value : undefined;
    // A routed thread's Lead is its session model: the composer shows one model,
    // and every role call selects its own from the stored settings.
    const modelId = orchestrator ? orchestrator.roles.lead.modelId : options.modelId && splitModelId(options.modelId).providerId ? options.modelId : await this.defaultModel();
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      sessionId: `h-${randomUUID()}`,
      workspaceRoot: options.workspaceRoot,
      title: null,
      createdAt: now,
      updatedAt: now,
      ...(modelId ? { modelId } : {}),
      ...(!orchestrator && options.effort ? { effort: options.effort } : {}),
      mode: options.mode === "plan" ? "plan" : "build",
      ...(orchestrator ? { orchestrator } : {}),
    };
    await this.store.create(meta);
    const live = this.track(meta, [], options.approvalMode);
    live.mcpAuthorization = options.mcpAuthorization ?? this.authorization(live.meta.sessionId) ?? { workspaceTrusted: false };
    return { sessionId: meta.sessionId, opening: { result: { session: { sessionId: meta.sessionId, workspaceRoot: meta.workspaceRoot, modelId: modelId ?? null, providerId: modelId ? splitModelId(modelId).providerId : null } } }, agentConfig: this.config(live) };
  }

  private track(meta: SessionMeta, messages: ChatMessage[], approvalMode?: string): Live {
    const live: Live = { meta, messages, mcpAuthorization: this.authorization(meta.sessionId) ?? { workspaceTrusted: false }, approvalMode: APPROVAL_MODES.has(approvalMode as ApprovalMode) ? approvalMode as ApprovalMode : "promptUnmatched", grants: [], prompting: false, controller: null, turnId: "idle", counter: 0, usage: { promptTokens: meta.usage?.promptTokens ?? 0, outputTokens: meta.usage?.outputTokens ?? 0, cacheReadTokens: meta.usage?.cacheReadTokens ?? 0, cacheWriteTokens: meta.usage?.cacheWriteTokens ?? 0 }, queue: [], steering: [], replacing: false, repeatCount: 0, leadMessages: [] };
    this.sessions.set(meta.sessionId, live);
    return live;
  }

  async resumeSession(options: { sessionId: string; workspaceRoot: string; approvalMode?: string }) {
    const open = this.sessions.get(options.sessionId);
    if (open) return { sessionId: options.sessionId, alreadyOpen: true, agentConfig: this.config(open), userInputs: this.openQuestions(open) };
    const meta = await this.store.meta(options.sessionId);
    if (!meta) throw new Error("This thread's history is no longer on this device.");
    if (meta.workspaceRoot !== options.workspaceRoot) throw new Error("That thread belongs to another workspace.");
    const { messages, items, steering, question, delegation, routes, leadMessages, builder } = await this.store.read(options.sessionId);
    // The log is authoritative for a child's scope: if the index lost the
    // stamp, restore it and persist it, never adopt the caller's mode.
    const policy = meta.delegation ?? delegation;
    if (policy && !meta.delegation) {
      meta.delegation = policy;
      meta.mode = policy.planMode ? "plan" : "build";
      await this.store.update(options.sessionId, { delegation: policy, mode: meta.mode });
    }
    const live = this.track(meta, messages, policy ? policy.approvalMode : options.approvalMode);
    live.steering = steering ?? [];
    // Replay the transcript exactly as it was recorded; nothing runs again.
    live.question = question;
    live.leadMessages = leadMessages ?? [];
    live.builder = builder;
    await this.ensureRoleSessions(live);
    // A staged plan review keeps its validated plan in the synthetic call, so a
    // restart can still approve it; the route restores the shape the build
    // continuation must keep.
    if (question?.intent?.kind === "planReview") {
      const pending = pendingPlanFromHistory(messages, question);
      if (pending) {
        const item = items.find((entry) => entry.kind === "orchestratorPlan" && entry.turnId === question.turnId);
        live.pendingPlan = { ...pending, ...(item?.itemId ? { itemId: String(item.itemId) } : {}) };
      }
    } else if (!question) {
      const approved = approvedPlanFromHistory(messages);
      if (approved) {
        const item = [...items].reverse().find((entry) => entry.kind === "orchestratorPlan");
        live.approvedPlan = { plan: approved, ...(item?.itemId ? { itemId: String(item.itemId) } : {}) };
      }
    }
    if (question) {
      // A pending question's answer must keep the route that asked it, whether
      // it was a plan review or a Builder question.
      const pendingRoute = (routes ?? []).find((entry) => entry.turnId === question.turnId)?.route;
      if (pendingRoute) live.openTask = { shape: pendingRoute.executedShape ?? pendingRoute.shape, assessment: continuationAssessment(pendingRoute) };
    }
    for (const route of routes ?? []) this.emit("route", { sessionId: options.sessionId, turnId: route.turnId, route: route.route });
    // The call a pending question belongs to is still open: it completes when the question is answered.
    for (const item of items) this.emit("item", { sessionId: options.sessionId, item: { ...item, status: item.status === "inProgress" && item.itemId !== question?.itemId ? "cancelled" : item.status } });
    this.emitUsage(live);
    return { sessionId: options.sessionId, alreadyOpen: false, opening: { result: { session: { sessionId: options.sessionId, workspaceRoot: meta.workspaceRoot, modelId: meta.modelId ?? null } } }, agentConfig: this.config(live), userInputs: this.openQuestions(live) };
  }

  async closeSession(options: { sessionId: string }) {
    const live = this.sessions.get(options.sessionId);
    live?.controller?.abort();
    this.sessions.delete(options.sessionId);
    await this.mcp.closeSession(options.sessionId);
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
    if (live.meta.orchestrator) throw new Error("Orchestrator threads use the role models from Settings → Orchestrator.");
    if (!splitModelId(options.modelId).providerId) throw new Error("Pick a model from the list.");
    return this.changed(live, { modelId: options.modelId });
  }

  async setEffort(sessionId: string, effort: string) {
    const live = this.requireLive(sessionId);
    if (live.meta.orchestrator) throw new Error("Orchestrator threads choose each role's effort from its model and the goal.");
    return this.changed(live, { effort });
  }

  /**
   * Switch a live thread between manual models and Orchestrator. Enabling
   * remembers the manual pick and makes the Lead the session model; disabling
   * restores that pick. Role changes apply from the next routed turn.
   */
  async setOrchestrator(options: { sessionId: string; orchestrator?: unknown }) {
    const live = this.requireLive(options.sessionId);
    const current = live.meta.orchestrator;
    if (options.orchestrator === undefined || options.orchestrator === null) {
      if (!current) return { status: "accepted", agentConfig: this.config(live) };
      const manual = live.meta.manual;
      return this.changed(live, {
        orchestrator: undefined,
        manual: undefined,
        ...(manual?.modelId ? { modelId: manual.modelId } : {}),
        effort: manual?.effort,
      });
    }
    const normalized = normalizeOrchestratorSettings(options.orchestrator);
    if (!normalized.ok) throw new Error(normalized.errors.join(" "));
    const orchestrator = normalized.value;
    return this.changed(live, {
      orchestrator,
      // The Lead is the session model the composer shows; only the first switch
      // stashes the manual pick, so re-enabling keeps the original one.
      ...(!current ? { manual: { ...(live.meta.modelId ? { modelId: live.meta.modelId } : {}), ...(live.meta.effort ? { effort: live.meta.effort } : {}) } } : {}),
      modelId: orchestrator.roles.lead.modelId,
      effort: undefined,
    });
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
    // A delegated task defaults to the model actually running this turn, not the
    // thread's Lead slot.
    const modelId = request.model ?? parent.activeModelId ?? parent.meta.modelId;
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

  /**
   * The thread the app is showing. A muted child bills through its open
   * ancestors, so a delegated audit is counted on the turn that started it.
   */
  private surface(live: Live): Live {
    let current = live;
    const seen = new Set<string>();
    while (current.muted && !seen.has(current.meta.sessionId)) {
      seen.add(current.meta.sessionId);
      const parentId = current.meta.delegation?.parentSessionId;
      const parent = parentId ? this.sessions.get(parentId) : undefined;
      if (!parent) break;
      current = parent;
    }
    return current;
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

  /** Add one call's reported tokens to this session and its open ancestors. */
  private accumulateUsage(live: Live, spent: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
    if (!(spent.input || spent.output || spent.cacheRead || spent.cacheWrite)) return;
    let current: Live | undefined = live;
    const seen = new Set<string>();
    while (current && !seen.has(current.meta.sessionId)) {
      seen.add(current.meta.sessionId);
      current.usage = {
        promptTokens: current.usage.promptTokens + spent.input,
        outputTokens: current.usage.outputTokens + spent.output,
        cacheReadTokens: current.usage.cacheReadTokens + spent.cacheRead,
        cacheWriteTokens: current.usage.cacheWriteTokens + spent.cacheWrite,
      };
      void this.store.update(current.meta.sessionId, { usage: current.usage });
      if (!current.muted) break;
      const parentId: string | undefined = current.meta.delegation?.parentSessionId;
      current = parentId ? this.sessions.get(parentId) : undefined;
    }
    this.emitUsage(this.surface(live));
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
    await this.mcp.ensure(live.meta.workspaceRoot, this.mcpAuthorization(live), options.sessionId, options.refresh === true);
    return this.mcp.status(options.sessionId);
  }

  /** Redacted rows stay visible for consent review while startup is denied; values never cross into the renderer. */
  async mcpConfig(options: { sessionId: string }) {
    const live = this.requireLive(options.sessionId);
    return readMcpConfig(live.meta.workspaceRoot, this.homeDir);
  }

  private mcpAuthorization(live: Live) {
    const authorization = this.authorization(live.meta.sessionId);
    if (authorization) live.mcpAuthorization = authorization;
    return live.mcpAuthorization;
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

  async sendTurn(options: { sessionId: string; text: string; reasoningEffort?: string; images?: Array<{ mediaType: string; base64Data: string }>; ifBusy?: "queue" | "steer" | "replace"; skill?: SkillInvocation; forcedShape?: OrchestratorShape }) {
    const live = this.requireLive(options.sessionId);
    // A typed `/skill` is expanded now, so a queued turn runs the skill as it was when sent.
    const expanded = options.skill ? expandInvocation(live.meta.workspaceRoot, this.homeDir, options.skill, options.text) : undefined;
    const text = expanded?.content ?? options.text;
    const display = expanded?.display ?? options.text;
    // Steer folds into the running turn, whose shape is already decided.
    const request = { text, images: options.images, effort: options.reasoningEffort, ...(expanded ? { display } : {}), ...(options.forcedShape && options.ifBusy !== "steer" ? { forcedShape: options.forcedShape } : {}) };
    if (live.prompting) {
      if (options.ifBusy === "queue") {
        const turnId = this.mintTurnId();
        live.queue.push({ turnId, ...request });
        return { turnId, disposition: "queued" as const };
      }
      if (options.ifBusy === "steer") {
        if (!text.trim() && !options.images?.length) throw new Error("A message is required to steer the turn.");
        const itemId = `${live.turnId}:steer:${randomUUID().slice(0, 8)}`;
        const steering = { itemId, text, images: options.images };
        live.steering.push(steering);
        await this.store.append(live.meta.sessionId, [{ type: "steer", steering }]);
        // The transcript shows it now. The model sees it at the next tool boundary.
        this.emitItem(live, { itemId, kind: "userMessage", status: "completed", text: display, turnId: live.turnId }, true);
        return { turnId: live.turnId, disposition: "steered" as const };
      }
      if (options.ifBusy === "replace") {
        const turnId = this.mintTurnId();
        live.replacing = true;
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
      // A new user message is a new task, even while a plan review waits.
      live.approvedPlan = undefined;
      live.pendingPlan = undefined;
      if (live.builder) await this.endBuilderSession(live);
      if (!live.meta.orchestrator && request.effort && request.effort !== live.meta.effort) await this.changed(live, { effort: request.effort });
      // An unanswered question is settled first, so its result sits ahead of this message.
      await this.settleQuestion(live, { action: "superseded" });
      // A new user message is a new task, whatever the question it replaced was about.
      live.openTask = undefined;
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
      // broken config reports and retires the previous generation for future turns.
      await this.mcp.ensure(live.meta.workspaceRoot, this.mcpAuthorization(live), live.meta.sessionId);
      void this.runTurn(live, request.turnId, { prompt: request.display ?? request.text, ...(request.forcedShape ? { forcedShape: request.forcedShape } : {}) });
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
    if (live) this.stopInFlight(live);
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
    try { rules = (await readFile(confine(live.meta.workspaceRoot, "AGENTS.md"), "utf8")).slice(0, 20_000); } catch { /* no readable in-workspace project rules */ }
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
  private async flushSteering(live: Live, push?: (message: ChatMessage) => Promise<void>): Promise<boolean> {
    if (!live.steering.length) return false;
    const batch = live.steering.splice(0);
    for (const item of batch) {
      const message: ChatMessage = { role: "user", content: this.userContent(item.text, item.images) };
      if (push) await push(message);
      else live.messages.push(message);
    }
    await this.store.append(live.meta.sessionId, [{ type: "steerSettled", itemIds: batch.map((item) => item.itemId) }]);
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

  /**
   * Decide a turn's shape before its first model call: an open task keeps its
   * shape, and an open prompt goes to the Router. Roles are checked lazily
   * because the policy treats an unchecked role as unsupported.
   */
  private async resolveTurnRoute(live: Live, prompt: string, openTask: OpenTask | undefined, signal: AbortSignal, forcedShape?: OrchestratorShape): Promise<RouteResolution | undefined> {
    const settings = live.meta.orchestrator;
    if (!settings || live.meta.delegation) return undefined;
    const routeId = `r-${randomUUID()}`;
    const attachments = this.currentAttachments(live);
    const requiredCapabilities: OrchestratorCapability[] = attachments.some((attachment) => attachment.mediaType.startsWith("image/")) ? ["vision"] : [];
    const routed = preRoute({ prompt, ...(openTask ? { openTask } : {}), ...(forcedShape ? { forcedShape } : {}), attachments });
    const checked = await this.ensureRoleProbes(settings, signal);
    if (checked && !live.muted) {
      this.emit("agentNotice", { sessionId: live.meta.sessionId, level: "info", message: "Checked the Orchestrator role models; later turns reuse the result until you change a model." });
    }
    let assessment: RouterAssessment | undefined = routed.decided ? routed.assessment : undefined;
    let failure: RouterFailure | undefined;
    let routerStage: RouteStageRecord | undefined;
    if (!routed.decided) {
      const router = settings.roles.router;
      const effort = await this.effortFor(router.modelId, "low");
      try {
        const result = await this.runRouterCall(live, routeId, router, effort, prompt, openTask, attachments, signal);
        routerStage = { providerId: router.providerId, modelId: router.modelId, stage: "router", ...(result.effort ? { effectiveEffort: result.effort } : {}) };
        const parsed = parseRouterAssessment(result.text);
        if (parsed.ok) assessment = parsed.value;
        else failure = "invalid-json";
      } catch (error) {
        if (signal.aborted) throw error;
        failure = "unavailable";
        routerStage = { providerId: router.providerId, modelId: router.modelId, stage: "router" };
      }
    }
    const decision = decideRoute({
      goal: settings.goal,
      roleCapabilities: roleCapabilitiesFromProbes({
        roles: { lead: settings.roles.lead, builder: settings.roles.builder, small: settings.roles.small },
        store: this.probes,
        catalog: await this.roleCatalogCapabilities(settings),
      }),
      tuning: this.tuning,
      ...(requiredCapabilities.length ? { requiredCapabilities } : {}),
      ...(routed.decided ? { preRoute: routed } : assessment ? { assessment } : { routerFailure: failure ?? "unavailable" }),
    });
    const record = createRouteRecord({ routeId, goal: settings.goal, decision, roles: settings.roles });
    if (routerStage) record.stages.push(routerStage);
    if (!decision.canStart) return { record, decision, ...(assessment ? { assessment } : {}), blocked: this.routeBlockedMessage(settings, decision) };
    const builder = settings.roles.builder;
    if (decision.shape === "lead-guided") {
      // The staged pipeline records its own stages as they run. The early route
      // event still names the model that will do the building.
      record.executedShape = "lead-guided";
      return {
        record,
        decision,
        ...(assessment ? { assessment } : {}),
        route: {
          record,
          role: "builder",
          stage: "builder",
          modelId: builder.modelId,
          providerId: builder.providerId,
          ...(decision.efforts.builder ? { effort: await this.effortFor(builder.modelId, decision.efforts.builder) } : {}),
        },
      };
    }
    const execution = await this.executionStage(decision, settings);
    record.executedShape = execution.executedShape;
    record.stages.push({ providerId: execution.model.providerId, modelId: execution.model.modelId, stage: execution.stage, ...(execution.effort ? { effectiveEffort: execution.effort } : {}) });
    return {
      record,
      decision,
      ...(assessment ? { assessment } : {}),
      route: { record, ...(assessment ? { assessment } : {}), role: execution.role, stage: execution.stage, modelId: execution.model.modelId, providerId: execution.model.providerId, ...(execution.effort ? { effort: execution.effort } : {}) },
    };
  }

  /** Run the missing role checks once. A check that cannot run is recorded as failed, not retried every turn. */
  private async ensureRoleProbes(settings: OrchestratorSettings, signal: AbortSignal): Promise<boolean> {
    const targets: Array<{ role: ProbeRole; providerId: string; modelId: string }> = [
      { role: "lead", ...settings.roles.lead },
      { role: "builder", ...settings.roles.builder },
    ];
    const small = settings.roles.small;
    // Small-task shares the Builder's check only when it is the same model.
    if (small.providerId !== settings.roles.builder.providerId || small.modelId !== settings.roles.builder.modelId) targets.push({ role: "small", ...small });
    const missing = targets.filter((target) => probeNeeded(this.probes, target));
    if (!missing.length) return false;
    await Promise.all(missing.map(async (target) => {
      try {
        await this.orchestratorProbe({ role: target.role, providerId: target.providerId, modelId: target.modelId, timeoutMs: ROUTE_PROBE_TIMEOUT_MS, signal });
      } catch (error) {
        if (signal.aborted) return;
        this.probes = recordProbe(this.probes, {
          ...target,
          probeVersion: PROBE_VERSION,
          status: "failed",
          detail: (error instanceof Error ? error.message : "Probe execution failed.").slice(0, 500),
          capabilities: [],
          checkedAt: Date.now(),
        });
      }
    }));
    return true;
  }

  /** Catalog capabilities are added only to roles that already passed their check. */
  private async roleCatalogCapabilities(settings: OrchestratorSettings): Promise<Partial<Record<OrchestratorRole, OrchestratorCapability[]>>> {
    const rows = await this.loadCatalog(false).catch(() => []);
    const forModel = (modelId: string) => {
      const { providerId, model } = splitModelId(modelId);
      const listed = rows.find((row) => row.modelId === modelId);
      return catalogCapabilities({ modelId, contextLimit: listed?.contextLimit ?? contextWindow(providerId, model) });
    };
    return { lead: forModel(settings.roles.lead.modelId), builder: forModel(settings.roles.builder.modelId), small: forModel(settings.roles.small.modelId) };
  }

  /** The single-stage shapes: one model runs the turn. Lead-guided is staged. */
  private async executionStage(decision: RoutePolicyDecision, settings: OrchestratorSettings): Promise<ExecutionStage> {
    if (decision.shape === "direct-small") {
      return { role: "small", stage: "small", model: settings.roles.small, executedShape: "direct-small", effort: await this.effortFor(settings.roles.small.modelId, decision.efforts.small ?? "highest") };
    }
    if (decision.shape === "direct-builder") {
      return { role: "builder", stage: "builder", model: settings.roles.builder, executedShape: "direct-builder", effort: await this.effortFor(settings.roles.builder.modelId, decision.efforts.builder ?? "highest") };
    }
    return {
      role: "lead",
      stage: "lead",
      model: settings.roles.lead,
      executedShape: "lead-only",
      effort: await this.effortFor(settings.roles.lead.modelId, decision.efforts.lead ?? "highest"),
    };
  }

  /** The nearest supported concrete tier for this model, or none when it exposes no effort choice. */
  private async effortFor(modelId: string, target: EffortTarget): Promise<string | undefined> {
    const { providerId, model } = splitModelId(modelId);
    const provider = resolveProvider(providerId, this.credentials);
    if (!provider) return undefined;
    const listed = (await this.loadCatalog(false).catch(() => [])).find((row) => row.modelId === modelId);
    return resolveEffortTarget(target, effortTiers(provider.id, model, provider.wire, listed?.listedReasoning, listed?.reasoningEfforts));
  }

  private routeBlockedMessage(settings: OrchestratorSettings, decision: RoutePolicyDecision): string {
    const issues = decision.capabilityIssues.map(({ role, capability }) => {
      const model = settings.roles[role];
      const probe = findProbe(this.probes, { role, ...model });
      const reason = probe?.status === "failed" ? ` — ${probe.detail.slice(0, 200)}` : "";
      return `${ORCHESTRATOR_ROLE_NAME[role]} (${model.modelId}) cannot cover ${capability}${reason}.`;
    });
    return `Orchestrator cannot start this turn. ${[...new Set(issues)].join(" ")} Open Settings → Orchestrator to check the role models.`;
  }

  /** One tool-less classification call. It never enters the transcript or the model history. */
  private async runRouterCall(live: Live, routeId: string, router: OrchestratorModel, effort: string | undefined, prompt: string, openTask: OpenTask | undefined, attachments: readonly { name: string; mediaType?: string }[], signal: AbortSignal): Promise<{ text: string; effort?: string }> {
    const { providerId, model } = splitModelId(router.modelId);
    const provider = resolveProvider(providerId, this.credentials);
    if (!provider) throw new ProviderError(`${providerSpec(providerId)?.name ?? providerId} has no key. Add it in Settings → Providers.`, undefined, "MISSING_CREDENTIAL");
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), ROUTER_TIMEOUT_MS);
    timer.unref?.();
    const spent = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const at = Date.now();
    let text = "";
    try {
      const envelope = routerEnvelope({
        prompt,
        mode: live.meta.mode,
        ...(attachments.length ? { attachmentNames: attachments } : {}),
        recent: this.recentTurns(live, prompt),
        ...(openTask ? { openTask: openTask.shape } : {}),
      });
      const listed = (await this.loadCatalog(false).catch(() => [])).find((row) => row.modelId === router.modelId);
      for await (const event of streamChat({
        provider,
        modelId: router.modelId,
        system: { stable: ROUTER_SYSTEM, volatile: "" },
        messages: [{ role: "user", content: [{ type: "text", text: envelope }] }],
        tools: [],
        effort,
        listedReasoning: listed?.listedReasoning,
        listedEfforts: listed?.reasoningEfforts,
        signal: controller.signal,
        timeouts: { idleMs: this.limits.idleMs, firstEventMs: this.limits.firstEventMs },
        fetchImpl: this.fetchImpl,
      })) {
        if (event.type === "text") text += event.delta;
        else if (event.type === "usage") {
          if (event.inputTokens != null) spent.input = event.inputTokens;
          if (event.outputTokens != null) spent.output = event.outputTokens;
          if (event.cacheReadTokens != null) spent.cacheRead = event.cacheReadTokens;
          if (event.cacheWriteTokens != null) spent.cacheWrite = event.cacheWriteTokens;
        } else if (event.type === "done") {
          this.accumulateUsage(live, spent);
          this.emitCall(this.surface(live), {
            callId: randomUUID(),
            routeId,
            role: "router",
            stage: "router",
            at,
            providerId: provider.id,
            modelId: router.modelId,
            ...(effort ? { effort } : {}),
            inputTokens: spent.input + spent.cacheRead + spent.cacheWrite,
            cachedTokens: spent.cacheRead + spent.cacheWrite,
            outputTokens: spent.output,
            ...(event.stopReason ? { stopReason: event.stopReason } : {}),
            durationMs: Date.now() - at,
            toolCalls: 0,
          });
          return { text, ...(effort ? { effort } : {}) };
        }
      }
      // streamChat throws when a stream closes without its end marker.
      return { text, ...(effort ? { effort } : {}) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", forwardAbort);
    }
  }

  /** The tail of the conversation, with the prompt this turn is routing excluded. */
  private recentTurns(live: Live, prompt: string): RouterRecentTurn[] {
    const messages = [...live.messages];
    const last = messages.at(-1);
    if (last?.role === "user" && this.userText(last) === prompt.trim()) messages.pop();
    const recent: RouterRecentTurn[] = [];
    for (let index = messages.length - 1; index >= 0 && recent.length < 4; index -= 1) {
      const message = messages[index];
      if (message.role === "user") {
        const text = this.userText(message);
        if (text) recent.unshift({ role: "user", text });
      } else if (message.role === "assistant") {
        const text = message.text.trim();
        if (text) recent.unshift({ role: "assistant", text });
      }
    }
    return recent;
  }

  private userText(message: Extract<ChatMessage, { role: "user" }>): string {
    return message.content.map((part) => part.type === "text" ? part.text : "").join("\n").trim();
  }

  /** Names and types only; image bytes never reach the Router. */
  private currentAttachments(live: Live): Array<{ name: string; mediaType: string }> {
    const last = live.messages.at(-1);
    if (last?.role !== "user") return [];
    const attachments: Array<{ name: string; mediaType: string }> = [];
    for (const part of last.content) {
      if (part.type === "image") attachments.push({ name: `image-${attachments.length + 1}`, mediaType: part.mediaType });
    }
    return attachments;
  }

  /** The current request's image bytes, for the role that must see them. */
  private currentImages(live: Live): ImagePart[] {
    const last = live.messages.at(-1);
    if (last?.role !== "user") return [];
    return last.content.filter((part): part is ImagePart => part.type === "image");
  }

  /** Images the Lead's session does not already hold, byte for byte. */
  private missingLeadImages(live: Live, images: readonly ImagePart[]): ImagePart[] {
    if (!images.length) return [];
    const held = new Set(live.leadMessages.flatMap((message) => message.role === "user" ? message.content.filter((part) => part.type === "image").map((part) => part.data) : []));
    return images.filter((image) => !held.has(image.data));
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
          : subject.kind === "browser"
            ? { kind: "browser", path: subject.origin || "this page", origin: subject.origin, ...(verdict.risk ? { risk: verdict.risk } : {}) }
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

  private async runTurn(live: Live, turnId: string, options: { stepCap?: number; profileId?: string; signal?: AbortSignal; prompt?: string; openTask?: OpenTask; forcedShape?: OrchestratorShape } = {}): Promise<{ outcome: Json; text: string; capped: boolean }> {
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
    let routeRecord: RouteRecord | undefined;
    let activeRoute: TurnRoute | undefined;
    let routeAssessment: RouterAssessment | undefined;
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
      // Routing is decided once, before any role model runs. Its model and stage
      // stay fixed for the turn, including every tool step.
      const routed = await this.resolveTurnRoute(live, options.prompt ?? "", options.openTask, controller.signal, options.forcedShape);
      if (routed) {
        routeRecord = routed.record;
        routeAssessment = routed.assessment;
        activeRoute = routed.route;
        if (!live.muted) this.emit("route", { sessionId, turnId, route: routed.record });
        if (activeRoute) live.activeModelId = activeRoute.modelId;
        if (routed.blocked) throw new Error(routed.blocked);
      }
      if (routed?.decision?.shape === "lead-guided" && routed.route) {
        const run = await this.runLeadGuided({
          live,
          turn: contributions,
          turnId,
          prompt: options.prompt ?? "",
          system,
          signal: controller.signal,
          routeId: routed.route.record.routeId,
          record: routed.route.record,
          decision: routed.decision,
          settings: live.meta.orchestrator!,
          ...(routeAssessment ? { assessment: routeAssessment } : {}),
          stepCap,
          active,
          offered,
        });
        text = run.text;
        capped = run.capped;
        if (controller.signal.aborted) cancelled();
      } else {
        const last = activeRoute?.record.stages.at(-1);
        const run = await this.runStageLoop(live, contributions, {
          turnId,
          system,
          signal: controller.signal,
          stepCap,
          noticeCap: stepCap,
          active,
          offered,
          ...(activeRoute && last
            ? { stage: { routeId: activeRoute.record.routeId, record: last, role: activeRoute.role, stage: activeRoute.stage, model: { providerId: activeRoute.providerId, modelId: activeRoute.modelId }, ...(activeRoute.effort ? { effort: activeRoute.effort } : {}) } }
            : {}),
        });
        text = run.text;
        capped = run.capped;
        if (run.cancelled) cancelled();
      }
    } catch (error) {
      outcome = controller.signal.aborted
        ? { kind: "completed", params: { terminal: "cancelled" } }
        : { kind: "failed", params: { terminal: "failed", error: { message: error instanceof Error ? error.message : String(error) } } };
    } finally {
      // A staged turn's record grows after the early event; send the final rows
      // so the live receipt and Usage can name the review and takeover stages.
      if (routeRecord?.shape === "lead-guided" && !live.muted) this.emit("route", { sessionId, turnId, route: routeRecord });
      // The decision is durable even when execution failed: the next turn can
      // explain the shape without repeating the Router call.
      if (routeRecord) await this.store.append(sessionId, [{ type: "route", turnId, route: routeRecord }]).catch(() => {});
      // A steer accepted in the last moment stays in history, including after
      // cancellation or replacement. Its durable pending record settles here.
      await this.flushSteering(live).catch(() => {});
      // While the turn still holds the session, so no next turn starts before its observers have run.
      const finished = turn ? await turn.runHook("turnFinished", { context: turn.context, outcome }) : [];
      const startNext = live.replacing || !controller.signal.aborted;
      live.replacing = false;
      live.prompting = false;
      live.controller = null;
      live.activeModelId = undefined;
      // An answer to the question this turn ended with continues the same shape.
      if (live.question?.turnId === turnId) {
        if (activeRoute) live.openTask = { shape: activeRoute.record.executedShape ?? activeRoute.record.shape, ...(routeAssessment ? { assessment: routeAssessment } : {}) };
      } else {
        live.openTask = undefined;
      }
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

  /**
   * One stage's model and tool loop over the thread's history. A manual turn
   * has no stage row; a routed stage carries its role into every call report.
   */
  private async runStageLoop(live: Live, contributions: TurnContributions, input: {
    turnId: string;
    system: SystemPrompt;
    signal: AbortSignal;
    stepCap: number;
    noticeCap: number;
    active: Set<string>;
    offered: () => readonly ToolSchema[];
    stage?: StageRoute;
    collect?: BuildObservations;
    /** The Builder's Lead tool, when this stage may consult. */
    askLead?: (call: ToolCall) => Promise<CallResult>;
    /** Extra schemas this stage offers; defaults to the turn's registry tools. */
    toolSchemas?: () => readonly ToolSchema[];
    /** Runs after a normal tool batch is in history, before the next call. */
    afterTools?: (results: readonly CallResult[], context: { step: number; stepsLeft: number; calls: readonly ToolCall[] }) => Promise<void>;
    /** An isolated role session; defaults to the thread's neutral history. */
    history?: { messages: ChatMessage[]; push: (message: ChatMessage) => Promise<void> };
    /** A Builder question completes in its isolated session. */
    questionTarget?: "builder";
    /** Suppress the model's text/reasoning items while keeping tool items. */
    emitText?: boolean;
    /** A hard whitelist; a hallucinated tool call is refused without running. */
    allowedTools?: ReadonlySet<string>;
  }): Promise<{ text: string; capped: boolean; asked: boolean; cancelled: boolean; steps: number }> {
    const sessionId = live.meta.sessionId;
    const history = input.history ?? {
      messages: live.messages,
      push: async (message: ChatMessage) => {
        live.messages.push(message);
        await this.store.append(sessionId, [{ type: "message", message }]);
      },
    };
    let text = "";
    let capped = false;
    let asked = false;
    let steps = 0;
    for (let step = 0; step < input.stepCap; step += 1) {
      if (input.signal.aborted) return { text, capped, asked, cancelled: true, steps };
      // Steering that arrived during tools waits until the results are in the history.
      await this.flushSteering(live, input.history?.push);
      if (input.signal.aborted) return { text, capped, asked, cancelled: true, steps };
      steps += 1;
      const modelId = input.stage?.model.modelId ?? live.meta.modelId ?? await this.defaultModel();
      if (!modelId) throw new Error(`${HARNESS_NAME} has no model to use. Add a provider key in Settings → Providers.`);
      if (!input.stage && !live.meta.modelId) await this.changed(live, { modelId });
      const { providerId, model } = splitModelId(modelId);
      const provider = resolveProvider(providerId, this.credentials);
      if (!provider) throw new ProviderError(`${providerSpec(providerId)?.name ?? providerId} has no key. Add it in Settings → Providers, or pick another model.`, undefined, "MISSING_CREDENTIAL");
      // The listed window and capability beat the family default, so the catalog is loaded before they are consulted.
      const listed = (await this.loadCatalog(false).catch(() => [])).find((row) => row.modelId === modelId);
      const window = listed?.contextLimit ?? contextWindow(provider.id, model);
      const route = input.stage ? { routeId: input.stage.routeId, role: input.stage.role, stage: input.stage.stage, ...(input.stage.effort ? { effort: input.stage.effort } : {}) } : undefined;
      const schemas = input.toolSchemas?.() ?? input.offered();
      const isolated = input.history ? clipRecency(history.messages) : undefined;
      const callOptions = { ...(isolated ? { messages: isolated } : {}), ...(input.emitText === false ? { emitText: false } : {}) };
      const { message: reply, stopReason, effort } = await this.callModel(live, provider, modelId, model, input.system, schemas, input.signal, window, listed?.listedReasoning, listed?.reasoningEfforts, route, Object.keys(callOptions).length ? callOptions : undefined);
      // A provider that rejected the effort fell back for this call; the route record keeps what actually ran.
      if (input.stage && effort !== input.stage.effort) {
        input.stage.effort = effort;
        if (effort) input.stage.record.effectiveEffort = effort;
        else delete input.stage.record.effectiveEffort;
      }
      await history.push(reply);
      // A cut-off reply can carry valid JSON that is still an incomplete tool call. Do not run it.
      if (isTruncatedStop(stopReason) && reply.toolCalls?.length) {
        const results = reply.toolCalls.map((call) => {
          const output = truncatedToolResult(call.name);
          this.emitItem(live, { ...this.toolBase(live, call, call.input), status: "failed", failureReason: output, visibleOutput: output }, true);
          return { id: call.id, name: call.name, output, isError: true as const };
        });
        const message: ChatMessage = { role: "tool", results };
        await history.push(message);
        if (step === input.stepCap - 1) {
          capped = true;
          this.stageCapNotice(live, input.noticeCap);
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
      const denied = (index: number) => {
        const call = calls[index];
        const output = `The ${call.name} tool is not available in this stage.`;
        this.emitItem(live, { ...this.toolBase(live, call, call.input), status: "failed", failureReason: output, visibleOutput: output }, true);
        return { id: call.id, name: call.name, output, isError: true as const };
      };
      const askLead = input.askLead;
      const results = await scheduleToolCalls({
        safe: calls.map((call) => (input.allowedTools && !input.allowedTools.has(call.name)) || call.name === ASK_LEAD_TOOL.name ? false : executionMode(contributions.tools.get(call.name)) === "concurrent"),
        signal: input.signal,
        onAborted: stopped,
        run: (index) => {
          if (input.signal.aborted) return Promise.resolve(stopped(index));
          if (input.allowedTools && !input.allowedTools.has(calls[index].name)) return Promise.resolve(denied(index));
          if (askLead && calls[index].name === ASK_LEAD_TOOL.name) return askLead(calls[index]);
          return this.runToolCall(live, contributions, calls[index], input.signal, reminders[index]);
        },
      });
      for (const result of results) {
        for (const name of result.activate ?? []) if (contributions.tools.has(name)) input.active.add(name);
      }
      if (input.collect) for (const result of results) this.collectObservation(input.collect, result);
      if (results.some((result) => result.question)) {
        // The turn ends with the questions. Their answer completes this tool message in a new turn.
        await this.parkQuestion(live, input.turnId, results, input.questionTarget === "builder" && live.builder ? { builder: { planId: live.builder.planId } } : undefined);
        asked = true;
        break;
      }
      const message: ChatMessage = { role: "tool", results };
      await history.push(message);
      if (input.afterTools) await input.afterTools(results, { step, stepsLeft: input.stepCap - step - 1, calls });
      if (step === input.stepCap - 1) {
        capped = true;
        this.stageCapNotice(live, input.noticeCap);
      }
    }
    return { text, capped, asked, cancelled: input.signal.aborted, steps };
  }

  /**
   * One read-only stage. The model gets read_file/list_files/grep in a local
   * history, no writes, shell, MCP, questions or delegation; its text is
   * suppressed from the transcript while tool items stay visible. Used by the
   * scout and Lead reads once their policies enable them.
   */
  private async runReadOnlyStage(input: {
    live: Live;
    turn: TurnContributions;
    turnId: string;
    signal: AbortSignal;
    routeId: string;
    record: RouteRecord;
    role: "lead" | "small";
    stage: OrchestratorStage;
    model: OrchestratorModel;
    effort: EffortTarget;
    system: SystemPrompt;
    brief: string;
    /** Images from the current request, when this role must see them. */
    images?: ImagePart[];
    maxSteps: number;
    maxChars: number;
    history?: { messages: ChatMessage[]; push: (message: ChatMessage) => Promise<void> };
  }): Promise<{ text: string; toolsUsed: string[]; capped: boolean }> {
    let history = input.history;
    if (!history) {
      const messages: ChatMessage[] = [];
      history = { messages, push: async (message: ChatMessage) => { messages.push(message); } };
    }
    const stageHistory = history;
    await stageHistory.push({ role: "user", content: [{ type: "text", text: input.brief }, ...(input.images ?? [])] });
    const readSchemas = () => input.turn.schemas.filter((schema) => READ_ONLY_TOOL_NAMES.has(schema.name));
    if (!readSchemas().length) throw new Error("No read tools are available in this workspace.");
    const effort = await this.effortFor(input.model.modelId, input.effort);
    const row: RouteStageRecord = { providerId: input.model.providerId, modelId: input.model.modelId, stage: input.stage, ...(effort ? { effectiveEffort: effort } : {}) };
    input.record.stages.push(row);
    const route: StageRoute = { routeId: input.routeId, record: row, role: input.role, stage: input.stage, model: input.model, ...(effort ? { effort } : {}) };
    const allowed = new Set(READ_ONLY_TOOL_NAMES);
    const used = new Set<string>();
    let open = true;
    const afterTools = async (results: readonly CallResult[]) => {
      for (const result of results) if (READ_ONLY_TOOL_NAMES.has(result.name)) used.add(result.name);
      if (!open) return;
      const chars = stageHistory.messages.reduce((sum, message) => sum + messageWeight(message), 0);
      if (chars < input.maxChars) return;
      open = false;
      allowed.clear();
      await stageHistory.push({ role: "user", content: [{ type: "text", text: "The read budget is exhausted. Return the final JSON now with what you have." }] });
    };
    const run = await this.runStageLoop(input.live, input.turn, {
      turnId: input.turnId,
      system: input.system,
      signal: input.signal,
      stepCap: Math.max(1, Math.floor(input.maxSteps)),
      noticeCap: Math.max(1, Math.floor(input.maxSteps)),
      active: new Set<string>(),
      offered: readSchemas,
      toolSchemas: () => open ? readSchemas() : [],
      allowedTools: allowed,
      emitText: false,
      history: stageHistory,
      stage: route,
      afterTools,
    });
    return { text: run.text, toolsUsed: [...used], capped: run.capped };
  }

  /**
   * The staged Lead-guided turn: plan, build, review and, in Output mode, one
   * repair. Each stage keeps its own route row; only the builder and repair
   * loops add to the thread's message history, so the plan and review calls
   * never become part of another model's conversation.
   */
  private async runLeadGuided(input: {
    live: Live;
    turn: TurnContributions;
    turnId: string;
    prompt: string;
    system: SystemPrompt;
    signal: AbortSignal;
    routeId: string;
    record: RouteRecord;
    decision: RoutePolicyDecision;
    settings: OrchestratorSettings;
    assessment?: RouterAssessment;
    stepCap: number;
    active: Set<string>;
    offered: () => readonly ToolSchema[];
  }): Promise<{ text: string; capped: boolean; asked: boolean }> {
    const { live, record, decision, settings, signal } = input;
    const lead = settings.roles.lead;
    const builder = settings.roles.builder;
    let remaining = input.stepCap;
    let capped = false;
    let text = "";

    const stage = async (options: {
      role: OrchestratorRole;
      stage: OrchestratorStage;
      model: OrchestratorModel;
      effort: EffortTarget;
      system: SystemPrompt;
      collect?: BuildObservations;
      /** Builder and repair stages may ask the Lead within the goal's budget. */
      consult?: { askLead: (call: ToolCall) => Promise<CallResult>; toolSchemas: () => readonly ToolSchema[]; afterTools: (results: readonly CallResult[], context: { step: number; stepsLeft: number; calls: readonly ToolCall[] }) => Promise<void> };
      /** A Builder stage uses its own fresh/resumed session. */
      history?: { messages: ChatMessage[]; push: (message: ChatMessage) => Promise<void> };
      questionTarget?: "builder";
    }) => {
      if (remaining <= 0) throw new Error(`${HARNESS_NAME} reached this turn's step limit before the next stage could start.`);
      const effort = await this.effortFor(options.model.modelId, options.effort);
      const row: RouteStageRecord = { providerId: options.model.providerId, modelId: options.model.modelId, stage: options.stage, ...(effort ? { effectiveEffort: effort } : {}) };
      record.stages.push(row);
      const route: StageRoute = { routeId: input.routeId, record: row, role: options.role, stage: options.stage, model: options.model, ...(effort ? { effort } : {}) };
      const run = await this.runStageLoop(live, input.turn, {
        turnId: input.turnId,
        system: options.system,
        signal,
        stepCap: remaining,
        noticeCap: input.stepCap,
        active: input.active,
        offered: input.offered,
        stage: route,
        ...(options.collect ? { collect: options.collect } : {}),
        ...(options.consult ? { askLead: options.consult.askLead, toolSchemas: options.consult.toolSchemas, afterTools: options.consult.afterTools } : {}),
        ...(options.history ? { history: options.history } : {}),
        ...(options.questionTarget ? { questionTarget: options.questionTarget } : {}),
      });
      remaining = Math.max(0, remaining - run.steps);
      if (run.capped) capped = true;
      return run;
    };

    const objective = input.prompt.trim() || neutralEntries(live.messages).filter((entry) => entry.kind === "user").at(-1)?.text || "The current request.";
    const brief = threadBrief({ ...(live.meta.title ? { title: live.meta.title } : {}), objective, transcript: neutralEntries(live.messages) });
    const images = this.currentImages(live);
    await this.ensureRoleSessions(live);
    const planImages = this.missingLeadImages(live, images);

    // A question needs no plan: the Lead answers it directly.
    if (input.assessment?.taskKind === "question") {
      live.activeModelId = lead.modelId;
      const run = await stage({ role: "lead", stage: "lead", model: lead, effort: decision.efforts.lead ?? "highest", system: this.stageSystem(input.system, leadExecutionNote("question")) });
      record.executedShape = "lead-only";
      record.reasonCodes.push("execution:lead-question");
      return { text: run.text, capped, asked: run.asked };
    }

    const approved = live.approvedPlan;
    const resumed = live.builder;
    // The plan call carries the image on a fresh plan; an approved or resumed
    // plan still needs it in the Lead's session for review and consults. Skip
    // an image the session already holds, so an approval does not duplicate it.
    if (planImages.length && (approved || resumed)) {
      await this.appendLeadMessage(live, { role: "user", content: [{ type: "text", text: "The current request includes this attachment." }, ...planImages] });
    }
    let scoutPack: ContextPack | undefined;
    if (decision.scout && !resumed && !approved) {
      const small = settings.roles.small;
      try {
        const probe = await this.orchestratorReadProbe({ modelId: small.modelId, signal });
        if (!probe.ok) {
          this.reason(record, "scout:unavailable");
          record.fallbacks.push("scout:unavailable");
          this.notice(live, "info", `Scouting was skipped: ${probe.detail}`);
        } else {
          const scoutMessages: ChatMessage[] = [];
          const scoutHistory = { messages: scoutMessages, push: async (message: ChatMessage) => { scoutMessages.push(message); } };
          const scoutSystem = this.stageSystem(input.system, SCOUT_INSTRUCTIONS);
          const runScout = (briefText: string) => this.runReadOnlyStage({
            live,
            turn: input.turn,
            turnId: input.turnId,
            signal,
            routeId: input.routeId,
            record,
            role: "small",
            stage: "scout",
            model: small,
            effort: "low",
            system: scoutSystem,
            brief: briefText,
            maxSteps: this.tuning.scout.maxReadCalls,
            maxChars: this.tuning.scout.maxPackChars,
            history: scoutHistory,
          });
          let run = await runScout(scoutPrompt({ brief, maxPackChars: this.tuning.scout.maxPackChars, maxExcerptChars: this.tuning.scout.maxExcerptChars }));
          let parsed = parseContextPack(run.text);
          let errors = parsed.ok ? this.validateScoutPack(parsed.value, run.toolsUsed) : parsed.errors;
          if (errors.length) {
            run = await runScout(scoutRetryPrompt(errors));
            parsed = parseContextPack(run.text);
            errors = parsed.ok ? this.validateScoutPack(parsed.value, run.toolsUsed) : parsed.errors;
          }
          if (parsed.ok && !errors.length) {
            scoutPack = parsed.value;
            record.references.contextPack = this.emitHandoff(live, "orchestratorContextPack", scoutPackSummary(scoutPack));
            this.reason(record, "scout:used");
          } else {
            this.reason(record, "scout:invalid");
            record.fallbacks.push("scout:invalid");
            this.notice(live, "warning", `Scouting did not produce a usable context pack: ${errors.join(" ")}`);
          }
        }
      } catch (error) {
        if (signal.aborted) throw error;
        this.reason(record, "scout:unavailable");
        record.fallbacks.push("scout:unavailable");
        this.notice(live, "warning", `Scouting was skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let plan: ReturnType<typeof parsePlan> | undefined;
    if (resumed) {
      // A user answer continued the same plan; keep the Builder's own session.
      plan = { ok: true, value: resumed.plan };
      record.reasonCodes.push("execution:resumed-builder");
      record.references.plan = resumed.planId;
    } else if (approved) {
      plan = { ok: true, value: approved.plan };
      record.reasonCodes.push("execution:approved-plan");
      if (approved.itemId) record.references.plan = approved.itemId;
    } else {
      const planBrief = scoutPack ? `${brief}\n\nScout context pack (read-only excerpts):\n${JSON.stringify(scoutPack)}` : brief;
      const reads = this.tuning.leadReads[settings.goal];
      let readAttempted = false;
      if (reads.calls > 0 && reads.chars > 0) {
        try {
          const probe = await this.orchestratorReadProbe({ modelId: lead.modelId, signal });
          if (!probe.ok) {
            this.reason(record, "lead-read:unavailable");
            record.fallbacks.push("lead-read:unavailable");
            this.notice(live, "info", `Lead reads were skipped: ${probe.detail}`);
          } else {
            readAttempted = true;
            const readSystem = this.stageSystem(input.system, LEAD_PLAN_READ_INSTRUCTIONS);
            const leadHistory = { messages: live.leadMessages, push: (message: ChatMessage) => this.appendLeadMessage(live, message) };
            const runPlan = (text: string, withImages = false) => this.runReadOnlyStage({
              live,
              turn: input.turn,
              turnId: input.turnId,
              signal,
              routeId: input.routeId,
              record,
              role: "lead",
              stage: "lead-plan",
              model: lead,
              effort: decision.efforts.lead ?? "high",
              system: readSystem,
              brief: text,
              ...(withImages && planImages.length ? { images: planImages } : {}),
              maxSteps: reads.calls,
              maxChars: reads.chars,
              history: leadHistory,
            });
            const first = await runPlan(leadPlanReadPrompt(planBrief, reads.calls, reads.chars), true);
            plan = parsePlan(first.text);
            if (!plan.ok) {
              this.reason(record, "plan:retry");
              const retry = await runPlan(leadPlanRetryPrompt(plan.errors));
              plan = parsePlan(retry.text);
            }
          }
        } catch (error) {
          if (signal.aborted) throw error;
          readAttempted = false;
          this.reason(record, "lead-read:unavailable");
          record.fallbacks.push("lead-read:unavailable");
          this.notice(live, "warning", `Lead reads failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!readAttempted) {
        const leadPlanSystem = this.stageSystem(input.system, LEAD_PLAN_INSTRUCTIONS);
        const first = await this.leadTurn({
          live,
          signal,
          routeId: input.routeId,
          record,
          stage: "lead-plan",
          model: lead,
          effort: decision.efforts.lead ?? "high",
          system: leadPlanSystem,
          user: leadPlanPrompt(planBrief),
          ...(planImages.length ? { images: planImages } : {}),
        });
        plan = parsePlan(first.text);
        if (!plan.ok) {
          this.reason(record, "plan:retry");
          const retry = await this.leadTurn({
            live,
            signal,
            routeId: input.routeId,
            record,
            stage: "lead-plan",
            model: lead,
            effort: decision.efforts.lead ?? "high",
            system: leadPlanSystem,
            user: leadPlanRetryPrompt(plan.errors),
          });
          plan = parsePlan(retry.text);
        }
      }
    }

    // Two rejected plans: the Lead does the work itself, as the plan specifies.
    if (!plan) throw new Error("The Lead plan stage did not produce a result.");
    if (!plan.ok) {
      live.activeModelId = lead.modelId;
      const run = await stage({ role: "lead", stage: "lead", model: lead, effort: "highest", system: this.stageSystem(input.system, leadExecutionNote("plan-invalid")) });
      record.executedShape = "lead-only";
      record.executionFallback = "plan-invalid";
      record.reasonCodes.push("execution:plan-invalid");
      record.fallbacks.push("plan:invalid");
      return { text: run.text, capped, asked: run.asked };
    }
    const validPlan = plan.value;
    if (!approved && !resumed) record.references.plan = this.emitHandoff(live, "orchestratorPlan", this.planSummary(validPlan));

    // Plan mode stops at the Lead's plan: the Builder starts only after the
    // user approves the same card a model's exit_plan_mode call produces.
    if (live.meta.mode === "plan" && !approved && !resumed) {
      const markdown = planMarkdown(validPlan);
      const call: ToolCall = { id: `plan-${randomUUID()}`, name: "exit_plan_mode", input: { plan: markdown, orchestratorPlan: validPlan } };
      const message: ChatMessage = { role: "assistant", text: "", toolCalls: [call], modelId: lead.modelId };
      live.messages.push(message);
      await this.store.append(live.meta.sessionId, [{ type: "message", message }]);
      const item = this.toolBase(live, call, { plan: markdown });
      live.pendingPlan = { plan: validPlan, markdown, ...(record.references.plan ? { itemId: record.references.plan } : {}) };
      this.emitItem(live, { ...item, status: "inProgress" });
      const asked: Asked = { questions: [planReviewQuestion(markdown)], intent: { kind: "planReview", plan: markdown } };
      await this.parkQuestion(live, input.turnId, [{ id: call.id, name: call.name, output: "", question: asked, item }]);
      record.executedShape = "lead-guided";
      record.reasonCodes.push("execution:plan-review");
      return { text: "", capped, asked: true };
    }

    let consultsLeft = decision.consultBudget;
    const consultSystem = this.stageSystem(input.system, LEAD_CONSULT_INSTRUCTIONS);
    const askLead = async (call: ToolCall): Promise<CallResult> => {
      const question = typeof call.input.question === "string" ? call.input.question.trim() : "";
      const excerpt = typeof call.input.excerpt === "string" ? call.input.excerpt.trim() : "";
      const base = this.toolBase(live, call, call.input);
      const refuse = (output: string): CallResult => {
        this.emitItem(live, { ...base, status: "failed", failureReason: output, visibleOutput: output }, true);
        return { id: call.id, name: call.name, output, isError: true };
      };
      if (!question) return refuse("ask_lead needs a question.");
      if (question.length > 4_000) return refuse("The question is too long; keep it under 4,000 characters.");
      if (excerpt.length > 20_000) return refuse("The excerpt is too long; keep it under 20,000 characters.");
      if (consultsLeft <= 0) {
        this.reason(record, "consult:budget-exhausted");
        return refuse("No Lead consults remain for this turn. Continue with the plan, or finish and explain what is blocked.");
      }
      consultsLeft -= 1;
      record.consultCount += 1;
      this.reason(record, "consult:explicit");
      this.emitItem(live, { ...base, status: "inProgress" });
      try {
        const answer = await this.leadTurn({
          live,
          signal,
          routeId: input.routeId,
          record,
          stage: "consult",
          model: lead,
          effort: decision.efforts.lead ?? "high",
          system: consultSystem,
          user: leadConsultPrompt({ plan: validPlan, question, ...(excerpt ? { excerpt } : {}) }),
        });
        const guidance = answer.text.trim().slice(0, 8_000) || "The Lead returned no guidance.";
        this.emitItem(live, { ...base, status: "completed", visibleOutput: guidance }, true);
        return { id: call.id, name: call.name, output: guidance };
      } catch (error) {
        if (signal.aborted) throw error;
        this.reason(record, "consult:unavailable");
        record.fallbacks.push("consult:unavailable");
        return refuse(`The Lead could not answer: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const stuckState = createStuckState();
    const builderTools = () => [...input.offered(), ASK_LEAD_TOOL];
    const afterTools = async (results: readonly CallResult[], context: { step: number; stepsLeft: number; calls: readonly ToolCall[] }) => {
      const asked = results.some((result) => result.name === ASK_LEAD_TOOL.name);
      let stuck: StuckSignal | undefined;
      for (const [index, result] of results.entries()) {
        if (result.name === ASK_LEAD_TOOL.name) continue;
        const call = context.calls[index];
        const observation: StuckObservation = {
          ...(result.observation ?? {}),
          ...(call ? { tool: call.name, inputKey: JSON.stringify(canonicalize(call.input)) } : {}),
          ...(result.isError ? { failed: true, detail: (result.output.split("\n")[0] ?? result.output).slice(0, 300) } : {}),
          ...(call && typeof call.input.path === "string" && !result.observation?.path ? { path: call.input.path } : {}),
        };
        const found = observeStuck(stuckState, observation, this.tuning.stuck, context.step);
        if (!stuck && found) stuck = found;
      }
      if (asked) return;
      if (context.stepsLeft <= 0) return;
      stuck ??= planChecksSignal(stuckState, validPlan.checks, context.stepsLeft, this.tuning.stuck);
      stuck ??= stepLimitSignal(stuckState, context.stepsLeft, this.tuning.stuck.stepLimitStepsLeft);
      if (!stuck) return;
      this.reason(record, `stuck:${stuck.code}`);
      if (consultsLeft <= 0) return;
      consultsLeft -= 1;
      record.consultCount += 1;
      this.reason(record, `consult:auto:${stuck.code}`);
      const evidence = [
        ...stuckState.recentFailures,
        ...(stuckState.editedPaths.size ? [`Edited: ${[...stuckState.editedPaths].slice(-6).join(", ")}`] : []),
      ].join("\n");
      this.notice(live, "info", `The Builder looks stuck (${stuck.code}); the Lead was consulted.`);
      try {
        const answer = await this.leadTurn({
          live,
          signal,
          routeId: input.routeId,
          record,
          stage: "consult",
          model: lead,
          effort: decision.efforts.lead ?? "high",
          system: consultSystem,
          user: stuckConsultPrompt({ plan: validPlan, reason: stuck.detail, ...(evidence ? { evidence } : {}) }),
        });
        const guidance = answer.text.trim();
        if (!guidance) {
          this.notice(live, "warning", "The Lead returned no guidance for the stuck check.");
          return;
        }
        this.emitHandoff(live, "orchestratorConsult", `Automatic consult · ${stuck.code}\n${guidance.slice(0, 8_000)}`);
        const message: ChatMessage = { role: "user", content: [{ type: "text", text: `Lead guidance (automatic consult · ${stuck.code}):\n${guidance.slice(0, 8_000)}` }] };
        if (live.builder) await this.appendBuilderMessage(live, message);
        else {
          live.messages.push(message);
          await this.store.append(live.meta.sessionId, [{ type: "message", message }]);
        }
        // One further attempt may ask again; the first consult is never repeated without new work.
        rearmStuck(stuckState, stuck.code);
      } catch (error) {
        if (signal.aborted) throw error;
        this.reason(record, "consult:unavailable");
        record.fallbacks.push("consult:unavailable");
        this.notice(live, "warning", `The Lead could not answer the stuck check: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const consult = { askLead, toolSchemas: builderTools, afterTools };
    const planId = resumed ? resumed.planId : record.references.plan ?? `plan-${randomUUID()}`;
    let builderTouched = Boolean(resumed);
    let builderOpen = false;
    if (!resumed) {
      const seed: ChatMessage = {
        role: "user",
        content: [{ type: "text", text: `Execute the Lead's plan.\n\n${threadBrief({ ...(live.meta.title ? { title: live.meta.title } : {}), objective, transcript: neutralEntries(live.messages) })}` }],
      };
      await this.startBuilderSession(live, planId, validPlan, seed);
      builderTouched = true;
    }
    const builderHistory = { messages: live.builder!.messages, push: (message: ChatMessage) => this.appendBuilderMessage(live, message) };
    const closeBuilder = async () => {
      if (builderTouched && !builderOpen) await this.endBuilderSession(live);
    };

    const observations: BuildObservations = { files: new Map(), checks: [], patches: [] };
    const takeOver = async (reason: string, builtText: string): Promise<{ text: string; capped: boolean; asked: boolean }> => {
      record.takeovers.push(`builder:${reason}`.slice(0, 300));
      record.reasonCodes.push("execution:takeover");
      live.activeModelId = lead.modelId;
      await this.endBuilderSession(live);
      builderOpen = false;
      const note = [
        builderInstructions(validPlan),
        `The Builder could not finish: ${reason}`,
        "Take over and complete the plan yourself. State what changed and what you checked.",
      ].join("\n\n");
      const run = await stage({ role: "lead", stage: "takeover", model: lead, effort: "highest", system: this.stageSystem(input.system, note) });
      record.executedShape = "lead-guided";
      return { text: run.text || builtText, capped, asked: run.asked };
    };

    live.activeModelId = builder.modelId;
    const builderSystem = this.stageSystem(input.system, builderInstructions(validPlan));
    let build: Awaited<ReturnType<typeof stage>>;
    try {
      build = await stage({ role: "builder", stage: "builder", model: builder, effort: decision.efforts.builder ?? "highest", system: builderSystem, collect: observations, consult, history: builderHistory, questionTarget: "builder" });
    } catch (error) {
      if (signal.aborted) { await closeBuilder(); throw error; }
      if (decision.builderFailure === "takeover") return takeOver(error instanceof Error ? error.message : String(error), text);
      await closeBuilder();
      throw error;
    }
    text = build.text;
    if (build.cancelled) {
      if (text.trim()) await this.appendThreadAnswer(live, text, builder.modelId);
      await closeBuilder();
      record.executedShape = "lead-guided";
      return { text, capped, asked: false };
    }
    if (build.asked) {
      builderOpen = true;
      record.executedShape = "lead-guided";
      return { text, capped, asked: true };
    }
    if (build.capped) {
      // The Builder spent the turn's step budget, so there is no budget left
      // for a takeover in this turn. Stop with the work that exists.
      if (text.trim()) await this.appendThreadAnswer(live, text, builder.modelId);
      await closeBuilder();
      this.notice(live, "warning", "The Builder hit the turn's step limit before finishing. Send a message to continue.");
      record.executedShape = "lead-guided";
      return { text, capped, asked: false };
    }

    const review = async (answer: string, report: BuildReport): Promise<ReviewNotes | undefined> => {
      const reviewSystem = this.stageSystem(input.system, LEAD_REVIEW_INSTRUCTIONS);
      try {
        const reviewRaw = await this.leadTurn({
          live,
          signal,
          routeId: input.routeId,
          record,
          stage: "review",
          model: lead,
          effort: decision.efforts.lead ?? "high",
          system: reviewSystem,
          user: leadReviewPrompt({ plan: validPlan, report, answer }),
        });
        const notes = parseReviewNotes(reviewRaw.text);
        if (!notes.ok) {
          this.reason(record, "review:invalid");
          record.fallbacks.push("review:invalid");
          this.notice(live, "warning", "The Lead's review could not be read, so the build stands without review notes.");
          return undefined;
        }
        record.reviewCount += 1;
        this.reason(record, `review:${notes.value.outcome}`);
        record.references.reviewNotes = this.emitHandoff(live, "orchestratorReview", this.reviewSummary(notes.value));
        return notes.value;
      } catch (error) {
        if (signal.aborted) throw error;
        this.reason(record, "review:unavailable");
        record.fallbacks.push("review:unavailable");
        this.notice(live, "warning", `The Lead could not review the build: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    };

    let report = this.buildReport(observations, text);
    record.references.buildReport = this.emitHandoff(live, "orchestratorBuildReport", this.reportSummary(report, "Build report"));

    if (decision.leadReview) {
      const notes = await review(text, report);
      if (notes?.outcome === "changes-required") {
        if (decision.repairBudget > 0 && remaining > 0) {
          try {
            const repair = await stage({ role: "builder", stage: "repair", model: builder, effort: decision.efforts.builder ?? "highest", system: this.stageSystem(input.system, repairInstructions(validPlan, notes)), collect: observations, consult, history: builderHistory, questionTarget: "builder" });
            text = repair.text || text;
            if (repair.cancelled) {
              if (text.trim()) await this.appendThreadAnswer(live, text, builder.modelId);
              await closeBuilder();
              record.executedShape = "lead-guided";
              return { text, capped, asked: false };
            }
            if (repair.asked) {
              builderOpen = true;
              record.executedShape = "lead-guided";
              return { text, capped, asked: true };
            }
            if (repair.capped) {
              this.notice(live, "warning", "The Builder hit the turn's step limit during the repair.");
            } else {
              report = this.buildReport(observations, text);
              record.references.buildReport = this.emitHandoff(live, "orchestratorBuildReport", this.reportSummary(report, "Build report after repair"));
              const again = await review(text, report);
              if (again?.outcome === "changes-required") {
                this.notice(live, "warning", `The Lead still requires fixes: ${again.fixes.join("; ").slice(0, 500)}`);
              }
            }
          } catch (error) {
            if (signal.aborted) { await closeBuilder(); throw error; }
            if (decision.builderFailure === "takeover") return takeOver(error instanceof Error ? error.message : String(error), text);
            await closeBuilder();
            throw error;
          }
        } else {
          this.notice(live, "warning", `The Lead reviewed the build and requires fixes: ${notes.fixes.join("; ").slice(0, 500)}`);
        }
      }
    }

    if (text.trim()) await this.appendThreadAnswer(live, text, builder.modelId);
    await closeBuilder();
    record.executedShape = "lead-guided";
    return { text, capped, asked: false };
  }

  /** A tool-less, off-history call for a plan or review handoff. */
  private async auxiliaryCall(input: {
    live: Live;
    signal: AbortSignal;
    routeId: string;
    record: RouteRecord;
    role: OrchestratorRole;
    stage: OrchestratorStage;
    model: OrchestratorModel;
    effort: EffortTarget;
    system: SystemPrompt;
    messages: ChatMessage[];
  }): Promise<{ text: string; message: AssistantMessage }> {
    const modelId = input.model.modelId;
    const { providerId, model } = splitModelId(modelId);
    const provider = resolveProvider(providerId, this.credentials);
    if (!provider) throw new ProviderError(`${providerSpec(providerId)?.name ?? providerId} has no key. Add it in Settings → Providers, or pick another model.`, undefined, "MISSING_CREDENTIAL");
    const effort = await this.effortFor(modelId, input.effort);
    const row: RouteStageRecord = { providerId, modelId, stage: input.stage, ...(effort ? { effectiveEffort: effort } : {}) };
    input.record.stages.push(row);
    const listed = (await this.loadCatalog(false).catch(() => [])).find((entry) => entry.modelId === modelId);
    const window = listed?.contextLimit ?? contextWindow(provider.id, model);
    const { message, effort: actual } = await this.callModel(
      input.live,
      provider,
      modelId,
      model,
      input.system,
      [],
      input.signal,
      window,
      listed?.listedReasoning,
      listed?.reasoningEfforts,
      { routeId: input.routeId, role: input.role, stage: input.stage, ...(effort ? { effort } : {}) },
      { messages: input.messages, emitText: false, emitContext: false },
    );
    if (actual !== effort) {
      if (actual) row.effectiveEffort = actual;
      else delete row.effectiveEffort;
    }
    return { text: message.text, message };
  }

  private stageSystem(base: SystemPrompt, addition: string): SystemPrompt {
    return { stable: base.stable, volatile: [base.volatile, addition].filter(Boolean).join("\n\n") };
  }

  private lastAssistantModel(messages: readonly ChatMessage[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && message.modelId) return message.modelId;
    }
    return undefined;
  }

  /** Reset a role session when its model changed; provider-specific blocks must not cross models. */
  private async ensureRoleSessions(live: Live) {
    const settings = live.meta.orchestrator;
    if (!settings) return;
    const leadUsed = this.lastAssistantModel(live.leadMessages);
    if (leadUsed && leadUsed !== settings.roles.lead.modelId) {
      await this.resetLeadSession(live);
      this.notice(live, "info", "The Lead model changed; its session starts fresh.");
    }
    if (live.builder) {
      const builderUsed = this.lastAssistantModel(live.builder.messages);
      if (builderUsed && builderUsed !== settings.roles.builder.modelId) {
        await this.endBuilderSession(live);
        this.notice(live, "info", "The Builder model changed; its plan session starts fresh.");
      }
    }
  }

  private async appendLeadMessage(live: Live, message: ChatMessage) {
    live.leadMessages.push(message);
    await this.store.append(live.meta.sessionId, [{ type: "leadMessage", message }]);
    await this.trimLeadSession(live);
  }

  private async trimLeadSession(live: Live) {
    const size = live.leadMessages.reduce((sum, message) => sum + messageWeight(message), 0);
    if (live.leadMessages.length <= MAX_LEAD_SESSION_MESSAGES && size <= MAX_LEAD_SESSION_CHARS) return;
    const keep = live.leadMessages.slice(-Math.floor(MAX_LEAD_SESSION_MESSAGES / 2));
    const note: ChatMessage = { role: "user", content: [{ type: "text", text: "[Earlier Lead session compacted; keep the current plan and latest reports in mind.]" }] };
    // Keep the same array: a read stage may be holding this reference while it appends.
    live.leadMessages.splice(0, live.leadMessages.length, note, ...keep);
    await this.store.append(live.meta.sessionId, [{ type: "leadReset" }, ...live.leadMessages.map((message) => ({ type: "leadMessage" as const, message }))]);
  }

  private async resetLeadSession(live: Live) {
    if (!live.leadMessages.length) return;
    live.leadMessages = [];
    await this.store.append(live.meta.sessionId, [{ type: "leadReset" }]);
  }

  private async endBuilderSession(live: Live) {
    const builder = live.builder;
    if (!builder) return;
    live.builder = undefined;
    await this.store.append(live.meta.sessionId, [{ type: "builderEnd", planId: builder.planId }]).catch(() => {});
  }

  private async startBuilderSession(live: Live, planId: string, plan: OrchestratorPlan, seed: ChatMessage) {
    if (live.builder) await this.endBuilderSession(live);
    live.builder = { planId, plan, messages: [seed] };
    await this.store.append(live.meta.sessionId, [{ type: "builderStart", planId, plan }, { type: "builderMessage", planId, message: seed }]);
  }

  private async appendBuilderMessage(live: Live, message: ChatMessage) {
    if (!live.builder) return;
    live.builder.messages.push(message);
    await this.store.append(live.meta.sessionId, [{ type: "builderMessage", planId: live.builder.planId, message }]);
  }

  /** The thread stores only the neutral final answer, never the Builder's tool traffic. */
  private async appendThreadAnswer(live: Live, text: string, modelId?: string) {
    if (!text.trim()) return;
    const message: ChatMessage = { role: "assistant", text, ...(modelId ? { modelId } : {}) };
    live.messages.push(message);
    await this.store.append(live.meta.sessionId, [{ type: "message", message }]);
  }

  private async leadTurn(input: {
    live: Live;
    signal: AbortSignal;
    routeId: string;
    record: RouteRecord;
    stage: OrchestratorStage;
    model: OrchestratorModel;
    effort: EffortTarget;
    system: SystemPrompt;
    user: string;
    images?: ImagePart[];
  }): Promise<{ text: string; message: AssistantMessage }> {
    await this.ensureRoleSessions(input.live);
    const user: ChatMessage = { role: "user", content: [{ type: "text", text: input.user }, ...(input.images ?? [])] };
    const result = await this.auxiliaryCall({
      live: input.live,
      signal: input.signal,
      routeId: input.routeId,
      record: input.record,
      role: "lead",
      stage: input.stage,
      model: input.model,
      effort: input.effort,
      system: input.system,
      messages: [...input.live.leadMessages, user],
    });
    await this.appendLeadMessage(input.live, user);
    await this.appendLeadMessage(input.live, result.message);
    return { text: result.message.text, message: result.message };
  }

  /**
   * A model cannot see its own routing, so an identity question is answered from
   * its training prior — a distilled model may name its teacher. The volatile
   * half keeps the cached prefix intact, and the name is per call so a routed
   * turn names the model that actually serves that stage.
   */
  private servingSystem(base: SystemPrompt, model: string, provider: ResolvedProvider): SystemPrompt {
    return this.stageSystem(base, `Serving model: ${model} (provider: ${provider.name}). If the user asks about your identity, answer with this and do not claim another vendor's model or a training cutoff.`);
  }

  private notice(live: Live, level: "info" | "warning", message: string) {
    if (!live.muted) this.emit("agentNotice", { sessionId: live.meta.sessionId, level, message });
  }

  /** Decision-grade route metadata: one copy of each reason code. */
  private reason(record: RouteRecord, code: string) {
    if (!record.reasonCodes.includes(code)) record.reasonCodes.push(code);
  }

  private stageCapNotice(live: Live, cap: number) {
    if (!live.muted) this.emit("agentNotice", { sessionId: live.meta.sessionId, level: "warning", message: `${HARNESS_NAME} stopped after ${cap} steps. Send a message to continue.` });
  }

  private collectObservation(collect: BuildObservations, result: CallResult) {
    const observation = result.observation;
    if (!observation) return;
    if (observation.path && (observation.oldText !== undefined || observation.newText !== undefined)) {
      const delta = lineDelta(observation.oldText ?? "", observation.newText ?? "");
      const current = collect.files.get(observation.path) ?? { added: 0, removed: 0 };
      collect.files.set(observation.path, { added: current.added + delta.added, removed: current.removed + delta.removed });
      const patch = linePatch(observation.path, observation.oldText ?? "", observation.newText ?? "");
      if (patch) collect.patches.push(patch);
    }
    if (observation.command && observation.exitCode !== undefined) {
      collect.checks.push({
        command: observation.command.slice(0, 500),
        status: observation.exitCode === 0 ? "passed" : "failed",
        ...(result.isError ? { detail: result.output.split("\n")[0].slice(0, 300) } : {}),
      });
    }
  }

  private buildReport(observations: BuildObservations, answer: string): BuildReport {
    let added = 0;
    let removed = 0;
    for (const delta of observations.files.values()) {
      added += delta.added;
      removed += delta.removed;
    }
    const files = observations.files.size;
    const patch = observations.patches.join("\n");
    const diff = patch.length <= MAX_REPORT_DIFF_CHARS ? patch : `${patch.slice(0, MAX_REPORT_DIFF_CHARS - 100)}\n… (diff shortened)`;
    const report: BuildReport = {
      kind: "build-report",
      version: 1,
      summary: (answer.trim() || "The Builder finished without a final summary.").slice(0, 4_000),
      diffStat: files ? `${files} file${files === 1 ? "" : "s"} changed, +${added}/-${removed}` : "No file changes were recorded.",
      diff,
      checks: observations.checks,
      deviations: [],
      openQuestions: [],
    };
    const valid = validateBuildReport(report);
    if (!valid.ok) throw new Error(`The Builder's report could not be assembled: ${valid.errors.join(" ")}`);
    return valid.value;
  }

  /** Put a handoff document in the turn's trajectory and return its item id. */
  private emitHandoff(live: Live, kind: HandoffItemKind, text: string): string {
    const itemId = this.itemId(live, "orchestrator");
    this.emitItem(live, { itemId, kind, status: "completed", text: text.slice(0, 12_000), turnId: live.turnId }, true);
    return itemId;
  }

  private validateScoutPack(pack: ContextPack, toolsUsed: readonly string[]): string[] {
    const errors: string[] = [];
    if (!toolsUsed.length) errors.push("The scout must read at least one file.");
    const serialized = JSON.stringify(pack);
    if (serialized.length > this.tuning.scout.maxPackChars) errors.push(`The context pack is too large; keep it under ${this.tuning.scout.maxPackChars} characters.`);
    if (pack.excerpts.length > 20) errors.push("Use at most 20 excerpts.");
    const long = pack.excerpts.find((excerpt) => excerpt.text.length > this.tuning.scout.maxExcerptChars);
    if (long) errors.push(`The excerpt for ${long.path} is too long; keep each under ${this.tuning.scout.maxExcerptChars} characters.`);
    return errors;
  }

  private planSummary(plan: OrchestratorPlan): string {    const lines = [
      `Goal: ${plan.goal}`,
      `Acceptance: ${plan.acceptanceCriteria.join("; ")}`,
      `Files: ${plan.fileTargets.map((target) => `${target.path}${target.intent ? ` — ${target.intent}` : ""}`).join("; ")}`,
      `Steps: ${plan.steps.map((step, index) => `${index + 1}. ${step.intent}${step.files.length ? ` (${step.files.join(", ")})` : ""}`).join(" ")}`,
    ];
    if (plan.checks.length) lines.push(`Checks: ${plan.checks.join("; ")}`);
    if (plan.constraints.length) lines.push(`Constraints: ${plan.constraints.join("; ")}`);
    if (plan.risks.length) lines.push(`Risks: ${plan.risks.join("; ")}`);
    if (plan.askLeadIf.length) lines.push(`Ask the Lead if: ${plan.askLeadIf.join("; ")}`);
    return lines.join("\n");
  }

  private reportSummary(report: BuildReport, label: string): string {
    const checks = report.checks.length
      ? `Checks: ${report.checks.map((check) => `${check.command} — ${check.status}${check.detail ? ` (${check.detail})` : ""}`).join("; ")}`
      : "Checks: none recorded";
    const lines = [`${label}: ${report.summary}`, report.diffStat, checks];
    if (report.deviations.length) lines.push(`Deviations: ${report.deviations.join("; ")}`);
    if (report.openQuestions.length) lines.push(`Open questions: ${report.openQuestions.join("; ")}`);
    return lines.join("\n");
  }

  private reviewSummary(notes: ReviewNotes): string {
    return [`Review: ${notes.outcome}`, ...(notes.fixes.length ? [`Fixes: ${notes.fixes.join("; ")}`] : [])].join("\n");
  }

  /** One model call, streamed into reasoning and message items, with retries for transient failures. */
  private async callModel(live: Live, provider: ResolvedProvider, modelId: string, model: string, system: SystemPrompt, tools: readonly ToolSchema[], signal: AbortSignal, window: number | null, listedReasoning?: boolean, listedEfforts?: readonly string[], route?: CallRoute, options: CallOptions = {}): Promise<{ message: AssistantMessage; stopReason: string; effort?: string }> {
    const serving = this.servingSystem(system, model, provider);
    let effort = route ? route.effort : live.meta.effort && (live.meta.effort !== "none" || SENDS_NONE.has(provider.id)) ? live.meta.effort : undefined;
    const tiers = effortTiers(provider.id, model, provider.wire, listedReasoning, listedEfforts) as string[];
    if (effort && !tiers.includes(effort)) effort = undefined;
    // ZenMux fills an omitted effort with medium. Kimi K3 does not accept that, and its published default is max.
    if (!effort && tiers.length === 3 && tiers[0] === "low" && tiers[1] === "high" && tiers[2] === "max") effort = "max";
    const startedAt = Date.now();
    const cap = this.limits.retryElapsedMs ?? RETRY_ELAPSED_MS;
    // The window is only known for catalog and family-known models. Unknown means no fitting: current behaviour, unchanged.
    let budget = window ? contextBudget(window) : null;
    // System prompt and tool schemas never change within a call, so their cost is measured once.
    let fixedTokens = budget ? estimateRequestTokens({ system: serving, messages: [], tools }) : 0;
    let providerOverflow = false;
    // One tighter refit after a reported overflow. A second rejection stands.
    let overflowRetried = false;
    // The request view, re-fitted per attempt: a retry after an overflow fits the already-trimmed
    // view again, so each attempt is strictly smaller than the one the provider rejected.
    let view: ChatMessage[] | undefined;
    for (let attempt = 1; ; attempt += 1) {
      const streams: { reasoning?: { itemId: string; text: string }; text?: { itemId: string; text: string } } = {};
      // This call's own counts. Cache fields stay put when a later event omits them.
      const spent = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const attemptAt = Date.now();
      const close = () => {
        if (options.emitText === false) return;
        for (const kind of ["reasoning", "text"] as const) {
          const open = streams[kind];
          if (open) this.emitItem(live, { itemId: open.itemId, kind: kind === "text" ? "agentMessage" : "reasoning", status: "completed", text: open.text, turnId: live.turnId }, true);
        }
      };
      // Fit the request into the window before sending. Trimming is a request view:
      // the transcript keeps full output, and the model is told what was shortened.
      // `view` persists across attempts, so a retry after an overflow fits the
      // already-trimmed view again — each attempt strictly smaller than the last.
      // Thinking blocks carry the signature of the model that produced them, so
      // a routed turn strips any that came from another model before sending.
      view ??= sanitizeHistory(options.messages ?? this.history(live), modelId, live.meta.modelId);
      const fitted = fitHistory({ messages: view, budget: budget ? Math.max(1, budget.input - fixedTokens) : null, force: budget ? providerOverflow : false });
      if (fitted.outcome === "unfittable") throw unfittableContextError();
      providerOverflow = false;
      view = fitted.messages;
      if (fitted.trimmed && !live.muted && !live.contextNotified) {
        live.contextNotified = true;
        this.emit("agentNotice", {
          sessionId: live.meta.sessionId,
          level: "info",
          message: "The thread's history was shortened to fit the model's context window; the full transcript keeps everything.",
        });
      }
      try {
        for await (const event of streamChat({ provider, modelId, system: serving, messages: fitted.messages, tools, effort, listedReasoning, listedEfforts, signal, timeouts: { idleMs: this.limits.idleMs, firstEventMs: this.limits.firstEventMs }, fetchImpl: this.fetchImpl })) {
          if (event.type === "text" || event.type === "reasoning") {
            if (options.emitText === false) continue;
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
            const surface = this.surface(live);
            if (reportedInput && window && !surface.muted && options.emitContext !== false) {
              this.emit("sessionFacts", {
                sessionId: surface.meta.sessionId,
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
            this.accumulateUsage(live, spent);
            const reported = Boolean(spent.input || spent.output || spent.cacheRead || spent.cacheWrite);
            if (!live.muted || reported) this.emitCall(this.surface(live), {
              callId: randomUUID(),
              ...(route ? { routeId: route.routeId, role: route.role, stage: route.stage } : {}),
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
            // The model is part of the message so a later cross-model call can
            // tell which thinking blocks are safe to send back.
            return { message: { ...event.message, modelId }, stopReason: event.stopReason, ...(effort ? { effort } : {}) };
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
        // An input overflow cannot be retried as-is. One retry refits the original
        // history against half the budget and forces the next trim rung. A second
        // rejection stands. An unknown window gets no speculative shrinking.
        const overflow = error instanceof ProviderError && (error.code === "CONTEXT_WINDOW_EXCEEDED" || (error.status === 400 && CONTEXT_WINDOW.test(message)));
        if (overflow) {
          if (!overflowRetried && budget) {
            const original = sanitizeHistory(options.messages ?? this.history(live), modelId, live.meta.modelId);
            const input = Math.max(1, Math.floor(budget.input / 2));
            const fixed = estimateRequestTokens({ system, messages: [], tools });
            const tighter = fitHistory({ messages: original, budget: Math.max(1, input - fixed), force: true });
            // A second provider call is useful only when the smaller request actually fits.
            if (!tighter.trimmed) throw error;
            if (tighter.outcome === "unfittable") throw unfittableContextError();
            overflowRetried = true;
            view = original;
            budget = { input, output: budget.output };
            fixedTokens = fixed;
            providerOverflow = true;
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
    // A user can navigate the shared page while an approval waits. Do not let
    // the old origin's approval act on the new one: ask again before execution.
    if (kind === "browser" && subject?.kind === "browser" && subject.control) {
      let latest: Subject | undefined;
      try { latest = definition.subject?.(live.meta.workspaceRoot, frozen) ?? subject; } catch { latest = undefined; }
      if (!latest) {
        const output = noted("The browser permission check failed, so this call was refused.");
        this.emitItem(live, { ...base, status: "failed", failureReason: output, visibleOutput: output }, true);
        return { id: call.id, name: call.name, output, isError: true };
      }
      if (latest.kind === "browser" && (latest.origin !== subject.origin || latest.control !== subject.control)) {
        const refreshed = decide({ kind, subject: latest, mode: live.approvalMode, planMode: live.meta.mode === "plan", grants: live.grants });
        if (refreshed.kind === "deny") {
          const output = noted(refreshed.reason);
          this.emitItem(live, { ...base, status: "failed", failureReason: output, visibleOutput: output }, true);
          return { id: call.id, name: call.name, output, isError: true };
        }
        if (refreshed.kind === "ask") {
          const outcome = await this.ask(live, call, kind, latest, refreshed);
          if (outcome.kind !== "allowed") {
            const output = noted(REFUSALS[outcome.kind]);
            this.emitItem(live, { ...base, status: outcome.kind === "cancelled" ? "cancelled" : "failed", failureReason: output, visibleOutput: output }, true);
            return { id: call.id, name: call.name, output, isError: true };
          }
          if (outcome.grant) live.grants.push(outcome.grant);
        }
        subject = latest;
      }
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
    const observation: ToolObservation | undefined = presentation ? {
      ...(presentation.path ? { path: presentation.path } : {}),
      ...(presentation.command ? { command: presentation.command } : {}),
      ...(presentation.exitCode !== undefined ? { exitCode: presentation.exitCode } : {}),
      ...(presentation.oldText !== undefined ? { oldText: presentation.oldText } : {}),
      ...(presentation.newText !== undefined ? { newText: presentation.newText } : {}),
    } : undefined;
    if (kind !== "delegate") this.emitItem(live, {
      ...base,
      status: result.isError ? "failed" : "completed",
      visibleOutput: visible,
      ...(presentation ? { presentation } : {}),
      ...(presentation?.truncated ? { truncated: true } : {}),
      ...(result.exitCode != null ? { exitCode: result.exitCode } : {}),
      ...(result.isError ? { failureReason: visible.split("\n")[0].slice(0, 300) } : {}),
    }, true);
    return { id: call.id, name: call.name, output, ...(result.isError ? { isError: true } : {}), ...(result.activate?.length ? { activate: result.activate } : {}), ...(result.images?.length ? { images: result.images } : {}), ...(observation ? { observation } : {}) };
  }

  /** The question this thread is waiting on, as the app's card renders it. */
  private openQuestions(live: Live) {
    return live.question ? [questionRequest(live.meta.sessionId, live.question)] : [];
  }

  /** Record that a turn ended asking the user. Only the first ask in a batch stands. */
  private async parkQuestion(live: Live, turnId: string, results: CallResult[], target?: { builder?: { planId: string } }) {
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
      ...(target?.builder ? { target: "builder" as const, planId: target.builder.planId } : {}),
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
    if (pending.intent?.kind === "planReview" && live.pendingPlan) {
      // Approval hands the validated plan to the next Build turn; any other
      // answer drops it so the Lead plans again.
      if (settled.leavePlanMode) {
        live.approvedPlan = { plan: live.pendingPlan.plan, ...(live.pendingPlan.itemId ? { itemId: live.pendingPlan.itemId } : {}) };
        await this.appendLeadMessage(live, { role: "user", content: [{ type: "text", text: "The user approved the plan. Carry it out." }] });
      }
      live.pendingPlan = undefined;
    }
    const message: ChatMessage = { role: "tool", results: pending.results.map((result) => (result.id === pending.callId ? { id: result.id, name: result.name, output: settled.output } : result)) };
    live.question = undefined;
    if (pending.target === "builder") {
      // The Builder continues in its own session; the thread keeps only a
      // neutral note so a future plan can see what was decided.
      if (live.builder && pending.planId === live.builder.planId) await this.appendBuilderMessage(live, message);
      const neutral: ChatMessage = { role: "user", content: [{ type: "text", text: `The user answered the Builder's question: ${settled.summary}` }] };
      live.messages.push(neutral);
      await this.store.append(live.meta.sessionId, [{ type: "message", message: neutral }, { type: "questionSettled", userInputId: pending.userInputId }]);
    } else {
      live.messages.push(message);
      await this.store.append(live.meta.sessionId, [{ type: "message", message }, { type: "questionSettled", userInputId: pending.userInputId }]);
    }
    this.emitItem(live, { ...pending.item, status: "completed", visibleOutput: settled.summary }, true);
    this.emit("userInputs", { sessionId: live.meta.sessionId, requests: [] });
    return settled;
  }

  /** The user settled the question the last turn ended with: record it, then continue in a new turn. */
  async respondUserInput(options: { sessionId: string; userInputId: string; response: UserInputResponse }) {
    const live = this.requireLive(options.sessionId);
    if (live.question?.userInputId !== options.userInputId) throw new Error("This question is no longer pending. Reopen the thread to refresh it.");
    if (live.prompting) throw new Error(`${HARNESS_NAME} is still working. Answer when the turn ends.`);
    // The answer continues the task the question belongs to, so it keeps that shape.
    const openTask = live.openTask;
    let prompt = "Continue the current task.";
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
          prompt = settled.feedback;
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
    void this.runTurn(live, turnId, { prompt, ...(openTask ? { openTask } : {}) });
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

  /**
   * Settings → Orchestrator's role check. Builder and Small-task run a real
   * write/read in a throwaway directory; Router and Lead are tool-less format
   * checks. Nothing reaches a session, transcript or store, and the result is
   * cached for this host's lifetime unless a refresh is requested.
   */
  async orchestratorProbe(options: { role: string; providerId: string; modelId: string; timeoutMs?: number; refresh?: boolean; signal?: AbortSignal }): Promise<ProbeResult> {
    if (!isProbeRole(options.role)) throw new Error(`Unknown orchestrator role: ${options.role || "none"}.`);
    const role = options.role;
    const modelId = options.modelId.trim();
    if (!modelId) throw new Error("A model is required for the probe.");
    const providerId = options.providerId.trim() || splitModelId(modelId).providerId;
    if (!providerId) throw new Error(`${modelId} does not name a provider.`);
    const target = { role, providerId, modelId };
    const cached = findProbe(this.probes, target);
    if (cached && options.refresh !== true) return cached;
    const key = `${role}\u0000${providerId}\u0000${modelId}`;
    const running = this.probeRuns.get(key);
    if (running) return running;
    const run = this.runOrchestratorProbe(target, options.timeoutMs, options.signal)
      .then((result) => {
        // A check cut short by a stopped turn says nothing about the model.
        if (!options.signal?.aborted) this.probes = recordProbe(this.probes, result);
        return result;
      })
      .finally(() => { this.probeRuns.delete(key); });
    this.probeRuns.set(key, run);
    return run;
  }

  /**
   * A read-tool capability check for a read-enabled role. It is internal (not a
   * Settings probe): the caller falls back to no reads when it fails, never to
   * another model. The result is cached for this host's lifetime.
   */
  async orchestratorReadProbe(options: { modelId: string; timeoutMs?: number; signal?: AbortSignal }): Promise<{ ok: boolean; detail: string }> {
    const modelId = options.modelId.trim();
    if (!modelId) throw new Error("A model is required for the read probe.");
    const cached = this.readProbes.get(modelId);
    if (cached) return cached;
    const run = this.runReadProbe(modelId, options.timeoutMs, options.signal);
    this.readProbes.set(modelId, run);
    void run.then(() => { if (options.signal?.aborted) this.readProbes.delete(modelId); });
    return run;
  }

  private async runReadProbe(modelId: string, timeoutMs?: number, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    const { providerId } = splitModelId(modelId);
    const provider = resolveProvider(providerId, this.credentials);
    if (!provider) return { ok: false, detail: `${providerSpec(providerId)?.name ?? providerId} has no key.` };
    const budget = Math.min(120_000, Math.max(5_000, timeoutMs ?? 90_000));
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), budget);
    timer.unref?.();
    const scratch = await mkdtemp(join(tmpdir(), "glitter-read-probe-"));
    const definitions = BUILTIN_TOOLS.filter((definition) => READ_ONLY_TOOL_NAMES.has(definition.schema.name));
    const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: `Read ./${PROBE_FILE} with the read_file tool. Do not use any other tool. Reply with exactly: ${PROBE_DONE}` }] }];
    let readProbeFile = false;
    try {
      await writeFile(join(scratch, PROBE_FILE), PROBE_CONTENT, "utf8");
      for (let step = 0; step < 3; step += 1) {
        if (controller.signal.aborted) return { ok: false, detail: "The read probe was interrupted." };
        let reply: AssistantMessage | undefined;
        for await (const event of streamChat({
          provider,
          modelId,
          system: { stable: "You are running a fixed read-only capability check. Follow the instructions exactly, do not ask questions, and do not call tools that were not provided.", volatile: "" },
          messages,
          tools: definitions.map((definition) => definition.schema),
          signal: controller.signal,
          timeouts: { idleMs: this.limits.idleMs, firstEventMs: this.limits.firstEventMs },
          fetchImpl: this.fetchImpl,
        })) {
          if (event.type === "done") reply = event.message;
        }
        if (!reply) return { ok: false, detail: `${provider.name} ended the read probe without a reply.` };
        messages.push(reply);
        if (!reply.toolCalls?.length) {
          const ok = readProbeFile && reply.text.trim() === PROBE_DONE;
          return { ok, detail: ok ? "Read tool use verified." : "The read probe must read the probe file and reply probe-ok." };
        }
        const results: Array<{ id: string; name: string; output: string; isError?: boolean }> = [];
        for (const call of reply.toolCalls) {
          const definition = definitions.find((tool) => tool.schema.name === call.name);
          if (!definition) {
            results.push({ id: call.id, name: call.name, output: `Unknown tool: ${call.name}. Only read_file, list_files and grep are available.`, isError: true });
            continue;
          }
          const prepared = await prepareTool(definition, scratch, call.input);
          if (prepared.error) {
            results.push({ id: call.id, name: call.name, output: prepared.error, isError: true });
            continue;
          }
          const outcome = await executeTool(definition, scratch, prepared.input, controller.signal);
          const path = typeof call.input.path === "string" ? call.input.path.replace(/^\.\//, "") : "";
          if (call.name === "read_file" && path === PROBE_FILE && !outcome.isError && outcome.output.includes(PROBE_CONTENT)) readProbeFile = true;
          results.push({ id: call.id, name: call.name, output: outcome.output, ...(outcome.isError ? { isError: true } : {}) });
        }
        messages.push({ role: "tool", results });
      }
      return { ok: false, detail: "The read probe did not finish within three model turns." };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, detail: `The read probe did not finish within ${Math.round(budget / 1000)} seconds.` };
      return { ok: false, detail: error instanceof Error ? error.message.slice(0, 500) : "The read probe failed." };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async runOrchestratorProbe(target: { role: ProbeRole; providerId: string; modelId: string }, timeoutMs?: number, signal?: AbortSignal): Promise<ProbeResult> {
    const provider = resolveProvider(target.providerId, this.credentials);
    if (!provider) throw new ProviderError(`${providerSpec(target.providerId)?.name ?? target.providerId} has no key.`, undefined, "MISSING_CREDENTIAL");
    const budget = Math.min(120_000, Math.max(5_000, timeoutMs ?? 90_000));
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), budget);
    timer.unref?.();
    let scratch: string | undefined;
    try {
      if (target.role === "builder" || target.role === "small") scratch = await mkdtemp(join(tmpdir(), "glitter-probe-"));
      return await runProbe({
        target,
        checkedAt: Date.now(),
        execute: async (request) => {
          try {
            return await this.executeProbe(request, provider, target.modelId, scratch, controller.signal);
          } catch (error) {
            if (controller.signal.aborted) throw new ProviderError(`The probe did not finish within ${Math.round(budget / 1000)} seconds.`, undefined, "TIMEOUT");
            throw error;
          }
        },
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async executeProbe(request: ProbeRequest, provider: ResolvedProvider, modelId: string, scratch: string | undefined, signal: AbortSignal): Promise<ProbeResponse> {
    const definitions = request.kind === "builder-tool-edit" && scratch
      ? BUILTIN_TOOLS.filter((tool) => tool.schema.name === "read_file" || tool.schema.name === "write_file")
      : [];
    const tools = definitions.map((definition) => definition.schema);
    const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: request.prompt }] }];
    const toolCalls: ProbeResponse["toolCalls"] = [];
    for (let step = 0; step < 4; step += 1) {
      if (signal.aborted) throw new ProviderError("The probe was interrupted.", undefined, "TIMEOUT");
      let reply: AssistantMessage | undefined;
      for await (const event of streamChat({
        provider,
        modelId,
        system: { stable: "You are running a fixed capability check. Follow the instructions exactly, do not ask questions, and do not call tools that were not provided.", volatile: "" },
        messages,
        tools,
        signal,
        timeouts: { idleMs: this.limits.idleMs, firstEventMs: this.limits.firstEventMs },
        fetchImpl: this.fetchImpl,
      })) {
        if (event.type === "done") reply = event.message;
      }
      if (!reply) throw new ProviderError(`${provider.name} ended the probe without a reply.`);
      if (request.kind !== "builder-tool-edit" || !scratch) return { text: reply.text, toolCalls: [] };
      messages.push(reply);
      if (!reply.toolCalls?.length) {
        const content = await readFile(join(scratch, PROBE_FILE), "utf8").catch(() => undefined);
        return { text: reply.text, toolCalls, ...(content !== undefined ? { files: { [PROBE_FILE]: content } } : {}) };
      }
      const results: Array<{ id: string; name: string; output: string; isError?: boolean }> = [];
      for (const call of reply.toolCalls) {
        toolCalls.push({ name: call.name, arguments: call.input });
        const definition = definitions.find((tool) => tool.schema.name === call.name);
        if (!definition) {
          results.push({ id: call.id, name: call.name, output: `Unknown tool: ${call.name}. Only write_file and read_file are available.`, isError: true });
          continue;
        }
        const prepared = await prepareTool(definition, scratch, call.input);
        if (prepared.error) {
          results.push({ id: call.id, name: call.name, output: prepared.error, isError: true });
          continue;
        }
        const outcome = await executeTool(definition, scratch, prepared.input, signal);
        results.push({ id: call.id, name: call.name, output: outcome.output, ...(outcome.isError ? { isError: true } : {}) });
      }
      messages.push({ role: "tool", results });
    }
    throw new Error("The probe did not finish within four model turns.");
  }
}
