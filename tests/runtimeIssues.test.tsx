// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { emptyWatch } from '@/engine/types';
import type { SafetyEvent } from '@/engine/types';
import { useAppStore } from '@/state/store';
import { ConsolePanel } from '@/ui/ConsolePanel';

/**
 * The "Runtime" tab, which is where the collected safety events are read.
 */

function install(safety: readonly SafetyEvent[]): void {
  useAppStore.setState({
    watch: { ...emptyWatch({ status: 'ok' }), engineLabel: 'Fast engine', safety },
    consoleTab: 'runtime',
  });
}

beforeEach(() => {
  install([]);
});

afterEach(() => {
  cleanup();
});

describe('runtime issues tab', () => {
  it('lists each event with its kind and line', () => {
    install([
      { kind: 'uninitialized-read', severity: 'warning', message: "read of uninitialized variable 'x'", line: 4 },
      { kind: 'division-by-zero', severity: 'error', message: 'division by zero', line: 9 },
      { kind: 'leak', severity: 'info', message: '8 byte cấp phát chưa được free', line: 0 },
    ]);
    render(<ConsolePanel />);

    expect(screen.getByText(/uninitialized · Ln 4/)).toBeTruthy();
    expect(screen.getByText(/divide by zero · Ln 9/)).toBeTruthy();
    // An event with no line of its own says so rather than pointing at line 1.
    expect(screen.getByText(/not freed · no line/)).toBeTruthy();
    expect(screen.getByText(/read of uninitialized variable 'x'/)).toBeTruthy();
  });

  it('badges the tab when there is something to look at', () => {
    install([{ kind: 'leak', severity: 'info', message: 'leaked', line: 0 }]);
    render(<ConsolePanel />);

    const tab = screen.getByRole('button', { name: /Runtime/ });
    expect(tab.textContent).toContain('1');
  });

  it('explains itself when the engine checks nothing, and when nothing went wrong', () => {
    // clang only builds and runs: saying so avoids the impression that a clean
    // report means the program was checked.
    useAppStore.setState({
      watch: { ...emptyWatch({ status: 'ok' }), engineLabel: 'Clang + LLD (WebAssembly)', safety: [] },
      consoleTab: 'runtime',
    });
    const { unmount } = render(<ConsolePanel />);
    expect(screen.getByText(/không kiểm tra an toàn lúc chạy/)).toBeTruthy();
    unmount();

    install([]);
    render(<ConsolePanel />);
    expect(screen.getByText(/Không thấy vấn đề runtime nào/)).toBeTruthy();
  });

  it('switches to the tab from Output', () => {
    useAppStore.setState({ consoleTab: 'output' });
    render(<ConsolePanel />);

    fireEvent.click(screen.getByRole('button', { name: /Runtime/ }));
    expect(useAppStore.getState().consoleTab).toBe('runtime');
  });
});
