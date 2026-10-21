import { useEffect, useMemo, useState, type CSSProperties, type ComponentType } from "react";
import { Clock3, FilePenLine, FileText, LoaderCircle, RotateCcw, Search, Terminal, Trash2, Wrench } from "lucide-react";
import { useAppStore } from "../lib/store";
import { formatResetIn, relativeTime, usageWindowLabel, windowPercent } from "../lib/format";
import { mockUsageLedger } from "../lib/mock";
import { PROVIDERS } from "../lib/providers";
import { groupUsage, ledgerSlices, type UsageGroup, type UsageSlice } from "../lib/usageLedger";
import { AGENT_LABELS, agentEnabled, type AgentId } from "../lib/types";
import { AgentMark } from "./AgentPicker";

type Period = "today" | "week" | "overview";
type Cell = { key: string; label: string; tokens: number; level: number };
type MapModel = { cells: Cell[]; columns: number; rows: number; labels: { text: string; column: number }[]; range: string; peakLabel: string };

const PERIODS: { id: Period; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "overview", label: "Overview" },
];

const DAY = 86_400_000;
/** Providers that get their own colour; the rest share "Other". */
const COLOR_SLOTS = 5;
const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const formatTokens = (value: number) => value ? compactNumber.format(Math.round(value)) : "0";
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const mondayOf = (date: Date) => {
  const value = startOfDay(date);
  value.setDate(value.getDate() - ((value.getDay() + 6) % 7));
  return value;
};
const sundayOf = (date: Date) => {
  const value = startOfDay(date);
  value.setDate(value.getDate() - value.getDay());
  return value;
};
const tokensOf = (entry: { inputTokens: number; outputTokens: number }) => entry.inputTokens + entry.outputTokens;
const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

const PROVIDER_NAMES: Record<string, string> = {
  ...Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider.name])),
  meta: "Meta",
  alibaba: "Alibaba Cloud",
  opencode: "OpenCode Zen",
};
export const providerName = (id: string) => PROVIDER_NAMES[id] ?? (AGENT_LABELS[id as AgentId] || (id ? id[0].toUpperCase() + id.slice(1) : "Unknown"));
/** "anthropic/claude-sonnet-5" reads as "claude-sonnet-5": the provider is shown beside it. */
const modelLabel = (modelId: string) => modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;

function periodStart(period: Period, now: Date) {
  if (period === "today") return startOfDay(now);
  if (period === "week") return mondayOf(now);
  return new Date(sundayOf(now).getTime() - 52 * 7 * DAY);
}

function totalBetween(slices: UsageSlice[], from: Date, to: Date) {
  const start = from.getTime();
  const end = to.getTime();
  return slices.reduce((sum, slice) => slice.at >= start && slice.at < end ? sum + tokensOf(slice) : sum, 0);
}

function quantize(values: number[]) {
  const active = values.filter(Boolean).sort((a, b) => a - b);
  return values.map((value) => {
    if (!value || !active.length) return 0;
    const rank = active.findIndex((candidate) => candidate >= value) / Math.max(1, active.length - 1);
    return Math.min(4, Math.max(1, Math.ceil(rank * 4)));
  });
}

function makeMap(period: Period, slices: UsageSlice[], now: Date): MapModel {
  const raw: Omit<Cell, "level">[] = [];
  const labels: MapModel["labels"] = [];
  let columns = 0;
  let rows = 0;
  let range = "";
  let peakLabel = "Peak period";
  const cell = (from: Date, to: Date, label: string) => {
    const tokens = from > now ? 0 : totalBetween(slices, from, to);
    raw.push({ key: from.toISOString(), label: `${label} · ${formatTokens(tokens)} tokens`, tokens });
  };

  if (period === "today") {
    columns = 24;
    rows = 4;
    const day = startOfDay(now);
    for (let row = 0; row < rows; row += 1) {
      for (let hour = 0; hour < columns; hour += 1) {
        const from = new Date(day.getTime() + hour * 3_600_000 + row * 900_000);
        cell(from, new Date(from.getTime() + 900_000), from.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
      }
    }
    [0, 4, 8, 12, 16, 20].forEach((hour) => labels.push({ text: hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`, column: hour + 1 }));
    range = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    peakLabel = "Peak 15 min";
  } else if (period === "week") {
    columns = 7;
    rows = 6;
    const week = mondayOf(now);
    for (let row = 0; row < rows; row += 1) {
      for (let dayIndex = 0; dayIndex < columns; dayIndex += 1) {
        const from = new Date(week.getTime() + dayIndex * DAY + row * 4 * 3_600_000);
        cell(from, new Date(from.getTime() + 4 * 3_600_000), `${from.toLocaleDateString([], { weekday: "long" })}, ${from.toLocaleTimeString([], { hour: "numeric" })}`);
      }
    }
    for (let dayIndex = 0; dayIndex < columns; dayIndex += 1) {
      labels.push({ text: new Date(week.getTime() + dayIndex * DAY).toLocaleDateString([], { weekday: "short" }), column: dayIndex + 1 });
    }
    const end = new Date(week.getTime() + 6 * DAY);
    range = `${week.toLocaleDateString([], { month: "short", day: "numeric" })} – ${end.toLocaleDateString([], { month: "short", day: "numeric" })}`;
    peakLabel = "Peak block";
  } else {
    columns = 53;
    rows = 7;
    const start = periodStart("overview", now);
    for (let row = 0; row < rows; row += 1) {
      for (let week = 0; week < columns; week += 1) {
        const from = new Date(start.getTime() + (week * 7 + row) * DAY);
        cell(from, new Date(from.getTime() + DAY), from.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }));
      }
    }
    let month = -1;
    for (let week = 0; week < columns; week += 1) {
      const date = new Date(start.getTime() + week * 7 * DAY);
      if (date.getMonth() !== month) {
        month = date.getMonth();
        labels.push({ text: date.toLocaleDateString([], { month: "short" }), column: week + 1 });
      }
    }
    range = `${start.toLocaleDateString([], { month: "short", year: "numeric" })} – ${now.toLocaleDateString([], { month: "short", year: "numeric" })}`;
    peakLabel = "Peak day";
  }

  const levels = quantize(raw.map((entry) => entry.tokens));
  return { cells: raw.map((entry, index) => ({ ...entry, level: levels[index] })), columns, rows, labels, range, peakLabel };
}

const TOOL_ICONS: Record<string, ComponentType<{ size?: number; "aria-hidden"?: boolean }>> = {
  bash: Terminal,
  shell: Terminal,
  codebase_search: Search,
  grep: Search,
  read_file: FileText,
  edit_file: FilePenLine,
};

function currentStreak(slices: UsageSlice[], now: Date) {
  const days = new Set(slices.map((slice) => startOfDay(new Date(slice.at)).getTime()));
  let cursor = startOfDay(now);
  if (!days.has(cursor.getTime())) cursor = new Date(cursor.getTime() - DAY);
  let streak = 0;
  while (days.has(cursor.getTime())) {
    streak += 1;
    cursor = startOfDay(new Date(cursor.getTime() - DAY / 2));
  }
  return streak;
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
  // Providers past the coloured slots share one grey segment, so no colour repeats.
  const segments = rows.reduce<Array<{ id: string; label: string; slot: number; tokens: number }>>((result, row) => {
    const tokens = tokensOf(row);
    if (!tokens) return result;
    const other = result.find((segment) => segment.slot === 0);
    if (row.slot === 0 && other) other.tokens += tokens;
    else result.push({ id: row.slot === 0 ? "other" : row.id, label: row.slot === 0 ? "Other providers" : providerName(row.id), slot: row.slot, tokens });
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
              {segments.map((segment) => <span key={segment.id} data-slot={segment.slot} style={{ flexGrow: segment.tokens }} title={`${segment.label} · ${formatTokens(segment.tokens)} tokens`} />)}
            </div>
          ) : null}
          <ol className="usage-provider-list">
            {rows.map((row) => (
              <li key={row.id}>
                <i className="usage-swatch" data-slot={row.slot} aria-hidden="true" />
                <span className="usage-provider-name">
                  <strong>{providerName(row.id)}</strong>
                  <span>{formatTokens(row.inputTokens)} in{row.cachedTokens ? ` (${formatTokens(row.cachedTokens)} cached)` : ""} · {row.estimatedTurns ? "≈" : ""}{formatTokens(row.outputTokens)} out · {plural(row.turns, "turn")}</span>
                </span>
                <span className="usage-provider-total">
                  <strong>{row.estimatedTurns ? "≈" : ""}{formatTokens(tokensOf(row))}</strong>
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

export function UsageView({ embedded = false }: { embedded?: boolean } = {}) {
  const stored = useAppStore((state) => state.usageLedger);
  const preview = useAppStore((state) => state.preview);
  // The plan meter is Meta's subscription. It stays off unless Muse itself is on,
  // so a disabled Muse CLI does not pin the page to a host that is not running.
  const museOn = useAppStore((state) => state.preview || (agentEnabled(state, "muse") && state.agents.some((agent) => agent.id === "muse" && agent.found)));
  const confirm = useAppStore((state) => state.confirm);
  const clearUsageHistory = useAppStore((state) => state.clearUsageHistory);
  const [period, setPeriod] = useState<Period>("overview");
  // The clock moves while the view is open, so Today rolls over and new turns land in the right cell.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const now = useMemo(() => new Date(nowMs), [nowMs]);
  const previewDay = preview ? startOfDay(now).getTime() : 0;
  const ledger = useMemo(() => preview ? mockUsageLedger() : stored, [preview, previewDay, stored]);
  const all = useMemo(() => ledgerSlices(ledger), [ledger]);
  const from = periodStart(period, now).getTime();
  const slices = useMemo(() => all.filter((slice) => slice.at >= from && slice.at <= nowMs), [all, from, nowMs]);
  const model = useMemo(() => makeMap(period, slices, now), [now, period, slices]);

  // Colours follow the provider, not its rank this period: slots are dealt by all-time use.
  const slots = useMemo(() => new Map(groupUsage(all, (slice) => slice.providerId).map((group, index) => [group.id, index < COLOR_SLOTS ? index + 1 : 0])), [all]);
  const input = slices.reduce((sum, slice) => sum + slice.inputTokens, 0);
  const cached = slices.reduce((sum, slice) => sum + slice.cachedTokens, 0);
  const output = slices.reduce((sum, slice) => sum + slice.outputTokens, 0);
  const total = input + output;
  const turns = slices.reduce((sum, slice) => sum + slice.turns, 0);
  const estimated = slices.reduce((sum, slice) => sum + slice.estimatedTurns, 0);
  const approx = estimated ? "≈" : "";
  const providers: ProviderRow[] = groupUsage(slices, (slice) => slice.providerId).map((group) => ({ ...group, slot: slots.get(group.id) ?? 0, share: total ? tokensOf(group) / total : 0 }));
  const providerOfModel = new Map(slices.filter((slice) => slice.modelId).map((slice) => [slice.modelId as string, slice.providerId]));
  const models = groupUsage(slices, (slice) => slice.modelId).slice(0, 5);
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
  const longest = Math.max(0, ...individual.map((slice) => slice.durationMs));
  const threads = new Set(individual.map((slice) => slice.threadId).filter(Boolean)).size;
  const workspaces = new Set(individual.map((slice) => slice.workspace).filter(Boolean)).size;
  const peak = Math.max(0, ...model.cells.map((entry) => entry.tokens));
  const mapStyle = { "--activity-columns": model.columns } as CSSProperties;

  const clearHistory = async () => {
    const ok = await confirm({ title: "Clear usage history?", body: "Every recorded turn and daily total is removed from this Mac. The Muse subscription reading is not affected.", confirmLabel: "Clear history", danger: true });
    if (ok) clearUsageHistory();
  };

  const periods = (
    <div className="usage-periods" role="tablist" aria-label="Usage period">
      {PERIODS.map((item) => (
        <button key={item.id} role="tab" aria-selected={period === item.id} onClick={() => setPeriod(item.id)}>{item.label}</button>
      ))}
    </div>
  );
  const clear = (
    <button type="button" className="ghost-btn small usage-clear" disabled={preview || !(stored.turns.length || stored.days.length)} onClick={() => void clearHistory()}>
      <Trash2 size={11} aria-hidden="true" />Clear history
    </button>
  );

  const Shell = embedded ? "div" : "main";
  const shellProps = embedded
    ? { className: "usage-embed" }
    : { id: "main-content", tabIndex: -1, className: "main usage-main solo" };

  return (
    <Shell {...shellProps}>
      {embedded ? <div className="usage-embed-head">{periods}{clear}</div> : (
        <header className="topbar usage-topbar" data-tauri-drag-region>
          <div>
            <h1>Usage</h1>
            <span>Tokens across every agent and provider</span>
          </div>
          <span className="grow" />
          {periods}
          {clear}
        </header>
      )}

      <div className="usage-scroll">
        {museOn ? <PlanUsage now={nowMs} /> : null}
        <section className="usage-summary" aria-label="Usage summary">
          <div><span>Tokens</span><strong>{approx}{formatTokens(total)}</strong></div>
          <div title={cached ? `${formatTokens(cached)} of it from prompt caches` : undefined}><span>Input</span><strong>{formatTokens(input)}</strong></div>
          <div><span>Output</span><strong>{approx}{formatTokens(output)}</strong></div>
          <div><span>Turns</span><strong>{turns.toLocaleString()}</strong></div>
          <div><span>Current streak</span><strong>{plural(currentStreak(all, now), "day")}</strong></div>
        </section>

        <ProviderBreakdown rows={providers} total={total} />

        <section className="usage-activity" aria-labelledby="token-activity-title">
          <div className="usage-section-head">
            <div><h2 id="token-activity-title">Token activity</h2><p>{model.range} · {model.peakLabel.toLowerCase()} {approx}{formatTokens(peak)}</p></div>
            <div className="usage-legend" aria-label="Activity intensity"><span>Less</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)}<span>More</span></div>
          </div>
          <div className={`activity-map period-${period}`} style={mapStyle} role="grid" aria-label={`${PERIODS.find((item) => item.id === period)?.label} token activity`}>
            {model.cells.map((entry) => <span key={entry.key} role="gridcell" data-level={entry.level} aria-label={entry.label} title={entry.label} />)}
          </div>
          <div className="activity-labels" style={mapStyle} aria-hidden="true">
            {model.labels.map((label) => <span key={`${label.text}-${label.column}`} style={{ gridColumn: label.column }}>{label.text}</span>)}
          </div>
        </section>

        <div className="usage-details">
          <section aria-labelledby="usage-models-title">
            <h2 id="usage-models-title">Top models</h2>
            {models.length ? <ol className="usage-ranking">
              {models.map((group) => {
                const provider = providerOfModel.get(group.id) ?? "";
                return (
                  <li key={group.id} title={group.id}>
                    <span className="usage-rank-swatch"><i className="usage-swatch" data-slot={slots.get(provider) ?? 0} aria-hidden="true" /></span>
                    <span>{modelLabel(group.id)}<em>{providerName(provider)}</em></span>
                    <strong>{group.estimatedTurns ? "≈" : ""}{formatTokens(tokensOf(group))}</strong>
                  </li>
                );
              })}
            </ol> : <p className="usage-empty">Models appear after your first turn.</p>}
          </section>

          <section aria-labelledby="active-agents-title">
            <h2 id="active-agents-title">By agent</h2>
            {agents.length ? <ol className="usage-ranking">
              {agents.map((group) => (
                <li key={group.id}>
                  <span className="usage-agent-mark"><AgentMark id={group.id as AgentId} size={17} /></span>
                  <span>{AGENT_LABELS[group.id as AgentId] ?? group.id}<em>{plural(group.turns, "turn")}</em></span>
                  <strong>{group.estimatedTurns ? "≈" : ""}{formatTokens(tokensOf(group))}</strong>
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
              <div><dt>Average per turn</dt><dd>{turns ? `${approx}${formatTokens(total / turns)}` : "—"}</dd></div>
              <div><dt>Longest turn</dt><dd>{longest ? `${Math.max(1, Math.round(longest / 60_000))}m` : "—"}</dd></div>
              <div><dt>Threads</dt><dd>{threads}</dd></div>
              <div><dt>Workspaces</dt><dd>{workspaces}</dd></div>
              <div><dt>Tool calls</dt><dd>{Object.values(toolCounts).reduce((sum, count) => sum + count, 0).toLocaleString()}</dd></div>
            </dl>
          </section>
        </div>
        <p className="usage-note">
          <Clock3 size={12} aria-hidden />
          <span>Counted as each turn finishes, from the tokens each agent reports, and kept on this Mac.{estimated ? ` ≈ marks ${plural(estimated, "turn")} whose agent reported no counts; those are estimated from the reply.` : ""}</span>
        </p>
      </div>
    </Shell>
  );
}
