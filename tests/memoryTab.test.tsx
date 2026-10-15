// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { emptyMemoryView, emptyWatch } from '@/engine/types';
import type { MemoryView } from '@/engine/types';
import { useAppStore } from '@/state/store';
import { ConsolePanel } from '@/ui/ConsolePanel';

/**
 * The Memory tab: the picture a variables table cannot draw.
 */

function install(memory: MemoryView, engineLabel = 'Fast engine'): void {
  useAppStore.setState({
    watch: { ...emptyWatch({ status: 'ok' }), engineLabel, memory },
    consoleTab: 'memory',
  });
}

beforeEach(() => {
  install(emptyMemoryView());
});

afterEach(() => {
  cleanup();
});

describe('memory tab', () => {
  it('draws a linked list node by node', () => {
    install({
      blocks: [],
      truncated: false,
      chains: [
        {
          name: 'head',
          end: 'null',
          nodes: [
            { address: 0x1000, fields: [{ name: 'value', value: '1' }, { name: 'next', value: '0x1010' }] },
            { address: 0x1010, fields: [{ name: 'value', value: '2' }, { name: 'next', value: 'NULL' }] },
          ],
        },
      ],
    });

    render(<ConsolePanel />);

    expect(screen.getByText(/head → 2 node → NULL/)).toBeTruthy();
    expect(screen.getByText(/value = 1, next = 0x1010/)).toBeTruthy();
    expect(screen.getByText(/value = 2, next = NULL/)).toBeTruthy();
  });

  it('says a cycle is a cycle rather than pretending the list ended', () => {
    install({
      blocks: [],
      truncated: false,
      chains: [
        {
          name: 'head',
          end: 'cycle',
          nodes: [{ address: 0x1000, fields: [{ name: 'next', value: '0x1000' }] }],
        },
      ],
    });

    render(<ConsolePanel />);
    // Both the summary line and the node's end marker say it, on purpose.
    expect(screen.getAllByText(/quay lại/).length).toBeGreaterThan(0);
  });

  it('dumps allocated blocks as hex and ASCII', () => {
    install({
      chains: [],
      truncated: false,
      blocks: [
        { address: 0x1000, size: 4, bytes: [0x68, 0x69, 0x00, 0xff], truncated: false },
      ],
    });

    render(<ConsolePanel />);
    expect(screen.getByText(/68 69 00 ff/)).toBeTruthy();
    expect(screen.getByText(/hi\./)).toBeTruthy();
    expect(screen.getByText(/4 byte/)).toBeTruthy();
  });

  it('explains itself for the engine that has no memory model, and for an idle program', () => {
    install(emptyMemoryView(), 'Clang + LLD (WebAssembly)');
    const { unmount } = render(<ConsolePanel />);
    expect(screen.getByText(/không mô hình hoá memory/)).toBeTruthy();
    unmount();

    install(emptyMemoryView());
    render(<ConsolePanel />);
    expect(screen.getByText(/chưa cấp phát gì/)).toBeTruthy();
  });

  it('switches to the tab', () => {
    useAppStore.setState({ consoleTab: 'output' });
    render(<ConsolePanel />);

    fireEvent.click(screen.getByRole('button', { name: /Memory/ }));
    expect(useAppStore.getState().consoleTab).toBe('memory');
  });
});
