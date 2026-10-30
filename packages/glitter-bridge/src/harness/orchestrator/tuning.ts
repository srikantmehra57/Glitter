import { DEFAULT_STUCK_TUNING } from "./stuck.js";
import type { OrchestratorGoal, OrchestratorTuning } from "./types.js";

/**
 * The internal tuning contract. Settings never sees these values; the host
 * resolves a partial override from the evaluator or a test and clamps it.
 * Scout entries gate 3.2; zero Lead-read budgets keep 3.3 reads off.
 */
export const DEFAULT_ORCHESTRATOR_TUNING: OrchestratorTuning = {
  consultBudgets: { cost: 1, balanced: 2, output: 4 },
  reviewAllComplex: false,
  stuck: { ...DEFAULT_STUCK_TUNING },
  scout: { enabled: false, maxReadCalls: 12, maxPackChars: 24_000, maxExcerptChars: 8_000 },
  leadReads: {
    cost: { calls: 0, chars: 0 },
    balanced: { calls: 0, chars: 0 },
    output: { calls: 0, chars: 0 },
  },
};

const GOALS: readonly OrchestratorGoal[] = ["cost", "balanced", "output"];
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function integer(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Merge a partial override, clamping every number to a safe internal range. */
export function resolveOrchestratorTuning(input: unknown): OrchestratorTuning {
  const value = isRecord(input) ? input : {};
  const budgets = isRecord(value.consultBudgets) ? value.consultBudgets : {};
  const stuck = isRecord(value.stuck) ? value.stuck : {};
  const scout = isRecord(value.scout) ? value.scout : {};
  const leadReads = isRecord(value.leadReads) ? value.leadReads : {};
  const defaults = DEFAULT_ORCHESTRATOR_TUNING;
  const consultBudgets = Object.fromEntries(GOALS.map((goal) => [goal, integer(budgets[goal], defaults.consultBudgets[goal], 0, 8)])) as OrchestratorTuning["consultBudgets"];
  const reads = Object.fromEntries(GOALS.map((goal) => {
    const entry = isRecord(leadReads[goal]) ? leadReads[goal] : {};
    return [goal, { calls: integer(entry.calls, defaults.leadReads[goal].calls, 0, 100), chars: integer(entry.chars, defaults.leadReads[goal].chars, 0, 500_000) }];
  })) as OrchestratorTuning["leadReads"];
  return {
    consultBudgets,
    reviewAllComplex: flag(value.reviewAllComplex, defaults.reviewAllComplex),
    stuck: {
      checkFailures: integer(stuck.checkFailures, defaults.stuck.checkFailures, 1, 10),
      editHistory: integer(stuck.editHistory, defaults.stuck.editHistory, 1, 10),
      repeatedCalls: integer(stuck.repeatedCalls, defaults.stuck.repeatedCalls, 2, 10),
      editFailures: integer(stuck.editFailures, defaults.stuck.editFailures, 1, 10),
      noNewTargetSteps: integer(stuck.noNewTargetSteps, defaults.stuck.noNewTargetSteps, 2, 20),
      stepLimitStepsLeft: integer(stuck.stepLimitStepsLeft, defaults.stuck.stepLimitStepsLeft, 0, 20),
    },
    scout: {
      enabled: flag(scout.enabled, defaults.scout.enabled),
      maxReadCalls: integer(scout.maxReadCalls, defaults.scout.maxReadCalls, 0, 50),
      maxPackChars: integer(scout.maxPackChars, defaults.scout.maxPackChars, 1_000, 250_000),
      maxExcerptChars: integer(scout.maxExcerptChars, defaults.scout.maxExcerptChars, 500, 50_000),
    },
    leadReads: reads,
  };
}
