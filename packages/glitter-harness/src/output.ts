/**
 * The one place protocol frames leave the bridge.
 *
 * Streamed `delta` frames are the chattiest thing on the wire: one per model
 * token, one per burst of command output. Each becomes a Rust-side JSON parse, a
 * native event and a webview dispatch, and the renderer paints once per display
 * frame regardless. Deltas for the same item and field are therefore merged for
 * up to `FLUSH_MS` before they cross the pipe.
 *
 * Ordering is preserved exactly: every *other* frame — a response, an item, an
 * approval, the end of a turn — flushes pending deltas first, so the renderer
 * observes the same sequence it would have without any merging.
 */
import { MAX_FRAME_BYTES, encodeFrame } from "./framing.js";

const FLUSH_MS = 12;
/** A burst this large is written at once instead of waiting out the timer. */
const FLUSH_CHARS = 64 * 1024;

type Delta = { sessionId: string; itemId: string; field?: string; delta: string };

const pending = new Map<string, Delta>();
let queuedChars = 0;
let timer: NodeJS.Timeout | null = null;

/** Write one complete, newline-terminated frame after any pending deltas. */
export function writeFrame(line: string) {
  flushDeltas();
  process.stdout.write(line);
}

/**
 * Hold a delta for merging. Returns false — and holds nothing — for a payload
 * that is not the plain shape the host emits, so odd frames pass through untouched.
 */
export function queueDelta(payload: unknown): boolean {
  const delta = payload as Delta | null;
  if (!delta || typeof delta !== "object" || typeof delta.sessionId !== "string" || typeof delta.itemId !== "string" || typeof delta.delta !== "string") return false;
  if (delta.field !== undefined && typeof delta.field !== "string") return false;
  const key = `${delta.sessionId}\u0000${delta.itemId}\u0000${delta.field ?? ""}`;
  const held = pending.get(key);
  if (held) held.delta += delta.delta;
  else pending.set(key, { ...delta });
  queuedChars += delta.delta.length;
  if (queuedChars >= FLUSH_CHARS) flushDeltas();
  else if (!timer) timer = setTimeout(flushDeltas, FLUSH_MS);
  return true;
}

/** Write everything held, oldest first. Safe to call at any time. */
export function flushDeltas() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending.size) return;
  const batch = [...pending.values()];
  pending.clear();
  queuedChars = 0;
  for (const delta of batch) {
    for (const frame of deltaFrames(delta)) process.stdout.write(frame);
  }
}

/**
 * Frames carrying one delta, split when a single burst would cross the
 * protocol ceiling. Every other frame leaves through `encodeFrame`, which
 * refuses oversize lines; an unguarded delta here would kill the shell's
 * reader for the whole bridge. A delta is additive — the renderer concatenates
 * the field — so an oversized burst is split rather than dropped, which would
 * silently eat part of the transcript.
 */
export function deltaFrames(delta: Delta, limit = MAX_FRAME_BYTES): string[] {
  if (Buffer.byteLength(JSON.stringify(delta), "utf8") <= limit) return [encodeFrame({ type: "event", event: "delta", payload: delta })];
  const frames: string[] = [];
  let rest = delta.delta;
  while (rest) {
    // Half the ceiling leaves room for the JSON envelope and multi-byte
    // escapes; cutting before a low surrogate keeps the frame valid UTF-8.
    let end = Math.min(Math.floor(limit / 2), rest.length);
    const cut = rest.charCodeAt(end);
    if (cut >= 0xdc00 && cut <= 0xdfff) end -= 1;
    frames.push(encodeFrame({ type: "event", event: "delta", payload: { ...delta, delta: rest.slice(0, end) } }));
    rest = rest.slice(end);
  }
  return frames;
}

// The shell can die mid-stream, which raises EPIPE on stdout. Without a handler
// that surfaces as an uncaughtException and a non-zero exit instead of the clean
// shutdown the stdin path performs; the stream is gone either way.
process.stdout.on("error", () => {});

// A stream that is cut off mid-burst still delivers what was already produced.
process.once("exit", flushDeltas);
