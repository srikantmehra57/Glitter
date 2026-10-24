/**
 * The model providers the built-in harness can use, as Settings shows them.
 * The bridge (`packages/glitter-bridge/src/harness/providers.ts`) holds the wire
 * details and the native shell the list of ids it will store keys for; a test
 * keeps the three in step. Custom endpoints are not listed here: the native
 * shell mints their ids (`custom-1`…) and they arrive with the keychain
 * status, so any number of them can coexist.
 */

/** The two wires a model provider can speak. */
export type ProviderWire = "openai" | "anthropic";

export type ProviderEntry = {
  id: string;
  name: string;
  detail: string;
  /** Format hint for the key field. */
  placeholder?: string;
  /** Runs on this Mac: no key needed, and the address can change. */
  local?: boolean;
  /** The user supplies the address (a custom endpoint). */
  custom?: boolean;
  /** The wire a custom endpoint speaks; absent for providers with a fixed one. */
  wire?: ProviderWire;
  defaultUrl?: string;
  /** Where the user creates a key, opened from the key form. */
  keyUrl?: string;
};

export const PROVIDERS: ProviderEntry[] = [
  { id: "anthropic", name: "Anthropic", detail: "Claude models, with extended thinking for effort levels.", placeholder: "sk-ant-…", keyUrl: "https://platform.claude.com/settings/keys" },
  { id: "openai", name: "OpenAI", detail: "GPT and reasoning models.", placeholder: "sk-…", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "google", name: "Google Gemini", detail: "Gemini models, with a key from Google AI Studio.", placeholder: "AIza…", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "openrouter", name: "OpenRouter", detail: "Hundreds of models from many labs behind one key.", placeholder: "sk-or-…", keyUrl: "https://openrouter.ai/settings/keys" },
  { id: "cline", name: "Cline API", detail: "Anthropic, OpenAI, Google and more behind one Cline key.", placeholder: "sk-…", keyUrl: "https://app.cline.bot/dashboard/account" },
  { id: "kilo", name: "Kilo API", detail: "Anthropic, OpenAI, Google and more behind one Kilo key.", placeholder: "eyJ…", keyUrl: "https://app.kilo.ai/profile" },
  { id: "xai", name: "xAI", detail: "Grok models through the xAI API.", placeholder: "xai-…", keyUrl: "https://console.x.ai/" },
  { id: "deepseek", name: "DeepSeek", detail: "DeepSeek chat and reasoner models.", placeholder: "sk-…", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "groq", name: "Groq", detail: "Open models on fast inference hardware.", placeholder: "gsk_…", keyUrl: "https://console.groq.com/keys" },
  { id: "mistral", name: "Mistral", detail: "Mistral and Codestral models.", keyUrl: "https://console.mistral.ai/api-keys" },
  { id: "nvidia", name: "NVIDIA NIM", detail: "Open models such as Kimi, GLM and Nemotron, hosted by NVIDIA.", placeholder: "nvapi-…", keyUrl: "https://build.nvidia.com/settings/api-keys" },
  { id: "ollama", name: "Ollama", detail: "Models running on this Mac. No key needed.", local: true, defaultUrl: "http://localhost:11434/v1" },
  { id: "lmstudio", name: "LM Studio", detail: "Models served by LM Studio on this Mac. No key needed.", local: true, defaultUrl: "http://localhost:1234/v1" },
];

export const PROVIDER_IDS = PROVIDERS.map((provider) => provider.id);

/** A minted custom-endpoint id, as the native keychain stores it. */
export function isCustomProviderId(id: string): boolean {
  return /^custom-\d{1,4}$/.test(id);
}

/** What the renderer may know about a saved provider credential: never the key itself. */
export type ProviderStatus = { id: string; configured: boolean; keyHint: string | null; baseUrl: string | null; name?: string | null; wire?: string | null };

const WIRE_LABEL: Record<ProviderWire, string> = { openai: "OpenAI-compatible", anthropic: "Anthropic Messages" };

/** The wire a status row names, narrowed from the string the keychain sends. */
export function providerWire(wire?: string | null): ProviderWire | undefined {
  return wire === "anthropic" || wire === "openai" ? wire : undefined;
}

/** The label for a wire, as the Providers page names it. */
export function providerWireLabel(wire?: ProviderWire): string {
  return wire ? WIRE_LABEL[wire] : "";
}

/** Custom endpoints the keychain holds, as Settings and the pickers show them. */
export function customProviders(status: ReadonlyArray<Pick<ProviderStatus, "id" | "name" | "wire" | "baseUrl">>): ProviderEntry[] {
  return status.filter((row) => isCustomProviderId(row.id)).map((row) => {
    const wire = providerWire(row.wire);
    return {
      id: row.id,
      name: row.name?.trim() || "Custom endpoint",
      detail: [wire ? providerWireLabel(wire) : null, row.baseUrl].filter(Boolean).join(" · "),
      custom: true as const,
      ...(wire ? { wire } : {}),
    };
  });
}

/** Labs a catalog names that are not providers in the list above. */
const LAB_NAMES: Record<string, string> = { opencode: "OpenCode Zen", meta: "Meta", grok: "xAI", "x-ai": "xAI", "z-ai": "Z.ai", moonshotai: "Moonshot AI", mistralai: "Mistral", "meta-llama": "Meta", "deepseek-ai": "DeepSeek", qwen: "Qwen", "cline-free": "Cline" };

/** A provider's or lab's display name; a custom endpoint takes the name the user gave it. */
export function providerName(id?: string, customs: ReadonlyArray<{ id: string; name: string }> = []): string {
  if (!id) return "Models";
  const custom = customs.find((row) => row.id === id);
  if (custom) return custom.name;
  return PROVIDERS.find((provider) => provider.id === id)?.name ?? LAB_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** The provider ids a catalog uses: Settings order, other labs, then custom endpoints by minted id. */
export function providerIds(models: ReadonlyArray<{ providerId?: string }>): string[] {
  const ids = [...new Set(models.map((model) => model.providerId).filter((id): id is string => Boolean(id)))];
  const order = PROVIDER_IDS;
  const rank = (id: string) => {
    const at = order.indexOf(id);
    if (at >= 0) return at;
    const custom = isCustomProviderId(id) ? Number(id.slice("custom-".length)) : 0;
    // Custom endpoints follow everything the catalog might name, in minted order.
    return custom ? order.length + 1000 + custom : order.length;
  };
  return ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
