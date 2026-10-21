import { Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import { useAppStore } from "../lib/store";
import { sidebarWidthBounds, sidebarWidthFor } from "../lib/reviewLayout";
import { resetStore, seedStore } from "../test/store";
import type { ApprovalRequest, Thread } from "../lib/types";

const exporter = vi.hoisted(() => ({ exportSession: vi.fn() }));
vi.mock("../lib/bridge", async (original) => ({ ...(await original<typeof import("../lib/bridge")>()), exportSession: exporter.exportSession }));

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
  beforeEach(resetStore);

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

  it("flags a collapsed workspace that holds a blocked thread", () => {
    seedTwo([thread("a"), thread("z", { workspacePath: "/other", title: "Blocked", status: "running", pendingApproval: approval("z") })]);
    render(<Sidebar />);
    const other = screen.getByRole("button", { name: /^other/ });
    expect(within(other).getByLabelText("A thread needs your attention")).toBeInTheDocument();
    expect(screen.queryByText("Blocked")).toBeNull();
  });

  it("finds threads in collapsed workspaces without expanding them for good", async () => {
    const { loadWorkspaceThreads } = seedTwo([thread("a", { title: "Alpha" }), thread("z", { workspacePath: "/other", title: "Deploy notes" })]);
    render(<Sidebar />);
    expect(screen.queryByText("Deploy notes")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Search threads" }));
    await user.type(await screen.findByRole("textbox", { name: "Search threads" }), "deploy");
    await screen.findByText("Deploy notes");
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(loadWorkspaceThreads).toHaveBeenCalledWith("w2");
    // The caret hides a revealed group for this search only.
    await user.click(screen.getByRole("button", { name: "Collapse other" }));
    expect(screen.queryByText("Deploy notes")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand other" }));
    expect(screen.getByText("Deploy notes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(screen.queryByText("Deploy notes")).toBeNull());
    expect(screen.getByRole("button", { name: "Expand other" })).toBeInTheDocument();
  });

  it("archives from the thread menu and opens the archive from the sidebar", async () => {
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
    await user.type(await screen.findByRole("textbox", { name: "Search threads" }), "reconcil");
    await screen.findByText("Alpha");
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("does not claim 'No agent CLI found' before detection has answered", () => {
    seed([]);
    seedStore({ detectionChecked: false, detection: null, agents: [] });
    render(<Sidebar />);
    expect(screen.getByText("Checking agents…")).toBeInTheDocument();
    expect(screen.queryByText("No agent CLI found")).toBeNull();
    // An empty list reads as loading, not as "No threads yet", until then.
    expect(screen.getByText("Loading threads…")).toBeInTheDocument();
    act(() => { useAppStore.setState({ detectionChecked: true }); });
    expect(screen.getByText("No agent CLI found")).toBeInTheDocument();
    expect(screen.getByText("No threads yet")).toBeInTheDocument();
  });

  it("opens an account menu from the footer, with usage on demand", async () => {
    seed([]);
    seedStore({
      detection: { found: true, path: "/bin/muse", version: "Muse Code 3.14.3", authenticated: true, method: "auth.json", accountName: "Ada" },
      subscriptionUsage: {
        observedAtMs: Date.now(),
        tier: "pro",
        window: { usedPercent: 42, resetsAtMs: Date.now() + 60 * 60_000, windowDurationMins: 300 },
        weekly: { usedPercent: 18, resetsAtMs: Date.now() + 3 * 24 * 60 * 60_000 },
      },
    });
    render(<Sidebar />);
    const user = userEvent.setup();
    expect(screen.queryByRole("status", { name: "Subscription usage" })).not.toBeInTheDocument();
    const account = screen.getByRole("button", { name: "Account menu, Ada" });
    expect(account.closest(".sidebar-bottom")).not.toBeNull();
    await user.click(account);
    const menu = screen.getByRole("menu", { name: "Account" });
    const usage = within(menu).getByRole("menuitem", { name: /Usage/ });
    expect(usage).toHaveTextContent("42% used");
    await user.click(usage);
    const meter = within(menu).getByRole("status", { name: "Subscription usage" });
    expect(within(meter).getByText("42%")).toBeInTheDocument();
    expect(within(meter).getByText("18%")).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Appearance" }));
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
    expect(useAppStore.getState().settingsOpen).toBe(true);
    expect(useAppStore.getState().settingsTab).toBe("Theme");
  });

  it("keeps Extensions, Usage and Settings out of the sidebar's rows; the account menu still opens Settings", async () => {
    seed([]);
    render(<Sidebar />);
    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(within(primary).getAllByRole("button").map((button) => button.textContent)).toEqual([expect.stringContaining("New thread")]);
    for (const name of ["Extensions", "Usage", "Settings"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Account menu/ }));
    await user.click(within(screen.getByRole("menu", { name: "Account" })).getByRole("menuitem", { name: /Settings/ }));
    expect(useAppStore.getState().settingsOpen).toBe(true);
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

  it("closes the account menu on Escape and on an outside click", async () => {
    seed([]);
    render(<Sidebar />);
    const user = userEvent.setup();
    const account = screen.getByRole("button", { name: /Account menu/ });
    await user.click(account);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
    await user.click(account);
    expect(screen.getByRole("menu", { name: "Account" })).toBeInTheDocument();
    await waitFor(async () => { await user.click(document.body); expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument(); });
  });

  it("shows the CLI update row with release notes when an update is available", async () => {
    seed([]);
    const refreshCliUpdate = vi.fn();
    const updateCli = vi.fn();
    seedStore({
      detection: { found: true, path: "/bin/muse", version: "Muse Code 3.14.3", authenticated: true, method: "auth.json" },
      cliUpdate: { available: true, current: "3.14.3-R1", latest: "3.14.4-R2", urgency: "encouraged", notification: "Faster startup.", channel: "muse-stable" },
      cliUpdateAt: Date.now(),
      refreshCliUpdate,
      updateCli,
    });
    render(<Sidebar />);
    const user = userEvent.setup();
    const update = screen.getByRole("button", { name: /Muse CLI update available/ });
    const updateWrap = update.closest(".update-wrap");
    expect(updateWrap?.parentElement).toHaveClass("sidebar-bottom");
    expect(updateWrap?.nextElementSibling).toHaveClass("sidebar-foot");
    await user.click(update);
    const dialog = screen.getByRole("dialog", { name: "Muse CLI update" });
    expect(within(dialog).getByText("Faster startup.")).toBeInTheDocument();
    expect(within(dialog).getByText("Recommended")).toBeInTheDocument();
    expect(within(dialog).getByText("v3.14.3-R1")).toBeInTheDocument();
    expect(within(dialog).getByText("v3.14.4-R2")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Update now" }));
    expect(updateCli).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole("button", { name: "Check again" }));
    expect(refreshCliUpdate).toHaveBeenCalledWith(true);
  });

  it("hides the CLI update row when the channel has nothing newer", () => {
    seed([]);
    seedStore({ cliUpdate: { available: false, current: "3.14.4-R2", latest: "3.14.4-R2", urgency: "none", notification: "", channel: "muse-stable" } });
    render(<Sidebar />);
    expect(screen.queryByRole("button", { name: /Muse CLI update available/ })).toBeNull();
    expect(screen.queryByText("CLI update")).toBeNull();
  });

  it("flags the CLI update in the collapsed rail", async () => {
    seed([]);
    seedStore({
      sidebarCollapsed: true,
      cliUpdate: { available: true, current: "3.14.3-R1", latest: "3.14.4-R2", urgency: "must_download", notification: "", channel: "muse-stable" },
    });
    render(<Sidebar />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "CLI update available — show sidebar" }));
    expect(screen.getByRole("button", { name: /Muse CLI update available/ })).toBeInTheDocument();
  });

  it("reports an export through the app's own dialog rather than a native alert", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    seed([thread("a", { title: "Alpha" })]);
    render(<Sidebar />);
    const user = userEvent.setup();

    exporter.exportSession.mockResolvedValueOnce("/tmp/alpha.json");
    await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    await user.click(await screen.findByRole("menuitem", { name: "Export" }));
    await user.click(await screen.findByRole("menuitem", { name: /Export raw JSON/ }));
    await waitFor(() => expect(useAppStore.getState().confirmDialog).toMatchObject({ title: "Session exported", body: "/tmp/alpha.json", info: true }));
    act(() => useAppStore.getState().resolveConfirm(true));
    expect(exporter.exportSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "a", title: "Alpha", redacted: false, markdown: false }));

    exporter.exportSession.mockResolvedValueOnce("/tmp/alpha.md");
    await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    await user.click(await screen.findByRole("menuitem", { name: "Export" }));
    await user.click(await screen.findByRole("menuitem", { name: /Export share-safe Markdown/ }));
    await waitFor(() => expect(useAppStore.getState().confirmDialog).toMatchObject({ title: "Session exported", body: "/tmp/alpha.md", info: true }));
    act(() => useAppStore.getState().resolveConfirm(true));
    expect(exporter.exportSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "a", title: "Alpha", redacted: true, markdown: true }));

    exporter.exportSession.mockRejectedValueOnce(new Error("disk full"));
    await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    await user.click(await screen.findByRole("menuitem", { name: "Export" }));
    await user.click(await screen.findByRole("menuitem", { name: /Export share-safe JSON/ }));
    await waitFor(() => expect(useAppStore.getState().confirmDialog?.title).toBe("Could not export this Muse thread"));
    expect(useAppStore.getState().confirmDialog?.body).toContain("disk full");
    expect(useAppStore.getState().confirmDialog?.info).toBe(true);
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
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
