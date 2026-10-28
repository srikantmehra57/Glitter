import type { UserInputAnswer, UserInputIntent, UserInputRequest, UserInputResponse } from "../protocol.js";
import type { ToolDefinition } from "./tools.js";

/**
 * `ask_user`: the model asks the user one to four questions and the turn ends.
 * The request is durable: it is written to the session log, survives a
 * restart, and comes back to the app when the thread reopens. The answer is
 * the call's result, and a new turn continues from it. Nothing waits in the
 * meantime, so an unanswered question cannot hold a turn open; a new message
 * from the user settles it instead.
 *
 * `exit_plan_mode` is the same mechanism with a plan-review intent: Plan mode
 * ends only when the user approves the plan.
 */

export type Question = {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string; preview?: { format: string; content: string } }>;
  multiSelect: boolean;
};

/** What the call asks, and for what. */
export type Asked = { questions: Question[]; intent?: UserInputIntent };

/** A question waiting for the user, with the rest of its call batch, so the tool message can be completed later. */
export type PendingQuestion = {
  userInputId: string;
  turnId: string;
  callId: string;
  toolName: string;
  itemId: string;
  /** The transcript item's identity fields, to complete it when the answer arrives. */
  item: Record<string, unknown>;
  questions: Question[];
  intent?: UserInputIntent;
  /** Every result of the batch in model order; the question's own slot is filled on settlement. */
  results: Array<{ id: string; name: string; output: string; isError?: boolean }>;
};

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;
const QUESTION_CHARS = 1000;
const HEADER_CHARS = 40;
const LABEL_CHARS = 120;
const DESCRIPTION_CHARS = 400;
const ANSWER_CHARS = 500;
const PLAN_CHARS = 40_000;
const FEEDBACK_CHARS = 4_000;
/** The approving option is named, not positional, so no client can infer the verdict from button order. */
export const APPROVE = "Approve";
export const KEEP_PLANNING = "Keep planning";

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The questions in a call's arguments, or why they cannot be asked. */
export function parseQuestions(input: Readonly<Record<string, unknown>>): { questions: Question[] } | { error: string } {
  const raw = input.questions;
  if (!Array.isArray(raw) || !raw.length) return { error: "questions must list at least one question." };
  if (raw.length > MAX_QUESTIONS) return { error: `Ask at most ${MAX_QUESTIONS} questions at once.` };
  const questions: Question[] = [];
  for (const [index, entry] of raw.entries()) {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const question = text(item.question);
    if (!question) return { error: `Question ${index + 1} has no question text.` };
    if (question.length > QUESTION_CHARS) return { error: `Question ${index + 1} is longer than ${QUESTION_CHARS} characters.` };
    const header = text(item.header).slice(0, HEADER_CHARS);
    const rawOptions = Array.isArray(item.options) ? item.options : [];
    if (rawOptions.length === 1 || rawOptions.length > MAX_OPTIONS) return { error: `Question ${index + 1} needs no options (a free answer) or 2 to ${MAX_OPTIONS} options.` };
    const options: Question["options"] = [];
    const seen = new Set<string>();
    for (const option of rawOptions) {
      const record = option && typeof option === "object" ? option as Record<string, unknown> : {};
      const label = text(record.label);
      if (!label || label.length > LABEL_CHARS) return { error: `Every option of question ${index + 1} needs a label of 1 to ${LABEL_CHARS} characters.` };
      if (seen.has(label.toLowerCase())) return { error: `Question ${index + 1} has two options labelled ${label}.` };
      seen.add(label.toLowerCase());
      const description = text(record.description).slice(0, DESCRIPTION_CHARS);
      options.push(description ? { label, description } : { label });
    }
    questions.push({ question, header, options, multiSelect: item.multiSelect === true && options.length > 0 });
  }
  return { questions };
}

export const ASK_USER_TOOL: ToolDefinition = {
  schema: {
    name: "ask_user",
    description: "Ask the user one to four questions when you cannot go on without their decision, and offer the likely answers as options. The turn ends with the questions; it continues when the user answers, with their answers as this call's result. The user can always write their own answer instead. Do not ask what you can find out with the other tools.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_QUESTIONS,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The full question, ending with a question mark." },
              header: { type: "string", description: "A label of a few words, such as Database or Scope." },
              options: { type: "array", maxItems: MAX_OPTIONS, items: { type: "object", properties: { label: { type: "string" }, description: { type: "string", description: "What choosing it means." } }, required: ["label"] }, description: "Two to six answers to choose from. Leave it empty for a free answer." },
              multiSelect: { type: "boolean", description: "True when more than one option may be chosen." },
            },
            required: ["question"],
          },
        },
      },
      required: ["questions"],
    },
  },
  // Asking needs no approval: it changes nothing.
  kind: "read",
  validate: (_root, input) => {
    const parsed = parseQuestions(input);
    return "error" in parsed ? parsed.error : undefined;
  },
  run: (_root, input) => {
    const parsed = parseQuestions(input);
    if ("error" in parsed) return { value: { kind: "error", message: parsed.error } };
    return { value: { kind: "question", questions: parsed.questions } };
  },
};

/** The one question a plan review asks. A client without the plan-review card still renders it. */
function planReview(plan: string): Question {
  return {
    question: "Approve this plan?",
    header: "Plan",
    options: [
      { label: APPROVE, description: "Turn Plan mode off and carry it out.", preview: { format: "markdown", content: plan } },
      { label: KEEP_PLANNING, description: "Stay in Plan mode." },
    ],
    multiSelect: false,
  };
}

/** The same card a model's exit_plan_mode call asks, for a plan the host wrote. */
export function planReviewQuestion(plan: string): Question {
  return planReview(plan);
}

/** Offered in Plan mode only: present the finished plan, and Build mode starts when the user approves it. */
export const EXIT_PLAN_TOOL: ToolDefinition = {
  schema: {
    name: "exit_plan_mode",
    description: "Present your finished plan for the user to approve, in Markdown. The turn ends here. If the user approves, Plan mode turns off and you continue in Build mode to carry the plan out. If they send feedback, revise the plan and present it again.",
    parameters: { type: "object", properties: { plan: { type: "string", description: "The plan in Markdown: the steps, the files each step changes, and how you will check the result." } }, required: ["plan"] },
  },
  kind: "read",
  validate: (_root, input) => {
    const plan = text(input.plan);
    if (!plan) return "plan is empty. Write the plan before presenting it.";
    return plan.length > PLAN_CHARS ? `The plan is longer than ${PLAN_CHARS} characters. Shorten it.` : undefined;
  },
  run: (_root, input) => {
    const plan = text(input.plan);
    return { value: { kind: "question", questions: [planReview(plan)], intent: { kind: "planReview", plan } } };
  },
};

/** The request the app's question card renders. Question ids are positional and stable. */
export function questionRequest(sessionId: string, pending: PendingQuestion): UserInputRequest {
  return {
    sessionId,
    turnId: pending.turnId,
    userInputId: pending.userInputId,
    itemId: pending.itemId,
    toolCallId: pending.callId,
    toolName: pending.toolName,
    viewCursor: "",
    ...(pending.intent ? { intent: pending.intent } : {}),
    questions: pending.questions.map((question, index) => ({
      id: `q${index + 1}`,
      header: question.header,
      question: question.question,
      options: question.options,
      selection: question.multiSelect ? { mode: "multiple", minSelections: 1, maxSelections: question.options.length } : { mode: "single" },
    })),
  };
}

class AnswerError extends Error {}

function answerLine(question: Question, answer: UserInputAnswer | undefined): string {
  if (!answer) throw new AnswerError(`Answer every question: ${question.question}`);
  const labels = new Set(question.options.map((option) => option.label));
  let chosen: string;
  if (typeof answer.freeText === "string") {
    const free = answer.freeText.trim();
    if (!free || free.length > ANSWER_CHARS) throw new AnswerError(`An answer must have 1 to ${ANSWER_CHARS} characters.`);
    chosen = `In their own words: ${free}`;
  } else if (question.multiSelect) {
    const picked = answer.selectedLabels ?? [];
    if (!picked.length || picked.some((label) => !labels.has(label))) throw new AnswerError(`Choose options listed for: ${question.question}`);
    chosen = picked.join(", ");
  } else {
    if (!answer.selectedLabel || !labels.has(answer.selectedLabel)) throw new AnswerError(`Choose an option listed for: ${question.question}`);
    chosen = answer.selectedLabel;
  }
  const note = typeof answer.note === "string" && answer.note.trim() ? ` (note: ${answer.note.trim().slice(0, ANSWER_CHARS)})` : "";
  return `- ${question.question}\n  ${chosen}${note}`;
}

export type Settlement = {
  output: string;
  summary: string;
  outcome: "answered" | "clarified" | "cancelled" | "superseded" | "approved" | "keptPlanning";
  /** Whether a new turn should run now. A plan kept without feedback waits for the user's next message. */
  continueTurn: boolean;
  /** Plan-review feedback: it reaches the model as a message from the user, not as a tool result. */
  feedback?: string;
  /** The plan was approved: Plan mode turns off before the next turn. */
  leavePlanMode?: boolean;
};

function planSettlement(response: UserInputResponse | { action: "superseded" }): Settlement {
  if (response.action === "superseded") return { output: "The user did not review the plan and sent a new message instead. If it is feedback on the plan, revise the plan.", summary: "Not reviewed", outcome: "superseded", continueTurn: false };
  const answer = response.action === "answer" ? response.answers.find((entry) => entry.questionId === "q1") : undefined;
  const written = response.action === "clarify" ? response.text : typeof answer?.freeText === "string" ? answer.freeText : undefined;
  if (written !== undefined) {
    const feedback = written.trim();
    if (!feedback || feedback.length > FEEDBACK_CHARS) throw new AnswerError(`Feedback must have 1 to ${FEEDBACK_CHARS} characters.`);
    return { output: "The user did not approve the plan. Their feedback follows as their next message: revise the plan and present it again.", summary: "Sent feedback", outcome: "clarified", continueTurn: true, feedback };
  }
  if (answer?.selectedLabel === APPROVE) return { output: "The user approved the plan. Plan mode is now off: carry the plan out.", summary: "Approved", outcome: "approved", continueTurn: true, leavePlanMode: true };
  if (response.action === "answer" && answer?.selectedLabel !== KEEP_PLANNING) throw new AnswerError(`Choose ${APPROVE} or ${KEEP_PLANNING}.`);
  return { output: "The user did not approve the plan and is staying in Plan mode. Wait for their next message.", summary: "Kept planning", outcome: "keptPlanning", continueTurn: false };
}

/**
 * The call's result for each way the user can settle it: the model's text and
 * a short line for the transcript. Throws when the answers do not fit the questions.
 */
export function settlement(pending: PendingQuestion, response: UserInputResponse | { action: "superseded" }): Settlement {
  if (pending.intent?.kind === "planReview") return planSettlement(response);
  if (response.action === "answer") {
    const lines = pending.questions.map((question, index) => answerLine(question, response.answers.find((answer) => answer.questionId === `q${index + 1}`)));
    return { output: `The user answered:\n${lines.join("\n")}`, summary: lines.map((line) => line.split("\n  ")[1]).join(" · "), outcome: "answered", continueTurn: true };
  }
  if (response.action === "clarify") {
    const reply = response.text.trim();
    if (!reply || reply.length > ANSWER_CHARS) throw new AnswerError(`An explanation must have 1 to ${ANSWER_CHARS} characters.`);
    return { output: `The user did not choose an answer. They wrote instead:\n${reply}`, summary: `Explained: ${reply}`, outcome: "clarified", continueTurn: true };
  }
  if (response.action === "cancel") {
    return { output: "The user declined to answer. Go on with your best judgment and say what you assumed, or stop if you cannot.", summary: "Declined to answer", outcome: "cancelled", continueTurn: true };
  }
  return { output: "The user did not answer and sent a new message instead. If that message answers the question, use it.", summary: "Not answered", outcome: "superseded", continueTurn: false };
}
