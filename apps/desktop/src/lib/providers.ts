/**
 * The model providers the built-in harness can use, as Settings shows them.
 * The bridge (`packages/glitter-bridge/src/harness/providers.ts`) holds the wire
 * details and the native shell the list of ids it will store keys for; a test
 * keeps the three in step.
 */
export type ProviderEntry = {
  id: string;
  name: string;
  detail: string;
  /** Format hint for the key field. */
  placeholder?: string;
  /** Runs on this Mac: no key needed, and the address can change. */
  local?: boolean;
  /** The user supplies the address (a custom OpenAI-compatible API). */
  custom?: boolean;
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
  { id: "xai", name: "xAI", detail: "Grok models through the xAI API.", placeholder: "xai-…", keyUrl: "https://console.x.ai/" },
  { id: "deepseek", name: "DeepSeek", detail: "DeepSeek chat and reasoner models.", placeholder: "sk-…", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "groq", name: "Groq", detail: "Open models on fast inference hardware.", placeholder: "gsk_…", keyUrl: "https://console.groq.com/keys" },
  { id: "mistral", name: "Mistral", detail: "Mistral and Codestral models.", keyUrl: "https://console.mistral.ai/api-keys" },
  { id: "nvidia", name: "NVIDIA NIM", detail: "Open models such as Kimi, GLM and Nemotron, hosted by NVIDIA.", placeholder: "nvapi-…", keyUrl: "https://build.nvidia.com/settings/api-keys" },
  { id: "ollama", name: "Ollama", detail: "Models running on this Mac. No key needed.", local: true, defaultUrl: "http://localhost:11434/v1" },
  { id: "lmstudio", name: "LM Studio", detail: "Models served by LM Studio on this Mac. No key needed.", local: true, defaultUrl: "http://localhost:1234/v1" },
  { id: "custom", name: "Custom endpoint", detail: "Any OpenAI-compatible API, such as a company gateway or vLLM.", custom: true, placeholder: "API key" },
];

export const PROVIDER_IDS = PROVIDERS.map((provider) => provider.id);
