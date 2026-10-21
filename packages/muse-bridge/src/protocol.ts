export type BridgeRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
  /** Relative budget from receipt; the bridge measures it on a monotonic clock. */
  deadlineInMs?: number;
};

export type ApprovalMode = "allowAll" | "promptUnmatched" | "onRequest" | "denyUnmatched";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type { UserInputRequestParams as UserInputRequest, UserInputAnswer } from "@muse-code/sdk/dist/src/msp.js";
export type UserInputResponse =
  | { action: "answer"; answers: import("@muse-code/sdk/dist/src/msp.js").UserInputAnswer[] }
  | { action: "cancel" }
  | { action: "clarify"; text: string };
