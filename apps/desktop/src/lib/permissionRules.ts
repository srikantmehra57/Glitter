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

/**
 * Files the built-in agent's edits ask about in every permission mode and its
 * shell cannot write. Mirrors `DEFAULT_PROTECTED_PATHS` in the harness; a test
 * keeps the two lists equal. Settings store `protectedPaths` only once the user
 * changes the list, so a new default reaches everyone who has not.
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  "AGENTS.md", "CLAUDE.md", ".glitter/**", ".agents/**",
  ".env", ".env.*", ".envrc",
  "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
];

/** Mirrors `PROTECTED_PATHS_LIMIT` and `PROTECTED_PATH_LIMIT` in the native DTO. */
export const PROTECTED_PATH_LIMIT = 100;
export const PROTECTED_PATH_LENGTH = 200;

/** Why a protected-path pattern would be refused, or null. Mirrors the harness's check. */
export function protectedPathProblem(pattern: string): string | null {
  const text = pattern.trim();
  if (!text) return "Write a path or pattern, such as .env or secrets/**.";
  if (new TextEncoder().encode(text).length > PROTECTED_PATH_LENGTH) return `A pattern is at most ${PROTECTED_PATH_LENGTH} bytes.`;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return "A pattern cannot contain control characters.";
  if (text.startsWith("/") || text.startsWith("~")) return "A pattern names a path inside the workspace.";
  if (text.split("/").some((part) => part === ".." || part === "." || part === "")) return "A pattern cannot contain empty, . or .. parts.";
  if (/[[\]{}\\"]/.test(text)) return "A pattern may use * and ? only.";
  if (text === "**" || text === "*") return "That would protect every file; use a narrower pattern.";
  return null;
}

/** Saved patterns, valid and unique, in order; undefined (the defaults) when nothing was saved. */
export function normalizeProtectedPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const text = entry.trim();
    if (protectedPathProblem(text) || out.includes(text)) continue;
    out.push(text);
    if (out.length >= PROTECTED_PATH_LIMIT) break;
  }
  return out;
}

/** The list in effect: what the user saved, or the defaults. */
export function effectiveProtectedPaths(value: unknown): string[] {
  return normalizeProtectedPaths(value) ?? [...DEFAULT_PROTECTED_PATHS];
}
