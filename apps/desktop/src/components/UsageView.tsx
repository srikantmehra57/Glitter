import { useEffect, useMemo, useState, type CSSProperties, type ComponentType } from "react";
import { Clock3, Coins, FilePenLine, FileText, Flame, LoaderCircle, ChevronRight, Mountain, RefreshCw, RotateCcw, Search, Terminal, Trash2, Wrench, Zap } from "lucide-react";
import { useAppStore } from "../lib/store";
import { formatDuration, formatResetIn, humanizeStopReason, relativeTime, usageWindowLabel, windowPercent } from "../lib/format";
import { mockUsageLedger } from "../lib/mock";
import { PROVIDERS, customProviders } from "../lib/providers";
import { groupUsage, ledgerSlices, type UsageGroup, type UsageSlice } from "../lib/usageLedger";
import { activityMap, busiestDay, chartLabels, formatCount, formatSpan, peakTokens, smoothPath, streakStats, tokenTrend, type ActivityGrain } from "../lib/usageChart";
import { AGENT_LABELS, agentEnabled, type AgentId, type ModelCall } from "../lib/types";
import { AgentMark } from "./AgentPicker";

type RangeDays = 7 | 30;
const GRAINS: { id: ActivityGrain; label: string }[] = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "cumulative", label: "Cumulative" },
];
const RANGES: { id: RangeDays; label: string }[] = [
  { id: 7, label: "Last 7 days" },
  { id: 30, label: "Last 30 days" },
];

/** Providers that get their own colour; the rest share "Other". */
const COLOR_SLOTS = 5;
/** Turns the trajectory lists. The ledger keeps detail for more; the page stays readable. */
const TRAJECTORY_TURNS = 6;
const tokensOf = (entry: { inputTokens: number; outputTokens: number }) => entry.inputTokens + entry.outputTokens;
const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

const PROVIDER_NAMES: Record<string, string> = {
  ...Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider.name])),
  meta: "Meta",
  alibaba: "Alibaba Cloud",
  opencode: "OpenCode Zen",
};
export const providerName = (id: string, customs: ReadonlyArray<{ id: string; name: string }> = []) => PROVIDER_NAMES[id] ?? customs.find((row) => row.id === id)?.name ?? (AGENT_LABELS[id as AgentId] || (id ? id[0].toUpperCase() + id.slice(1) : "Unknown"));
/** "anthropic/claude-sonnet-5" reads as "claude-sonnet-5": the provider is shown beside it. */
const modelLabel = (modelId: string) => (modelId === "other" ? "Other" : modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId);

const TOOL_ICONS: Record<string, ComponentType<{ size?: number; "aria-hidden"?: boolean }>> = {
  bash: Terminal,
  shell: Terminal,
  codebase_search: Search,
  grep: Search,
  read_file: FileText,
  edit_file: FilePenLine,
};

function foldModels(groups: UsageGroup[], limit = COLOR_SLOTS): UsageGroup[] {
  if (groups.length <= limit) return groups;
  const other = groups.slice(limit).reduce<UsageGroup>((sum, group) => ({
    id: "other",
    inputTokens: sum.inputTokens + group.inputTokens,
    cachedTokens: sum.cachedTokens + group.cachedTokens,
    outputTokens: sum.outputTokens + group.outputTokens,
    turns: sum.turns + group.turns,
    estimatedTurns: sum.estimatedTurns + group.estimatedTurns,
  }), { id: "other", inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0, estimatedTurns: 0 });
  return [...groups.slice(0, limit), other];
}

function PlanUsage({ now }: { now: number }) {
  const usage = useAppStore((state) => state.subscriptionUsage);
  const loading = useAppStore((state) => state.subscriptionUsageLoading);
  const error = useAppStore((state) => state.subscriptionUsageError);
  const authenticated = useAppStore((state) => state.detection?.authenticated);
  const refresh = useAppStore((state) => state.refreshSubscriptionUsage);
  useEffect(() => { void refresh(); }, [refresh]);
  const rows = usage
    ? [
      { label: usageWindowLabel(usage.window.windowDurationMins), percent: usage.window.usedPercent, resetsAtMs: usage.window.resetsAtMs },
      { label: "Weekly", percent: usage.weekly.usedPercent, resetsAtMs: usage.weekly.resetsAtMs },
    ]
    : [];
  const ago = usage ? relativeTime(new Date(usage.observedAtMs).toISOString()) : "";
  return (
    <section className="usage-plan" aria-labelledby="plan-usage-title">
      <div className="usage-section-head">
        <div>
          <h2 id="plan-usage-title">Muse subscription</h2>
          <p>{usage ? `Reported by the Muse host · as of ${ago === "now" ? "now" : `${ago} ago`}` : "Reported by the Muse host once it has seen a turn."}</p>
        </div>
        <button type="button" className="ghost-btn small" disabled={loading} onClick={() => void refresh(true)}>
          {loading ? <LoaderCircle size={11} className="spin" aria-hidden="true" /> : <RotateCcw size={11} aria-hidden="true" />}
          {loading ? "Reading…" : "Refresh"}
        </button>
      </div>
      {rows.length ? (
        <div className="usage-plan-rows">
          {rows.map((row) => {
            const current = windowPercent(row.percent, row.resetsAtMs, now);
            const rounded = Math.round(current ?? 0);
            const tone = current == null ? "" : rounded >= 100 ? " over" : rounded >= 80 ? " high" : "";
            return (
              <div className="usage-row" key={row.label}>
                <div className="usage-row-head"><span>{row.label}</span><span className="usage-pct">{current == null ? "—" : `${rounded}%`}</span></div>
                <span className={`usage-bar${tone}`} role="img" aria-label={current == null ? "No current reading" : `${rounded}% used`}><span style={{ width: `${Math.min(100, Math.max(0, rounded))}%` }} /></span>
                <div className="usage-sub">{current == null ? "Reset since this reading" : formatResetIn(row.resetsAtMs, now)}</div>
              </div>
            );
          })}
        </div>
      ) : null}
      {error || !rows.length ? (
        <p className={`usage-empty${rows.length ? " usage-plan-error" : ""}`} role={error ? "alert" : "status"}>
          {error ? error : loading ? "Reading usage…" : authenticated === false ? "Sign in with the Muse CLI to see subscription usage." : "No reading yet. It appears after your first Muse turn."}
        </p>
      ) : null}
    </section>
  );
}

/** One provider's share of the period: a coloured segment, and a labelled row below. */
type ProviderRow = UsageGroup & { slot: number; share: number };

function ProviderBreakdown({ rows, total }: { rows: ProviderRow[]; total: number }) {
  // A custom endpoint is named what the user named it, not by its minted id.
  const customs = customProviders(useAppStore((state) => state.providerStatus) ?? []);
  // Providers past the coloured slots share one grey segment, so no colour repeats.
  const segments = rows.reduce<Array<{ id: string; label: string; slot: number; tokens: number }>>((result, row) => {
    const tokens = tokensOf(row);
    if (!tokens) return result;
    const other = result.find((segment) => segment.slot === 0);
    if (row.slot === 0 && other) other.tokens += tokens;
    else result.push({ id: row.slot === 0 ? "other" : row.id, label: row.slot === 0 ? "Other providers" : providerName(row.id, customs), slot: row.slot, tokens });
    return result;
  }, []).sort((a, b) => (a.slot || COLOR_SLOTS + 1) - (b.slot || COLOR_SLOTS + 1));
  return (
    <section className="usage-providers" aria-labelledby="usage-providers-title">
      <div className="usage-section-head">
        <div><h2 id="usage-providers-title">By provider</h2><p>Who served the tokens, across every agent</p></div>
      </div>
      {rows.length ? (
        <>
          {total ? (
            <div className="usage-share" role="img" aria-label={segments.map((segment) => `${segment.label} ${Math.round((segment.tokens / total) * 100)}%`).join(", ")}>
              {segments.map((segment) => <span key={segment.id} data-slot={segment.slot} style={{ flexGrow: segment.tokens }} title={`${segment.label} · ${formatCount(segment.tokens)} tokens`} />)}
            </div>
          ) : null}
          <ol className="usage-provider-list">
            {rows.map((row) => (
              <li key={row.id}>
                <i className="usage-swatch" data-slot={row.slot} aria-hidden="true" />
                <span className="usage-provider-name">
                  <strong>{providerName(row.id, customs)}</strong>
                  <span>{formatCount(row.inputTokens)} in{row.cachedTokens ? ` (${formatCount(row.cachedTokens)} cached)` : ""} · {row.estimatedTurns ? "≈" : ""}{formatCount(row.outputTokens)} out · {plural(row.turns, "turn")}</span>
                </span>
                <span className="usage-provider-total">
                  <strong>{row.estimatedTurns ? "≈" : ""}{formatCount(tokensOf(row))}</strong>
                  <span>{total ? `${Math.round(row.share * 100)}%` : "—"}</span>
                </span>
              </li>
            ))}
          </ol>
        </>
      ) : <p className="usage-empty">Each provider's share appears here after your first turn.</p>}
    </section>
  );
}

/** The exact counts behind one call's compact row. */
const callTokens = (call: ModelCall) => `${call.inputTokens.toLocaleString()} input${call.cachedTokens ? `, ${call.cachedTokens.toLocaleString()} of it cached` : ""} · ${call.outputTokens.toLocaleString()} output tokens`;

/** Each model call behind the recent turns' totals: what it sent, what came back, why it stopped. */
function Trajectory({ turns, slots }: { turns: UsageSlice[]; slots: Map<string, number> }) {
  return (
    <section className="usage-trajectory" aria-labelledby="usage-trajectory-title">
      <div className="usage-section-head">
        <div><h2 id="usage-trajectory-title">Trajectory</h2><p>Each model call behind these totals, newest first</p></div>
      </div>
      {turns.length ? (
        <ol className="usage-call-turns">
          {turns.map((slice) => {
            const calls = slice.calls ?? [];
            const at = new Date(slice.at);
            return (
              <li key={`${slice.threadId ?? "turn"}:${slice.at}`}>
                <details>
                  <summary>
                    <i className="usage-swatch" data-slot={slots.get(slice.providerId) ?? 0} aria-hidden="true" />
                    <ChevronRight size={13} className="usage-call-chevron" aria-hidden="true" />
                    <strong>{modelLabel(slice.modelId ?? "")}</strong>
                    <span className="usage-call-when">{at.toLocaleDateString([], { month: "short", day: "numeric" })} · {at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                    <span className="usage-call-sum">{plural(calls.length, "call")} · {formatCount(tokensOf(slice))} tokens · {formatDuration(slice.durationMs)}</span>
                  </summary>
                  <ol className="usage-call-list">
                    {calls.map((call, position) => (
                      <li key={`${call.at}:${position}`}>
                        <span className="usage-call-step">{position + 1}</span>
                        <span className="usage-call-what">
                          {modelLabel(call.modelId)}
                          {call.effort ? <em>{call.effort}</em> : null}
                          {call.attempt ? <span className="picker-tag usage-call-retry">attempt {call.attempt}</span> : null}
                        </span>
                        <span className="usage-call-tokens" title={callTokens(call)}>{formatCount(call.inputTokens)} in · {formatCount(call.outputTokens)} out{call.toolCalls ? ` · ${plural(call.toolCalls, "tool")}` : ""}</span>
                        <span className="usage-call-stop">{humanizeStopReason(call.stopReason)}</span>
                        <span className="usage-call-time">{formatDuration(call.durationMs)}</span>
                      </li>
                    ))}
                  </ol>
                </details>
              </li>
            );
          })}
        </ol>
      ) : <p className="usage-empty">Harness turns list every call here. Other agents report totals only.</p>}
    </section>
  );
}

function TokenTrendChart({ dates, series }: { dates: Date[]; series: Array<{ id: string; label: string; slot: number; values: number[] }> }) {
  const width = 640;
  const height = 188;
  const padX = 8;
  const padTop = 16;
  const padBottom = 8;
  const innerW = width - padX * 2;
  const innerH = height - padTop - padBottom;
  const max = Math.max(1, ...series.flatMap((item) => item.values));
  const count = Math.max(1, dates.length);
  const xAt = (index: number) => padX + (count <= 1 ? innerW / 2 : (index / (count - 1)) * innerW);
  const yAt = (value: number) => padTop + innerH - (value / max) * innerH;
  const grids = [0, 1, 2, 3].map((step) => padTop + (innerH * step) / 3);
  const indexes = chartLabels(dates.length);
  const summary = series.length
    ? series.map((item) => `${item.label} ${formatCount(item.values.reduce((sum, value) => sum + value, 0))}`).join(", ")
    : "No tokens in this range";
  return (
    <div className="usage-chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Daily token trend, last ${dates.length} days. ${summary}`} focusable="false">
        <g aria-hidden="true">
          {grids.map((y) => <line key={y} className="usage-chart-grid" x1={padX} x2={width - padX} y1={y} y2={y} />)}
          {[...series].reverse().map((item) => (
            <path key={item.id} className="usage-line" data-slot={item.slot} pathLength={1} d={smoothPath(item.values.map((value, index) => ({ x: xAt(index), y: yAt(value) })))} />
          ))}
        </g>
      </svg>
      <div className="usage-chart-labels" aria-hidden="true">
        {indexes.map((index) => {
          const align = index === 0 ? "start" : index === dates.length - 1 ? "end" : "mid";
          return <span key={dates[index].toISOString()} data-align={align} style={{ left: `${(xAt(index) / width) * 100}%` }}>{dates[index].toLocaleDateString([], { month: "short", day: "numeric" })}</span>;
        })}
      </div>
    </div>
  );
}

function ModelDonut({ segments, totalLabel }: { segments: Array<{ id: string; label: string; slot: number; tokens: number }>; totalLabel: string }) {
  const size = 160;
  const stroke = 26;
  const center = size / 2;
  const radius = (size - stroke) / 2 - 1;
  const circumference = 2 * Math.PI * radius;
  const drawn = segments.filter((segment) => segment.tokens > 0);
  const total = drawn.reduce((sum, segment) => sum + segment.tokens, 0);
  const gap = drawn.length > 1 ? Math.min(6, circumference * 0.012) : 0;
  let cursor = 0;
  const label = drawn.length ? drawn.map((segment) => `${segment.label} ${Math.round((segment.tokens / total) * 100)}%`).join(", ") : "No model usage";
  return (
    <div className="usage-donut">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} focusable="false">
        <g aria-hidden="true">
          <circle className="usage-donut-track" cx={center} cy={center} r={radius} strokeWidth={stroke} />
          {drawn.map((segment) => {
            const length = total ? (segment.tokens / total) * circumference : 0;
            const dash = Math.max(0, length - gap);
            const offset = cursor;
            cursor += length;
            return (
              <circle
                key={segment.id}
                className="usage-segment"
                data-slot={segment.slot}
                cx={center}
                cy={center}
                r={radius}
                strokeWidth={stroke}
                strokeDasharray={drawn.length > 1 ? `${dash} ${circumference - dash}` : undefined}
                strokeDashoffset={drawn.length > 1 ? -offset : undefined}
                transform={drawn.length > 1 ? `rotate(-90 ${center} ${center})` : undefined}
              />
            );
          })}
        </g>
      </svg>
      <div className="usage-donut-center">
        <strong>{totalLabel}</strong>
        <span>tokens</span>
      </div>
    </div>
  );
}

export function UsageView({ embedded = false }: { embedded?: boolean } = {}) {
  const stored = useAppStore((state) => state.usageLedger);
  const preview = useAppStore((state) => state.preview);
  // The plan meter is Meta's subscription. It stays off unless Muse itself is on,
  // so a disabled Muse CLI does not pin the page to a host that is not running.
  const museOn = useAppStore((state) => state.preview || (agentEnabled(state, "muse") && state.agents.some((agent) => agent.id === "muse" && agent.found)));
  const confirm = useAppStore((state) => state.confirm);
  const clearUsageHistory = useAppStore((state) => state.clearUsageHistory);
  const refreshSubscriptionUsage = useAppStore((state) => state.refreshSubscriptionUsage);
  const subscriptionLoading = useAppStore((state) => state.subscriptionUsageLoading);
  const [grain, setGrain] = useState<ActivityGrain>("daily");
  const [range, setRange] = useState<RangeDays>(7);
  const [refreshing, setRefreshing] = useState(false);
  // The clock moves while the view is open, so today rolls over and a new turn lands in the right cell.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!museOn) return;
    void refreshSubscriptionUsage();
    const timer = window.setInterval(() => void refreshSubscriptionUsage(), 60_000);
    return () => window.clearInterval(timer);
  }, [museOn, refreshSubscriptionUsage]);
  const now = useMemo(() => new Date(nowMs), [nowMs]);
  const previewDay = preview ? startOfPreview(now) : 0;
  const ledger = useMemo(() => preview ? mockUsageLedger() : stored, [preview, previewDay, stored]);
  const all = useMemo(() => ledgerSlices(ledger), [ledger]);
  const slices = useMemo(() => all.filter((slice) => slice.at <= nowMs), [all, nowMs]);
  const activity = useMemo(() => activityMap(slices, now, grain), [grain, now, slices]);
  const trend = useMemo(() => tokenTrend(slices, now, range), [now, range, slices]);

  // Colours follow the provider, not its rank this period: slots are dealt by all-time use.
  const slots = useMemo(() => new Map(groupUsage(all, (slice) => slice.providerId).map((group, index) => [group.id, index < COLOR_SLOTS ? index + 1 : 0])), [all]);
  const rankedModels = useMemo(() => groupUsage(slices, (slice) => slice.modelId), [slices]);
  const modelSlots = useMemo(() => new Map(rankedModels.map((group, index) => [group.id, index < COLOR_SLOTS ? index + 1 : 0])), [rankedModels]);
  const input = slices.reduce((sum, slice) => sum + slice.inputTokens, 0);
  const cached = slices.reduce((sum, slice) => sum + slice.cachedTokens, 0);
  const output = slices.reduce((sum, slice) => sum + slice.outputTokens, 0);
  const total = input + output;
  const turns = slices.reduce((sum, slice) => sum + slice.turns, 0);
  const estimated = slices.reduce((sum, slice) => sum + slice.estimatedTurns, 0);
  const approx = estimated ? "≈" : "";
  const providers: ProviderRow[] = groupUsage(slices, (slice) => slice.providerId).map((group) => ({ ...group, slot: slots.get(group.id) ?? 0, share: total ? tokensOf(group) / total : 0 }));
  const models = foldModels(rankedModels);
  const modelTotal = models.reduce((sum, group) => sum + tokensOf(group), 0);
  const modelApprox = models.some((group) => group.estimatedTurns) ? "≈" : "";
  const agents = groupUsage(slices, (slice) => slice.agentId);
  const toolCounts = slices.reduce<Record<string, number>>((result, slice) => {
    for (const [tool, count] of Object.entries(slice.tools)) result[tool] = (result[tool] ?? 0) + count;
    return result;
  }, {});
  const tools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const individual = slices.filter((slice) => !slice.wholeDay);
  const effortCounts = individual.reduce<Record<string, number>>((result, slice) => {
    if (slice.effort) result[slice.effort] = (result[slice.effort] ?? 0) + 1;
    return result;
  }, {});
  const reasoning = Object.entries(effortCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const longest = Math.max(0, ...(individual.length ? individual : slices).map((slice) => slice.durationMs));
  const threads = new Set(individual.map((slice) => slice.threadId).filter(Boolean)).size;
  const workspaces = new Set(individual.map((slice) => slice.workspace).filter(Boolean)).size;
  const trajectory = individual.filter((slice) => slice.calls?.length).sort((a, b) => b.at - a.at).slice(0, TRAJECTORY_TURNS);
  const streaks = useMemo(() => streakStats(slices, now), [now, slices]);
  const peak = useMemo(() => peakTokens(slices, now), [now, slices]);
  const busiest = useMemo(() => busiestDay(slices, now), [now, slices]);
  const trendSeries = trend.series.map((series) => ({
    ...series,
    label: modelLabel(series.id),
    slot: series.id === "other" ? 0 : (modelSlots.get(series.id) ?? 0),
  }));
  const mapStyle = { "--activity-columns": activity.columns } as CSSProperties;
  const grainLabel = GRAINS.find((item) => item.id === grain)?.label ?? "Daily";

  const clearHistory = async () => {
    const ok = await confirm({ title: "Clear usage history?", body: "Every recorded turn and daily total is removed from this Mac. The Muse subscription reading is not affected.", confirmLabel: "Clear history", danger: true });
    if (ok) clearUsageHistory();
  };

  const refreshPage = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setNowMs(Date.now());
    try {
      if (museOn) await refreshSubscriptionUsage(true);
    } finally {
      setRefreshing(false);
    }
  };

  const refresh = (
    <button type="button" className="secondary" disabled={refreshing || subscriptionLoading} onClick={() => void refreshPage()}>
      <RefreshCw size={14} className={refreshing || subscriptionLoading ? "spin" : undefined} aria-hidden="true" />
      {refreshing || subscriptionLoading ? "Refreshing…" : "Refresh"}
    </button>
  );

  const clear = (
    <button type="button" className="secondary usage-clear" disabled={preview || !(stored.turns.length || stored.days.length)} onClick={() => void clearHistory()}>
      <Trash2 size={14} aria-hidden="true" />Clear history
    </button>
  );

  const Shell = embedded ? "div" : "main";
  const shellProps = embedded
    ? { className: "usage-embed" }
    : { id: "main-content", tabIndex: -1, className: "main usage-main solo" };

  return (
    <Shell {...shellProps}>
      {embedded ? null : (
        <header className="topbar usage-topbar" data-tauri-drag-region>
          <div className="usage-page-title">
            <h1>Usage stats</h1>
            <span className="usage-scope">App usage</span>
          </div>
          <span className="grow" />
          {refresh}
          {clear}
        </header>
      )}

      <div className="usage-scroll">
        <section className="usage-summary" aria-label="Usage summary">
          <div className="lead">
            <Coins size={15} aria-hidden="true" />
            <div><strong>{approx}{formatCount(total)}</strong><span>Total tokens</span></div>
          </div>
          <div>
            <Zap size={15} aria-hidden="true" />
            <div><strong>{formatCount(peak)}</strong><span>Peak day</span></div>
          </div>
          <div>
            <Clock3 size={15} aria-hidden="true" />
            <div><strong aria-label={longest ? formatDuration(longest) : "0 minutes"}>{formatSpan(longest)}</strong><span>Longest turn</span></div>
          </div>
          <div>
            <Flame size={15} aria-hidden="true" />
            <div><strong aria-label={plural(streaks.current, "day")}>{plural(streaks.current, "day")}</strong><span>Current streak</span></div>
          </div>
          <div>
            <Mountain size={15} aria-hidden="true" />
            <div><strong aria-label={plural(streaks.longest, "day")}>{plural(streaks.longest, "day")}</strong><span>Longest streak</span></div>
          </div>
        </section>

        <section className="usage-activity" aria-labelledby="token-activity-title">
          <div className="usage-section-head">
            <div>
              <h2 id="token-activity-title">Token activity</h2>
              <p>{busiest ? `One year of days · busiest ${busiest.at.toLocaleDateString([], { month: "short", day: "numeric" })} at ${formatCount(busiest.tokens)} tokens` : "One year of days, one cell each"}</p>
            </div>
            <div className="usage-periods" role="tablist" aria-label="Activity grain">
              {GRAINS.map((item) => (
                <button key={item.id} type="button" role="tab" aria-selected={grain === item.id} onClick={() => setGrain(item.id)}>{item.label}</button>
              ))}
            </div>
          </div>
          <div className="activity-labels" style={mapStyle} aria-hidden="true">
            {activity.labels.map((label) => <span key={`${label.text}-${label.column}`} style={{ gridColumn: label.column }}>{label.text}</span>)}
          </div>
          <div className="activity-map" style={mapStyle} role="grid" aria-label={`${grainLabel} token activity`}>
            {activity.cells.map((entry, index) => <span key={entry.key} role="gridcell" data-level={entry.level} aria-label={entry.label} title={entry.label} style={{ "--i": index } as CSSProperties} />)}
          </div>
          <div className="activity-legend" aria-hidden="true">
            <span>Less</span>
            {[0, 1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)}
            <span>More</span>
          </div>
        </section>

        <section className="usage-trend" aria-labelledby="usage-trend-title">
          <div className="usage-section-head">
            <div><h2 id="usage-trend-title">Token trend</h2><p>Tokens per day, by model</p></div>
            <div className="usage-periods" role="tablist" aria-label="Trend range">
              {RANGES.map((item) => (
                <button key={item.id} type="button" role="tab" aria-selected={range === item.id} onClick={() => setRange(item.id)}>{item.label}</button>
              ))}
            </div>
          </div>
          {trendSeries.length ? (
            <ul className="usage-legend-models">
              {trendSeries.map((series) => (
                <li key={series.id}><i className="usage-dot" data-slot={series.slot} aria-hidden="true" />{series.label}</li>
              ))}
            </ul>
          ) : <p className="usage-empty">{slices.length ? "No tokens in this range." : "Trends appear after your first turn."}</p>}
          <TokenTrendChart dates={trend.dates} series={trendSeries} />
        </section>

        <section className="usage-models" aria-labelledby="usage-models-title">
          <div className="usage-section-head"><div><h2 id="usage-models-title">Model usage</h2><p>Each model's share of all tokens</p></div></div>
          {models.length ? (
            <div className="usage-model-body">
              <ModelDonut
                totalLabel={`${modelApprox}${formatCount(modelTotal)}`}
                segments={models.map((group) => ({ id: group.id, label: modelLabel(group.id), slot: group.id === "other" ? 0 : (modelSlots.get(group.id) ?? 0), tokens: tokensOf(group) }))}
              />
              <ol className="usage-model-list">
                {models.map((group) => {
                  const tokens = tokensOf(group);
                  const share = modelTotal ? Math.round((tokens / modelTotal) * 100) : 0;
                  return (
                    <li key={group.id} title={group.id}>
                      <i className="usage-dot" data-slot={group.id === "other" ? 0 : (modelSlots.get(group.id) ?? 0)} aria-hidden="true" />
                      <span className="usage-model-name">{modelLabel(group.id)}</span>
                      <span className="usage-model-pct">{modelTotal ? `${share}%` : "—"}</span>
                      <span className="usage-model-tokens">{group.estimatedTurns ? "≈" : ""}{formatCount(tokens)} tokens</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : <p className="usage-empty">Models appear after your first turn.</p>}
        </section>

        <ProviderBreakdown rows={providers} total={total} />

        <div className="usage-details">
          <section aria-labelledby="active-agents-title">
            <h2 id="active-agents-title">By agent</h2>
            {agents.length ? <ol className="usage-ranking">
              {agents.map((group) => (
                <li key={group.id}>
                  <span className="usage-agent-mark"><AgentMark id={group.id as AgentId} size={17} /></span>
                  <span>{AGENT_LABELS[group.id as AgentId] ?? group.id}<em>{plural(group.turns, "turn")}</em></span>
                  <strong>{group.estimatedTurns ? "≈" : ""}{formatCount(tokensOf(group))}</strong>
                </li>
              ))}
            </ol> : <p className="usage-empty">Agents appear after your first turn.</p>}
          </section>

          <section aria-labelledby="used-tools-title">
            <h2 id="used-tools-title">Most used tools</h2>
            {tools.length ? <ol className="usage-ranking">
              {tools.map(([tool, count]) => {
                const Icon = TOOL_ICONS[tool] ?? Wrench;
                return <li key={tool}><span className="usage-tool-icon"><Icon size={15} aria-hidden /></span><span>{tool.replaceAll("_", " ")}</span><strong>{plural(count, "run")}</strong></li>;
              })}
            </ol> : <p className="usage-empty">Tool activity appears after your first run.</p>}
          </section>

          <section aria-labelledby="activity-insights-title">
            <h2 id="activity-insights-title">Activity insights</h2>
            <dl className="insight-list">
              <div><dt>Most used reasoning</dt><dd>{reasoning ? reasoning[0].toUpperCase() + reasoning.slice(1) : "—"}</dd></div>
              <div><dt>Cached input</dt><dd>{input ? `${Math.round((cached / input) * 100)}%` : "—"}</dd></div>
              <div><dt>Average per turn</dt><dd>{turns ? `${approx}${formatCount(total / turns)}` : "—"}</dd></div>
              <div><dt>Threads</dt><dd>{threads}</dd></div>
              <div><dt>Workspaces</dt><dd>{workspaces}</dd></div>
              <div><dt>Tool calls</dt><dd>{Object.values(toolCounts).reduce((sum, count) => sum + count, 0).toLocaleString()}</dd></div>
            </dl>
          </section>
        </div>
        <Trajectory turns={trajectory} slots={slots} />
        {/* Muse's own plan meter, for people who also run Muse: after Glitter's counts, not ahead of them. */}
        {museOn ? <PlanUsage now={nowMs} /> : null}
        <p className="usage-note">
          <Clock3 size={12} aria-hidden />
          <span>Counted as each turn finishes, from the tokens each agent reports, and kept on this Mac.{estimated ? ` ≈ marks ${plural(estimated, "turn")} whose agent reported no counts; those are estimated from the reply.` : ""}</span>
        </p>
        {embedded ? <div className="usage-footer">{refresh}{clear}</div> : null}
      </div>
    </Shell>
  );
}

/** The preview ledger is keyed to the local day, so it stays put until midnight. */
const startOfPreview = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
