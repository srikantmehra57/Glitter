import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./Composer";
import { EffortPicker } from "./EffortPicker";
import { openPicker } from "../lib/commands";
import { haptic } from "../lib/haptics";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import { MOCK_MODELS } from "../lib/mock";
import type { ReasoningEffort, Thread } from "../lib/types";

vi.mock("../lib/haptics", async (original) => {
  const actual = await original<typeof import("../lib/haptics")>();
  return { ...actual, haptic: vi.fn() };
});
const hapticMock = vi.mocked(haptic);

const thread = (partial: Partial<Thread> = {}): Thread => ({
  sessionId: "s1",
  workspacePath: "/repo",
  title: "Work",
  updatedAt: new Date().toISOString(),
  status: "idle",
  unread: false,
  items: [],
  opened: true,
  ...partial,
});

function seed(extra: Record<string, unknown> = {}) {
  seedStore({
    workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }],
    selectedWorkspaceId: "w",
    threads: [thread({ config: { modelId: "muse-spark-1.3-contributor", effort: "xhigh", approvalMode: "promptUnmatched" } })],
    selectedSessionId: "s1",
    models: MOCK_MODELS,
    modelsAgentId: "muse",
    agents: [{ id: "muse", name: "Muse", protocol: "msp", found: true, path: "/usr/local/bin/muse", version: "1.3.0", verified: true, signIn: "", authenticated: true }],
    ready: true,
    ...extra,
  });
}

const effort = () => useAppStore.getState().threads.find((t) => t.sessionId === "s1")?.config?.effort;
const chip = () => screen.getByRole("button", { name: /^Reasoning effort/ });
const menu = () => screen.queryByRole("listbox", { name: /^Reasoning effort/ });
const row = (name: RegExp) => screen.getByRole("option", { name });

describe("EffortPicker", () => {
  beforeEach(() => { resetStore(); hapticMock.mockClear(); });

  it("sits beside the model chip and opens a menu of levels in one click", async () => {
    seed();
    render(<Composer />);
    expect(screen.getByRole("button", { name: "Model" })).not.toHaveTextContent("Extra high");
    expect(chip()).toHaveAccessibleName("Reasoning effort, Extra high");
    expect(chip()).toHaveTextContent("Extra high");
    fireEvent.click(chip());
    expect(menu()).toBeInTheDocument();
    expect(chip()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("option").map((option) => option.querySelector(".option-copy > span")?.firstChild?.textContent)).toEqual(["None", "Minimal", "Low", "Medium", "High", "Extra high", "Max"]);
    expect(row(/^Extra high/)).toHaveAttribute("aria-selected", "true");
  });

  it("lists Low, High, and Max for Kimi K3.1 Pro and tags Max as the default", () => {
    seed({
      modelsAgentId: "harness",
      agents: [{ id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "", authenticated: true }],
      models: [{ modelId: "custom-1/moonshotai/kimi-k3.1-pro", providerId: "custom-1", displayLabel: "MoonshotAI: Kimi K3.1 Pro", description: "ZenMux", reasoningEfforts: ["low", "high", "max"], defaultReasoningEffort: "max", effortSource: "host", isDefault: true, isActive: true }],
      threads: [thread({ agentId: "harness", config: { agentId: "harness", modelId: "custom-1/moonshotai/kimi-k3.1-pro", providerId: "custom-1", effort: "max", approvalMode: "guarded" } })],
    });
    render(<Composer />);
    fireEvent.click(chip());
    expect(screen.getAllByRole("option").map((option) => option.querySelector(".option-copy > span")?.firstChild?.textContent)).toEqual(["Low", "High", "Max"]);
    expect(row(/^Max/)).toHaveTextContent("Default");
    expect(row(/^High/)).not.toHaveTextContent("Default");
  });

  it("tags the model default and does not describe each level", () => {
    render(<EffortPicker value="low" tiers={["low", "medium", "high"]} fallback="medium" disabled={false} onChange={vi.fn()} />);
    fireEvent.click(chip());
    expect(row(/^Medium/)).toHaveTextContent("MediumDefault");
    expect(row(/^Medium/).querySelector("small")).toBeNull();
    expect(row(/^High/)).not.toHaveTextContent("Default");
    expect(row(/^High/).querySelector("small")).toBeNull();
  });

  it("picks a level with one click and closes, back on the chip, with no special treatment for the top tier", async () => {
    seed();
    render(<Composer />);
    fireEvent.click(chip());
    fireEvent.click(row(/^Max/));
    await vi.waitFor(() => expect(effort()).toBe("max"));
    expect(hapticMock).toHaveBeenCalledWith("level");
    expect(hapticMock).not.toHaveBeenCalledWith("thump");
    expect(chip()).toHaveAttribute("aria-expanded", "false");
    expect(chip()).toHaveFocus();
    expect(chip()).toHaveTextContent("Max");
    expect(document.querySelector(".effort-select .peak, .effort-ripple")).toBeNull();
  });

  it("draws each level as a dial on the scale from None to Max", () => {
    render(<EffortPicker value="low" tiers={["none", "low", "high", "max"]} fallback="high" disabled={false} onChange={vi.fn()} />);
    expect(chip().querySelector(".effort-gauge")).toHaveAttribute("data-level", "2");
    fireEvent.click(chip());
    expect(screen.getAllByRole("option").map((option) => option.querySelector(".effort-gauge")?.getAttribute("data-level"))).toEqual(["0", "2", "4", "6"]);
    expect(row(/^Max/).querySelector(".effort-gauge")).toHaveAttribute("data-peak", "true");
  });

  it("moves through the menu with the arrow keys and closes on Escape", () => {
    const onChange = vi.fn();
    render(<EffortPicker value="medium" tiers={["low", "medium", "high", "max"]} fallback="medium" disabled={false} onChange={onChange} />);
    fireEvent.click(chip());
    fireEvent.keyDown(row(/^Medium/), { key: "ArrowDown" });
    expect(row(/^High/)).toHaveClass("active");
    fireEvent.keyDown(row(/^High/), { key: "Escape" });
    expect(chip()).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("steps the level from the closed chip with the left and right arrows", () => {
    const onChange = vi.fn();
    render(<EffortPicker value="medium" tiers={["low", "medium", "high"]} fallback="medium" disabled={false} onChange={onChange} />);
    fireEvent.keyDown(chip(), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("high");
    fireEvent.keyDown(chip(), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it("does nothing while disabled", () => {
    const onChange = vi.fn();
    render(<EffortPicker tiers={["low", "high"]} fallback="high" disabled onChange={onChange} />);
    expect(chip()).toBeDisabled();
    expect(chip()).toHaveAccessibleName("Reasoning effort, High, model default");
    fireEvent.keyDown(chip(), { key: "ArrowLeft" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a pick drawn while it applies, then follows the session", () => {
    const onChange = vi.fn();
    const props = { tiers: ["low", "medium", "high"] as ReasoningEffort[], fallback: "medium" as ReasoningEffort, disabled: false, onChange };
    const view = render(<EffortPicker {...props} value="medium" applying />);
    fireEvent.click(chip());
    fireEvent.click(row(/^High/));
    expect(chip()).toHaveAccessibleName("Reasoning effort, High");
    // The write was rejected: the applied value comes back once it settles.
    view.rerender(<EffortPicker {...props} value="medium" applying={false} />);
    expect(chip()).toHaveAccessibleName("Reasoning effort, Medium, model default");
  });

  it("is opened by the effort command", () => {
    seed();
    render(<Composer />);
    act(() => { expect(openPicker("effort")).toBe(true); });
    expect(menu()).toBeInTheDocument();
  });

  it("is visible and shows the default effort level for a model without effort levels", () => {
    seed({ models: [{ modelId: "plain", isActive: true, reasoningEfforts: [], effortSource: "host" }], threads: [thread({ agentId: "grok", config: { agentId: "grok", modelId: "plain" } })], modelsAgentId: "grok", agents: [{ id: "grok", name: "Grok", protocol: "acp", found: true, path: "/bin/grok", version: "1", verified: true, signIn: "" }], enabledAgents: { grok: true } });
    render(<Composer />);
    expect(screen.getByRole("button", { name: /^Reasoning effort/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Reasoning effort/ })).toHaveAccessibleName("Reasoning effort, High, model default");
    act(() => { expect(openPicker("effort")).toBe(true); });
    expect(menu()).toBeInTheDocument();
  });
});
