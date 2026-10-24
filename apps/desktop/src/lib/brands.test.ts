import { expect, it } from "vitest";
import { brandSrc, modelBrand, providerBrand, providerSlug } from "./brands";

it("uses a real logo for each harness provider", () => {
  expect(providerSlug("nvidia")).toBe("nvidia");
  expect(providerBrand("nvidia")).toEqual({ slug: "nvidia", tone: "nvidia" });
  expect(brandSrc("nvidia")).toBe("/brands/nvidia.svg");
  expect(providerBrand("anthropic")).toEqual({ slug: "claude", tone: "anthropic" });
  expect(providerBrand("xai")).toEqual({ slug: "grok", tone: "xai" });
  expect(brandSrc("grok")).toBe("/agents/grok.svg");
  expect(providerBrand("custom")).toEqual({ glyph: "C", tone: "custom" });
});

it("picks the model family, not the host, and letters an unknown lab", () => {
  expect(modelBrand("nvidia/google/codegemma-7b", "nvidia")).toEqual({ slug: "gemma", tone: "gemma" });
  expect(modelBrand("nvidia/deepseek-ai/deepseek-v4.1-flash", "nvidia")).toEqual({ slug: "deepseek", tone: "deepseek" });
  expect(modelBrand("nvidia/01-ai/yi-large", "nvidia")).toEqual({ slug: "yi", tone: "yi" });
  expect(modelBrand("nvidia/ai21labs/jamba-1.5-large-instruct", "nvidia")).toEqual({ slug: "ai21", tone: "ai21" });
  expect(modelBrand("nvidia/databricks/dbrx-instruct", "nvidia")).toEqual({ slug: "dbrx", tone: "dbrx" });
  expect(modelBrand("nvidia/moonshotai/kimi-k2.6", "nvidia")).toEqual({ slug: "kimi", tone: "kimi" });
  expect(modelBrand("nvidia/z-ai/glm-4.5", "nvidia")).toEqual({ slug: "zai", tone: "zai" });
  expect(modelBrand("nvidia/adept/fuyu-8b", "nvidia")).toEqual({ glyph: "Ad", tone: "custom" });
  expect(modelBrand("nvidia/bigcode/starcoder2-15b", "nvidia")).toEqual({ glyph: "Bi", tone: "custom" });
  expect(modelBrand("claude-sonnet-4", "anthropic")).toEqual({ slug: "claude", tone: "claude" });
  expect(modelBrand("grok-4.7", "grok")).toEqual({ slug: "grok", tone: "grok" });
  expect(modelBrand("muse-spark-1.3", "muse")).toBeNull();
});

it("gives a lab an agent's catalog names its family logo when there is one", () => {
  expect(providerBrand("upstage")).toEqual({ slug: "upstage", tone: "upstage" });
  expect(providerBrand("meta")).toEqual({ slug: "meta", tone: "meta" });
  expect(providerBrand("poolside")).toEqual({ glyph: "P", tone: "custom" });
});

it("letters a custom endpoint from its own name, so two never look alike", () => {
  expect(providerBrand("custom-1", "Work gateway")).toEqual({ glyph: "Wo", tone: "custom" });
  expect(providerBrand("custom-2", "vLLM")).toEqual({ glyph: "Vl", tone: "custom" });
  // Without a name it falls back to a letter; a fixed provider ignores the name.
  expect(providerBrand("custom-3")).toEqual({ glyph: "C", tone: "custom" });
  expect(providerBrand("anthropic", "Work gateway")).toEqual({ slug: "claude", tone: "anthropic" });
});
