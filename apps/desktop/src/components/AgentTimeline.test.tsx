import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentTimeline, WorkingIndicator } from "./AgentTimeline";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import type { Thread, TranscriptItem } from "../lib/types";

// Every agent message renders one mark, so counting marks counts message renders.
const marks = vi.hoisted(() => ({ count: 0 }));
vi.mock("./AgentPicker", () => ({
  AgentMark: () => { marks.count += 1; return <span data-testid="agent-mark" />; },
}));
vi.mock("./Orb", () => ({ Orb: ({ state, paused }: { state: string; paused?: boolean }) => <span data-testid="thinking-orb" data-state={state} data-paused={paused} /> }));

describe("thinking orb preference", () => {
  beforeEach(resetStore);

  it("updates a live indicator, keeps automatic effort states and preserves paused and ACP indicators", () => {
    const view = render(<WorkingIndicator label="Thinking" />);
    expect(screen.getByTestId("thinking-orb")).toHaveAttribute("data-state", "working");
    view.rerender(<WorkingIndicator label="Thinking" peak />);
    expect(screen.getByTestId("thinking-orb")).toHaveAttribute("data-state", "solving");
    act(() => seedStore({ thinkingOrb: "weaving" }));
    expect(screen.getByTestId("thinking-orb")).toHaveAttribute("data-state", "weaving");
    view.rerender(<WorkingIndicator label="Waiting for approval" paused />);
    expect(screen.getByTestId("thinking-orb")).toHaveAttribute("data-state", "breathing");
    expect(screen.getByTestId("thinking-orb")).toHaveAttribute("data-paused", "true");
    view.rerender(<WorkingIndicator label="Thinking" agentId="opencode" />);
    expect(screen.queryByTestId("thinking-orb")).toBeNull();
    expect(screen.getByTestId("agent-mark")).toBeInTheDocument();
  });
});

const item = (partial: Partial<TranscriptItem>): TranscriptItem => ({
  itemId: `i-${Math.random().toString(36).slice(2)}`,
  kind: "toolCall",
  status: "completed",
  ...partial,
});

const thread = (partial: Partial<Thread> = {}): Thread => ({
  sessionId: "s1",
  workspacePath: "/repo",
  title: "Work",
  updatedAt: new Date().toISOString(),
  status: "idle",
  unread: false,
  items: [],
  ...partial,
});

function mount(t: Thread) {
  seedStore({ threads: [t], selectedSessionId: t.sessionId });
  return render(<AgentTimeline thread={t} />);
}

describe("message editing", () => {
  beforeEach(() => {
    resetStore();
    seedStore({ workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }], selectedWorkspaceId: "w" });
  });
  const prompts = () => [
    item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "First prompt" }),
    item({ itemId: "a1", kind: "agentMessage", turnId: "t1", text: "First reply" }),
    item({ itemId: "u2", kind: "userMessage", turnId: "t2", text: "Second prompt" }),
  ];

  it("forks an edited Muse message with an optional reset and keeps a failed edit open", async () => {
    const rewind = vi.fn(async () => false);
    seedStore({ rewindMessage: rewind, composer: "Unsent draft" });
    mount(thread({ historyExhausted: true, items: prompts(), snapshots: { t2: { snapshotId: "snap-2", sessionId: "s1", turnId: "t2", state: "ready", files: ["a.txt"], reason: null, createdAt: 1 } } }));
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Edit and rewind" })[1]);
    expect(screen.getByText(/Creates a fork before this message/)).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Edit message" }));
    await user.type(screen.getByRole("textbox", { name: "Edit message" }), "Revised prompt");
    await user.click(screen.getByRole("checkbox", { name: "Reset files too" }));
    expect(screen.getByText(/Resets only this turn’s saved files/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fork and send" }));
    expect(rewind).toHaveBeenCalledWith("s1", "u2", "Revised prompt", true);
    expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveValue("Revised prompt");
    expect(useAppStore.getState().composer).toBe("Unsent draft");
    seedStore({ threads: [thread({ items: prompts(), rewindError: { itemId: "u2", message: "Nothing was restored." } })] });
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was restored.");
  });

  it("labels the first message as starting a fresh thread and hides unavailable resets", async () => {
    mount(thread({ historyExhausted: true, items: [prompts()[0]], snapshots: { t1: { snapshotId: "snap-1", sessionId: "s1", turnId: "t1", state: "unavailable", files: [], reason: "Expired", createdAt: 1 } } }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Edit and rewind" }));
    expect(screen.getByText(/First message: starts a new thread/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start and send" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Reset files too" })).toBeNull();
  });

  it("cancels inline editing without touching the composer or sending", async () => {
    const rewind = vi.fn(async () => false); const send = vi.fn(async () => {});
    seedStore({ rewindMessage: rewind, sendPrompt: send, composer: "Keep this draft" });
    mount(thread({ items: prompts() }));
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Edit and rewind" })[1]);
    await user.type(screen.getByRole("textbox", { name: "Edit message" }), " edited{Escape}");
    expect(screen.queryByRole("textbox", { name: "Edit message" })).toBeNull();
    expect(rewind).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(useAppStore.getState().composer).toBe("Keep this draft");
  });

  it("shows a history-boundary error instead of appending a legacy message", async () => {
    const send = vi.fn(async () => {}); seedStore({ sendPrompt: send });
    mount(thread({ items: [item({ itemId: "old", kind: "userMessage", text: "Historical prompt" })], historyExhausted: true }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit and rewind" }));
    await user.click(screen.getByRole("button", { name: "Fork and send" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/no confirmed turn boundary/);
    expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveValue("Historical prompt");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps ACP editing as resend with the original attachments", async () => {
    const send = vi.fn(async () => {}); const rewind = vi.fn(async () => false);
    const images = [{ name: "a.png", mediaType: "image/png", base64Data: "aW1hZ2U=" }];
    const refs = [{ id: "r", kind: "file" as const, path: "a.ts" }];
    seedStore({ sendPrompt: send, rewindMessage: rewind });
    mount(thread({ agentId: "opencode", items: [item({ itemId: "u", kind: "userMessage", text: "Original", images, refs })] }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit and resend" }));
    await user.clear(screen.getByRole("textbox", { name: "Edit message" }));
    await user.type(screen.getByRole("textbox", { name: "Edit message" }), "Revised");
    await user.click(screen.getByRole("button", { name: "Resend" }));
    expect(send).toHaveBeenCalledWith({ resetTaskState: true }); expect(rewind).not.toHaveBeenCalled();
    expect(useAppStore.getState().composer).toBe("Revised");
    expect(useAppStore.getState().images).toEqual(images); expect(useAppStore.getState().contextRefs).toEqual(refs);
  });

  it("does not send while composing text or while a rewind is pending", async () => {
    const rewind = vi.fn(async () => false); seedStore({ rewindMessage: rewind });
    const source = thread({ items: prompts() }); mount(source);
    await userEvent.setup().click(screen.getAllByRole("button", { name: "Edit and rewind" })[1]);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit message" }), { key: "Enter", ctrlKey: true, isComposing: true });
    expect(rewind).not.toHaveBeenCalled();
    seedStore({ threads: [{ ...source, rewindPending: "u2" }] });
    expect(await screen.findByRole("button", { name: "Fork and send" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit message" }), { key: "Enter", metaKey: true });
    expect(rewind).not.toHaveBeenCalled();
  });
});

describe("AgentTimeline", () => {
  beforeEach(resetStore);

  it("renders user and agent message text", () => {
    mount(thread({
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "Fix the flaky login test" }),
        item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "Found the race in the token refresh" }),
      ],
    }));
    expect(screen.getByText("Fix the flaky login test")).toBeInTheDocument();
    expect(screen.getByText(/Found the race in the token refresh/)).toBeInTheDocument();
  });

  it("stops the plan's spinner once the turn has stopped", () => {
    const plan = [{ id: "p1", text: "Sidebar fixes", status: "inProgress" as const }, { id: "p2", text: "Tooltips", status: "pending" as const }];
    const items = [item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "go" }), item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "On it" })];
    const view = mount(thread({ status: "running", activeTurnId: "t1", plan, items }));
    expect(document.querySelector(".plan-item.inProgress .spin")).not.toBeNull();
    view.unmount();
    mount(thread({ status: "idle", lastTurnId: "t1", lastOutcome: "cancelled", plan, items }));
    expect(document.querySelector(".plan .spin")).toBeNull();
    expect(screen.getByText("Sidebar fixes").closest("li")).toHaveClass("pending");
  });

  it("offers Copy and Retry on the settled answer only, not on the notes between steps", () => {
    const items = [
      item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "Fix the flaky login test" }),
      item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "Reading the guide first" }),
      item({ itemId: "c1", tool: "read_file", turnId: "t1", args: "{}" }),
      item({ itemId: "m2", kind: "agentMessage", turnId: "t1", text: "Found the race" }),
    ];
    const actions = (id: string) => document.querySelector(`[data-item="${id}"] .msg-actions`);
    const view = mount(thread({ agentId: "grok", status: "running", activeTurnId: "t1", items }));
    expect(actions("m1"), "a note between steps").toBeNull();
    expect(actions("m2"), "the newest note of a turn still running").toBeNull();
    view.unmount();
    mount(thread({ agentId: "grok", lastTurnId: "t1", lastOutcome: "completed", items }));
    expect(actions("m1")).toBeNull();
    expect(actions("m2")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry last turn" })).toBeInTheDocument();
  });

  it("shows an Undo confirmation for saved files without discarding all uncommitted edits", async () => {
    seedStore({ workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }], selectedWorkspaceId: "w" });
    mount(thread({
      snapshots: { t1: { snapshotId: "snap-1", sessionId: "s1", turnId: "t1", state: "ready", files: ["src/a.ts", "src/b.ts"], reason: null, createdAt: 1 } },
      lastOutcome: "completed",
      lastTurnId: "t1",
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "rename both" }),
        item({ itemId: "e1", tool: "edit_file", turnId: "t1", args: JSON.stringify({ path: "src/a.ts", old_string: "x", new_string: "y" }) }),
        item({ itemId: "e2", tool: "write_file", turnId: "t1", args: JSON.stringify({ path: "src/b.ts", content: "new" }) }),
        item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "Both files updated." }),
      ],
    }));
    expect(screen.getByText("Changed 2 files")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    const dialog = useAppStore.getState().confirmDialog;
    expect(dialog?.danger).not.toBe(true);
    expect(dialog?.title).toContain("2 file changes");
    expect(dialog?.body).toContain("nothing is restored");
  });

  it("does not offer a destructive fallback for historical turns without snapshots", () => {
    mount(thread({ items: [item({ tool: "edit_file", turnId: "t1", args: '{"path":"src/a.ts"}' })] }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Revert files/ })).toBeNull();
    expect(screen.getByText(/without a saved file state/)).toBeInTheDocument();
  });

  it("shows native snapshot files and Reapply even when a shell made the changes", () => {
    mount(thread({ snapshots: { t1: { snapshotId: "snap-1", sessionId: "s1", turnId: "t1", state: "undone", files: ["shell-created.txt"], reason: null, createdAt: 1 } }, items: [item({ tool: "bash", turnId: "t1", commandText: "create a file" })] }));
    expect(screen.getByText("Changed 1 file")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reapply" })).toBeInTheDocument();
    expect(screen.getByText(/Thread history is kept/)).toBeInTheDocument();
  });

  it("explains an unavailable snapshot even without file-edit tool records", () => {
    mount(thread({ snapshots: { t1: { snapshotId: "snap-1", sessionId: "s1", turnId: "t1", state: "unavailable", files: [], reason: "Overlapping runs shared this workspace. Their changes cannot be separated.", createdAt: 1 } }, items: [item({ tool: "bash", turnId: "t1", commandText: "create a file" })] }));
    expect(screen.getByText(/Overlapping runs shared/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByText(/Changed 0 files/)).toBeNull();
  });

  it("labels an in-progress tool call as Running", () => {
    // The live turn's trailing steps fold into the status line, so the
    // in-progress run must be followed by a newer run to render its StepRow.
    mount(thread({
      status: "running",
      activeTurnId: "t2",
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "run tests" }),
        item({ itemId: "t-cmd", tool: "bash", turnId: "t1", status: "inProgress", args: JSON.stringify({ command: "npm test" }), commandText: "npm test" }),
        item({ itemId: "u2", kind: "userMessage", turnId: "t2", text: "and lint" }),
        item({ itemId: "m2", kind: "agentMessage", turnId: "t2", text: "On it." }),
      ],
    }));
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getByText("npm test")).toBeInTheDocument();
  });

  it("a streamed token re-renders only the message being written, not the settled thread", () => {
    const turns = 40;
    const settled: TranscriptItem[] = Array.from({ length: turns }, (_, n) => [
      item({ itemId: `u${n}`, kind: "userMessage", turnId: `t${n}`, text: `question ${n}` }),
      item({ itemId: `a${n}`, kind: "agentMessage", turnId: `t${n}`, text: `answer ${n}` }),
    ]).flat();
    const live = item({ itemId: "live", kind: "agentMessage", turnId: "t-live", status: "inProgress", text: "Working on" });
    const user = item({ itemId: "u-live", kind: "userMessage", turnId: "t-live", text: "go" });
    const make = (text: string) => thread({
      status: "running", activeTurnId: "t-live",
      items: [...settled, user, { ...live, text }],
    });
    const first = make("Working on");
    seedStore({ threads: [first], selectedSessionId: first.sessionId });
    marks.count = 0;
    const { rerender } = render(<AgentTimeline thread={first} />);
    expect(marks.count).toBe(turns + 1);

    marks.count = 0;
    const next = make("Working on it, and more");
    seedStore({ threads: [next], selectedSessionId: next.sessionId });
    rerender(<AgentTimeline thread={next} />);
    expect(screen.getByText(/Working on it, and more/)).toBeInTheDocument();
    // Before: every message on screen rendered again for every streamed frame.
    expect(marks.count).toBe(1);

    marks.count = 0;
    for (let frame = 0; frame < 5; frame += 1) {
      const streamed = make(`Working on it, and more ${"…".repeat(frame + 1)}`);
      seedStore({ threads: [streamed], selectedSessionId: streamed.sessionId });
      rerender(<AgentTimeline thread={streamed} />);
    }
    expect(marks.count).toBe(5);
  });

  it("a finished turn's receipt appears for the last run only once, without re-rendering earlier runs", () => {
    const items: TranscriptItem[] = [
      item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "one" }),
      item({ itemId: "e1", tool: "edit_file", turnId: "t1", args: JSON.stringify({ path: "src/a.ts" }) }),
      item({ itemId: "a1", kind: "agentMessage", turnId: "t1", text: "done one" }),
      item({ itemId: "u2", kind: "userMessage", turnId: "t2", text: "two" }),
      item({ itemId: "a2", kind: "agentMessage", turnId: "t2", text: "done two" }),
    ];
    const done = thread({ lastOutcome: "completed", lastTurnId: "t2", items });
    seedStore({ threads: [done], selectedSessionId: done.sessionId });
    render(<AgentTimeline thread={done} />);
    expect(screen.getAllByText("Changed 1 file")).toHaveLength(1);
    expect(screen.queryByText(/Run failed/)).toBeNull();
  });
});

describe("timeline edit and thought previews", () => {
  beforeEach(resetStore);
  it("shows the completed edit arguments as a diff and opens Changes", () => {
    mount(thread({ items: [
      item({ itemId: "u", kind: "userMessage", turnId: "t", text: "edit" }),
      item({ itemId: "e", turnId: "t", tool: "edit_file", args: JSON.stringify({ path: "src/a.ts", old_string: "const a = 1", new_string: "const a = 2" }), visibleOutput: "Applied" }),
    ] }));
    fireEvent.click(screen.getByRole("button", { name: /Edited\s*src\/a.ts/ }));
    expect(screen.getByLabelText("Edit preview")).toHaveTextContent("- const a = 1");
    expect(screen.getByLabelText("Edit preview")).toHaveTextContent("+ const a = 2");
    fireEvent.click(screen.getByRole("button", { name: "Open in Changes" }));
    expect(useAppStore.getState().inspectorTab).toBe("changes");
    expect(useAppStore.getState().dockOpen).toBe(true);
  });
  it("shows the saved before and after when a write overwrote a file", () => {
    mount(thread({ items: [
      item({
        itemId: "w",
        turnId: "t",
        tool: "write_file",
        args: JSON.stringify({ path: "a.txt", content: "after" }),
        presentation: { kind: "diff", path: "a.txt", oldText: "before", newText: "after" },
      }),
    ] }));
    fireEvent.click(screen.getByRole("button", { name: /Edited\s*a.txt/ }));
    expect(screen.getByLabelText("Edit preview")).toHaveTextContent("- before");
    expect(screen.getByLabelText("Edit preview")).toHaveTextContent("+ after");
  });
  it("keeps failed edits as errors without claiming an applied change", () => {
    mount(thread({ items: [item({ tool: "edit_file", status: "failed", args: JSON.stringify({ old_string: "old", new_string: "new" }), failureReason: "Not found" })] }));
    expect(screen.queryByLabelText("Edit preview")).toBeNull();
    expect(screen.getByText("Not found")).toBeInTheDocument();
  });
  it("shows the first thought line once when expanded", () => {
    mount(thread({ items: [item({ kind: "reasoning", text: "Unique opening line\n\nMore detail" })] }));
    fireEvent.click(screen.getByRole("button", { name: /Thought\s*Unique opening line/ }));
    expect(screen.getAllByText("Unique opening line")).toHaveLength(1);
    expect(document.querySelector(".reasoning .step-summary")).toBeNull();
  });
});
