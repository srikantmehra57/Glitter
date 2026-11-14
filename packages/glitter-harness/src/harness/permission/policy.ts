import type { ToolKind } from "../tools.js";
import { assessCommand } from "./danger.js";
import { covers, coversNetwork, networkScopes, scopesFor, type Grant, type GrantScope, type Subject } from "./grants.js";

/**
 * The ask-policy: whether a call that the guards let through runs now, is
 * refused, or waits for the user. It never sees a call a guard denied, so it
 * cannot turn that denial into permission.
 */

/** Permission modes the app enforces. The composer calls them Ask (`onRequest`), Auto (`guarded`) and Full access (`allowAll`). */
export type ApprovalMode = "denyUnmatched" | "promptUnmatched" | "onRequest" | "guarded" | "allowAll";

export type PolicyInput = {
  kind: ToolKind;
  toolName?: string;
  subject: Subject;
  mode: ApprovalMode;
  planMode: boolean;
  grants: readonly Grant[];
  /** The protected-path pattern an edit's path falls under (Settings → Permissions), if any. */
  protectedPath?: (path: string) => string | undefined;
};

export type Verdict =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  /** `scopes` are the thread grants to offer; a risky command gets none and says why in `risk`. */
  | { kind: "ask"; scopes: GrantScope[]; risk?: string };

export function decide(input: PolicyInput): Verdict {
  const { kind, subject, mode } = input;
  if (input.planMode && (input.toolName === "bash_output" || input.toolName === "kill_shell")) return { kind: "deny", reason: "Plan mode is on: background shell output and controls are unavailable. Switch to Build to use them." };
  // Delegation does not act by itself: the child's own calls meet this same
  // policy, one at a time, so the task call needs no approval of its own.
  if (kind === "read" || kind === "plan" || kind === "delegate") return { kind: "allow" };
  if (kind === "browser" && subject.kind === "browser" && !subject.control) return { kind: "allow" };
  if (kind === "browser" && input.planMode) return { kind: "deny", reason: "Plan mode is on: the browser is read-only. Finish the plan, or ask the user to switch to Build." };
  // A shell command can run helpers or follow symlinks, and an MCP server has
  // its own authority. Neither is reliably read-only just from its name.
  if (input.planMode && (kind === "shell" || kind === "mcp")) return { kind: "deny", reason: "Plan mode is on: commands and MCP tools cannot run. Use the workspace read tools, or ask the user to switch to Build." };
  if (kind === "edit" && input.planMode) return { kind: "deny", reason: "Plan mode is on: files are not edited. Finish the plan, or ask the user to switch to Build." };
  if (kind === "edit" && subject.kind === "path") {
    const pattern = input.protectedPath?.(subject.path);
    // Every mode asks, Full access included, and the card offers no grant:
    // approving one change to AGENTS.md must not approve the next.
    if (pattern) {
      if (mode === "denyUnmatched") return { kind: "deny", reason: "The thread is read-only: file edits are refused. Ask the user to change the permission mode if this is needed." };
      return { kind: "ask", scopes: [], risk: `${subject.path} is protected (${pattern}): it holds agent instructions, settings or secrets that outlive this turn. Each change asks first, in every mode.` };
    }
  }
  if (kind === "web" && subject.kind === "web") return decideWeb(input, subject);
  if (kind === "shell" && subject.kind === "command" && subject.network) return decideOnline(input, subject);
  if (mode === "denyUnmatched") return { kind: "deny", reason: `The thread is read-only: ${kind === "edit" ? "file edits are" : kind === "mcp" ? "MCP tool calls are" : kind === "browser" ? "browser control is" : "commands are"} refused. Ask the user to change the permission mode if this is needed.` };
  if (mode === "allowAll") return { kind: "allow" };
  if (kind === "browser") {
    if (covers(input.grants, subject)) return { kind: "allow" };
    return { kind: "ask", scopes: scopesFor(subject) };
  }
  // An external server runs with its own authority, so a call meets the user in
  // every mode short of full access — Autonomous included — unless this thread
  // already granted that tool or server.
  if (kind === "mcp") {
    if (covers(input.grants, subject)) return { kind: "allow" };
    return { kind: "ask", scopes: scopesFor(subject) };
  }
  if (mode === "onRequest" && kind === "edit") return { kind: "allow" };
  const risks = subject.kind === "command" ? assessCommand(subject.command).filter((risk) => risk.level === "ask") : [];
  if (risks.length) return { kind: "ask", scopes: [], risk: risks.map((risk) => risk.reason).join(" ") };
  // Auto, but not reckless: the ask-level risks above are the brakes, and
  // everything else runs. A risky call is still offered no grant.
  if (mode === "guarded") return { kind: "allow" };
  if (covers(input.grants, subject)) return { kind: "allow" };
  return { kind: "ask", scopes: scopesFor(subject) };
}

/**
 * A command that asked for the internet. The shell otherwise runs offline, so
 * going online is its own permission on top of the command's: Full access
 * allows it, a thread grant covers it, and every other mode asks, Auto
 * included. A risky command still asks every time and is offered no grant.
 */
function decideOnline(input: PolicyInput, subject: Extract<Subject, { kind: "command" }>): Verdict {
  if (input.mode === "denyUnmatched") return { kind: "deny", reason: "The thread is read-only: commands are refused. Ask the user to change the permission mode if this is needed." };
  if (input.mode === "allowAll") return { kind: "allow" };
  const risks = assessCommand(subject.command).filter((risk) => risk.level === "ask");
  if (risks.length) return { kind: "ask", scopes: [], risk: risks.map((risk) => risk.reason).join(" ") };
  const offline = { ...subject, network: false };
  const commandAllowed = input.mode === "guarded" || covers(input.grants, offline);
  if (commandAllowed && coversNetwork(input.grants, subject)) return { kind: "allow" };
  return { kind: "ask", scopes: networkScopes(subject, commandAllowed), risk: "Goes online. Commands otherwise run without internet access." };
}

/**
 * A web fetch reaches an origin of the model's choosing, so a URL could carry
 * workspace data out: it asks per origin in Ask and Auto. A search goes to the
 * provider the user keyed, so Auto runs it and Ask asks once per thread.
 * Reading is not editing, so Plan mode follows the same rules.
 */
function decideWeb(input: PolicyInput, subject: Extract<Subject, { kind: "web" }>): Verdict {
  if (input.mode === "denyUnmatched") return { kind: "deny", reason: "The thread is read-only: web access is refused. Ask the user to change the permission mode if this is needed." };
  if (input.mode === "allowAll") return { kind: "allow" };
  if (subject.search && input.mode === "guarded") return { kind: "allow" };
  if (covers(input.grants, subject)) return { kind: "allow" };
  return { kind: "ask", scopes: scopesFor(subject) };
}
