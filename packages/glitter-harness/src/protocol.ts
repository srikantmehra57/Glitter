export type BridgeRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
  /** Relative budget from receipt; the agent process measures it on a monotonic clock. */
  deadlineInMs?: number;
};

/** `guarded` is Auto. */
export type ApprovalMode = "allowAll" | "promptUnmatched" | "onRequest" | "denyUnmatched" | "guarded";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** One answer to one question: exactly one of `selectedLabel`, `selectedLabels` or `freeText`, plus an optional note. */
export type UserInputAnswer = {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
  note?: string;
};

export type UserInputOption = {
  label: string;
  description?: string;
  preview?: { content: string; format: string };
};

export type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  options: UserInputOption[];
  selection: { mode: "single" | "multiple"; minSelections?: number; maxSelections?: number };
};

/** What a request is for, beyond its questions: a plan review gets its own card. */
export type UserInputIntent = { kind: "planReview"; plan: string };

/** A question the agent parked for the user, as the app renders it. */
export type UserInputRequest = {
  userInputId: string;
  sessionId: string;
  turnId: string;
  itemId: string;
  toolCallId: string;
  toolName: string;
  questions: UserInputQuestion[];
  viewCursor: string;
  autoResolutionMs?: number;
  intent?: UserInputIntent;
};

export type UserInputResponse =
  | { action: "answer"; answers: UserInputAnswer[] }
  | { action: "cancel" }
  | { action: "clarify"; text: string };
