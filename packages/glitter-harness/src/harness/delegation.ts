import type { Extension, TurnContext } from "./registry.js";
import type { ToolDefinition } from "./tools.js";

/**
 * Delegation: the main agent hands one self-contained task to a child agent.
 * The child gets a narrowed tool profile, its own step budget and a parent approval
 * channel when available. Depth is stamped into the child's session, so a resumed
 * child keeps its place and can never delegate as if it were top-level.
 */

/** Parent is 0; a child of the parent is 1. A leaf at this depth gets no task tool. */
export const MAX_DELEGATION_DEPTH = 2;
/** Enough for a focused task, small enough that a child cannot run away. */
export const MAX_DELEGATED_STEPS = 24;
/** The narrowed tool set a child at depth 1 gets; it includes task, so it can delegate once more. */
export const DELEGATE_PROFILE = "delegate";
/** The leaf profile: the same narrowed set without task. */
export const DELEGATE_LEAF_PROFILE = "delegate-leaf";

export type DelegationRequest = { description: string; prompt: string; model?: string };

export type DelegationResult = {
  childSessionId: string;
  /** The child's final reply, or why it failed. Bounded by the host. */
  text: string;
  failed?: boolean;
  capped?: boolean;
};

export interface Delegator {
  canDelegate(context: TurnContext): boolean;
  delegate(context: TurnContext, request: DelegationRequest, signal?: AbortSignal): Promise<DelegationResult>;
}

const MAX_DESCRIPTION = 120;
const MAX_PROMPT = 100_000;
const MAX_RESULT = 30_000;

export function delegationExtension(delegator: Delegator): Extension {
  return {
    id: "delegation",
    tools: [(context) => (delegator.canDelegate(context) ? taskTool(delegator, context) : undefined)],
    prompt: [
      {
        placement: "stable",
        text: (context) => (context.delegationDepth ?? 0) > 0
          ? "You are a delegated child agent working on one task for the main agent. Complete it and reply with a concise result. You cannot ask the user questions or see the conversation that sent you the task. Tool approvals are requested in the parent thread when a channel is available."
          : "",
      },
      {
        placement: "volatile",
        text: (context) => (delegator.canDelegate(context)
          ? "You can hand a self-contained task to a child agent with the task tool. The child works in the same workspace under this thread's permission mode, has a smaller tool set and a step limit, and cannot ask the user; give it everything it needs."
          : ""),
      },
    ],
  };
}

function taskTool(delegator: Delegator, context: TurnContext): ToolDefinition {
  return {
    schema: {
      name: "task",
      description: "Delegate a self-contained task to a child agent and wait for its result. The child works in the same workspace with a narrowed tool set, a step limit and no ability to ask the user. It cannot see this conversation, so include every fact it needs.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "A short label for the task, up to 120 characters." },
          prompt: { type: "string", description: "The full task for the child, with any context it needs." },
          model: { type: "string", description: "Optional model id from the model list, for the child only." },
        },
        required: ["description", "prompt"],
        additionalProperties: false,
      },
    },
    kind: "delegate",
    concurrencySafe: false,
    validate: (_root, input) => {
      const description = typeof input.description === "string" ? input.description.trim() : "";
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      if (!description) return "A short description of the task is required.";
      if (description.length > MAX_DESCRIPTION) return `The description is limited to ${MAX_DESCRIPTION} characters.`;
      if (!prompt) return "The task prompt is required.";
      if (prompt.length > MAX_PROMPT) return `The task prompt is limited to ${MAX_PROMPT.toLocaleString("en-US")} characters.`;
      if (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim())) return "The model must be a model id from the list.";
      return undefined;
    },
    run: async (_root, input, signal) => {
      const description = String(input.description).trim();
      const prompt = String(input.prompt).trim();
      const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
      const result = await delegator.delegate(context, { description, prompt, ...(model ? { model } : {}) }, signal);
      const text = result.text.trim().slice(0, MAX_RESULT);
      const head = result.failed ? "The delegated task failed." : "The delegated task finished.";
      const capped = result.capped ? `It stopped after ${MAX_DELEGATED_STEPS} steps without finishing.` : "";
      return {
        value: {
          kind: "task",
          childSessionId: result.childSessionId,
          summary: description,
          text: [head, capped, text].filter(Boolean).join("\n\n"),
          ...(result.failed ? { failed: true } : {}),
        },
      };
    },
  };
}
