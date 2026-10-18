// @vitest-environment jsdom
/**
 * @file Tests for the UnifiedHeader component.
 * @details Verifies brand identity, execution controls, compiler engine switcher,
 * stop button, and the overflow action menu behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UnifiedHeader } from '@/ui/UnifiedHeader';
import { registerDefaultEngines } from '@/engine/bootstrap';
import { useAppStore } from '@/state/store';

beforeEach(() => {
  registerDefaultEngines();
  useAppStore.setState({
    path: 'main.cpp',
    runState: 'idle',
    engineId: 'fast',
    artifactsReady: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('UnifiedHeader', () => {
  it('renders brand name, logo and active file path', () => {
    render(<UnifiedHeader />);
    expect(screen.getByText('C+')).toBeTruthy();
    expect(screen.getByText('C/C++ Studio')).toBeTruthy();
    expect(screen.getByText(/main\.cpp/)).toBeTruthy();
  });

  it('renders Run button with F5 badge and triggers run', () => {
    const runMock = vi.fn();
    useAppStore.setState({ run: runMock });
    render(<UnifiedHeader />);

    const runBtn = screen.getByRole('button', { name: /Run/i });
    expect(runBtn).toBeTruthy();
    expect(screen.getByText('F5')).toBeTruthy();
    fireEvent.click(runBtn);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('allows switching compiler engine via selector', () => {
    render(<UnifiedHeader />);
    const select = screen.getByLabelText(/Compiler engine/i) as HTMLSelectElement;
    expect(select.value).toBe('fast');

    fireEvent.change(select, { target: { value: 'clang-wasm' } });
    expect(useAppStore.getState().engineId).toBe('clang-wasm');
  });

  it('enables Stop button when running and triggers stop', () => {
    const stopMock = vi.fn();
    useAppStore.setState({ runState: 'running', stop: stopMock });
    render(<UnifiedHeader />);

    const stopBtn = screen.getByRole('button', { name: /Stop/i });
    expect(stopBtn.getAttribute('disabled')).toBeNull();
    fireEvent.click(stopBtn);
    expect(stopMock).toHaveBeenCalledTimes(1);
  });

  it('toggles overflow action menu and handles actions', () => {
    const clearMock = vi.fn();
    useAppStore.setState({ clearOutput: clearMock });
    render(<UnifiedHeader />);

    const menuBtn = screen.getByRole('button', { name: /More actions/i });
    expect(screen.queryByText(/Clear console/i)).toBeNull();

    fireEvent.click(menuBtn);
    expect(screen.getByText(/Clear console/i)).toBeTruthy();

    fireEvent.click(screen.getByText(/Clear console/i));
    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Clear console/i)).toBeNull();
  });
});
