/** The prompt Continue sends for every agent except an interrupted Harness turn. */
export const GENERIC_CONTINUE_PROMPT = "Continue from the last interruption. Finish remaining work.";

/**
 * Harness continuation starts a new turn from the results already in the log.
 * It must not ask the model to repeat a call whose outcome was not recorded.
 */
export const HARNESS_CONTINUE_PROMPT = [
  "Continue from the results already recorded in this thread.",
  "Do not re-run a tool whose result says its outcome is unknown, that it did not run, or that its approval was not kept.",
  "Do not start another delegated child for a task that already names one.",
  "Finish only the work those results show is still undone.",
].join(" ");

/** What Continue puts in the composer. A new instruction is whatever the user types instead. */
export function continuationPrompt(agentId: string | undefined, outcome: string | undefined): string {
  return agentId === "harness" && outcome === "interrupted" ? HARNESS_CONTINUE_PROMPT : GENERIC_CONTINUE_PROMPT;
}
