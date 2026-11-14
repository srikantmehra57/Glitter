import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { resetStore, seedStore } from "../test/store";
import { ModelEditDialog } from "./ModelEditDialog";
import type { UserModelEntry } from "../lib/types";

const PROVIDERS = [
  { id: "custom-1", name: "Work gateway", detail: "", custom: true },
  { id: "anthropic", name: "Anthropic", detail: "" },
];

describe("model edit dialog", () => {
  beforeEach(() => {
    resetStore();
  });

  it("adds a model with the provider's reported details filled in from the suggestion", async () => {
    const fetchProviderModels = vi.fn(async () => [
      { modelId: "zai/glm-5.3", providerId: "custom-1", displayLabel: "GLM 5.3", contextLimit: 200000, reasoningEfforts: ["low", "high"] as UserModelEntry["efforts"], defaultReasoningEffort: "high" as const, images: true, cost: { input: "3", output: "15", currency: "USD" } },
    ]);
    const putModelEntry = vi.fn(async () => {});
    seedStore({ fetchProviderModels, putModelEntry });
    const onClose = vi.fn();
    render(<ModelEditDialog request={{ entry: null }} providers={PROVIDERS} onClose={onClose} />);

    // The dialog lists the provider's own models as suggestions.
    const suggestion = await screen.findByRole("button", { name: /GLM 5.3/ });
    fireEvent.click(suggestion);
    expect(screen.getByLabelText("Model")).toHaveValue("glm-5.3");
    expect(screen.getByLabelText("Name in the picker (optional)")).toHaveValue("GLM 5.3");
    expect(screen.getByLabelText(/Context window/)).toHaveValue("200000");
    expect(screen.getByRole("button", { name: /^High \(default\)$/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Low$/ })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    await vi.waitFor(() => expect(putModelEntry).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "custom-1",
      model: "glm-5.3",
      displayName: "GLM 5.3",
      contextWindow: 200000,
      efforts: ["low", "high"],
      defaultEffort: "high",
      effortSource: "fetched",
    })));
    expect(onClose).toHaveBeenCalled();
  });

  it("edits a model's own metadata: context window, effort levels and modalities", async () => {
    const putModelEntry = vi.fn(async () => {});
    seedStore({ putModelEntry });
    const entry: UserModelEntry = {
      providerId: "anthropic", model: "claude-x", displayName: "Claude X",
      contextWindow: 200000, efforts: ["low", "high"], defaultEffort: "high",
      images: true, documents: null, video: null, source: "user", addedAt: "2026-01-01T00:00:00Z",
    };
    render(<ModelEditDialog request={{ entry }} providers={PROVIDERS} onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Edit model" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Context window/), { target: { value: "1000000" } });
    // Removing the default level clears it; a new one can be picked after.
    fireEvent.click(screen.getByRole("button", { name: /^High \(default\)$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Low$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Max$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Document support" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "Document support" })).getByRole("option", { name: "Not supported" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await vi.waitFor(() => expect(putModelEntry).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "anthropic",
      model: "claude-x",
      contextWindow: 1000000,
      efforts: ["high", "max"],
      effortSource: "user",
      documents: false,
    })));
  });

  it("refuses a model id with whitespace and a context window that is not a number", async () => {
    const putModelEntry = vi.fn(async () => {});
    seedStore({ putModelEntry });
    render(<ModelEditDialog request={{ entry: null }} providers={PROVIDERS} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "two words" } });
    expect(screen.getByRole("button", { name: "Add model" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "ok-model" } });
    expect(screen.getByRole("button", { name: "Add model" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/Context window/), { target: { value: "abc" } });
    expect(screen.getByRole("button", { name: "Add model" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    await vi.waitFor(() => expect(putModelEntry).toHaveBeenCalledWith(expect.objectContaining({ model: "ok-model", contextWindow: null })));
  });
});
