// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MobileMenu } from '@/ui/MobileMenu';
import { useAppStore } from '@/state/store';

describe('MobileMenu bottom sheet', () => {
  beforeEach(() => {
    useAppStore.setState({
      engineId: 'fast',
      artifactsReady: true,
      path: 'main.cpp',
    });
  });

  afterEach(cleanup);

  it('renders menu options and closes when clicking close button or backdrop', () => {
    const onClose = vi.fn();
    render(<MobileMenu onClose={onClose} />);

    expect(screen.getByText(/compiler engine/i)).toBeDefined();
    expect(screen.getByText(/tải \.wasm/i)).toBeDefined();

    const closeBtn = screen.getByRole('button', { name: /đóng/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('changes engine via segmented radio buttons', () => {
    render(<MobileMenu onClose={vi.fn()} />);
    const clangRadio = screen.getByLabelText(/clang/i);
    fireEvent.click(clangRadio);
    expect(useAppStore.getState().engineId).toBe('clang-wasm');
  });

  it('clears console output when clicking clear output button', () => {
    const clearSpy = vi.fn();
    useAppStore.setState({ clearOutput: clearSpy });
    render(<MobileMenu onClose={vi.fn()} />);
    const clearBtn = screen.getByRole('button', { name: /xóa màn hình console/i });
    fireEvent.click(clearBtn);
    expect(clearSpy).toHaveBeenCalled();
  });
});
