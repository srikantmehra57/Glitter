/**
 * Models the user switched off in Settings → Models. A hidden model leaves the
 * composer's picker but stays in its agent's catalog, so a thread already on it
 * keeps working and the model can be switched back on at any time.
 */
type ModelRef = { modelId: string; providerId?: string };

const MAX_HIDDEN = 2_000;
const MAX_KEY = 600;

/** One string per agent, provider and model, so the same id under two providers stays distinct. */
export function modelVisibilityKey(agentId: string, model: ModelRef): string {
  return `${agentId}|${model.providerId ?? ""}|${model.modelId}`;
}

export function normalizeHiddenModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = value.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= MAX_KEY && key.split("|").length >= 3);
  return [...new Set(keys)].slice(0, MAX_HIDDEN);
}

export function isModelHidden(hidden: readonly string[] | undefined, agentId: string, model: ModelRef): boolean {
  return Boolean(hidden?.length) && hidden!.includes(modelVisibilityKey(agentId, model));
}

/** The picker's list: hidden models drop out, except one a thread is using now. */
export function pickerModels<T extends ModelRef>(models: readonly T[], agentId: string, hidden: readonly string[] | undefined, keep?: ModelRef): T[] {
  if (!hidden?.length) return [...models];
  const set = new Set(hidden);
  return models.filter((model) => !set.has(modelVisibilityKey(agentId, model)) || (keep != null && keep.modelId === model.modelId && (keep.providerId ?? "") === (model.providerId ?? "")));
}

/** Show or hide a set of models at once, keeping every other agent's choices. */
export function withModelsHidden(hidden: readonly string[] | undefined, agentId: string, models: readonly ModelRef[], hide: boolean): string[] {
  const keys = models.map((model) => modelVisibilityKey(agentId, model));
  const rest = (hidden ?? []).filter((key) => !keys.includes(key));
  return normalizeHiddenModels(hide ? [...rest, ...keys] : rest);
}
