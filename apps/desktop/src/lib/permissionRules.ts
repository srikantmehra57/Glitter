import type { PermissionRule, PermissionRuleEffect } from "./types";

/** Mirrors `RULES_LIMIT` and `RULE_LIMIT` in the native DTO, so a save is never refused wholesale. */
export const HARNESS_RULE_LIMIT = 200;
export const HARNESS_RULE_LENGTH = 300;

const EFFECTS: readonly PermissionRuleEffect[] = ["allow", "deny"];

/** Why the native side would refuse this rule text. Syntax is the harness's answer, not this one's. */
export function harnessRuleProblem(rule: string): string | null {
  const text = rule.trim();
  if (!text) return "Write a rule, such as Bash(npm test).";
  if (new TextEncoder().encode(text).length > HARNESS_RULE_LENGTH) return `A rule is at most ${HARNESS_RULE_LENGTH} bytes.`;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return "A rule cannot contain control characters.";
  return null;
}

/**
 * Read saved rules. Order is kept, duplicates collapse, and anything the native
 * side would refuse is dropped rather than failing the whole settings write.
 * A rule the harness cannot parse survives: it is reported as a problem and
 * ignored there, so the user can see and fix it.
 */
export function normalizeHarnessRules(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return [];
  const out: PermissionRule[] = [];
  for (const entry of value) {
    const effect = EFFECTS.find((candidate) => candidate === entry?.effect);
    const rule = typeof entry?.rule === "string" ? entry.rule.trim() : "";
    if (!effect || harnessRuleProblem(rule)) continue;
    if (out.some((kept) => kept.effect === effect && kept.rule === rule)) continue;
    out.push({ effect, rule });
    if (out.length >= HARNESS_RULE_LIMIT) break;
  }
  return out;
}
