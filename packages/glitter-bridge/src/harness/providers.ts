/**
 * Model providers the built-in harness can call with the user's own key. Two
 * wire formats cover them: Anthropic's Messages API, and the OpenAI-compatible
 * Chat Completions API that every other provider here (and local servers such
 * as Ollama and LM Studio) also serves.
 *
 * Keys never live here. The native shell holds them in the OS keychain and
 * injects them into each harness request (`providerKeys`); a custom endpoint's
 * URL is stored with its key there, so a key can only ever be sent to the
 * address it was saved with.
 *
 * Custom endpoints are not in the static list: the native shell mints their
 * ids (`custom-1`, `custom-2`…) and their name, wire and address travel with
 * the credential, so any number of them can coexist.
 */

import { diagnostics } from "../redaction.js";

export type Wire = "anthropic" | "openai";

export type ProviderSpec = {
  id: string;
  name: string;
  wire: Wire;
  /** API root without a trailing slash. Custom endpoints take it from their saved credential. */
  baseUrl: string;
  /** Local servers answer without a key. */
  keyless?: boolean;
};

export const PROVIDERS: ProviderSpec[] = [
  { id: "anthropic", name: "Anthropic", wire: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { id: "openai", name: "OpenAI", wire: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "google", name: "Google Gemini", wire: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "openrouter", name: "OpenRouter", wire: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "cline", name: "Cline API", wire: "openai", baseUrl: "https://api.cline.bot/api/v1" },
  { id: "kilo", name: "Kilo API", wire: "openai", baseUrl: "https://ai-gateway.kilo.ai/api/v1" },
  { id: "xai", name: "xAI", wire: "openai", baseUrl: "https://api.x.ai/v1" },
  { id: "deepseek", name: "DeepSeek", wire: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { id: "groq", name: "Groq", wire: "openai", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "mistral", name: "Mistral", wire: "openai", baseUrl: "https://api.mistral.ai/v1" },
  { id: "nvidia", name: "NVIDIA NIM", wire: "openai", baseUrl: "https://integrate.api.nvidia.com/v1" },
  { id: "ollama", name: "Ollama", wire: "openai", baseUrl: "http://localhost:11434/v1", keyless: true },
  { id: "lmstudio", name: "LM Studio", wire: "openai", baseUrl: "http://localhost:1234/v1", keyless: true },
];

/** A minted custom-endpoint id, as the native keychain stores it. */
export function isCustomProvider(id: string): boolean {
  return /^custom-\d{1,4}$/.test(id);
}

/** What the native shell injects per configured provider. */
export type ProviderCredential = { key?: string; baseUrl?: string; name?: string; wire?: Wire };
export type ProviderCredentials = Record<string, ProviderCredential>;

/** Credentials injected by the native keychain, including custom endpoint identity and wire. */
export function nativeProviderCredentials(raw: unknown): ProviderCredentials | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const credentials: ProviderCredentials = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as { key?: unknown; baseUrl?: unknown; name?: unknown; wire?: unknown };
    const key = typeof entry.key === "string" ? entry.key : undefined;
    if (key) diagnostics.remember({ [`${id}ApiKey`]: key });
    credentials[id] = {
      ...(key ? { key } : {}),
      ...(typeof entry.baseUrl === "string" && entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      ...(typeof entry.name === "string" && entry.name ? { name: entry.name } : {}),
      ...(entry.wire === "anthropic" || entry.wire === "openai" ? { wire: entry.wire } : {}),
    };
  }
  return credentials;
}

export function providerSpec(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/** A configured provider ready to call: its wire, its root URL and its key. */
export type ResolvedProvider = ProviderSpec & { apiKey: string; root: string };

export function resolveProvider(id: string, credentials: ProviderCredentials): ResolvedProvider | null {
  const credential = credentials[id];
  if (!credential) return null;
  const apiKey = credential.key?.trim() ?? "";
  const spec = providerSpec(id);
  if (spec) {
    if (!apiKey && !spec.keyless) return null;
    const root = (credential.baseUrl?.trim() || spec.baseUrl).replace(/\/+$/, "");
    if (!root) return null;
    return { ...spec, apiKey, root };
  }
  // A custom endpoint carries everything the static list would know about it.
  if (!isCustomProvider(id)) return null;
  const root = credential.baseUrl?.trim().replace(/\/+$/, "") ?? "";
  if (!root) return null;
  return { id, name: credential.name?.trim() || "Custom endpoint", wire: credential.wire === "anthropic" ? "anthropic" : "openai", baseUrl: root, ...(apiKey ? {} : { keyless: true }), apiKey, root };
}

/** Configured providers, in catalog order: the static list, then custom endpoints by minted id. */
export function configuredProviders(credentials: ProviderCredentials): ResolvedProvider[] {
  const custom = Object.keys(credentials).filter(isCustomProvider).sort((a, b) => Number(a.slice("custom-".length)) - Number(b.slice("custom-".length)));
  return [...PROVIDERS.map((spec) => spec.id), ...custom]
    .map((id) => resolveProvider(id, credentials))
    .filter((provider): provider is ResolvedProvider => Boolean(provider));
}

/** `provider/model` ids: the provider is everything before the first slash. */
export function splitModelId(modelId: string): { providerId: string; model: string } {
  const slash = modelId.indexOf("/");
  return slash < 0 ? { providerId: "", model: modelId } : { providerId: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

/** Effort tiers the app shows, in order. */
export const TIERS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Tier = (typeof TIERS)[number];

/** Reasoning families a gateway (OpenRouter, the Cline API, the Kilo API) routes to, by the vendor's own model names. */
const GATEWAY_REASONING = /(^|\/)(o\d|gpt-([5-9]|\d\d)|gpt-oss)|codex|claude-(3-7|sonnet-4|opus-4|[a-z]+-[4-9])|gemini-(2\.5|[3-9])|deepseek-(r1|v3\.[1-9]|v[4-9])|grok-([3-9]|code)|qwen3|qwq|glm-(4\.[5-9]|[5-9])|kimi-k[2-9]|minimax-m|nemotron|magistral|reasoning|thinking/;

/** OpenAI-compatible gateways accept these levels even though their model lists do not report them. */
const CUSTOM_REASONING: Tier[] = ["minimal", "low", "medium", "high"];

/**
 * Kimi K3 (including K3.1 Pro and Highspeed) and K2.8. Moonshot accepts
 * exactly low, high, and max; the model always reasons, so None is not a level.
 */
const KIMI_THREE_EFFORT = /(?:^|\/)kimi-k(?:3(?:[.-]|$)|2\.8(?:[.-]|$))/;

/**
 * NIM models whose chat template takes a thinking switch. They have no
 * levels, only on and off, which the app shows as None and High.
 */
const NIM_THINKING_SWITCH = /nemotron-(nano-9b-v2|[3-9])|qwen3|deepseek-v3\.[1-9]|deepseek-v[4-9]|glm-(4\.[5-9]|[5-9])|kimi-k2\.[5-9]/;

/** Providers whose wire carries an explicit "none" (thinking off). The rest treat None as their default. */
export const SENDS_NONE = new Set(["nvidia", "cline", "openrouter", "kilo"]);

/**
 * How a Claude model takes reasoning, by its published family rules.
 *
 * - `budget`: Claude 3.7 through 4.5 take `thinking.budget_tokens`.
 * - `adaptive`: Claude 4.6 and later take `thinking: {type: "adaptive"}` plus
 *   `output_config.effort`, and reject a token budget with a 400.
 *
 * `off` says how None is expressed: by omitting `thinking` (the model then
 * does not think), by `{type: "disabled"}` (the model would otherwise think),
 * or not at all (the model always thinks, so None is not a level).
 * `display` asks for summarized thinking text, which these models otherwise
 * omit. `binding` marks models that check a replayed thinking block against
 * the history that produced it.
 */
export type ClaudeThinking =
  | { mode: "budget" }
  | { mode: "adaptive"; off: "omit" | "disabled" | "never"; defaultOn: boolean; display: boolean; binding: boolean; tiers: Tier[] };

const CLAUDE_VERSION = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2})(?!\d))?/;

export function claudeThinking(model: string): ClaudeThinking | null {
  const id = model.toLowerCase();
  // 3.0 and 3.5 have no thinking; 3.7 is the first family with a budget.
  if (/claude-3-(?!7)|claude-instant|claude-2/.test(id)) return null;
  if (/claude-3-7/.test(id)) return { mode: "budget" };
  // Another vendor's model behind an Anthropic-compatible endpoint keeps the
  // budget shape those endpoints implement.
  if (!id.includes("claude")) return { mode: "budget" };
  const match = CLAUDE_VERSION.exec(id);
  const family = match?.[1];
  const version = match ? Number(match[2]) + Number(match[3] ?? 0) / 10 : Infinity;
  const all: Tier[] = ["none", "low", "medium", "high", "xhigh", "max"];
  const always: Tier[] = ["low", "medium", "high", "xhigh", "max"];
  if (family === "fable" || family === "mythos" || !family) return { mode: "adaptive", off: "never", defaultOn: true, display: true, binding: true, tiers: always };
  if (version <= 4.5) return { mode: "budget" };
  if (version < 4.7) return { mode: "adaptive", off: "omit", defaultOn: false, display: false, binding: false, tiers: ["none", "low", "medium", "high", "max"] };
  if (version < 5) return { mode: "adaptive", off: "omit", defaultOn: false, display: true, binding: false, tiers: all };
  // Haiku 5.5 thinks by default and still accepts `disabled`; it checks replayed blocks.
  if (family === "haiku" && version < 6) return { mode: "adaptive", off: "disabled", defaultOn: true, display: true, binding: version >= 5.5, tiers: all };
  if (version < 5.5) return { mode: "adaptive", off: "disabled", defaultOn: true, display: true, binding: false, tiers: all };
  return { mode: "adaptive", off: "never", defaultOn: true, display: true, binding: true, tiers: always };
}

/**
 * The effort tiers a model takes, or none when it has no reasoning control.
 * A catalog that names the accepted levels (OpenRouter does) is authoritative.
 * Otherwise providers do not report this, so it follows their published model
 * families; an unknown model simply shows no effort picker.
 */
export function effortTiers(providerId: string, model: string, wire: "anthropic" | "openai" = providerId === "anthropic" ? "anthropic" : "openai", listedReasoning?: boolean, listedEfforts?: readonly string[]): Tier[] {
  if (listedEfforts) return TIERS.filter((tier) => listedEfforts.includes(tier));
  const id = model.toLowerCase();
  if (wire === "anthropic") {
    // Extended thinking: Claude 3.7 and every later family. 3.0 and 3.5 lack it.
    const thinking = claudeThinking(id);
    if (!thinking) return [];
    return thinking.mode === "budget" ? ["none", "low", "medium", "high", "xhigh", "max"] : thinking.tiers;
  }
  if (providerId === "openai") return /^(o\d|gpt-5|codex)/.test(id) ? ["minimal", "low", "medium", "high"] : [];
  if (providerId === "xai") return /grok-3-mini/.test(id) ? ["low", "high"] : [];
  if (providerId === "google") return /gemini-(2\.5|[3-9])/.test(id) ? ["none", "low", "medium", "high"] : [];
  // NIM documents `reasoning_effort` for gpt-oss, and a template switch for its hybrid thinkers.
  if (providerId === "nvidia") return /(^|\/)gpt-oss/.test(id) ? ["low", "medium", "high"] : NIM_THINKING_SWITCH.test(id) ? ["none", "high"] : [];
  if (providerId === "groq") return /(^|\/)gpt-oss/.test(id) ? ["low", "medium", "high"] : [];
  // Custom OpenAI-compatible gateways such as ZenMux use the common reasoning vocabulary.
  // A catalog capability is authoritative; older gateways only need the family fallback.
  // Kimi K3's published levels replace that list, with or without the capability flag.
  if (isCustomProvider(providerId)) {
    if (KIMI_THREE_EFFORT.test(id)) return ["low", "high", "max"];
    return (listedReasoning ?? GATEWAY_REASONING.test(id)) ? CUSTOM_REASONING : [];
  }
  // Gateways take OpenRouter's effort vocabulary and drop what a model cannot use.
  // Kilo's auto routers are virtual ids, so the family pattern never sees the model they resolve to.
  if (providerId === "kilo" && /(^|\/)kilo-auto\//.test(id)) return ["none", "low", "medium", "high", "xhigh"];
  if (providerId === "openrouter" || providerId === "cline" || providerId === "kilo") return GATEWAY_REASONING.test(id) ? ["none", "low", "medium", "high", "xhigh"] : [];
  return [];
}

/** The level a catalog marks when the model does not name one. Moonshot's default for Kimi K3 is max. */
export function defaultEffortTier(model: string, tiers: readonly Tier[]): Tier | undefined {
  if (!tiers.length) return undefined;
  if (KIMI_THREE_EFFORT.test(model.toLowerCase()) && tiers.includes("max")) return "max";
  if (tiers.includes("medium")) return "medium";
  return tiers[Math.floor(tiers.length / 2)];
}

/** Anthropic thinking budgets per tier (tokens). */
export const THINKING_BUDGET: Partial<Record<Tier, number>> = { low: 2048, medium: 8192, high: 16384, xhigh: 32000, max: 63999 };
