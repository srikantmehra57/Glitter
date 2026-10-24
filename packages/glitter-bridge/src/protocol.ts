export type BridgeRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
  /** Relative budget from receipt; the bridge measures it on a monotonic clock. */
  deadlineInMs?: number;
};

/** `guarded` is Auto. The app stores it for every agent; Muse's CLI is sent the mode it accepts. */
export type ApprovalMode = "allowAll" | "promptUnmatched" | "onRequest" | "denyUnmatched" | "guarded";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type { UserInputAnswer } from "@muse-code/sdk/dist/src/msp.js";
/** What a request is for, beyond its questions: a plan review gets its own card. Muse sends none. */
export type UserInputIntent = { kind: "planReview"; plan: string };
export type UserInputRequest = import("@muse-code/sdk/dist/src/msp.js").UserInputRequestParams & { intent?: UserInputIntent };
export type UserInputResponse =
  | { action: "answer"; answers: import("@muse-code/sdk/dist/src/msp.js").UserInputAnswer[] }
  | { action: "cancel" }
  | { action: "clarify"; text: string };
