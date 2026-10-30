import {
  ORCHESTRATOR_GOALS,
  ORCHESTRATOR_ROLES,
  ORCHESTRATOR_SHAPES,
  type ModelCall,
  type OrchestratorAssignments,
  type OrchestratorGoal,
  type OrchestratorModel,
  type OrchestratorRole,
  type OrchestratorRoute,
  type OrchestratorRouteModel,
  type OrchestratorShape,
  type OrchestratorUsageRole,
} from "./types";

/**
 * Settings-side rules for the Orchestrator roles, plus the short route facts
 * the thread and Usage show. The bridge owns routing and execution; this module
 * only validates what Settings stores, resolves the role fallbacks the plan
 * defines (Small-task follows Builder, Router follows Small-task), and names
 * what a recorded route ran.
 */

export const ORCHESTRATOR_ROLE_LABELS: Record<OrchestratorRole, string> = {
  lead: "Lead",
  builder: "Builder",
  small: "Small-task",
  router: "Router",
};

export const ORCHESTRATOR_GOAL_COPY: Record<OrchestratorGoal, { label: string; summary: string }> = {
  cost: { label: "Optimize for cost", summary: "The Lead plans only complex work, consults once, and does not review." },
  balanced: { label: "Balanced", summary: "The Lead plans complex work, answers the Builder’s questions and reviews high-risk work." },
  output: { label: "Optimize for output", summary: "The Lead plans and reviews every complex turn, with a repair and a wider consult budget." },
};

/** The goal control's chip uses the short names; the menu rows carry the full labels. */
export const ORCHESTRATOR_GOAL_SHORT: Record<OrchestratorGoal, string> = {
  cost: "Cost",
  balanced: "Balanced",
  output: "Output",
};

export const DEFAULT_ORCHESTRATOR_GOAL: OrchestratorGoal = "balanced";

const MAX_MODEL_ID = 600;
const MAX_PROVIDER_ID = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const clean = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
};

export function normalizeOrchestratorGoal(value: unknown): OrchestratorGoal {
  return ORCHESTRATOR_GOALS.find((goal) => goal === value) ?? DEFAULT_ORCHESTRATOR_GOAL;
}

/** Read stored role assignments field by field, dropping anything malformed. */
export function normalizeOrchestratorModels(value: unknown): OrchestratorAssignments {
  if (!isRecord(value)) return {};
  const assignments: OrchestratorAssignments = {};
  for (const role of ORCHESTRATOR_ROLES) {
    const entry = value[role];
    if (!isRecord(entry)) continue;
    const modelId = clean(entry.modelId, MAX_MODEL_ID);
    if (!modelId) continue;
    const providerId = clean(entry.providerId, MAX_PROVIDER_ID);
    assignments[role] = { modelId, ...(providerId ? { providerId } : {}) };
  }
  return assignments;
}

/** The models a turn will actually use: Small-task defaults to Builder, Router to Small-task. */
export function effectiveOrchestratorAssignments(assignments: OrchestratorAssignments): OrchestratorAssignments {
  const small = assignments.small ?? assignments.builder;
  const router = assignments.router ?? small;
  return {
    ...(assignments.lead ? { lead: assignments.lead } : {}),
    ...(assignments.builder ? { builder: assignments.builder } : {}),
    ...(small ? { small } : {}),
    ...(router ? { router } : {}),
  };
}

/** A turn needs a Lead and a Builder; every other role has a defined fallback. */
export function orchestratorReady(assignments: OrchestratorAssignments): boolean {
  return Boolean(assignments.lead && assignments.builder);
}

/** The block a new built-in session starts with. The bridge resolves the routers it owns. */
export type OrchestratorStart = { goal: OrchestratorGoal; models: OrchestratorAssignments };

/**
 * The Orchestrator block a thread can switch to, whether or not new threads
 * start with it, or undefined while the stored roles are incomplete. Starting
 * without a Lead or Builder would leave the session unable to route a turn.
 */
export function orchestratorFromSettings(settings: {
  orchestratorGoal?: OrchestratorGoal;
  orchestratorModels?: OrchestratorAssignments;
}): OrchestratorStart | undefined {
  const models = effectiveOrchestratorAssignments(normalizeOrchestratorModels(settings.orchestratorModels));
  if (!orchestratorReady(models)) return undefined;
  return { goal: normalizeOrchestratorGoal(settings.orchestratorGoal), models };
}

/** The block a new built-in session starts with when Settings turns Orchestrator on. */
export function orchestratorStart(settings: {
  orchestratorEnabled?: boolean;
  orchestratorGoal?: OrchestratorGoal;
  orchestratorModels?: OrchestratorAssignments;
}): OrchestratorStart | undefined {
  if (!settings.orchestratorEnabled) return undefined;
  return orchestratorFromSettings(settings);
}

/** Every provider that receives the prompt, grouped in role order for the disclosure line. */
export function orchestratorDisclosure(assignments: OrchestratorAssignments): Array<{ providerId: string; roles: OrchestratorRole[] }> {
  const effective = effectiveOrchestratorAssignments(assignments);
  const groups: Array<{ providerId: string; roles: OrchestratorRole[] }> = [];
  for (const role of ORCHESTRATOR_ROLES) {
    const providerId = effective[role]?.providerId;
    if (!providerId) continue;
    const group = groups.find((item) => item.providerId === providerId);
    if (group) group.roles.push(role);
    else groups.push({ providerId, roles: [role] });
  }
  return groups;
}

/** The role's own stored model, before fallbacks resolve it. */
export function storedOrchestratorModel(assignments: OrchestratorAssignments, role: OrchestratorRole): OrchestratorModel | undefined {
  return assignments[role];
}

export const ORCHESTRATOR_SHAPE_LABELS: Record<OrchestratorShape, string> = {
  "direct-small": "Small",
  "direct-builder": "Builder",
  "lead-guided": "Lead-guided",
  "lead-only": "Lead only",
};

/** Short role names for one model call in the Usage trajectory. */
export const ORCHESTRATOR_USAGE_ROLE_LABELS: Record<OrchestratorUsageRole, string> = {
  router: "Router",
  small: "Small",
  builder: "Builder",
  lead: "Lead",
};

type ExecutedRouteRole = "lead" | "builder" | "small";

const EXECUTION_STAGES = new Set<OrchestratorRoute["stages"][number]["stage"]>(["small", "builder", "repair", "takeover", "lead"]);

/** The model that executed a routed turn, read from its last executing stage; a review does not write code. */
export function orchestratorRouteExecution(route: OrchestratorRoute): (OrchestratorRouteModel & { role: ExecutedRouteRole }) | undefined {
  const stage = [...route.stages].reverse().find((entry) => EXECUTION_STAGES.has(entry.stage));
  if (!stage) {
    const shape = route.executedShape ?? route.shape;
    if (shape === "direct-small") return { role: "small", ...route.roles.small };
    return shape === "direct-builder" ? { role: "builder", ...route.roles.builder } : { role: "lead", ...route.roles.lead };
  }
  const role = stage.stage === "small" ? "small" : stage.stage === "builder" || stage.stage === "repair" ? "builder" : "lead";
  return { role, modelId: stage.modelId, providerId: stage.providerId };
}

const ROUTE_FALLBACK_NOTES: Record<string, string> = {
  "router-invalid-json-fallback": "The Router reply was invalid, so this turn ran Lead-guided without review.",
  "router-unavailable-fallback": "The Router was unavailable, so this turn ran Lead-guided without review.",
  "scout:invalid": "Scouting did not produce a usable context pack, so the Lead planned without one.",
  "scout:unavailable": "The Scout could not use read tools, so the Lead planned without a context pack.",
  "scout:small-no-tools": "The Small-task model has no tools, so scouting was skipped.",
  "lead-read:unavailable": "The Lead could not use read tools, so it planned from the brief.",
};

const SHAPE_RANK: Record<OrchestratorShape, number> = Object.fromEntries(ORCHESTRATOR_SHAPES.map((shape, index) => [shape, index])) as Record<OrchestratorShape, number>;

/**
 * The shape a floor raised a per-message choice to, or undefined when the
 * requested shape ran unchanged (or Auto decided).
 */
export function orchestratorRouteFloor(route: OrchestratorRoute): OrchestratorShape | undefined {
  if (!route.requestedShape || SHAPE_RANK[route.shape] <= SHAPE_RANK[route.requestedShape]) return undefined;
  return route.shape;
}

/** The receipt's "fallback" mark and its hover text: routing itself fell back, not a per-message floor. */
export function orchestratorRouteFallback(route: OrchestratorRoute): string | undefined {
  const notes = [...new Set(route.reasonCodes.flatMap((code) => (ROUTE_FALLBACK_NOTES[code] ? [ROUTE_FALLBACK_NOTES[code]] : [])))];
  if (route.executionFallback === "lead-single-stage") notes.push("This earlier turn ran as the Lead alone rather than through the staged pipeline.");
  if (route.executionFallback === "plan-invalid") notes.push("The Lead's plan was rejected twice, so the Lead completed the turn itself.");
  return notes.length ? notes.join(" ") : undefined;
}

/** Why a routed turn did not follow its shape exactly, in plain words; undefined for a clean route. */
export function orchestratorRouteNote(route: OrchestratorRoute): string | undefined {
  const floor = orchestratorRouteFloor(route);
  const notes = [
    orchestratorRouteFallback(route),
    floor && route.requestedShape ? `A floor raised this message from ${ORCHESTRATOR_SHAPE_LABELS[route.requestedShape]} to ${ORCHESTRATOR_SHAPE_LABELS[floor]}.` : undefined,
  ].filter(Boolean);
  return notes.length ? notes.join(" ") : undefined;
}

/** The receipt's short route fact: the shape the policy decided. */
export function orchestratorRouteLabel(route: OrchestratorRoute): string {
  return ORCHESTRATOR_SHAPE_LABELS[route.shape];
}

/** Hover detail for a route fact: what the user asked for, the goal, and any fallback or floor. */
export function orchestratorRouteTitle(route: OrchestratorRoute): string {
  const goal = ORCHESTRATOR_GOAL_COPY[route.goal].label.toLowerCase();
  const asked = route.requestedShape && route.requestedShape !== route.shape
    ? `You asked for ${ORCHESTRATOR_SHAPE_LABELS[route.requestedShape]}; routed as ${orchestratorRouteLabel(route)} (${goal})`
    : `Routed as ${orchestratorRouteLabel(route)} (${goal})`;
  const note = orchestratorRouteNote(route);
  const facts = orchestratorRouteFacts(route).join(" · ");
  return [asked, note, facts].filter(Boolean).join(". ");
}

/** "2 calls · 1 model" over the calls a route reported; undefined before any arrives. */
export function orchestratorRouteCallFact(calls: readonly ModelCall[] | undefined, routeId: string): string | undefined {
  const routed = (calls ?? []).filter((call) => call.routeId === routeId);
  if (!routed.length) return undefined;
  const models = new Set(routed.map((call) => call.modelId)).size;
  return `${routed.length} ${routed.length === 1 ? "call" : "calls"} · ${models} ${models === 1 ? "model" : "models"}`;
}

/** A short model name for a route fact; the provider prefix would only repeat the provider. */
export function orchestratorModelName(modelId: string): string {
  const part = modelId.slice(modelId.lastIndexOf("/") + 1).replace(/^~/, "");
  return part || modelId;
}

const CONSULT_BUDGET: Record<OrchestratorGoal, number> = { cost: 1, balanced: 2, output: 4 };

function lastStage(route: OrchestratorRoute, stage: OrchestratorRoute["stages"][number]["stage"]): OrchestratorRoute["stages"][number] | undefined {
  return [...route.stages].reverse().find((entry) => entry.stage === stage);
}

/**
 * The short facts a staged turn can state about how it ran: who planned, who
 * built, how many consults were spent, whether the Lead took over and who
 * reviewed. A single-role turn already says its model in the receipt, so it
 * adds no facts here.
 */
export function orchestratorRouteFacts(route: OrchestratorRoute): string[] {
  if (route.shape !== "lead-guided") return [];
  const facts: string[] = [];
  const scout = lastStage(route, "scout");
  if (scout) facts.push(`Scout · ${orchestratorModelName(scout.modelId)}`);
  const plan = lastStage(route, "lead-plan");
  const builder = lastStage(route, "builder") ?? lastStage(route, "repair");
  const approved = route.reasonCodes.includes("execution:approved-plan");
  const resumed = route.reasonCodes.includes("execution:resumed-builder");
  if (plan && builder) facts.push(`${approved ? "Approved plan" : "Lead plan"} · ${orchestratorModelName(plan.modelId)} → Builder · ${orchestratorModelName(builder.modelId)}`);
  else if (builder) {
    if (approved) facts.push(`Approved plan · ${orchestratorModelName(route.roles.lead.modelId)} → Builder · ${orchestratorModelName(builder.modelId)}`);
    else if (resumed) facts.push(`Builder resumed · ${orchestratorModelName(builder.modelId)}`);
    else facts.push(`Builder · ${orchestratorModelName(builder.modelId)}`);
  }
  else if (plan && route.executionFallback !== "plan-invalid") facts.push(`Lead plan · ${orchestratorModelName(plan.modelId)}`);
  if (route.consultCount > 0) {
    const budget = route.consultBudget ?? CONSULT_BUDGET[route.goal];
    facts.push(`Builder asked the Lead · ${route.consultCount} of ${budget}`);
  }
  const takeover = route.takeovers[route.takeovers.length - 1];
  if (takeover) {
    const reason = takeover.replace(/^builder:/, "").trim();
    facts.push(`Lead took over${reason ? ` · ${reason.length > 90 ? `${reason.slice(0, 89)}…` : reason}` : ""}`);
  }
  if (route.reviewCount > 0) {
    const review = lastStage(route, "review");
    const name = orchestratorModelName(review?.modelId ?? route.roles.lead.modelId);
    facts.push(`Reviewed by ${name}${route.reviewCount > 1 ? ` · ${route.reviewCount} reviews` : ""}`);
  }
  return facts;
}
