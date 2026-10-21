import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

const refresh = vi.fn(async () => {});
function seed(extra: Record<string, unknown> = {}) {
  seedStore({ preview: false, usageLedger: ledger, agents: [], refreshSubscriptionUsage: refresh, ...extra });
}

describe("UsageView", () => {
  beforeEach(() => { resetStore(); refresh.mockClear(); });

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
    expect(screen.getByRole("region", { name: "Usage summary" })).toHaveTextContent("Tokens≈10K");
    expect(screen.getByText(/≈ marks 1 turn whose agent reported no counts/)).toBeInTheDocument();
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

  it("says what the trajectory needs when no turn carries calls", () => {
    seed();
    render(<UsageView embedded />);
    expect(within(screen.getByRole("region", { name: "Trajectory" })).getByText("Harness turns list every call here. Other agents report totals only.")).toBeInTheDocument();
  });

  it("shows nothing when nothing is recorded, rather than stale estimates", () => {
    seed({ usageLedger: { version: 1, turns: [], days: [] } });
    render(<UsageView embedded />);
    expect(screen.getByText("Each provider's share appears here after your first turn.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear history" })).toBeDisabled();
  });

  it("clears the history after confirming", async () => {
    const confirm = vi.fn(async () => true);
    seed({ confirm });
    render(<UsageView embedded />);
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await vi.waitFor(() => expect(useAppStore.getState().usageLedger.turns).toEqual([]));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Clear usage history?", danger: true }));
  });

  it("hides the Muse subscription card when Muse is installed but turned off", () => {
    seed({
      agents: [{ id: "muse", name: "Muse", protocol: "msp", found: true, path: "/bin/muse", version: "1.3.0", verified: true, signIn: "", authenticated: true }],
      enabledAgents: { muse: false },
    });
    render(<UsageView embedded />);
    expect(screen.queryByRole("region", { name: "Muse subscription" })).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("hides the Muse subscription card unless Muse is installed", () => {
    seed();
    render(<UsageView embedded />);
    expect(screen.queryByRole("region", { name: "Muse subscription" })).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("drops a subscription window that has reset since the reading", () => {
    const now = Date.now();
    seed({
      agents: [{ id: "muse", name: "Muse", protocol: "msp", found: true, path: "/bin/muse", version: "1.3.0", verified: true, signIn: "", authenticated: true }],
      subscriptionUsage: { observedAtMs: now - 6 * 3_600_000, tier: "pro", window: { usedPercent: 87, resetsAtMs: now - 3_600_000, windowDurationMins: 300 }, weekly: { usedPercent: 40, resetsAtMs: now + 86_400_000 } },
      subscriptionUsageError: "Could not load subscription usage: the host is not running.",
    });
    render(<UsageView embedded />);
    const card = screen.getByRole("region", { name: "Muse subscription" });
    expect(card).toHaveTextContent("as of 6h ago");
    expect(card).not.toHaveTextContent("87%");
    expect(card).toHaveTextContent("Reset since this reading");
    expect(card).toHaveTextContent("40%");
    expect(within(card).getByRole("alert")).toHaveTextContent("the host is not running");
    expect(refresh).toHaveBeenCalled();
  });
});
