type Bounds = { left: number; right: number; top: number; bottom: number };

/** Keep an anchored menu inside its viewport or modal, choosing the roomier side. */
export function menuPosition(anchor: Bounds, menu: { width: number; height: number }, bounds: Bounds, preferBelow: boolean, alignRight = false) {
  const margin = 8;
  const gap = 6;
  const width = Math.max(0, Math.min(menu.width, bounds.right - bounds.left - margin * 2));
  const above = Math.max(0, anchor.top - bounds.top - margin - gap);
  const below = Math.max(0, bounds.bottom - anchor.bottom - margin - gap);
  const preferred = preferBelow ? below : above;
  const other = preferBelow ? above : below;
  const openBelow = preferred >= menu.height || preferred >= other ? preferBelow : !preferBelow;
  const height = Math.min(menu.height, openBelow ? below : above);
  const left = Math.max(bounds.left + margin, Math.min(alignRight ? anchor.right - width : anchor.left, bounds.right - margin - width));
  const top = openBelow ? anchor.bottom + gap : anchor.top - gap - height;
  return { left, top, width, maxHeight: height };
}
