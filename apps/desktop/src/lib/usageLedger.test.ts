import { describe, expect, it } from "vitest";
import { asLedger, compact, dayKey, EMPTY_LEDGER, groupUsage, ledgerSlices, MAX_CALL_TURNS, MAX_TURN_CALLS, providerOf, recordTurn, RECENT_DAYS, totalsSince, turnEntry, type UsageTurn } from "./usageLedger";
import type { ModelCall, Thread } from "./types";

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 21, 15).getTime();

const turn = (partial: Partial<UsageTurn> = {}): UsageTurn => ({
  key: "s1:t1",
  at: NOW - 3_600_000,
  agentId: "harness",
  providerId: "anthropic",
  modelId: "anthropic/claude-sonnet-5",
  inputTokens: 1_000,
  cachedTokens: 0,
  outputTokens: 200,
  estimated: false,
  durationMs: 30_000,
  threadId: "s1",
  workspace: "/repo",
  tools: { bash: 2 },
  ...partial,
});

const call = (partial: Partial<ModelCall> = {}): ModelCall => ({
  at: NOW - 3_600_000,
  providerId: "anthropic",
  modelId: "anthropic/claude-sonnet-5",
  inputTokens: 900,
  cachedTokens: 0,
  outputTokens: 120,
  stopReason: "end_turn",
  durationMs: 4_000,
  toolCalls: 1,
  ...partial,
});

describe("totalsSince", () => {
  it("counts today's turns and a rolled-up day, and skips yesterday", () => {
    const start = new Date(2026, 9, 21, 0, 0, 0, 0).getTime();
    const ledger = {
      version: 1 as const,
      turns: [turn({ at: NOW, outputTokens: 50, estimated: true }), turn({ key: "y", at: start - 60_000, outputTokens: 9_000 })],
      days: [{ day: "2026-10-21", agentId: "harness" as const, providerId: "anthropic", turns: 2, estimatedTurns: 0, inputTokens: 100, cachedTokens: 0, outputTokens: 40, durationMs: 0, tools: {} }],
    };
    expect(totalsSince(ledger, start, NOW)).toEqual({ tokens: 1_190, turns: 3, estimated: true });
  });
});

describe("providerOf", () => {
  it("names the company that served the model", () => {
    expect(providerOf("harness", "anthropic/claude-sonnet-5")).toBe("anthropic");
    expect(providerOf("opencode", "openrouter/qwen/qwen3:free")).toBe("openrouter");
    expect(providerOf("grok", "grok-4.7", "grok")).toBe("xai");
    expect(providerOf("muse", "muse-spark-1.3")).toBe("meta");
    expect(providerOf("gemini")).toBe("google");
    expect(providerOf("goose")).toBe("goose");
  });
});

describe("ledger", () => {
  it("replaces a turn's entry when its usage arrives late", () => {
    const first = recordTurn(EMPTY_LEDGER, turn({ outputTokens: 50, estimated: true }), NOW);
    const second = recordTurn(first, turn({ outputTokens: 240 }), NOW);
    expect(second.turns).toHaveLength(1);
    expect(second.turns[0]).toMatchObject({ outputTokens: 240, estimated: false });
  });

  it("rolls old turns into daily totals per provider and model", () => {
    const old = NOW - (RECENT_DAYS + 2) * DAY;
    const ledger = compact({ version: 1, days: [], turns: [
      turn({ key: "a", at: old }),
      turn({ key: "b", at: old + 60_000, outputTokens: 300, tools: { bash: 1, grep: 1 } }),
      turn({ key: "c", at: old, providerId: "openai", modelId: "openai/gpt-5.5" }),
      turn({ key: "d" }),
    ] }, NOW);
    expect(ledger.turns.map((entry) => entry.key)).toEqual(["d"]);
    const anthropic = ledger.days.find((day) => day.providerId === "anthropic");
    expect(anthropic).toMatchObject({ day: dayKey(old), turns: 2, inputTokens: 2_000, outputTokens: 500, tools: { bash: 3, grep: 1 } });
    expect(ledger.days.find((day) => day.providerId === "openai")?.turns).toBe(1);
  });

  it("drops days past keeping", () => {
    const ledger = compact({ version: 1, turns: [turn({ at: NOW - 500 * DAY })], days: [] }, NOW);
    expect(ledger).toEqual(EMPTY_LEDGER);
  });

  it("keeps per-call detail only for the newest turns", () => {
    const count = MAX_CALL_TURNS + 4;
    const turns = Array.from({ length: count }, (_, index) => turn({ key: `t${index}`, at: NOW - (count - index) * 60_000, calls: [call()] }));
    const ledger = compact({ version: 1, turns, days: [] }, NOW);
    expect(ledger.turns).toHaveLength(count);
    expect(ledger.turns.slice(0, 4).every((entry) => entry.calls === undefined)).toBe(true);
    expect(ledger.turns.slice(4).every((entry) => entry.calls?.length === 1)).toBe(true);
  });

  it("trusts nothing malformed from storage", () => {
    expect(asLedger(null)).toEqual(EMPTY_LEDGER);
    expect(asLedger({ version: 2, turns: [turn()] })).toEqual(EMPTY_LEDGER);
    const ledger = asLedger({ version: 1, turns: [turn(), { key: 4 }, { ...turn({ key: "x" }), inputTokens: -5, tools: { bash: "lots" } }], days: [{ day: "nope", agentId: "harness", providerId: "x" }] });
    expect(ledger.turns).toHaveLength(2);
    expect(ledger.turns[1]).toMatchObject({ inputTokens: 0, tools: {} });
    expect(ledger.days).toEqual([]);
  });

  it("reads stored calls field by field, and no more of them than it keeps", () => {
    const many = Array.from({ length: MAX_TURN_CALLS + 3 }, (_, index) => call({ at: index }));
    const ledger = asLedger({ version: 1, days: [], turns: [
      { ...turn({ key: "a" }), calls: [{ at: 1 }, "nope", call({ inputTokens: -5, attempt: 1 })] },
      { ...turn({ key: "b" }), calls: [] },
      { ...turn({ key: "c" }), calls: many },
    ] });
    expect(ledger.turns[0].calls).toEqual([call({ inputTokens: 0 })]);
    expect(ledger.turns[1].calls).toBeUndefined();
    expect(ledger.turns[2].calls).toEqual(many.slice(-MAX_TURN_CALLS));
  });

  it("totals by provider, largest first", () => {
    const ledger = { version: 1 as const, days: [], turns: [
      turn({ key: "a" }),
      turn({ key: "b", providerId: "openai", inputTokens: 9_000 }),
      turn({ key: "c", providerId: "openai", outputTokens: 0, estimated: true }),
    ] };
    expect(groupUsage(ledgerSlices(ledger), (slice) => slice.providerId)).toEqual([
      { id: "openai", inputTokens: 10_000, cachedTokens: 0, outputTokens: 200, turns: 2, estimatedTurns: 1 },
      { id: "anthropic", inputTokens: 1_000, cachedTokens: 0, outputTokens: 200, turns: 1, estimatedTurns: 0 },
    ]);
  });
});

describe("turnEntry", () => {
  const thread = (partial: Partial<Thread> = {}) => ({
    sessionId: "s1",
    agentId: "harness" as const,
    workspacePath: "/repo",
    config: { modelId: "openai/gpt-5.5", effort: "high" as const },
    turnStats: { turnId: "t1", durationMs: 4_000, inputTokens: 900, outputTokens: 120 },
    items: [
      { itemId: "a", kind: "toolCall" as const, status: "completed" as const, turnId: "t1", tool: "bash" },
      { itemId: "b", kind: "toolCall" as const, status: "completed" as const, turnId: "t0", tool: "grep" },
    ],
    ...partial,
  });

  it("counts the finished turn with its provider, model and own tools", () => {
    expect(turnEntry(thread(), NOW)).toMatchObject({ key: "s1:t1", providerId: "openai", modelId: "openai/gpt-5.5", effort: "high", inputTokens: 900, cachedTokens: 0, outputTokens: 120, tools: { bash: 1 } });
  });

  it("counts cached prompt tokens as input, and says how many were cached", () => {
    expect(turnEntry(thread({ turnStats: { turnId: "t1", durationMs: 1, inputTokens: 20, cachedTokens: 80_000, outputTokens: 40 } }), NOW)).toMatchObject({ inputTokens: 80_020, cachedTokens: 80_000 });
  });

  it("carries the turn's own calls, bounded to a whole trajectory", () => {
    const calls = Array.from({ length: MAX_TURN_CALLS + 3 }, (_, index) => call({ at: index }));
    expect(turnEntry(thread({ turnCalls: calls }), NOW)?.calls).toEqual(calls.slice(-MAX_TURN_CALLS));
    expect(turnEntry(thread({ turnCalls: [] }), NOW)?.calls).toBeUndefined();
  });

  it("skips a turn with nothing to count", () => {
    expect(turnEntry(thread({ turnStats: { turnId: "t9", durationMs: 1 } }), NOW)).toBeNull();
    expect(turnEntry(thread({ turnStats: undefined }), NOW)).toBeNull();
  });
});
