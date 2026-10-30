import type { ChatMessage } from "../wire.js";

/** The only conversation shape shared between providers: app-owned plain text. */
export type NeutralTranscriptEntry = {
  kind: "user" | "answer" | "plan" | "build-report" | "review-notes";
  text: string;
};

export type TranscriptTail = {
  entries: NeutralTranscriptEntry[];
  omittedEntries: number;
  truncated: boolean;
};

export const DEFAULT_TRANSCRIPT_TAIL = { maxEntries: 12, maxChars: 24_000 } as const;
export const MAX_THREAD_BRIEF_CHARS = 12_000;
const KINDS: readonly NeutralTranscriptEntry["kind"][] = ["user", "answer", "plan", "build-report", "review-notes"];

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = (omitted: number) => `\n… (${omitted} chars omitted) …\n`;
  let head = Math.floor(maxChars / 2);
  let tail = maxChars - head;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const omitted = text.length - head - tail;
    const label = marker(omitted);
    const available = maxChars - label.length;
    if (available < 2) return text.slice(0, maxChars);
    const nextHead = Math.floor(available / 2);
    const nextTail = available - nextHead;
    if (nextHead === head && nextTail === tail) return `${text.slice(0, head)}${label}${text.slice(text.length - tail)}`;
    head = nextHead;
    tail = nextTail;
  }
  return text.slice(0, maxChars);
}

/**
 * Keep a bounded recent tail and rebuild every entry with only `kind` and
 * `text`. Extra runtime fields such as thinking blocks, signatures and tool
 * calls therefore cannot hitchhike into another provider's session.
 */
export function neutralTranscriptTail(
  entries: readonly NeutralTranscriptEntry[],
  options: { maxEntries?: number; maxChars?: number } = {},
): TranscriptTail {
  const maxEntries = options.maxEntries ?? DEFAULT_TRANSCRIPT_TAIL.maxEntries;
  const maxChars = options.maxChars ?? DEFAULT_TRANSCRIPT_TAIL.maxChars;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive integer.");
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError("maxChars must be a positive integer.");

  const clean = entries.filter((entry) => entry && KINDS.includes(entry.kind) && typeof entry.text === "string")
    .map((entry) => ({ kind: entry.kind, text: entry.text }));
  const recent = clean.slice(-maxEntries);
  const selected: NeutralTranscriptEntry[] = [];
  let remaining = maxChars;
  let truncated = clean.length > recent.length;

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const entry = recent[index];
    if (entry.text.length <= remaining) {
      selected.unshift(entry);
      remaining -= entry.text.length;
      continue;
    }
    if (!selected.length) selected.unshift({ kind: entry.kind, text: clip(entry.text, remaining) });
    truncated = true;
    break;
  }
  return { entries: selected, omittedEntries: clean.length - selected.length, truncated };
}

/**
 * Reduce a provider-specific history to the app-owned neutral transcript.
 * Tool traffic, thinking blocks and signatures never become part of it.
 */
export function neutralEntries(messages: readonly ChatMessage[]): NeutralTranscriptEntry[] {
  const entries: NeutralTranscriptEntry[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
      const images = message.content.filter((part) => part.type === "image").length;
      const attachment = images ? `[${images} image attachment${images === 1 ? "" : "s"}]` : "";
      const shown = [text, attachment].filter(Boolean).join("\n");
      if (shown) entries.push({ kind: "user", text: shown });
    } else if (message.role === "assistant" && message.text.trim()) {
      entries.push({ kind: "answer", text: message.text.trim() });
    }
  }
  return entries;
}

/** A short, provider-neutral brief for a fresh Builder or Small-task session. */
export function threadBrief(options: {
  title?: string;
  objective: string;
  constraints?: readonly string[];
  transcript?: readonly NeutralTranscriptEntry[];
  maxTranscriptChars?: number;
}): string {
  const title = options.title?.trim();
  const constraints = (options.constraints ?? []).slice(0, 20).map((constraint) => clip(constraint.trim(), 500)).filter(Boolean);
  const sections = [
    title ? `Thread: ${clip(title, 200)}` : "",
    `Current objective:\n${clip(options.objective.trim(), 4_000)}`,
    constraints.length ? `Constraints:\n${constraints.map((constraint) => `- ${constraint}`).join("\n")}` : "",
  ].filter(Boolean);
  if (options.transcript?.length) {
    const tail = neutralTranscriptTail(options.transcript, { maxChars: options.maxTranscriptChars ?? 8_000, maxEntries: 8 });
    if (tail.entries.length) sections.push(`Recent neutral transcript:\n${tail.entries.map((entry) => `[${entry.kind}]\n${entry.text}`).join("\n\n")}`);
  }
  return clip(sections.join("\n\n"), MAX_THREAD_BRIEF_CHARS);
}
