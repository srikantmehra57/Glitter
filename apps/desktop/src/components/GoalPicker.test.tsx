import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GoalPicker } from "./GoalPicker";
import { haptic } from "../lib/haptics";

vi.mock("../lib/haptics", async (original) => {
  const actual = await original<typeof import("../lib/haptics")>();
  return { ...actual, haptic: vi.fn() };
});

const chip = (name = /^Orchestrator goal/) => screen.getByRole("button", { name });
const menu = () => screen.queryByRole("listbox", { name: /^Orchestrator goal/ });

function open(props: Partial<Parameters<typeof GoalPicker>[0]> = {}) {
  const handlers = { onGoal: vi.fn(), onOverride: vi.fn() };
  const view = render(<GoalPicker goal="balanced" override="auto" disabled={false} {...handlers} {...props} />);
  fireEvent.click(chip());
  return { ...handlers, view };
}

describe("GoalPicker", () => {
  it("puts the goal in the effort control's footprint and the shapes under This message", () => {
    open();
    expect(chip()).toHaveAccessibleName("Orchestrator goal, Balanced; Auto");
    expect(chip()).toHaveTextContent("Balanced");
    expect(menu()).toBeInTheDocument();
    expect(screen.getByText("Goal")).toBeInTheDocument();
    expect(screen.getByText("This message")).toBeInTheDocument();
    expect(screen.getAllByRole("option").map((option) => option.querySelector(".option-copy > span")?.firstChild?.textContent)).toEqual([
      "Optimize for cost", "Balanced", "Optimize for output", "Auto", "Small", "Builder", "Lead-guided", "Lead only",
    ]);
    // With Auto in effect the chip stands for the goal, so the goal row carries the check.
    expect(screen.getByRole("option", { name: /^Balanced/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /^Auto/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("option", { name: /^Auto/ })).toHaveTextContent("Default");
  });

  it("picks the goal and keeps a shape already queued for the next message", () => {
    const { onGoal, onOverride } = open({ override: "lead-only" });
    expect(chip()).toHaveAccessibleName("Orchestrator goal, Balanced; Lead only for the next message");
    expect(chip()).toHaveTextContent("Balanced · Lead only next");
    fireEvent.click(screen.getByRole("option", { name: /^Optimize for cost/ }));
    expect(onGoal).toHaveBeenCalledWith("cost");
    expect(onOverride).not.toHaveBeenCalled();
    // The parent has not written the goal yet; the pick stays drawn meanwhile.
    expect(chip()).toHaveTextContent("Cost · Lead only next");
    expect(chip()).toHaveAttribute("aria-expanded", "false");
    expect(chip()).toHaveFocus();
  });

  it("queues a shape for the next message and Auto returns to the policy", () => {
    const { onGoal, onOverride } = open();
    fireEvent.click(screen.getByRole("option", { name: /^Lead-guided/ }));
    expect(onOverride).toHaveBeenCalledWith("lead-guided");
    expect(onGoal).not.toHaveBeenCalled();
    expect(chip()).toHaveAccessibleName("Orchestrator goal, Balanced; Lead-guided for the next message");
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("option", { name: /^Auto/ }));
    expect(onOverride).toHaveBeenLastCalledWith("auto");
    expect(chip()).toHaveTextContent("Balanced");
    expect(haptic).toHaveBeenCalledWith("level");
  });

  it("keeps the pick drawn while it applies, then follows the session", () => {
    const props = { goal: "balanced" as const, override: "auto" as const, disabled: false, onGoal: vi.fn(), onOverride: vi.fn() };
    const view = render(<GoalPicker {...props} applying />);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("option", { name: /^Small/ }));
    expect(chip()).toHaveTextContent("Balanced · Small next");
    // The write was rejected: the applied value comes back once it settles.
    view.rerender(<GoalPicker {...props} applying={false} />);
    expect(chip()).toHaveTextContent("Balanced");
    view.rerender(<GoalPicker {...props} goal="output" override="lead-guided" applying={false} />);
    expect(chip()).toHaveTextContent("Output · Lead-guided next");
  });

  it("does nothing while disabled", () => {
    const onGoal = vi.fn();
    const onOverride = vi.fn();
    render(<GoalPicker goal="balanced" override="auto" disabled onGoal={onGoal} onOverride={onOverride} />);
    expect(chip()).toBeDisabled();
    fireEvent.click(chip());
    expect(menu()).toBeNull();
    expect(onGoal).not.toHaveBeenCalled();
    expect(onOverride).not.toHaveBeenCalled();
  });
});
