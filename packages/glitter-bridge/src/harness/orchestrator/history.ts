import type { ChatMessage } from "../wire.js";

/**
 * A reply's thinking blocks carry the signature of the model that produced
 * them. Only that model can send them back: another Anthropic model rejects the
 * signature, and every other provider ignores them. Strip them at the model
 * boundary, never from the stored session, so switching roles cannot poison a
 * later turn. Replies recorded before model tagging belong to the session's
 * own model, which is what `fallbackModelId` names.
 */
export function sanitizeHistory(messages: readonly ChatMessage[], targetModelId: string, fallbackModelId?: string): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const toolCalls = message.toolCalls?.map((call) => {
      if (call.input.orchestratorPlan === undefined) return call;
      // A staged plan is carried in the call for restart recovery; the model
      // gets it in its stage prompt and the plan card, not again in history.
      const input = { ...call.input };
      delete input.orchestratorPlan;
      delete input.plan;
      return { ...call, input };
    });
    const changedCalls = Boolean(toolCalls && toolCalls.some((call, index) => call !== message.toolCalls![index]));
    const producer = message.modelId ?? fallbackModelId;
    const keepThinking = Boolean(message.thinking?.length && producer === targetModelId);
    const stripThinking = Boolean(message.thinking?.length && !keepThinking);
    if (!changedCalls && !stripThinking) return message;
    const { role, text, modelId } = message;
    return {
      role,
      text,
      ...(keepThinking ? { thinking: message.thinking } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      ...(modelId ? { modelId } : {}),
    };
  });
}
