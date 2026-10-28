import { splitModelId } from "../providers.js";
import type { OrchestratorGoal, OrchestratorModel, OrchestratorRole, OrchestratorSettings } from "./types.js";

export type OrchestratorSettingsValidation = { ok: true; value: OrchestratorSettings } | { ok: false; errors: string[] };

const GOALS: readonly OrchestratorGoal[] = ["cost", "balanced", "output"];
const ROLES: readonly OrchestratorRole[] = ["lead", "builder", "small"];
const ALL_ROLES = [...ROLES, "router"] as const;
const MAX_MODEL_ID = 256;
const MAX_PROVIDER_ID = 256;
const LABEL: Record<(typeof ALL_ROLES)[number], string> = { lead: "Lead", builder: "Builder", small: "Small-task", router: "Router" };

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

function model(value: unknown, role: keyof typeof LABEL, errors: string[]): OrchestratorModel | undefined {
  if (!isRecord(value)) {
    errors.push(`${LABEL[role]} model must be an object.`);
    return undefined;
  }
  for (const key of Object.keys(value)) if (key !== "modelId" && key !== "providerId") errors.push(`Unknown ${LABEL[role]} model field: ${key}.`);
  if (typeof value.modelId !== "string" || !value.modelId.trim()) {
    errors.push(`${LABEL[role]} model needs a modelId.`);
    return undefined;
  }
  const modelId = value.modelId.trim();
  if (modelId.length > MAX_MODEL_ID) errors.push(`${LABEL[role]} modelId exceeds ${MAX_MODEL_ID} characters.`);
  const { providerId: prefix } = splitModelId(modelId);
  if (!prefix) {
    errors.push(`${LABEL[role]} modelId must be a provider/model id.`);
    return undefined;
  }
  if (value.providerId !== undefined && (typeof value.providerId !== "string" || !value.providerId.trim())) {
    errors.push(`${LABEL[role]} providerId must be a non-empty string.`);
  } else if (typeof value.providerId === "string" && value.providerId.trim().length > MAX_PROVIDER_ID) {
    errors.push(`${LABEL[role]} providerId exceeds ${MAX_PROVIDER_ID} characters.`);
  } else if (typeof value.providerId === "string" && value.providerId.trim() !== prefix) {
    errors.push(`${LABEL[role]} modelId names ${prefix}, not ${value.providerId.trim()}.`);
  }
  return { providerId: prefix, modelId };
}

/**
 * Read the Renderer's Orchestrator block, resolving the plan's role fallbacks
 * (Small-task follows Builder, Router follows Small-task). Unlike stored
 * settings, a missing Lead or Builder is an error: a session must not start
 * with a role the user never assigned.
 */
export function normalizeOrchestratorSettings(input: unknown): OrchestratorSettingsValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["Orchestrator settings must be an object."] };
  for (const key of Object.keys(input)) if (key !== "goal" && key !== "models") errors.push(`Unknown orchestrator field: ${key}.`);

  let goal: OrchestratorGoal = "balanced";
  if (input.goal !== undefined) {
    if (typeof input.goal === "string" && (GOALS as readonly string[]).includes(input.goal)) goal = input.goal as OrchestratorGoal;
    else errors.push(`Orchestrator goal must be one of: ${GOALS.join(", ")}.`);
  }

  if (!isRecord(input.models)) {
    errors.push("Orchestrator models must be an object.");
    return { ok: false, errors };
  }
  for (const key of Object.keys(input.models)) if (!(ALL_ROLES as readonly string[]).includes(key)) errors.push(`Unknown orchestrator role: ${key}.`);

  const lead = input.models.lead === undefined ? undefined : model(input.models.lead, "lead", errors);
  const builder = input.models.builder === undefined ? undefined : model(input.models.builder, "builder", errors);
  if (input.models.lead === undefined) errors.push("A Lead model is required.");
  if (input.models.builder === undefined) errors.push("A Builder model is required.");

  const small = input.models.small === undefined ? undefined : model(input.models.small, "small", errors);
  const router = input.models.router === undefined ? undefined : model(input.models.router, "router", errors);
  if (!lead || !builder || errors.length) return { ok: false, errors };

  const resolvedSmall = small ?? builder;
  return {
    ok: true,
    value: {
      goal,
      roles: { lead, builder, small: resolvedSmall, router: router ?? resolvedSmall },
    },
  };
}
