import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./Composer";
import { EffortMeter } from "./EffortMeter";
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
const panel = () => screen.queryByRole("dialog", { name: "Reasoning effort" });

describe("EffortMeter", () => {
  beforeEach(() => { resetStore(); hapticMock.mockClear(); });

  it("sits beside the model chip and opens its own panel in one click", async () => {
    seed();
    render(<Composer />);
    expect(screen.getByRole("button", { name: "Model" })).not.toHaveTextContent("Extra high");
    expect(chip()).toHaveAccessibleName("Reasoning effort, Extra high");
    expect(chip()).toHaveTextContent("XHigh");
    fireEvent.click(chip());
    expect(panel()).toBeInTheDocument();
    expect(chip()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["None", "Min", "Low", "Med", "High", "XHigh", "Max"]);
    expect(screen.getByRole("radio", { name: "Extra high" })).toHaveAttribute("aria-checked", "true");
  });

  it("picks a level with one click and closes, back on the chip", async () => {
    seed();
    render(<Composer />);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("radio", { name: "Max" }));
    await vi.waitFor(() => expect(effort()).toBe("max"));
    expect(hapticMock).toHaveBeenCalledWith("level");
    expect(chip()).toHaveAttribute("aria-expanded", "false");
    expect(chip()).toHaveFocus();
    expect(chip()).toHaveClass("peak");
  });

  it("previews a level on hover without committing it", () => {
    const onChange = vi.fn();
    render(<EffortMeter value="medium" tiers={["low", "medium", "high"]} fallback="medium" disabled={false} onChange={onChange} />);
    fireEvent.click(chip());
    expect(screen.getByText("Balanced speed and depth · model default")).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByRole("radio", { name: "High" }));
    expect(screen.getByText("Thinks it through before acting")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves through the panel with the arrow keys and closes on Escape", () => {
    const onChange = vi.fn();
    render(<EffortMeter value="medium" tiers={["low", "medium", "high", "max"]} fallback="medium" disabled={false} onChange={onChange} />);
    fireEvent.click(chip());
    const medium = screen.getByRole("radio", { name: "Medium, model default" });
    medium.focus();
    fireEvent.keyDown(medium, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "High" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("radio", { name: "High" }), { key: "Escape" });
    expect(chip()).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("steps the level from the closed chip with the arrow keys", () => {
    const onChange = vi.fn();
    render(<EffortMeter value="medium" tiers={["low", "medium", "high"]} fallback="medium" disabled={false} onChange={onChange} />);
    fireEvent.keyDown(chip(), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("high");
    expect(panel()).toBeNull();
  });

  it("does nothing while disabled", () => {
    const onChange = vi.fn();
    render(<EffortMeter tiers={["low", "high"]} fallback="high" disabled onChange={onChange} />);
    expect(chip()).toBeDisabled();
    expect(chip()).toHaveAccessibleName("Reasoning effort, High, model default");
  });

  it("keeps a pick drawn while it applies, then follows the session", () => {
    const onChange = vi.fn();
    const props = { tiers: ["low", "medium", "high"] as ReasoningEffort[], fallback: "medium" as ReasoningEffort, disabled: false, onChange };
    const view = render(<EffortMeter {...props} value="medium" applying />);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("radio", { name: "High" }));
    expect(chip()).toHaveAccessibleName("Reasoning effort, High");
    // The write was rejected: the applied value comes back once it settles.
    view.rerender(<EffortMeter {...props} value="medium" applying={false} />);
    expect(chip()).toHaveAccessibleName("Reasoning effort, Medium, model default");
  });

  it("is opened by the effort command", () => {
    seed();
    render(<Composer />);
    act(() => { expect(openPicker("effort")).toBe(true); });
    expect(panel()).toBeInTheDocument();
  });

  it("is absent for a model without effort levels", () => {
    seed({ models: [{ modelId: "plain", isActive: true, reasoningEfforts: [], effortSource: "host" }], threads: [thread({ agentId: "grok", config: { agentId: "grok", modelId: "plain" } })], modelsAgentId: "grok", agents: [{ id: "grok", name: "Grok", protocol: "acp", found: true, path: "/bin/grok", version: "1", verified: true, signIn: "" }], enabledAgents: { grok: true } });
    render(<Composer />);
    expect(screen.queryByRole("button", { name: /^Reasoning effort/ })).toBeNull();
    expect(openPicker("effort")).toBe(false);
  });
});
