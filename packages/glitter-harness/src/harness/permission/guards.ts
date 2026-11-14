import type { ToolKind } from "../tools.js";
import { assessCommand } from "./danger.js";
import type { Subject } from "./grants.js";

/**
 * Deny-only guards. A guard returns a refusal or nothing; there is no allow
 * result, so no ordering of guards, modes or grants can turn a refusal back
 * into permission. Guards run before the ask-policy, in every permission mode.
 */

export type GuardInput = Readonly<{ toolName: string; kind: ToolKind; subject: Subject }>;
export type ToolGuard = (input: GuardInput) => string | undefined;

/** Commands no mode may run: formatting a disk, deleting the root or the home folder. */
export const dangerGuard: ToolGuard = ({ subject }) => {
  if (subject.kind !== "command") return undefined;
  const blocked = assessCommand(subject.command).find((risk) => risk.level === "block");
  return blocked ? `This command is blocked in every permission mode: ${blocked.reason} Do not retry it; tell the user what you were trying to do.` : undefined;
};

/**
 * The edit tools never write inside a `.git` folder (or a `.git` file). The
 * app's own git runs with the user's authority and reads `.git/config`, so a
 * planted filter, hook or redirect there would run outside the sandbox. The
 * tools run outside the sandbox too, so this guard is what stops them; the
 * shell's write sandbox denies the same files. APFS folds case, so `.GIT` is
 * the same folder.
 */
export const gitControlGuard: ToolGuard = ({ kind, subject }) => {
  if (kind !== "edit" || subject.kind !== "path") return undefined;
  if (!subject.path.split("/").some((part) => part.toLowerCase() === ".git")) return undefined;
  return "Files inside .git are off-limits to the edit tools in every permission mode: Git and this app read them with your authority. Use git commands in the shell instead, or ask the user to make this change.";
};

/** The first refusal wins. A guard that throws refuses, so a broken check fails closed. */
export function runGuards(guards: readonly ToolGuard[], input: GuardInput): string | undefined {
  for (const guard of guards) {
    let reason: string | undefined;
    try { reason = guard(input); }
    catch { return "A permission check failed, so this call was refused."; }
    if (reason) return reason;
  }
  return undefined;
}
