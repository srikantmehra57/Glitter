import type { StuckTuning } from "./stuck.js";

export type OrchestratorGoal = "cost" | "balanced" | "output";
export type OrchestratorShape = "direct-small" | "direct-builder" | "lead-guided" | "lead-only";
export type OrchestratorRole = "lead" | "builder" | "small";
export type OrchestratorStage = "router" | "scout" | "lead-plan" | "lead" | "builder" | "consult" | "review" | "repair" | "takeover" | "small";
export type OrchestratorCapability = "tools" | "vision" | "long_context";
export type EffortTarget = "low" | "medium" | "high" | "highest";
export type RouterFailure = "invalid-json" | "unavailable";
export type OrchestratorRoleCapabilities = Record<OrchestratorRole, readonly OrchestratorCapability[]>;
export type CapabilityIssue = { role: OrchestratorRole; capability: OrchestratorCapability };

export type RouterAssessment = {
  taskKind: "question" | "minor_edit" | "bug_fix" | "feature" | "redesign" | "refactor" | "migration" | "security" | "other";
  difficulty: "trivial" | "mid" | "complex";
  designChoices: boolean;
  separable: boolean;
  causeKnown: boolean;
  risk: "low" | "medium" | "high";
  confidence: "low" | "high";
  continuity: "new" | "continuation";
  requiredCapabilities: OrchestratorCapability[];
  reasonCodes: string[];
};

export type PreRouteRule = "pre-route:forced-shape" | "pre-route:continuation" | "pre-route:high-risk" | "pre-route:exact-small-change";
export type PreRouteDecision = {
  rule: PreRouteRule;
  assessment: RouterAssessment;
  /** Forced shapes and open-task continuity still pass through every policy floor. */
  shape?: OrchestratorShape;
};
export type PreRouteResult = { decided: false } | ({ decided: true } & PreRouteDecision);

export type RoutePolicyDecision = {
  shape: OrchestratorShape;
  canStart: boolean;
  capabilityIssues: CapabilityIssue[];
  leadPlan: boolean;
  leadReview: boolean;
  leadDiagnosis: boolean;
  /** Run the Small-task Scout before the Lead plan. */
  scout: boolean;
  consultBudget: number;
  repairBudget: number;
  builderFailure?: "stop" | "takeover";
  efforts: Partial<Record<OrchestratorRole, EffortTarget>>;
  reasonCodes: string[];
  preRouteRule?: PreRouteRule;
  routerFallback?: RouterFailure;
  /** The shape a per-message override asked for, before every floor ran. */
  forcedShape?: OrchestratorShape;
};

export type OrchestratorModel = { providerId: string; modelId: string };
export type OrchestratorRoleSnapshot = Record<OrchestratorRole, OrchestratorModel> & { router?: OrchestratorModel };
/** The resolved role models for one session: Small-task and Router always have a fallback. */
export type OrchestratorSettings = {
  goal: OrchestratorGoal;
  roles: Record<OrchestratorRole, OrchestratorModel> & { router: OrchestratorModel };
};

/**
 * Internal knobs, resolved once per host. The app never exposes them; the
 * evaluation runner and deterministic tests override them. Scout entries gate
 * 3.2; zero Lead-read budgets keep 3.3 reads off.
 */
export type OrchestratorTuning = {
  consultBudgets: Record<OrchestratorGoal, number>;
  reviewAllComplex: boolean;
  stuck: StuckTuning;
  scout: { enabled: boolean; maxReadCalls: number; maxPackChars: number; maxExcerptChars: number };
  leadReads: Record<OrchestratorGoal, { calls: number; chars: number }>;
};
export type RouteStageRecord = OrchestratorModel & { stage: OrchestratorStage; effectiveEffort?: string };

/** Durable routing metadata only: never a prompt, credentials or private reasoning. */
export type RouteRecord = {
  routeId: string;
  policyVersion: string;
  goal: OrchestratorGoal;
  shape: OrchestratorShape;
  /** The shape actually run this turn. Absent until execution starts. */
  executedShape?: OrchestratorShape;
  /** Set when the decided shape ran as a smaller, single-model pipeline. */
  executionFallback?: "lead-single-stage" | "plan-invalid";
  reasonCodes: string[];
  preRouteRule?: PreRouteRule;
  /** The shape the user asked this message to take, when they overrode Auto. */
  requestedShape?: OrchestratorShape;
  roles: OrchestratorRoleSnapshot;
  stages: RouteStageRecord[];
  /** The consult budget the policy gave this turn; absent on older records. */
  consultBudget?: number;
  consultCount: number;
  reviewCount: number;
  fallbacks: string[];
  takeovers: string[];
  escalations: string[];
  references: { plan?: string; contextPack?: string; buildReport?: string; reviewNotes?: string };
};
