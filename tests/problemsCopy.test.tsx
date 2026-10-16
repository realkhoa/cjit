// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { emptyWatch } from '@/engine/types';
import type { Diagnostic } from '@/engine/types';
import { useAppStore } from '@/state/store';
import {
  ConsolePanel,
  formatDiagnosticForClipboard,
  formatDiagnosticsForClipboard,
} from '@/ui/ConsolePanel';

describe('formatDiagnosticsForClipboard helper', () => {
  const sampleDiagnostics: Diagnostic[] = [
    {
      source: 'main.cpp',
      startLine: 10,
      startColumn: 5,
      endLine: 10,
      endColumn: 12,
      severity: 'error',
      message: "expected ';' after expression",
    },
    {
      source: 'main.cpp',
      startLine: 25,
      startColumn: 1,
      endLine: 25,
      endColumn: 8,
      severity: 'warning',
      message: 'unused variable "x"',
    },
  ];

  it('formats a single diagnostic into standard compiler output format', () => {
    const formatted = formatDiagnosticForClipboard(sampleDiagnostics[0]!);
    expect(formatted).toBe("main.cpp:10:5: error: expected ';' after expression");
  });

  it('formats multiple diagnostics separated by newlines', () => {
    const formatted = formatDiagnosticsForClipboard(sampleDiagnostics);
    expect(formatted).toBe(
      "main.cpp:10:5: error: expected ';' after expression\nmain.cpp:25:1: warning: unused variable \"x\"",
    );
  });
});

describe('Problems Tab Copy Button UI', () => {
  const mockDiagnostics: Diagnostic[] = [
    {
      source: 'main.cpp',
      startLine: 42,
      startColumn: 3,
      endLine: 42,
      endColumn: 10,
      severity: 'error',
      message: 'unknown type name "Foo"',
    },
    {
      source: 'main.cpp',
      startLine: 50,
      startColumn: 1,
      endLine: 50,
      endColumn: 5,
      severity: 'warning',
      message: 'comparison between signed and unsigned',
    },
  ];

  let writeTextMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    useAppStore.setState({
      watch: emptyWatch({ diagnostics: mockDiagnostics }),
      consoleTab: 'problems',
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders copy button when diagnostics exist in problems tab', () => {
    render(<ConsolePanel />);
    const copyBtns = screen.getAllByRole('button', { name: /sao chép/i });
    expect(copyBtns.length).toBeGreaterThan(0);
  });

  it('does not render copy all button when there are no diagnostics', () => {
    useAppStore.setState({
      watch: emptyWatch({ diagnostics: [] }),
      consoleTab: 'problems',
    });
    render(<ConsolePanel />);
    expect(screen.queryByRole('button', { name: /sao chép tất cả/i })).toBeNull();
  });

  it('copies all problems to clipboard when clicking copy all button', async () => {
    render(<ConsolePanel />);
    const copyBtn = screen.getByRole('button', { name: /sao chép tất cả/i });
    fireEvent.click(copyBtn);

    expect(writeTextMock).toHaveBeenCalledWith(
      "main.cpp:42:3: error: unknown type name \"Foo\"\nmain.cpp:50:1: warning: comparison between signed and unsigned",
    );

    await waitFor(() => {
      expect(screen.getAllByText(/đã sao chép/i).length).toBeGreaterThan(0);
    });
  });

  it('copies single problem to clipboard when clicking individual copy button', async () => {
    render(<ConsolePanel />);
    const singleCopyBtns = screen.getAllByRole('button', { name: /sao chép lỗi dòng/i });
    expect(singleCopyBtns.length).toBe(2);

    fireEvent.click(singleCopyBtns[0]!);
    expect(writeTextMock).toHaveBeenCalledWith('main.cpp:42:3: error: unknown type name "Foo"');
  });

  it('does not render raw textarea console keeping clean copy button layout', () => {
    render(<ConsolePanel />);
    expect(screen.queryByRole('textbox', { name: /văn bản chẩn đoán lỗi/i })).toBeNull();
  });

  it('renders copy button in console header tools and copies all problems when clicked', async () => {
    render(<ConsolePanel />);
    const headerCopyBtn = screen.getByRole('button', { name: /sao chép danh sách lỗi/i });
    expect(headerCopyBtn).toBeTruthy();

    fireEvent.click(headerCopyBtn);
    expect(writeTextMock).toHaveBeenCalledWith(
      "main.cpp:42:3: error: unknown type name \"Foo\"\nmain.cpp:50:1: warning: comparison between signed and unsigned",
    );

    await waitFor(() => {
      expect(screen.getByText(/đã chép/i)).toBeTruthy();
    });
  });
});
