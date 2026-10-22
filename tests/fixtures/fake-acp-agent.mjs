// Minimal ACP agent for tests: one session, one scripted turn with a permission request.
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
let pendingPrompt = null;
let nextSession = 1;
const grokCatalog = process.argv.includes("--grok-catalog");
const authRequired = process.argv.includes("--auth-required");
const rejectModel = process.argv.includes("--reject-model");
const growCatalog = process.argv.includes("--grow-catalog");
// The first discovery lists no models (a provider still warming up); later ones list them.
const lateCatalog = process.argv.includes("--late-catalog");
let catalogPasses = 0;
// Cline: no effort option; the level comes from `--thinking` at launch, and sessions reload across processes.
const cline = process.argv.includes("--cline");
const thinkingAt = process.argv.indexOf("--thinking");
const thinking = thinkingAt > 0 ? process.argv[thinkingAt + 1] : "off";
const clineConfig = (model = "anthropic/claude-haiku-5.5", mode = "act") => [
  { id: "model", category: "model", type: "select", currentValue: model, options: [{ value: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5" }, { value: "nvidia/nemotron-3.5-super", name: "Nemotron 3.5 Super" }] },
  { id: "mode", category: "mode", type: "select", currentValue: mode, options: [{ value: "plan", name: "Plan" }, { value: "act", name: "Act" }] },
];
const clineSessions = new Map();
const grokModels = [
  { modelId: "grok-4.7", name: "Grok 4.7", _meta: { totalContextTokens: 256000, reasoningEfforts: [{ value: "high", default: true }, { value: "low" }, { value: "xhigh" }] } },
  { modelId: "grok-4.7-build-fast", name: "Grok 4.7 Fast", description: "Fast variant. 2x the price.", _meta: { totalContextTokens: 256000, reasoningEfforts: [{ value: "high", default: true }, { value: "low" }] } },
  { modelId: "grok-4.6", name: "Grok 4.6" },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (cline) {
    if (method === "initialize") return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } } } });
    if (method === "session/new") {
      const sessionId = `c-${process.pid}-${nextSession++}`;
      clineSessions.set(sessionId, { model: "anthropic/claude-haiku-5.5", mode: "act" });
      return send({ id, result: { sessionId, configOptions: clineConfig() } });
    }
    // A new process reloads with Cline's defaults; the host restores the model and mode.
    if (method === "session/load") {
      clineSessions.set(params.sessionId, { model: "anthropic/claude-haiku-5.5", mode: "act" });
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed history" } });
      return send({ id, result: { configOptions: clineConfig() } });
    }
    if (method === "session/set_config_option") {
      const state = clineSessions.get(params.sessionId);
      if (!state) return send({ id, error: { code: -32602, message: `unknown session: ${params.sessionId}` } });
      state[params.configId] = params.value;
      return send({ id, result: { configOptions: clineConfig(state.model, state.mode) } });
    }
    if (method === "session/prompt") {
      if (!clineSessions.has(params.sessionId)) return send({ id, error: { code: -32602, message: `unknown session: ${params.sessionId}` } });
      const state = clineSessions.get(params.sessionId);
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `thinking=${thinking} model=${state.model} mode=${state.mode}` } });
      return send({ id, result: { stopReason: "end_turn" } });
    }
  }
  if (method === "initialize") return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: false }, sessionCapabilities: { list: {}, close: {} } }, ...(grokCatalog ? { _meta: { modelState: { currentModelId: "grok-4.6", availableModels: [grokModels[2]] } } } : {}) } });
  if (method === "session/list") return send({ id, result: { sessions: [{ sessionId: "s-old", cwd: params.cwd, title: "Earlier work", updatedAt: "2026-09-19T00:00:00Z" }] } });
  if (method === "session/new" && authRequired) return send({ id, error: { code: -32000, message: "Authentication required. Sign in to load models." } });
  if (method === "session/new" && grokCatalog) return send({ id, result: { sessionId: `s${nextSession++}`, models: { currentModelId: "grok-4.6", availableModels: grokModels }, configOptions: [
    { id: "model", category: "model", currentValue: "grok-4.6", options: grokModels.map((model) => ({ value: model.modelId, name: model.name })) },
    { id: "reasoning_effort", category: "thought_level", currentValue: "high", options: [{ value: "high" }, { value: "low" }, { value: "xhigh" }] },
  ] } });
  if (method === "session/close") return send({ id, result: {} });
  if (method === "session/new" && lateCatalog && catalogPasses++ === 0) return send({ id, result: { sessionId: `s${nextSession++}`, configOptions: [] } });
  if (method === "session/new" && growCatalog) {
    catalogPasses += 1;
    const options = catalogPasses === 1
      ? [{ value: "zen/a", name: "Zen/Model A" }]
      : [{ value: "zen/a", name: "Zen/Model A" }, { value: "zen/c", name: "Zen/Model C" }];
    return send({ id, result: { sessionId: `s${nextSession++}`, configOptions: [
      { id: "model", category: "model", type: "select", currentValue: "zen/a", options },
      { id: "effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
    ] } });
  }
  if (method === "session/new") return send({ id, result: { sessionId: `s${nextSession++}`, configOptions: [
    { id: "model", category: "model", type: "select", currentValue: "zen/a", options: [{ value: "zen/a", name: "Zen/Model A" }, { value: "zen/b", name: "Zen/Model B" }] },
    { id: "effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low" }, { value: "high" }, { value: "max" }, { value: "default" }] },
    { id: "mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "build" }, { value: "plan", name: "plan" }] },
  ] } });
  if (method === "session/set_config_option" && rejectModel) return send({ id, error: { code: -32603, message: "model refused" } });
  if (method === "session/set_config_option") return send({ id, result: { configOptions: [{ id: "model", category: "model", currentValue: params.configId === "model" ? params.value : "zen/a", options: [{ value: "zen/a" }, { value: "zen/b" }] }, { id: "effort", category: "thought_level", currentValue: params.configId === "effort" ? params.value : "high", options: [{ value: "low" }, { value: "high" }, { value: "max" }] }, { id: "mode", category: "mode", currentValue: params.configId === "mode" ? params.value : "build", options: [{ value: "build" }, { value: "plan" }] }] } });
  if (method === "session/prompt") {
    pendingPrompt = id;
    update("s1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking " } });
    update("s1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hard." } });
    update("s1", { sessionUpdate: "plan", entries: [{ content: "Run ls", status: "in_progress", priority: "medium" }] });
    update("s1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Execute `ls`", kind: "execute", status: "pending", rawInput: { command: "ls" } });
    return send({ id: 900, method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "t1", title: "Execute `ls`", kind: "execute", rawInput: { command: "ls" } }, options: [{ optionId: "yes", name: "Allow once", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] } });
  }
  if (id === 900 && message.result) {
    const allowed = message.result.outcome?.optionId === "yes";
    update("s1", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: allowed ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: allowed ? "a.txt\n" : "denied" } }], rawOutput: { exit_code: allowed ? 0 : 1 } });
    update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done, " } });
    update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "found a.txt." } });
    update("s1", { sessionUpdate: "session_info_update", title: "List files" });
    return send({ id: pendingPrompt, result: { stopReason: "end_turn" } });
  }
  if (method === "session/cancel") {
    if (pendingPrompt != null) {
      send({ id: pendingPrompt, result: { stopReason: "cancelled" } });
      pendingPrompt = null;
    }
    return;
  }
  if (id != null && method) send({ id, error: { code: -32601, message: `unsupported ${method}` } });
});
