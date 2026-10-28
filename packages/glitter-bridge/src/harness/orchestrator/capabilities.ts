import type { OrchestratorCapability } from "./types.js";

/** A context this large is worth calling long even when the prompt is average. */
export const LONG_CONTEXT_MIN = 200_000;

/**
 * Catalog rows do not carry a vision flag, so recognizable multimodal families
 * are listed here. A false negative only routes image work to the Lead; a false
 * positive would send an image to a text-only model, which the provider then
 * rejects, so the list stays deliberately narrow.
 */
const VISION = /(?:^|\/)(?:claude(?:-|$)|gpt-(?:4o|4\.1|4-turbo|5)|o[1-9](?:-|$)|gemini|grok-(?:2-vision|[3-9])|qwen[\w.-]*vl|llama-(?:3\.2|4)|pixtral|llava|phi-[\d.]+-multimodal|internvl|minicpm-v|molmo|idefics|florence|kosmos)/i;

/**
 * The model-level capabilities the policy may assume beyond its probe. Every
 * catalog row is a chat model the harness offers, and tool use is the one
 * capability a role's probe verifies separately; vision and a long window come
 * from the model itself.
 */
export function catalogCapabilities(input: { modelId: string; contextLimit?: number | null }): OrchestratorCapability[] {
  return [
    "tools",
    ...(typeof input.contextLimit === "number" && input.contextLimit >= LONG_CONTEXT_MIN ? ["long_context" as const] : []),
    ...(VISION.test(input.modelId) ? ["vision" as const] : []),
  ];
}
