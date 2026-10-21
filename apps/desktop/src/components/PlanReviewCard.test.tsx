import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UserInputCards } from "./UserInputCards";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import type { Thread, UserInputRequest } from "../lib/types";

const plan = "## Steps\n\n1. Add `db.ts`.\n2. Wire it in.";

const review = (partial: Partial<UserInputRequest> = {}): UserInputRequest => ({
  sessionId: "s1",
  turnId: "t1",
  userInputId: "q-1",
  itemId: "s1:t1:tool:p1",
  toolCallId: "p1",
  toolName: "exit_plan_mode",
  viewCursor: "",
  intent: { kind: "planReview", plan },
  questions: [{ id: "q1", header: "Plan", question: "Approve this plan?", options: [{ label: "Approve", preview: { format: "markdown", content: plan } }, { label: "Keep planning" }], selection: { mode: "single" } }],
  ...partial,
});

function mount(request: UserInputRequest) {
  const respond = vi.fn(async () => {});
  const thread: Thread = { sessionId: "s1", workspacePath: "/repo", title: "Work", updatedAt: new Date().toISOString(), status: "idle", unread: false, items: [], agentId: "harness", opened: true, userInputs: [request] };
  seedStore({ threads: [thread], selectedSessionId: "s1", respondUserInput: respond });
  render(<UserInputCards />);
  return respond;
}

describe("PlanReviewCard", () => {
  beforeEach(resetStore);

  it("renders the plan as Markdown and approves by name", () => {
    const respond = mount(review());
    expect(screen.getByRole("alertdialog", { name: "Review the plan" })).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Steps" })).toBeInTheDocument();
    expect(screen.getByText("db.ts").tagName).toBe("CODE");
    expect(screen.queryByText("Approve this plan?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve and build" }));
    expect(respond).toHaveBeenCalledWith("s1", "q-1", { action: "answer", answers: [{ questionId: "q1", selectedLabel: "Approve" }] });
  });

  it("sends typed feedback, and Keep planning closes the review", () => {
    const respond = mount(review());
    const send = screen.getByRole("button", { name: "Send feedback" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText("What should change?"), { target: { value: "  Add tests first.  " } });
    fireEvent.click(send);
    expect(respond).toHaveBeenLastCalledWith("s1", "q-1", { action: "clarify", text: "Add tests first." });
    fireEvent.click(screen.getByRole("button", { name: "Keep planning" }));
    expect(respond).toHaveBeenLastCalledWith("s1", "q-1", { action: "answer", answers: [{ questionId: "q1", selectedLabel: "Keep planning" }] });
  });

  it("leaves other requests to the question card", () => {
    mount(review({ intent: undefined }));
    expect(screen.queryByRole("alertdialog", { name: "Review the plan" })).toBeNull();
    expect(screen.getByText("Plan: Approve this plan?")).toBeInTheDocument();
    expect(useAppStore.getState().threads[0].userInputs).toHaveLength(1);
  });
});
