import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp(join(tmpdir(), "glitter-wire-"));
const outfile = join(directory, "wire.mjs");
await writeFile(join(directory, "entry.ts"), `export { streamChat, isTransientProviderError, parseRetryAfter, parseContextLimit } from ${JSON.stringify(resolve("packages/glitter-harness/src/harness/wire.ts"))};\nexport { imageRequestProblem } from ${JSON.stringify(resolve("packages/glitter-harness/src/harness/images.ts"))};\n`);
await build({ entryPoints: [join(directory, "entry.ts")], bundle: true, platform: "node", format: "esm", outfile, logLevel: "silent" });
const { streamChat, isTransientProviderError, imageRequestProblem, parseRetryAfter, parseContextLimit } = await import(pathToFileURL(outfile).href);

function png(width, height) {
  const bytes = Buffer.alloc(24);
  bytes.write("\x89PNG\r\n\x1a\n", 0, "binary");
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

function imageMessage(mediaType, data) {
  return { role: "user", content: [{ type: "image", mediaType, data }] };
}

test("common WebP encodings pass image admission and malformed base64 does not", () => {
  // Real 2×3 lossy, lossless, and alpha WebP files, respectively.
  const webp = [
    "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=",
    "UklGRhwAAABXRUJQVlA4TA8AAAAvAYAAAAcQ/Y/+ByKi/wEA",
    "UklGRl4AAABXRUJQVlA4WAoAAAAQAAAAAQAAAgAAQUxQSAcAAAAAgICAgICAAFZQOCAwAAAA0AEAnQEqAgADAAFAJiWgAnS6AfgAA7AA/vLrf/zYFc1z7/f/0uD9Lg/S4P/SkAAA",
  ];
  for (const data of webp) assert.equal(imageRequestProblem([imageMessage("image/webp", data)], true), undefined);
  assert.match(imageRequestProblem([imageMessage("image/webp", `${webp[0]}!`)], true), /base64/i);
  assert.match(imageRequestProblem([imageMessage("image/webp", "")], true), /empty/i);
  const oversizedLossy = Buffer.from(webp[0], "base64");
  oversizedLossy.writeUInt16LE(8001, 26);
  assert.match(imageRequestProblem([imageMessage("image/webp", oversizedLossy.toString("base64"))], true), /8001/);
  const oversizedLossless = Buffer.from(webp[1], "base64");
  oversizedLossless.writeUInt32LE((oversizedLossless.readUInt32LE(21) & ~0x3fff) | 8000, 21);
  assert.match(imageRequestProblem([imageMessage("image/webp", oversizedLossless.toString("base64"))], true), /8001/);
});

const anthropic = { id: "anthropic", name: "Anthropic", wire: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "fixture-key", root: "https://api.anthropic.com/v1" };
const groq = { id: "groq", name: "Groq", wire: "openai", baseUrl: "https://api.groq.com/openai/v1", apiKey: "fixture-key", root: "https://api.groq.com/openai/v1" };
const openrouter = { id: "openrouter", name: "OpenRouter", wire: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKey: "fixture-key", root: "https://openrouter.ai/api/v1" };

function sse(frames) {
  const body = frames.map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function chat(provider, model, fetchImpl, extra = {}) {
  return {
    provider,
    modelId: `${provider.id}/${model}`,
    system: { stable: "fixture system", volatile: "" },
    messages: [{ role: "user", content: [{ type: "text", text: "fixture" }] }],
    tools: [],
    fetchImpl,
    ...extra,
  };
}

async function collect(provider, model, fetchImpl, extra) {
  const events = [];
  for await (const event of streamChat(chat(provider, model, fetchImpl, extra))) events.push(event);
  return events;
}

test("sanitized protocol fixtures cover both wires and one gateway", async () => {
  const anthropicEvents = await collect(anthropic, "claude-sonnet-4.6", async () => sse([
    { type: "message_start", message: { usage: { input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "look" } },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "tu_1", name: "read_file" } },
    { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "{\"pa" } },
    { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "th\":\"a.txt\"}" } },
    "not-json",
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } },
  ]));
  assert.deepEqual(anthropicEvents.filter((event) => event.type === "reasoning" || event.type === "text").map((event) => event.delta), ["look", "ok"]);
  const anthropicDone = anthropicEvents.at(-1);
  assert.equal(anthropicDone.stopReason, "tool_use");
  assert.equal(anthropicDone.message.text, "ok");
  assert.equal(anthropicDone.message.toolCalls[0].id, "tu_1");
  assert.deepEqual(anthropicDone.message.toolCalls[0].input, { path: "a.txt" });
  assert.equal(anthropicEvents.find((event) => event.cacheReadTokens).cacheReadTokens, 80);
  assert.equal(anthropicEvents.find((event) => event.outputTokens).outputTokens, 6);

  const openaiEvents = await collect(groq, "llama-fixture", async () => sse([
    { choices: [{ index: 0, delta: { reasoning_content: "lo" } }] },
    { choices: [{ index: 0, delta: { reasoning_content: "ok", content: "" } }] },
    { choices: [{ index: 0, delta: { content: "hi" } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "{\"pa" } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"a.txt\"}" } }] }, finish_reason: "length" }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 40 } } },
    "[DONE]",
  ]));
  assert.deepEqual(openaiEvents.filter((event) => event.type === "reasoning" || event.type === "text").map((event) => [event.type, event.delta]), [["reasoning", "lo"], ["reasoning", "ok"], ["text", "hi"]]);
  const openaiDone = openaiEvents.at(-1);
  assert.equal(openaiDone.stopReason, "length");
  assert.equal(openaiDone.message.toolCalls[0].id, "call_1");
  assert.deepEqual(openaiDone.message.toolCalls[0].input, { path: "a.txt" });
  const usage = openaiEvents.find((event) => event.cacheReadTokens);
  assert.equal(usage.inputTokens, 60);
  assert.equal(usage.cacheReadTokens, 40);

  let gateway;
  const gatewayEvents = await collect(openrouter, "openai/gpt-5", async (_url, init) => {
    gateway = { url: String(_url), body: JSON.parse(init.body), title: init.headers["x-title"] };
    return sse([
      { choices: [{ index: 0, delta: { content: "routed" }, finish_reason: "stop" }] },
      "[DONE]",
    ]);
  }, { effort: "high" });
  assert.equal(gateway.title, "Glitter");
  assert.equal(gateway.body.reasoning.effort, "high");
  assert.match(gateway.url, /openrouter\.ai/);
  assert.equal(gatewayEvents.at(-1).message.text, "routed");
  assert.equal(gatewayEvents.at(-1).stopReason, "stop");
});

test("a rate limit is retryable and an early close is not a finished answer", async () => {
  await assert.rejects(collect(anthropic, "claude-sonnet-4.6", async () => new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429, headers: { "content-type": "application/json" } })), (error) => {
    assert.equal(error.code, "RATE_LIMIT");
    assert.equal(isTransientProviderError(error), true);
    assert.doesNotMatch(error.message, /fixture-key/);
    return true;
  });
  await assert.rejects(collect(anthropic, "claude-sonnet-4.6", async () => sse([
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
  ])), (error) => {
    assert.equal(error.code, "STREAM_CLOSED");
    assert.equal(isTransientProviderError(error), true);
    return true;
  });
  await assert.rejects(collect(groq, "llama-fixture", async () => new Response("", { status: 200, headers: { "content-type": "text/event-stream" } })), (error) => {
    assert.equal(error.code, "EMPTY_RESPONSE");
    return true;
  });
});

test("an unsupported image is rejected before the provider is called", async () => {
  const approved = Object.freeze({ path: "a.txt" });
  const messages = [
    { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "read_file", input: approved }] },
    imageMessage("image/svg+xml", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64")),
  ];
  assert.match(imageRequestProblem(messages, true), /PNG, JPEG, GIF, or WebP/);
  assert.deepEqual(messages[0].toolCalls[0].input, { path: "a.txt" });
  assert.match(imageRequestProblem([imageMessage("image/png", png(8001, 2))], true), /8001×2/);
  assert.match(imageRequestProblem([imageMessage("image/png", png(2, 2))], false), /does not accept images/);
  assert.equal(imageRequestProblem([imageMessage("image/png", png(2, 2))], null), undefined);
  const many = Array.from({ length: 21 }, () => imageMessage("image/png", png(2, 2)));
  assert.match(imageRequestProblem(many, true), /at most 20/);
  let calls = 0;
  await assert.rejects(collect(anthropic, "claude-sonnet-4.6", async () => { calls += 1; return sse([]); }, {
    messages: [imageMessage("image/svg+xml", Buffer.from("<svg/>").toString("base64"))],
  }), /PNG, JPEG, GIF, or WebP/);
  assert.equal(calls, 0);
});

test("cache controls stay on the wire that supports them, and Retry-After is a bounded delay", async () => {
  let anthropicBody;
  await collect(anthropic, "claude-sonnet-4.6", async (_url, init) => {
    anthropicBody = JSON.parse(init.body);
    return sse([{ type: "message_start", message: { usage: { input_tokens: 1 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }]);
  });
  assert.equal(anthropicBody.system[0].cache_control.type, "ephemeral");
  let groqBody;
  await collect(groq, "llama-fixture", async (_url, init) => {
    groqBody = JSON.parse(init.body);
    return sse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"]);
  });
  assert.equal(JSON.stringify(groqBody).includes("cache_control"), false);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter("1.2"), 1200);
  // Bounded by the host's whole retry budget, not by 20 s: a provider that asks for a minute is honored, one that asks for an hour is not.
  assert.equal(parseRetryAfter("100"), 100_000);
  assert.equal(parseRetryAfter("3600"), 120_000);
  assert.equal(parseRetryAfter("not-a-date"), undefined);
});

test("a stated context limit is parsed out of overflow prose, and prompt sizes are not", () => {
  // OpenAI and vLLM phrasing: the limit comes first, the prompt size is the distractor.
  assert.equal(parseContextLimit("This model's maximum context length is 131072 tokens. However, your messages resulted in 150000 tokens. Please reduce the length of the messages."), 131_072);
  assert.equal(parseContextLimit("litellm.BadRequestError: OpenAIException - This model's maximum context length is 4096 tokens. However, you requested 5000 tokens."), 4_096);
  // Anthropic phrasing: the maximum trails the prompt size.
  assert.equal(parseContextLimit("prompt is too long: 250000 tokens > 200000 maximum"), 200_000);
  assert.equal(parseContextLimit("input length exceeds maximum context length of 8192 tokens"), 8_192);
  assert.equal(parseContextLimit("maximum context length is 32768 tokens"), 32_768);
  // No stated maximum: the host falls back to estimating, never guesses from these.
  assert.equal(parseContextLimit("prompt is too long for the context window"), null);
  assert.equal(parseContextLimit("your messages resulted in 150000 tokens. Please reduce the length."), null);
  assert.equal(parseContextLimit("Request too large: please reduce tokens."), null);
  // Implausible stated limits are ignored, not adopted.
  assert.equal(parseContextLimit("maximum context length is 512 tokens"), null);
  assert.equal(parseContextLimit("maximum context length is 99999999999 tokens"), null);
});

test.after(async () => { await rm(directory, { recursive: true, force: true }); });
