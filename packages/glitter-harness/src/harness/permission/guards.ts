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
