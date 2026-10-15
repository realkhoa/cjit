// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * Layout composition tests for the narrow (phone) layout.
 *
 * Monaco cannot run under jsdom, and this suite is about *which pane is on screen*
 * rather than about the editor, so the heavy panes are replaced by markers. The
 * shell, the tab bar, the Explorer and the toolbar are the real components.
 */
vi.mock('@/ui/EditorPane', () => ({ EditorPane: () => <div data-pane-marker="editor" /> }));
vi.mock('@/ui/WatchPane', () => ({ WatchPane: () => <div data-pane-marker="watch" /> }));
vi.mock('@/ui/ConsolePanel', () => ({ ConsolePanel: () => <div data-pane-marker="console" /> }));

import { App } from '@/App';
import { registerDefaultEngines } from '@/engine/bootstrap';
import { useAppStore } from '@/state/store';

function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });

  // Only the width query this app uses is emulated; that is what `useIsMobile`
  // subscribes to.
  window.matchMedia = ((query: string) => {
    const limit = /max-width:\s*(\d+)px/.exec(query);
    const matches = limit ? width <= Number(limit[1]) : false;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

/** `data-active` of each pane, as the CSS sees it. */
function paneState(): Record<string, string | null> {
  const state: Record<string, string | null> = {};
  for (const pane of ['files', 'code', 'watch', 'console']) {
    state[pane] =
      document.querySelector(`[data-pane="${pane}"]`)?.getAttribute('data-active') ?? null;
  }
  return state;
}

beforeEach(() => {
  registerDefaultEngines();
  useAppStore.getState().setMobilePane('code');
});

afterEach(() => {
  cleanup();
});

describe('narrow layout', () => {
  it('shows one pane at a time behind a tab bar', () => {
    setViewport(390);
    render(<App />);

    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Files',
      'Code',
      'Watch',
      'Output',
    ]);

    expect(paneState()).toEqual({
      files: 'false',
      code: 'true',
      watch: 'false',
      console: 'false',
    });

    // No splitters: there is nothing to drag when one pane owns the screen.
    expect(screen.queryAllByRole('separator')).toHaveLength(0);
  });

  it('switches the visible pane when a tab is tapped', () => {
    setViewport(390);
    render(<App />);

    fireEvent.click(screen.getByRole('tab', { name: 'Watch' }));
    expect(paneState()).toEqual({
      files: 'false',
      code: 'false',
      watch: 'true',
      console: 'false',
    });
    expect(useAppStore.getState().mobilePane).toBe('watch');

    fireEvent.click(screen.getByRole('tab', { name: 'Output' }));
    expect(paneState().console).toBe('true');
    expect(paneState().watch).toBe('false');
  });

  it('keeps the editor mounted while another pane is displayed', () => {
    setViewport(390);
    render(<App />);

    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));

    // Staying in the tree is exactly what preserves Monaco's undo history and
    // scroll position; only CSS hides it.
    expect(document.querySelector('[data-pane="code"] [data-pane-marker="editor"]')).toBeTruthy();
    expect(paneState().files).toBe('true');
  });

  it('switches at the breakpoint and not before', () => {
    setViewport(881);
    const { unmount } = render(<App />);
    expect(screen.queryByRole('tablist')).toBeNull();
    unmount();

    setViewport(880);
    render(<App />);
    expect(screen.getByRole('tablist')).toBeTruthy();
  });
});

describe('wide layout', () => {
  it('keeps the three columns, the splitters and no tab bar', () => {
    setViewport(1440);
    render(<App />);

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getAllByRole('separator')).toHaveLength(3);
    // The narrow layout marks panes; the wide one does not need to.
    expect(document.querySelector('[data-pane]')).toBeNull();
    expect(screen.getByText('Explorer')).toBeTruthy();
    expect(document.querySelector('[data-pane-marker="editor"]')).toBeTruthy();
  });
});

describe('touch reachability', () => {
  it('offers rename on a touch screen and cancels cleanly', () => {
    setViewport(390);
    render(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));

    // These controls were hover-only, which made them unreachable on a phone.
    // The default workspace is a project, so there is one per file: the first is
    // the open one.
    fireEvent.click(screen.getAllByRole('button', { name: /^Rename / })[0] as HTMLElement);

    const input = screen.getByRole('textbox', { name: 'File name' });
    expect(input).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'File name' })).toBeNull();
  });

  it('keeps the CSS that reveals those controls without hover', () => {
    // A source guard rather than a rendering test: jsdom does not evaluate
    // stylesheets, and this is precisely the rule a tidy-up would delete.
    const css = readFileSync('src/ui/theme/app.css', 'utf8');
    expect(css).toMatch(/@media \(hover: none\)[\s\S]{0,240}\.explorer__actions/);
  });

  it('keeps safe-area insets paired with viewport-fit=cover', () => {
    const css = readFileSync('src/ui/theme/app.css', 'utf8');
    const html = readFileSync('index.html', 'utf8');

    // env(safe-area-inset-*) reports 0 without viewport-fit=cover, which would
    // silently put the tab bar under a home indicator.
    expect(css).toContain('env(safe-area-inset-bottom');
    expect(html).toContain('viewport-fit=cover');
  });

  it('keeps the touch behaviours a phone needs', () => {
    const css = readFileSync('src/ui/theme/app.css', 'utf8');

    // Without `overscroll-behavior: contain`, scrolling a pane can trigger the
    // browser's pull-to-refresh and reload the page.
    expect(css).toContain('overscroll-behavior: contain');
    // Double-tap zoom would fight the rename gesture.
    expect(css).toContain('touch-action: manipulation');
    expect(css).toContain('-webkit-tap-highlight-color: transparent');
  });
});
