import { effortTiers, isCustomProvider, type Tier } from "./providers.js";

/**
 * What the harness knows about one resolved model. A null value is an explicit
 * unknown: the catalog did not say, and no tested family override applies.
 * Provider quirks stay here so the turn loop does not grow model-name checks.
 */
export type CapabilitySource = "catalog" | "family" | "unknown";

export type Capability<T> = { value: T | null; source: CapabilitySource };

export type ModelCapabilities = {
  /** Input window, in tokens. */
  context: Capability<number>;
  /** Maximum completion tokens the wire will request. */
  output: Capability<number>;
  /** Whether a turn may send the harness tools. */
  tools: Capability<boolean>;
  /** Whether a request may include images. */
  images: Capability<boolean>;
  /** Effort levels the model accepts. Empty means no reasoning control. */
  reasoning: { tiers: readonly Tier[]; source: CapabilitySource };
  /** Whether the stream is asked to include usage. */
  streamingUsage: Capability<boolean>;
  /** Whether the wire may set a prompt-cache breakpoint. */
  cache: Capability<boolean>;
};

const OUTPUT_TOKENS = 32_000;
/** Claude 3.0 and 3.5 cap output below the current families. 3.7 does not. */
const SMALL_OUTPUT_TOKENS = 8_192;

/** Providers whose Chat Completions streams accept `include_usage`. */
const STREAMING_USAGE = new Set(["openai", "openrouter", "xai", "deepseek", "groq", "google"]);

export function modelCapabilities(input: {
  providerId: string;
  model: string;
  wire?: "anthropic" | "openai";
  listedContext?: number | null;
  listedOutput?: number | null;
  listedTools?: boolean | null;
  listedImages?: boolean | null;
  listedReasoning?: boolean;
  listedEfforts?: readonly string[];
}): ModelCapabilities {
  const wire = input.wire ?? (input.providerId === "anthropic" ? "anthropic" : "openai");
  const tiers = effortTiers(input.providerId, input.model, wire, input.listedReasoning, input.listedEfforts);
  return {
    context: contextCapability(input.providerId, input.model, input.listedContext),
    output: outputCapability(input.model, wire, input.listedOutput),
    tools: booleanCapability(input.listedTools, true),
    images: imageCapability(input.providerId, input.model, wire, input.listedImages),
    reasoning: { tiers, source: input.listedEfforts ? "catalog" : tiers.length ? "family" : "unknown" },
    streamingUsage: streamingUsageCapability(input.providerId, wire),
    cache: wire === "anthropic" ? { value: true, source: "family" } : { value: null, source: "unknown" },
  };
}

function booleanCapability(listed: boolean | null | undefined, family: boolean): Capability<boolean> {
  if (typeof listed === "boolean") return { value: listed, source: "catalog" };
  return { value: family, source: "family" };
}

function contextCapability(providerId: string, model: string, listed?: number | null): Capability<number> {
  if (listed) return { value: listed, source: "catalog" };
  const tokens = familyContext(providerId, model);
  return tokens ? { value: tokens, source: "family" } : { value: null, source: "unknown" };
}

/** Known context windows. A gateway model is `vendor/model`; Cline and Kilo write xAI as `x-ai`. */
function familyContext(providerId: string, model: string): number | null {
  const id = model.toLowerCase();
  const slash = id.indexOf("/");
  const gateway = (providerId === "cline" || providerId === "kilo") && slash > 0;
  const vendor = (gateway ? id.slice(0, slash) : providerId).replace(/^~/, "");
  const name = gateway ? id.slice(slash + 1) : id;
  const family = vendor === "x-ai" ? "xai" : vendor;
  if (family === "anthropic") return 200_000;
  if (family === "openai") return /gpt-5/.test(name) ? 400_000 : /gpt-4\.1/.test(name) ? 1_047_576 : /^o\d/.test(name) ? 200_000 : /gpt-4o/.test(name) ? 128_000 : null;
  if (family === "google") return /gemini/.test(name) ? 1_048_576 : null;
  if (family === "xai") return /grok-4/.test(name) ? 256_000 : /grok-3/.test(name) ? 131_072 : null;
  if (family === "deepseek") return 128_000;
  return null;
}

function outputCapability(model: string, wire: "anthropic" | "openai", listed?: number | null): Capability<number> {
  if (listed) return { value: listed, source: "catalog" };
  if (wire !== "anthropic") return { value: null, source: "unknown" };
  return { value: /claude-3-(?!7)/i.test(model) ? SMALL_OUTPUT_TOKENS : OUTPUT_TOKENS, source: "family" };
}

function imageCapability(providerId: string, model: string, wire: "anthropic" | "openai", listed?: boolean | null): Capability<boolean> {
  if (typeof listed === "boolean") return { value: listed, source: "catalog" };
  const name = model.toLowerCase();
  const vision = wire === "anthropic"
    ? /claude/i.test(name)
    : providerId === "openai" ? /^(gpt-4o|gpt-4\.1|gpt-5|o\d)/.test(name)
    : providerId === "google" ? /gemini/.test(name)
    : (providerId === "cline" || providerId === "kilo") && /^(anthropic\/.*claude|openai\/(gpt-4o|gpt-4\.1|gpt-5|o\d)|google\/gemini)/.test(name);
  return vision ? { value: true, source: "family" } : { value: null, source: "unknown" };
}

/** Gaps that change how a turn can run. Empty reasoning is already visible as no effort control. */
export function capabilityGaps(caps: ModelCapabilities): string[] {
  const gaps: string[] = [];
  if (caps.context.value == null) gaps.push("an unknown context window");
  if (caps.tools.value === false) gaps.push("no tool support");
  if (caps.images.value === false) gaps.push("no image support");
  return gaps;
}

function streamingUsageCapability(providerId: string, wire: "anthropic" | "openai"): Capability<boolean> {
  if (wire === "anthropic" || STREAMING_USAGE.has(providerId) || isCustomProvider(providerId)) return { value: true, source: "family" };
  return { value: null, source: "unknown" };
}
