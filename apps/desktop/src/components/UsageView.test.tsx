import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { UsageView } from "./UsageView";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import type { UsageLedger, UsageTurn } from "../lib/usageLedger";

const turn = (partial: Partial<UsageTurn>): UsageTurn => ({
  key: `s:${Math.random()}`,
  at: Date.now() - 60_000,
  agentId: "harness",
  providerId: "anthropic",
  modelId: "anthropic/claude-sonnet-5",
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  estimated: false,
  durationMs: 10_000,
  threadId: "s",
  workspace: "/repo",
  tools: {},
  ...partial,
});

const ledger: UsageLedger = { version: 1, days: [], turns: [
  turn({ inputTokens: 6_000, cachedTokens: 4_500, outputTokens: 1_500, tools: { bash: 2 } }),
  turn({ agentId: "harness", providerId: "openai", modelId: "openai/gpt-5.5", inputTokens: 2_000, outputTokens: 500 }),
  turn({ agentId: "grok", providerId: "xai", modelId: "grok-4.7", outputTokens: 0, estimated: true }),
] };

function seed(extra: Record<string, unknown> = {}) {
  seedStore({ preview: false, usageLedger: ledger, agents: [], ...extra });
}

describe("UsageView", () => {
  beforeEach(() => { resetStore(); });

  it("breaks the period down by provider, from the recorded ledger", () => {
    seed();
    render(<UsageView embedded />);
    const list = within(screen.getByRole("region", { name: "By provider" })).getByRole("list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["Anthropic", "OpenAI", "xAI"]);
    expect(rows[0]).toHaveTextContent("6K in (4.5K cached) · 1.5K out · 1 turn");
    expect(rows[1]).toHaveTextContent("2K in · 500 out · 1 turn");
    expect(rows[0]).toHaveTextContent("75%");
    expect(rows[2]).toHaveTextContent("≈0 out");
    expect(screen.getByRole("img", { name: "Anthropic 75%, OpenAI 25%" })).toBeInTheDocument();
    const summary = screen.getByRole("region", { name: "Usage summary" });
    expect(summary).toHaveTextContent("Total tokens");
    expect(summary).toHaveTextContent("≈10K");
    expect(within(summary).getByText("10K")).toBeInTheDocument();
    expect(within(summary).getByLabelText("10s")).toHaveTextContent("0 m");
    expect(within(summary).getAllByLabelText("1 day")).toHaveLength(2);
    expect(screen.getByText(/≈ marks 1 turn whose agent reported no counts/)).toBeInTheDocument();
  });

  it("switches the activity grain and the trend range, and shares models on the donut", () => {
    seed();
    render(<UsageView embedded />);
    expect(screen.getByRole("tab", { name: "Daily" })).toHaveAttribute("aria-selected", "true");
    const grid = screen.getByRole("grid", { name: "Daily token activity" });
    const cells = within(grid).getAllByRole("gridcell");
    expect(cells).toHaveLength(53 * 7);
    expect(cells.filter((cell) => cell.getAttribute("data-level") === "4")).toHaveLength(1);

    fireEvent.click(screen.getByRole("tab", { name: "Weekly" }));
    expect(screen.getByRole("grid", { name: "Weekly token activity" })).toBeInTheDocument();

    expect(screen.getByRole("img", { name: /Daily token trend, last 7 days/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Last 30 days" }));
    expect(screen.getByRole("img", { name: /Daily token trend, last 30 days/ })).toBeInTheDocument();

    const models = screen.getByRole("region", { name: "Model usage" });
    expect(models).toHaveTextContent("claude-sonnet-5");
    expect(models).toHaveTextContent("75%");
    expect(models).toHaveTextContent("gpt-5.5");
    expect(models).toHaveTextContent("25%");
    expect(models).toHaveTextContent("≈0 tokens");
    expect(within(models).getByRole("img", { name: "claude-sonnet-5 75%, gpt-5.5 25%" })).toBeInTheDocument();
  });

  it("lists every model call behind a recent Harness turn", () => {
    const now = Date.now();
    seed({ usageLedger: { version: 1, days: [], turns: [turn({ inputTokens: 2_300, cachedTokens: 900, outputTokens: 120, durationMs: 30_000, calls: [
      { at: now - 90_000, providerId: "anthropic", modelId: "anthropic/claude-sonnet-5", effort: "high", inputTokens: 900, cachedTokens: 0, outputTokens: 40, stopReason: "tool_use", durationMs: 12_000, toolCalls: 2 },
      { at: now - 60_000, providerId: "anthropic", modelId: "anthropic/claude-sonnet-5", effort: "high", inputTokens: 1_400, cachedTokens: 900, outputTokens: 80, stopReason: "end_turn", durationMs: 18_000, attempt: 2, toolCalls: 0 },
    ] })] } });
    render(<UsageView embedded />);
    const card = screen.getByRole("region", { name: "Trajectory" });
    const group = card.querySelector(".usage-call-turns > li") as HTMLElement;
    expect(within(group).getByText("2 calls · 2.4K tokens · 30s")).toBeInTheDocument();
    const rows = [...group.querySelectorAll(".usage-call-list > li")] as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("900 in · 40 out · 2 tools")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Tool use")).toBeInTheDocument();
    expect(within(rows[0]).getByText("high")).toBeInTheDocument();
    expect(within(rows[1]).getByText("attempt 2")).toBeInTheDocument();
    expect(within(rows[1]).getByText("End turn")).toBeInTheDocument();
    expect(within(rows[1]).getByText("1.4K in · 80 out")).toHaveAttribute("title", "1,400 input, 900 of it cached · 80 output tokens");
  });

  it("tags each routed call with the role that made it", () => {
    const now = Date.now();
    seed({ usageLedger: { version: 1, days: [], turns: [turn({ calls: [
      { at: now - 30_000, providerId: "anthropic", modelId: "anthropic/claude-opus-4-1", role: "lead", stage: "lead-plan", inputTokens: 400, cachedTokens: 0, outputTokens: 60, stopReason: "end_turn", durationMs: 8_000, toolCalls: 0 },
      { at: now, providerId: "deepseek", modelId: "deepseek/deepseek-v4", role: "builder", stage: "builder", inputTokens: 900, cachedTokens: 0, outputTokens: 120, stopReason: "end_turn", durationMs: 9_000, toolCalls: 1 },
    ] })] } });
    render(<UsageView embedded />);
    const card = screen.getByRole("region", { name: "Trajectory" });
    const rows = [...card.querySelectorAll(".usage-call-what")] as HTMLElement[];
    expect(rows[0]).toHaveTextContent("Lead");
    expect(rows[1]).toHaveTextContent("Builder");
  });

  it("filters trajectory calls to one thread and returns to all threads", () => {
    const now = Date.now();
    const call = { at: now - 60_000, providerId: "anthropic", modelId: "anthropic/claude-sonnet-5", inputTokens: 100, cachedTokens: 0, outputTokens: 20, stopReason: "end_turn", durationMs: 1_000, toolCalls: 0 };
    seed({
      trajectoryThreadId: "s1",
      threads: [{ sessionId: "s1", workspacePath: "/repo", title: "Fix the composer", updatedAt: new Date(now).toISOString(), status: "idle", unread: false, items: [] }],
      usageLedger: { version: 1, days: [], turns: [
        turn({ key: "s1:t1", threadId: "s1", calls: [call] }),
        turn({ key: "s2:t2", threadId: "s2", providerId: "openai", modelId: "openai/gpt-5.5", calls: [{ ...call, providerId: "openai", modelId: "openai/gpt-5.5" }] }),
      ] },
    });
    render(<UsageView embedded />);
    expect(screen.getByText("Fix the composer")).toBeInTheDocument();
    const card = screen.getByRole("region", { name: "Trajectory" });
    expect(card.querySelectorAll(".usage-call-turns > li")).toHaveLength(1);
    expect(within(card).getAllByText("claude-sonnet-5")).not.toHaveLength(0);
    expect(within(card).queryByText("gpt-5.5")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View all threads" }));
    expect(useAppStore.getState().trajectoryThreadId).toBeNull();
    expect(screen.getByRole("region", { name: "Trajectory" }).querySelectorAll(".usage-call-turns > li")).toHaveLength(2);
  });

  it("says what the trajectory needs when no turn carries calls", () => {
    seed();
    render(<UsageView embedded />);
    expect(within(screen.getByRole("region", { name: "Trajectory" })).getByText("Harness turns list every call here. Other agents report totals only.")).toBeInTheDocument();
  });

  it("shows nothing when nothing is recorded, rather than stale estimates", () => {
    seed({ usageLedger: { version: 1, turns: [], days: [] } });
    render(<UsageView embedded />);
    const summary = screen.getByRole("region", { name: "Usage summary" });
    expect(within(summary).getAllByText("0")).toHaveLength(2);
    expect(within(summary).getByLabelText("0 minutes")).toHaveTextContent("0 m");
    expect(within(summary).getAllByLabelText("0 days")).toHaveLength(2);
    const chart = screen.getByRole("img", { name: "Daily token trend, last 7 days. No tokens in this range" });
    expect(chart.querySelector("path")).toBeNull();
    expect(screen.getByText("Each provider's share appears here after your first turn.")).toBeInTheDocument();
    expect(screen.getByText("Models appear after your first turn.")).toBeInTheDocument();
    expect(screen.getByText("Trends appear after your first turn.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear history" })).toBeDisabled();
  });

  it("adds rolled-up ledger days to the totals, and only to a range that contains them", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 23, 15, 0, 0));
    try {
      const dayLabel = (date: Date) => date.toLocaleDateString([], { month: "short", day: "numeric" });
      seed({ usageLedger: { version: 1, turns: [
        turn({ at: Date.now() - 3_600_000, inputTokens: 1_000, outputTokens: 200, durationMs: 12 * 60_000, threadId: "today", key: "today" }),
      ], days: [{
        day: "2026-10-01",
        agentId: "harness",
        providerId: "anthropic",
        modelId: "anthropic/claude-sonnet-5",
        turns: 2,
        estimatedTurns: 0,
        inputTokens: 200_000,
        cachedTokens: 0,
        outputTokens: 22_200,
        durationMs: 0,
        tools: { bash: 4 },
      }] } });
      render(<UsageView embedded />);
      const summary = screen.getByRole("region", { name: "Usage summary" });
      expect(within(summary).getByText("223.4K")).toBeInTheDocument();
      expect(within(summary).getByText("222.2K")).toBeInTheDocument();
      expect(within(summary).getByLabelText("12m 0s")).toHaveTextContent("12 m");
      expect(screen.getByText("4 runs")).toBeInTheDocument();

      const week = screen.getByRole("img", { name: /Daily token trend, last 7 days/ });
      expect(week).toHaveAttribute("aria-label", expect.stringContaining("claude-sonnet-5 1.2K"));
      expect(week.getAttribute("aria-label")).not.toContain("223.4K");
      expect(week.querySelector("path")?.getAttribute("d")).toMatch(/^M /);
      expect([...document.querySelectorAll(".usage-chart-labels span")].map((node) => node.textContent)).toEqual(
        Array.from({ length: 7 }, (_, index) => dayLabel(new Date(2026, 9, 17 + index))),
      );

      fireEvent.click(screen.getByRole("tab", { name: "Last 30 days" }));
      const month = screen.getByRole("img", { name: "Daily token trend, last 30 days. claude-sonnet-5 223.4K" });
      expect(month.querySelector("path")).toBeTruthy();
      const labels = [...document.querySelectorAll(".usage-chart-labels span")].map((node) => node.textContent);
      expect(labels[0]).toBe(dayLabel(new Date(2026, 8, 24)));
      expect(labels[labels.length - 1]).toBe(dayLabel(new Date(2026, 9, 23)));

      const active = within(screen.getByRole("grid", { name: "Daily token activity" })).getAllByRole("gridcell").filter((cell) => cell.getAttribute("data-level") !== "0");
      expect(active).toHaveLength(2);
      expect(active.filter((cell) => cell.getAttribute("data-level") === "4")).toHaveLength(1);
      expect(active.some((cell) => cell.getAttribute("aria-label")?.includes("222.2K"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("redraws as soon as a finished turn changes the stored ledger", () => {
    seed({ usageLedger: { version: 1, turns: [], days: [] } });
    render(<UsageView embedded />);
    expect(screen.getByRole("region", { name: "Usage summary" })).toHaveTextContent("Total tokens");
    expect(screen.getByRole("img", { name: /No tokens in this range/ })).toBeInTheDocument();
    act(() => { seedStore({ usageLedger: { version: 1, days: [], turns: [turn({ inputTokens: 1_200, outputTokens: 300 })] } }); });
    expect(within(screen.getByRole("region", { name: "Usage summary" }).querySelector(".lead") as HTMLElement).getByText("1.5K")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /claude-sonnet-5 1.5K/ })).toBeInTheDocument();
  });



  it("clears the history after confirming", async () => {
    const confirm = vi.fn(async () => true);
    seed({ confirm });
    render(<UsageView embedded />);
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await vi.waitFor(() => expect(useAppStore.getState().usageLedger.turns).toEqual([]));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Clear usage history?", danger: true }));
  });




  it("answers a heatmap cell on hover at once, without a native title", () => {
    seed();
    render(<UsageView embedded />);
    const grid = screen.getByRole("grid", { name: "Daily token activity" });
    const cell = within(grid).getAllByRole("gridcell").find((node) => node.getAttribute("data-level") === "4") as HTMLElement;
    expect(cell).not.toHaveAttribute("title");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerOver(cell);
    expect(screen.getByRole("tooltip")).toHaveTextContent(cell.getAttribute("aria-label") ?? "");
    fireEvent.pointerLeave(grid);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("names the full model behind each trend legend entry, with its tokens", () => {
    seed();
    render(<UsageView embedded />);
    const trend = screen.getByRole("region", { name: "Token trend" });
    const legend = trend.querySelector(".usage-legend-models") as HTMLElement;
    const entry = within(legend).getByText("claude-sonnet-5").closest("li") as HTMLElement;
    fireEvent.pointerEnter(entry);
    expect(screen.getByRole("tooltip")).toHaveTextContent("anthropic/claude-sonnet-5 · 7.5K tokens");
    fireEvent.pointerLeave(legend);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("counts the stat strip up to its values when motion is allowed", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    let at = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => at);
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      at += 100;
      const stamp = at;
      return window.setTimeout(() => callback(stamp), 0) as unknown as number;
    });
    try {
      seed();
      render(<UsageView embedded />);
      const summary = screen.getByRole("region", { name: "Usage summary" });
      const lead = () => summary.querySelector(".lead strong")?.textContent;
      expect(lead()).toBe("≈0");
      await vi.waitFor(() => expect(lead()).toBe("≈10K"));
      expect(within(summary).getByText("0 m")).toBeInTheDocument();
      expect(within(summary).getAllByText("1 day")).toHaveLength(2);
    } finally {
      raf.mockRestore();
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("finishes an active count immediately when Reduce motion is enabled", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    let at = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => at);
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      at += 100;
      const stamp = at;
      return window.setTimeout(() => callback(stamp), 0) as unknown as number;
    });
    try {
      seed();
      render(<UsageView embedded />);
      const summary = screen.getByRole("region", { name: "Usage summary" });
      const lead = () => summary.querySelector(".lead strong")?.textContent;
      expect(lead()).toBe("≈0");
      act(() => useAppStore.setState({ reduceMotion: true }));
      await vi.waitFor(() => expect(lead()).toBe("≈10K"));
    } finally {
      raf.mockRestore();
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
