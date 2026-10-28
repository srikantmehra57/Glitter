export type ApprovalMode = "allowAll" | "promptUnmatched" | "onRequest" | "denyUnmatched" | "guarded";
/** The modes the Muse CLI accepts. Auto (`guarded`) is translated before it is sent. */
export type CliApprovalMode = Exclude<ApprovalMode, "guarded">;
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ThemeMode = "system" | "dark" | "light";
export type AccentColor = "ember" | "mono" | "blue" | "violet" | "pink" | "orange" | "yellow" | "green" | "teal";
/** How deep the dark theme goes; `mid` is the default Smoke palette. */
export const DARK_INTENSITIES = ["subtle", "mid", "black"] as const;
export type DarkIntensity = (typeof DARK_INTENSITIES)[number];
/** Interface typeface. `system` is the face in styles.css; Inter is bundled and the rest ship with macOS. */
export const UI_FONTS = ["system", "inter", "helvetica", "avenir", "gill", "futura"] as const;
export type UiFont = (typeof UI_FONTS)[number];
/** Vertical rhythm for workspace and thread rows; standard preserves the original 28px rows. */
export const SIDEBAR_DENSITIES = ["standard", "comfortable", "compact"] as const;
export type SidebarDensity = (typeof SIDEBAR_DENSITIES)[number];
export const THINKING_ORBS = ["auto", "working", "searching", "solving", "listening", "connecting", "weaving", "composing", "breathing", "shaping"] as const;
export type ThinkingOrbStyle = (typeof THINKING_ORBS)[number];
/** Which credential pays for a session: the Muse Code subscription sign-in, or a metered API key. */
export type AuthSource = "subscription" | "apiKey";
export type AuthMode = "auto" | AuthSource;
import type { UserInputRequest, UserInputResponse, UserInputAnswer } from "../../../../packages/glitter-bridge/src/protocol";
export type { UserInputRequest, UserInputResponse, UserInputAnswer };
import type { BrowserControlInput, BrowserControlResult, BrowserFrame, BrowserState, BrowserStateEvent, BrowserViewport } from "../../../../packages/glitter-bridge/src/browser-types";
export type { BrowserControlInput, BrowserControlResult, BrowserFrame, BrowserState, BrowserStateEvent, BrowserViewport };

import type { ShortcutOverrides } from "./shortcuts";

/** One predicted starter prompt on the new-thread empty state, drafted by the user's chosen agent. */
export type Suggestion = { title: string; prompt: string };

export type Workspace = {
  id: string;
  path: string;
  name: string;
  /**
   * Native grant id authorizing this root. Minted by the native folder
   * picker, persisted as a display hint, and re-validated against the
   * native grant store on every launch. Null means ungranted: session, git,
   * and open operations fail until the folder is re-opened.
   */
  grantId?: string | null;
  /**
   * Explicit workspace trust: the host loads this workspace's skills and
   * rules only when true. Untrusted by default; switching the selected
   * workspace across the trust boundary restarts the host.
   */
  trusted?: boolean;
  /**
   * The first-open trust prompt has already run for this workspace. Set once
   * the preview has been fetched (and shown or skipped) so the dialog never
   * reappears on re-selection.
   */
  trustPrompted?: boolean;
};

/** Settings → Models' Test: how long a one-word reply took, and the start of it. */
export type ModelTestResult = { latencyMs: number; firstTokenMs: number | null; reply: string };

/** A user-defined slash command: a prompt template. `$ARGUMENTS` in the body marks where the user's input goes. */
export type CustomCommand = { name: string; description: string; body: string };
export const EDITOR_CHOICES = ["default", "vscode", "cursor", "zed", "idea"] as const;
export type EditorChoice = (typeof EDITOR_CHOICES)[number];
export const EDITOR_LABELS: Record<EditorChoice, string> = { default: "System default", vscode: "VS Code", cursor: "Cursor", zed: "Zed", idea: "IntelliJ IDEA" };
/** Settings pages, in navigation order. Names and groups are in `lib/settingsNav.ts`. */
export const SETTINGS_TABS = ["Models", "Orchestrator", "Providers", "Agents", "Extensions", "Permissions", "Threads", "General", "Theme", "Shortcuts", "Usage", "Diagnostics", "About"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** `harness` is the app's own agent: it calls model providers with the user's keys (Settings → Providers). */
export type AgentId = "harness" | "muse" | "opencode" | "grok" | "gemini" | "qwen" | "goose" | "cline";
export const AGENT_IDS: AgentId[] = ["harness", "muse", "opencode", "grok", "gemini", "qwen", "goose", "cline"];
export const AGENT_LABELS: Record<AgentId, string> = {
  harness: "Harness",
  muse: "Muse",
  opencode: "OpenCode",
  grok: "Grok",
  gemini: "Gemini CLI",
  qwen: "Qwen Code",
  goose: "Goose",
  cline: "Cline CLI",
};
/** OpenCode is off until the user turns it on — Zen free models fail on many accounts. */
export const DEFAULT_ENABLED_AGENTS: Record<AgentId, boolean> = {
  harness: true,
  muse: true,
  opencode: false,
  grok: false,
  gemini: false,
  qwen: false,
  goose: false,
  cline: false,
};
export function agentEnabled(settings: { enabledAgents?: Partial<Record<AgentId, boolean>>; acpUnisolatedConsent?: boolean }, id: AgentId): boolean {
  // Native consent also overrides stale per-agent choices; callers without
  // consent state retain the per-agent preference behavior.
  if (id !== "harness" && id !== "muse" && settings.acpUnisolatedConsent === false) return false;
  return settings.enabledAgents?.[id] ?? DEFAULT_ENABLED_AGENTS[id];
}

/**
 * Map a `skills list` scope to the `skills enable|disable --scope` argument
 * (live-verified: list reports `bundled`, the mutator takes `built-in`).
 * Unknown scopes yield null: lifecycle buttons stay hidden rather than guess.
 */
export function skillScopeArg(scope: string): string | null {
  const normalized = scope.trim().toLowerCase();
  if (normalized === "bundled" || normalized === "built-in") return "built-in";
  if (normalized === "user" || normalized === "project" || normalized === "plugin") return normalized;
  return null;
}
/** A coding-agent CLI found on this machine (Muse over MSP, the rest over ACP). */
export type AgentInfo = {
  id: AgentId;
  name: string;
  protocol: "msp" | "acp" | "native";
  found: boolean;
  path: string | null;
  version: string | null;
  verified: boolean;
  signIn: string;
  authenticated?: boolean;
};

/** Point-in-time `session/read` result for the preview modal (never attached). */
export type SessionPreview = {
  session?: { status?: string; activeTurnId?: string | null; updatedAt?: string; [key: string]: unknown };
  history?: { items?: TranscriptItem[] };
};

/** Native ACP identity: canonical binary, version, and pin/drift state. */
export type AgentIdentity = {
  agentId: AgentId;
  name: string;
  path: string | null;
  version: string | null;
  pinned: boolean;
  changed: boolean;
};

export type Detection = {
  found: boolean;
  path: string | null;
  version: string | null;
  authenticated: boolean;
  method: string | null;
  /** Credential the next session will bill, after applying the chosen mode. */
  activeAuth?: AuthSource | null;
  subscriptionAvailable?: boolean;
  apiKeyAvailable?: boolean;
  /** Display name/email from the `muse /login` credential, when signed in. */
  accountName?: string | null;
  accountEmail?: string | null;
  running?: boolean;
  agents?: AgentInfo[];
};

export type DiagnosticsSnapshot = { os: string; arch: string; logTail: string[] };
/** Native app-log and Harness session-log locations; no renderer-chosen paths. */
export type SupportPaths = { appLogPath: string; sessionLogPath: string | null };

/** Muse CLI release-channel urgency (`muse-launcher.sh` channel manifest). */
export type CliUpdateUrgency = "none" | "encouraged" | "must_download";

/** Installed CLI compared against its release channel (`checkCliUpdate` verb). */
export type CliUpdateStatus = {
  available: boolean;
  /** Installed channel version (`3.14.4-R2`); null when not launcher-managed. */
  current: string | null;
  /** Channel version; null when the check could not run. */
  latest: string | null;
  urgency: CliUpdateUrgency;
  /** Channel `notification_text`: the release notes shown beside the update. */
  notification: string;
  channel: string;
};

/** Outcome of one explicit CLI update run (`updateCli` verb). */
export type CliUpdateOutcome = {
  updated: boolean;
  from: string | null;
  to: string | null;
  /** New channel version, else the `--version` print for display. */
  version: string | null;
};

/** Protocol-compatibility snapshot from the `muse serve` handshake. */
export type HostCompat = {
  /** `@muse-code/sdk` the bridge was written against. */
  sdk: string;
  /** Stable-schema fingerprint the SDK pins. */
  pinned: string;
  /** Fingerprint the host served, when it sent one. */
  served: string | null;
  /** `unknown` when the host sent no fingerprint; never overclaims a match. */
  state: "match" | "mismatch" | "unknown";
  /** Capabilities granted for this connection. */
  granted: string[];
};

/** Live `muse serve` host facts, captured at `startHost` and cleared when the host dies. */
export type HostInfo = {
  server?: { name?: string; version?: string } | null;
  museHome?: string | null;
  durability?: string | null;
  bin?: string | null;
  activeAuth?: AuthSource | null;
  compat?: HostCompat | null;
  trustWorkspace?: boolean | null;
  /** Posture the running host was constructed with; absent while stopped. */
  posture?: HostPosture | null;
  isolation?: {
    env: "minimal";
    /** cli-managed delegates shell isolation to Muse's per-session policy. */
    osSandbox: "enforced" | "unavailable" | "cli-managed";
    platform: string;
    cwd?: string;
    consentRequired: boolean;
  } | null;
};

/** Trusted-content preview: project skills plus the workspace rules excerpt. */
export type TrustPreview = {
  skills: Array<{ name: string; description: string }>;
  rules: { path: string; excerpt: string; truncated: boolean } | null;
};

/** One user-invocable skill row (`skill/list`): the selector is the exact typed spelling. */
export type SkillRow = {
  selector: string;
  displayName?: string;
  description?: string;
  source?: string;
  pluginId?: string;
  argumentHint?: string;
};

/** A CLI-configured MCP server: OAuth applies to streamable-HTTP servers. */
export type McpServer = { name: string; transport: string; oauth: boolean };
/** A server the Harness started from `.glitter/mcp.json`; `tools` is what its last listing returned. */
export type HarnessMcpServer = { name: string; transport: string; tools: number };
export type HarnessMcpStatus = { servers: HarnessMcpServer[]; error: string | null };
/** Which `.glitter/mcp.json` a server lives in; the workspace file wins a duplicate name. */
export type HarnessMcpScope = "workspace" | "home";
/** A configured server for the management list. Values from env and headers never reach the renderer, only their key names. */
export type HarnessMcpConfigServer = {
  name: string;
  source: HarnessMcpScope;
  transport: string;
  command?: string;
  url?: string;
  args: number;
  envKeys: string[];
  headerKeys: string[];
  error?: string;
};
export type HarnessMcpConfig = { servers: HarnessMcpConfigServer[]; error: string | null };
/** Native, digest-bound approval for the exact workspace and home MCP files reviewed in Extensions. */
export type HarnessMcpReview = { trusted: boolean; current: boolean; hasWorkspaceConfig: boolean; configurationDigest: string };
/** A server the app may add; env and header values are written once and never read back. */
export type HarnessMcpServerInput = {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

/** One entry in the bundled extension store: a skill, an MCP server, or a plugin that bundles either. */
export type CatalogKind = "skill" | "mcp" | "plugin";
export type CatalogEntry = {
  id: string;
  kind: CatalogKind;
  name: string;
  summary: string;
  description: string;
  tags: string[];
  version: number;
  /** Skill ids this entry installs into `~/.agents/skills`. */
  skills: string[];
  /** Server ids this entry writes to `.glitter/mcp.json`. */
  servers: string[];
  /** Where the servers go: `user` is the home config, `mixed` spans both. */
  scope: "user" | "workspace" | "mixed";
  requiresWorkspace: boolean;
  /** The commands or URLs the entry would add, for review before installing. */
  commands: string[];
  installed: boolean;
  installedParts: number;
  totalParts: number;
};
export type CatalogList = { entries: CatalogEntry[]; skillsRoot: string; error: string | null };
export type CatalogInstallResult = { installedSkills: string[]; installedServers: string[]; skipped: string[]; errors: string[] };
export type CatalogRemoveResult = { removed: string[]; skipped: string[]; errors: string[] };

export type PluginEntry = { id: string; version?: string | null; description: string; enabled?: boolean | null };
/** One CLI skill row (`skills list`): `activation` is `on`/`off`, `scope` is user/project/bundled/plugin. */
export type SkillEntry = { id: string; name: string; description: string; scope: string; activation: string };
/** One inspected skill (`skills inspect`): identity, scope, activation, and on-disk path. */
export type SkillDetail = { id: string; name: string; description: string; scope: string; activation: string; path: string | null };
/** One enterprise config plane source (`config status`): plane, source class, and state. */
export type EnterpriseSource = { plane: string; sourceClass: string; state: string };
/** Enterprise configuration status: policy generation plus plane sources. */
export type EnterpriseStatus = { generation: string | null; sources: EnterpriseSource[] };
export type PluginCapability = { id: string; kind?: string | null; description: string; enabled?: boolean | null };
export type PluginDetail = { id: string; version?: string | null; description: string; capabilities: PluginCapability[] };

/** Live options an ACP agent reports for a session. */
export type AgentSessionConfig = { modelId?: string; effort?: ReasoningEffort; mode?: string; modes?: Array<{ value: string; name?: string; description?: string }>; orchestrator?: OrchestratorConfig | null };

export type ApprovalChoice = {
  choiceId: string;
  label: string;
  decision: string;
  scope: string;
  acceptsFeedback?: boolean;
  /** How far a thread grant reaches, such as "This exact command". Thread choices that carry one share a scope picker. */
  scopeLabel?: string;
};

export type ApprovalRequest = {
  approvalId: string;
  sessionId: string;
  turnId: string;
  toolName: string;
  rawArgs: string;
  availableChoices: ApprovalChoice[];
  subject?: Record<string, unknown>;
  /** Host-side decision deadline (epoch ms); the waiter rejects past it. */
  expiresAt?: number;
};

export type ComposerImage = { mediaType: string; base64Data: string; name: string };
/** One file from a native OS drop, inspected by the Rust shell. */
export type DroppedFile = { path: string; name: string; isDir: boolean; size: number; mediaType?: string | null; base64Data?: string | null; error?: string | null };
export type ContextRef = { id: string; kind: "file" | "folder"; path: string };
export type SessionConfig = { agentId?: AgentId; modelId?: string; providerId?: string; approvalMode?: ApprovalMode; effort?: ReasoningEffort; mode?: string; orchestrator?: OrchestratorConfig | null };

/** Orchestrator roles, in the order Settings lists them. Router is under Advanced. */
export const ORCHESTRATOR_ROLES = ["lead", "builder", "small", "router"] as const;
export type OrchestratorRole = (typeof ORCHESTRATOR_ROLES)[number];
export const ORCHESTRATOR_GOALS = ["cost", "balanced", "output"] as const;
export type OrchestratorGoal = (typeof ORCHESTRATOR_GOALS)[number];
/** A role's model. Absent `small` means the Builder; absent `router` means Small-task. */
export type OrchestratorModel = { modelId: string; providerId?: string };
export type OrchestratorAssignments = Partial<Record<OrchestratorRole, OrchestratorModel>>;
/** Orchestrator mode as a live session reports it: the goal and the role models to route with. */
export type OrchestratorConfig = { goal: OrchestratorGoal; models: OrchestratorAssignments };
/** A role's live capability check: whether the model can do that role's work, and why not. */
export type OrchestratorProbeResult = {
  role: OrchestratorRole;
  providerId: string;
  modelId: string;
  probeVersion: number;
  status: "passed" | "failed";
  detail: string;
  capabilities: Array<"tools" | "vision" | "long_context">;
  checkedAt: number;
};

export const ORCHESTRATOR_SHAPES = ["direct-small", "direct-builder", "lead-guided", "lead-only"] as const;
export type OrchestratorShape = (typeof ORCHESTRATOR_SHAPES)[number];
export type OrchestratorRouteStage = "router" | "scout" | "lead-plan" | "lead" | "builder" | "consult" | "review" | "repair" | "takeover" | "small";
export type OrchestratorRouteModel = { providerId: string; modelId: string };
/** One routed turn's durable decision: models, stages and counts, never prompts or private reasoning. */
export type OrchestratorRoute = {
  routeId: string;
  policyVersion: string;
  goal: OrchestratorGoal;
  shape: OrchestratorShape;
  /** The shape actually run this turn; absent for a turn blocked before execution. */
  executedShape?: OrchestratorShape;
  executionFallback?: "lead-single-stage" | "plan-invalid";
  reasonCodes: string[];
  preRouteRule?: string;
  /** The shape this message asked for, before the policy floors ran. */
  requestedShape?: OrchestratorShape;
  roles: Record<"lead" | "builder" | "small", OrchestratorRouteModel> & { router?: OrchestratorRouteModel };
  stages: Array<OrchestratorRouteModel & { stage: OrchestratorRouteStage; effectiveEffort?: string }>;
  consultCount: number;
  reviewCount: number;
  fallbacks: string[];
  takeovers: string[];
  escalations: string[];
  references: { plan?: string; buildReport?: string; reviewNotes?: string };
};

export type Model = { modelId: string; displayLabel?: string; providerId?: string; isActive?: boolean; isDefault?: boolean; unavailable?: boolean; /** Named by a thread or the saved default, but absent from the agent's catalog. */ unlisted?: boolean; description?: string | null; contextLimit?: number | null; releaseDate?: string | null; cost?: { input: string; output: string; cached?: string; currency?: string | null } | null; reasoningEfforts?: ReasoningEffort[]; defaultReasoningEffort?: ReasoningEffort; effortSource?: "host" | "vocabulary"; /** Cline's current free promotion. Absent for other agents. */ free?: boolean };
export type SessionMetadata = { sessionId: string; name?: string | null; title?: string | null; workspaceRoot?: string | null; updatedAt?: string; status?: string; activeTurnId?: string | null; modelId?: string | null; providerId?: string | null; approvalMode?: { mode: ApprovalMode } };
export type SessionOpening = { sessionId: string; alreadyOpen?: boolean; userInputs?: UserInputRequest[]; opening?: { result: { session: SessionMetadata } } };

export type WorkflowChild = {
  childId: string;
  attempt: number;
  /** Lifecycle status verbatim ("started", "terminal", …); `terminal` holds the outcome once it ends. */
  status: string;
  terminal?: string;
  label?: string;
  phase?: string;
  durationMs?: number;
  usage?: { outputTokens?: number; inputTokens?: number };
};

/** A subagent's result envelope (`SubagentResultEnvelope`): bounded summary, optional text, verbatim refs. */
export type SubagentResult = {
  summary: string;
  text?: string;
  artifactRefs: string[];
  evidenceRefs: string[];
  errorKind?: string;
  structuredData?: Record<string, unknown>;
};

export type TranscriptItem = {
  images?: ComposerImage[];
  refs?: ContextRef[];
  optimistic?: boolean;
  itemId: string;
  kind: string;
  status: string;
  text?: string;
  tool?: string;
  args?: string;
  visibleOutput?: string;
  fallbackText?: string;
  commandText?: string;
  exitCode?: number;
  durationMs?: number;
  failureReason?: string;
  failureKind?: string;
  summary?: string[];
  objective?: string;
  reason?: string;
  /** `workflow`: per-agent state, re-sent whole on every change. */
  children?: WorkflowChild[];
  /** `workflow`: launched entry name, e.g. "project.audit-5agent". */
  entryId?: string;
  /** `workflow`: final message once it ends. */
  message?: string;
  /** `subagent`: role as spawned, and the host's control status ("running", "resultReady", …). */
  role?: string;
  controlStatus?: string;
  /** `toolCall`: true once the task keeps running in the background. */
  background?: boolean;
  turnId?: string;
  approvalId?: string;
  /** `subagent`: durable child identity for `subagent/*` controls. */
  subagentId?: string;
  /** `subagent`: the child's own session id — drill down via `session/read`, or `readChildSession` for the harness. */
  childSessionId?: string;
  /** `subagent`: a harness child that only supports the read-only drill-down, with no lifecycle controls. */
  readOnly?: boolean;
  /** `subagent`: result envelope once ready; consume via `subagent/readResult`. */
  result?: SubagentResult;
  /** `subagent`/`workflow`: owning durable workflow run id for `workflow/*` controls. */
  workflowRunId?: string;
  /** `toolCall`: who backgrounded the task (`user`, `timeout`, …); never inferred. */
  backgroundInitiator?: string;
  truncated?: boolean;
  /**
   * Replayable tool-card state. The harness fills this when a tool finishes;
   * the card redraws from it and does not read the file again.
   */
  presentation?: {
    kind: string;
    path?: string;
    oldText?: string;
    newText?: string;
    command?: string;
    exitCode?: number;
    truncated?: boolean;
    artifactPath?: string;
  };
  /** `toolCall`/`userShell`: stored-output reference; fetch bytes via `item/readOutput`. */
  outputRef?: {
    id: string;
    kind: string;
    uri: string;
    availability: string;
    byteLen: number;
    mediaType?: string;
    path?: string;
    digest?: string;
  };
  recordedAt?: string;
};

export type PlanStatus = "pending" | "inProgress" | "completed" | "cancelled" | "failed" | "skipped";
export type PlanItem = { id: string; text: string; status: PlanStatus; activeForm?: string };
export type GoalState = { objective: string; currentWork?: string; nextWork?: string; percentComplete?: number; status?: string };
export type ContextUsage = { usedTokens?: number; windowTokens?: number; pressure?: string; cacheReadTokens?: number; cacheWriteTokens?: number };
export type TokenUsage = { promptTokens?: number; totalTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
/**
 * One model call inside a turn, as the harness reports it. A turn with tools
 * makes several; the sequence is the turn's trajectory.
 */
export type OrchestratorUsageRole = "lead" | "builder" | "small" | "router";
export type OrchestratorUsageStage = "router" | "scout" | "lead-plan" | "lead" | "builder" | "consult" | "review" | "repair" | "takeover" | "small";
export type EstimatedCost = { amount: number; currency: string; /** One or more token legs had no catalog price. */ partial: boolean };
export type ModelCall = {
  /** Stable host id, used to deduplicate late or replayed accounting. */
  callId?: string;
  /** Present only on a turn driven by Orchestrator. */
  routeId?: string;
  role?: OrchestratorUsageRole;
  stage?: OrchestratorUsageStage;
  /** Catalog-priced estimate captured with the call; never presented as a bill. */
  estimatedCost?: EstimatedCost;
  at: number;
  providerId: string;
  modelId: string;
  effort?: string;
  /** Every prompt token this call sent, cached ones included. */
  inputTokens: number;
  /** The part of the input read from or written to a provider's prompt cache. */
  cachedTokens: number;
  outputTokens: number;
  /** The provider's own finish reason: `end_turn`, `tool_use`, `max_tokens`, `stop`. */
  stopReason?: string;
  durationMs: number;
  /** Present only on a retry, counting from 1. */
  attempt?: number;
  toolCalls: number;
};
/** Point-in-time subscription budget snapshot from `usage/read` / `usage/changed`. Percents may exceed 100. */
export type UsageWindow = { usedPercent: number; resetsAtMs: number; windowDurationMins?: number };
export type SubscriptionUsage = {
  observedAtMs: number;
  /** Opaque provider tier id — never displayed; the provider sends an id, not a plan name. */
  tier: string;
  window: UsageWindow;
  weekly: { usedPercent: number; resetsAtMs: number };
};
export type ThreadOutcome = "completed" | "failed" | "cancelled" | "interrupted";

export type ApprovalFeedback = { id: string; text: string; state: "queued" | "sending" | "failed" | "uncertain"; error?: string };

export type TurnSnapshot = {
  snapshotId: string;
  sessionId: string;
  turnId: string | null;
  state: "capturing" | "ready" | "undone" | "unavailable";
  files: string[];
  reason: string | null;
  createdAt: number;
};
/**
 * A thread's own git worktree: a separate checkout on its own branch, with its
 * own native grant. The thread's session, files and Changes all live here
 * instead of in the workspace folder.
 */
export type ThreadWorktree = {
  /** Derived grant for the worktree root, minted natively when it was created. */
  grantId: string;
  path: string;
  branch: string;
  /** What it started from, for display. */
  base: string;
  /** The workspace it was created from. */
  workspaceId: string;
};
export type WorktreeRemoval = { branch?: string | null; branchKept: boolean };
export type GitBranch = { name: string; current: boolean; upstream?: string };
/** The current branch's pull request as `gh` reports it. `unavailable` says why there can be none here. */
export type PullRequest = { unavailable?: string; url?: string; number?: number; state?: string; checks?: "passing" | "failing" | "pending" | "none" };
export type DockTab = "changes" | "diff" | "files" | "activity" | "environment" | "graph";
/** One file as the read-only viewer shows it. `content` is absent when `skipped` says why. */
export type WorkspaceFile = { path: string; content?: string; size: number; truncated: boolean; skipped?: string };
export type SnapshotRestore = { snapshot: TurnSnapshot; conflicts: string[] };

export type TokenSpeed = {
  /** UTF-16 length of generated text observed by this renderer, matching the existing chars/4 estimate. */
  characters: number;
  /** Accumulated active stream time; long gaps between generated chunks are capped. */
  activeMs: number;
  /** Renderer clock at the latest accepted generated-text item or delta. */
  lastAt: number;
};

export type Thread = {
  /** Native checkpoints; content is retained only in the native snapshot store. */
  snapshots?: Record<string, TurnSnapshot>;
  snapshotPending?: string;
  snapshotError?: { turnId: string; message: string };
  rewindPending?: string;
  rewindError?: { itemId: string; message: string };
  /** Reuse a create request after a lost acknowledgement; never persist this as session history. */
  rewindAttempt?: { itemId: string; text: string; resetFiles: boolean; requestId: string; sessionId?: string; filesReset?: boolean };

  /** Denial explanations waiting for delivery; never mixed into the composer's draft. */
  approvalFeedback?: ApprovalFeedback[];
  sessionId: string;
  /** Which agent CLI owns this session; absent means Muse. */
  agentId?: AgentId;
  /** Agent modes (e.g. OpenCode build/plan), when the agent offers them. */
  modes?: AgentSessionConfig["modes"];
  /** Live, transient status from the agent (rate limits, retries). `key` lets flows clear their own notice. */
  notice?: { level: "info" | "warning"; message: string; key?: string } | null;
  /** Fork provenance: the source thread this one branched from. */
  forkedFrom?: { sessionId: string; title: string; cutTurnId?: string; firstMessage?: boolean } | null;
  /** The owning workspace's root, also for a worktree thread: it groups the thread in the sidebar. */
  workspacePath: string;
  /** Set when the thread runs in its own worktree rather than in the workspace folder. */
  worktree?: ThreadWorktree;
  title: string;
  updatedAt: string;
  status: "idle" | "running" | "error";
  unread: boolean;
  items: TranscriptItem[];
  pendingApproval?: ApprovalRequest | null;
  /** Older approvals displaced from the slot, oldest first; the newest waits at the end. */
  queuedApprovals?: ApprovalRequest[];
  userInputs?: UserInputRequest[];
  userInputPending?: string;
  userInputVersion?: number;
  activeTurnId?: string | null;
  /** Idempotency key of a send whose result is unknown; the next send reuses it so the host dedupes. */
  pendingTurnKey?: string | null;
  /** Submits admitted while a turn runs, awaiting launch (Muse and Harness; settled by `turnStarted`/`turnCompleted`). */
  queuedTurns?: Array<{ turnId: string; text: string }>;
  config?: SessionConfig;
  configPending?: boolean;
  /** Config patches merged while an ACP apply was in flight; the newest value per key wins when it drains. */
  pendingConfig?: Partial<SessionConfig>;
  configNotice?: string;
  opening?: boolean;
  opened?: boolean;
  cancelRequested?: boolean;
  approvalPending?: boolean;
  /** The thread scope picked on the approval card, so ⇧⌘Y approves what the picker shows. */
  approvalScope?: { approvalId: string; choiceId: string };
  error?: string | null;
  activity?: "working" | "composing";
  lastTurnId?: string;
  lastOutcome?: ThreadOutcome;
  customTitle?: boolean;
  pinned?: boolean;
  /** Sidebar position key, fixed at creation so activity doesn't reorder threads. Higher sorts first. */
  order?: number;
  archived?: boolean;
  plan?: PlanItem[];
  /** Transcript item the plan first appeared after, so the timeline shows it where it was made. */
  planAnchor?: string;
  /** When the current turn was sent, and the host's token counts at that moment. */
  turnStartedAt?: number;
  /** Ephemeral renderer-side stream measurement; never supplied by a provider or CLI. */
  tokenSpeed?: TokenSpeed;
  turnStartOutput?: number;
  turnStartPrompt?: number;
  /** Cached prompt tokens (read and written) when the turn started; reported apart from the prompt by some providers. */
  turnStartCache?: number;
  /** Time and tokens the last finished turn took; input is undefined when the agent reports output only. */
  turnStats?: { turnId?: string; durationMs: number; outputTokens?: number; inputTokens?: number; cachedTokens?: number; estimated?: boolean; tokensPerSecond?: number };
  /** The model calls made so far in the running turn; cleared when the next one starts. */
  turnCalls?: ModelCall[];
  /** Each routed turn's decision, keyed by turn id so receipts keep their label and resume restores it. */
  routes?: Record<string, OrchestratorRoute>;
  goal?: GoalState | null;
  context?: ContextUsage | null;
  usage?: TokenUsage | null;
  hostBranch?: string | null;
  /** Scheduled model retry (`turn/retryScheduled`): attempt counts, reason, and the local fire time. */
  retry?: { turnId: string; attempt: number; maxAttempts: number; reason: string; retryAt: number } | null;
  /** Outstanding or failed view gap (`view/gap`): opaque bounds plus fill state. */
  viewGap?: { after: string; next: string; state: "filling" | "failed"; reason?: string } | null;
  /** Live view health (`session/viewHealthChanged`); absent means healthy. */
  viewHealth?: { health: string; noneReason?: string } | null;
  /** Backward-history cursor for on-demand older pages; null with `historyExhausted` means complete. */
  historyCursor?: string | null;
  historyExhausted?: boolean;
  historyLoading?: boolean;
  /** The initial history load failed and nothing may have arrived; retry rebuilds it. */
  historyFailed?: boolean;
  /** Last observed view cursor: resubscribe position for the next resume. */
  resumeCursor?: string | null;
  /** Session skill catalog (`skill/list`); refreshed on open and `skill/changed`. */
  skills?: SkillRow[] | null;
};

export type GitFile = {
  path: string;
  /** Exact two-column porcelain XY status: `" M"` unstaged, `"M "` staged. */
  status: string;
  added: number;
  removed: number;
  /** Why a new file has no diff preview. Absent when the preview exists. */
  previewSkipped?: "binary" | "tooLarge" | "unavailable" | "unsupported" | "limit";
};

export type GitSnapshot = {
  /** False when the folder is not inside a working tree. Missing means true (older fixtures). */
  repository?: boolean;
  branch: string;
  dirty: boolean;
  files: GitFile[];
  diff: string;
  truncated?: boolean;
};

export type GitGraph = { graph: string; truncated: boolean };

export const REVIEW_SCOPES = ["all", "lastTurn", "staged", "unstaged", "branch"] as const;
export type ReviewScope = typeof REVIEW_SCOPES[number];
export type GitReview = Pick<GitSnapshot, "files" | "diff" | "truncated"> & { baseCommit?: string | null; headCommit?: string | null };
export type GitReviewRequest = { scope: ReviewScope; base?: string; sessionId?: string; snapshotId?: string };

/** `serve --sandbox-network` mode; proxy-only is the CLI default. */
export type SandboxNetwork = "proxy-only" | "restricted" | "enabled";

/** Host-construction posture (`serve` flags): ephemeral sessions plus sandbox hardening. */
export type HostPosture = {
  ephemeralSessions: boolean;
  disableWrite: boolean;
  disableShell: boolean;
  sandboxNetwork: SandboxNetwork;
  contributorMode?: "on" | "off";
};

export type Settings = {
  museBin: string;
  museApiKey: string;
  /** Automatic prefers the subscription sign-in and falls back to the API key. */
  museAuthMode: AuthMode;
  /** Muse subscription routing override. Absent preserves the CLI's Contributor preference. */
  contributorMode?: "on" | "off";
  /** Memory-only sessions (`serve --no-session-log`): nothing persists to the session log. */
  ephemeralSessions: boolean;
  /** Disable non-shell workspace filesystem writes (`serve --disable-write`). */
  disableWrite: boolean;
  /** Disable workspace shell execution (`serve --disable-shell`). */
  disableShell: boolean;
  /** Sandbox network mode (`serve --sandbox-network`). */
  sandboxNetwork: SandboxNetwork;
  theme: ThemeMode;
  /** Interface typeface. Code, diffs and the terminal stay on the monospace face. */
  uiFont: UiFont;
  /** How deep the dark theme is when the interface resolves to dark. */
  darkIntensity: DarkIntensity;
  accentColor: AccentColor;
  accentSidebar: boolean;
  /** How see-through the sidebar is, 0 (solid) to 100. Only shows where the window has a material behind it. */
  sidebarTranslucency: number;
  /** Vertical spacing for workspace and thread rows. */
  sidebarDensity: SidebarDensity;
  /** Reduce interface animation in addition to the macOS accessibility preference. */
  reduceMotion: boolean;
  /** Animation used while an agent thinks; automatic follows the run's effort. */
  thinkingOrb?: ThinkingOrbStyle;
  defaultModel: string;
  defaultProviderId?: string;
  defaultEffort: ReasoningEffort | undefined;
  defaultApprovalMode: ApprovalMode | undefined;
  /** Agent new threads start with; absent means the first ready agent. */
  defaultAgentId?: AgentId;
  /** Per-provider on/off. Missing keys use DEFAULT_ENABLED_AGENTS (ACP agents off). */
  enabledAgents?: Partial<Record<AgentId, boolean>>;
  /**
   * Informed opt-in for third-party ACP agents. They are not OS-isolated;
   * the native keyring copy of this flag is what actually gates spawn.
   */
  acpUnisolatedConsent?: boolean;
  /** Hide the optional ACP adapter capability introduction. It remains in the Agent menu. */
  hideAgentCapabilities?: boolean;
  /** OS notifications for turn completion and approvals while the app is unfocused or another thread is selected. */
  notifications?: boolean;
  /** Where "Open file" sends a file. The native side maps the id to a program; the renderer never names one. */
  editor?: EditorChoice;
  /** Keyboard shortcuts the user rebound, by action id. Absent actions keep their default. */
  shortcutOverrides?: ShortcutOverrides;
  /** Prompt templates the user defined, offered in the slash menu. */
  customCommands?: CustomCommand[];
  /** Opt-in: draft starter prompts for the new-thread empty state from workspace state. */
  suggestionsEnabled?: boolean;
  /** Agent that drafts predicted suggestions; absent means the first ready agent. */
  suggestionsAgentId?: AgentId;
  /** Model override for suggestions; absent means the agent's cheapest catalog model. */
  suggestionsModelId?: string;
  /** Route new built-in agent threads through the Orchestrator roles. */
  orchestratorEnabled?: boolean;
  orchestratorGoal?: OrchestratorGoal;
  /** Role assignments for built-in agent threads. Missing roles fall back per `lib/orchestrator.ts`. */
  orchestratorModels?: OrchestratorAssignments;
  /** Models switched off in Settings → Models, as `modelVisibilityKey` strings. They leave the model picker, not the catalog. */
  hiddenModels?: string[];
  /** Providers switched off in Settings → Models, as `providerKey` strings. They leave the model picker. */
  hiddenProviders?: string[];
  workspaces: Workspace[];
};

export const DEFAULT_SETTINGS: Settings = {
  museBin: "",
  museApiKey: "",
  museAuthMode: "auto",
  ephemeralSessions: false,
  disableWrite: false,
  disableShell: false,
  sandboxNetwork: "proxy-only",
  theme: "system",
  uiFont: "system",
  darkIntensity: "mid",
  accentColor: "ember",
  accentSidebar: false,
  sidebarTranslucency: 50,
  sidebarDensity: "standard",
  reduceMotion: false,
  thinkingOrb: "auto",
  defaultModel: "",
  defaultProviderId: undefined,
  defaultEffort: undefined,
  defaultApprovalMode: "onRequest",
  enabledAgents: { ...DEFAULT_ENABLED_AGENTS },
  acpUnisolatedConsent: false,
  hideAgentCapabilities: false,
  notifications: true,
  editor: "default",
  customCommands: [],
  suggestionsEnabled: false,
  suggestionsAgentId: undefined,
  suggestionsModelId: undefined,
  shortcutOverrides: {},
  orchestratorEnabled: false,
  orchestratorGoal: "balanced",
  orchestratorModels: {},
  hiddenModels: [],
  hiddenProviders: [],
  workspaces: [],
};

/**
 * The permission menu is the app's, for every agent and model.
 * Ask, Auto, Full access. Read only remains for a thread already using it.
 */
export const APPROVAL_LABELS: Record<ApprovalMode, string> = {
  denyUnmatched: "Read only",
  promptUnmatched: "Ask",
  onRequest: "Ask",
  guarded: "Auto",
  allowAll: "Full access",
};

export const APPROVAL_DESCRIPTIONS: Record<ApprovalMode, string> = {
  denyUnmatched: "Reads files. Changes nothing.",
  promptUnmatched: "Edits run, commands ask.",
  onRequest: "Edits run, commands ask.",
  guarded: "Risky commands still ask.",
  allowAll: "No approval prompts.",
};

/** Composer order, strict to open. Full access stays off the saved default. */
export const APPROVAL_ORDER: ApprovalMode[] = ["onRequest", "guarded", "allowAll"];

/**
 * The app owns the mode. The agent id is unused: a provider does not get its
 * own list. A saved Ask-me (`promptUnmatched`) is Ask.
 */
export const approvalModeForAgent = (_agentId: AgentId | undefined, mode: ApprovalMode | undefined): ApprovalMode | undefined =>
  mode === "promptUnmatched" ? "onRequest" : mode;

export const AUTH_MODE_ORDER: AuthMode[] = ["auto", "subscription", "apiKey"];

export const AUTH_MODE_LABELS: Record<AuthMode, string> = {
  auto: "Automatic",
  subscription: "Muse Code subscription",
  apiKey: "Muse API key",
};

export const AUTH_MODE_DESCRIPTIONS: Record<AuthMode, string> = {
  auto: "Use the subscription you signed into with the Muse CLI, and fall back to the API key.",
  subscription: "Bill sessions to your Muse Code plan. The API key is ignored, even if one is set in your shell.",
  apiKey: "Bill sessions to the key below at pay-as-you-go API rates.",
};

export const AUTH_SOURCE_LABELS: Record<AuthSource, string> = {
  subscription: "Muse Code subscription",
  apiKey: "Muse API key",
};

/** Fits the one-line connection status in the settings footer. */
export const AUTH_SOURCE_SHORT: Record<AuthSource, string> = {
  subscription: "subscription",
  apiKey: "API key",
};

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
