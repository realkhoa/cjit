// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MobileHeader } from '@/ui/MobileHeader';
import { useAppStore } from '@/state/store';

describe('MobileHeader component', () => {
  beforeEach(() => {
    useAppStore.setState({
      path: 'src/main.cpp',
      engineId: 'fast',
      runState: 'idle',
    });
  });

  afterEach(cleanup);

  it('renders active file name and engine badge', () => {
    const onOpenMenu = vi.fn();
    render(<MobileHeader onOpenMenu={onOpenMenu} />);
    expect(screen.getByText('main.cpp')).toBeDefined();
    expect(screen.getByText('Fast')).toBeDefined();
  });

  it('toggles engine when clicking the engine badge', () => {
    const onOpenMenu = vi.fn();
    render(<MobileHeader onOpenMenu={onOpenMenu} />);
    const badge = screen.getByText('Fast');
    fireEvent.click(badge);
    expect(useAppStore.getState().engineId).toBe('clang-wasm');
  });

  it('triggers run when clicking the Run button in idle state', () => {
    const runSpy = vi.fn();
    useAppStore.setState({ run: runSpy });
    render(<MobileHeader onOpenMenu={vi.fn()} />);
    const runBtn = screen.getByRole('button', { name: /run/i });
    fireEvent.click(runBtn);
    expect(runSpy).toHaveBeenCalled();
  });

  it('renders Stop button when running and triggers stop', () => {
    const stopSpy = vi.fn();
    useAppStore.setState({ runState: 'running', stop: stopSpy });
    render(<MobileHeader onOpenMenu={vi.fn()} />);
    const stopBtn = screen.getByRole('button', { name: /stop/i });
    fireEvent.click(stopBtn);
    expect(stopSpy).toHaveBeenCalled();
  });

  it('triggers onOpenMenu when clicking the overflow button', () => {
    const onOpenMenu = vi.fn();
    render(<MobileHeader onOpenMenu={onOpenMenu} />);
    const menuBtn = screen.getByRole('button', { name: /more actions/i });
    fireEvent.click(menuBtn);
    expect(onOpenMenu).toHaveBeenCalled();
  });
});
