import type { BuildReport, OrchestratorPlan, ReviewNotes } from "./handoffs.js";

/**
 * The fixed prompts the staged pipeline sends. They are provider-neutral and
 * contain no app state: the thread brief, plan and reports are appended by the
 * host. Keeping them here lets tests assert the contract without reaching into
 * the host.
 */

const PLAN_EXAMPLE = {
  kind: "orchestrator-plan",
  version: 1,
  goal: "One sentence describing the finished change.",
  acceptanceCriteria: ["A verifiable condition the build must satisfy."],
  fileTargets: [{ path: "src/example.ts", symbols: ["changedSymbol"], intent: "What changes in this file and why." }],
  steps: [{ intent: "One ordered, concrete action.", files: ["src/example.ts"] }],
  constraints: [],
  checks: ["A command that proves the change works."],
  risks: [],
  askLeadIf: [],
};

export const LEAD_PLAN_INSTRUCTIONS = [
  "You are the Lead in a two-model coding pipeline. You diagnose the request and write the plan; a separate Builder model will execute it.",
  "You cannot edit files and you are not given tools in this call. Work from the thread brief and the request; name concrete files and symbols, and say when a path is a best guess.",
  "If the request includes an image, record every visual fact the Builder needs in the plan's steps and file targets; the Builder does not receive the image.",
  "Return exactly one JSON object and no prose, Markdown fences or commentary.",
  "The object must match this shape exactly; unknown fields are rejected:",
  JSON.stringify(PLAN_EXAMPLE),
  "A plan without at least one acceptance criterion and at least one concrete file target is rejected. Keep the plan short enough to execute in one turn.",
].join("\n\n");

export const LEAD_REVIEW_INSTRUCTIONS = [
  "You are the Lead reviewing a Builder's completed work. Judge the build against the plan and return review notes only.",
  "If the request includes an image, use it from the session history when judging the build.",
  "Return exactly one JSON object and no prose or fences, in this shape:",
  JSON.stringify({ kind: "review-notes", version: 1, outcome: "pass", fixes: [] }),
  "Use outcome \"changes-required\" only when the build does not meet the plan's acceptance criteria, and list specific fixes. A passing review cannot carry fixes.",
].join("\n\n");

export function leadPlanPrompt(brief: string): string {
  return `Thread brief:\n${brief}\n\nWrite the plan for the current request.`;
}

export const LEAD_PLAN_READ_INSTRUCTIONS = [
  "You are the Lead in a two-model coding pipeline. You diagnose the request and write the plan; a separate Builder model will execute it.",
  "You may use read_file, list_files and grep to resolve gaps in the brief or a scout context pack. Do not edit files, run shell commands, ask the user or delegate.",
  "If the request includes an image, record every visual fact the Builder needs in the plan's steps and file targets; the Builder does not receive the image.",
  "Return exactly one JSON object and no prose, Markdown fences or commentary.",
  "The object must match this shape exactly; unknown fields are rejected:",
  JSON.stringify(PLAN_EXAMPLE),
  "A plan without at least one acceptance criterion and at least one concrete file target is rejected. Read only where the brief or pack is not enough.",
].join("\n\n");

export function leadPlanReadPrompt(brief: string, calls: number, chars: number): string {
  return [
    leadPlanPrompt(brief),
    `You may use at most ${calls} read call${calls === 1 ? "" : "s"} and ${chars.toLocaleString()} characters of read context. Return the plan JSON only.`,
  ].join("\n\n");
}

export function leadPlanRetryPrompt(errors: readonly string[]): string {
  return [
    "The plan was rejected for these reasons:",
    ...errors.map((error) => `- ${error}`),
    "Return the corrected JSON object only.",
  ].join("\n");
}

export function builderInstructions(plan: OrchestratorPlan): string {
  return [
    "ORCHESTRATOR BUILDER MODE",
    "You are the Builder. Execute the Lead's plan in this workspace using tools.",
    "Follow the plan's steps and acceptance criteria. Do not redesign the request. If a step is impossible or a named file does not exist, adapt minimally and state the deviation in your final reply.",
    "Do not ask the user unless the plan cannot be carried out. When you finish, summarise what changed and the checks you ran.",
    "The Lead's plan:",
    JSON.stringify(plan),
  ].join("\n\n");
}

export function repairInstructions(plan: OrchestratorPlan, notes: ReviewNotes): string {
  return [
    builderInstructions(plan),
    "The Lead reviewed the build and requires these fixes:",
    ...notes.fixes.map((fix) => `- ${fix}`),
    "Apply the fixes, re-run the relevant checks, and summarise the result.",
  ].join("\n\n");
}

export function leadReviewPrompt(input: { plan: OrchestratorPlan; report: BuildReport; answer: string }): string {
  return [
    "Plan:",
    JSON.stringify(input.plan),
    "Build report:",
    JSON.stringify(input.report),
    "Builder's final reply:",
    input.answer.trim() || "(no final reply)",
    "Review this build and return the review notes JSON.",
  ].join("\n\n");
}

export function leadExecutionNote(reason: "plan-invalid" | "question"): string {
  return reason === "question"
    ? "ORCHESTRATOR LEAD MODE: this request is a question, so answer it directly. Do not invent file edits."
    : "ORCHESTRATOR LEAD MODE: the plan could not be completed, so do the work yourself using tools. State what changed and what you checked.";
}
