import { describe, expect, it } from "vitest";
import { asLedger, compact, dayKey, dayStart, EMPTY_LEDGER, groupCallUsage, groupUsage, ledgerCalls, ledgerSlices, MAX_CALL_TURNS, MAX_TURN_CALLS, providerOf, recordTurn, RECENT_DAYS, routeUsage, summarizeCalls, totalsSince, turnEntry, type UsageCall, type UsageLedger, type UsageTurn } from "./usageLedger";
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

const usageCall = (partial: Partial<UsageCall> = {}): UsageCall => ({
  ...call(),
  key: "s1:t1:0",
  turnKey: "s1:t1",
  agentId: "harness",
  threadId: "s1",
  workspace: "/repo",
  ...partial,
});
const storedCalls = (ledger: UsageLedger): UsageCall[] => ledger.calls ?? [];

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

  it("gives a rolled-up day a timestamp inside its local calendar day", () => {
    const entries = ledgerSlices({ version: 1, turns: [], days: [{ day: "2026-10-01", agentId: "harness", providerId: "openai", modelId: "openai/gpt-5.5", turns: 1, estimatedTurns: 0, inputTokens: 100, cachedTokens: 0, outputTokens: 50, durationMs: 1, tools: {} }] });
    expect(entries[0].at).toBe(dayStart("2026-10-01"));
    expect(new Date(entries[0].at).getDate()).toBe(1);
    expect(entries[0].wholeDay).toBe(true);
  });

  it("keeps per-call detail only for the newest turns", () => {
    const count = MAX_CALL_TURNS + 4;
    const turns = Array.from({ length: count }, (_, index) => turn({ key: `t${index}`, at: NOW - (count - index) * 60_000, calls: [call()] }));
    const ledger = compact({ version: 1, turns, days: [] }, NOW);
    const detailed = new Set(turns.slice(-MAX_CALL_TURNS).map((entry) => entry.key));
    expect(ledger.turns).toHaveLength(count);
    expect(ledger.turns.every((entry) => entry.calls === undefined)).toBe(true);
    expect(storedCalls(ledger)).toHaveLength(MAX_CALL_TURNS);
    expect(storedCalls(ledger).every((entry) => detailed.has(entry.turnKey))).toBe(true);
  });

  it("trusts nothing malformed from storage", () => {
    expect(asLedger(null)).toEqual(EMPTY_LEDGER);
    expect(asLedger({ version: 3, turns: [] })).toEqual(EMPTY_LEDGER);
    expect(asLedger({ version: 2, turns: [{ key: 4 }], days: [] })).toEqual(EMPTY_LEDGER);
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
    expect(ledger.turns.every((entry) => entry.calls === undefined)).toBe(true);
    expect(storedCalls(ledger).filter((entry) => entry.turnKey === "a")).toMatchObject([call({ inputTokens: 0 })]);
    expect(storedCalls(ledger).filter((entry) => entry.turnKey === "b")).toEqual([]);
    expect(storedCalls(ledger).filter((entry) => entry.turnKey === "c")).toMatchObject(many.slice(-MAX_TURN_CALLS));
  });

  it("drops unknown roles and stages from stored calls", () => {
    const ledger = asLedger({ version: 2, turns: [turn()], days: [], calls: [{ ...usageCall(), role: "admin", stage: "nope" }] });
    expect(storedCalls(ledger)).toHaveLength(1);
    expect(storedCalls(ledger)[0]).not.toHaveProperty("role");
    expect(storedCalls(ledger)[0]).not.toHaveProperty("stage");
  });

  it("counts a late turn update once, with its newest calls", () => {
    const first = recordTurn(EMPTY_LEDGER, turn({ calls: [call()] }), NOW);
    const second = recordTurn(first, turn({ calls: [call({ outputTokens: 999 })] }), NOW);
    expect(ledgerCalls(second)).toHaveLength(1);
    expect(storedCalls(second)[0].outputTokens).toBe(999);
  });

  it("groups per-call usage by route and role without double counting turn totals", () => {
    const calls = [
      usageCall({ key: "s1:t1:lead", role: "lead", stage: "lead-plan", routeId: "r1", inputTokens: 1_000, outputTokens: 100, estimatedCost: { amount: 0.5, currency: "USD", partial: false } }),
      usageCall({ key: "s1:t1:build", role: "builder", stage: "builder", routeId: "r1", inputTokens: 5_000, outputTokens: 300, estimatedCost: { amount: 0.05, currency: "USD", partial: false } }),
      usageCall({ key: "s2:t2:build", role: "builder", stage: "builder", routeId: "r2", inputTokens: 800, outputTokens: 80 }),
    ];
    const ledger = { version: 2 as const, turns: [turn()], days: [], calls };
    expect(routeUsage(ledger, "r1")).toMatchObject({ calls: 2, inputTokens: 6_000, outputTokens: 400, partial: false });
    expect(routeUsage(ledger, "r1").costs).toEqual([{ currency: "USD", amount: 0.55 }]);
    expect(groupCallUsage(calls, (entry) => entry.role).map((group) => ({ id: group.id, calls: group.calls, tokens: group.inputTokens + group.outputTokens }))).toEqual([
      { id: "builder", calls: 2, tokens: 6_180 },
      { id: "lead", calls: 1, tokens: 1_100 },
    ]);
    expect(summarizeCalls(calls)).toMatchObject({ calls: 3, partial: true, unpricedCalls: 1 });
    expect(totalsSince(ledger, 0, NOW + 1).tokens).toBe(1_200);
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
