import { Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import { useAppStore } from "../lib/store";
import { sidebarWidthBounds, sidebarWidthFor } from "../lib/reviewLayout";
import { resetStore, seedStore } from "../test/store";
import type { ApprovalRequest, Thread } from "../lib/types";

const threadActions = vi.hoisted(() => ({ openThreadFolder: vi.fn(), copyThreadPath: vi.fn(), copyThreadLogPath: vi.fn(), copyAppLogPath: vi.fn(), copySessionId: vi.fn(), openAppConfig: vi.fn(), reportThreadIssue: vi.fn() }));
vi.mock("../lib/threadActions", () => threadActions);

const thread = (sessionId: string, partial: Partial<Thread> = {}): Thread => ({
  sessionId,
  workspacePath: "/repo",
  title: `Thread ${sessionId}`,
  updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  status: "idle",
  unread: false,
  items: [],
  opened: true,
  ...partial,
});

const approval = (sessionId: string): ApprovalRequest => ({ approvalId: `ap-${sessionId}`, sessionId, turnId: "t1", toolName: "write_file", rawArgs: "{}", availableChoices: [] });

/** Two workspaces: "repo" selected and open, "other" collapsed. */
function seedTwo(threads: Thread[]) {
  const loadWorkspaceThreads = vi.fn(async () => {});
  seedStore({
    workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }, { id: "w2", path: "/other", name: "other", grantId: "g2" }],
    selectedWorkspaceId: "w",
    threads,
    selectedSessionId: threads[0]?.sessionId ?? null,
    preview: false,
    detectionChecked: true,
    loadWorkspaceThreads,
  });
  return { loadWorkspaceThreads };
}

function seed(threads: Thread[], selected = threads[0]?.sessionId ?? null) {
  seedStore({
    workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }],
    selectedWorkspaceId: "w",
    threads,
    selectedSessionId: selected,
    preview: false,
    detectionChecked: true,
  });
}

/** Mount the sidebar inside a Profiler so commits are countable. */
function mount() {
  const commits = { count: 0 };
  render(<Profiler id="sidebar" onRender={() => { commits.count += 1; }}><Sidebar /></Profiler>);
  return commits;
}

describe("Sidebar", () => {
  beforeEach(() => {
    resetStore();
    for (const action of Object.values(threadActions)) action.mockReset();
  });

  it("lists the workspace's threads with their status", () => {
    seed([thread("a", { status: "running" }), thread("b", { title: "Failing one", lastOutcome: "failed" }), thread("c", { unread: true })]);
    mount();
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByLabelText("Running")).toBeInTheDocument();
    expect(within(list).getByLabelText("Failed")).toBeInTheDocument();
    expect(within(list).getByLabelText("Unread")).toBeInTheDocument();
  });

  it("flags a thread waiting on the user ahead of its running spinner", () => {
    seed([thread("a", { status: "running", pendingApproval: approval("a") }), thread("b", { userInputs: [{ userInputId: "q", sessionId: "b", turnId: "t1", itemId: "i", toolCallId: "c", toolName: "ask_user", viewCursor: "v", questions: [] }] }), thread("c", { status: "running" })]);
    mount();
    const list = screen.getByRole("list");
    expect(within(list).getAllByLabelText("Needs your attention")).toHaveLength(2);
    expect(within(list).getAllByLabelText("Running")).toHaveLength(1);
  });

  it("flags a blocked thread in another workspace on its visible row", () => {
    seedTwo([thread("a"), thread("z", { workspacePath: "/other", title: "Blocked", status: "running", pendingApproval: approval("z") })]);
    render(<Sidebar />);
    const other = screen.getByRole("button", { name: /^other/ });
    expect(within(other).getByLabelText("A thread needs your attention")).toBeInTheDocument();
    // Only the folder in view's threads are listed.
    expect(screen.queryByText("Blocked")).toBeNull();
  });

  it("spans every workspace in a search, opening each folder with a match for that search only", async () => {
    const { loadWorkspaceThreads } = seedTwo([thread("a", { title: "Redeploy plan" }), thread("b", { title: "Lint fixes" }), thread("z", { workspacePath: "/other", title: "Deploy notes" })]);
    render(<Sidebar />);
    expect(screen.queryByText("Deploy notes")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Search threads" }));
    await user.type(screen.getByRole("textbox", { name: "Search threads" }), "deploy");
    await screen.findByText("Deploy notes");
    expect(loadWorkspaceThreads).toHaveBeenCalledWith("w2");
    // The matches sit under their own folder rows; nothing else is listed.
    expect(within(screen.getByRole("list", { name: "Threads in other" })).getByText("Deploy notes")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Threads in repo" })).getByText("Redeploy plan")).toBeInTheDocument();
    expect(screen.queryByText("Lint fixes")).toBeNull();
    // The caret hides a revealed folder for this search only.
    await user.click(screen.getByRole("button", { name: "Collapse other" }));
    expect(screen.queryByText("Deploy notes")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand other" }));
    expect(screen.getByText("Deploy notes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(screen.queryByText("Deploy notes")).toBeNull());
    expect(screen.getByRole("button", { name: "Expand other" })).toBeInTheDocument();
  });

  it("opens another workspace from its caret without leaving the folder in view", async () => {
    const { loadWorkspaceThreads } = seedTwo([thread("a", { title: "Alpha" }), thread("z", { workspacePath: "/other", title: "Elsewhere" })]);
    render(<Sidebar />);
    expect(screen.queryByText("Elsewhere")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Expand other" }));
    expect(loadWorkspaceThreads).toHaveBeenCalledWith("w2");
    expect(screen.getByText("Elsewhere")).toBeInTheDocument();
    // Both lists stay open side by side; the selection did not move.
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(useAppStore.getState().selectedWorkspaceId).toBe("w");
    await user.click(screen.getByRole("button", { name: "Collapse other" }));
    await waitFor(() => expect(screen.queryByText("Elsewhere")).toBeNull());
  });

  it("folds a long list after eight threads, keeping the open one and any waiting or running in place", async () => {
    const many = Array.from({ length: 14 }, (_, index) => thread(`t${index}`, { title: `Task ${index}`, order: 100 - index }));
    many[11] = { ...many[11], status: "running" };
    seed(many, "t12");
    render(<Sidebar />);
    const list = screen.getByRole("list", { name: "Threads in repo" });
    // Eight, plus the running one and the open one past the cap.
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    expect(within(list).getByText("Task 11")).toBeInTheDocument();
    expect(within(list).getByText("Task 12")).toBeInTheDocument();
    expect(within(list).queryByText("Task 13")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show 4 more" }));
    expect(within(screen.getByRole("list", { name: "Threads in repo" })).getAllByRole("listitem")).toHaveLength(14);
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(within(screen.getByRole("list", { name: "Threads in repo" })).getAllByRole("listitem")).toHaveLength(10);
  });

  it("keeps Remove behind the workspace's menu, beside opening the folder and copying its path", async () => {
    seedTwo([thread("a")]);
    const confirm = vi.fn(async () => true);
    const removeWorkspace = vi.fn();
    const openTrustDialog = vi.fn(async () => {});
    seedStore({ confirm, removeWorkspace, openTrustDialog });
    render(<Sidebar />);
    // No bare Remove button on the row, one slip from New thread.
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Actions for other" }));
    const menu = screen.getByRole("menu", { name: "Actions for other" });
    expect(within(menu).getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Show in Finder|Open folder/ })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Trust workspace…" }));
    expect(openTrustDialog).toHaveBeenCalledWith("w2");
    await user.click(screen.getByRole("button", { name: "Actions for other" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from sidebar" }));
    await waitFor(() => expect(removeWorkspace).toHaveBeenCalledWith("w2"));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Remove other from the sidebar?", danger: true }));
  });

  it("archives from the thread menu and opens the archive from the Workspaces label", async () => {
    seed([thread("a", { title: "Alpha" }), thread("b", { title: "Beta" })]);
    render(<Sidebar />);
    expect(screen.queryByRole("button", { name: /Archived threads/ })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(useAppStore.getState().threads.find((item) => item.sessionId === "a")?.archived).toBe(true);
    expect(screen.queryByText("Alpha")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Archived threads (1)" }));
    expect(useAppStore.getState().settingsOpen).toBe(true);
    expect(useAppStore.getState().settingsTab).toBe("Threads");
  });

  it("runs the screenshot's support actions from a Harness thread menu", async () => {
    seed([thread("h-thread-123", { agentId: "harness", title: "Alpha" })]);
    const user = userEvent.setup();
    render(<Sidebar />);
    await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    for (const name of ["Mark as unread", "Open in Finder", "Copy path", "Copy task path", "Copy log path", "Copy session ID", "Go to config", "View model trajectory", "Report issue"]) {
      expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();
    }
    await user.click(screen.getByRole("menuitem", { name: "Mark as unread" }));
    expect(useAppStore.getState().threads[0].unread).toBe(true);
    await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    await user.click(screen.getByRole("menuitem", { name: "Mark as read" }));
    expect(useAppStore.getState().threads[0].unread).toBe(false);

    const actions: Array<[string, () => unknown, ...unknown[]]> = [
      ["Open in Finder", threadActions.openThreadFolder, "h-thread-123"],
      ["Copy path", threadActions.copyThreadPath, "h-thread-123"],
      ["Copy task path", threadActions.copyThreadLogPath, "h-thread-123"],
      ["Copy log path", threadActions.copyAppLogPath],
      ["Copy session ID", threadActions.copySessionId, "h-thread-123"],
      ["Go to config", threadActions.openAppConfig],
      ["Report issue", threadActions.reportThreadIssue, "h-thread-123"],
    ];
    for (const [name, action, ...args] of actions) {
      await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));
      await user.click(screen.getByRole("menuitem", { name }));
      expect(action).toHaveBeenCalledWith(...args);
    }
  });


  it("does not re-render while a reply streams into the open thread", () => {
    seed([thread("a", { status: "running", items: [{ itemId: "m", kind: "agentMessage", status: "inProgress", text: "Hel" }] }), thread("b"), thread("c")]);
    const commits = mount();
    commits.count = 0;
    // What a stream frame does to the store: replace the running thread and its items.
    for (let frame = 0; frame < 8; frame += 1) {
      act(() => {
        useAppStore.setState((state) => ({
          threads: state.threads.map((item) => item.sessionId === "a"
            ? { ...item, unread: false, items: [{ itemId: "m", kind: "agentMessage", status: "inProgress", text: `Hello ${"…".repeat(frame + 1)}` }] }
            : item),
        }));
      });
    }
    expect(commits.count, "eight stream frames, no sidebar work").toBe(0);
  });

  it("still updates when something a row shows changes", () => {
    seed([thread("a", { status: "running" }), thread("b")]);
    const commits = mount();
    expect(screen.getByLabelText("Running")).toBeInTheDocument();
    commits.count = 0;
    act(() => {
      useAppStore.setState((state) => ({ threads: state.threads.map((item) => item.sessionId === "a" ? { ...item, status: "idle" as const, lastOutcome: "completed" as const } : item) }));
    });
    expect(commits.count).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Running")).toBeNull();
    act(() => {
      useAppStore.setState((state) => ({ threads: state.threads.map((item) => item.sessionId === "b" ? { ...item, title: "Renamed elsewhere" } : item) }));
    });
    expect(screen.getByText("Renamed elsewhere")).toBeInTheDocument();
  });

  it("filters threads by their content while a search is active", async () => {
    seed([
      thread("a", { title: "Alpha", items: [{ itemId: "1", kind: "agentMessage", status: "completed", text: "the reconciliation step" }] }),
      thread("b", { title: "Beta", items: [{ itemId: "2", kind: "agentMessage", status: "completed", text: "nothing relevant" }] }),
    ]);
    mount();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Search threads" }));
    await user.type(screen.getByRole("textbox", { name: "Search threads" }), "reconcil");
    await screen.findByText("Alpha");
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("does not ask for a provider key before detection has answered", async () => {
    seed([]);
    seedStore({ detectionChecked: false, detection: null, agents: [] });
    render(<Sidebar />);
    expect(screen.getByText("Starting the agent…")).toBeInTheDocument();
    expect(screen.queryByText("Add a provider key")).toBeNull();
    // An empty list reads as loading, not as "No threads yet", until then.
    expect(screen.getByText("Loading threads…")).toBeInTheDocument();
    act(() => { useAppStore.setState({ detectionChecked: true }); });
    expect(screen.getByText("Add a provider key")).toBeInTheDocument();
    expect(screen.getByText("No threads yet")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Add a provider key" }));
    expect(useAppStore.getState().settingsOpen).toBe(true);
    expect(useAppStore.getState().settingsTab).toBe("Models & providers");
  });

  it("opens Usage straight from the footer beside the profile and Settings controls", async () => {
    seed([]);
    seedStore({ agents: [{ id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "", authenticated: true }] });
    render(<Sidebar />);
    expect(screen.getByRole("button", { name: "Profile menu, Profile" })).toHaveTextContent("Profile");
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(screen.queryByText("Glitter")).not.toBeInTheDocument();
    const usage = screen.getByRole("button", { name: "Usage" });
    expect(usage.closest(".sidebar-foot")).not.toBeNull();
    expect(usage).not.toHaveTextContent("Usage");
    expect(screen.getByRole("button", { name: "Settings" })).not.toHaveTextContent("Settings");
    await userEvent.setup().click(usage);
    expect(screen.queryByRole("dialog", { name: "Usage" })).not.toBeInTheDocument();
    expect(useAppStore.getState().settingsOpen).toBe(true);
    expect(useAppStore.getState().settingsTab).toBe("Usage");
  });

  it("opens App theme, Usage stats and shortcuts from the profile menu", async () => {
    seed([]);
    seedStore({ agents: [{ id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "", authenticated: true }] });
    const user = userEvent.setup();
    render(<Sidebar />);
    await user.click(screen.getByRole("button", { name: "Profile menu, Profile" }));
    const menu = screen.getByRole("menu", { name: "Profile" });
    expect(within(menu).getByRole("menuitem", { name: "Usage stats" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Commands & shortcuts" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /^Settings/ })).toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: "App theme" }));
    expect(useAppStore.getState().settingsTab).toBe("Theme");
    await user.click(screen.getByRole("button", { name: "Profile menu, Profile" }));
    await user.click(screen.getByRole("menuitem", { name: "Usage stats" }));
    expect(useAppStore.getState().settingsTab).toBe("Usage");
    await user.click(screen.getByRole("button", { name: "Profile menu, Profile" }));
    await user.click(screen.getByRole("menuitem", { name: "Commands & shortcuts" }));
    expect(useAppStore.getState().settingsTab).toBe("Shortcuts");
  });

  it("supports keyboard navigation in the profile menu and returns focus on Escape", async () => {
    seed([]);
    const user = userEvent.setup();
    render(<Sidebar />);
    const trigger = screen.getByRole("button", { name: "Profile menu, Profile" });
    expect(trigger).toHaveTextContent("Profile");
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "App theme" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Usage stats" })).toHaveFocus();
    expect(screen.getByText("Preferences on this Mac")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu", { name: "Profile" })).not.toBeInTheDocument();
  });


  it("puts New thread and Settings in the sidebar, and leaves Extensions to Settings", async () => {
    seed([]);
    render(<Sidebar />);
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New thread" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Extensions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Usage" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
    expect(useAppStore.getState().settingsOpen).toBe(true);
  });

  it("keeps each list in sidebar order and gathers work waiting on you, anywhere, into one row", async () => {
    const selectNextAttentionThread = vi.fn(async () => {});
    seedTwo([
      thread("b", { title: "Idle one", order: 3 }),
      thread("a", { status: "running", title: "Running one", order: 2 }),
      thread("q", { title: "Waiting", status: "running", pendingApproval: approval("q"), order: 1 }),
      thread("z", { workspacePath: "/other", title: "Blocked", status: "running", pendingApproval: approval("z") }),
    ]);
    seedStore({ selectNextAttentionThread });
    render(<Sidebar />);
    // The list does not reshuffle as threads start and stop: the order is the one the shortcuts walk.
    expect(within(screen.getByRole("list")).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Idle one"),
      expect.stringContaining("Running one"),
      expect.stringContaining("Waiting"),
    ]);
    // A closed workspace flags its blocked thread on its row instead of listing it.
    expect(within(screen.getByRole("button", { name: /^other/ })).getByLabelText("A thread needs your attention")).toBeInTheDocument();
    expect(screen.queryByText("Blocked")).toBeNull();
    // No filter control anywhere.
    expect(screen.queryByRole("button", { name: "All" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Live/ })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "2 threads need you" }));
    expect(selectNextAttentionThread).toHaveBeenCalledTimes(1);
  });

  it("shows no attention row while nothing waits on you", () => {
    seedTwo([thread("a", { status: "running" }), thread("z", { workspacePath: "/other", status: "running" })]);
    render(<Sidebar />);
    expect(screen.queryByRole("button", { name: /need(s)? you/ })).toBeNull();
    // A closed workspace with work in flight says so on its row.
    expect(within(screen.getByRole("button", { name: /^other/ })).getByLabelText("A thread is running")).toBeInTheDocument();
  });

  it("keeps thread search behind its title-bar icon until it is opened, and folds it on Escape", async () => {
    seed([]);
    render(<Sidebar />);
    const user = userEvent.setup();
    const icon = screen.getByRole("button", { name: "Search threads" });
    expect(icon.closest(".sidebar-rail")).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Search threads" })).toBeNull();
    await user.click(icon);
    const field = screen.getByRole("textbox", { name: "Search threads" });
    await waitFor(() => expect(field).toHaveFocus());
    await user.type(field, "auth");
    expect(useAppStore.getState().threadSearch).toBe("auth");
    await user.keyboard("{Escape}");
    expect(useAppStore.getState().threadSearch).toBe("");
    expect(useAppStore.getState().threadSearchOpen).toBe(false);
  });

  it("collapses from its own button", async () => {
    seed([]);
    render(<Sidebar />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    expect(screen.getByRole("button", { name: "Show sidebar" })).toBeInTheDocument();
  });

  it("keeps one toggle in the title bar, whichever way the sidebar is", async () => {
    seed([]);
    render(<Sidebar />);
    const toggle = screen.getByRole("button", { name: "Hide sidebar" });
    expect(toggle.closest(".sidebar-rail")).not.toBeNull();
    expect(toggle.closest("aside")).toBeNull();
    await userEvent.setup().click(toggle);
    // The same button, so it neither moves nor blinks under the pointer.
    expect(screen.getByRole("button", { name: "Show sidebar" })).toBe(toggle);
  });

  it("shows today's tokens beside the Usage mark in the foot, and only the mark when there are none", () => {
    seed([]);
    seedStore({ usageLedger: { version: 1, days: [], turns: [{ key: "k", at: Date.now() - 60_000, agentId: "muse", providerId: "meta", inputTokens: 38_200, cachedTokens: 0, outputTokens: 9_900, estimated: false, durationMs: 1_000, threadId: "a", workspace: "/repo", tools: {} }] } });
    render(<Sidebar />);
    const usage = screen.getByRole("button", { name: /^Usage, .+ tokens today$/ });
    expect(usage.closest(".sidebar-foot")).not.toBeNull();
    expect(usage.textContent).toMatch(/48/);
    act(() => { useAppStore.setState({ usageLedger: { version: 1, days: [], turns: [] } }); });
    expect(screen.getByRole("button", { name: "Usage" })).toHaveTextContent("");
  });




});

describe("collapsed sidebar", () => {
  beforeEach(() => {
    resetStore();
    seed([thread("a", { title: "Alpha" }), thread("b", { title: "Beta" })]);
    seedStore({ sidebarCollapsed: true });
  });

  it("opens from the toggle button only, not on hover", () => {
    render(<Sidebar />);
    const show = screen.getByRole("button", { name: "Show sidebar" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Alpha")).toBeNull();
    fireEvent.mouseEnter(show);
    fireEvent.mouseEnter(screen.getByRole("group", { name: "Sidebar" }));
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    fireEvent.click(show);
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    expect(screen.queryByText("Alpha")).toBeNull();
  });
});

describe("thread change counts", () => {
  beforeEach(resetStore);

  it("shows uncommitted lines only for threads working in the folder in view", () => {
    const edit = (itemId: string, path: string) => ({ itemId, kind: "toolCall" as const, status: "completed" as const, tool: "write_file", args: JSON.stringify({ path }) });
    seedTwo([
      thread("a", { items: [edit("1", "src/a.ts")] }),
      thread("b", { items: [edit("2", "src/untouched.ts")] }),
      thread("wt", { items: [edit("3", "src/a.ts")], worktree: { grantId: "g-wt", path: "/worktrees/one", branch: "muse/one", base: "main", workspaceId: "w" } }),
    ]);
    seedStore({ git: { repository: true, branch: "main", dirty: true, files: [{ path: "src/a.ts", status: " M", added: 12, removed: 3 }], diff: "", truncated: false } });
    render(<Sidebar />);
    const row = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) });
    expect(within(row("Thread a")).getByText("+12")).toBeInTheDocument();
    expect(within(row("Thread a")).getByText("−3")).toBeInTheDocument();
    expect(within(row("Thread b")).queryByText(/^\+/)).toBeNull();
    expect(within(row("Thread wt")).queryByText(/^\+/), "a worktree thread is not described by the workspace snapshot").toBeNull();
  });

  it("resizes from its edge with the keyboard and resets on double-click", () => {
    seedTwo([thread("a")]);
    const setSidebarWidth = vi.fn();
    seedStore({ sidebarWidth: 300, setSidebarWidth });
    const view = render(<Sidebar />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    const { min, max } = sidebarWidthBounds(window.innerWidth);
    expect(handle).toHaveAttribute("aria-valuenow", String(sidebarWidthFor(window.innerWidth, false, 300)));
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(setSidebarWidth).toHaveBeenLastCalledWith(sidebarWidthFor(window.innerWidth, false, 324));
    fireEvent.keyDown(handle, { key: "Home" });
    expect(setSidebarWidth).toHaveBeenLastCalledWith(min);
    fireEvent.keyDown(handle, { key: "End" });
    expect(setSidebarWidth).toHaveBeenLastCalledWith(max);
    fireEvent.doubleClick(handle);
    expect(setSidebarWidth).toHaveBeenLastCalledWith(null);
    act(() => seedStore({ sidebarCollapsed: true }));
    view.rerender(<Sidebar />);
    expect(screen.queryByRole("separator", { name: "Resize sidebar" })).toBeNull();
  });
});
