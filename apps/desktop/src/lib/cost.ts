import type { Model, TokenUsage } from "./types";

/** Catalog `ModelCost` rows price tokens per one million (MSP wire schema). */
const PER_MILLION = 1_000_000;

/** One catalog price leg as a per-1M rate; undefined when the leg is unpriced. */
function rate(value: string | undefined): number | undefined {
  if (value == null || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
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
