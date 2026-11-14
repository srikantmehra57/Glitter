import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PermissionRulesCard } from "./PermissionRulesCard";
import { HARNESS_RULE_LENGTH, HARNESS_RULE_LIMIT } from "../lib/permissionRules";
import type { PermissionRule } from "../lib/types";

const rules: PermissionRule[] = [
  { effect: "allow", rule: "Bash(npm test)" },
  { effect: "deny", rule: "Edit(.env)" },
  { effect: "allow", rule: "WebSearch" },
];

function mount(props: Partial<Parameters<typeof PermissionRulesCard>[0]> = {}) {
  const onChange = vi.fn();
  const view = render(<PermissionRulesCard rules={rules} onChange={onChange} problems={[]} {...props} />);
  return { onChange, view };
}

const list = (name: "Always allow" | "Never allow") => within(screen.getByRole("region", { name }));
const input = (name: "Always allow" | "Never allow") => screen.getByRole("textbox", { name: `Add a rule to ${name}` });

function add(name: "Always allow" | "Never allow", text: string) {
  fireEvent.change(input(name), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: `Add rule to ${name}` }));
}

describe("PermissionRulesCard", () => {
  it("shows each list's own rules and removes one without disturbing the rest", () => {
    const { onChange } = mount();
    expect(list("Always allow").getByText("Bash(npm test)")).toBeInTheDocument();
    expect(list("Always allow").getByText("WebSearch")).toBeInTheDocument();
    expect(list("Always allow").queryByText("Edit(.env)")).not.toBeInTheDocument();
    expect(list("Never allow").getByText("Edit(.env)")).toBeInTheDocument();

    fireEvent.click(list("Always allow").getByRole("button", { name: "Remove Bash(npm test) from Always allow" }));
    expect(onChange).toHaveBeenCalledWith([{ effect: "deny", rule: "Edit(.env)" }, { effect: "allow", rule: "WebSearch" }]);
  });

  it("appends a trimmed rule to the list it was typed in and clears the field", () => {
    const { onChange } = mount();
    add("Never allow", "  Bash(git push *)  ");
    expect(onChange).toHaveBeenCalledWith([...rules, { effect: "deny", rule: "Bash(git push *)" }]);
    expect(input("Never allow")).toHaveValue("");
  });

  it("refuses an empty, over-long, control-character or duplicate rule inline", () => {
    const { onChange } = mount();
    for (const [text, message] of [
      ["   ", /Write a rule/],
      ["x".repeat(HARNESS_RULE_LENGTH + 1), /at most 300 bytes/],
      ["Bash(npm\u0000test)", /control characters/],
      ["Bash(npm test)", /already in this list/],
    ] as const) {
      fireEvent.change(input("Always allow"), { target: { value: text } });
      fireEvent.submit(input("Always allow").closest("form")!);
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(onChange).not.toHaveBeenCalled();
    }
    expect(screen.getByRole("textbox", { name: "Add a rule to Always allow" })).toHaveAttribute("maxlength", String(HARNESS_RULE_LENGTH));
  });

  it("leaves syntax to the harness and shows what it could not use", () => {
    const { onChange } = mount({ problems: ["A Bash rule may only end with *.", "Network is an allow rule; to keep commands offline, leave it out."] });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("could not use 2 rules");
    expect(alert).toHaveTextContent("A Bash rule may only end with *.");
    expect(alert).toHaveTextContent("ignored until you fix them");
    add("Always allow", "Bash(npm * test)");
    expect(onChange).toHaveBeenCalledWith([...rules, { effect: "allow", rule: "Bash(npm * test)" }]);
  });

  it("closes both lists at the shared limit and says why", () => {
    const full = Array.from({ length: HARNESS_RULE_LIMIT }, (_, index) => ({ effect: "allow" as const, rule: `Bash(npm run task-${index})` }));
    mount({ rules: full });
    for (const name of ["Always allow", "Never allow"] as const) {
      expect(input(name)).toBeDisabled();
      expect(list(name).getByRole("button", { name: `Add rule to ${name}` })).toBeDisabled();
    }
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(`Both lists hold ${HARNESS_RULE_LIMIT} rules`);
  });

  it("names the deny-only path form so an allow rule is not saved for nothing", () => {
    mount();
    expect(screen.getByText(/Write a rule as Tool\(pattern\)/)).toHaveTextContent("A path — Edit(.env), Read(.env), Edit(src/**) — is deny-only: edits already run in Ask and Auto, and reads never ask.");
    expect(screen.getByText(/Skips the approval this rule names, for commands, web calls and MCP tools/)).toBeInTheDocument();
  });

  it("offers a retry when the live rules could not be applied", () => {
    const onRetry = vi.fn();
    mount({ syncError: "Could not apply permission rules. Open threads may still use the previous rules.", onRetry });
    expect(screen.getByRole("alert")).toHaveTextContent("Open threads may still use the previous rules");
    fireEvent.click(screen.getByRole("button", { name: "Retry applying rules" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
