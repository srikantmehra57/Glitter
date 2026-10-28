import type { OrchestratorCapability, RouterAssessment } from "./types.js";

export const MAX_ROUTER_ASSESSMENT_CHARS = 16_000;
export type AssessmentValidation = { ok: true; value: RouterAssessment } | { ok: false; errors: string[] };

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const TASK_KINDS = ["question", "minor_edit", "bug_fix", "feature", "redesign", "refactor", "migration", "security", "other"] as const;
const DIFFICULTIES = ["trivial", "mid", "complex"] as const;
const RISKS = ["low", "medium", "high"] as const;
const CONFIDENCE = ["low", "high"] as const;
const CONTINUITY = ["new", "continuation"] as const;
const CAPABILITIES = ["tools", "vision", "long_context"] as const;
const FIELDS = ["taskKind", "difficulty", "designChoices", "separable", "causeKnown", "risk", "confidence", "continuity", "requiredCapabilities", "reasonCodes"] as const;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, errors: string[]): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  errors.push(`${field} must be one of: ${allowed.join(", ")}.`);
  return allowed[0];
}

function boolean(value: unknown, field: string, errors: string[]): boolean {
  if (typeof value === "boolean") return value;
  errors.push(`${field} must be a boolean.`);
  return false;
}

/** Parse the router's closed JSON envelope. Unknown fields are not forwarded. */
export function validateRouterAssessment(input: unknown): AssessmentValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["Router assessment must be an object."] };
  for (const key of Object.keys(input)) if (!(FIELDS as readonly string[]).includes(key)) errors.push(`Unknown router field: ${key}.`);

  const rawCapabilities = input.requiredCapabilities;
  if (!Array.isArray(rawCapabilities)) errors.push("requiredCapabilities must be an array.");
  const requiredCapabilities: OrchestratorCapability[] = [];
  for (const [index, capability] of (Array.isArray(rawCapabilities) ? rawCapabilities : []).entries()) {
    const parsed = oneOf(capability, CAPABILITIES, `requiredCapabilities[${index}]`, errors);
    if (!requiredCapabilities.includes(parsed)) requiredCapabilities.push(parsed);
  }

  const rawReasons = input.reasonCodes;
  if (!Array.isArray(rawReasons)) errors.push("reasonCodes must be an array.");
  const reasonCodes = (Array.isArray(rawReasons) ? rawReasons : []).map((reason, index) => {
    if (typeof reason !== "string" || !reason.trim()) {
      errors.push(`reasonCodes[${index}] must be a non-empty string.`);
      return "";
    }
    if (reason.length > 120) errors.push(`reasonCodes[${index}] exceeds 120 characters.`);
    return reason.trim();
  }).filter(Boolean).slice(0, 32);
  if (Array.isArray(rawReasons) && rawReasons.length > 32) errors.push("reasonCodes exceeds 32 entries.");

  const value: RouterAssessment = {
    taskKind: oneOf(input.taskKind, TASK_KINDS, "taskKind", errors),
    difficulty: oneOf(input.difficulty, DIFFICULTIES, "difficulty", errors),
    designChoices: boolean(input.designChoices, "designChoices", errors),
    separable: boolean(input.separable, "separable", errors),
    causeKnown: boolean(input.causeKnown, "causeKnown", errors),
    risk: oneOf(input.risk, RISKS, "risk", errors),
    confidence: oneOf(input.confidence, CONFIDENCE, "confidence", errors),
    continuity: oneOf(input.continuity, CONTINUITY, "continuity", errors),
    requiredCapabilities,
    reasonCodes,
  };
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function parseRouterAssessment(raw: string): AssessmentValidation {
  if (raw.length > MAX_ROUTER_ASSESSMENT_CHARS) return { ok: false, errors: [`Router assessment exceeds ${MAX_ROUTER_ASSESSMENT_CHARS} characters.`] };
  try { return validateRouterAssessment(JSON.parse(raw) as unknown); }
  catch { return { ok: false, errors: ["Router assessment must be one JSON object without fences or surrounding prose."] }; }
}
