/**
 * The model providers the built-in harness can use, as Settings shows them.
 * The bridge (`packages/muse-bridge/src/harness/providers.ts`) holds the wire
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
};

export const PROVIDERS: ProviderEntry[] = [
  { id: "anthropic", name: "Anthropic", detail: "Claude models, with extended thinking for effort levels.", placeholder: "sk-ant-…" },
  { id: "openai", name: "OpenAI", detail: "GPT and reasoning models.", placeholder: "sk-…" },
  { id: "google", name: "Google Gemini", detail: "Gemini models, with a key from Google AI Studio.", placeholder: "AIza…" },
  { id: "openrouter", name: "OpenRouter", detail: "Hundreds of models from many labs behind one key.", placeholder: "sk-or-…" },
  { id: "xai", name: "xAI", detail: "Grok models through the xAI API.", placeholder: "xai-…" },
  { id: "deepseek", name: "DeepSeek", detail: "DeepSeek chat and reasoner models.", placeholder: "sk-…" },
  { id: "groq", name: "Groq", detail: "Open models on fast inference hardware.", placeholder: "gsk_…" },
  { id: "mistral", name: "Mistral", detail: "Mistral and Codestral models." },
  { id: "ollama", name: "Ollama", detail: "Models running on this Mac. No key needed.", local: true, defaultUrl: "http://localhost:11434/v1" },
  { id: "lmstudio", name: "LM Studio", detail: "Models served by LM Studio on this Mac. No key needed.", local: true, defaultUrl: "http://localhost:1234/v1" },
  { id: "custom", name: "Custom endpoint", detail: "Any OpenAI-compatible API, such as a company gateway or vLLM.", custom: true, placeholder: "API key" },
];

export const PROVIDER_IDS = PROVIDERS.map((provider) => provider.id);
