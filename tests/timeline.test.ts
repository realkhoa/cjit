import { describe, expect, it } from 'vitest';
import {
  PLAYBACK_INTERVAL_MS,
  clampTimelineIndex,
  entryIndexFor,
  isTimelineAtEnd,
  lastTimelineIndex,
  stepTimeline,
  timelinePositionLabel,
} from '@/ui/timeline';

/**
 * Stepping walks a recording, so the interesting behaviour is at the boundaries:
 * both ends, an empty history, and entering the timeline from another mode.
 */

describe('timeline stepping', () => {
  it('walks forward and backward through the recorded moments', () => {
    expect(stepTimeline(10, 3, 1)).toBe(4);
    expect(stepTimeline(10, 3, -1)).toBe(2);
    expect(stepTimeline(10, 3, 5)).toBe(8);
  });

  it('stays at the ends instead of wrapping or going negative', () => {
    expect(stepTimeline(10, 0, -1)).toBe(0);
    expect(stepTimeline(10, 9, 1)).toBe(9);
    expect(stepTimeline(10, 9, 100)).toBe(9);
  });

  it('handles an empty history', () => {
    expect(lastTimelineIndex(0)).toBe(0);
    expect(clampTimelineIndex(0, 5)).toBe(0);
    expect(stepTimeline(0, 0, 1)).toBe(0);
    expect(isTimelineAtEnd(0, 0)).toBe(true);
  });

  it('clamps a nonsense index rather than trusting it', () => {
    expect(clampTimelineIndex(5, Number.NaN)).toBe(4);
    expect(clampTimelineIndex(5, -3)).toBe(0);
    expect(clampTimelineIndex(5, 99)).toBe(4);
    expect(clampTimelineIndex(5, 2.7)).toBe(2);
  });

  it('enters the timeline from the end when stepping back, the start when forward', () => {
    // Walking the run starts at the beginning; walking back starts at the end.
    expect(entryIndexFor(10, 1)).toBe(0);
    expect(entryIndexFor(10, -1)).toBe(9);
    expect(entryIndexFor(0, -1)).toBe(0);
  });

  it('reports the position, or says there is nothing recorded', () => {
    expect(timelinePositionLabel(10, 0)).toBe('1/10');
    expect(timelinePositionLabel(10, 9)).toBe('10/10');
    expect(timelinePositionLabel(10, 99)).toBe('10/10');
    expect(timelinePositionLabel(0, 0)).toBe('no history');
  });

  it('knows when playback has reached the end', () => {
    expect(isTimelineAtEnd(10, 8)).toBe(false);
    expect(isTimelineAtEnd(10, 9)).toBe(true);
    expect(isTimelineAtEnd(1, 0)).toBe(true);
  });

  it('plays at a pace a person can follow', () => {
    expect(PLAYBACK_INTERVAL_MS).toBeGreaterThan(60);
    expect(PLAYBACK_INTERVAL_MS).toBeLessThan(400);
  });
});
