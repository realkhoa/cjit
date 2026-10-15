/**
 * Timeline stepping.
 *
 * The interpreter records every assignment and every loop pass, so the timeline is
 * a complete recording of the run. Stepping through it is therefore index
 * arithmetic, not process control: this walks *what already happened*, it does not
 * pause a running program. Being precise about that matters, because a debugger
 * that claims to stop a program which has already finished would be a lie.
 *
 * Everything here is pure so the boundary behaviour (both ends, empty history) is
 * unit tested rather than discovered by clicking.
 */

/** How fast playback advances, in milliseconds per moment. */
export const PLAYBACK_INTERVAL_MS = 140;

export function lastTimelineIndex(historyLength: number): number {
  return Math.max(historyLength - 1, 0);
}

export function clampTimelineIndex(historyLength: number, index: number): number {
  const last = lastTimelineIndex(historyLength);
  if (!Number.isFinite(index)) return last;
  return Math.min(Math.max(Math.trunc(index), 0), last);
}

/** The index `delta` moments away, clamped: stepping past an end stays there. */
export function stepTimeline(
  historyLength: number,
  index: number,
  delta: number,
): number {
  return clampTimelineIndex(historyLength, clampTimelineIndex(historyLength, index) + delta);
}

export function isTimelineAtEnd(historyLength: number, index: number): boolean {
  return clampTimelineIndex(historyLength, index) >= lastTimelineIndex(historyLength);
}

/**
 * Where stepping forward/back should start when the timeline is entered.
 *
 * Stepping forward starts at the beginning (you are walking the run), stepping
 * back starts at the end (you are walking back from what just happened).
 */
export function entryIndexFor(historyLength: number, delta: number): number {
  return delta > 0 ? 0 : lastTimelineIndex(historyLength);
}

/** `3/12`, or `no history` when there is nothing recorded. */
export function timelinePositionLabel(historyLength: number, index: number): string {
  if (historyLength <= 0) return 'no history';
  return `${clampTimelineIndex(historyLength, index) + 1}/${historyLength}`;
}
