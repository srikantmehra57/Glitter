/**
 * Bounds math for the resizable Changes dock. The stored preference is only
 * ever normalized here — the effective on-screen width is clamped against the
 * live viewport at render/drag time, so resizing the window never rewrites
 * the user's saved width.
 */

export const DOCK_MIN_WIDTH = 300;
export const DOCK_DEFAULT_WIDTH = 360;
export const DOCK_MAX_SAVED_WIDTH = 1600;
/** The thread pane keeps at least this much room next to the dock. */
export const THREAD_MIN_WIDTH = 336;
/** Collapsed, the sidebar has no column of its own: only the main panel's left margin remains. */
export const SIDEBAR_COLLAPSED_WIDTH = 8;

/** Saved width is a user preference: finite values clamp to a generous range. */
export function normalizeDockWidth(value: unknown): number {
  const width = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(width)) return DOCK_DEFAULT_WIDTH;
  return Math.min(DOCK_MAX_SAVED_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(width)));
}

export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;

/** Saved sidebar width: null until the user drags it, then clamped like any hand-editable value. */
export function normalizeSidebarWidth(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

/** On-screen bounds for the sidebar: at most 40% of the window, so the thread keeps the larger share. */
export function sidebarWidthBounds(viewport: number): { min: number; max: number } {
  return { min: SIDEBAR_MIN_WIDTH, max: Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(viewport * 0.4))) };
}

/** The sidebar's rendered width at this viewport. Without a saved width it matches styles.css. */
export function sidebarWidthFor(viewport: number, collapsed: boolean, saved: number | null = null): number {
  if (collapsed) return SIDEBAR_COLLAPSED_WIDTH;
  if (saved == null) return viewport > 1200 ? 264 : 240;
  const { min, max } = sidebarWidthBounds(viewport);
  return Math.min(max, Math.max(min, Math.round(saved)));
}

/** Window resizes, for `useSyncExternalStore` readers of the viewport width. */
export const subscribeResize = (notify: () => void) => {
  window.addEventListener("resize", notify);
  return () => window.removeEventListener("resize", notify);
};

/**
 * On-screen bounds for the dock: never narrower than 300, never wider than
 * 60% of the window, and always leaving room for the thread pane. The maximum
 * is floored at the minimum so absurdly small windows still get a dock.
 */
export function dockWidthBounds(viewport: number, sidebarWidth: number): { min: number; max: number } {
  const max = Math.max(DOCK_MIN_WIDTH, Math.min(Math.floor(viewport * 0.6), viewport - sidebarWidth - THREAD_MIN_WIDTH));
  return { min: DOCK_MIN_WIDTH, max };
}

/** Effective width for display and for drag/keyboard targets. */
export function clampDockWidth(width: number, viewport: number, sidebarWidth: number): number {
  const { min, max } = dockWidthBounds(viewport, sidebarWidth);
  if (!Number.isFinite(width)) return Math.min(max, Math.max(min, DOCK_DEFAULT_WIDTH));
  return Math.min(max, Math.max(min, Math.round(width)));
}
