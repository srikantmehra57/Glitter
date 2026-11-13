import type { ChatMessage, ToolCall } from "../wire.js";
import type { PendingQuestion } from "../questions.js";
import { validatePlan, type OrchestratorPlan } from "./handoffs.js";

/**
 * Plan-mode integration for staged turns. The Lead's validated plan becomes
 * the existing plan-review card; the call that carries it is persisted like a
 * model's own `exit_plan_mode` call, so a pending or approved plan survives a
 * restart without another Lead call.
 */

export const MAX_PLAN_MARKDOWN_CHARS = 38_000;

export type StagedPlan = { plan: OrchestratorPlan; markdown: string };

function bullets(label: string, items: readonly string[]): string {
  return items.length ? `**${label}**\n${items.map((item) => `- ${item}`).join("\n")}` : "";
}

export function planMarkdown(plan: OrchestratorPlan): string {
  const sections = [
    `# ${plan.goal}`,
    bullets("Acceptance", plan.acceptanceCriteria),
    plan.fileTargets.length
      ? `**Files**\n${plan.fileTargets.map((target) => `- \`${target.path}\`${target.symbols.length ? ` (${target.symbols.join(", ")})` : ""} — ${target.intent}`).join("\n")}`
      : "",
    plan.steps.length
      ? `**Steps**\n${plan.steps.map((step, index) => `${index + 1}. ${step.intent}${step.files.length ? `\n   Files: ${step.files.map((file) => `\`${file}\``).join(", ")}` : ""}`).join("\n")}`
      : "",
    bullets("Checks", plan.checks),
    bullets("Constraints", plan.constraints),
    bullets("Risks", plan.risks),
    bullets("Ask the Lead if", plan.askLeadIf),
  ].filter(Boolean);
  const markdown = sections.join("\n\n");
  return markdown.length <= MAX_PLAN_MARKDOWN_CHARS
    ? markdown
    : `${markdown.slice(0, MAX_PLAN_MARKDOWN_CHARS - 80)}\n\n… (plan shortened for review)`;
}

/** The validated staged plan in a synthetic exit_plan_mode call, if it carries one. */
function stagedCallPlan(call: ToolCall): OrchestratorPlan | undefined {
  if (call.name !== "exit_plan_mode") return undefined;
  const valid = validatePlan(call.input.orchestratorPlan);
  return valid.ok ? valid.value : undefined;
}

function stagedCall(messages: readonly ChatMessage[], id: string): OrchestratorPlan | undefined {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (call.id === id) return stagedCallPlan(call);
    }
  }
  return undefined;
}

/** A Plan-mode review still waiting: recover the validated plan from its synthetic call. */
export function pendingPlanFromHistory(messages: readonly ChatMessage[], pending: PendingQuestion): StagedPlan | undefined {
  if (pending.intent?.kind !== "planReview") return undefined;
  const plan = stagedCall(messages, pending.callId);
  return plan ? { plan, markdown: pending.intent.plan } : undefined;
}

/** An approval that has not started its build turn yet: recover the plan it named. */
export function approvedPlanFromHistory(messages: readonly ChatMessage[]): OrchestratorPlan | undefined {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "tool") return undefined;
  for (const result of last.results) {
    if (!/^The user approved the plan\./.test(result.output)) continue;
    const plan = stagedCall(messages, result.id);
    if (plan) return plan;
  }
  return undefined;
}
