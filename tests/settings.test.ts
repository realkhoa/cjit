import { describe, expect, it } from 'vitest';
import {
  MAX_DEBOUNCE_MS,
  MAX_FONT_SIZE,
  MIN_DEBOUNCE_MS,
  MIN_FONT_SIZE,
  clampDebounce,
  clampFontSize,
  defaultSettings,
  settingsFrom,
} from '@/state/settings';

describe('clampFontSize', () => {
  it('keeps values inside the range the editor can render', () => {
    expect(clampFontSize(13)).toBe(13);
    expect(clampFontSize(2)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(999)).toBe(MAX_FONT_SIZE);
    expect(clampFontSize(13.6)).toBe(14);
    expect(clampFontSize(Number.NaN)).toBe(13);
  });
});

describe('clampDebounce', () => {
  it('keeps the delay fast enough to feel live and slow enough to be useful', () => {
    expect(clampDebounce(1000)).toBe(1000);
    expect(clampDebounce(10)).toBe(MIN_DEBOUNCE_MS);
    expect(clampDebounce(999_999)).toBe(MAX_DEBOUNCE_MS);
    expect(clampDebounce(Number.NaN)).toBe(1000);
  });
});

describe('settingsFrom', () => {
  it('falls back to the defaults for a fresh browser', () => {
    expect(settingsFrom({})).toEqual(defaultSettings());
  });

  it('keeps valid stored values and clamps the rest', () => {
    const settings = settingsFrom({
      fontSize: 18,
      debounceMs: 50,
      minimap: false,
      inlineValues: false,
    });

    expect(settings.fontSize).toBe(18);
    expect(settings.debounceMs).toBe(MIN_DEBOUNCE_MS);
    expect(settings.minimap).toBe(false);
    expect(settings.inlineValues).toBe(false);
  });

  it('ignores values of the wrong type instead of trusting storage', () => {
    const settings = settingsFrom({
      fontSize: 'huge' as unknown as number,
      debounceMs: null as unknown as number,
      minimap: 'yes' as unknown as boolean,
    });

    expect(settings.fontSize).toBe(defaultSettings().fontSize);
    expect(settings.debounceMs).toBe(defaultSettings().debounceMs);
    expect(settings.minimap).toBe(defaultSettings().minimap);
  });
});
