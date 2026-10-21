import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import { indentText } from "../lib/composerText";
import type { Thread } from "../lib/types";

// The model picker sits in the composer's tree; counting its renders counts composer renders.
const pickerRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./ModelPicker", async (original) => {
  const actual = await original<typeof import("./ModelPicker")>();
  return { ...actual, ModelPicker: (props: Parameters<typeof actual.ModelPicker>[0]) => { pickerRenders.count += 1; return actual.ModelPicker(props); } };
});

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

function seedWorkspace(threadPatch: Partial<Thread> = {}) {
  seedStore({
    workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }],
    selectedWorkspaceId: "w",
    threads: [thread(threadPatch)],
    selectedSessionId: "s1",
    preview: false,
  });
}

describe("Composer", () => {
  beforeEach(resetStore);

  // WCAG 2.1.2 — No Keyboard Trap (Level A).
  it("Tab moves focus out of the composer instead of trapping the keyboard", () => {
    seedWorkspace();
    useAppStore.setState({ composer: "hello" });
    render(<Composer />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    box.setSelectionRange(5, 5);

    const propagated = fireEvent.keyDown(box, { key: "Tab" });

    expect(propagated, "Tab must not be preventDefault-ed with no selection").toBe(true);
    expect(box.value, "an unselected Tab must not edit the draft").toBe("hello");
  });

  it("Shift+Tab also leaves the composer when nothing is selected", () => {
    seedWorkspace();
    useAppStore.setState({ composer: "hello" });
    render(<Composer />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    box.setSelectionRange(5, 5);

    const propagated = fireEvent.keyDown(box, { key: "Tab", shiftKey: true });

    expect(propagated, "Shift+Tab must still traverse backwards out of the field").toBe(true);
    expect(box.value).toBe("hello");
  });

  it("Tab still indents when text is selected", () => {
    seedWorkspace();
    useAppStore.setState({ composer: "alpha" });
    render(<Composer />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    box.setSelectionRange(0, 5);

    const propagated = fireEvent.keyDown(box, { key: "Tab" });

    expect(propagated, "a selection is an explicit editing gesture, so Tab is consumed").toBe(false);
    expect(box.value).toBe(indentText("alpha", 0, 5).text);
    expect(box.value).not.toBe("alpha");
  });

  it("Enter sends; Shift+Enter inserts a newline instead", async () => {
    const sendPrompt = vi.fn();
    useAppStore.setState({ sendPrompt: sendPrompt as never });
    seedWorkspace();
    const user = userEvent.setup();
    render(<Composer />);
    const box = screen.getByRole("combobox");
    await user.type(box, "hello");
    await user.keyboard("{Enter}");
    expect(sendPrompt).toHaveBeenCalledTimes(1);

    sendPrompt.mockClear();
    useAppStore.setState({ composer: "" });
    await user.type(box, "a{Shift>}{Enter}{/Shift}b");
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(useAppStore.getState().composer).toBe("a\nb");
  });

  it("offers queue, steer, and replace while a harness turn runs", () => {
    seedWorkspace({ agentId: "harness", status: "running", activeTurnId: "t1" });
    useAppStore.setState({ composer: "follow up" });
    render(<Composer />);
    expect(screen.getByRole("button", { name: "What to do with this message while a turn runs" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Queue a follow-up/)).toBeInTheDocument();
  });

  it("keeps Stop-to-send for an ACP agent while a turn runs", () => {
    seedWorkspace({ agentId: "opencode", status: "running", activeTurnId: "t1" });
    useAppStore.setState({ composer: "follow up" });
    render(<Composer />);
    expect(screen.queryByRole("button", { name: "What to do with this message while a turn runs" })).toBeNull();
    expect(screen.getByPlaceholderText(/Stop to send a new message/)).toBeInTheDocument();
  });

  it("shows Stop instead of Send while the turn runs and calls stopTurn", async () => {
    const stopTurn = vi.fn();
    useAppStore.setState({ stopTurn: stopTurn as never });
    seedWorkspace({ status: "running", activeTurnId: "t1" });
    const user = userEvent.setup();
    render(<Composer />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(stopTurn).toHaveBeenCalledTimes(1);
  });

  it("@-mention offers fuzzy matches from the workspace file index", async () => {
    seedWorkspace();
    seedStore({ fileIndex: { workspaceId: "w", paths: ["src/components/Composer.tsx", "README.md"], loadedAt: Date.now() } });
    const user = userEvent.setup();
    render(<Composer />);
    await user.type(screen.getByRole("combobox"), "@Comp");
    const listbox = await screen.findByRole("listbox", { name: "File references" });
    expect(within(listbox).getByRole("option", { name: /Composer\.tsx/ })).toBeInTheDocument();
    expect(within(listbox).queryByRole("option", { name: /README/ })).toBeNull();
  });

  it("is disabled with the open-a-workspace reason when no workspace exists", () => {
    seedStore({ workspaces: [], selectedWorkspaceId: null, threads: [], selectedSessionId: null });
    render(<Composer />);
    const box = screen.getByPlaceholderText("Open a workspace to start");
    expect(box).toBeDisabled();
  });

  it("does not re-render while the transcript streams, and still reacts to a status change", () => {
    seedWorkspace({ status: "running", activeTurnId: "t1", items: [{ itemId: "m", kind: "agentMessage", status: "inProgress", text: "Hel" }] });
    render(<Composer />);
    pickerRenders.count = 0;
    // What a delta flush does: the thread object and its items change, nothing else.
    for (let frame = 0; frame < 6; frame += 1) {
      act(() => {
        useAppStore.setState((state) => ({
          threads: state.threads.map((item) => ({ ...item, items: [{ itemId: "m", kind: "agentMessage", status: "inProgress", text: `Hello ${"…".repeat(frame + 1)}` }] })),
        }));
      });
    }
    expect(pickerRenders.count, "six stream frames, zero composer renders").toBe(0);
    act(() => {
      useAppStore.setState((state) => ({ threads: state.threads.map((item) => ({ ...item, status: "idle", activeTurnId: null })) }));
    });
    expect(pickerRenders.count).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("offers @-mentions from paths the agent touched, read from the transcript on demand", async () => {
    seedWorkspace({ items: [{ itemId: "e", kind: "toolCall", status: "completed", tool: "read_file", args: JSON.stringify({ path: "src/lib/store.ts" }) }] });
    const user = userEvent.setup();
    render(<Composer />);
    await user.type(screen.getByRole("combobox"), "@store");
    const listbox = await screen.findByRole("listbox", { name: "File references" });
    expect(within(listbox).getByRole("option", { name: /store\.ts/ })).toBeInTheDocument();
  });

  it("completes a word from recent transcript text with Tab", async () => {
    seedWorkspace({ items: [{ itemId: "m", kind: "agentMessage", status: "completed", text: "The reconciliation step finished." }] });
    const user = userEvent.setup();
    render(<Composer />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    await user.click(box);
    await user.type(box, "reconc");
    expect(document.querySelector(".ghost-suffix")?.textContent).toBe("iliation");
  });

  it("Esc stops a running turn, but dismisses an open @-menu first", async () => {
    const stopTurn = vi.fn();
    useAppStore.setState({ stopTurn: stopTurn as never });
    seedWorkspace({ status: "running", activeTurnId: "t1" });
    seedStore({ fileIndex: { workspaceId: "w", paths: ["src/components/Composer.tsx"], loadedAt: Date.now() } });
    const user = userEvent.setup();
    render(<Composer />);
    const box = screen.getByRole("combobox");
    await user.type(box, "@Comp");
    await screen.findByRole("listbox", { name: "File references" });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(stopTurn, "the first Esc closes the menu and leaves the run alone").not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: "File references" })).toBeNull();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(stopTurn, "with nothing left to dismiss, Esc stops the turn").toHaveBeenCalledTimes(1);
  });

  it("Esc does nothing when no turn is running", () => {
    const stopTurn = vi.fn();
    useAppStore.setState({ stopTurn: stopTurn as never });
    seedWorkspace();
    render(<Composer />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(stopTurn).not.toHaveBeenCalled();
  });
});

describe("prompt history and agent capabilities", () => {
  beforeEach(() => {
    resetStore();
    seedWorkspace();
    seedStore({ promptHistory: { w: ["older prompt", "newer prompt"], elsewhere: ["private to another workspace"] } });
  });

  it("walks acknowledged prompts and restores the unsent draft", async () => {
    seedStore({ composer: "unsent draft" });
    const user = userEvent.setup();
    render(<Composer />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    await user.click(box);
    await user.keyboard("{ArrowUp}");
    expect(box.value).toBe("newer prompt");
    await user.keyboard("{ArrowUp}");
    expect(box.value).toBe("older prompt");
    await user.keyboard("{ArrowUp}");
    expect(box.value).toBe("older prompt");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(box.value).toBe("unsent draft");
  });

  it("leaves multiline movement, selections, modifiers and IME alone", () => {
    seedStore({ composer: "first\nsecond\nthird" });
    render(<Composer />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    box.setSelectionRange(8, 8);
    expect(fireEvent.keyDown(box, { key: "ArrowUp" })).toBe(true);
    expect(fireEvent.keyDown(box, { key: "ArrowDown" })).toBe(true);
    box.setSelectionRange(0, 3);
    expect(fireEvent.keyDown(box, { key: "ArrowUp" })).toBe(true);
    box.setSelectionRange(0, 0);
    expect(fireEvent.keyDown(box, { key: "ArrowUp", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(box, { key: "ArrowUp", isComposing: true })).toBe(true);
    expect(box.value).toBe("first\nsecond\nthird");
  });

  it("menu arrows choose options, and manual edits restart history navigation", async () => {
    const user = userEvent.setup();
    render(<Composer />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    await user.type(box, "/");
    await user.keyboard("{ArrowUp}");
    expect(box.value).toBe("/");
    await user.clear(box);
    await user.keyboard("{ArrowUp}");
    expect(box.value).toBe("newer prompt");
    await user.type(box, "edited");
    const edited = box.value;
    await user.keyboard("{ArrowUp}{ArrowDown}");
    expect(box.value).toBe(edited);
  });

  it("resets the cursor on a workspace switch and leaves attachments alone", async () => {
    seedStore({ contextRefs: [{ id: "file", kind: "file", path: "a.ts" }] });
    const user = userEvent.setup();
    render(<Composer />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    await user.click(box);
    await user.keyboard("{ArrowUp}");
    expect(useAppStore.getState().contextRefs).toHaveLength(1);
    act(() => seedStore({ selectedSessionId: null, selectedWorkspaceId: "elsewhere", composer: "", workspaces: [{ id: "elsewhere", path: "/elsewhere", name: "elsewhere" }] }));
    await user.keyboard("{ArrowUp}");
    expect(box.value).toBe("private to another workspace");
    await user.keyboard("{ArrowDown}");
    expect(box.value).toBe("");
  });

  it("puts ACP limits in a dismissible dialog and remembers Don’t show again", async () => {
    seedWorkspace({ agentId: "opencode" });
    seedStore({ theme: "light" });
    const view = render(<Composer />);
    expect(useAppStore.getState().confirmDialog).toMatchObject({ title: "OpenCode capabilities in Muse Code", confirmLabel: "Don’t show again" });
    expect(screen.queryByText(/threads can’t be forked or exported/)).toBeNull();
    await act(async () => useAppStore.getState().resolveConfirm(true));
    expect(useAppStore.getState().hideAgentCapabilities).toBe(true);
    view.unmount();
    render(<Composer />);
    expect(useAppStore.getState().confirmDialog).toBeNull();
  });

  it("keeps model errors and agent notices inside the composer, with an ACP retry", () => {
    seedWorkspace({ agentId: "grok", notice: { level: "warning", message: "Rate limited" } });
    const refreshModels = vi.fn(async () => {});
    const startHost = vi.fn(async () => {});
    seedStore({ hideAgentCapabilities: true, modelsError: "Catalog unavailable", refreshModels, startHost });
    render(<Composer />);
    for (const message of ["Catalog unavailable", "Rate limited"]) expect(screen.getByText(message).closest(".composer")).not.toBeNull();
    expect(document.querySelector(".composer-beam")?.nextElementSibling).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refreshModels).toHaveBeenCalled();
    expect(startHost).not.toHaveBeenCalled();
  });
});

describe("worktree thread", () => {
  beforeEach(resetStore);

  it("names the branch of a worktree thread and offers to apply it to Local", () => {
    seedWorkspace({ worktree: { grantId: "wt", path: "/worktrees/one", branch: "muse/one", base: "main", workspaceId: "w" } });
    render(<Composer />);
    expect(screen.getByText("muse/one")).toBeInTheDocument();
    expect(screen.getByText(/started from main/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply to Local" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply to Local" }).closest(".composer")).not.toBeNull();
  });
});

describe("built-in slash commands", () => {
  beforeEach(resetStore);

  it("keeps focus on the effort choices after removing the slash command from the draft", async () => {
    seedWorkspace();
    seedStore({ models: [{ modelId: "muse-spark-1.3", isActive: true }], modelsAgentId: "muse" });
    const user = userEvent.setup();
    render(<Composer />);
    const box = screen.getByRole("combobox");
    await user.type(box, "/effort{Enter}");
    await vi.waitFor(() => expect(screen.getByRole("radio", { checked: true })).toHaveFocus());
    expect(useAppStore.getState().composer).toBe("");
    expect(screen.getByRole("dialog", { name: "Reasoning effort" })).toBeInTheDocument();
  });

  it("act at once, send nothing and leave the rest of the draft alone", async () => {
    seedWorkspace({ context: { usedTokens: 1000, windowTokens: 4000 } });
    const sendPrompt = vi.fn();
    useAppStore.setState({ sendPrompt });
    const user = userEvent.setup();
    render(<Composer />);
    const box = screen.getByRole("combobox");
    await user.type(box, "keep this{Shift>}{Enter}{/Shift}/ren");
    const listbox = await screen.findByRole("listbox", { name: "Slash commands" });
    expect(within(listbox).getByRole("option", { name: /\/rename/ })).toBeInTheDocument();
    const before = useAppStore.getState().titleEditRequest;
    await user.keyboard("{Enter}");
    expect(useAppStore.getState().titleEditRequest).toBe(before + 1);
    expect(useAppStore.getState().composer).toBe("keep this\n");
    expect(sendPrompt).not.toHaveBeenCalled();

    await user.clear(box);
    await user.type(box, "/mcp{Enter}");
    expect(useAppStore.getState().settingsOpen).toBe(true);
    expect(useAppStore.getState().settingsTab).toBe("Extensions");

    await user.clear(box);
    await user.type(box, "/status{Enter}");
    expect(useAppStore.getState().confirmDialog?.body).toMatch(/Session: s1\nAgent: Muse\nContext: 1K of 4K tokens \(25%\)/);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("drafts the review prompt for the scope in view, and lists each name once", async () => {
    seedWorkspace({ skills: [{ selector: "/plan", description: "Planner skill", argumentHint: "<goal>" }] as Thread["skills"] });
    useAppStore.setState({ reviewScope: "staged" });
    const user = userEvent.setup();
    render(<Composer />);
    const box = screen.getByRole("combobox");
    await user.type(box, "/");
    const listbox = await screen.findByRole("listbox", { name: "Slash commands" });
    expect(within(listbox).getAllByRole("option", { name: /\/plan/ })).toHaveLength(1);
    expect(within(listbox).getByText("<goal>")).toBeInTheDocument();
    expect(within(listbox).getAllByRole("option").length).toBeGreaterThan(6);
    await user.type(box, "review{Enter}");
    expect(useAppStore.getState().composer).toMatch(/^Review my staged changes/);
  });

  it("inserts a custom command as plain text with the caret at its argument slot", async () => {
    seedWorkspace();
    seedStore({ customCommands: [{ name: "standup", description: "Daily update", body: "Summarize commits since $ARGUMENTS as a standup." }] });
    const user = userEvent.setup();
    render(<Composer />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    await user.type(box, "/stand");
    const listbox = await screen.findByRole("listbox", { name: "Slash commands" });
    expect(within(listbox).getByText("Custom · Daily update")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(useAppStore.getState().composer).toBe("Summarize commits since  as a standup.");
    await vi.waitFor(() => expect(box.selectionStart).toBe("Summarize commits since ".length));
  });
});

describe("cost estimate", () => {
  beforeEach(resetStore);

  const priced = [{ modelId: "muse-spark-1.3", displayLabel: "Muse Spark", isActive: true, cost: { input: "1.25", output: "4.25", currency: "USD" } }];

  it("shows the thread's estimated cost beside context usage", async () => {
    seedWorkspace({ context: { usedTokens: 1000, windowTokens: 4000 }, usage: { promptTokens: 48210, totalTokens: 61004, outputTokens: 12794 } });
    seedStore({ models: priced, modelsAgentId: "muse" });
    const user = userEvent.setup();
    render(<Composer />);
    await user.click(screen.getByRole("button", { name: /Context window/ }));
    const row = screen.getByText("Est. cost").parentElement as HTMLElement;
    expect(row).toHaveTextContent("$0.11");
    expect(within(row).getByText("$0.11")).toHaveAttribute("title", expect.stringContaining("Estimated from reported usage"));
  });

  it("omits the row without reported usage", () => {
    seedWorkspace({ context: { usedTokens: 1000, windowTokens: 4000 } });
    seedStore({ models: priced, modelsAgentId: "muse" });
    render(<Composer />);
    expect(screen.queryByText("Est. cost")).toBeNull();
  });

  it("shows cached tokens when the provider reported them", async () => {
    seedWorkspace({ context: { usedTokens: 100020, windowTokens: 200000, cacheReadTokens: 100000, cacheWriteTokens: 500 } });
    const user = userEvent.setup();
    render(<Composer />);
    await user.click(screen.getByRole("button", { name: /Context window/ }));
    expect(screen.getByText("Cached").parentElement).toHaveTextContent("100K");
    expect(screen.getByText("Cache write").parentElement).toHaveTextContent("500");
  });

  it("omits the row when the model has no price", () => {
    seedWorkspace({ context: { usedTokens: 1000, windowTokens: 4000 }, usage: { promptTokens: 48210, totalTokens: 61004, outputTokens: 12794 } });
    seedStore({ models: [{ ...priced[0], cost: null }], modelsAgentId: "muse" });
    render(<Composer />);
    expect(screen.queryByText("Est. cost")).toBeNull();
  });
});
