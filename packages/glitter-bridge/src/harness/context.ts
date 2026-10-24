import type { ChatMessage, ContentPart, ToolSchema } from "./wire.js";

/**
 * Context management: fit the request into the model's window before it is
 * sent. The estimator is deliberately conservative (it over-counts); it only
 * decides *whether* to trim, never what the provider charges. Providers remain
 * the source of truth through the `usage` event.
 *
 * Trimming is a request view, like `history()`: the persisted transcript keeps
 * full output, and every rung of the ladder says what it is, so the model
 * knows the tail is not the whole output. Oversized *single* results are
 * handled earlier, in tools.ts, by spilling to `.muse/tool-output`; this module
 * fits the accumulated history.
 */

/** How far one tool result has been shortened. */
export type TrimRung = "full" | "head_tail" | "skeleton";

export type ContextBudget = { input: number; output: number };

/** How many messages keep their tool output verbatim. */
const RECENT_MESSAGES = 8;
/** Older tool output beyond this is shortened, even in a roomy window. */
const OLD_OUTPUT_CHARS = 4_000;

/**
 * The recency clip: long threads keep their recent tool output in full and
 * shorten older output. This is rung zero of the ladder — it applies before any
 * budget pressure, and a result already past it enters the ladder at head_tail.
 */
export function clipRecency(messages: readonly ChatMessage[]): ChatMessage[] {
  const keepFrom = Math.max(0, messages.length - RECENT_MESSAGES);
  return messages.map((message, index) => {
    if (index >= keepFrom || message.role !== "tool") return message;
    return {
      ...message,
      results: message.results.map((result) => {
        const shortened = result.output.length > OLD_OUTPUT_CHARS ? `${result.output.slice(0, OLD_OUTPUT_CHARS / 2)}\n… (older output shortened)` : result.output;
        if (!result.images?.length) return shortened === result.output ? result : { ...result, output: shortened };
        return { ...result, output: `${shortened}\n[Older tool image omitted from this context view.]`, images: undefined };
      }),
    };
  });
}

/** One character is about this many tokens, over exactly what the wire sends. */
const CHARS_PER_TOKEN = 4;
/** What the providers charge for a 1568px image, as a flat estimate. */
const IMAGE_TOKENS = 1_100;
/** Head/tail sizes at the middle rung: the head keeps what was asked, the tail keeps errors and summaries. */
const HEAD_CHARS = 3_000;
const TAIL_CHARS = 1_000;

/**
 * The output reserve. Matches wire.ts's MAX_TOKENS, and shrinks on small
 * windows so input + output can never exceed the window.
 */
export function outputReserve(window: number): number {
  return Math.min(32_000, Math.floor(window * 0.1));
}

/** Input budget = window minus the output reserve. */
export function contextBudget(window: number): ContextBudget {
  const output = outputReserve(window);
  return { input: Math.max(1, window - output), output };
}

function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function contentTokens(parts: readonly ContentPart[]): number {
  let tokens = 0;
  for (const part of parts) {
    if (part.type === "text") tokens += textTokens(part.text);
    else tokens += IMAGE_TOKENS;
  }
  return tokens;
}

/** Estimate the tokens a request costs, in the shape the wires send. */
export function estimateRequestTokens(options: {
  system: { stable: string; volatile: string };
  messages: readonly ChatMessage[];
  tools: readonly ToolSchema[];
}): number {
  let tokens = textTokens(options.system.stable) + textTokens(options.system.volatile);
  for (const tool of options.tools) tokens += textTokens(tool.name) + textTokens(tool.description) + textTokens(JSON.stringify(tool.parameters));
  for (const message of options.messages) {
    if (message.role === "user") tokens += contentTokens(message.content);
    else if (message.role === "assistant") {
      tokens += textTokens(message.text);
      for (const block of message.thinking ?? []) tokens += textTokens(block.text);
      for (const call of message.toolCalls ?? []) tokens += textTokens(call.name) + textTokens(JSON.stringify(call.input));
    } else {
      for (const result of message.results) tokens += textTokens(result.output) + (result.images?.length ?? 0) * IMAGE_TOKENS;
    }
  }
  return tokens;
}

/** The marker a head+tail result carries. A result containing it is on the middle rung. */
export const HEADTAIL_MARKER = "chars elided";
/** The marker a skeleton carries. A result containing it is on the lowest rung. */
export const SKELETON_MARKER = "shortened to fit the context window";

/** Head + tail, marked; the model sees that the middle is gone. */
export function headTail(output: string, head = HEAD_CHARS, tail = TAIL_CHARS): string {
  if (output.length <= head + tail) return output;
  const elided = output.length - head - tail;
  return `${output.slice(0, head)}\n… (${elided.toLocaleString("en-US")} ${HEADTAIL_MARKER} — the full text is in the transcript's earlier messages and in any saved tool output) …\n${output.slice(output.length - tail)}`;
}

/** The lowest rung: what the call was, its first line, and how big the *original* result was. */
export function skeleton(name: string, output: string, originalChars = output.length): string {
  const first = output.split("\n", 1)[0].slice(0, 200);
  return `[Tool result ${SKELETON_MARKER}. Tool: ${name}. First line: ${first}. Size: ${originalChars.toLocaleString("en-US")} chars. The full text is in the transcript's earlier messages and in any saved tool output.]`;
}

/** Which rung a result is on, by its own marker. Our markers are deterministic; a tool result that happens to contain one is trimmed one rung deeper, which is safe. */
function rungOf(output: string): TrimRung {
  if (output.includes(SKELETON_MARKER)) return "skeleton";
  if (output.includes(HEADTAIL_MARKER)) return "head_tail";
  return "full";
}

/**
 * Fit `messages` into `budget` tokens. Tool results are shortened one rung at a
 * time — full → head+tail → skeleton, oldest first — until the messages fit.
 * A result already carrying a marker (a view fitted on an earlier attempt)
 * continues from that rung, so a retry is strictly smaller than the request
 * before it. Returns the fitted messages (the input array is never mutated),
 * whether anything changed, the estimate afterwards, and whether it now fits.
 * `force` is reserved for a provider-reported overflow: it advances one rung
 * even when the conservative local estimate already fits.
 */
export type FitHistory = { messages: ChatMessage[]; trimmed: boolean; tokens: number; fitted: boolean };

export function fitHistory(options: { messages: readonly ChatMessage[]; budget: number; force?: boolean }): FitHistory {
  const measure = (messages: readonly ChatMessage[]): number => {
    let tokens = 0;
    for (const message of messages) {
      if (message.role === "user") tokens += contentTokens(message.content);
      else if (message.role === "assistant") {
        tokens += textTokens(message.text);
        for (const block of message.thinking ?? []) tokens += textTokens(block.text);
        for (const call of message.toolCalls ?? []) tokens += textTokens(call.name) + textTokens(JSON.stringify(call.input));
      } else {
        for (const result of message.results) tokens += Math.ceil(result.output.length / CHARS_PER_TOKEN) + (result.images?.length ?? 0) * IMAGE_TOKENS;
      }
    }
    return tokens;
  };
  let tokens = measure(options.messages);
  if (tokens <= options.budget && !options.force) return { messages: options.messages as ChatMessage[], trimmed: false, tokens, fitted: true };

  // Clone the tool messages (the only mutable rung) so the canonical history is untouched.
  const messages = options.messages.map((message) => (message.role === "tool" ? { ...message, results: message.results.map((result) => ({ ...result })) } : message));
  // Each result descends its own ladder completely — full → head+tail → skeleton —
  // before the next result is touched: the oldest result is the least relevant, so
  // it gives up the most bytes first, and the newest stays verbatim as long as it can.
  const state = new Map<string, { rung: TrimRung; original: number }>();
  let changed = false;
  // Images are large and cannot be shortened like text. Drop the oldest ones
  // first, before spending another text-trimming rung, and say what was removed.
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const result of message.results) {
      if ((!options.force && tokens <= options.budget) || !result.images?.length) continue;
      tokens -= result.images.length * IMAGE_TOKENS;
      result.images = undefined;
      const note = "\n[Tool image omitted to fit the context window.]";
      result.output += note;
      tokens += textTokens(note);
      changed = true;
    }
  }
  outer: for (let index = 0; index < messages.length && (options.force || tokens > options.budget); index += 1) {
    const message = messages[index];
    if (message.role !== "tool") continue;
    for (const result of message.results) {
      const recorded = state.get(`${index}:${result.id}`) ?? { rung: rungOf(result.output), original: result.output.length };
      while ((options.force || tokens > options.budget) && recorded.rung !== "skeleton") {
        const current = result.output;
        const next = recorded.rung === "full" ? headTail(current) : skeleton(result.name, current, recorded.original);
        recorded.rung = recorded.rung === "full" ? "head_tail" : "skeleton";
        state.set(`${index}:${result.id}`, recorded);
        // A no-op (already short) or a cut that does not pay for its marker leaves the result alone.
        if (next === current || next.length >= current.length) continue;
        tokens -= Math.ceil(current.length / CHARS_PER_TOKEN) - Math.ceil(next.length / CHARS_PER_TOKEN);
        result.output = next;
        changed = true;
      }
      if (tokens <= options.budget) break outer;
    }
  }
  return { messages, trimmed: changed, tokens: Math.max(0, tokens), fitted: tokens <= options.budget };
}
