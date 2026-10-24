import { describe, expect, it } from "vitest";
import type { UsageSlice } from "./usageLedger";
import { activityMap, addDays, busiestDay, chartLabels, formatCount, formatSpan, peakTokens, quantize, smoothPath, startOfDay, streakStats, tokenTrend } from "./usageChart";

const NOW = new Date(2026, 9, 23, 15, 0, 0);

const slice = (partial: Partial<UsageSlice> & { at: number }): UsageSlice => ({
  wholeDay: false,
  agentId: "harness",
  providerId: "anthropic",
  modelId: "anthropic/claude-sonnet-5",
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  turns: 1,
  estimatedTurns: 0,
  durationMs: 0,
  tools: {},
  ...partial,
});

const at = (days: number) => addDays(NOW, days).getTime() + 3_600_000;

const pathYs = (path: string) => [...path.matchAll(/-?\d+\.\d+/g)].flatMap((match, index) => (index % 2 === 1 ? [Number(match[0])] : []));

describe("usage charts", () => {
  it("formats a stat the way the strip reads", () => {
    expect(formatSpan(0)).toBe("0 m");
    expect(formatSpan(10_000)).toBe("0 m");
    expect(formatSpan(12 * 60_000)).toBe("12 m");
    expect(formatSpan(3 * 3_600_000)).toBe("3 h");
    expect(formatSpan(3 * 86_400_000)).toBe("3 d");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(222_200)).toBe("222.2K");
  });

  it("paints one active day at full intensity on a year of cells", () => {
    const map = activityMap([slice({ at: NOW.getTime(), outputTokens: 100 })], NOW, "daily");
    expect(map.columns).toBe(53);
    expect(map.cells).toHaveLength(53 * 7);
    const active = map.cells.filter((cell) => cell.tokens > 0);
    expect(active).toEqual([expect.objectContaining({ tokens: 100, level: 4 })]);
    expect(map.labels.every((label) => label.column >= 1 && label.column <= 53)).toBe(true);
  });

  it("does not invent samples between daily values that the curve joins", () => {
    const trend = tokenTrend([slice({ at: at(-2), outputTokens: 100 }), slice({ at: at(0), outputTokens: 50 })], NOW, 3);
    expect(trend.series[0].values).toEqual([100, 0, 50]);
  });

  it("keeps a whole day's total on its calendar day, even before midnight passes its timestamp", () => {
    const early = new Date(2026, 9, 22, 8).getTime();
    const slices = [slice({ at: early, wholeDay: true, outputTokens: 300 })];
    const daily = activityMap(slices, NOW, "daily");
    const dailyActive = daily.cells.filter((cell) => cell.tokens > 0);
    expect(dailyActive).toHaveLength(1);
    expect(dailyActive[0].tokens).toBe(300);
    expect(dailyActive[0].label).toContain("Oct 22");
    const cumulative = activityMap(slices, NOW, "cumulative");
    expect(cumulative.cells.filter((cell) => cell.tokens > 0)).toHaveLength(3);
    expect(cumulative.cells.filter((cell) => cell.tokens > 0).every((cell) => cell.tokens === 300)).toBe(true);
  });

  it("shares the week's total with every day in that week, and makes cumulative a running total", () => {
    const slices = [
      slice({ at: at(-8), outputTokens: 40 }),
      slice({ at: at(0), outputTokens: 60 }),
    ];
    const weekly = activityMap(slices, NOW, "weekly");
    const weeklyActive = weekly.cells.filter((cell) => cell.tokens > 0);
    expect(weeklyActive).toHaveLength(13);
    expect(weeklyActive.filter((cell) => cell.tokens === 40)).toHaveLength(7);
    expect(weeklyActive.filter((cell) => cell.tokens === 60)).toHaveLength(6);
    const cumulative = activityMap(slices, NOW, "cumulative");
    const cumulativeActive = cumulative.cells.filter((cell) => cell.tokens > 0);
    expect(cumulativeActive).toHaveLength(10);
    expect(cumulativeActive.filter((cell) => cell.tokens === 40)).toHaveLength(8);
    expect(cumulativeActive[cumulativeActive.length - 1]?.tokens).toBe(100);
  });

  it("counts a streak through today, or from yesterday when today is empty", () => {
    expect(streakStats([slice({ at: at(0) }), slice({ at: at(-1) }), slice({ at: at(-2) })], NOW)).toEqual({ current: 3, longest: 3 });
    expect(streakStats([slice({ at: at(0) }), slice({ at: at(-2) }), slice({ at: at(-3) })], NOW)).toEqual({ current: 1, longest: 2 });
    expect(streakStats([slice({ at: at(-1) })], NOW)).toEqual({ current: 1, longest: 1 });
    expect(streakStats([slice({ at: at(-2) })], NOW)).toEqual({ current: 0, longest: 1 });
    expect(streakStats([slice({ at: at(0), outputTokens: 0 })], NOW)).toEqual({ current: 1, longest: 1 });
    expect(streakStats([], NOW)).toEqual({ current: 0, longest: 0 });
  });

  it("takes the busiest day inside the year the map draws", () => {
    expect(peakTokens([
      slice({ at: at(0), outputTokens: 10 }),
      slice({ at: at(-1), outputTokens: 50 }),
      slice({ at: at(-1), outputTokens: 20 }),
    ], NOW)).toBe(70);
    expect(peakTokens([
      slice({ at: addDays(NOW, -400).getTime(), outputTokens: 9_999 }),
      slice({ at: at(0), outputTokens: 5 }),
    ], NOW)).toBe(5);
  });

  it("names the busiest day for the map header, or nothing on an empty year", () => {
    const busiest = busiestDay([
      slice({ at: at(0), outputTokens: 10 }),
      slice({ at: at(-1), outputTokens: 50 }),
      slice({ at: at(-1), outputTokens: 20 }),
    ], NOW);
    expect(busiest).toEqual({ at: startOfDay(new Date(at(-1))), tokens: 70 });
    expect(busiestDay([slice({ at: addDays(NOW, -400).getTime(), outputTokens: 9_999 })], NOW)).toBeNull();
    expect(busiestDay([], NOW)).toBeNull();
  });

  it("ranks equal activity as the peak and steps the rest", () => {
    expect(quantize([0, 5, 0])).toEqual([0, 4, 0]);
    expect(quantize([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
  });

  it("leaves an empty ledger as an empty year and an empty trend", () => {
    const map = activityMap([], NOW, "daily");
    expect(map.cells).toHaveLength(53 * 7);
    expect(map.cells.every((cell) => cell.tokens === 0 && cell.level === 0)).toBe(true);
    expect(tokenTrend([], NOW, 7)).toEqual({ dates: expect.any(Array), series: [] });
    expect(tokenTrend([], NOW, 7).dates).toHaveLength(7);
    expect(peakTokens([], NOW)).toBe(0);
  });

  it("counts a rolled-up day on its own calendar day inside the range", () => {
    const noon = new Date(2026, 9, 1, 12).getTime();
    const trend = tokenTrend([slice({ at: noon, wholeDay: true, outputTokens: 222_200 })], NOW, 30);
    const october = trend.dates.findIndex((date) => date.getMonth() === 9 && date.getDate() === 1);
    expect(october).toBeGreaterThanOrEqual(0);
    expect(trend.series[0].values[october]).toBe(222_200);
    expect(trend.series[0].values[trend.series[0].values.length - 1]).toBe(0);
    const week = tokenTrend([slice({ at: noon, wholeDay: true, outputTokens: 222_200 })], NOW, 7);
    expect(week.series).toEqual([]);
    expect(peakTokens([slice({ at: noon, outputTokens: 222_200 })], NOW)).toBe(222_200);
  });

  it("plots one value per day and folds models past the cap", () => {
    const trend = tokenTrend([
      slice({ at: at(0), modelId: "a", outputTokens: 10 }),
      slice({ at: at(0), modelId: "b", outputTokens: 3 }),
      slice({ at: at(-1), modelId: "a", outputTokens: 1 }),
      slice({ at: at(0), modelId: "z", outputTokens: 0 }),
    ], NOW, 7);
    expect(trend.dates).toHaveLength(7);
    expect(trend.dates[0].getTime()).toBe(startOfDay(addDays(NOW, -6)).getTime());
    expect(trend.series.map((series) => series.id)).toEqual(["a", "b", "z"]);
    expect(trend.series[0].values).toEqual([0, 0, 0, 0, 0, 1, 10]);
    expect(trend.series[2].values.every((value) => value === 0)).toBe(true);

    const many = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map((id, index) => slice({ at: at(0), modelId: id, outputTokens: 100 - index }));
    const folded = tokenTrend(many, NOW, 7, 5);
    expect(folded.series.map((series) => series.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "other"]);
    expect(folded.series[5].values[6]).toBe(95 + 94);
  });

  it("labels every day of a week and about six of a month", () => {
    expect(chartLabels(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(chartLabels(30)).toEqual([0, 6, 12, 18, 24, 29]);
  });

  it("keeps a smooth line between its points", () => {
    const flat = pathYs(smoothPath([{ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 20, y: 10 }]));
    expect(flat.every((y) => y === 10)).toBe(true);
    const spike = [
      { x: 0, y: 100 },
      { x: 40, y: 100 },
      { x: 80, y: 100 },
      { x: 120, y: 100 },
      { x: 160, y: 100 },
      { x: 200, y: 0 },
    ];
    const ys = pathYs(smoothPath(spike));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100);
    expect(pathYs(smoothPath([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 100 }, { x: 30, y: 0 }, { x: 40, y: 0 },
    ])).every((y) => y >= 0 && y <= 100)).toBe(true);
    expect(smoothPath([])).toBe("");
  });

  it("steps a calendar day across the daylight-saving change", () => {
    const next = addDays(new Date(2026, 2, 8, 15), 1);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(2);
    expect(next.getDate()).toBe(9);
  });
});
