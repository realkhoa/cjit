import { describe, expect, it } from 'vitest';
import {
  MAX_BOTTOM_PERCENT,
  MAX_RIGHT_PERCENT,
  MIN_BOTTOM_PERCENT,
  MIN_RIGHT_PERCENT,
  clamp,
  percentFromDelta,
} from '@/util/layout';

describe('clamp', () => {
  it('passes through values inside the range', () => {
    expect(clamp(35, 20, 70)).toBe(35);
  });

  it('clamps to both bounds', () => {
    expect(clamp(5, 20, 70)).toBe(20);
    expect(clamp(95, 20, 70)).toBe(70);
  });

  it('falls back to the lower bound for NaN instead of producing NaN layout', () => {
    expect(clamp(Number.NaN, 20, 70)).toBe(20);
  });
});

describe('percentFromDelta', () => {
  it('converts pointer pixels into percentage of the container', () => {
    // 100px of a 1000px wide container is 10%.
    expect(percentFromDelta(30, 100, 1000, MIN_RIGHT_PERCENT, MAX_RIGHT_PERCENT)).toBe(40);
    expect(percentFromDelta(30, -100, 1000, MIN_RIGHT_PERCENT, MAX_RIGHT_PERCENT)).toBe(20);
  });

  it('clamps so a pane can never be dragged out of existence', () => {
    expect(percentFromDelta(65, 500, 1000, MIN_RIGHT_PERCENT, MAX_RIGHT_PERCENT)).toBe(
      MAX_RIGHT_PERCENT,
    );
    expect(percentFromDelta(25, -500, 1000, MIN_RIGHT_PERCENT, MAX_RIGHT_PERCENT)).toBe(
      MIN_RIGHT_PERCENT,
    );
  });

  it('keeps the current value when the container has no measurable extent', () => {
    expect(percentFromDelta(42, 100, 0, MIN_BOTTOM_PERCENT, MAX_BOTTOM_PERCENT)).toBe(42);
    expect(percentFromDelta(42, 100, Number.NaN, MIN_BOTTOM_PERCENT, MAX_BOTTOM_PERCENT)).toBe(42);
  });
});
