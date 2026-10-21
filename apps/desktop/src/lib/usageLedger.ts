import type { AgentId, ModelCall, Thread } from "./types";

/**
 * A durable record of usage, kept by the app itself: one entry per finished
 * turn, with its agent, provider, model, tokens, duration and tools. Before it,
 * the Usage view re-estimated everything from whichever transcripts happened to
 * be loaded, so its numbers moved with what was open and a restart showed a
 * stale picture. Recent turns stay individual (the Today and week maps need
 * their times); older ones roll up into daily totals so the record stays small.
 */

export type UsageTurn = {
  /** `sessionId:turnId`, so a late usage report updates the same entry. */
  key: string;
  at: number;
  agentId: AgentId;
  providerId: string;
  modelId?: string;
  effort?: string;
  /** Every prompt token, cached ones included. */
  inputTokens: number;
  /** The part of the input read from or written to a provider's prompt cache. */
  cachedTokens: number;
  outputTokens: number;
  /** No usage was reported, so the output count is estimated from the reply text. */
  estimated: boolean;
  durationMs: number;
  threadId: string;
  workspace: string;
  tools: Record<string, number>;
  /** The turn's own model calls, newest turns only: the trajectory behind these totals. */
  calls?: ModelCall[];
};

/** One day's totals for one agent, provider and model. */
export type UsageDay = {
  day: string;
  agentId: AgentId;
  providerId: string;
  modelId?: string;
  turns: number;
  estimatedTurns: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  durationMs: number;
  tools: Record<string, number>;
};

export type UsageLedger = { version: 1; turns: UsageTurn[]; days: UsageDay[] };

export const EMPTY_LEDGER: UsageLedger = { version: 1, turns: [], days: [] };

/** Turns younger than this stay individual. */
export const RECENT_DAYS = 14;
const MAX_TURNS = 4000;
const MAX_DAY_AGE = 400;
const DAY_MS = 86_400_000;
/** Calls kept for one turn. The harness stops a turn at 80 steps, so this is a whole trajectory. */
export const MAX_TURN_CALLS = 80;
/** Turns whose calls are kept. Older turns keep their totals: per-call detail is only read for recent work. */
export const MAX_CALL_TURNS = 25;

export function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Local midday of a `YYYY-MM-DD` key: inside that day in every time zone offset. */
export function dayStart(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, (month || 1) - 1, date || 1, 12).getTime();
}

/** Agents and catalogs that name a provider by product: the company behind it. */
const PROVIDER_ALIASES: Record<string, string> = { muse: "meta", grok: "xai", gemini: "google", qwen: "alibaba", claude: "anthropic" };

/** Who served a turn: the model's provider prefix, else the catalog's provider, else the agent's own service. */
export function providerOf(agentId: AgentId, modelId?: string, providerId?: string): string {
  const named = modelId?.includes("/") ? modelId.slice(0, modelId.indexOf("/")) : providerId || agentId;
  return PROVIDER_ALIASES[named] ?? named;
}

const addTools = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [tool, count] of Object.entries(from)) into[tool] = (into[tool] ?? 0) + count;
  return into;
};

/** Roll turns older than the recent window into daily totals, and drop what is past keeping. */
export function compact(ledger: UsageLedger, now = Date.now()): UsageLedger {
  const cutoff = now - RECENT_DAYS * DAY_MS;
  const keep: UsageTurn[] = [];
  const days = new Map(ledger.days.map((day) => [`${day.day}\u0000${day.agentId}\u0000${day.providerId}\u0000${day.modelId ?? ""}`, { ...day, tools: { ...day.tools } }]));
  const sorted = ledger.turns.slice().sort((a, b) => a.at - b.at);
  const overflow = Math.max(0, sorted.length - MAX_TURNS);
  sorted.forEach((turn, index) => {
    if (turn.at >= cutoff && index >= overflow) { keep.push(turn); return; }
    const day = dayKey(turn.at);
    const key = `${day}\u0000${turn.agentId}\u0000${turn.providerId}\u0000${turn.modelId ?? ""}`;
    const total = days.get(key) ?? { day, agentId: turn.agentId, providerId: turn.providerId, ...(turn.modelId ? { modelId: turn.modelId } : {}), turns: 0, estimatedTurns: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, durationMs: 0, tools: {} };
    total.turns += 1;
    total.estimatedTurns += turn.estimated ? 1 : 0;
    total.inputTokens += turn.inputTokens;
    total.cachedTokens += turn.cachedTokens;
    total.outputTokens += turn.outputTokens;
    total.durationMs += turn.durationMs;
    addTools(total.tools, turn.tools);
    days.set(key, total);
  });
  const oldest = dayKey(now - MAX_DAY_AGE * DAY_MS);
  // `keep` is in time order, so only its tail stays detailed.
  const detailedFrom = Math.max(0, keep.length - MAX_CALL_TURNS);
  const turns = keep.map((turn, index) => (index < detailedFrom && turn.calls ? { ...turn, calls: undefined } : turn));
  return { version: 1, turns, days: [...days.values()].filter((day) => day.day >= oldest).sort((a, b) => a.day.localeCompare(b.day)) };
}

/** Add or update one turn (a late usage report replaces the estimate), then compact. */
export function recordTurn(ledger: UsageLedger, turn: UsageTurn, now = Date.now()): UsageLedger {
  const turns = ledger.turns.filter((entry) => entry.key !== turn.key);
  turns.push(turn);
  return compact({ ...ledger, turns }, now);
}

/**
 * The ledger entry for a thread's finished turn, or null when there is nothing
 * to count. Tools are the turn's own tool calls; tokens are what the agent
 * reported (or the estimate `finishTurn` made when it reported none).
 */
export function turnEntry(thread: Pick<Thread, "sessionId" | "agentId" | "config" | "turnStats" | "items" | "workspacePath" | "worktree" | "turnCalls">, at = Date.now()): UsageTurn | null {
  const stats = thread.turnStats;
  if (!stats?.turnId) return null;
  const tools: Record<string, number> = {};
  for (const item of thread.items) {
    if (item.turnId === stats.turnId && item.kind === "toolCall" && item.tool) tools[item.tool] = (tools[item.tool] ?? 0) + 1;
  }
  const cachedTokens = Math.max(0, Math.round(stats.cachedTokens ?? 0));
  const inputTokens = Math.max(0, Math.round(stats.inputTokens ?? 0)) + cachedTokens;
  const outputTokens = Math.max(0, Math.round(stats.outputTokens ?? 0));
  if (!inputTokens && !outputTokens && !Object.keys(tools).length) return null;
  const agentId: AgentId = thread.agentId ?? "muse";
  const modelId = thread.config?.modelId;
  return {
    key: `${thread.sessionId}:${stats.turnId}`,
    at,
    agentId,
    providerId: providerOf(agentId, modelId, thread.config?.providerId),
    ...(modelId ? { modelId } : {}),
    ...(thread.config?.effort ? { effort: thread.config.effort } : {}),
    inputTokens,
    cachedTokens,
    outputTokens,
    estimated: Boolean(stats.estimated),
    durationMs: Math.max(0, stats.durationMs ?? 0),
    threadId: thread.sessionId,
    workspace: thread.worktree?.path ?? thread.workspacePath,
    tools,
    ...(thread.turnCalls?.length ? { calls: thread.turnCalls.slice(-MAX_TURN_CALLS) } : {}),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
const tools = (value: unknown) => Object.fromEntries(Object.entries(isRecord(value) ? value : {}).filter(([, count]) => typeof count === "number" && count > 0)) as Record<string, number>;
/** A turn's stored calls, checked field by field and bounded; undefined when it has none. */
const asCalls = (value: unknown): ModelCall[] | undefined => {
  const calls = (Array.isArray(value) ? value : []).filter(isRecord)
    .filter((call) => typeof call.providerId === "string" && typeof call.modelId === "string")
    .slice(-MAX_TURN_CALLS)
    .map((call): ModelCall => ({
      at: num(call.at),
      providerId: String(call.providerId),
      modelId: String(call.modelId),
      ...(typeof call.effort === "string" ? { effort: call.effort } : {}),
      inputTokens: num(call.inputTokens),
      cachedTokens: num(call.cachedTokens),
      outputTokens: num(call.outputTokens),
      ...(typeof call.stopReason === "string" ? { stopReason: call.stopReason } : {}),
      durationMs: num(call.durationMs),
      ...(num(call.attempt) > 1 ? { attempt: num(call.attempt) } : {}),
      toolCalls: num(call.toolCalls),
    }));
  return calls.length ? calls : undefined;
};

/** A stored ledger, checked field by field: anything malformed is dropped rather than trusted. */
export function asLedger(raw: unknown): UsageLedger {
  if (!isRecord(raw) || raw.version !== 1) return EMPTY_LEDGER;
  const turns = (Array.isArray(raw.turns) ? raw.turns : []).filter(isRecord).filter((turn) => typeof turn.key === "string" && typeof turn.agentId === "string" && typeof turn.providerId === "string").map((turn): UsageTurn => ({
    key: String(turn.key),
    at: num(turn.at),
    agentId: turn.agentId as AgentId,
    providerId: String(turn.providerId),
    ...(typeof turn.modelId === "string" ? { modelId: turn.modelId } : {}),
    ...(typeof turn.effort === "string" ? { effort: turn.effort } : {}),
    inputTokens: num(turn.inputTokens),
    cachedTokens: num(turn.cachedTokens),
    outputTokens: num(turn.outputTokens),
    estimated: turn.estimated === true,
    durationMs: num(turn.durationMs),
    threadId: String(turn.threadId ?? ""),
    workspace: String(turn.workspace ?? ""),
    tools: tools(turn.tools),
    calls: asCalls(turn.calls),
  }));
  const days = (Array.isArray(raw.days) ? raw.days : []).filter(isRecord).filter((day) => typeof day.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day.day) && typeof day.agentId === "string" && typeof day.providerId === "string").map((day): UsageDay => ({
    day: String(day.day),
    agentId: day.agentId as AgentId,
    providerId: String(day.providerId),
    ...(typeof day.modelId === "string" ? { modelId: day.modelId } : {}),
    turns: num(day.turns),
    estimatedTurns: num(day.estimatedTurns),
    inputTokens: num(day.inputTokens),
    cachedTokens: num(day.cachedTokens),
    outputTokens: num(day.outputTokens),
    durationMs: num(day.durationMs),
    tools: tools(day.tools),
  }));
  return { version: 1, turns, days };
}

/**
 * Tokens and turns whose time falls in `[from, now]`. Day totals count when
 * their calendar day does, so a rolled-up day is not missed before midday.
 */
export function totalsSince(ledger: UsageLedger, from: number, now = Date.now()): { tokens: number; turns: number; estimated: boolean } {
  const startDay = dayKey(from);
  const endDay = dayKey(now);
  let tokens = 0;
  let turns = 0;
  let estimated = false;
  for (const turn of ledger.turns) {
    if (turn.at < from || turn.at > now) continue;
    tokens += turn.inputTokens + turn.outputTokens;
    turns += 1;
    estimated = estimated || turn.estimated;
  }
  for (const day of ledger.days) {
    if (day.day < startDay || day.day > endDay) continue;
    tokens += day.inputTokens + day.outputTokens;
    turns += day.turns;
    estimated = estimated || day.estimatedTurns > 0;
  }
  return { tokens, turns, estimated };
}

/** One countable slice for the Usage view: a recent turn, or an older day's total. */
export type UsageSlice = {
  at: number;
  /** Whole-day totals carry no time of day. */
  wholeDay: boolean;
  agentId: AgentId;
  providerId: string;
  modelId?: string;
  effort?: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  turns: number;
  estimatedTurns: number;
  durationMs: number;
  threadId?: string;
  workspace?: string;
  tools: Record<string, number>;
  /** Only individual recent turns carry calls; a rolled-up day does not. */
  calls?: ModelCall[];
};

export function ledgerSlices(ledger: UsageLedger): UsageSlice[] {
  return [
    ...ledger.days.map((day): UsageSlice => ({ at: dayStart(day.day), wholeDay: true, agentId: day.agentId, providerId: day.providerId, ...(day.modelId ? { modelId: day.modelId } : {}), inputTokens: day.inputTokens, cachedTokens: day.cachedTokens, outputTokens: day.outputTokens, turns: day.turns, estimatedTurns: day.estimatedTurns, durationMs: day.durationMs, tools: day.tools })),
    ...ledger.turns.map((turn): UsageSlice => ({ at: turn.at, wholeDay: false, agentId: turn.agentId, providerId: turn.providerId, ...(turn.modelId ? { modelId: turn.modelId } : {}), ...(turn.effort ? { effort: turn.effort } : {}), inputTokens: turn.inputTokens, cachedTokens: turn.cachedTokens, outputTokens: turn.outputTokens, turns: 1, estimatedTurns: turn.estimated ? 1 : 0, durationMs: turn.durationMs, threadId: turn.threadId, workspace: turn.workspace, tools: turn.tools, ...(turn.calls ? { calls: turn.calls } : {}) })),
  ];
}

export type UsageGroup = { id: string; inputTokens: number; cachedTokens: number; outputTokens: number; turns: number; estimatedTurns: number };

/** Totals per key (provider, agent, model), largest first. */
export function groupUsage(slices: UsageSlice[], key: (slice: UsageSlice) => string | undefined): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const slice of slices) {
    const id = key(slice);
    if (!id) continue;
    const group = groups.get(id) ?? { id, inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0, estimatedTurns: 0 };
    group.inputTokens += slice.inputTokens;
    group.cachedTokens += slice.cachedTokens;
    group.outputTokens += slice.outputTokens;
    group.turns += slice.turns;
    group.estimatedTurns += slice.estimatedTurns;
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) || b.turns - a.turns);
}
