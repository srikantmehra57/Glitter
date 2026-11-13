import { describe, expect, it } from "vitest";
import { continuationPrompt, GENERIC_CONTINUE_PROMPT, HARNESS_CONTINUE_PROMPT } from "./continuation";

describe("continuation prompts", () => {
  it("keeps an interrupted Harness turn on the recorded results", () => {
    const prompt = continuationPrompt("harness", "interrupted");
    expect(prompt).toBe(HARNESS_CONTINUE_PROMPT);
    expect(prompt).toMatch(/outcome is unknown/);
    expect(prompt).toMatch(/Do not start another delegated child/);
  });

  it("leaves other agents on the general continue prompt", () => {
    expect(continuationPrompt("muse", "interrupted")).toBe(GENERIC_CONTINUE_PROMPT);
    expect(continuationPrompt("harness", "failed")).toBe(GENERIC_CONTINUE_PROMPT);
  });
});
