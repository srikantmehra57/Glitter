import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { ThreadView } from "./ThreadView";
import { resetStore, seedStore } from "../test/store";
import { useAppStore } from "../lib/store";

vi.mock("./Orb", () => ({ Orb: () => <span /> }));

describe("thread layout", () => {
  beforeEach(() => {
    resetStore();
    seedStore({ workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }], selectedWorkspaceId: "w", selectedSessionId: "s1", threads: [{
      sessionId: "s1", workspacePath: "/repo", title: "Work", updatedAt: new Date().toISOString(), status: "running", unread: false, opened: true,
      activeTurnId: "t", items: [{ itemId: "u", kind: "userMessage", status: "completed", text: "Do the work", turnId: "t" }],
      plan: [{ id: "p", text: "Inspect the code", status: "inProgress" }],
    }] });
  });
  it("keeps the plan where it was made, and pins a compact copy outside the scroller only on request", () => {
    render(<ThreadView />);
    const inline = screen.getByRole("region", { name: "Plan" });
    expect(inline.closest(".conversation")).not.toBeNull();
    // It sits after the message that asked for it, not at the top of the thread.
    expect(screen.getByText("Do the work").compareDocumentPosition(inline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pin plan to top" }));
    const plan = screen.getByRole("region", { name: "Plan" });
    expect(plan.closest(".conversation")).toBeNull();
    expect(within(plan).getByRole("button", { name: /Plan/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByRole("region", { name: "Plan" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Unpin plan from top" }));
    expect(screen.getByRole("region", { name: "Plan" }).closest(".conversation")).not.toBeNull();
    act(() => useAppStore.setState((s) => ({ threads: s.threads.map((t) => ({ ...t, status: "idle", plan: [{ id: "p", text: "Inspect the code", status: "completed" }] })) })));
    expect(screen.getByRole("region", { name: "Plan" }).closest(".conversation")).not.toBeNull();
  });
  it("places Jump to latest above the composer and jumps to the end", () => {
    render(<ThreadView />);
    const scroller = screen.getByLabelText("Agent");
    Object.defineProperties(scroller, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 400, configurable: true } });
    fireEvent.scroll(scroller, { target: { scrollTop: 100 } });
    const jump = screen.getByRole("button", { name: "Jump to latest" });
    expect(jump.closest(".composer-wrap")).not.toBeNull();
    fireEvent.click(jump);
    expect(scroller.scrollTop).toBe(2000);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("labels a fresh first-message edit separately from a history fork", () => {
    seedStore({ threads: useAppStore.getState().threads.map((thread) => ({ ...thread, forkedFrom: { sessionId: "source", title: "Original", firstMessage: true } })) });
    render(<ThreadView />);
    expect(screen.getByText("Edited from Original")).toHaveAttribute("title", expect.stringContaining("no earlier history"));
    act(() => useAppStore.setState((state) => ({ threads: state.threads.map((thread) => ({ ...thread, forkedFrom: { sessionId: "source", title: "Original", cutTurnId: "t1" } })) })));
    expect(screen.getByText("Fork of Original")).toBeInTheDocument();
  });

  it("mounts the dock once next to the thread and keeps the composer while expanded", () => {
    seedStore({ dockOpen: true, dockExpanded: true });
    const { container } = render(<ThreadView />);
    expect(container.querySelectorAll("aside.dock")).toHaveLength(1);
    expect(container.querySelectorAll(".composer-wrap")).toHaveLength(1);
    expect(container.querySelector(".review-layout.expanded")).not.toBeNull();
    expect(container.querySelector("main.main.dock-focused")).not.toBeNull();
    expect(document.getElementById("prompt")).not.toBeNull();
    // Closing restores the side-by-side transcript without remounting anything.
    act(() => useAppStore.setState({ dockOpen: false, dockExpanded: false }));
    expect(container.querySelector("main.main.dock-focused")).toBeNull();
    expect(container.querySelectorAll(".composer-wrap")).toHaveLength(1);
  });

  it("keeps the title bar outside the main panel, directly before it", () => {
    const { container } = render(<ThreadView />);
    const bar = container.querySelector("header.topbar");
    expect(bar).not.toBeNull();
    expect(bar?.closest("main")).toBeNull();
    // The focused-dock toggle in the title bar is styled from this adjacency.
    expect(bar?.nextElementSibling).toBe(container.querySelector("main.main"));
  });

  it("keeps the composer last in the thread column and empty states free of artwork", () => {
    seedStore({ threads: [], selectedSessionId: null });
    const { container } = render(<ThreadView />);
    expect(container.querySelector(".thread-main")?.lastElementChild).toBe(container.querySelector(".composer-wrap"));
    expect(container.querySelector(".ember-tiles")).toBeNull();
    expect(screen.getByRole("heading", { name: /What should we build/ })).toBeInTheDocument();
  });

  it("offers a Thread/Changes toggle for focused layouts", () => {
    const setOpen = vi.fn();
    seedStore({ dockOpen: true, setDockOpen: setOpen });
    render(<ThreadView />);
    const group = screen.getByRole("group", { name: "Thread or Changes view" });
    const thread = within(group).getByRole("button", { name: "Thread" });
    const changes = within(group).getByRole("button", { name: "Changes" });
    expect(thread).toHaveAttribute("aria-pressed", "false");
    expect(changes).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(thread);
    expect(setOpen).toHaveBeenLastCalledWith(false);
    fireEvent.click(changes);
    expect(setOpen).toHaveBeenLastCalledWith(true);
  });

  it("the Changes toggle lands on a changes/diff tab, not Monitor", () => {
    const setOpen = vi.fn();
    const setTab = vi.fn();
    // Monitor was the open inspector: switching to Changes must leave it.
    seedStore({ dockOpen: false, inspectorTab: "activity", setDockOpen: setOpen, setInspectorTab: setTab });
    const { unmount } = render(<ThreadView />);
    fireEvent.click(within(screen.getByRole("group", { name: "Thread or Changes view" })).getByRole("button", { name: "Changes" }));
    expect(setTab).toHaveBeenCalledWith("changes");
    expect(setOpen).toHaveBeenCalledWith(true);
    unmount();
    // Diff stays Diff when it was the open inspector.
    setTab.mockClear();
    seedStore({ dockOpen: false, inspectorTab: "diff" });
    render(<ThreadView />);
    fireEvent.click(within(screen.getByRole("group", { name: "Thread or Changes view" })).getByRole("button", { name: "Changes" }));
    expect(setTab).not.toHaveBeenCalled();
    expect(setOpen).toHaveBeenCalledWith(true);
  });
});

describe("predicted suggestions", () => {
  beforeEach(() => {
    resetStore();
    seedStore({ workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }], selectedWorkspaceId: "w", selectedSessionId: null, threads: [] });
  });
  const predicted = (workspaceId = "w") => ({ workspaceId, signature: "s", at: Date.now(), agentId: "muse" as const, items: [
    { title: "Finish the login flow", prompt: "Wire the login submit handler and cover it." },
    { title: "Review dirty files", prompt: "Review my uncommitted changes." },
  ] });

  it("renders predicted chips with their source when the feature is on", () => {
    seedStore({ suggestionsEnabled: true, suggestions: predicted(), refreshSuggestions: vi.fn(async () => {}) });
    render(<ThreadView />);
    expect(screen.getByText("Predicted from workspace state by Muse")).toBeInTheDocument();
    const chip = screen.getByRole("button", { name: /Finish the login flow/ });
    expect(chip.closest(".composer-wrap")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Explain this codebase/ })).toBeNull();
  });

  it("falls back to the static set when disabled or generated for another workspace", () => {
    seedStore({ suggestionsEnabled: false, suggestions: predicted(), refreshSuggestions: vi.fn(async () => {}) });
    const first = render(<ThreadView />);
    expect(screen.getByRole("button", { name: /Explain this codebase/ })).toBeInTheDocument();
    expect(screen.queryByText(/Predicted from workspace state/)).toBeNull();
    first.unmount();
    seedStore({ suggestionsEnabled: true, suggestions: predicted("elsewhere") });
    render(<ThreadView />);
    expect(screen.getByRole("button", { name: /Explain this codebase/ })).toBeInTheDocument();
    expect(screen.queryByText(/Predicted from workspace state/)).toBeNull();
  });

  it("asks for suggestions when the empty state mounts and prefills the composer on click", () => {
    const refreshSuggestions = vi.fn(async () => {});
    seedStore({ suggestionsEnabled: true, suggestions: predicted(), refreshSuggestions });
    render(<ThreadView />);
    expect(refreshSuggestions).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Finish the login flow/ }));
    expect(useAppStore.getState().composer).toBe("Wire the login submit handler and cover it.");
  });

  it("centres the empty state on the composer with the workspace beneath the heading", () => {
    seedStore({ suggestionsEnabled: false, git: { repository: true, branch: "main", dirty: false, files: [], diff: "", truncated: false }, refreshSuggestions: vi.fn(async () => {}) });
    const { container } = render(<ThreadView />);
    expect(container.querySelector(".thread-main")).toHaveClass("centered");
    const hero = screen.getByRole("region", { name: "What should we build next?" });
    expect(within(hero).getByText("repo")).toBeInTheDocument();
    expect(within(hero).getByText("main")).toBeInTheDocument();
    expect(screen.queryByText(/suggestion above the composer/)).toBeNull();
    // The chips still ride the composer's top edge, never the stage.
    expect(screen.getByRole("button", { name: /Explain this codebase/ }).closest(".composer-wrap")).not.toBeNull();
  });

  it("docks the composer once the thread has messages or the terminal opens", () => {
    seedStore({ terminalOpen: true, refreshSuggestions: vi.fn(async () => {}) });
    const terminal = render(<ThreadView />);
    expect(terminal.container.querySelector(".thread-main")).not.toHaveClass("centered");
    terminal.unmount();
    seedStore({
      terminalOpen: false,
      selectedSessionId: "s1",
      threads: [{ sessionId: "s1", workspacePath: "/repo", title: "Work", updatedAt: new Date().toISOString(), status: "idle", unread: false, opened: true, items: [{ itemId: "u1", kind: "userMessage", status: "completed", text: "Hi", turnId: "t1" }] }],
    });
    const { container } = render(<ThreadView />);
    expect(container.querySelector(".thread-main")).not.toHaveClass("centered");
  });

  it("does not ask while restoring or while an existing thread is selected", () => {
    const refreshSuggestions = vi.fn(async () => {});
    seedStore({ suggestionsEnabled: true, restoringSession: "s1", suggestions: predicted(), refreshSuggestions });
    const restoring = render(<ThreadView />);
    expect(refreshSuggestions).not.toHaveBeenCalled();
    restoring.unmount();
    refreshSuggestions.mockClear();
    seedStore({
      suggestionsEnabled: true,
      restoringSession: null,
      selectedSessionId: "s1",
      suggestions: predicted(),
      refreshSuggestions,
      threads: [{ sessionId: "s1", workspacePath: "/repo", title: "Work", updatedAt: new Date().toISOString(), status: "idle", unread: false, items: [], opened: false, opening: true }],
    });
    render(<ThreadView />);
    expect(refreshSuggestions).not.toHaveBeenCalled();
  });
});

describe("find in thread", () => {
  const item = (itemId: string, kind: "userMessage" | "agentMessage", text: string, turnId: string) => ({ itemId, kind, status: "completed" as const, text, turnId });
  beforeEach(() => {
    resetStore();
    seedStore({ workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }], selectedWorkspaceId: "w", selectedSessionId: "s1", findOpen: true, threads: [{
      sessionId: "s1", workspacePath: "/repo", title: "Work", updatedAt: new Date().toISOString(), status: "idle", unread: false, opened: true, lastTurnId: "t2",
      items: [item("u1", "userMessage", "Fix the login page", "t1"), item("m1", "agentMessage", "The login form now validates.", "t1"), item("u2", "userMessage", "Thanks", "t2"), item("m2", "agentMessage", "Done.", "t2")],
    }] });
  });

  it("counts matching messages, steps through them with wrap-around and marks the current one", () => {
    render(<ThreadView />);
    const input = screen.getByRole("textbox", { name: "Find in thread" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "LOGIN" } });
    expect(document.querySelector(".find-count")).toHaveTextContent("1 of 2");
    expect(document.querySelector(".find-current")).toHaveAttribute("data-item", "u1");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.querySelector(".find-count")).toHaveTextContent("2 of 2");
    expect(document.querySelectorAll(".find-current")).toHaveLength(1);
    expect(document.querySelector(".find-current")).toHaveAttribute("data-item", "m1");
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(document.querySelector(".find-count")).toHaveTextContent("1 of 2");
    fireEvent.keyDown(window, { key: "g", code: "KeyG", metaKey: true, shiftKey: true });
    expect(document.querySelector(".find-count")).toHaveTextContent("2 of 2");
    fireEvent.change(input, { target: { value: "nowhere" } });
    expect(document.querySelector(".find-count")).toHaveTextContent("No matches");
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
    expect(document.querySelector(".find-current")).toBeNull();
  });

  it("closes on Esc without stopping anything and clears its marks", () => {
    const stopTurn = vi.fn();
    useAppStore.setState({ stopTurn });
    render(<ThreadView />);
    const input = screen.getByRole("textbox", { name: "Find in thread" });
    fireEvent.change(input, { target: { value: "login" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useAppStore.getState().findOpen).toBe(false);
    expect(screen.queryByRole("textbox", { name: "Find in thread" })).toBeNull();
    expect(document.querySelector(".find-current")).toBeNull();
    expect(stopTurn).not.toHaveBeenCalled();
  });

  it("hands focus back to the element that opened it", () => {
    seedStore({ findOpen: false });
    render(<ThreadView />);
    const composer = document.getElementById("prompt") as HTMLElement;
    composer.focus();
    act(() => useAppStore.getState().setFindOpen(true));
    expect(screen.getByRole("textbox", { name: "Find in thread" })).toHaveFocus();
    act(() => useAppStore.getState().setFindOpen(false));
    expect(composer).toHaveFocus();
  });
});

describe("completion usage", () => {
  beforeEach(() => {
    resetStore();
    seedStore({
      workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }],
      selectedWorkspaceId: "w",
      selectedSessionId: "s1",
      threads: [{
        sessionId: "s1", workspacePath: "/repo", title: "Work", updatedAt: new Date().toISOString(), status: "idle", unread: false, opened: true,
        lastTurnId: "t1", lastOutcome: "completed",
        items: [{ itemId: "u", kind: "userMessage", status: "completed", text: "Do the work", turnId: "t1" }],
        turnStats: { turnId: "t1", durationMs: 42000, inputTokens: 12040, outputTokens: 3120 },
      }],
      models: [{ modelId: "muse-spark-1.3", isActive: true, cost: { input: "1.25", output: "4.25", currency: "USD" } }],
      modelsAgentId: "muse",
    });
  });

  it("combines completion, duration, tokens and cost even without file changes", () => {
    render(<ThreadView />);
    const receipt = screen.getByRole("region", { name: "Done" });
    const stats = within(receipt).getByLabelText("Turn usage");
    expect(stats).toHaveTextContent("42s");
    expect(stats).toHaveTextContent("3.1K tokens");
    expect(stats).toHaveTextContent("≈$0.03");
    expect(within(stats).getByTitle("Estimated cost for this turn")).toHaveTextContent("≈$0.03");
    expect(screen.getAllByLabelText("Turn usage")).toHaveLength(1);
    expect(within(receipt).getByRole("button", { name: "Fork here" })).toBeInTheDocument();
  });

  it("leaves turn stats alone when the model is unpriced", () => {
    seedStore({ models: [{ modelId: "muse-spark-1.3", isActive: true, cost: null }] });
    render(<ThreadView />);
    expect(document.querySelector(".turn-stats")).not.toHaveTextContent("≈");
  });

  it("keeps estimated output counts marked and only shows usage on the matching latest turn", () => {
    seedStore({ threads: useAppStore.getState().threads.map((thread) => ({ ...thread, turnStats: { turnId: "t1", durationMs: 81000, outputTokens: 2900, estimated: true } })) });
    render(<ThreadView />);
    expect(screen.getByLabelText("Turn usage")).toHaveTextContent("1m 21s");
    expect(screen.getByLabelText("Turn usage")).toHaveTextContent("~2.9K tokens");
    act(() => seedStore({ threads: useAppStore.getState().threads.map((thread) => ({ ...thread, lastTurnId: "t2", items: [...thread.items, { itemId: "u2", kind: "userMessage", status: "completed", text: "Another turn", turnId: "t2" }] })) }));
    expect(screen.queryByLabelText("Turn usage")).toBeNull();
  });

  it("leaves Undo out without a note when no file state was saved", () => {
    seedStore({ threads: useAppStore.getState().threads.map((thread) => ({ ...thread, snapshots: { t1: { snapshotId: "snap", sessionId: "s1", turnId: "t1", state: "unavailable", files: [], reason: "Undo is unavailable: workspace capture took too long.", createdAt: 1 } } })) });
    render(<ThreadView />);
    const receipt = screen.getByRole("region", { name: "Done" });
    expect(within(receipt).queryByText(/Undo is unavailable/)).toBeNull();
    expect(within(receipt).getByLabelText("Turn usage")).toBeInTheDocument();
    expect(within(receipt).queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("shows stopped usage without labelling a cancelled turn Done", () => {
    seedStore({ threads: useAppStore.getState().threads.map((thread) => ({ ...thread, lastOutcome: "cancelled" })) });
    render(<ThreadView />);
    expect(screen.queryByRole("region", { name: "Done" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Stopped" })).getByLabelText("Turn usage")).toHaveTextContent("3.1K tokens");
  });
});

