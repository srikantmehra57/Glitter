import type { Model, ReasoningEffort, SessionConfig } from "./types";

export const TIER_ORDER: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
/** What the host accepts when a model row does not list its own tiers (`ultra` is experimental-gated). */
export const VOCABULARY: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export const HOST_DEFAULT: ReasoningEffort = "high";

export const TIER_COPY: Record<ReasoningEffort, { label: string; short: string }> = {
  none: { label: "None", short: "None" },
  minimal: { label: "Minimal", short: "Min" },
  low: { label: "Low", short: "Low" },
  medium: { label: "Medium", short: "Med" },
  high: { label: "High", short: "High" },
  xhigh: { label: "Extra high", short: "XHigh" },
  max: { label: "Max", short: "Max" },
  ultra: { label: "Ultra", short: "Ultra" },
};

export function modelFor(models: Model[], config: Pick<SessionConfig, "modelId" | "providerId">): Model | undefined {
  if (config.modelId) {
    return models.find((model) => model.modelId === config.modelId && (!config.providerId || !model.providerId || model.providerId === config.providerId))
      ?? models.find((model) => model.modelId === config.modelId);
  }
  return models.find((model) => model.isActive) ?? models.find((model) => model.isDefault) ?? models[0];
}

/**
 * The catalog, plus any model a selection still names that the agent no longer
 * lists (Muse 1.4 stopped listing the `-contributor` ids, for one). The choice
 * stays visible and selectable instead of leaving the picker with nothing
 * selected. An empty catalog stays empty: there is nothing to compare against.
 */
export function withUnlistedModels(models: Model[], selections: Array<Pick<SessionConfig, "modelId" | "providerId">>): Model[] {
  if (!models.length) return models;
  const unlisted: Model[] = [];
  for (const selection of selections) {
    const modelId = selection.modelId?.trim();
    if (!modelId || modelFor(models, { modelId }) || unlisted.some((model) => model.modelId === modelId)) continue;
    unlisted.push({ modelId, providerId: selection.providerId, unlisted: true });
  }
  return unlisted.length ? [...models, ...unlisted] : models;
}

/**
 * Effort tiers the model accepts. Tiers reported by the agent win; an agent that
 * reports none for a model (e.g. an OpenCode model without variants) gets no
 * effort control. Only Muse falls back to its documented vocabulary.
 */
export function tiersFor(model: Model | undefined, agentId: string = "muse"): ReasoningEffort[] {
  if (model?.reasoningEfforts && (model.effortSource === "host" || agentId !== "muse")) return TIER_ORDER.filter((tier) => model.reasoningEfforts!.includes(tier));
  const tiers = model?.reasoningEfforts?.filter((tier) => TIER_ORDER.includes(tier));
  if (tiers?.length) return TIER_ORDER.filter((tier) => tiers.includes(tier));
  return agentId === "muse" ? VOCABULARY : [];
}

export function defaultTier(model: Model | undefined, tiers = tiersFor(model)): ReasoningEffort | undefined {
  const declared = model?.defaultReasoningEffort;
  if (declared && tiers.includes(declared)) return declared;
  if (!tiers.length) return undefined;
  return tiers.includes(HOST_DEFAULT) ? HOST_DEFAULT : tiers[Math.floor(tiers.length / 2)];
}

/** Nearest supported tier at or below `effort` (or the lowest one). */
export function clampTier(effort: ReasoningEffort | undefined, tiers: ReasoningEffort[]): ReasoningEffort | undefined {
  if (!effort || !tiers.length || tiers.includes(effort)) return effort;
  const rank = TIER_ORDER.indexOf(effort);
  const below = tiers.filter((tier) => TIER_ORDER.indexOf(tier) <= rank);
  return below[below.length - 1] ?? tiers[0];
}

/** The model's own top tier (Max on Muse, Extra high on Grok) is the peak mode with its own visuals. */
export function isPeak(effort: ReasoningEffort | undefined, tiers: ReasoningEffort[]) {
  return Boolean(effort) && tiers.length > 1 && effort === tiers[tiers.length - 1] && TIER_ORDER.indexOf(effort!) >= TIER_ORDER.indexOf("xhigh");
}

const FAST_ID = /-(?:build-)?fast$/;

/** A Grok-style fast variant: `grok-4.7-build-fast` (or plain `-fast`) pairs with `grok-4.7`. */
export function isFastModel(model: Pick<Model, "modelId"> | undefined): boolean {
  return Boolean(model && FAST_ID.test(model.modelId));
}
