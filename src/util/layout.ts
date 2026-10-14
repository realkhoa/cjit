/**
 * Pure geometry helpers for the resizable panes. Kept free of DOM and React so
 * the clamping rules can be unit-tested directly.
 */

export const MIN_RIGHT_PERCENT = 20;
export const MAX_RIGHT_PERCENT = 70;
export const MIN_BOTTOM_PERCENT = 12;
export const MAX_BOTTOM_PERCENT = 75;
export const DEFAULT_RIGHT_PERCENT = 34;
export const DEFAULT_BOTTOM_PERCENT = 30;

/** Explorer is a fixed-width column, so it is stored in pixels. */
export const MIN_EXPLORER_WIDTH = 140;
export const MAX_EXPLORER_WIDTH = 420;
export const DEFAULT_EXPLORER_WIDTH = 200;

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Converts a pointer delta in pixels into a new percentage for a pane, clamped
 * to its legal range.
 *
 * @param current Current percentage of the pane being resized.
 * @param deltaPx Pointer movement since the previous event, in CSS pixels.
 * @param extentPx Size of the container along the drag axis, in CSS pixels.
 */
export function percentFromDelta(
  current: number,
  deltaPx: number,
  extentPx: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(extentPx) || extentPx <= 0) {
    return clamp(current, min, max);
  }
  const next = current + (deltaPx / extentPx) * 100;
  return clamp(next, min, max);
}
