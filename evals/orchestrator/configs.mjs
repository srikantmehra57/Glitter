import { readFileSync } from "node:fs";

/**
 * Model and credential setup for the evaluation runner. Models are supplied by
 * environment so the corpus never hard-codes providers or prices. Prices are
 * USD per 1M tokens; an unknown price makes the report's cost partial.
 */

const PROVIDER_ENV = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  cline: ["CLINE_API_KEY"],
  kilo: ["KILO_API_KEY"],
};

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio"]);

export function modelRef(modelId) {
  const text = typeof modelId === "string" ? modelId.trim() : "";
  const slash = text.indexOf("/");
  if (slash < 1 || slash === text.length - 1) throw new Error(`Model id must be provider/model: ${JSON.stringify(modelId)}`);
  return { providerId: text.slice(0, slash), modelId: text };
}

export function providerOf(modelId) {
  return modelRef(modelId).providerId;
}

export function isLocalProvider(providerId) {
  return LOCAL_PROVIDERS.has(providerId);
}

export function credentialsFromEnv(env = process.env) {
  const credentials = {};
  for (const [providerId, names] of Object.entries(PROVIDER_ENV)) {
    const key = names.map((name) => env[name]).find((value) => value?.trim());
    if (key) credentials[providerId] = { key: key.trim() };
  }
  // The host treats an absent provider as unconfigured, so keyless local
  // providers still need an entry; resolveProvider accepts an empty key for them.
  for (const providerId of LOCAL_PROVIDERS) credentials[providerId] ??= { key: "" };
  return credentials;
}

export function buildConfigs(env = process.env) {
  const lead = env.EVAL_LEAD_MODEL?.trim();
  const builder = env.EVAL_BUILDER_MODEL?.trim();
  const small = env.EVAL_SMALL_MODEL?.trim() || builder;
  const router = env.EVAL_ROUTER_MODEL?.trim() || small;
  const configs = {};
  if (lead && builder) {
    for (const goal of ["cost", "balanced", "output"]) {
      configs[`orchestrator-${goal}`] = {
        kind: "orchestrator",
        goal,
        models: { lead: modelRef(lead), builder: modelRef(builder), small: modelRef(small), router: modelRef(router) },
      };
    }
  }
  if (lead) configs["lead-alone"] = { kind: "manual", modelId: lead };
  if (builder) configs["builder-alone"] = { kind: "manual", modelId: builder };
  if (env.EVAL_SMALL_MODEL?.trim()) configs["small-alone"] = { kind: "manual", modelId: env.EVAL_SMALL_MODEL.trim() };
  return configs;
}

export function requiredProviders(configs) {
  const providers = new Set();
  for (const config of Object.values(configs)) {
    if (config.kind === "manual") {
      providers.add(providerOf(config.modelId));
    } else {
      for (const model of Object.values(config.models)) providers.add(model.providerId);
    }
  }
  return providers;
}

/** Providers that have neither a key nor a keyless local endpoint. */
export function missingCredentials(configs, credentials) {
  return [...requiredProviders(configs)].filter((providerId) => !isLocalProvider(providerId) && !credentials[providerId]?.key);
}

function validPrice(value) {
  return value && typeof value === "object" && Number.isFinite(value.input) && value.input >= 0 && Number.isFinite(value.output) && value.output >= 0;
}

/** Read `EVAL_PRICES` as JSON or a path; otherwise a local prices.json. */
export function loadPrices(env = process.env) {
  let raw = env.EVAL_PRICES?.trim();
  if (!raw) {
    try { raw = readFileSync(new URL("./prices.json", import.meta.url), "utf8"); } catch { return {}; }
  } else if (!raw.startsWith("{")) {
    raw = readFileSync(raw, "utf8");
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("EVAL_PRICES must be a JSON object or a path to one."); }
  const prices = {};
  for (const [modelId, price] of Object.entries(parsed)) {
    if (validPrice(price)) prices[modelId] = { input: price.input, output: price.output, ...(Number.isFinite(price.cached) ? { cached: price.cached } : {}) };
  }
  return prices;
}

export function costOf(calls, prices) {
  let usd = 0;
  let partial = false;
  for (const call of calls) {
    if (!call.modelId) { partial = true; continue; }
    const price = prices[call.modelId];
    if (!price) {
      if (!isLocalProvider(providerOf(call.modelId))) partial = true;
      continue;
    }
    usd += ((call.inputTokens ?? 0) / 1_000_000) * price.input + ((call.outputTokens ?? 0) / 1_000_000) * price.output;
  }
  return { usd, partial };
}
