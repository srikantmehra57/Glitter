import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ModelPicker, modelKey } from "./ModelPicker";
import type { AgentInfo, Model } from "../lib/types";

it("selects the declared Grok 4.7 Fast id and retains its pricing note", () => {
  const models = [{ modelId: "grok-4.7", displayLabel: "Grok 4.7" }, { modelId: "grok-4.7-build-fast", displayLabel: "Grok 4.7 Fast", description: "Fast variant. 2x the price." }];
  const onChange = vi.fn();
  render(<ModelPicker models={models} agentId="grok" loading={false} disabled={false} onChange={onChange} value={modelKey(models[0])} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: /Grok 4.7 Fast/ }));
  expect(onChange).toHaveBeenCalledWith(models[1]);
});

it("names the contributor variant distinctly and selects its exact model while retaining its disclosure", () => {
  const models = [{ modelId: "muse-spark-1.3" }, { modelId: "muse-spark-1.3-contributor" }];
  const onChange = vi.fn();
  const props = { models, agentId: "muse" as const, loading: false, disabled: false, onChange };
  const view = render(<ModelPicker {...props} value={modelKey(models[0])} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const options = screen.getAllByRole("option");
  expect(options[0]).not.toHaveTextContent("Contributor");
  expect(options[1]).toHaveTextContent("· Contributor");
  expect(options[1]).toHaveAttribute("aria-description", expect.stringContaining("data"));
  expect(screen.getByText(/Contributor models are discounted/)).toBeInTheDocument();
  fireEvent.click(options[1]);
  expect(onChange).toHaveBeenCalledWith(models[1]);
  view.rerender(<ModelPicker {...props} value={modelKey(models[1])} />);
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("· Contributor");
});

it("keeps a model the catalog no longer lists selectable, and says why it is there", () => {
  const models = [{ modelId: "muse-wonder-1.0", isDefault: true }, { modelId: "muse-spark-1.3" }, { modelId: "muse-spark-1.3-contributor", providerId: "meta", unlisted: true }];
  render(<ModelPicker models={models} agentId="muse" loading={false} disabled={false} onChange={vi.fn()} value={modelKey(models[2])} />);
  const trigger = screen.getByRole("button", { name: "Model" });
  expect(trigger).toHaveTextContent("Muse Spark 1.3 · Contributor");
  fireEvent.click(trigger);
  const unlisted = screen.getByRole("option", { selected: true });
  expect(unlisted).toHaveTextContent("Not listed");
  expect(unlisted).toHaveAttribute("aria-description", expect.stringContaining("not in the current model list"));
  expect(screen.getByText(/Muse Spark 1.3 · Contributor is not in the current model list/)).toBeInTheDocument();
});

const AGENTS: AgentInfo[] = [
  { id: "muse", name: "Muse", protocol: "msp", found: true, authenticated: true, path: "/bin/muse", version: "1.4", verified: true, signIn: "" },
  { id: "grok", name: "Grok", protocol: "acp", found: true, path: "/bin/grok", version: "1", verified: true, signIn: "" },
  { id: "gemini", name: "Gemini CLI", protocol: "acp", found: false, path: null, version: null, verified: false, signIn: "" },
];

it("opens straight to the models in one click, and one click on a row picks it and closes", () => {
  const models: Model[] = [{ modelId: "grok-4.7", reasoningEfforts: ["low", "high"] }, { modelId: "grok-4.6" }];
  const onChange = vi.fn();
  render(<ModelPicker models={models} agentId="grok" value={modelKey(models[0])} loading={false} disabled={false} onChange={onChange} />);
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

it("lists other agents as providers, and a model from one switches the thread to it", async () => {
  const onChooseOther = vi.fn();
  const loadCatalog = vi.fn(async () => [{ modelId: "muse-spark-1.3" }] as Model[]);
  render(<ModelPicker models={[{ modelId: "grok-4.7" }]} agentId="grok" agents={AGENTS} value={modelKey({ modelId: "grok-4.7" })} loading={false} disabled={false} onChange={vi.fn()} onChooseOther={onChooseOther} loadCatalog={loadCatalog} onRescan={vi.fn(async () => {})} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  // One level of providers: no Agents section, and no agent nested over its providers.
  expect(screen.queryByRole("tablist", { name: "Agent" })).toBeNull();
  const tabs = screen.getAllByRole("tab");
  expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual(["Muse", "Grok"]);
  expect(screen.getByRole("tab", { name: "Grok" })).toHaveAttribute("aria-selected", "true");
  expect(loadCatalog).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: "Muse" }));
  expect(loadCatalog).toHaveBeenCalledWith("muse");
  const muse = await screen.findByRole("option", { name: /Muse Spark 1.3/ });
  expect(muse).toHaveAttribute("aria-description", expect.stringContaining("Switches this thread to Muse"));
  fireEvent.click(muse);
  expect(onChooseOther).toHaveBeenCalledWith("muse", { modelId: "muse-spark-1.3" });
});

it("keeps another agent's provider out of reach while the thread cannot switch", () => {
  render(<ModelPicker models={[{ modelId: "grok-4.7" }]} agentId="grok" agents={AGENTS} agentDisabled loading={false} disabled={false} onChange={vi.fn()} onChooseOther={vi.fn()} loadCatalog={vi.fn(async () => [])} onRescan={vi.fn(async () => {})} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("tab", { name: "Muse" })).toBeDisabled();
  expect(screen.getByRole("tab", { name: "Grok" })).not.toBeDisabled();
});

it("searches humanized model names and says when nothing matches", () => {
  const models: Model[] = [{ modelId: "grok-4.7" }, { modelId: "grok-4.6" }, ...Array.from({ length: 5 }, (_, index) => ({ modelId: `other-${index}` }))];
  render(<ModelPicker models={models} agentId="grok" value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const input = screen.getByRole("combobox", { name: "Search models" });
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "Grok 4.7" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.change(input, { target: { value: "absent" } });
  expect(screen.getByText("No models match “absent”.")).toBeInTheDocument();
});

it("restores trigger focus when Escape or Tab dismisses it", () => {
  const models = [{ modelId: "muse-spark-1.3" }];
  render(<ModelPicker models={models} agentId="muse" value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} />);
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
  const models = [{ modelId: "muse-spark-1.3" }];
  render(<ModelPicker models={models} agentId="muse" value={modelKey(models[0])} loading={false} disabled={false} applying onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("option")).toBeDisabled();
});

it("restores model focus when a provider switch unlocks the loaded catalog", () => {
  const models = [{ modelId: "grok-4.7" }];
  const props = { models, agentId: "grok" as const, value: modelKey(models[0]), loading: false, onChange: vi.fn() };
  const view = render(<ModelPicker {...props} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("option")).toHaveFocus();
  view.rerender(<ModelPicker {...props} disabled />);
  screen.getByRole("option").blur();
  view.rerender(<ModelPicker {...props} disabled={false} />);
  expect(screen.getByRole("option")).toHaveFocus();
});

it("leaves an empty catalog recoverable, and points the built-in harness at its providers", () => {
  const onManageProviders = vi.fn();
  const view = render(<ModelPicker models={[]} agentId="grok" loading={false} disabled={false} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByText("No models available. Rescan agents to try again.")).toBeInTheDocument();
  view.unmount();
  render(<ModelPicker models={[]} agentId="harness" loading={false} disabled={false} onChange={vi.fn()} onManageProviders={onManageProviders} />);
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
  const agents: AgentInfo[] = [
    { id: "harness", name: "Harness", protocol: "native", found: true, authenticated: true, path: null, version: null, verified: true, signIn: "" },
    { id: "grok", name: "Grok", protocol: "acp", found: true, path: "/bin/grok", version: "1", verified: true, signIn: "" },
  ];
  render(<ModelPicker models={models} agentId="harness" agents={agents} value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} onChooseOther={vi.fn()} loadCatalog={vi.fn(async () => [])} onRescan={async () => {}} />);
  const trigger = screen.getByRole("button", { name: "Model" });
  expect(trigger.querySelector(".agent-mark.harness")).toBeNull();
  expect(trigger.querySelector(".agent-mark.anthropic")).not.toBeNull();
  fireEvent.click(trigger);
  expect(screen.queryByRole("tab", { name: "Harness" })).toBeNull();
  const providers = screen.getByRole("tablist", { name: "Providers" });
  expect([...providers.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute("aria-label"))).toEqual(["Anthropic", "OpenAI", "xAI", "Grok"]);
  expect(screen.getByRole("tab", { name: "Anthropic" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("option", { name: /Claude Sonnet/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /GPT-5/ })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "OpenAI" }));
  expect(screen.getByRole("tab", { name: "OpenAI" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("option", { name: /GPT-5/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Claude Sonnet/ })).toBeNull();
});

it("keeps the Cline API provider distinct from the Cline CLI agent", () => {
  const models: Model[] = [
    { modelId: "cline/anthropic/claude-sonnet-5.5", providerId: "cline", displayLabel: "claude-sonnet-5.5", description: "Cline API" },
  ];
  const agents: AgentInfo[] = [
    { id: "harness", name: "Harness", protocol: "native", found: true, authenticated: true, path: null, version: null, verified: true, signIn: "" },
    { id: "cline", name: "Cline CLI", protocol: "acp", found: true, path: "/bin/cline", version: "1", verified: false, signIn: "" },
  ];
  render(<ModelPicker models={models} agentId="harness" agents={agents} value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} onChooseOther={vi.fn()} loadCatalog={vi.fn(async () => [])} onRescan={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("tab", { name: "Cline API" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Cline CLI" })).toHaveAttribute("aria-selected", "false");
  expect(screen.getByRole("option", { name: /claude-sonnet-5.5/ })).toBeInTheDocument();
});

it("leaves switched-off models out, except the one the thread uses, and links to them", () => {
  const models: Model[] = [
    { modelId: "anthropic/claude-sonnet", providerId: "anthropic", displayLabel: "Claude Sonnet" },
    { modelId: "anthropic/claude-haiku", providerId: "anthropic", displayLabel: "Claude Haiku" },
    { modelId: "anthropic/claude-opus", providerId: "anthropic", displayLabel: "Claude Opus" },
  ];
  const onManageModels = vi.fn();
  const hidden = ["harness|anthropic|anthropic/claude-sonnet", "harness|anthropic|anthropic/claude-haiku"];
  render(<ModelPicker models={models} agentId="harness" value={modelKey(models[0])} hidden={hidden} loading={false} disabled={false} onChange={vi.fn()} onManageModels={onManageModels} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Claude Sonnet", "Claude Opus"]);
  fireEvent.click(screen.getByRole("button", { name: "1 hidden" }));
  expect(onManageModels).toHaveBeenCalled();
});

it("shows the provider logo on the source and the model logo beside the name", () => {
  const models: Model[] = [
    { modelId: "nvidia/google/codegemma-7b", providerId: "nvidia", displayLabel: "google/codegemma-7b" },
    { modelId: "nvidia/adept/fuyu-8b", providerId: "nvidia", displayLabel: "adept/fuyu-8b" },
    { modelId: "openai/gpt-5", providerId: "openai", displayLabel: "GPT-5" },
  ];
  const agents: AgentInfo[] = [
    { id: "harness", name: "Harness", protocol: "native", found: true, authenticated: true, path: null, version: null, verified: true, signIn: "" },
  ];
  render(<ModelPicker models={models} agentId="harness" agents={agents} value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} onRescan={async () => {}} />);
  const trigger = screen.getByRole("button", { name: "Model" });
  expect(trigger.querySelector(".agent-mark.nvidia img")).toHaveAttribute("src", "/brands/nvidia.svg");
  expect(trigger.querySelector(".agent-mark.gemma img")).toHaveAttribute("src", "/brands/gemma.svg");
  fireEvent.click(trigger);
  expect(screen.getByRole("tab", { name: "NVIDIA NIM" }).querySelector("img")).toHaveAttribute("src", "/brands/nvidia.svg");
  const gemma = screen.getByRole("option", { name: "google/codegemma-7b" });
  expect(gemma.querySelector("img")).toHaveAttribute("src", "/brands/gemma.svg");
  const adept = screen.getByRole("option", { name: "adept/fuyu-8b" });
  expect(adept.querySelector("img")).toBeNull();
  expect(adept.querySelector(".agent-mark")).toHaveTextContent("Ad");
  fireEvent.click(screen.getByRole("tab", { name: "OpenAI" }));
  expect(screen.getByRole("option", { name: "GPT-5" }).querySelector("img")).toHaveAttribute("src", "/brands/openai.svg");
});

it("tags only Cline's current free models, and a search for free leaves retired ones out", () => {
  const models: Model[] = [
    { modelId: "cline-free/minimax-m3.1-flash", displayLabel: "Minimax M3.1 Flash", providerId: "cline-free", free: true },
    { modelId: "nvidia/nemotron-3.5-lightning-free", displayLabel: "Nemotron 3.5 Lightning (free)", providerId: "nvidia", free: true },
    { modelId: "nvidia/nemotron-3-ultra:free", displayLabel: "Nemotron 3 Ultra (free)", providerId: "nvidia", free: false },
    ...Array.from({ length: 4 }, (_, index) => ({ modelId: `openai/gpt-${index}`, displayLabel: `GPT ${index}`, providerId: "openai" })),
  ];
  render(<ModelPicker models={models} agentId="cline" value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const retired = screen.getByRole("option", { name: "Nemotron 3 Ultra" });
  expect(retired).not.toHaveTextContent("Free");
  expect(retired).not.toHaveTextContent("(free)");
  expect(screen.getByRole("option", { name: /Minimax M3.1 Flash/ })).toHaveTextContent("Free");
  fireEvent.change(screen.getByRole("combobox", { name: "Search models" }), { target: { value: "free" } });
  const names = screen.getAllByRole("option").map((option) => option.textContent);
  expect(names.some((name) => name?.includes("Minimax"))).toBe(true);
  expect(names.some((name) => name?.includes("Lightning"))).toBe(true);
  expect(names.some((name) => name?.includes("Ultra"))).toBe(false);
});

it("lists a fast variant as its own row, tagged Fast, and marks it on the trigger when chosen", () => {
  const models: Model[] = [
    { modelId: "grok-4.7", displayLabel: "Grok 4.7", providerId: "grok" },
    { modelId: "grok-4.7-build-fast", displayLabel: "Grok 4.7 Fast", providerId: "grok" },
  ];
  const onChange = vi.fn();
  const view = render(<ModelPicker models={models} agentId="grok" value={modelKey(models[0])} loading={false} disabled={false} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const fast = screen.getByRole("option", { name: /Grok 4.7 Fast/ });
  expect(fast).toHaveTextContent("Fast");
  fireEvent.click(fast);
  expect(onChange).toHaveBeenCalledWith(models[1]);
  view.rerender(<ModelPicker models={models} agentId="grok" value={modelKey(models[1])} loading={false} disabled={false} onChange={onChange} />);
  expect(screen.getByLabelText("Fast")).toBeInTheDocument();
});

it("groups an agent's mixed catalog by lab under one provider, and gives every row an icon", () => {
  const models: Model[] = [
    { modelId: "nvidia/nemotron-3.5-super", displayLabel: "Nemotron 3.5 Super", providerId: "nvidia", free: true },
    { modelId: "reflection/beam-1.0", displayLabel: "Beam", providerId: "reflection", free: true },
    { modelId: "anthropic/claude-haiku-5.5", displayLabel: "Claude Haiku 5.5", providerId: "anthropic", free: false },
    { modelId: "openai/gpt-6.1-sol", displayLabel: "GPT-6.1 Sol", providerId: "openai", free: false },
    ...Array.from({ length: 4 }, (_, index) => ({ modelId: `upstage/solar-${index}`, displayLabel: `Solar ${index}`, providerId: "upstage", free: false })),
  ];
  const agents: AgentInfo[] = [
    { id: "cline", name: "Cline CLI", protocol: "acp", found: true, path: "/bin/cline", version: "3", verified: false, signIn: "" },
  ];
  render(<ModelPicker models={models} agentId="cline" agents={agents} value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} onRescan={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  // The labs are headings in the list, not a third level in the rail.
  expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(["Cline CLI"]);
  expect(screen.getAllByRole("option")).toHaveLength(8);
  expect(screen.getByText("Free right now")).toBeInTheDocument();
  expect(screen.getByText("Anthropic")).toBeInTheDocument();
  // A lab with no logo of its own still shows a mark, never an empty slot.
  expect(screen.getByRole("option", { name: /Beam/ }).querySelector(".agent-mark")).toHaveTextContent("R");
  expect(screen.getByRole("option", { name: /Claude Haiku/ }).querySelector("img")).toHaveAttribute("src", "/brands/claude.svg");
  fireEvent.change(screen.getByRole("combobox", { name: "Search models" }), { target: { value: "gpt" } });
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["GPT-6.1 Sol"]);
});

it("shows the agent's own mark for a model with no family or provider logo", () => {
  const models = [{ modelId: "muse-spark-1.3" }];
  render(<ModelPicker models={models} agentId="muse" value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("option").querySelector(".agent-mark.img img")).toHaveAttribute("src", "/spark.svg");
});
