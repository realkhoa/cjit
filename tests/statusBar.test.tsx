// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatusBar } from '@/ui/StatusBar';
import { useAppStore } from '@/state/store';

beforeEach(() => {
  useAppStore.setState({
    runState: 'idle',
    analysisState: 'idle',
    cursor: { line: 1, column: 1, selected: 0 },
    language: 'cpp',
    trash: [],
    storageWarning: null,
  });
});

afterEach(() => {
  cleanup();
});

describe('streamlined StatusBar', () => {
  it('does not display static non-actionable labels (Spaces, UTF-8, LF)', () => {
    render(<StatusBar />);
    expect(screen.queryByText(/Spaces: 4/i)).toBeNull();
    expect(screen.queryByText(/UTF-8/i)).toBeNull();
    expect(screen.queryByText(/LF/i)).toBeNull();
  });

  it('renders dynamic cursor, language, and status indicators', () => {
    useAppStore.setState({
      cursor: { line: 42, column: 7, selected: 5 },
      language: 'cpp',
    });
    render(<StatusBar />);

    expect(screen.getByText(/Ln 42, Col 7/)).toBeTruthy();
    expect(screen.getByText(/Sel 5/)).toBeTruthy();
    expect(screen.getByText('C++')).toBeTruthy();
  });
});
