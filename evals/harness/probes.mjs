import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { conformanceReport } from "./conformance.mjs";

/**
 * Deterministic protocol probes. They drive the real HarnessHost against
 * scripted streams so each conformance id is either observed or reported
 * missing. They are not a live provider baseline: a pass means the host
 * exhibited the behavior on that script, not that a vendor did.
 */

const FAMILIES = [
  { id: "anthropic", wire: "anthropic", modelId: "anthropic/claude-sonnet-9", model: "claude-sonnet-9", credentials: { anthropic: { key: "probe-key" } } },
  { id: "groq", wire: "openai", modelId: "groq/llama-probe", model: "llama-probe", credentials: { groq: { key: "probe-key" } } },
];

const TRUNCATED = new Set(["length", "max_tokens", "max_output_tokens", "model_context_window_exceeded", "incomplete"]);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function empty() {
  return {
    listed: false, textDeltas: 0, reasoningDeltas: 0, toolCalls: 0, parallelToolCalls: 0,
    malformedCalls: 0, truncatedCalls: 0, cancellations: 0, idleStreams: 0, retries: 0,
    usageCalls: 0, contextOverflows: 0,
  };
}

function truncated(reason) {
  return TRUNCATED.has(reason) || reason.startsWith("incomplete:");
}

function createLog() {
  const streamKinds = new Map();
  const observed = empty();
  const events = [];
  return {
    observed,
    events,
    emit(event, payload) {
      events.push({ event, payload });
      if (event === "item" && typeof payload?.item?.itemId === "string" && (payload.item.kind === "agentMessage" || payload.item.kind === "reasoning")) {
        streamKinds.set(payload.item.itemId, payload.item.kind);
      }
      if (event === "delta" && payload?.field === "text") {
        const kind = streamKinds.get(payload.itemId);
        if (kind === "agentMessage") observed.textDeltas += 1;
        else if (kind === "reasoning") observed.reasoningDeltas += 1;
      }
      if (event === "modelCall" && payload?.call) {
        const call = payload.call;
        if (Number.isFinite(call.inputTokens) && Number.isFinite(call.outputTokens)) observed.usageCalls += 1;
        if (call.toolCalls > 1) observed.parallelToolCalls += 1;
        if (call.toolCalls > 0) observed.toolCalls += call.toolCalls;
        if (call.attempt > 1) observed.retries += 1;
        if (typeof call.stopReason === "string" && truncated(call.stopReason)) observed.truncatedCalls += 1;
      }
      if (event === "item" && payload?.item?.kind === "toolCall" && payload.item.status === "failed" && String(payload.item.failureReason ?? "").includes("not valid JSON")) {
        observed.malformedCalls += 1;
      }
      if (event === "turnCompleted") {
        const params = payload?.outcome?.params;
        const message = String(params?.error?.message ?? "");
        if (params?.terminal === "cancelled") observed.cancellations += 1;
        if (params?.error?.code === "CONTEXT_WINDOW_EXCEEDED" || /context window|prompt is too long|context length/i.test(message)) observed.contextOverflows += 1;
        if (/stopped sending/i.test(message)) observed.idleStreams += 1;
      }
    },
  };
}

function merge(into, from) {
  for (const key of Object.keys(into)) {
    if (typeof from[key] === "number") into[key] += from[key];
    else if (from[key] === true) into[key] = true;
  }
}

function sse(frames) {
  const body = frames.map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function hangAfter(chunk) {
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(chunk)); },
  }), { headers: { "content-type": "text/event-stream" } });
}

function untilAbort(signal) {
  return new Promise((_, reject) => {
    const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (!signal) { fail(); return; }
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

function anthropicStream() {
  return [
    { type: "message_start", message: { usage: { input_tokens: 20 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "lo" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ok" } },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ay" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  ];
}

function openaiStream() {
  return [
    { choices: [{ index: 0, delta: { reasoning_content: "lo" } }] },
    { choices: [{ index: 0, delta: { reasoning_content: "ok" } }] },
    { choices: [{ index: 0, delta: { content: "ok" } }] },
    { choices: [{ index: 0, delta: { content: "ay" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 3 } },
    "[DONE]",
  ];
}

function anthropicText() {
  return [
    { type: "message_start", message: { usage: { input_tokens: 12 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  ];
}

function openaiText() {
  return [
    { choices: [{ index: 0, delta: { content: "done" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 1 } },
    "[DONE]",
  ];
}

function anthropicTools(calls, stop = "tool_use") {
  const frames = [{ type: "message_start", message: { usage: { input_tokens: 18 } } }];
  calls.forEach((call, index) => {
    frames.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.name } });
    frames.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: call.json } });
  });
  frames.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 4 } });
  return frames;
}

function openaiTools(calls, finish = "tool_calls") {
  return [
    {
      choices: [{
        index: 0,
        delta: { tool_calls: calls.map((call, index) => ({ index, id: call.id, function: { name: call.name, arguments: call.json } })) },
        finish_reason: finish,
      }],
      usage: { prompt_tokens: 18, completion_tokens: 4 },
    },
    "[DONE]",
  ];
}

function tools(family, calls, stop) {
  return family.wire === "anthropic" ? anthropicTools(calls, stop) : openaiTools(calls, stop ?? "tool_calls");
}

function text(family) {
  return family.wire === "anthropic" ? anthropicText() : openaiText();
}

function stream(family) {
  return family.wire === "anthropic" ? anthropicStream() : openaiStream();
}

function idleChunk(family) {
  const frame = family.wire === "anthropic"
    ? { type: "message_start", message: { usage: { input_tokens: 1 } } }
    : { choices: [{ index: 0, delta: { content: "x" } }] };
  return `data: ${JSON.stringify(frame)}\n\n`;
}

function httpError(status, message) {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
}

function scripted(family, steps, onPost) {
  let posts = 0;
  return async (url, init = {}) => {
    if (String(url).includes("/models")) return Response.json({ data: [{ id: family.model }] });
    const step = steps[Math.min(posts, Math.max(0, steps.length - 1))];
    posts += 1;
    onPost?.(init);
    if (!step) throw new Error("Protocol probes received an unexpected model call.");
    return step(init);
  };
}

async function until(events, predicate, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const found = events.find(predicate);
    if (found) return found;
    await pause(15);
  }
  return undefined;
}

async function withHost({ HarnessHost, SessionStore, root, family, label, hostLimits, fetchImpl }, run) {
  const dir = join(root, `${family.id}-${label}`);
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const log = createLog();
  const host = new HarnessHost(log.emit, new SessionStore(join(dir, "sessions")), fetchImpl, { homeDir: home, ...hostLimits });
  host.setCredentials(family.credentials);
  try {
    await run({ host, log, workspace });
    return log;
  } finally {
    await host.stop();
  }
}

async function settleTurn(host, events, workspace, modelId, ms) {
  const { sessionId } = await host.startSession({ workspaceRoot: workspace, modelId, approvalMode: "allowAll" });
  await host.sendTurn({ sessionId, text: "Reply with ok." });
  await until(events, (entry) => entry.event === "turnCompleted", ms);
}

/** Run every probe on both wire families. The report has counts and statuses only. */
export async function runProtocolProbes({ HarnessHost, SessionStore, root }) {
  const families = [];
  for (const family of FAMILIES) families.push(await runFamily({ HarnessHost, SessionStore, root, family }));
  return { version: 1, kind: "protocol-probes", ok: families.every((family) => family.failures.length === 0), families };
}

function probesFor(family) {
  const read = { id: "c1", name: "read_file", json: "{\"path\":\"a.txt\"}" };
  const second = { id: "c2", name: "read_file", json: "{\"path\":\"b.txt\"}" };
  return [
    { label: "list", keys: ["listed"], list: true, steps: [] },
    { label: "stream", keys: ["textDeltas", "reasoningDeltas", "usageCalls"], steps: [() => sse(stream(family))] },
    { label: "tools", keys: ["toolCalls"], steps: [() => sse(tools(family, [read])), () => sse(text(family))] },
    { label: "parallel", keys: ["parallelToolCalls"], steps: [() => sse(tools(family, [read, second])), () => sse(text(family))] },
    { label: "malformed", keys: ["malformedCalls"], steps: [() => sse(tools(family, [{ id: "c1", name: "read_file", json: "{" }])), () => sse(text(family))] },
    { label: "truncated", keys: ["truncatedCalls"], steps: [() => sse(tools(family, [read], family.wire === "anthropic" ? "max_tokens" : "length")), () => sse(text(family))] },
    { label: "cancel", keys: ["cancellations"], cancel: true, steps: [(init) => untilAbort(init.signal)] },
    { label: "idle", keys: ["idleStreams"], host: { idleMs: 80, firstEventMs: 2_000, retryElapsedMs: 0 }, waitMs: 4_000, steps: [() => hangAfter(idleChunk(family))] },
    { label: "retry", keys: ["retries"], host: { retryElapsedMs: 10_000 }, waitMs: 8_000, steps: [() => httpError(429, "slow down"), () => sse(text(family))] },
    { label: "overflow", keys: ["contextOverflows"], host: { retryElapsedMs: 0 }, steps: [() => httpError(400, "prompt is too long for the context window")] },
  ];
}

async function runProbe(ctx, probe) {
  let entered;
  const pending = new Promise((resolve) => { entered = resolve; });
  const log = await withHost({
    ...ctx,
    label: probe.label,
    hostLimits: probe.host,
    fetchImpl: scripted(ctx.family, probe.steps, () => entered()),
  }, async ({ host, log, workspace }) => {
    if (probe.list) {
      const catalog = await host.listModels(undefined, true);
      if (catalog.models.some((model) => model.modelId === ctx.family.modelId)) log.observed.listed = true;
      return;
    }
    if (probe.cancel) {
      const { sessionId } = await host.startSession({ workspaceRoot: workspace, modelId: ctx.family.modelId, approvalMode: "allowAll" });
      await host.sendTurn({ sessionId, text: "Reply with ok." });
      const started = await Promise.race([pending.then(() => true), pause(4_000).then(() => false)]);
      if (!started) return;
      await host.cancelTurn({ sessionId });
      await until(log.events, (entry) => entry.event === "turnCompleted", 4_000);
      return;
    }
    await settleTurn(host, log.events, workspace, ctx.family.modelId, probe.waitMs ?? 4_000);
  });
  return log.observed;
}

async function runFamily(ctx) {
  const observed = empty();
  const failures = [];
  for (const probe of probesFor(ctx.family)) {
    const before = { ...observed };
    try {
      merge(observed, await runProbe(ctx, probe));
    } catch {
      // A thrown probe is not-observed. Its message can echo a stub body, so the report keeps only the id.
    }
    for (const key of probe.keys) {
      const id = keyToId(key);
      const grew = key === "listed" ? observed.listed === true && before.listed !== true : observed[key] > (before[key] ?? 0);
      if (!grew && !failures.includes(id)) failures.push(id);
    }
  }
  return { id: ctx.family.id, wire: ctx.family.wire, model: ctx.family.modelId, conformance: conformanceReport(observed), failures };
}

function keyToId(key) {
  return {
    listed: "model-listing",
    textDeltas: "text-streaming",
    reasoningDeltas: "reasoning-streaming",
    toolCalls: "tool-calls",
    parallelToolCalls: "parallel-tool-calls",
    malformedCalls: "malformed-calls",
    truncatedCalls: "truncated-calls",
    cancellations: "cancellation",
    idleStreams: "idle-streams",
    retries: "retries",
    usageCalls: "usage",
    contextOverflows: "context-overflow",
  }[key];
}
