// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MobileTabs } from '@/ui/MobileTabs';
import { useAppStore } from '@/state/store';

describe('Enhanced MobileTabs', () => {
  beforeEach(() => {
    useAppStore.setState({
      mobilePane: 'code',
      analysisState: 'idle',
      runState: 'idle',
      watch: {
        variables: [],
        diagnostics: [],
        history: [],
        timelineIndex: 0,
        timelineCount: 0,
        iterations: {},
      },
    });
  });

  afterEach(cleanup);

  it('renders all 4 tabs with icons and text labels', () => {
    render(<MobileTabs />);
    expect(screen.getByRole('tab', { name: /files/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /code/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /watch/i })).toBeDefined();
    expect(screen.getByRole('tab', { name: /output/i })).toBeDefined();
  });

  it('highlights the active tab', () => {
    render(<MobileTabs />);
    const codeTab = screen.getByRole('tab', { name: /code/i });
    expect(codeTab.getAttribute('aria-selected')).toBe('true');
  });

  it('switches tab on click', () => {
    render(<MobileTabs />);
    const watchTab = screen.getByRole('tab', { name: /watch/i });
    fireEvent.click(watchTab);
    expect(useAppStore.getState().mobilePane).toBe('watch');
  });

  it('displays problem badge when diagnostics exist', () => {
    useAppStore.setState({
      watch: {
        variables: [],
        diagnostics: [{ line: 1, column: 1, message: 'syntax error', severity: 'error' }],
        history: [],
        timelineIndex: 0,
        timelineCount: 0,
        iterations: {},
      },
    });
    render(<MobileTabs />);
    expect(screen.getByTitle(/1 problem\(s\)/i)).toBeDefined();
  });
});
