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
 */

export type Wire = "anthropic" | "openai";

export type ProviderSpec = {
  id: string;
  name: string;
  wire: Wire;
  /** API root without a trailing slash. Empty for `custom`, whose URL is saved with its key. */
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
  { id: "xai", name: "xAI", wire: "openai", baseUrl: "https://api.x.ai/v1" },
  { id: "deepseek", name: "DeepSeek", wire: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { id: "groq", name: "Groq", wire: "openai", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "mistral", name: "Mistral", wire: "openai", baseUrl: "https://api.mistral.ai/v1" },
  { id: "nvidia", name: "NVIDIA NIM", wire: "openai", baseUrl: "https://integrate.api.nvidia.com/v1" },
  { id: "ollama", name: "Ollama", wire: "openai", baseUrl: "http://localhost:11434/v1", keyless: true },
  { id: "lmstudio", name: "LM Studio", wire: "openai", baseUrl: "http://localhost:1234/v1", keyless: true },
  { id: "custom", name: "Custom endpoint", wire: "openai", baseUrl: "" },
];

/** What the native shell injects per configured provider. */
export type ProviderCredential = { key?: string; baseUrl?: string };
export type ProviderCredentials = Record<string, ProviderCredential>;

export function providerSpec(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/** A configured provider ready to call: its wire, its root URL and its key. */
export type ResolvedProvider = ProviderSpec & { apiKey: string; root: string };

export function resolveProvider(id: string, credentials: ProviderCredentials): ResolvedProvider | null {
  const spec = providerSpec(id);
  const credential = credentials[id];
  if (!spec || !credential) return null;
  const apiKey = credential.key?.trim() ?? "";
  if (!apiKey && !spec.keyless) return null;
  const root = (credential.baseUrl?.trim() || spec.baseUrl).replace(/\/+$/, "");
  if (!root) return null;
  return { ...spec, apiKey, root };
}

/** Configured providers, in catalog order. */
export function configuredProviders(credentials: ProviderCredentials): ResolvedProvider[] {
  return PROVIDERS.map((spec) => resolveProvider(spec.id, credentials)).filter((provider): provider is ResolvedProvider => Boolean(provider));
}

/** `provider/model` ids: the provider is everything before the first slash. */
export function splitModelId(modelId: string): { providerId: string; model: string } {
  const slash = modelId.indexOf("/");
  return slash < 0 ? { providerId: "", model: modelId } : { providerId: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
}

/** Effort tiers the app shows, in order. */
export const TIERS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * The effort tiers a model takes, or none when it has no reasoning control.
 * Providers do not report this, so it follows their published model families;
 * an unknown model simply shows no effort picker.
 */
export function effortTiers(providerId: string, model: string): Tier[] {
  const id = model.toLowerCase();
  if (providerId === "anthropic") {
    // Extended thinking: Claude 3.7 and every later family. 3.0 and 3.5 lack it.
    return /claude-3-(?!7)|claude-instant|claude-2/.test(id) ? [] : ["none", "low", "medium", "high", "xhigh", "max"];
  }
  if (providerId === "openai") return /^(o\d|gpt-5|codex)/.test(id) ? ["minimal", "low", "medium", "high"] : [];
  if (providerId === "xai") return /grok-3-mini/.test(id) ? ["low", "high"] : [];
  if (providerId === "google") return /gemini-(2\.5|[3-9])/.test(id) ? ["none", "low", "medium", "high"] : [];
  // NIM documents `reasoning_effort` only for its gpt-oss models.
  if (providerId === "nvidia") return /(^|\/)gpt-oss/.test(id) ? ["low", "medium", "high"] : [];
  if (providerId === "openrouter") {
    return /(^|\/)(o\d|gpt-5)|claude-(3-7|sonnet-4|opus-4|[a-z]+-[4-9])|gemini-(2\.5|[3-9])|deepseek-r1|grok-3-mini|qwq|reasoning|thinking/.test(id) ? ["low", "medium", "high"] : [];
  }
  // Cline's API documents no reasoning-effort parameter. Sending one it does
  // not accept would fail the call, so its models show no effort picker.
  if (providerId === "cline") return [];
  return [];
}

/** Anthropic thinking budgets per tier (tokens). */
export const THINKING_BUDGET: Partial<Record<Tier, number>> = { low: 2048, medium: 8192, high: 16384, xhigh: 32000, max: 63999 };
