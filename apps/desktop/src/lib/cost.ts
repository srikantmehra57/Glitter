import type { EstimatedCost, Model, ModelCall, TokenUsage } from "./types";

/** Catalog `ModelCost` rows price tokens per one million (MSP wire schema). */
const PER_MILLION = 1_000_000;

/** One catalog price leg as a per-1M rate; undefined when the leg is unpriced. */
function rate(value: string | undefined): number | undefined {
  if (value == null || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Only two explicitly reported zero prices make a model free. */
export function freeModelCost(cost: Model["cost"]): boolean {
  return rate(cost?.input) === 0 && rate(cost?.output) === 0;
}

/** A missing price is unknown, including when the other leg is free. */
export function modelPriceParts(cost: Model["cost"]): [string, string] | null {
  if (!cost || freeModelCost(cost)) return null;
  const input = rate(cost.input);
  const output = rate(cost.output);
  if (input == null && output == null) return null;
  const sign = !cost.currency || cost.currency === "USD" ? "$" : `${cost.currency} `;
  return [input == null ? "—" : `${sign}${cost.input}`, output == null ? "—" : `${sign}${cost.output}`];
}

/**
 * Estimated cost of counted tokens at the model's catalog rates. Client-local
 * view math over reported usage — the wire schema leaves cost arithmetic to
 * clients. Undefined when the model has no usable price for the counted legs,
 * or when no tokens were counted, so callers omit the figure instead of
 * showing a half-priced or empty one.
 */
export function estimateCost(
  usage: Pick<TokenUsage, "promptTokens" | "outputTokens"> | null | undefined,
  cost: Model["cost"],
): number | undefined {
  const prompt = usage?.promptTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  if (!Number.isFinite(prompt) || !Number.isFinite(output) || prompt < 0 || output < 0) return undefined;
  if (prompt === 0 && output === 0) return undefined;
  const inputRate = rate(cost?.input);
  const outputRate = rate(cost?.output);
  if (prompt > 0 && inputRate == null) return undefined;
  if (output > 0 && outputRate == null) return undefined;
  return (prompt / PER_MILLION) * (inputRate ?? 0) + (output / PER_MILLION) * (outputRate ?? 0);
}

/**
 * Price every call leg whose catalog rate is known. Cached input is not
 * silently charged at the full input rate: without a cached rate that leg is
 * omitted and the result is explicitly partial. Multiple currencies stay
 * separate when the ledger aggregates these estimates.
 */
export function estimateCallCost(
  call: Pick<ModelCall, "inputTokens" | "cachedTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  cost: Model["cost"],
): EstimatedCost | undefined {
  const { inputTokens, cachedTokens, outputTokens } = call;
  if (![inputTokens, cachedTokens, outputTokens].every((value) => Number.isFinite(value) && value >= 0) || cachedTokens > inputTokens) return undefined;
  if (!inputTokens && !outputTokens) return undefined;
  const { cacheReadTokens, cacheWriteTokens } = call;
  const hasBreakdown = cacheReadTokens != null && cacheWriteTokens != null;
  if (hasBreakdown && (![cacheReadTokens, cacheWriteTokens].every((value) => Number.isFinite(value) && value >= 0) || cacheReadTokens + cacheWriteTokens > cachedTokens)) return undefined;
  const legs = [
    { tokens: inputTokens - cachedTokens, rate: rate(cost?.input) },
    ...(hasBreakdown ? [
      { tokens: cacheReadTokens, rate: rate(cost?.cached) },
      { tokens: cacheWriteTokens, rate: rate(cost?.cacheWrite) },
      { tokens: cachedTokens - cacheReadTokens - cacheWriteTokens, rate: undefined },
    ] : [{ tokens: cachedTokens, rate: undefined }]),
    { tokens: outputTokens, rate: rate(cost?.output) },
  ];
  let amount = 0;
  let priced = false;
  let partial = false;
  for (const leg of legs) {
    if (!leg.tokens) continue;
    if (leg.rate == null) { partial = true; continue; }
    amount += (leg.tokens / PER_MILLION) * leg.rate;
    priced = true;
  }
  if (!priced) return undefined;
  const currency = cost?.currency?.trim() || "USD";
  return { amount, currency, partial };
}

/** Price cumulative provider usage without silently dropping its cached tokens. */
export function estimateUsageCost(usage: TokenUsage | null | undefined, cost: Model["cost"]): EstimatedCost | undefined {
  if (!usage) return undefined;
  const input = usage.promptTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  return estimateCallCost({ inputTokens: input + cacheReadTokens + cacheWriteTokens, cachedTokens: cacheReadTokens + cacheWriteTokens, cacheReadTokens, cacheWriteTokens, outputTokens: usage.outputTokens ?? 0 }, cost);
}

/**
 * Money for estimate labels: "$0.42", free models "$0.00". Sub-cent values
 * keep decimals so they never round to a misleading "$0.00"; anything below
 * $0.0001 reads as under that. Non-USD currencies use their code, matching
 * the model picker's price labels.
 */
export function formatCost(usd: number, currency?: string | null): string {
  if (!Number.isFinite(usd) || usd < 0) return "—";
  const sign = !currency || currency === "USD" ? "$" : `${currency} `;
  if (usd > 0 && usd < 0.01) {
    const trimmed = usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    return trimmed === "0" ? `<${sign}0.0001` : `${sign}${trimmed}`;
  }
  return `${sign}${usd.toFixed(2)}`;
}
