import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore, seedStore } from "../test/store";
import { bindBridgeEvents, useAppStore } from "./store";
import type { ModelCall, Thread } from "./types";

const events = vi.hoisted(() => ({ handler: null as null | ((event: string, payload: unknown) => void) }));
vi.mock("./bridge", async (original) => ({
  ...(await original<typeof import("./bridge")>()),
  bridge: vi.fn().mockResolvedValue({}),
  onBridgeEvent: (handler: (event: string, payload: unknown) => void) => { events.handler = handler; return () => {}; },
}));

const emit = (event: string, payload: unknown) => events.handler?.(event, payload);
const running = (): Thread => ({
  sessionId: "h-session-1",
  agentId: "harness",
  workspacePath: "/repo",
  title: "Work",
  updatedAt: new Date().toISOString(),
  status: "running",
  unread: false,
  activeTurnId: "t1",
  config: { modelId: "anthropic/claude-sonnet-5", effort: "high" },
  usage: { promptTokens: 4_000, outputTokens: 600 },
  turnStartedAt: Date.now() - 5_000,
  turnStartPrompt: 4_000,
  turnStartOutput: 600,
  items: [{ itemId: "tool", kind: "toolCall", status: "completed", turnId: "t1", tool: "bash" }],
});
const completed = { sessionId: "h-session-1", turnId: "t1", outcome: { kind: "completed", params: { terminal: "completed" } } };
const call = (partial: Partial<ModelCall> = {}): ModelCall => ({
  at: Date.now() - 4_000,
  providerId: "anthropic",
  modelId: "anthropic/claude-sonnet-5",
  effort: "high",
  inputTokens: 900,
  cachedTokens: 0,
  outputTokens: 120,
  stopReason: "end_turn",
  durationMs: 4_000,
  toolCalls: 0,
  ...partial,
});

describe("usage ledger", () => {
  let unbind: () => void;
  beforeEach(() => {
    resetStore();
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    seedStore({ preview: false, threads: [running()] });
    unbind = bindBridgeEvents();
  });
  afterEach(() => { unbind(); vi.useRealTimers(); });

  it("records a finished turn's reported tokens under its provider, and keeps them", () => {
    emit("sessionFacts", { sessionId: "h-session-1", usage: { promptTokens: 9_000, outputTokens: 900, totalTokens: 9_900 } });
    emit("turnCompleted", completed);
    const [entry] = useAppStore.getState().usageLedger.turns;
    expect(entry).toMatchObject({ key: "h-session-1:t1", agentId: "harness", providerId: "anthropic", modelId: "anthropic/claude-sonnet-5", effort: "high", inputTokens: 5_000, outputTokens: 300, estimated: false, tools: { bash: 1 } });
    vi.advanceTimersByTime(2_000);
    expect(JSON.parse(localStorage.getItem("glitter.usageLedger") ?? "null").turns).toHaveLength(1);
  });

  it("counts cached prompt tokens as input", () => {
    emit("sessionFacts", { sessionId: "h-session-1", usage: { promptTokens: 4_020, outputTokens: 640, cacheReadTokens: 90_000, cacheWriteTokens: 1_000, totalTokens: 95_660 } });
    emit("turnCompleted", completed);
    expect(useAppStore.getState().usageLedger.turns[0]).toMatchObject({ inputTokens: 91_020, cachedTokens: 91_000, outputTokens: 40 });
  });

  it("keeps the turn's own calls beside its totals", () => {
    emit("modelCall", { sessionId: "h-session-1", turnId: "t1", call: call({ stopReason: "tool_use", outputTokens: 40, toolCalls: 1 }) });
    emit("modelCall", { sessionId: "h-session-1", turnId: "t1", call: call({ stopReason: "end_turn", inputTokens: 1_400, outputTokens: 80 }) });
    emit("sessionFacts", { sessionId: "h-session-1", usage: { promptTokens: 6_000, outputTokens: 1_000, totalTokens: 7_000 } });
    emit("turnCompleted", completed);
    expect(useAppStore.getState().usageLedger.turns[0].calls?.map((entry) => [entry.stopReason, entry.inputTokens, entry.outputTokens])).toEqual([["tool_use", 900, 40], ["end_turn", 1_400, 80]]);
  });

  it("starts the next turn's trajectory from nothing", () => {
    emit("modelCall", { sessionId: "h-session-1", turnId: "t1", call: call() });
    emit("turnStarted", { sessionId: "h-session-1", turnId: "t2", cause: "userInput" });
    expect(useAppStore.getState().threads[0].turnCalls).toEqual([]);
    emit("modelCall", { sessionId: "h-session-1", turnId: "t2", call: call({ stopReason: "tool_use" }) });
    emit("sessionFacts", { sessionId: "h-session-1", usage: { promptTokens: 5_000, outputTokens: 800, totalTokens: 5_800 } });
    emit("turnCompleted", { sessionId: "h-session-1", turnId: "t2", outcome: { kind: "completed", params: { terminal: "completed" } } });
    expect(useAppStore.getState().usageLedger.turns.map((entry) => [entry.key, entry.calls?.length])).toEqual([["h-session-1:t2", 1]]);
  });

  it("updates cached input when it arrives after the turn, and keeps its trajectory", () => {
    emit("sessionFacts", { sessionId: "h-session-1", usage: { promptTokens: 5_000, outputTokens: 700, cacheReadTokens: 100 } });
    emit("modelCall", { sessionId: "h-session-1", turnId: "t1", call: call() });
    emit("turnCompleted", completed);
    const durationMs = useAppStore.getState().usageLedger.turns[0].durationMs;
    emit("usage", { sessionId: "h-session-1", usage: { promptTokens: 5_000, outputTokens: 700, cacheReadTokens: 900 } });
    expect(useAppStore.getState().usageLedger.turns[0]).toMatchObject({ inputTokens: 1_800, cachedTokens: 800, outputTokens: 100, durationMs });
    expect(useAppStore.getState().usageLedger.turns[0].calls).toHaveLength(1);
  });

  it("updates the same entry when usage lands after the turn ended", () => {
    emit("turnCompleted", completed);
    // Counted at once (it ran a tool), with no tokens yet.
    expect(useAppStore.getState().usageLedger.turns[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    const at = useAppStore.getState().usageLedger.turns[0].at;
    emit("sessionFacts", { sessionId: "h-session-1", usage: { promptTokens: 6_000, outputTokens: 1_000, totalTokens: 7_000 } });
    const turns = useAppStore.getState().usageLedger.turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ inputTokens: 2_000, outputTokens: 400, estimated: false, at });
  });

  it("clears on request", () => {
    emit("sessionFacts", { sessionId: "h-session-1", usage: { promptTokens: 9_000, outputTokens: 900, totalTokens: 9_900 } });
    emit("turnCompleted", completed);
    useAppStore.getState().clearUsageHistory();
    expect(useAppStore.getState().usageLedger.turns).toEqual([]);
    vi.advanceTimersByTime(2_000);
    expect(JSON.parse(localStorage.getItem("glitter.usageLedger") ?? "null").turns).toEqual([]);
  });
});
