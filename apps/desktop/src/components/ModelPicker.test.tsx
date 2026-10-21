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

it("switches agents with tabs in the header, never a menu inside the menu", () => {
  const onAgentChange = vi.fn();
  render(<ModelPicker models={[{ modelId: "grok-4.7" }]} agentId="grok" agents={AGENTS} value={modelKey({ modelId: "grok-4.7" })} loading={false} disabled={false} onChange={vi.fn()} onAgentChange={onAgentChange} onRescan={vi.fn(async () => {})} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  const tabs = screen.getAllByRole("tab");
  expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual(["Muse", "Grok"]);
  expect(screen.getByRole("tab", { name: /Grok/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("listbox", { name: "Agent" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: /Muse/ }));
  expect(onAgentChange).toHaveBeenCalledWith("muse");
  // The picker stays open on the new agent's models.
  expect(screen.getByRole("dialog", { name: "Choose a model" })).toBeInTheDocument();
});

it("can switch away from a hidden current agent when only one enabled agent remains", () => {
  const onAgentChange = vi.fn();
  render(<ModelPicker models={[]} agentId="grok" agents={[AGENTS[0]]} loading={false} disabled={false} onChange={vi.fn()} onAgentChange={onAgentChange} onRescan={vi.fn(async () => {})} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("tab", { name: /Muse/ }));
  expect(onAgentChange).toHaveBeenCalledWith("muse");
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

it("gives each harness provider its own badge and lists only that provider's models", () => {
  const models: Model[] = [
    { modelId: "anthropic/claude-sonnet", providerId: "anthropic", displayLabel: "Claude Sonnet" },
    { modelId: "openai/gpt-5", providerId: "openai", displayLabel: "GPT-5" },
    { modelId: "xai/grok-4", providerId: "xai", displayLabel: "Grok 4" },
  ];
  const agents: AgentInfo[] = [
    { id: "harness", name: "Harness", protocol: "native", found: true, authenticated: true, path: null, version: null, verified: true, signIn: "" },
    { id: "grok", name: "Grok", protocol: "acp", found: true, path: "/bin/grok", version: "1", verified: true, signIn: "" },
  ];
  render(<ModelPicker models={models} agentId="harness" agents={agents} value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} onAgentChange={vi.fn()} onRescan={async () => {}} />);
  const trigger = screen.getByRole("button", { name: "Model" });
  expect(trigger.querySelector(".agent-mark.harness")).toBeNull();
  expect(trigger.querySelector(".agent-mark.anthropic")).not.toBeNull();
  fireEvent.click(trigger);
  expect(screen.queryByRole("tab", { name: "Harness" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Anthropic" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "OpenAI" })).toHaveAttribute("aria-selected", "false");
  expect(screen.getByRole("tab", { name: "xAI" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Grok" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /Claude Sonnet/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /GPT-5/ })).toBeNull();
  expect(screen.queryByRole("option", { name: /Grok 4/ })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "OpenAI" }));
  expect(screen.getByRole("tab", { name: "OpenAI" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("option", { name: /GPT-5/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Claude Sonnet/ })).toBeNull();
});

it("keeps the Cline API badge distinct from the Cline CLI agent", () => {
  const models: Model[] = [
    { modelId: "cline/anthropic/claude-sonnet-5.5", providerId: "cline", displayLabel: "claude-sonnet-5.5", description: "Cline API" },
  ];
  const agents: AgentInfo[] = [
    { id: "harness", name: "Harness", protocol: "native", found: true, authenticated: true, path: null, version: null, verified: true, signIn: "" },
    { id: "cline", name: "Cline CLI", protocol: "acp", found: true, path: "/bin/cline", version: "1", verified: false, signIn: "" },
  ];
  render(<ModelPicker models={models} agentId="harness" agents={agents} value={modelKey(models[0])} loading={false} disabled={false} onChange={vi.fn()} onAgentChange={vi.fn()} onRescan={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("tab", { name: "Cline API" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Cline CLI" })).toHaveAttribute("aria-selected", "false");
  expect(screen.getByRole("option", { name: /claude-sonnet-5.5/ })).toBeInTheDocument();
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
