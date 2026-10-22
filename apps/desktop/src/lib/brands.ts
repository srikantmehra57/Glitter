import type { AgentId } from "./types";

/**
 * Logos for providers and model families. Files in `public/brands/` are avatar
 * plates made from Lobe Icons (MIT); Grok, Gemini and Qwen reuse the agent marks
 * already in `public/agents/`. A family we have no logo for keeps a short letter.
 */

export type BrandMark =
  | { slug: string; tone: string }
  | { glyph: string; tone: string };

const PROVIDER_SLUG: Record<string, string> = {
  anthropic: "claude",
  openai: "openai",
  google: "gemini",
  openrouter: "openrouter",
  cline: "cline",
  xai: "grok",
  deepseek: "deepseek",
  groq: "groq",
  mistral: "mistral",
  nvidia: "nvidia",
  ollama: "ollama",
  lmstudio: "lmstudio",
};

const PROVIDER_GLYPH: Record<string, { glyph: string; tone: string }> = {
  anthropic: { glyph: "A", tone: "anthropic" },
  openai: { glyph: "OA", tone: "openai" },
  google: { glyph: "Ge", tone: "gemini" },
  openrouter: { glyph: "OR", tone: "openrouter" },
  cline: { glyph: "Cl", tone: "cline" },
  xai: { glyph: "x", tone: "xai" },
  deepseek: { glyph: "D", tone: "deepseek" },
  groq: { glyph: "Gr", tone: "groq" },
  mistral: { glyph: "Mi", tone: "mistral" },
  nvidia: { glyph: "N", tone: "nvidia" },
  ollama: { glyph: "Ol", tone: "ollama" },
  lmstudio: { glyph: "LM", tone: "lmstudio" },
  custom: { glyph: "C", tone: "custom" },
};

/** More specific families first, so codegemma is Gemma and not Google. */
const MODEL_SLUGS: Array<[RegExp, string]> = [
  [/claude/, "claude"],
  [/gemini/, "gemini"],
  [/codegemma|gemma/, "gemma"],
  [/(^|[/-])gpt([-.]|$)|gpt-oss|openai|codex|(^|[/-])o[134]([.-]|$)/, "openai"],
  [/grok/, "grok"],
  [/deepseek/, "deepseek"],
  [/mistral|mixtral|codestral|pixtral|ministral|magistral|devstral|voxtral/, "mistral"],
  [/qwen|qwq|qvq/, "qwen"],
  [/llama|(^|[/-])meta([/-]|$)/, "meta"],
  [/kimi|moonshot/, "kimi"],
  [/(^|[/-])glm([.-]|$)|(^|[/-])z-?ai([/-]|$)|chatglm/, "zai"],
  [/nemotron|(^|[/-])nvidia([/-]|$)/, "nvidia"],
  [/(^|[/-])yi([.-]|$)|01[-.]?ai|zeroone/, "yi"],
  [/jamba|ai21/, "ai21"],
  [/dbrx|databricks/, "dbrx"],
  [/(^|[/-])phi([.-]|$)|microsoft/, "microsoft"],
  [/cohere|(^|[/-])command([.-]|$)/, "cohere"],
  [/internlm|internvl/, "internlm"],
  [/minimax/, "minimax"],
  [/perplexity|(^|[/-])sonar|pplx/, "perplexity"],
  [/huggingface|(^|[/-])hf([/-]|$)/, "huggingface"],
  [/snowflake|arctic/, "snowflake"],
  [/granite|(^|[/-])ibm([/-]|$)/, "ibm"],
  [/falcon|(^|[/-])tii([/-]|$)/, "tii"],
  [/nous|hermes/, "nous"],
  [/(^|[/-])bge-|baai/, "baai"],
  [/upstage|(^|[/-])solar([.-]|$)/, "upstage"],
  [/baichuan/, "baichuan"],
  [/(^|[/-])olmo|allenai|(^|[/-])ai2([/-]|$)/, "ai2"],
  [/stepfun|(^|[/-])step-/, "stepfun"],
  [/stable-diffusion|stabilityai|(^|[/-])sdxl/, "stability"],
  [/flux/, "flux"],
  [/exaone|(^|[/-])lgai/, "lg"],
  [/openchat/, "openchat"],
  [/arcee|(^|[/-])trinity-/, "arcee"],
  [/google/, "google"],
];

const AGENT_SLUG: Partial<Record<AgentId, string>> = {
  grok: "grok",
  gemini: "gemini",
  qwen: "qwen",
};

export function brandSrc(slug: string): string {
  if (slug === "grok" || slug === "gemini" || slug === "qwen") return `/agents/${slug}.svg`;
  return `/brands/${slug}.svg`;
}

export function providerSlug(id?: string): string | undefined {
  return id ? PROVIDER_SLUG[id] : undefined;
}

/** The logo already shown for this agent or provider, so the chip does not repeat it. */
export function leadingBrandSlug(agentId?: AgentId, providerId?: string): string | undefined {
  return providerSlug(providerId) ?? (agentId ? AGENT_SLUG[agentId] : undefined);
}

export function providerBrand(id: string): BrandMark {
  const known = PROVIDER_GLYPH[id];
  const tone = known?.tone ?? "custom";
  const slug = PROVIDER_SLUG[id];
  if (slug) return { slug, tone };
  // A lab an agent's catalog names (`upstage/…`, `meta/…`) wears its family logo when there is one.
  const family = known ? undefined : MODEL_SLUGS.find(([pattern]) => pattern.test(`${id.toLowerCase()}/`))?.[1];
  if (family) return { slug: family, tone: family };
  return { glyph: known?.glyph ?? id.slice(0, 1).toUpperCase(), tone };
}

/** The id with one leading provider prefix removed (`nvidia/google/gemma` → `google/gemma`). */
function modelRest(modelId: string, providerId?: string): string {
  let rest = modelId.trim();
  if (providerId) {
    const prefix = `${providerId}/`;
    if (rest.toLowerCase().startsWith(prefix.toLowerCase())) rest = rest.slice(prefix.length);
  }
  return rest.replace(/^~/, "").toLowerCase();
}

function orgGlyph(org: string): string {
  const clean = org.replace(/[^a-z0-9]/gi, "");
  if (!clean) return org.slice(0, 1).toUpperCase() || "?";
  if (/[0-9]/.test(clean[0] ?? "")) return clean.slice(0, 2);
  return (clean[0] ?? "").toUpperCase() + (clean[1] ?? "").toLowerCase();
}

/**
 * The model's own family when we know it (Gemma, DeepSeek, Yi), else a letter
 * for the lab prefix (`adept/fuyu` → Ad). A bare id with no family and no lab
 * prefix has nothing extra to show.
 */
export function modelBrand(modelId: string, providerId?: string): BrandMark | null {
  const rest = modelRest(modelId, providerId);
  if (!rest) return null;
  for (const [pattern, slug] of MODEL_SLUGS) {
    if (pattern.test(rest)) return { slug, tone: slug };
  }
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return { glyph: orgGlyph(rest.slice(0, slash)), tone: "custom" };
}
