import type { ToolSchema } from "../wire.js";
import type { OrchestratorPlan } from "./handoffs.js";

/**
 * The Builder's window into the Lead. The tool is offered only during a
 * Lead-guided build, runs in the host rather than the workspace, and each call
 * spends one of the goal's consults.
 */
export const ASK_LEAD_TOOL: ToolSchema = {
  name: "ask_lead",
  description: "Ask the Lead for help when the plan is ambiguous or you are stuck. Include the smallest relevant excerpt. The Lead knows the plan; it cannot see files or edit them. Do not use this for progress updates.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The decision or blockage you need the Lead to resolve." },
      excerpt: { type: "string", description: "The smallest file, error or diff excerpt that explains the question." },
    },
    required: ["question"],
  },
};

export const LEAD_CONSULT_INSTRUCTIONS = [
  "You are the Lead in a two-model coding pipeline. The Builder is executing your plan and asks one question.",
  "Answer in under 200 words with a concrete decision or next action. Do not restate the plan or the whole file. If the plan is wrong, say exactly what to change.",
  "You cannot read files or edit them; rely on the excerpt and the plan.",
].join("\n\n");

const MAX_EXCERPT_CHARS = 20_000;

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… (${value.length - max} chars omitted)`;
}

export function leadConsultPrompt(input: { plan: OrchestratorPlan; question: string; excerpt?: string }): string {
  return [
    "Plan:",
    JSON.stringify(input.plan),
    "The Builder asks:",
    input.question,
    "Excerpt:",
    input.excerpt ? bounded(input.excerpt, MAX_EXCERPT_CHARS) : "(none)",
    "Answer as the Lead.",
  ].join("\n\n");
}

export function stuckConsultPrompt(input: { plan: OrchestratorPlan; reason: string; evidence?: string }): string {
  return [
    "Plan:",
    JSON.stringify(input.plan),
    "The app detected that the Builder is stuck:",
    input.reason,
    "Recent evidence:",
    input.evidence ? bounded(input.evidence, MAX_EXCERPT_CHARS) : "(none)",
    "Tell the Builder what to do next. Be specific about the next action or what to stop doing.",
  ].join("\n\n");
}
