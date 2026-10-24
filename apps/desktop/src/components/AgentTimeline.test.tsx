import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentTimeline, WorkingIndicator } from "./AgentTimeline";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import type { Thread, TranscriptItem } from "../lib/types";

vi.mock("./AgentPicker", () => ({
  AgentMark: () => <span data-testid="agent-mark" />,
}));
// Every message renders its text through Markdown once, so counting those renders counts message renders.
const marks = vi.hoisted(() => ({ count: 0 }));
vi.mock("./Markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./Markdown")>();
  return { Markdown: (props: Parameters<typeof actual.Markdown>[0]) => { marks.count += 1; return <actual.Markdown {...props} />; } };
});
vi.mock("./Orb", () => ({ Orb: ({ state, paused, "aria-label": label }: { state: string; paused?: boolean; "aria-label"?: string }) => <span data-testid="thinking-orb" data-state={state} data-paused={paused} data-label={label} /> }));

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
    view.rerender(<WorkingIndicator label="Thinking" agentId="harness" />);
    expect(screen.getByTestId("thinking-orb")).toBeInTheDocument();
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

describe("live status line", () => {
  beforeEach(resetStore);

  it("uses the work rows for live steps and never repeats a compaction as one", () => {
    render(<WorkingIndicator label="Working" live={[
      { id: "c1", kind: "compaction", status: "completed", title: "Compaction", detail: "Context compacted", item: item({ itemId: "c1", kind: "compaction" }) },
      { id: "s1", kind: "command", status: "running", title: "Command", command: "npm test", item: item({ itemId: "s1", status: "inProgress", tool: "bash", commandText: "npm test", args: '{"command":"npm test"}' }) },
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Working/ }));
    expect(screen.queryByText("Compacted context")).toBeNull();
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText("npm test").closest(".working-detail")).toHaveAttribute("aria-live", "off");
  });

  it("keeps a streamed thought inside the working row until that row is opened", () => {
    render(<WorkingIndicator label="Thinking" live={[
      { id: "th", kind: "reasoning", status: "running", title: "Planning", detail: "Private chain\n\nShould stay inside the row.", item: item({ itemId: "th", kind: "reasoning", text: "Private chain" }) },
    ]} />);
    expect(screen.queryByText("Private chain")).toBeNull();
    expect(screen.queryByText("Should stay inside the row.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Thinking/ }));
    expect(screen.getByText("Should stay inside the row.").closest(".thought")).not.toBeNull();
  });
});

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
    const rewind = vi.fn(async () => false); const send = vi.fn(async () => true);
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
    const send = vi.fn(async () => true); seedStore({ sendPrompt: send });
    mount(thread({ items: [item({ itemId: "old", kind: "userMessage", text: "Historical prompt" })], historyExhausted: true }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit and rewind" }));
    await user.click(screen.getByRole("button", { name: "Fork and send" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/no confirmed turn boundary/);
    expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveValue("Historical prompt");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps ACP editing as resend with the original attachments", async () => {
    const send = vi.fn(async () => true); const rewind = vi.fn(async () => false);
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

  it("shows real message times beside above-opening, inward-aligned tooltips", () => {
    const sentAt = "2026-10-25T00:47:00+05:30";
    const answeredAt = "2026-10-25T00:49:00+05:30";
    const label = (value: string) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    mount(thread({
      lastOutcome: "completed",
      lastTurnId: "t1",
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "Fix the tooltip", recordedAt: sentAt }),
        item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "Fixed.", recordedAt: answeredAt }),
      ],
    }));
    const userMessage = screen.getByText("Fix the tooltip").closest(".msg.user") as HTMLElement;
    const agentMessage = screen.getByText("Fixed.").closest(".msg.agent") as HTMLElement;
    const sentTime = within(userMessage).getByText(label(sentAt));
    expect(sentTime).toHaveAttribute("datetime", sentAt);
    expect(sentTime).toHaveClass("msg-time");
    expect(sentTime.closest(".msg-actions")).toBeNull();
    expect(within(agentMessage).getByText(label(answeredAt))).toHaveAttribute("datetime", answeredAt);
    expect(within(userMessage).getByRole("button", { name: "Copy message" })).toHaveAttribute("data-tooltip-side", "top");
    expect(within(userMessage).getByRole("button", { name: "Copy message" })).toHaveAttribute("data-tooltip-align", "end");
    expect(within(agentMessage).getByRole("button", { name: "Copy message" })).toHaveAttribute("data-tooltip-align", "start");
  });

  it("puts no provider mark on a turn, live or settled", () => {
    const items = [
      item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "go" }),
      item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "Done." }),
    ];
    for (const agentId of ["harness", "opencode", "grok"] as const) {
      for (const state of [{ status: "running" as const, activeTurnId: "t1" }, { status: "idle" as const, lastTurnId: "t1", lastOutcome: "completed" as const }]) {
        const view = mount(thread({ agentId, items, ...state }));
        expect(document.querySelector(".agent-message-head")).toBeNull();
        expect(screen.queryByTestId("agent-mark")).toBeNull();
        expect(screen.queryByTestId("thinking-orb")).toBeNull();
        view.unmount();
      }
    }
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

  it("keeps Review after a completed answer without an edit or usage summary", async () => {
    mount(thread({
      lastOutcome: "completed",
      lastTurnId: "t1",
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "explain this" }),
        item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "Here is the explanation." }),
      ],
    }));
    const done = screen.getByRole("region", { name: "Done" });
    expect(screen.queryByRole("region", { name: "Changed files" })).toBeNull();
    expect(within(done).queryByRole("button", { name: "Undo" })).toBeNull();
    const user = userEvent.setup();
    await user.click(within(done).getByRole("button", { name: "Review" }));
    expect(useAppStore.getState().inspectorTab).toBe("changes");
    expect(useAppStore.getState().dockOpen).toBe(true);
  });

  it("does not offer a destructive fallback for historical turns without snapshots", () => {
    mount(thread({ items: [item({ tool: "edit_file", turnId: "t1", args: '{"path":"src/a.ts"}' })] }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Revert files/ })).toBeNull();
    // Undo is simply absent; the strip does not explain why.
    expect(screen.queryByText(/Undo is unavailable|saved file state/)).toBeNull();
  });

  it("shows native snapshot files and Reapply even when a shell made the changes", () => {
    mount(thread({ snapshots: { t1: { snapshotId: "snap-1", sessionId: "s1", turnId: "t1", state: "undone", files: ["shell-created.txt"], reason: null, createdAt: 1 } }, items: [item({ tool: "bash", turnId: "t1", commandText: "create a file" })] }));
    expect(screen.getByText("Changed 1 file")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reapply" })).toBeInTheDocument();
    // The strip itself says the turn is undone, in place of Done.
    expect(within(screen.getByRole("region", { name: "Done" })).getByText("Undone")).toBeInTheDocument();
  });

  it("fills a host that reports no turn usage with the derived step time", () => {
    mount(thread({
      agentId: "grok",
      lastTurnId: "t1",
      lastOutcome: "completed",
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "go" }),
        item({ itemId: "c1", tool: "bash", turnId: "t1", commandText: "npm test", durationMs: 9000 }),
        item({ itemId: "e1", tool: "edit_file", turnId: "t1", args: JSON.stringify({ path: "src/a.ts" }), durationMs: 1000 }),
      ],
    }));
    expect(screen.getByTitle("Sum of the step times the agent reported")).toHaveTextContent("~10s");
  });

  it("adds no receipt just to say a snapshot is unavailable", () => {
    mount(thread({ snapshots: { t1: { snapshotId: "snap-1", sessionId: "s1", turnId: "t1", state: "unavailable", files: [], reason: "Overlapping runs shared this workspace. Their changes cannot be separated.", createdAt: 1 } }, items: [item({ tool: "bash", turnId: "t1", commandText: "create a file" })] }));
    expect(screen.queryByText(/Overlapping runs shared/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByText(/Changed 0 files/)).toBeNull();
  });

  it("keeps a live turn's work open, then folds it above the answer once the turn settles", () => {
    const items = [
      item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "Fix the flaky login test" }),
      item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "Reading the guide first" }),
      item({ itemId: "c1", tool: "read_file", turnId: "t1", args: JSON.stringify({ path: "src/a.ts" }), durationMs: 2000 }),
      item({ itemId: "m2", kind: "agentMessage", turnId: "t1", text: "Found the race" }),
    ];
    const view = mount(thread({ status: "running", activeTurnId: "t1", items }));
    expect(screen.getByText("Reading the guide first").closest(".trace-note")).not.toBeNull();
    expect(document.querySelector(".trace-head")).toBeNull();
    expect(screen.queryByTestId("agent-mark")).toBeNull();
    view.unmount();
    mount(thread({ lastTurnId: "t1", lastOutcome: "completed", items }));
    expect(screen.queryByText("Reading the guide first")).toBeNull();
    expect(screen.getByText("Found the race").closest(".msg.agent")).not.toBeNull();
    const fold = screen.getByRole("button", { name: /Worked for/ });
    expect(fold).toHaveAttribute("data-holds", "m1");
    fireEvent.click(fold);
    expect(screen.getByText("Reading the guide first")).toBeInTheDocument();
  });

  it("keeps every note collapsed until it is opened, including the newest of a live turn", () => {
    const source = (items: TranscriptItem[]) => thread({ status: "running", activeTurnId: "t1", items });
    const first = [
      item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "Fix the flaky login test" }),
      item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "Reading the guide first" }),
      item({ itemId: "c1", tool: "read_file", turnId: "t1", args: "{}" }),
      item({ itemId: "m2", kind: "agentMessage", turnId: "t1", text: "Found the race\n\nIt is in the refresh path." }),
      item({ itemId: "c2", tool: "read_file", turnId: "t1", args: "{}" }),
    ];
    const note = (id: string) => document.querySelector(`[data-item="${id}"]`) as HTMLElement;
    const expanded = (id: string) => note(id)?.querySelector(".trace-note-head")?.getAttribute("aria-expanded");
    const view = mount(source(first));
    expect(expanded("m1")).toBe("false");
    expect(expanded("m2"), "the newest note stays one line").toBe("false");
    expect(screen.queryByText("It is in the refresh path.")).toBeNull();
    fireEvent.click(within(note("m2")).getByRole("button"));
    expect(expanded("m2")).toBe("true");
    expect(screen.getByText("It is in the refresh path.")).toBeInTheDocument();
    const next = source([...first,
      item({ itemId: "m3", kind: "agentMessage", turnId: "t1", text: "Applying the fix" }),
      item({ itemId: "c3", tool: "edit_file", turnId: "t1", args: JSON.stringify({ path: "src/a.ts" }) }),
    ]);
    seedStore({ threads: [next], selectedSessionId: next.sessionId });
    view.rerender(<AgentTimeline thread={next} />);
    expect(expanded("m3"), "a new note starts folded").toBe("false");
    expect(expanded("m2"), "a note the reader opened").toBe("true");
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

  it("summarizes a tool group at rest and opens it in place", async () => {
    mount(thread({
      status: "running",
      activeTurnId: "t1",
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "go" }),
        item({ itemId: "r1", tool: "read_file", turnId: "t1", args: JSON.stringify({ path: "src/a.ts" }) }),
        item({ itemId: "c1", tool: "bash", turnId: "t1", commandText: "npm test" }),
        item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "On it." }),
        item({ itemId: "x1", tool: "grep", turnId: "t1", status: "inProgress", args: JSON.stringify({ pattern: "later" }) }),
      ],
    }));
    const head = screen.getByRole("button", { name: /Ran 2 tools/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("src/a.ts")).toBeNull();
    await userEvent.setup().click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
  });

  it("badges a failed group and keeps its output folded until opened", async () => {
    mount(thread({
      status: "running",
      activeTurnId: "t1",
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "go" }),
        item({ itemId: "r1", tool: "read_file", turnId: "t1", args: JSON.stringify({ path: "src/a.ts" }) }),
        item({ itemId: "c1", tool: "bash", turnId: "t1", commandText: "npm test", failureReason: "exit 1" }),
        item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "The test failed." }),
        item({ itemId: "x1", tool: "grep", turnId: "t1", status: "inProgress", args: JSON.stringify({ pattern: "later" }) }),
      ],
    }));
    const head = screen.getByRole("button", { name: /Ran 2 tools/ });
    expect(screen.getByText("1 failure")).toBeInTheDocument();
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("npm test")).toBeNull();
    await userEvent.setup().click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("npm test").length).toBeGreaterThan(0);
  });

  it("marks a context compaction as a seam, not a step in the work list", () => {
    mount(thread({
      lastOutcome: "completed",
      lastTurnId: "t1",
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "first" }),
        item({ itemId: "k1", kind: "compaction", turnId: "t1", reason: "Older turns were summarised" }),
        item({ itemId: "a1", kind: "agentMessage", turnId: "t1", text: "Carrying on." }),
      ],
    }));
    expect(screen.getByRole("separator", { name: "Context compacted" })).toBeInTheDocument();
    expect(screen.queryByText("Compacted context")).toBeNull();
  });

  it("reviews a turn's changed files in a card, with the rest on request", async () => {
    mount(thread({
      snapshots: { t1: { snapshotId: "snap-1", sessionId: "s1", turnId: "t1", state: "ready", files: ["src/a.ts", "src/lib/b.ts", "test/c.ts", "docs/d.md", "e.txt"], reason: null, createdAt: 1 } },
      lastOutcome: "completed",
      lastTurnId: "t1",
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "change five files" }),
        item({ itemId: "a1", kind: "agentMessage", turnId: "t1", text: "All five are updated." }),
      ],
    }));
    const card = screen.getByRole("region", { name: "Changed files" });
    expect(within(card).getByText("Changed 5 files")).toBeInTheDocument();
    expect(card.querySelectorAll(".change-row")).toHaveLength(3);
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Show 2 more files" }));
    expect(card.querySelectorAll(".change-row")).toHaveLength(5);
    expect(within(card).getByRole("button", { name: "Show fewer files" })).toHaveAttribute("aria-expanded", "true");
    await user.click(within(screen.getByRole("region", { name: "Done" })).getByRole("button", { name: "Review" }));
    expect(useAppStore.getState().inspectorTab).toBe("changes");
    expect(useAppStore.getState().dockOpen).toBe(true);
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
    // Each settled turn's question and answer, then the live question and the message being written.
    expect(marks.count).toBe(turns * 2 + 2);

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

  it("drills into a delegated child read-only, with no lifecycle buttons to drive it", async () => {
    const openChild = vi.fn(async () => {});
    seedStore({ openChild });
    mount(thread({
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "audit the repo" }),
        item({
          itemId: "child-card",
          kind: "subagent",
          turnId: "t1",
          role: "delegate",
          readOnly: true,
          childSessionId: "h-child",
          objective: "Audit the repo",
          controlStatus: "resultReady",
          result: { summary: "Audit", text: "All clean.", artifactRefs: [], evidenceRefs: [] },
        }),
      ],
      lastTurnId: "t1",
      lastOutcome: "completed",
    }));
    expect(screen.queryByRole("button", { name: "Result" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Follow up" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: /Transcript/ }));
    expect(openChild).toHaveBeenCalledWith("s1", "child-card");
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
    expect(screen.queryByText("Not found")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Edited/ }));
    expect(screen.queryByLabelText("Edit preview")).toBeNull();
    expect(screen.getByText("Not found")).toBeInTheDocument();
  });
  it("shows the first thought line once when expanded", () => {
    mount(thread({ items: [item({ kind: "reasoning", text: "Unique opening line\n\nMore detail" })] }));
    expect(screen.queryByText("More detail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Thought\s*Unique opening line/ }));
    expect(screen.getAllByText("Unique opening line")).toHaveLength(1);
    expect(document.querySelector(".reasoning .step-summary")).toBeNull();
    expect(screen.getByText("More detail").closest(".thought")).not.toBeNull();
  });

  it("keeps a live turn's thinking inside a closed group, under the answer", async () => {
    mount(thread({
      status: "running",
      activeTurnId: "t1",
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "go" }),
        item({ itemId: "th1", kind: "reasoning", turnId: "t1", text: "I should read the login test\n\nThe race is in refresh." }),
        item({ itemId: "r1", tool: "read_file", turnId: "t1", args: JSON.stringify({ path: "src/a.ts" }) }),
        item({ itemId: "th2", kind: "reasoning", turnId: "t1", text: "The token refresh races the form." }),
        item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "Found the race in the token refresh." }),
      ],
    }));
    const head = screen.getByRole("button", { name: /Ran 1 tool/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("The race is in refresh.")).toBeNull();
    expect(screen.queryByText("The token refresh races the form.")).toBeNull();
    expect(screen.getByText("Found the race in the token refresh.").closest(".msg.agent")).not.toBeNull();
    await userEvent.setup().click(head);
    expect(screen.getByRole("button", { name: /Thought\s*I should read the login test/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("The race is in refresh.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Thought\s*I should read the login test/ }));
    expect(screen.getByText("The race is in refresh.").closest(".thought")).not.toBeNull();
    expect(screen.getByText("Found the race in the token refresh.").closest(".msg.agent")).not.toBeNull();
  });

  it("leaves a settled turn's thinking as one line above the answer", () => {
    mount(thread({
      lastTurnId: "t1",
      lastOutcome: "completed",
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "go" }),
        item({ itemId: "th1", kind: "reasoning", turnId: "t1", text: "First I will look.\n\nDetail that should stay hidden." }),
        item({ itemId: "th2", kind: "reasoning", turnId: "t1", text: "Then I will edit." }),
        item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "All set." }),
      ],
    }));
    expect(screen.getByRole("button", { name: /2 thoughts/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Detail that should stay hidden.")).toBeNull();
    expect(screen.getByText("All set.").closest(".msg.agent")).not.toBeNull();
  });
});
