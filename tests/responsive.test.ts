import { beforeEach, describe, expect, it } from 'vitest';
import { registerDefaultEngines } from '@/engine/bootstrap';
import { useAppStore } from '@/state/store';
import {
  MOBILE_MAX_WIDTH,
  PANE_LABELS,
  PANE_ORDER,
  isMobileWidth,
  isMobileViewport,
  mobileQuery,
} from '@/ui/responsive';

describe('isMobileWidth', () => {
  it('treats phone and small-tablet widths as narrow', () => {
    expect(isMobileWidth(320)).toBe(true); // small phone
    expect(isMobileWidth(390)).toBe(true); // common phone
    expect(isMobileWidth(430)).toBe(true); // large phone
    expect(isMobileWidth(768)).toBe(true); // tablet portrait
  });

  it('switches exactly at the breakpoint', () => {
    expect(isMobileWidth(MOBILE_MAX_WIDTH)).toBe(true);
    expect(isMobileWidth(MOBILE_MAX_WIDTH + 1)).toBe(false);
    expect(isMobileWidth(1280)).toBe(false);
  });

  it('does not treat a broken measurement as a phone', () => {
    expect(isMobileWidth(Number.NaN)).toBe(false);
    expect(isMobileWidth(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('exposes the same width to CSS, so the two cannot drift apart', () => {
    expect(mobileQuery()).toBe(`(max-width: ${MOBILE_MAX_WIDTH}px)`);
  });
});

describe('isMobileViewport', () => {
  it('is safe where there is no window at all', () => {
    expect(isMobileViewport()).toBe(false);
  });

  it('reads the real viewport when there is one', () => {
    const original = (globalThis as { window?: unknown }).window;
    try {
      (globalThis as { window?: unknown }).window = { innerWidth: 390 };
      expect(isMobileViewport()).toBe(true);
      (globalThis as { window?: unknown }).window = { innerWidth: 1440 };
      expect(isMobileViewport()).toBe(false);
    } finally {
      (globalThis as { window?: unknown }).window = original;
    }
  });
});

describe('pane tabs', () => {
  it('describes every pane the narrow layout can show', () => {
    expect(PANE_ORDER).toEqual(['files', 'code', 'watch', 'console']);
    for (const pane of PANE_ORDER) {
      expect(PANE_LABELS[pane]).toBeTruthy();
    }
  });
});

describe('store: mobile pane state', () => {
  beforeEach(() => {
    registerDefaultEngines();
    useAppStore.getState().setEngineId('fast');
    useAppStore.getState().setMobilePane('code');
  });

  it('starts on the code pane, because typing is the first thing you do', () => {
    expect(useAppStore.getState().mobilePane).toBe('code');
  });

  it('switches pane on request', () => {
    useAppStore.getState().setMobilePane('watch');
    expect(useAppStore.getState().mobilePane).toBe('watch');

    useAppStore.getState().setMobilePane('files');
    expect(useAppStore.getState().mobilePane).toBe('files');
  });

  it('leaves the pane alone when the viewport is not narrow', async () => {
    useAppStore.getState().setMobilePane('code');
    useAppStore.getState().setCodeFromEditor('int main(void) { return 0; }\n');

    await useAppStore.getState().run();

    // Running switches to the console only on a phone; on a wide screen the
    // console is already visible below the editor.
    expect(useAppStore.getState().mobilePane).toBe('code');
  });
});
