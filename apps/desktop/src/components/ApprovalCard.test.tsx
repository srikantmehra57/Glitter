import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ApprovalCard } from "./ApprovalCard";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import type { ApprovalRequest, Thread } from "../lib/types";

const thread = (partial: Partial<Thread> = {}): Thread => ({
  sessionId: "s1",
  workspacePath: "/repo",
  title: "Work",
  updatedAt: new Date().toISOString(),
  status: "running",
  unread: false,
  items: [],
  ...partial,
});

const approval = (partial: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  approvalId: "a1",
  sessionId: "s1",
  turnId: "t1",
  toolName: "bash",
  rawArgs: JSON.stringify({ command: "ls -la" }),
  availableChoices: [
    { choiceId: "allow-once", label: "Allow once", decision: "approved", scope: "once" },
    { choiceId: "allow-session", label: "Allow for session", decision: "approvedForSession", scope: "session" },
    { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
  ],
  ...partial,
});

function mount(request: ApprovalRequest, threadPatch: Partial<Thread> = {}) {
  seedStore({ threads: [thread({ pendingApproval: request, ...threadPatch })], selectedSessionId: "s1" });
  return render(<ApprovalCard />);
}

describe("ApprovalCard", () => {
  beforeEach(resetStore);
  afterEach(() => vi.useRealTimers());

  it("renders the tool label, summary, and decisions; allow calls decide", () => {
    const decide = vi.fn();
    useAppStore.setState({ decide: decide as never });
    mount(approval());
    expect(screen.getByRole("heading", { name: "Allow Terminal?" })).toBeInTheDocument();
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Allow once/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Deny(?! and)/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Allow once/ }));
    expect(decide).toHaveBeenCalledWith("a1", "allow-once");
  });

  it("shows the proposed change for an edit_file approval", () => {
    mount(approval({
      toolName: "edit_file",
      rawArgs: JSON.stringify({ path: "src/lib/store.ts", old_string: "const a = 1;", new_string: "const a = 2;" }),
    }));
    const region = screen.getByLabelText("Proposed change");
    expect(region).toHaveTextContent("- const a = 1;");
    expect(region).toHaveTextContent("+ const a = 2;");
    expect(region).toHaveTextContent("src/lib/store.ts");
  });

  it("ticks the expiry countdown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
    mount(approval({ expiresAt: Date.now() + 60_000 }));
    expect(screen.getByText("Expires in 1:00")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText("Expires in 0:59")).toBeInTheDocument();
  });

  it("past expiresAt shows the expired notice and disables every choice", () => {
    mount(approval({ expiresAt: Date.now() - 1000 }));
    expect(screen.getByText("This approval expired. Stop or re-run the turn.")).toBeInTheDocument();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("describes the first allow choice's scope", () => {
    mount(approval());
    expect(screen.getByText("Allows this call only.")).toBeInTheDocument();
    act(() => {
      useAppStore.setState({
        threads: [thread({
          pendingApproval: approval({
            availableChoices: [
              { choiceId: "allow-session", label: "Allow for session", decision: "approvedForSession", scope: "session" },
              { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
            ],
          }),
        })],
      });
    });
    expect(screen.getByText("Allows every matching call for the rest of this thread.")).toBeInTheDocument();
  });
});

describe("denial explanations", () => {
  beforeEach(resetStore);
  it("opens an inline field and sends the denial with its explanation", () => {
    const decide = vi.fn();
    useAppStore.setState({ decide });
    mount(approval());
    fireEvent.click(screen.getByRole("button", { name: "Deny and explain…" }));
    expect(screen.getByRole("button", { name: "Deny and send feedback" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Explain what the agent should do instead"), { target: { value: "Use the existing helper" } });
    fireEvent.click(screen.getByRole("button", { name: "Deny and send feedback" }));
    expect(decide).toHaveBeenCalledWith("a1", "deny", "Use the existing helper");
  });
  it("never carries an explanation over to another approval", () => {
    mount(approval());
    fireEvent.click(screen.getByRole("button", { name: "Deny and explain…" }));
    fireEvent.change(screen.getByLabelText("Explain what the agent should do instead"), { target: { value: "For this tool only" } });
    act(() => useAppStore.setState({ threads: [thread({ pendingApproval: approval({ approvalId: "a2" }) })] }));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Deny and explain…" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
  it("caps replacement previews and includes multiple patch files", () => {
    const { unmount } = mount(approval({ toolName: "edit_file", rawArgs: JSON.stringify({ old_string: "old\n".repeat(300), new_string: "new" }) }));
    expect(screen.getByText("Preview truncated")).toBeInTheDocument();
    expect(screen.getByLabelText("Proposed change").children.length).toBeLessThanOrEqual(201);
    unmount();
    mount(approval({ toolName: "apply_patch", rawArgs: JSON.stringify({ patch: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/b.ts b/b.ts\n@@ -1 +1 @@\n-c\n+d" }) }));
    expect(screen.getByLabelText("Proposed patch")).toHaveTextContent("diff --git a/b.ts b/b.ts");
  });

  it("Enter approves and Esc denies only while the card itself has focus", () => {
    const decide = vi.fn(async () => {});
    useAppStore.setState({ decide });
    mount(approval());
    const card = screen.getByRole("alertdialog", { name: "Allow Terminal?" });
    // From a button inside the card the keys keep their usual meaning.
    fireEvent.keyDown(screen.getByRole("button", { name: /Allow for session/ }), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("button", { name: /Allow once/ }), { key: "Escape" });
    expect(decide).not.toHaveBeenCalled();
    card.focus();
    fireEvent.keyDown(card, { key: "Enter" });
    expect(decide).toHaveBeenLastCalledWith("a1", "allow-once");
    fireEvent.keyDown(card, { key: "Escape" });
    expect(decide).toHaveBeenLastCalledWith("a1", "deny");
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("groups scoped thread choices into one picker and approves the scope it shows", () => {
    const decide = vi.fn(async () => {});
    useAppStore.setState({ decide });
    mount(approval({
      rawArgs: JSON.stringify({ command: "git push origin main" }),
      availableChoices: [
        { choiceId: "allow-once", label: "Allow once", decision: "approved", scope: "once" },
        { choiceId: "allow-session", label: "Allow this command in this thread", decision: "approved", scope: "session", scopeLabel: "This exact command" },
        { choiceId: "allow-session-prefix", label: "Allow `git push …` in this thread", decision: "approved", scope: "session", scopeLabel: "git push …" },
        { choiceId: "allow-session-program", label: "Allow every `git` command in this thread", decision: "approved", scope: "session", scopeLabel: "Any git command" },
        { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
      ],
    }));
    // One button per decision, not one per scope; the narrowest scope is the default.
    expect(screen.queryByRole("button", { name: /Allow every/ })).toBeNull();
    const trigger = screen.getByRole("button", { name: /What to allow in this thread/ });
    expect(trigger).toHaveTextContent("This exact command");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /Any git command/ }));
    expect(useAppStore.getState().threads[0].approvalScope).toEqual({ approvalId: "a1", choiceId: "allow-session-program" });
    expect(screen.getByRole("button", { name: /What to allow in this thread/ })).toHaveTextContent("Any git command");
    fireEvent.click(screen.getByRole("button", { name: /Allow in thread/ }));
    expect(decide).toHaveBeenLastCalledWith("a1", "allow-session-program");
  });

  it("says why a risky command can only be allowed once", () => {
    mount(approval({
      rawArgs: JSON.stringify({ command: "git push --force" }),
      subject: { kind: "command", risk: "Overwrites or deletes history on the remote." },
      availableChoices: [
        { choiceId: "allow-once", label: "Allow once", decision: "approved", scope: "once" },
        { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
      ],
    }));
    expect(screen.getByText(/Overwrites or deletes history on the remote\. It can only be allowed once\./)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Allow in this thread" })).toBeNull();
  });

  it("ignores Enter and Esc on an expired approval", () => {
    const decide = vi.fn(async () => {});
    useAppStore.setState({ decide });
    mount(approval({ expiresAt: Date.now() - 1000 }));
    const card = screen.getByRole("alertdialog", { name: "Allow Terminal?" });
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: "Escape" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("Esc inside the denial field stays in the field and keeps the draft", () => {
    const decide = vi.fn(async () => {});
    const heard = vi.fn();
    useAppStore.setState({ decide });
    mount(approval());
    window.addEventListener("keydown", heard);
    fireEvent.click(screen.getByRole("button", { name: "Deny and explain…" }));
    const field = screen.getByLabelText("Explain what the agent should do instead");
    fireEvent.change(field, { target: { value: "Use the safe helper" } });
    fireEvent.keyDown(field, { key: "Escape" });
    // It never reached the window listener — App would read a stray Esc as "stop the turn".
    expect(heard).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(field).toHaveValue("Use the safe helper");
    window.removeEventListener("keydown", heard);
  });
});

describe("waiting card contract", () => {
  beforeEach(resetStore);

  it("is a named alertdialog that takes focus on mount and gives it back", () => {
    const invoker = document.createElement("button");
    document.body.appendChild(invoker);
    invoker.focus();
    mount(approval());
    const card = screen.getByRole("alertdialog", { name: "Allow Terminal?" });
    expect(card).toHaveFocus();
    expect(card).toHaveAttribute("aria-describedby");
    // The request resolves: the card leaves and the invoker is re-focused.
    act(() => useAppStore.setState({ threads: [thread()] }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(invoker).toHaveFocus();
    invoker.remove();
  });
});
