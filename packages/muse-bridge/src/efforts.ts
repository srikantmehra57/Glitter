import type { ReasoningEffort } from "./protocol.js";

/**
 * Reasoning-effort tiers per model.
 *
 * Muse 1.4's `model/list` forwards a model's accepted tiers as `variants`; the
 * older `reasoningEffortVariants` field is a recommendation hint and may name
 * only a subset (e.g. just `xhigh`), so it must not win over `variants`.
 * Resolution:
 *   1. `variants` on the host's model row, when it lists known tiers
 *   2. other tier fields the host may forward (`reasoningEffortVariants`,
 *      `reasoningEfforts`, `supportedReasoningEfforts`)
 *   3. otherwise the host's tier vocabulary: `none`…`max`, plus `ultra` only when
 *      the host runs with MUSE_EXPERIMENTAL_ULTRA_REASONING_EFFORT
 */

export const TIER_ORDER: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
/** The CLI's documented default tier for Meta models. */
export const DEFAULT_TIER: ReasoningEffort = "high";

function isTier(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (TIER_ORDER as string[]).includes(value);
}

/** Accepts `["low", …]`, `[{ tier: "low" }, …]`, or `[{ reasoningEffort: "low" }, …]`. */
export function tiersFrom(raw: unknown): ReasoningEffort[] | null {
  if (!Array.isArray(raw)) return null;
  const tiers = raw
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      return row.tier ?? row.reasoningEffort ?? row.reasoning_effort;
    })
    .filter(isTier);
  const ordered = TIER_ORDER.filter((tier) => tiers.includes(tier));
  return ordered.length ? ordered : null;
}

export function vocabularyTiers(env: NodeJS.ProcessEnv): ReasoningEffort[] {
  const ultra = /^(1|true|on|yes)$/i.test(env.MUSE_EXPERIMENTAL_ULTRA_REASONING_EFFORT ?? "");
  return TIER_ORDER.filter((tier) => tier !== "ultra" || ultra);
}

/** Adds `reasoningEfforts`, `defaultReasoningEffort`, and `effortSource` to each `model/list` row. */
export function annotateEfforts<T extends { models?: unknown[] }>(result: T, env: NodeJS.ProcessEnv): T {
  const vocabulary = vocabularyTiers(env);
  const models = Array.isArray(result.models) ? result.models : [];
  return {
    ...result,
    models: models.map((model) => {
      const row = model as Record<string, unknown>;
      const own = tiersFrom(row.variants) ?? tiersFrom(row.reasoningEffortVariants) ?? tiersFrom(row.reasoningEfforts) ?? tiersFrom(row.supportedReasoningEfforts);
      const tiers = own ?? vocabulary;
      const declared = row.defaultReasoningEffort;
      const fallback = tiers.includes(DEFAULT_TIER) ? DEFAULT_TIER : tiers[Math.floor(tiers.length / 2)];
      return {
        ...row,
        reasoningEfforts: tiers,
        defaultReasoningEffort: isTier(declared) && tiers.includes(declared) ? declared : fallback,
        effortSource: own ? "host" : "vocabulary",
      };
    }),
  };
}
