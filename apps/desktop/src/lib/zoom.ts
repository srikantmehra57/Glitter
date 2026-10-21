/** Interface zoom levels, as browsers step them. 1 is actual size. */
export const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/** A saved zoom, or actual size when it is missing or out of range. */
export function normalizeZoom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= ZOOM_LEVELS[0] && value <= ZOOM_LEVELS[ZOOM_LEVELS.length - 1] ? value : 1;
}

/** The next level in a direction, stopping at either end. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const level = normalizeZoom(current);
  const next = direction > 0 ? ZOOM_LEVELS.find((entry) => entry > level + 0.001) : [...ZOOM_LEVELS].reverse().find((entry) => entry < level - 0.001);
  return next ?? level;
}
