import type { UsageSlice } from "./usageLedger";

/**
 * The usage page's charts. Pure so the year map, the trend and the streaks
 * can be checked without rendering. The map is one year of days, Sunday
 * columns, the same shape in every grain; only the colour's meaning changes.
 */

const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
/** Usage-page counts: 222200 → "222.2K". Zero stays "0", not a compact "0". */
export const formatCount = (value: number) => (value ? compactNumber.format(Math.round(value)) : "0");

export const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

export const addDays = (date: Date, days: number) => {
  const next = startOfDay(date);
  next.setDate(next.getDate() + days);
  return next;
};

const sundayOf = (date: Date) => addDays(date, -startOfDay(date).getDay());
const tokensOf = (slice: UsageSlice) => slice.inputTokens + slice.outputTokens;

/** A stat-strip length: "0 m", "12 m", "3 h", "2 d". */
export function formatSpan(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

export type ActivityGrain = "daily" | "weekly" | "cumulative";

export type ActivityCell = { key: string; label: string; tokens: number; level: number };
export type ActivityMap = { cells: ActivityCell[]; columns: number; labels: { text: string; column: number }[] };

const YEAR_WEEKS = 53;
const WEEK_ROWS = 7;

function yearWindow(now: Date) {
  const today = startOfDay(now);
  return { today, start: addDays(sundayOf(today), -(YEAR_WEEKS - 1) * 7) };
}

/** Relative intensity. Equal values are the peak, so one active day reads full. */
export function quantize(values: number[]): number[] {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (!active.length) return values.map(() => 0);
  if (active[0] === active[active.length - 1]) return values.map((value) => (value > 0 ? 4 : 0));
  return values.map((value) => {
    if (value <= 0) return 0;
    let index = 0;
    for (let cursor = 0; cursor < active.length; cursor += 1) if (active[cursor] <= value) index = cursor;
    return Math.min(4, Math.max(1, Math.ceil((index / (active.length - 1)) * 4)));
  });
}

/** Days of use, newest run and the longest run. A day counts even when its tokens were unreported. */
export function streakStats(slices: UsageSlice[], now: Date): { current: number; longest: number } {
  const days = new Set(slices.map((slice) => startOfDay(new Date(slice.at)).getTime()));
  if (!days.size) return { current: 0, longest: 0 };
  const sorted = [...days].sort((a, b) => a - b);
  let longest = 1;
  let run = 1;
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === addDays(new Date(sorted[index - 1]), 1).getTime()) {
      run += 1;
      if (run > longest) longest = run;
    } else run = 1;
  }
  let cursor = startOfDay(now);
  if (!days.has(cursor.getTime())) cursor = addDays(cursor, -1);
  let current = 0;
  while (days.has(cursor.getTime())) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  return { current, longest };
}

/** Busiest day inside the year the activity map draws. */
export function peakTokens(slices: UsageSlice[], now: Date): number {
  const { start, today } = yearWindow(now);
  const startMs = start.getTime();
  const todayMs = today.getTime();
  const totals = new Map<number, number>();
  for (const slice of slices) {
    const day = startOfDay(new Date(slice.at)).getTime();
    if (day < startMs || day > todayMs) continue;
    totals.set(day, (totals.get(day) ?? 0) + tokensOf(slice));
  }
  let peak = 0;
  for (const total of totals.values()) if (total > peak) peak = total;
  return peak;
}

/** The day the year map should name in its header: the busiest, when there was one. */
export function busiestDay(slices: UsageSlice[], now: Date): { at: Date; tokens: number } | null {
  const { start, today } = yearWindow(now);
  const startMs = start.getTime();
  const todayMs = today.getTime();
  const totals = new Map<number, number>();
  for (const slice of slices) {
    const day = startOfDay(new Date(slice.at)).getTime();
    if (day < startMs || day > todayMs) continue;
    totals.set(day, (totals.get(day) ?? 0) + tokensOf(slice));
  }
  let bestDay = 0;
  let best = 0;
  for (const [day, total] of totals) if (total > best) { best = total; bestDay = day; }
  return bestDay ? { at: new Date(bestDay), tokens: best } : null;
}

const dayText = (date: Date) => date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

export function activityMap(slices: UsageSlice[], now: Date, grain: ActivityGrain): ActivityMap {
  const { start, today } = yearWindow(now);
  const todayMs = today.getTime();
  const daily = new Map<number, number>();
  for (const slice of slices) {
    const day = startOfDay(new Date(slice.at)).getTime();
    daily.set(day, (daily.get(day) ?? 0) + tokensOf(slice));
  }
  const weekly = new Map<number, number>();
  const cumulative = new Map<number, number>();
  let running = 0;
  for (let week = 0; week < YEAR_WEEKS; week += 1) {
    const weekStart = addDays(start, week * 7).getTime();
    let weekTotal = 0;
    for (let row = 0; row < WEEK_ROWS; row += 1) {
      const day = addDays(start, week * 7 + row).getTime();
      const own = day > todayMs ? 0 : (daily.get(day) ?? 0);
      weekTotal += own;
      if (own) running += own;
      if (running) cumulative.set(day, running);
    }
    weekly.set(weekStart, weekTotal);
  }

  const raw: Array<Omit<ActivityCell, "level">> = [];
  for (let row = 0; row < WEEK_ROWS; row += 1) {
    for (let week = 0; week < YEAR_WEEKS; week += 1) {
      const date = addDays(start, week * 7 + row);
      const time = date.getTime();
      const own = time > todayMs ? 0 : (daily.get(time) ?? 0);
      const weekStart = addDays(start, week * 7);
      const tokens = grain === "weekly" ? (time > todayMs ? 0 : (weekly.get(weekStart.getTime()) ?? 0)) : grain === "cumulative" ? (cumulative.get(time) ?? 0) : own;
      const amount = `${formatCount(tokens)} tokens`;
      const label = grain === "weekly" && tokens
        ? `Week of ${weekStart.toLocaleDateString([], { month: "short", day: "numeric" })} · ${dayText(date)} · ${amount} this week`
        : grain === "cumulative" && tokens
          ? `${dayText(date)} · ${amount} cumulative`
          : `${dayText(date)} · ${amount}`;
      raw.push({ key: date.toISOString(), label, tokens });
    }
  }

  const labels: ActivityMap["labels"] = [];
  for (let week = 0; week < YEAR_WEEKS; week += 1) {
    for (let row = 0; row < WEEK_ROWS; row += 1) {
      const date = addDays(start, week * 7 + row);
      if (date.getDate() !== 1) continue;
      labels.push({ text: date.toLocaleDateString([], { month: "short" }), column: week + 1 });
      break;
    }
  }
  const levels = quantize(raw.map((cell) => cell.tokens));
  return { cells: raw.map((cell, index) => ({ ...cell, level: levels[index] })), columns: YEAR_WEEKS, labels };
}

export type TrendSeries = { id: string; values: number[] };
export type TokenTrend = { dates: Date[]; series: TrendSeries[] };

/** One point per day, largest models first. Past the cap, the rest share "other". */
export function tokenTrend(slices: UsageSlice[], now: Date, days: number, limit = 5): TokenTrend {
  const today = startOfDay(now);
  const dates = Array.from({ length: days }, (_, index) => addDays(today, index - (days - 1)));
  const indexOf = new Map(dates.map((date, index) => [date.getTime(), index]));
  const rows = new Map<string, number[]>();
  for (const slice of slices) {
    if (!slice.modelId) continue;
    const index = indexOf.get(startOfDay(new Date(slice.at)).getTime());
    if (index == null) continue;
    const row = rows.get(slice.modelId) ?? Array<number>(days).fill(0);
    row[index] += tokensOf(slice);
    rows.set(slice.modelId, row);
  }
  const ranked = [...rows.entries()]
    .map(([id, values]) => ({ id, values, total: values.reduce((sum: number, value: number) => sum + value, 0) }))
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  const head = ranked.slice(0, limit).map(({ id, values }) => ({ id, values }));
  const tail = ranked.slice(limit);
  if (tail.length) {
    const values = Array<number>(days).fill(0);
    for (const entry of tail) entry.values.forEach((value, index) => { values[index] += value; });
    head.push({ id: "other", values });
  }
  return { dates, series: head };
}

/** Indexes to label on a trend axis. A week shows every day; a month shows about six. */
export function chartLabels(count: number): number[] {
  if (count <= 8) return Array.from({ length: count }, (_, index) => index);
  const step = Math.ceil((count - 1) / 5);
  const indexes: number[] = [];
  for (let index = 0; index < count; index += step) indexes.push(index);
  if (indexes[indexes.length - 1] !== count - 1) indexes.push(count - 1);
  return indexes;
}

/**
 * Monotone cubic through the points. A straight spline overshoots a day that
 * jumps from nothing to a spike and draws the line below zero; this one stays
 * between its neighbours.
 */
export function smoothPath(points: Array<{ x: number; y: number }>): string {
  const n = points.length;
  if (!n) return "";
  const move = (point: { x: number; y: number }) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  if (n === 1) return `M ${move(points[0])}`;
  const delta: number[] = [];
  for (let index = 0; index < n - 1; index += 1) {
    const dx = points[index + 1].x - points[index].x;
    delta.push(dx === 0 ? 0 : (points[index + 1].y - points[index].y) / dx);
  }
  const slope = new Array<number>(n).fill(0);
  slope[0] = delta[0];
  slope[n - 1] = delta[n - 2];
  for (let index = 1; index < n - 1; index += 1) {
    if (delta[index - 1] === 0 || delta[index] === 0 || (delta[index - 1] > 0) !== (delta[index] > 0)) slope[index] = 0;
    else slope[index] = (delta[index - 1] + delta[index]) / 2;
  }
  for (let index = 0; index < n - 1; index += 1) {
    if (delta[index] === 0) {
      slope[index] = 0;
      slope[index + 1] = 0;
      continue;
    }
    const a = slope[index] / delta[index];
    const b = slope[index + 1] / delta[index];
    const sum = a * a + b * b;
    if (sum > 9) {
      const scale = 3 / Math.sqrt(sum);
      slope[index] = scale * a * delta[index];
      slope[index + 1] = scale * b * delta[index];
    }
  }
  let path = `M ${move(points[0])}`;
  for (let index = 0; index < n - 1; index += 1) {
    const dx = points[index + 1].x - points[index].x;
    const c1 = { x: points[index].x + dx / 3, y: points[index].y + (slope[index] * dx) / 3 };
    const c2 = { x: points[index + 1].x - dx / 3, y: points[index + 1].y - (slope[index + 1] * dx) / 3 };
    path += ` C ${move(c1)}, ${move(c2)}, ${move(points[index + 1])}`;
  }
  return path;
}
