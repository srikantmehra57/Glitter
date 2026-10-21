import type { ToolKind } from "../tools.js";
import { isReadOnly } from "./classify.js";
import { assessCommand } from "./danger.js";
import { covers, scopesFor, type Grant, type GrantScope, type Subject } from "./grants.js";

/**
 * The ask-policy: whether a call that the guards let through runs now, is
 * refused, or waits for the user. It never sees a call a guard denied, so it
 * cannot turn that denial into permission.
 */

/** Permission modes the app offers, in the app's vocabulary. */
export type ApprovalMode = "denyUnmatched" | "promptUnmatched" | "onRequest" | "allowAll";

export type PolicyInput = {
  kind: ToolKind;
  subject: Subject;
  mode: ApprovalMode;
  planMode: boolean;
  grants: readonly Grant[];
};

export type Verdict =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  /** `scopes` are the thread grants to offer; a risky command gets none and says why in `risk`. */
  | { kind: "ask"; scopes: GrantScope[]; risk?: string };

export function decide(input: PolicyInput): Verdict {
  const { kind, subject, mode } = input;
  if (kind === "read" || kind === "plan") return { kind: "allow" };
  // Known read-only commands need no approval in any mode, Plan mode and read-only threads included.
  if (kind === "shell" && subject.kind === "command" && isReadOnly(subject.command)) return { kind: "allow" };
  if (kind === "edit" && input.planMode) return { kind: "deny", reason: "Plan mode is on: files are not edited. Finish the plan, or ask the user to switch to Build." };
  if (mode === "denyUnmatched") return { kind: "deny", reason: `The thread is read-only: ${kind === "edit" ? "file edits" : "commands"} are refused. Ask the user to change the permission mode if this is needed.` };
  if (mode === "allowAll") return { kind: "allow" };
  if (mode === "onRequest" && kind === "edit") return { kind: "allow" };
  const risks = subject.kind === "command" ? assessCommand(subject.command).filter((risk) => risk.level === "ask") : [];
  if (risks.length) return { kind: "ask", scopes: [], risk: risks.map((risk) => risk.reason).join(" ") };
  if (covers(input.grants, subject)) return { kind: "allow" };
  return { kind: "ask", scopes: scopesFor(subject) };
}
