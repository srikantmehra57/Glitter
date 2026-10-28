import type { EffortTarget } from "./types.js";

/**
 * Nearest supported tier per target, best first. `highest` is not a tier a
 * provider accepts: it resolves to the last level the model supports, and a
 * model with no effort control runs at its default (`undefined`).
 */
const PREFERENCE: Record<Exclude<EffortTarget, "highest">, readonly string[]> = {
  high: ["high", "xhigh", "max", "medium", "low", "minimal", "none"],
  medium: ["medium", "high", "xhigh", "max", "low", "minimal", "none"],
  low: ["low", "minimal", "none", "medium", "high", "xhigh", "max"],
};

export function resolveEffortTarget(target: EffortTarget | undefined, tiers: readonly string[]): string | undefined {
  if (!target || !tiers.length) return undefined;
  if (target === "highest") return tiers[tiers.length - 1];
  return PREFERENCE[target].find((tier) => tiers.includes(tier)) ?? tiers[0];
}
