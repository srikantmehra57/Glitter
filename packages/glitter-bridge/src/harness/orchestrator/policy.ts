import type {
  EffortTarget,
  OrchestratorGoal,
  OrchestratorRoleCapabilities,
  OrchestratorRoleSnapshot,
  OrchestratorShape,
  PreRouteResult,
  RoutePolicyDecision,
  RouteRecord,
  RouterAssessment,
  RouterFailure,
} from "./types.js";

export const ORCHESTRATOR_POLICY_VERSION = "orchestrator-v2";
export const MAX_EXACT_SMALL_PROMPT_CHARS = 240;

const SHAPE_RANK: Record<OrchestratorShape, number> = { "direct-small": 0, "direct-builder": 1, "lead-guided": 2, "lead-only": 3 };
const HIGH_RISK = /\b(?:auth|authentication|authorization|oauth|security|payments?|secrets?|migrations?|concurrency|concurrent|race conditions?|deadlocks?|mutex(?:es)?)\b|\b(?:delete|drop|erase|wipe|destroy)(?:ing)?\s+(?:[\w-]+\s+){0,3}(?:data|records?|rows?|tables?|databases?|files?)\b/i;
const BROAD_SMALL_CHANGE = /\b(?:redesign|refactor|all|every|why)\b/i;
const CHANGE_VERB = /\b(?:change|set|update|replace|rename|fix|correct|remove)\b/i;
const QUOTED_TARGET = /`[^`\r\n]+`|"[^"\r\n]+"|'[^'\r\n]+'/;
const IDENTIFIER_TARGET = /\b(?:[a-z][a-z0-9]*_[a-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\b/;
const SELECTOR_TARGET = /(?:^|\s)[.#][A-Za-z_][\w-]*/;
const CSS_TARGET = /\b(?:color|background(?:-color)?|border(?:-radius)?|display|font(?:-size|-family|-weight)?|gap|grid|height|width|margin(?:-(?:top|right|bottom|left))?|padding(?:-(?:top|right|bottom|left))?|opacity|position|z-index|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)\s*(?:to|=|:)\s*[^\s;]+/i;

type Attachment = { name: string; mediaType?: string };
type OpenTask = { shape: OrchestratorShape; assessment?: RouterAssessment };

function requestCapabilities(attachments: readonly Attachment[], tools: boolean): RouterAssessment["requiredCapabilities"] {
  const result: RouterAssessment["requiredCapabilities"] = [];
  if (tools) result.push("tools");
  if (attachments.some((attachment) => attachment.mediaType?.startsWith("image/"))) result.push("vision");
  return result;
}

function synthetic(shape: OrchestratorShape, continuity: RouterAssessment["continuity"], attachments: readonly Attachment[]): RouterAssessment {
  const direct = shape === "direct-small" || shape === "direct-builder";
  return {
    taskKind: direct ? "minor_edit" : "other",
    difficulty: shape === "direct-small" ? "trivial" : shape === "direct-builder" ? "mid" : "complex",
    designChoices: !direct,
    separable: shape !== "lead-only",
    causeKnown: true,
    risk: "low",
    confidence: "high",
    continuity,
    requiredCapabilities: requestCapabilities(attachments, true),
    reasonCodes: [],
  };
}

function highRisk(assessment: RouterAssessment): RouterAssessment {
  return assessment.risk === "high" ? assessment : { ...assessment, risk: "high", reasonCodes: [...assessment.reasonCodes, "high-risk-keyword"] };
}

/**
 * The complete first-pass rule list. `openTask` is supplied only after the app
 * has established that this message continues that task (reply, steer or queue),
 * so the pure rules do not guess conversational continuity from one word.
 */
export function preRoute(input: {
  prompt: string;
  forcedShape?: OrchestratorShape;
  openTask?: OpenTask;
  attachments?: readonly Attachment[];
}): PreRouteResult {
  const attachments = input.attachments ?? [];
  const promptHasHighRisk = HIGH_RISK.test(input.prompt);
  if (input.forcedShape) {
    const base = synthetic(input.forcedShape, input.openTask ? "continuation" : "new", attachments);
    return { decided: true, rule: "pre-route:forced-shape", shape: input.forcedShape, assessment: promptHasHighRisk ? highRisk(base) : base };
  }
  if (input.openTask) {
    const base = input.openTask.assessment ?? synthetic(input.openTask.shape, "continuation", attachments);
    const continuing = { ...base, continuity: "continuation" as const };
    return { decided: true, rule: "pre-route:continuation", shape: input.openTask.shape, assessment: promptHasHighRisk ? highRisk(continuing) : continuing };
  }
  if (promptHasHighRisk) {
    const base = synthetic("lead-guided", "new", attachments);
    const taskKind = /migrations?/i.test(input.prompt) ? "migration" : /auth|security|oauth|secrets?/i.test(input.prompt) ? "security" : "other";
    return { decided: true, rule: "pre-route:high-risk", assessment: { ...highRisk(base), taskKind, causeKnown: false, reasonCodes: ["high-risk-keyword"] } };
  }
  const short = input.prompt.trim().length <= MAX_EXACT_SMALL_PROMPT_CHARS;
  const exactTarget = QUOTED_TARGET.test(input.prompt) || IDENTIFIER_TARGET.test(input.prompt) || SELECTOR_TARGET.test(input.prompt) || CSS_TARGET.test(input.prompt);
  if (!attachments.length && short && CHANGE_VERB.test(input.prompt) && exactTarget && !BROAD_SMALL_CHANGE.test(input.prompt)) {
    const base = synthetic("direct-small", "new", attachments);
    return { decided: true, rule: "pre-route:exact-small-change", assessment: { ...base, reasonCodes: ["exact-small-change"] } };
  }
  return { decided: false };
}

function atLeast(shape: OrchestratorShape, minimum: OrchestratorShape, reasons: string[], code: string): OrchestratorShape {
  if (SHAPE_RANK[shape] >= SHAPE_RANK[minimum]) return shape;
  reasons.push(code);
  return minimum;
}

function escalate(shape: OrchestratorShape): OrchestratorShape {
  return (["direct-small", "direct-builder", "lead-guided", "lead-only"] as const)[Math.min(3, SHAPE_RANK[shape] + 1)];
}

function leadEffort(goal: OrchestratorGoal): EffortTarget {
  return goal === "cost" ? "medium" : goal === "balanced" ? "high" : "highest";
}

export type RoutePolicyInput = {
  goal: OrchestratorGoal;
  /** Probe results only: an omitted capability is unsupported, never assumed. */
  roleCapabilities: OrchestratorRoleCapabilities;
  preRoute?: PreRouteResult;
  assessment?: RouterAssessment;
  /** Required when no pre-route rule or valid assessment is available. */
  routerFailure?: RouterFailure;
  /** Optional deterministic floor from context not present in the router envelope. */
  riskFloor?: RouterAssessment["risk"];
  /** Suppresses optional reviews; the high-risk floor still requires review. */
  reviewAllowed?: boolean;
  previousAttemptFailed?: boolean;
  previousShape?: OrchestratorShape;
};

/** Apply forced shapes, difficulty, goals and every floor in one deterministic place. */
export function decideRoute(input: RoutePolicyInput): RoutePolicyDecision {
  const preRouted = input.preRoute?.decided ? input.preRoute : undefined;
  const failure = preRouted ? undefined : input.assessment ? undefined : input.routerFailure;
  if (!preRouted && !input.assessment && !failure) throw new Error("An assessment or an explicit router failure is required.");
  if (input.assessment && input.routerFailure) throw new Error("A valid assessment and router failure are mutually exclusive.");

  const fallbackAssessment: RouterAssessment = {
    taskKind: "other",
    difficulty: "complex",
    designChoices: true,
    separable: true,
    causeKnown: false,
    risk: input.riskFloor ?? "low",
    confidence: "high",
    continuity: "new",
    requiredCapabilities: [],
    reasonCodes: [],
  };
  const assessment = preRouted?.assessment ?? input.assessment ?? fallbackAssessment;
  const reasons = [...assessment.reasonCodes];
  const highRisk = assessment.risk === "high" || input.riskFloor === "high" || assessment.taskKind === "security" || assessment.taskKind === "migration";
  let shape: OrchestratorShape;

  if (failure) {
    shape = "lead-guided";
    reasons.push(`router-${failure}-fallback`);
  } else if (preRouted?.shape) {
    shape = preRouted.shape;
    reasons.push(preRouted.rule === "pre-route:forced-shape" ? "forced-shape" : "continued-shape");
  } else if (assessment.difficulty === "trivial") {
    shape = "direct-small";
  } else if (assessment.difficulty === "mid") {
    shape = input.goal === "output" || (input.goal === "balanced" && assessment.designChoices) ? "lead-guided" : "direct-builder";
  } else {
    shape = "lead-guided";
  }

  if (!failure) {
    if (assessment.difficulty === "complex") shape = atLeast(shape, "lead-guided", reasons, "floor:complex");
    else if (assessment.difficulty === "mid") shape = atLeast(shape, "direct-builder", reasons, "floor:mid-level");
    if (assessment.taskKind === "redesign" || assessment.taskKind === "refactor" || assessment.taskKind === "migration" || assessment.taskKind === "security" || (assessment.taskKind === "feature" && assessment.designChoices)) {
      shape = atLeast(shape, "lead-guided", reasons, "floor:design-or-scope");
    }
    if (assessment.taskKind === "bug_fix" && !assessment.causeKnown) shape = atLeast(shape, "lead-guided", reasons, "floor:unknown-cause");
  }
  if (highRisk) shape = atLeast(shape, "lead-guided", reasons, "floor:high-risk");
  if (!failure && assessment.confidence === "low") {
    const raised = escalate(shape);
    if (raised !== shape) reasons.push("floor:low-confidence");
    shape = raised;
  }
  if (input.previousAttemptFailed && input.previousShape) shape = atLeast(shape, input.previousShape, reasons, "floor:previous-attempt");
  if (!assessment.separable && shape === "lead-guided") {
    shape = "lead-only";
    reasons.push("floor:not-separable");
  }
  if (highRisk && input.goal === "output") {
    shape = "lead-only";
    reasons.push("floor:output-lead-writes-risk");
  }

  const required = new Set(assessment.requiredCapabilities);
  const capabilityIssues: RoutePolicyDecision["capabilityIssues"] = [];
  const supports = (role: keyof OrchestratorRoleCapabilities, capability: RouterAssessment["requiredCapabilities"][number]) => input.roleCapabilities[role].includes(capability);
  const missing = (role: keyof OrchestratorRoleCapabilities) => [...required].filter((capability) => !supports(role, capability));
  const reportMissing = (role: keyof OrchestratorRoleCapabilities, capabilities: RouterAssessment["requiredCapabilities"]) => {
    for (const capability of capabilities) if (!capabilityIssues.some((issue) => issue.role === role && issue.capability === capability)) capabilityIssues.push({ role, capability });
  };
  let hasLead = shape === "lead-guided" || shape === "lead-only";
  if (hasLead) {
    reportMissing("lead", missing("lead"));
    if (shape === "lead-guided" && required.has("tools") && !supports("builder", "tools")) {
      if (supports("lead", "tools")) {
        shape = "lead-only";
        reasons.push("capability:builder-to-lead");
      } else {
        reportMissing("builder", ["tools"]);
      }
    }
  } else {
    const role = shape === "direct-small" ? "small" : "builder";
    const selectedMissing = missing(role);
    if (selectedMissing.length) {
      const leadMissing = missing("lead");
      if (!leadMissing.length) {
        shape = "lead-only";
        reasons.push(`capability:${role}-to-lead`);
      } else {
        reportMissing(role, selectedMissing);
        reportMissing("lead", leadMissing);
      }
    }
  }
  hasLead = shape === "lead-guided" || shape === "lead-only";
  const leadDiagnosis = hasLead && assessment.taskKind === "bug_fix" && !assessment.causeKnown;
  const leadPlan = shape === "lead-guided" || highRisk;
  const optionalReview = !failure && input.goal === "output" && assessment.difficulty !== "trivial" && hasLead;
  const leadReview = hasLead && (highRisk || (optionalReview && input.reviewAllowed !== false));
  if (optionalReview && input.reviewAllowed === false && !highRisk) reasons.push("review:user-disabled");
  const consultBudget = shape === "lead-guided" ? input.goal === "cost" ? 1 : input.goal === "balanced" ? 2 : 4 : 0;
  const repairBudget = leadReview && input.goal === "output" ? 1 : 0;
  const efforts: RoutePolicyDecision["efforts"] = {};
  // Every stage that writes or repairs code runs at the model's highest
  // supported effort; only questions and the Lead's planning call may run lower.
  if (shape === "direct-small") efforts.small = assessment.taskKind === "question" ? "low" : "highest";
  else if (shape === "direct-builder") efforts.builder = "highest";
  else {
    efforts.lead = shape === "lead-only" ? "highest" : leadEffort(input.goal);
    if (shape === "lead-guided") efforts.builder = "highest";
  }

  return {
    shape,
    canStart: capabilityIssues.length === 0,
    capabilityIssues,
    leadPlan,
    leadReview,
    leadDiagnosis,
    consultBudget,
    repairBudget,
    ...(shape === "lead-guided" ? { builderFailure: input.goal === "cost" ? "stop" as const : "takeover" as const } : {}),
    efforts,
    reasonCodes: [...new Set(reasons)],
    ...(preRouted ? { preRouteRule: preRouted.rule } : {}),
    ...(preRouted?.rule === "pre-route:forced-shape" ? { forcedShape: preRouted.shape } : {}),
    ...(failure ? { routerFallback: failure } : {}),
  };
}

/**
 * The minimum assessment a pending question's continuation needs after a
 * restart. The shape is preserved; the high-risk floor is restored from the
 * route's reason codes, so a reviewed plan stays reviewed.
 */
export function continuationAssessment(route: RouteRecord): RouterAssessment {
  const shape = route.executedShape ?? route.shape;
  return {
    taskKind: "other",
    difficulty: shape === "direct-small" ? "trivial" : shape === "direct-builder" ? "mid" : "complex",
    designChoices: shape === "lead-guided" || shape === "lead-only",
    separable: shape !== "lead-only",
    causeKnown: true,
    risk: route.reasonCodes.includes("floor:high-risk") ? "high" : "low",
    confidence: "high",
    continuity: "continuation",
    requiredCapabilities: [],
    reasonCodes: ["restored-continuation"],
  };
}

export function createRouteRecord(input: {
  routeId: string;
  goal: OrchestratorGoal;
  decision: RoutePolicyDecision;
  roles: OrchestratorRoleSnapshot;
}): RouteRecord {  if (!input.routeId.trim()) throw new Error("A route id is required.");
  return {
    routeId: input.routeId,
    policyVersion: ORCHESTRATOR_POLICY_VERSION,
    goal: input.goal,
    shape: input.decision.shape,
    reasonCodes: [...input.decision.reasonCodes],
    ...(input.decision.preRouteRule ? { preRouteRule: input.decision.preRouteRule } : {}),
    ...(input.decision.forcedShape ? { requestedShape: input.decision.forcedShape } : {}),
    roles: {
      lead: { ...input.roles.lead },
      builder: { ...input.roles.builder },
      small: { ...input.roles.small },
      ...(input.roles.router ? { router: { ...input.roles.router } } : {}),
    },
    stages: [],
    consultCount: 0,
    reviewCount: 0,
    fallbacks: [
      ...(input.decision.routerFallback ? [`router:${input.decision.routerFallback}`] : []),
      ...input.decision.capabilityIssues.map((issue) => `capability:${issue.role}:${issue.capability}`),
    ],
    takeovers: [],
    escalations: [],
    references: {},
  };
}
