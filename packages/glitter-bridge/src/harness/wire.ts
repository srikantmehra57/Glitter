import { THINKING_BUDGET, effortTiers, isCustomProvider, splitModelId, type ResolvedProvider, type Tier } from "./providers.js";

/**
 * One streaming chat call against a provider, in the harness's own message
 * shape. The two wire formats differ in every detail (roles, tool calls,
 * reasoning, usage); this file is the only place that knows either of them.
 */

export type ImagePart = { type: "image"; mediaType: string; data: string };
export type ContentPart = { type: "text"; text: string } | ImagePart;
/** `started` is harness bookkeeping: set once execution begins, never sent to a provider. */
export type ToolCall = { id: string; name: string; input: Record<string, unknown>; started?: boolean };
/** Anthropic thinking blocks must be sent back verbatim (with their signature) inside a tool loop. */
export type ThinkingBlock = { text: string; signature?: string; redacted?: string };
/** `modelId` is harness bookkeeping for cross-model routing; never sent to a provider. */
export type AssistantMessage = { role: "assistant"; text: string; thinking?: ThinkingBlock[]; toolCalls?: ToolCall[]; modelId?: string };
export type ToolResultMessage = { role: "tool"; results: Array<{ id: string; name: string; output: string; isError?: boolean; images?: ImagePart[] }> };
export type ChatMessage = { role: "user"; content: ContentPart[] } | AssistantMessage | ToolResultMessage;
export type ToolSchema = { name: string; description: string; parameters: Record<string, unknown> };

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  /** `inputTokens` is the uncached prompt. Cache counters are disjoint from it. */
  | { type: "usage"; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: "done"; message: AssistantMessage; stopReason: string };

/** Stable prefix (cached) plus the part that may change between calls. */
export type SystemPrompt = { stable: string; volatile: string };

export type StreamTimeouts = { idleMs?: number; firstEventMs?: number };

/**
 * Stable failure codes. Retry and the UI branch on these, not on the wording
 * of a provider's error body. `MISSING_CREDENTIAL` means no key was configured;
 * `INVALID_CREDENTIAL` means a key was sent and rejected.
 */
export type ProviderFailureCode =
  | "RATE_LIMIT"
  | "CONTEXT_WINDOW_EXCEEDED"
  | "MISSING_CREDENTIAL"
  | "INVALID_CREDENTIAL"
  | "EMPTY_RESPONSE"
  | "TIMEOUT"
  | "TRANSPORT"
  | "SERVER"
  | "STREAM_CLOSED"
  | "MALFORMED_RESPONSE";

/** A provider's 400 prose that means the input does not fit, even when the code says nothing. Exported so the host can retry an overflow reactively. */
export const CONTEXT_WINDOW = /context window|context length|maximum context|too many tokens|prompt is too long|exceeds the context|max(?:imum)? context|input is too long/i;

/** Map an HTTP status and a provider message onto one code. Status wins over prose except for a context-window overflow, which is never a retry. */
export function classifyProviderFailure(status: number | undefined, message: string): ProviderFailureCode {
  if (status === 429) return "RATE_LIMIT";
  if (status === 401 || status === 403) return "INVALID_CREDENTIAL";
  if (CONTEXT_WINDOW.test(message)) return "CONTEXT_WINDOW_EXCEEDED";
  if (status === 408) return "TIMEOUT";
  if (status === 409 || (status != null && status >= 500)) return "SERVER";
  if (/sent nothing|stopped sending/i.test(message)) return "EMPTY_RESPONSE";
  if (/could not reach|network|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(message)) return "TRANSPORT";
  if (/ended the reply early|stream error/i.test(message)) return "STREAM_CLOSED";
  if (status == null) return "TRANSPORT";
  return "MALFORMED_RESPONSE";
}

export class ProviderError extends Error {
  readonly code: ProviderFailureCode;
  constructor(message: string, readonly status?: number, code?: ProviderFailureCode) {
    super(message);
    this.name = "ProviderError";
    this.code = code ?? classifyProviderFailure(status, message);
  }
}

/** Codes the host may retry, still inside the elapsed budget from Phase 1. An empty body that carried an HTTP status is not a hung stream. */
export function isTransientProviderError(error: ProviderError): boolean {
  if (error.code === "EMPTY_RESPONSE") return error.status == null;
  return error.code === "RATE_LIMIT" || error.code === "TIMEOUT" || error.code === "SERVER" || error.code === "TRANSPORT" || error.code === "STREAM_CLOSED";
}

export type ChatRequest = {
  provider: ResolvedProvider;
  modelId: string;
  system: SystemPrompt;
  messages: ChatMessage[];
  tools: readonly ToolSchema[];
  effort?: string;
  /** Catalog-reported reasoning support for custom OpenAI-compatible providers. */
  listedReasoning?: boolean;
  /** The catalog's own effort list for this model, when it names one (OpenRouter does). */
  listedEfforts?: readonly string[];
  signal?: AbortSignal;
  /** Tests shorten the watchdogs. Production uses the defaults. */
  timeouts?: StreamTimeouts;
  /** Tests point this at a stub; the bridge uses the global fetch. */
  fetchImpl?: typeof fetch;
};

/** No byte from the provider for this long, after the first frame, ends the call. */
const IDLE_MS = 180_000;
/** No complete frame for this long after the provider accepts ends the call. A separate clock from the idle one: accepting and then hanging is not the same as going quiet mid-stream. */
const FIRST_EVENT_MS = 60_000;

/** A reply cut off by the output limit. Streamed tool arguments can be valid JSON and still incomplete. */
export function isTruncatedStop(stopReason: string): boolean {
  return stopReason === "length" || stopReason === "max_tokens" || stopReason === "max_output_tokens";
}

export function truncatedToolResult(name: string): string {
  return `Tool call "${name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`;
}

/** Interrupted before the harness recorded the call as started. Safe to retry. */
export const TOOL_NOT_STARTED = "The tool call was interrupted before it started. Retry it if it is still needed.";
/** Started, and no result was saved. The model must not assume it can just run it again. */
export const TOOL_OUTCOME_UNKNOWN = "The tool call started, but no result was recorded. Its outcome is unknown. Retry only if it is read-only or idempotent. If it may have changed files or run a command, check the workspace or ask the user before retrying. Do not retry blindly.";
const MAX_TOKENS = 32_000;
/** Older Claude families cap output lower than the current ones. */
const SMALL_MAX_TOKENS = 8_192;

export async function* streamChat(request: ChatRequest): AsyncGenerator<StreamEvent> {
  const repaired = repairHistory(request.messages);
  if (request.provider.wire === "anthropic") yield* streamAnthropic({ ...request, messages: repaired });
  else yield* streamOpenAi({ ...request, messages: repaired });
}

/**
 * A stopped turn can leave an assistant tool call with no result, and both
 * APIs reject a history like that. Missing results are filled in as
 * cancelled, and back-to-back user messages are merged.
 */
export function repairHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const previous = out[out.length - 1];
    if (message.role === "user" && previous?.role === "user") {
      out[out.length - 1] = { role: "user", content: [...previous.content, ...message.content] };
      continue;
    }
    out.push(message);
    if (message.role === "assistant" && message.toolCalls?.length) {
      const next = messages[index + 1];
      const answered = new Set(next?.role === "tool" ? next.results.map((result) => result.id) : []);
      const missing = message.toolCalls.filter((call) => !answered.has(call.id));
      if (!missing.length) continue;
      const filler = missing.map((call) => ({ id: call.id, name: call.name, output: call.started ? TOOL_OUTCOME_UNKNOWN : TOOL_NOT_STARTED, isError: true }));
      if (next?.role === "tool") {
        messages = [...messages.slice(0, index + 1), { role: "tool", results: [...next.results, ...filler] }, ...messages.slice(index + 2)];
      } else {
        out.push({ role: "tool", results: filler });
      }
    }
  }
  return out;
}

async function post(request: ChatRequest, url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  const fetcher = request.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: request.signal });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    throw new ProviderError(`Could not reach ${request.provider.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new ProviderError(await errorText(request.provider.name, response), response.status);
  if (!response.body) throw new ProviderError(`${request.provider.name} sent an empty response.`, response.status, "EMPTY_RESPONSE");
  return response;
}

async function errorText(name: string, response: Response): Promise<string> {
  let detail = "";
  try {
    const raw = await response.text();
    try {
      // `detail` is the RFC 7807 problem shape NVIDIA NIM answers with.
      const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string; detail?: string };
      detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message ?? parsed.detail ?? raw;
    } catch {
      detail = raw;
    }
  } catch { /* no body */ }
  const hint = response.status === 401 || response.status === 403 ? " Check the key in Settings → Providers." : response.status === 429 ? " The provider is rate-limiting this key; wait, then retry." : "";
  return `${name} returned ${response.status}${detail ? `: ${detail.slice(0, 600)}` : ""}.${hint}`;
}

/** Server-sent events: yields each event's name and data payload. */
async function* sse(response: Response, signal?: AbortSignal, timeouts?: StreamTimeouts): AsyncGenerator<{ event?: string; data: string }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timer: NodeJS.Timeout | undefined;
  let sawFrame = false;
  // The cancel reason is not always the error `read` rejects with, so the kind lives here.
  let timedOut: "first-event" | "idle" | undefined;
  const arm = (kind: "first-event" | "idle", ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = kind;
      void reader.cancel(new Error(kind)).catch(() => {});
    }, ms);
    timer.unref?.();
  };
  const watchdog = () => {
    if (!timedOut) return null;
    return new ProviderError(timedOut === "first-event" ? "The provider accepted the request but sent nothing." : "The provider stopped sending.", undefined, "EMPTY_RESPONSE");
  };
  try {
    arm("first-event", timeouts?.firstEventMs ?? FIRST_EVENT_MS);
    for (;;) {
      if (signal?.aborted) return;
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (error) {
        if (signal?.aborted) return;
        throw watchdog() ?? error;
      }
      if (timedOut) throw watchdog();
      if (read.done) break;
      // Bytes before the first complete frame do not postpone the first-event clock.
      if (sawFrame) arm("idle", timeouts?.idleMs ?? IDLE_MS);
      buffer += decoder.decode(read.value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event: string | undefined;
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (!data.length) continue;
        if (!sawFrame) {
          sawFrame = true;
          arm("idle", timeouts?.idleMs ?? IDLE_MS);
        }
        yield { event, data: data.join("\n") };
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}

function json(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  return json(raw) ?? { _unparsed: raw };
}

/**
 * A stream that closes without its end marker is not a finished reply: the
 * partial text or tool call must not be taken as the model's answer. Neither
 * carries a status, so both stay retryable inside the elapsed budget.
 */
function closedEarly(request: ChatRequest, opened: boolean, finished: boolean) {
  if (!opened) throw new ProviderError(`${request.provider.name} closed the stream without sending a reply.`, undefined, "EMPTY_RESPONSE");
  if (!finished) throw new ProviderError(`${request.provider.name} ended the reply early.`, undefined, "STREAM_CLOSED");
}

// ─── Anthropic Messages ─────────────────────────────────────────────────────

export function anthropicMessages(messages: ChatMessage[]) {
  const out: Array<{ role: string; content: unknown[] }> = [];
  for (const message of messages) {
    let next: { role: string; content: unknown[] };
    if (message.role === "user") {
      next = {
        role: "user",
        content: message.content.map((part) => part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } }),
      };
    } else if (message.role === "tool") {
      next = {
        role: "user",
        content: message.results.map((result) => ({
          type: "tool_result",
          tool_use_id: result.id,
          content: result.images?.length ? [
            { type: "text", text: result.output || "(no output)" },
            ...result.images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
          ] : result.output || "(no output)",
          ...(result.isError ? { is_error: true } : {}),
        })),
      };
    } else {
      const content: unknown[] = [];
      for (const block of message.thinking ?? []) {
        if (block.redacted) content.push({ type: "redacted_thinking", data: block.redacted });
        else if (block.signature) content.push({ type: "thinking", thinking: block.text, signature: block.signature });
      }
      if (message.text) content.push({ type: "text", text: message.text });
      for (const call of message.toolCalls ?? []) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      if (!content.length) content.push({ type: "text", text: "(no reply)" });
      next = { role: "assistant", content };
    }
    // Tool results are user messages. A steer after them must share that message; Anthropic rejects two user messages in a row.
    const previous = out[out.length - 1];
    if (next.role === "user" && previous?.role === "user") previous.content.push(...next.content);
    else out.push(next);
  }
  return out;
}

async function* streamAnthropic(request: ChatRequest): AsyncGenerator<StreamEvent> {
  const { model } = splitModelId(request.modelId);
  const tiers = effortTiers(request.provider.id, model, "anthropic", request.listedReasoning, request.listedEfforts);
  const tier = request.effort as Tier | undefined;
  const budget = tier && tier !== "none" && tiers.includes(tier) ? THINKING_BUDGET[tier] : undefined;
  const small = /claude-3-(?!7)/i.test(model);
  const body: Record<string, unknown> = {
    model,
    max_tokens: small ? SMALL_MAX_TOKENS : MAX_TOKENS,
    system: anthropicSystem(request.system),
    messages: anthropicMessages(request.messages),
    stream: true,
    ...(request.tools.length ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
    ...(budget ? { thinking: { type: "enabled", budget_tokens: Math.min(budget, MAX_TOKENS - 4_000) } } : {}),
  };
  const response = await post(request, `${request.provider.root}/messages`, { "x-api-key": request.provider.apiKey, "anthropic-version": "2023-06-01" }, body);
  type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  type Block = { type: string; text: string; signature?: string; data?: string; id?: string; name?: string; json: string };
  const blocks: Block[] = [];
  let stopReason = "end_turn";
  let opened = false;
  let finished = false;
  for await (const { data } of sse(response, request.signal, request.timeouts)) {
    const frame = json(data);
    if (!frame) continue;
    const type = frame.type;
    if (type === "message_start") opened = true;
    else if (type === "message_stop") finished = true;
    if (type === "error") {
      const error = frame.error as { message?: string } | undefined;
      throw new ProviderError(`${request.provider.name}: ${error?.message ?? "stream error"}`);
    }
    if (type === "message_start") {
      const usage = (frame.message as { usage?: Usage } | undefined)?.usage;
      // Anthropic's input_tokens excludes cache. The window is the sum of the three.
      if (usage && (usage.input_tokens != null || usage.cache_read_input_tokens != null || usage.cache_creation_input_tokens != null)) {
        yield {
          type: "usage",
          ...(usage.input_tokens != null ? { inputTokens: usage.input_tokens } : {}),
          ...(usage.cache_read_input_tokens != null ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
          ...(usage.cache_creation_input_tokens != null ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
        };
      }
    } else if (type === "content_block_start") {
      const block = frame.content_block as Record<string, unknown>;
      blocks[frame.index as number] = { type: String(block.type), text: String(block.text ?? block.thinking ?? ""), data: typeof block.data === "string" ? block.data : undefined, id: typeof block.id === "string" ? block.id : undefined, name: typeof block.name === "string" ? block.name : undefined, json: "" };
    } else if (type === "content_block_delta") {
      const block = blocks[frame.index as number];
      const delta = frame.delta as Record<string, unknown>;
      if (!block) continue;
      if (delta.type === "text_delta" && typeof delta.text === "string") { block.text += delta.text; yield { type: "text", delta: delta.text }; }
      else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") { block.text += delta.thinking; yield { type: "reasoning", delta: delta.thinking }; }
      else if (delta.type === "signature_delta" && typeof delta.signature === "string") block.signature = (block.signature ?? "") + delta.signature;
      else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") block.json += delta.partial_json;
    } else if (type === "message_delta") {
      const delta = frame.delta as { stop_reason?: string } | undefined;
      if (delta?.stop_reason) { stopReason = delta.stop_reason; finished = true; }
      const usage = frame.usage as { output_tokens?: number } | undefined;
      if (usage?.output_tokens != null) yield { type: "usage", outputTokens: usage.output_tokens };
    }
  }
  // A stop by the user keeps what arrived, as before. Only an unasked-for close is a failure.
  if (!request.signal?.aborted) closedEarly(request, opened, finished);
  const present = blocks.filter(Boolean);
  const message: AssistantMessage = {
    role: "assistant",
    text: present.filter((block) => block.type === "text").map((block) => block.text).join(""),
    thinking: present.filter((block) => block.type === "thinking" || block.type === "redacted_thinking").map((block) => block.type === "redacted_thinking" ? { text: "", redacted: block.data } : { text: block.text, signature: block.signature }),
    toolCalls: present.filter((block) => block.type === "tool_use" && block.id && block.name).map((block) => ({ id: block.id!, name: block.name!, input: parseArgs(block.json) })),
  };
  yield { type: "done", message, stopReason };
}

// ─── OpenAI-compatible Chat Completions ─────────────────────────────────────

/** The cached prefix first, then the part that may change, so a date or mode change does not rewrite the prefix. */
function anthropicSystem(system: SystemPrompt) {
  const blocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [
    { type: "text", text: system.stable, cache_control: { type: "ephemeral" } },
  ];
  if (system.volatile.trim()) blocks.push({ type: "text", text: system.volatile });
  return blocks;
}

export function openAiMessages(system: SystemPrompt, messages: ChatMessage[]) {
  const out: unknown[] = [{ role: "system", content: system.stable }];
  if (system.volatile.trim()) out.push({ role: "system", content: system.volatile });
  for (const message of messages) {
    if (message.role === "user") {
      const images = message.content.some((part) => part.type === "image");
      out.push({
        role: "user",
        content: images
          ? message.content.map((part) => part.type === "text" ? { type: "text", text: part.text } : { type: "image_url", image_url: { url: `data:${part.mediaType};base64,${part.data}` } })
          : message.content.map((part) => part.type === "text" ? part.text : "").join("\n"),
      });
    } else if (message.role === "tool") {
      // Chat Completions keeps tool results text-only. Send every result first,
      // then attach their images in one following user message so a multi-call
      // batch never breaks the assistant → tool-call pairing.
      const images = message.results.flatMap((result) => result.images ?? []);
      for (const result of message.results) out.push({ role: "tool", tool_call_id: result.id, content: result.output || "(no output)" });
      if (images.length) out.push({
        role: "user",
        content: [
          { type: "text", text: `Image output from the preceding tool result${images.length === 1 ? "" : "s"}.` },
          ...images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } })),
        ],
      });
    } else {
      out.push({
        role: "assistant",
        content: message.text || null,
        ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}),
      });
    }
  }
  return out;
}

/** The request field that carries a reasoning effort, per provider. */
function effortField(providerId: string, model: string, effort: string | undefined, wire: ResolvedProvider["wire"], listedReasoning?: boolean, listedEfforts?: readonly string[]): Record<string, unknown> {
  if (!effort) return {};
  const tiers = effortTiers(providerId, model, wire, listedReasoning, listedEfforts) as string[];
  if (!tiers.includes(effort)) return {};
  // OpenRouter, and the Kilo gateway in front of it, take `reasoning.effort` (including "none").
  if (providerId === "openrouter" || providerId === "kilo") return { reasoning: { effort } };
  // The Cline API takes the same pair its own CLI sends: the level and an on/off switch.
  if (providerId === "cline") return { reasoning_effort: effort, reasoning: { enabled: effort !== "none" } };
  if (providerId === "nvidia" && tiers.includes("none")) {
    // Hybrid thinkers read one of these two template switches; the other is ignored.
    const on = effort !== "none";
    return { chat_template_kwargs: { thinking: on, enable_thinking: on } };
  }
  return { reasoning_effort: effort };
}

/**
 * Providers known to accept `stream_options.include_usage`. NIM, Cline and Kilo
 * stay off this list. A custom gateway such as ZenMux is asked too: without the
 * flag its stream omits `usage`, and the app then counts only the reply.
 */
const USAGE_IN_STREAM = new Set(["openai", "openrouter", "xai", "deepseek", "groq", "google"]);

async function* streamOpenAi(request: ChatRequest): AsyncGenerator<StreamEvent> {
  const { providerId, model } = splitModelId(request.modelId);
  const askUsage = USAGE_IN_STREAM.has(providerId) || isCustomProvider(providerId);
  const body: Record<string, unknown> = {
    model,
    messages: openAiMessages(request.system, request.messages),
    stream: true,
    ...(askUsage ? { stream_options: { include_usage: true } } : {}),
    ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
    ...effortField(providerId, model, request.effort, request.provider.wire, request.listedReasoning, request.listedEfforts),
  };
  const headers: Record<string, string> = request.provider.apiKey ? { authorization: `Bearer ${request.provider.apiKey}` } : {};
  if (providerId === "openrouter") headers["x-title"] = "Glitter";
  const url = `${request.provider.root}/chat/completions`;
  let response: Response;
  try {
    response = await post(request, url, headers, body);
  } catch (error) {
    // A strict local gateway can reject the usage flag. Ask once more without it.
    const rejected = askUsage && error instanceof ProviderError && error.status === 400 && /stream_options|include_usage/i.test(error.message);
    if (!rejected) throw error;
    delete body.stream_options;
    response = await post(request, url, headers, body);
  }
  type PromptDetails = { cached_tokens?: number };
  let text = "";
  let reasoning = "";
  let stopReason = "stop";
  let opened = false;
  let finished = false;
  const calls: Array<{ id: string; name: string; json: string }> = [];
  for await (const { data } of sse(response, request.signal, request.timeouts)) {
    opened = true;
    if (data === "[DONE]") { finished = true; break; }
    const frame = json(data);
    if (!frame) continue;
    if (frame.error) {
      const error = frame.error as { message?: string } | string;
      throw new ProviderError(`${request.provider.name}: ${typeof error === "string" ? error : error.message ?? "stream error"}`);
    }
    const usage = frame.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: PromptDetails } | undefined;
    if (usage && (usage.prompt_tokens != null || usage.completion_tokens != null)) {
      // prompt_tokens already includes the cached portion. Subtract it so the uncached counter stays disjoint.
      const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
      yield {
        type: "usage",
        ...(usage.prompt_tokens != null ? { inputTokens: Math.max(0, usage.prompt_tokens - cached), ...(cached ? { cacheReadTokens: cached } : {}) } : {}),
        ...(usage.completion_tokens != null ? { outputTokens: usage.completion_tokens } : {}),
      };
    }
    const choice = (frame.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) continue;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    const thought = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
    if (thought) { reasoning += thought; yield { type: "reasoning", delta: thought }; }
    if (typeof delta.content === "string" && delta.content) { text += delta.content; yield { type: "text", delta: delta.content }; }
    for (const call of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
      const index = typeof call.index === "number" ? call.index : calls.length;
      const fn = (call.function ?? {}) as { name?: string; arguments?: string };
      calls[index] ??= { id: "", name: "", json: "" };
      if (typeof call.id === "string" && call.id) calls[index].id = call.id;
      if (fn.name) calls[index].name += fn.name;
      if (fn.arguments) calls[index].json += fn.arguments;
    }
    if (typeof choice.finish_reason === "string") { stopReason = choice.finish_reason; finished = true; }
  }
  // A stop by the user keeps what arrived, as before. Only an unasked-for close is a failure.
  if (!request.signal?.aborted) closedEarly(request, opened, finished);
  const message: AssistantMessage = {
    role: "assistant",
    text,
    ...(reasoning ? { thinking: [{ text: reasoning }] } : {}),
    toolCalls: calls.filter((call) => call && call.name).map((call, index) => ({ id: call.id || `call_${index}_${Date.now().toString(36)}`, name: call.name, input: parseArgs(call.json) })),
  };
  yield { type: "done", message, stopReason };
}
