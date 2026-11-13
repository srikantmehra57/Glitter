import type { TokenSpeed } from "./types";

export const TOKEN_SPEED_ESTIMATE = "Estimated from reply and reasoning text streamed to the app, using active streaming time; no provider or CLI usage data.";

const MIN_WINDOW_MS = 1000;
const MAX_ACTIVE_GAP_MS = 1000;
const IDLE_AFTER_MS = 2000;

export type TokenSpeedReading = {
  tokensPerSecond: number;
  /** True once the stream has been quiet long enough that the live value would be stale. */
  idle: boolean;
};

/**
 * Add newly streamed generated text. The renderer owns this measurement, so it
 * measures the Harness stream. Long tool or approval gaps contribute at most
 * one second instead of being mistaken for generation.
 */
export function recordTokenSpeed(current: TokenSpeed | undefined, text: string, at: number): TokenSpeed | undefined {
  if (!text) return current;
  const lastAt = Math.max(current?.lastAt ?? at, at);
  const gap = current ? Math.max(0, at - current.lastAt) : 0;
  return {
    characters: (current?.characters ?? 0) + text.length,
    activeMs: (current?.activeMs ?? 0) + Math.min(gap, MAX_ACTIVE_GAP_MS),
    lastAt,
  };
}

/** Read the average estimated rate over active streaming time, including the current quiet interval when it is short. */
export function readTokenSpeed(current: TokenSpeed | undefined, at: number): TokenSpeedReading | undefined {
  if (!current || current.characters <= 0) return undefined;
  const sinceLast = Math.max(0, at - current.lastAt);
  const activeMs = current.activeMs + Math.min(sinceLast, MAX_ACTIVE_GAP_MS);
  const sampleMs = Math.max(MIN_WINDOW_MS, activeMs);
  return {
    // Keep the app's existing coarse chars/4 estimate; "~" makes that visible.
    tokensPerSecond: (current.characters / 4) / (sampleMs / 1000),
    idle: sinceLast > IDLE_AFTER_MS,
  };
}

export function formatTokenSpeed(tokensPerSecond: number): string {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "";
  const rounded = tokensPerSecond < 10
    ? Math.max(0.1, Math.round(tokensPerSecond * 10) / 10)
    : Math.round(tokensPerSecond);
  return `~${rounded} tok/s`;
}
