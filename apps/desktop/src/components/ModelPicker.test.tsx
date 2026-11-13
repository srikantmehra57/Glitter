import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ModelPicker, modelKey } from "./ModelPicker";
import type { Model } from "../lib/types";

it("selects the declared Grok 4.7 Fast id and retains its pricing note", () => {
  const models = [{ modelId: "xai/grok-4.7", providerId: "xai", displayLabel: "Grok 4.7" }, { modelId: "xai/grok-4.7-build-fast", providerId: "xai", displayLabel: "Grok 4.7 Fast", description: "Fast variant. 2x the price." }];
  const onChange = vi.fn();
  render(<ModelPicker models={models} loading={false} disabled={false} onChange={onChange} value={modelKey(models[0])} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: /Grok 4.7 Fast/ }));
  expect(onChange).toHaveBeenCalledWith(models[1]);
});

it("shows an unknown output price without treating the model as free", () => {
  const models: Model[] = [{ modelId: "openai/partial-price", providerId: "openai", cost: { input: "0" } }];
  render(<ModelPicker models={models} loading={false} disabled={false} onChange={vi.fn()} value={modelKey(models[0])} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const option = screen.getByRole("option");
  expect(option).toHaveTextContent("$0 in");
  expect(option).toHaveTextContent("— out");
  expect(option).not.toHaveTextContent("Free");
});

it("opens straight to the models in one click, and one click on a row picks it and closes", () => {
  const models: Model[] = [{ modelId: "xai/grok-4.7", providerId: "xai", reasoningEfforts: ["low", "high"] }, { modelId: "xai/grok-4.6", providerId: "xai" }];
  const onChange = vi.fn();
  render(<ModelPicker models={models} value={modelKey(models[0])} loading={false} disabled={false} onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "Model" });
  expect(trigger).toHaveTextContent("Grok 4.7");
  expect(trigger).not.toHaveTextContent(/High|Low/);
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Choose a model" })).toBeInTheDocument();
  expect(screen.queryByRole("slider")).toBeNull();
  expect(screen.getByRole("option", { name: /Grok 4.7/, selected: true })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("option", { name: /Grok 4.6/ }));
  expect(onChange).toHaveBeenCalledWith(models[1]);
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(trigger).toHaveFocus();
});

it("searches humanized model names and says when nothing matches", () => {
  const models: Model[] = [{ modelId: "xai/grok-4.7", providerId: "xai" }, { modelId: "xai/grok-4.6", providerId: "xai" }, ...Array.from({ length: 5 }, (_, index) => ({ modelId: `xai/other-${index}`, providerId: "xai" }))];
  render(<ModelPicker models={models} value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const input = screen.getByRole("combobox", { name: "Search models" });
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "Grok 4.7" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.change(input, { target: { value: "absent" } });
  expect(screen.getByText("No models match “absent”.")).toBeInTheDocument();
});

it("restores trigger focus when Escape or Tab dismisses it", () => {
  const models = [{ modelId: "anthropic/claude-sonnet", providerId: "anthropic", displayLabel: "Claude Sonnet" }];
  render(<ModelPicker models={models} value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Model" });
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("option"), { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(trigger);
  const close = screen.getByRole("button", { name: "Close model picker" });
  fireEvent.keyDown(screen.getByRole("option"), { key: "Tab", shiftKey: true });
  expect(close).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("option"), { key: "Tab" });
  expect(trigger).toHaveFocus();
});

it("locks model selection while a change applies", () => {
  const models = [{ modelId: "anthropic/claude-sonnet", providerId: "anthropic", displayLabel: "Claude Sonnet" }];
  render(<ModelPicker models={models} value={modelKey(models[0])} loading={false} disabled={false} applying onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("option")).toBeDisabled();
});

it("restores model focus when a provider switch unlocks the loaded catalog", () => {
  const models = [{ modelId: "xai/grok-4.7", providerId: "xai" }];
  const props = { models, value: modelKey(models[0]), loading: false, onChange: vi.fn() };
  const view = render(<ModelPicker {...props} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("option")).toHaveFocus();
  view.rerender(<ModelPicker {...props} disabled />);
  screen.getByRole("option").blur();
  view.rerender(<ModelPicker {...props} disabled={false} />);
  expect(screen.getByRole("option")).toHaveFocus();
});

it("points an empty catalog at Providers", () => {
  const onManageProviders = vi.fn();
  render(<ModelPicker models={[]} loading={false} disabled={false} onChange={vi.fn()} onManageProviders={onManageProviders} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByText("No models yet. Add a provider key to see its models.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Manage providers" }));
  expect(onManageProviders).toHaveBeenCalled();
});

it("lists each Harness provider as a provider of its own, with no Harness row over them", () => {
  const models: Model[] = [
    { modelId: "anthropic/claude-sonnet", providerId: "anthropic", displayLabel: "Claude Sonnet" },
    { modelId: "openai/gpt-5", providerId: "openai", displayLabel: "GPT-5" },
    { modelId: "xai/grok-4", providerId: "xai", displayLabel: "Grok 4" },
  ];
  render(<ModelPicker models={models} value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} onRescan={async () => {}} />);
  const trigger = screen.getByRole("button", { name: "Model" });
  expect(trigger.querySelector(".agent-mark.harness")).toBeNull();
  expect(trigger.querySelector(".agent-mark.anthropic")).not.toBeNull();
  fireEvent.click(trigger);
  expect(screen.queryByRole("tab", { name: "Harness" })).toBeNull();
  const providers = screen.getByRole("tablist", { name: "Providers" });
  expect([...providers.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute("aria-label"))).toEqual(["Anthropic", "OpenAI", "xAI"]);
  expect(screen.getByRole("tab", { name: "Anthropic" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("option", { name: /Claude Sonnet/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /GPT-5/ })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "OpenAI" }));
  expect(screen.getByRole("tab", { name: "OpenAI" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("option", { name: /GPT-5/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Claude Sonnet/ })).toBeNull();
});

it("leaves switched-off models out, except the one the thread uses, and links to them", () => {
  const models: Model[] = [
    { modelId: "anthropic/claude-sonnet", providerId: "anthropic", displayLabel: "Claude Sonnet" },
    { modelId: "anthropic/claude-haiku", providerId: "anthropic", displayLabel: "Claude Haiku" },
    { modelId: "anthropic/claude-opus", providerId: "anthropic", displayLabel: "Claude Opus" },
  ];
  const onManageModels = vi.fn();
  const hidden = ["harness|anthropic|anthropic/claude-sonnet", "harness|anthropic|anthropic/claude-haiku"];
  render(<ModelPicker models={models} value={modelKey(models[0])} hidden={hidden} loading={false} disabled={false} onChange={vi.fn()} onManageModels={onManageModels} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getAllByRole("option").map((option) => option.querySelector(".model-label")?.textContent)).toEqual(["Claude Sonnet", "Claude Opus"]);
  fireEvent.click(screen.getByRole("button", { name: "1 hidden" }));
  expect(onManageModels).toHaveBeenCalled();
});

it("shows the provider logo on the source and the model logo beside the name", () => {
  const models: Model[] = [
    { modelId: "nvidia/google/codegemma-7b", providerId: "nvidia", displayLabel: "google/codegemma-7b" },
    { modelId: "nvidia/adept/fuyu-8b", providerId: "nvidia", displayLabel: "adept/fuyu-8b" },
    { modelId: "openai/gpt-5", providerId: "openai", displayLabel: "GPT-5" },
  ];
  render(<ModelPicker models={models} value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} onRescan={async () => {}} />);
  const trigger = screen.getByRole("button", { name: "Model" });
  expect(trigger.querySelector(".agent-mark.nvidia img")).toHaveAttribute("src", "/brands/nvidia.svg");
  expect(trigger.querySelector(".agent-mark.gemma img")).toHaveAttribute("src", "/brands/gemma.svg");
  fireEvent.click(trigger);
  expect(screen.getByRole("tab", { name: "NVIDIA NIM" }).querySelector("img")).toHaveAttribute("src", "/brands/nvidia.svg");
  const gemma = screen.getByRole("option", { name: /google\/codegemma-7b/ });
  expect(gemma.querySelector("img")).toHaveAttribute("src", "/brands/gemma.svg");
  const adept = screen.getByRole("option", { name: /adept\/fuyu-8b/ });
  expect(adept.querySelector("img")).toBeNull();
  expect(adept.querySelector(".agent-mark")).toHaveTextContent("Ad");
  fireEvent.click(screen.getByRole("tab", { name: "OpenAI" }));
  expect(screen.getByRole("option", { name: /GPT-5/ }).querySelector("img")).toHaveAttribute("src", "/brands/openai.svg");
});

it("lists a fast variant as its own row, tagged Fast, and marks it on the trigger when chosen", () => {
  const models: Model[] = [
    { modelId: "xai/grok-4.7", displayLabel: "Grok 4.7", providerId: "xai" },
    { modelId: "xai/grok-4.7-build-fast", displayLabel: "Grok 4.7 Fast", providerId: "xai" },
  ];
  const onChange = vi.fn();
  const view = render(<ModelPicker models={models} value={modelKey(models[0])} loading={false} disabled={false} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const fast = screen.getByRole("option", { name: /Grok 4.7 Fast/ });
  expect(fast).toHaveTextContent("Fast");
  fireEvent.click(fast);
  expect(onChange).toHaveBeenCalledWith(models[1]);
  view.rerender(<ModelPicker models={models} value={modelKey(models[1])} loading={false} disabled={false} onChange={onChange} />);
  expect(screen.getByLabelText("Fast")).toBeInTheDocument();
});

it("leaves a provider switched off, or with every model off, out of the rail unless the thread uses it", () => {
  const models: Model[] = [
    { modelId: "anthropic/claude-sonnet", providerId: "anthropic", displayLabel: "Claude Sonnet" },
    { modelId: "openai/gpt-5", providerId: "openai", displayLabel: "GPT-5" },
    { modelId: "kilo/auto", providerId: "kilo", displayLabel: "Auto" },
  ];
  const { rerender } = render(<ModelPicker models={models} value={modelKey(models[0])} hidden={["harness|kilo|kilo/auto"]} hiddenProviders={["harness:openai"]} loading={false} disabled={false} onChange={vi.fn()} onRescan={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(["Anthropic"]);
  rerender(<ModelPicker models={models} value={modelKey(models[0])} hiddenProviders={["harness:anthropic"]} loading={false} disabled={false} onChange={vi.fn()} onRescan={async () => {}} />);
  // The provider the thread's model comes from stays, even when it is switched off.
  expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(["Anthropic", "OpenAI", "Kilo API"]);
});

const ORCHESTRATOR = { goal: "balanced" as const, models: { lead: { modelId: "anthropic/claude-opus" }, builder: { modelId: "anthropic/claude-haiku" } } };

it("offers the Orchestrator row only where a thread can use it", () => {
  const models: Model[] = [{ modelId: "anthropic/claude-sonnet", providerId: "anthropic" }];
  const props = { models, value: modelKey(models[0]), loading: false, disabled: false, onChange: vi.fn() };
  const view = render(<ModelPicker {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.queryByRole("switch", { name: /Orchestrator/ })).toBeNull();
  view.unmount();
  render(<ModelPicker {...props} onOrchestratorChange={vi.fn()} orchestratorReady />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("switch", { name: /Orchestrator/ })).toHaveAttribute("aria-checked", "false");
});

it("switches Orchestrator on and off with one click, and closes", () => {
  const models: Model[] = [{ modelId: "anthropic/claude-sonnet", providerId: "anthropic" }];
  const onOrchestratorChange = vi.fn();
  const props = { models, value: modelKey(models[0]), loading: false, disabled: false, onChange: vi.fn(), orchestratorReady: true, onOrchestratorChange };
  const view = render(<ModelPicker {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("switch", { name: /Orchestrator/ }));
  expect(onOrchestratorChange).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute("aria-expanded", "false");
  view.rerender(<ModelPicker {...props} orchestrator={ORCHESTRATOR} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const on = screen.getByRole("switch", { name: /Orchestrator/ });
  expect(on).toHaveAttribute("aria-checked", "true");
  expect(on).toHaveTextContent("Balanced");
  fireEvent.click(on);
  expect(onOrchestratorChange).toHaveBeenLastCalledWith(false);
});

it.each([0, 1])("selects manual model %i while Orchestrator is on, even when already selected", (index) => {
  const models: Model[] = [{ modelId: "anthropic/claude-sonnet", providerId: "anthropic" }, { modelId: "anthropic/claude-haiku", providerId: "anthropic" }];
  const onChange = vi.fn();
  render(<ModelPicker models={models} value={modelKey(models[0])} loading={false} disabled={false} onChange={onChange} orchestrator={ORCHESTRATOR} onOrchestratorChange={vi.fn()} orchestratorReady />);
  const trigger = screen.getByRole("button", { name: "Model" });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { selected: index === 0 }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith(models[index]);
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(trigger).toHaveFocus();
});

it("does not reapply the selected model when Orchestrator is off", () => {
  const model: Model = { modelId: "anthropic/claude-sonnet", providerId: "anthropic" };
  const onChange = vi.fn();
  render(<ModelPicker models={[model]} value={modelKey(model)} loading={false} disabled={false} onChange={onChange} orchestrator={null} onOrchestratorChange={vi.fn()} orchestratorReady />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { selected: true }));
  expect(onChange).not.toHaveBeenCalled();
});

it("reads Orchestrator on the trigger, with the goal and without a manual model mark", () => {
  const models: Model[] = [{ modelId: "anthropic/claude-sonnet-fast", providerId: "anthropic", displayLabel: "Claude Sonnet Fast" }];
  render(<ModelPicker models={models} value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} orchestrator={{ ...ORCHESTRATOR, goal: "output" }} onOrchestratorChange={vi.fn()} orchestratorReady />);
  const trigger = screen.getByRole("button", { name: "Model" });
  expect(trigger).toHaveTextContent("Orchestrator");
  expect(trigger).not.toHaveTextContent("Claude Sonnet");
  expect(trigger).toHaveAccessibleDescription("Orchestrator · Optimize for output");
  expect(trigger.querySelector(".model-fast")).toBeNull();
});

it("leads to Settings instead of switching while the roles are incomplete", () => {
  const models: Model[] = [{ modelId: "anthropic/claude-sonnet", providerId: "anthropic" }];
  const onOrchestratorChange = vi.fn();
  const onManageOrchestrator = vi.fn();
  render(<ModelPicker models={models} value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} onOrchestratorChange={onOrchestratorChange} onManageOrchestrator={onManageOrchestrator} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const row = screen.getByRole("switch", { name: /Orchestrator/ });
  expect(row).toHaveTextContent("Set up");
  expect(row).toHaveTextContent("Choose a Lead and a Builder in Settings first");
  fireEvent.click(row);
  expect(onManageOrchestrator).toHaveBeenCalledTimes(1);
  expect(onOrchestratorChange).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute("aria-expanded", "false");
});

it("keeps the Orchestrator row out of a search and locked while a change applies", () => {
  const models: Model[] = Array.from({ length: 7 }, (_, index) => ({ modelId: `anthropic/claude-${index}`, providerId: "anthropic" }));
  const props = { models, value: modelKey(models[0]), loading: false, onChange: vi.fn(), orchestratorReady: true, onOrchestratorChange: vi.fn() };
  const view = render(<ModelPicker {...props} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Search models" }), { target: { value: "claude" } });
  expect(screen.queryByRole("switch", { name: /Orchestrator/ })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Search models" }), { target: { value: "" } });
  view.rerender(<ModelPicker {...props} disabled={false} applying />);
  expect(screen.getByRole("switch", { name: /Orchestrator/ })).toBeDisabled();
});

it("shows each provider as an icon, named by its label and a floating tip", () => {
  const models: Model[] = [{ modelId: "anthropic/claude-sonnet", providerId: "anthropic", displayLabel: "Claude Sonnet" }, { modelId: "openai/gpt-5", providerId: "openai", displayLabel: "GPT-5" }];
  render(<ModelPicker models={models} value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} onRescan={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const openai = screen.getByRole("tab", { name: "OpenAI" });
  expect(openai).not.toHaveTextContent("OpenAI");
  fireEvent.mouseEnter(openai);
  expect(document.querySelector(".rail-tip")).toHaveTextContent("OpenAI");
  fireEvent.mouseLeave(openai);
  expect(document.querySelector(".rail-tip")).toBeNull();
});
