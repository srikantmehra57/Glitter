import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./format";

/** `tick`: a light detent · `level`: a committed change · `thump`: a heavy hit. */
export type HapticKind = "tick" | "level" | "thump";

const NATIVE: Record<HapticKind, string> = { tick: "alignment", level: "level", thump: "generic" };
const VIBRATE: Record<HapticKind, number | number[]> = { tick: 6, level: 14, thump: [18, 30, 28] };
let last = 0;

/**
 * Trackpad haptics on macOS (Force Touch) through the shell; `navigator.vibrate`
 * elsewhere. Never throws — haptics are decoration.
 */
export function haptic(kind: HapticKind) {
  const now = performance.now();
  if (kind === "tick" && now - last < 28) return;
  last = now;
  if (isTauri()) {
    void invoke("haptic", { kind: NATIVE[kind] }).catch(() => {});
    return;
  }
  try { navigator.vibrate?.(VIBRATE[kind]); } catch { /* unsupported */ }
}
