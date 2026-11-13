/** Behavior the baseline should measure. A missing observation is never a pass. */
const CONTRACT = [
  ["model-listing", "listed"],
  ["text-streaming", "textDeltas"],
  ["reasoning-streaming", "reasoningDeltas"],
  ["tool-calls", "toolCalls"],
  ["parallel-tool-calls", "parallelToolCalls"],
  ["malformed-calls", "malformedCalls"],
  ["truncated-calls", "truncatedCalls"],
  ["cancellation", "cancellations"],
  ["idle-streams", "idleStreams"],
  ["retries", "retries"],
  ["usage", "usageCalls"],
  ["context-overflow", "contextOverflows"],
];

export const CONFORMANCE_IDS = Object.freeze(CONTRACT.map(([id]) => id));

/** Only observed behavior is counted. A live run cannot infer unsupported features from silence. */
export function conformanceReport(observed = {}, unsupported = []) {
  return CONTRACT.map(([id, key]) => {
    if (observed[key] === true || (typeof observed[key] === "number" && observed[key] > 0)) return { id, status: "pass" };
    if (unsupported.includes(id)) return { id, status: "unsupported", source: "operator" };
    return { id, status: "not-observed" };
  });
}
