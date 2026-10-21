import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { UserInputCards } from "./UserInputCards";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import type { Thread, UserInputRequest } from "../lib/types";

const request = (partial: Partial<UserInputRequest> = {}): UserInputRequest => ({
  sessionId: "s1",
  turnId: "t1",
  itemId: "i1",
  toolCallId: "tc1",
  toolName: "ask",
  userInputId: "ui1",
  viewCursor: "c1",
  questions: [
    {
      id: "q1",
      header: "Pick one",
      question: "Which option?",
      selection: { mode: "single" },
      options: [{ label: "A" }, { label: "B" }],
    },
  ],
  ...partial,
});

const thread = (partial: Partial<Thread> = {}): Thread => ({
  sessionId: "s1",
  workspacePath: "/repo",
  title: "Work",
  updatedAt: new Date().toISOString(),
  status: "running",
  unread: false,
  opened: true,
  items: [],
  ...partial,
});

function mount(req: UserInputRequest, threadPatch: Partial<Thread> = {}) {
  seedStore({ threads: [thread({ userInputs: [req], ...threadPatch })], selectedSessionId: "s1" });
  return render(<UserInputCards />);
}

describe("UserInputCards", () => {
  beforeEach(resetStore);

  it("is a named alertdialog that takes focus on mount", () => {
    mount(request());
    const card = screen.getByRole("alertdialog", { name: "Muse needs your input" });
    expect(card).toHaveFocus();
  });

  it("sends selected answers and hands focus back when the request settles", () => {
    const respondUserInput = vi.fn(async () => {});
    useAppStore.setState({ respondUserInput });
    const invoker = document.createElement("button");
    document.body.appendChild(invoker);
    invoker.focus();
    mount(request());
    fireEvent.click(screen.getByRole("radio", { name: /A/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    expect(respondUserInput).toHaveBeenCalledWith("s1", "ui1", { action: "answer", answers: [{ questionId: "q1", selectedLabel: "A" }] });
    // The settlement removes the request: the card leaves and the invoker is re-focused.
    act(() => useAppStore.setState({ threads: [thread()] }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(invoker).toHaveFocus();
    invoker.remove();
  });

  it("keeps Esc inside its fields instead of letting it reach the page", () => {
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    mount(request({ questions: [{ id: "q1", header: "", question: "Say more", selection: { mode: "single" }, options: [] }] }));
    const field = screen.getByRole("textbox", { name: "Answer: Say more" });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(heard).not.toHaveBeenCalled();
    window.removeEventListener("keydown", heard);
  });
});
