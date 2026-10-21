import { useEffect, useRef, useState } from "react";

/** Closing animations: popovers leave over EXIT_FAST_MS, larger surfaces over EXIT_MS. styles.css uses the same values (--dur-1, --dur-2). */
export const EXIT_FAST_MS = 120;
export const EXIT_MS = 180;

/**
 * True when nothing should wait on an animation: the user asked for reduced
 * motion, or the environment cannot say (no window, or no matchMedia).
 */
export function motionReduced(): boolean {
  return typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Keep something rendered while it animates out. `mounted` stays true for one
 * exit after `open` turns false, and `closing` is true during it, so the caller
 * can add its closing class. A duration of 0, or reduced motion, closes at once.
 */
export function usePresence(open: boolean, ms: number = EXIT_MS): { mounted: boolean; closing: boolean } {
  const [state, setState] = useState({ open, closing: false });
  let closing = state.closing;
  // Derived during render, so the frame that sees `open` turn false already draws the exit.
  if (state.open !== open) {
    closing = !open && ms > 0 && !motionReduced();
    setState({ open, closing });
  }
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setState((current) => (current.closing ? { ...current, closing: false } : current)), ms);
    return () => window.clearTimeout(timer);
  }, [closing, ms]);
  return { mounted: open || closing, closing };
}

/** The last value that was not null, so a surface can keep drawing its content while it animates out. */
export function useRetained<T>(value: T | null | undefined): T | null | undefined {
  const last = useRef(value);
  if (value != null) last.current = value;
  return value ?? last.current;
}
