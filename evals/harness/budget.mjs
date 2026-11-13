/**
 * Bound provider requests before they are sent. Input prices must be an upper
 * rate for all input tokens, including cache writes; rates are USD per million.
 * Reservations are deliberately conservative estimates, not a billing guarantee.
 */
export function createBudgetedFetch({ fetchImpl, maxCalls, maxTokens, maxUsd, outputTokens, prices, deadline }) {
  if (!prices || ![prices.input, prices.output].every((rate) => Number.isFinite(rate) && rate >= 0)) throw new Error("A non-negative input and output price is required.");
  if (![maxCalls, maxTokens, outputTokens].every((value) => Number.isSafeInteger(value) && value > 0) || !Number.isFinite(maxUsd) || maxUsd < 0) throw new Error("Invalid evaluation budget.");
  const state = { calls: 0, listings: 0, reservedTokens: 0, reservedUsd: 0, stopped: null };
  const stop = (reason) => { state.stopped = reason; throw new Error(`Evaluation ${reason} budget reached.`); };
  const send = async (url, init) => {
    const response = await fetchImpl(url, init);
    if (response.status === 429) state.stopped = "provider-rate-limit";
    else if (response.status === 402) state.stopped = "provider-billing";
    else if (response.status === 401 || response.status === 403) state.stopped = "provider-credentials";
    return response;
  };
  return {
    state,
    fetch: async (url, init = {}) => {
      if (state.stopped) throw new Error("Evaluation has stopped.");
      if (deadline !== undefined) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) stop("time");
        const timeout = AbortSignal.timeout(Math.ceil(remaining));
        init = { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout };
      }
      const method = String(init.method ?? "GET").toUpperCase();
      if (method === "GET") {
        if (state.listings >= 4) stop("listing");
        state.listings += 1;
        return send(url, init);
      }
      if (method !== "POST") throw new Error("Evaluation only permits model listing and inference requests.");
      if (state.calls >= maxCalls) stop("call");
      let body;
      try { body = JSON.parse(String(init.body)); } catch { throw new Error("The model request was not JSON."); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("The model request was not an object.");
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/messages")) {
        body.max_tokens = Math.min(Number.isFinite(body.max_tokens) ? body.max_tokens : outputTokens, outputTokens);
        if (body.thinking?.budget_tokens >= body.max_tokens) throw new Error("The requested reasoning budget exceeds the evaluation output limit.");
      } else if (path.endsWith("/responses")) body.max_output_tokens = outputTokens;
      else if (path.endsWith("/chat/completions")) body.max_tokens = outputTokens;
      else throw new Error("The provider request is not a supported inference endpoint.");
      const encoded = JSON.stringify(body);
      const input = Buffer.byteLength(encoded, "utf8") * 2 + 1024;
      const tokens = input + outputTokens;
      const usd = (input * prices.input + outputTokens * prices.output) / 1_000_000;
      if (state.reservedTokens + tokens > maxTokens) stop("token");
      if (state.reservedUsd + usd > maxUsd) stop("estimated cost");
      state.calls += 1;
      state.reservedTokens += tokens;
      state.reservedUsd += usd;
      return send(url, { ...init, body: encoded });
    },
  };
}
