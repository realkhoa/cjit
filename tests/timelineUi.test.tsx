// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Monaco cannot run under jsdom; the Watch pane and the playback hook are what
// this suite is about, so only the editor and the console are replaced.
vi.mock('@/ui/EditorPane', () => ({ EditorPane: () => <div data-pane-marker="editor" /> }));
vi.mock('@/ui/ConsolePanel', () => ({ ConsolePanel: () => <div data-pane-marker="console" /> }));

import { App } from '@/App';
import { emptyWatch } from '@/engine/types';
import type { VarNode, WatchHistoryEntry } from '@/engine/types';
import { useAppStore } from '@/state/store';
import { PLAYBACK_INTERVAL_MS } from '@/ui/timeline';

/**
 * The transport controls, driven the way a user drives them.
 *
 * The Watch pane is rendered on its own (no Monaco), and the recorded history is
 * installed directly, so what is tested is the stepping itself.
 */

function variable(name: string, value: string): VarNode {
  return { name, type: 'int', value, scope: 'main', changed: false };
}

function history(count: number): WatchHistoryEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'assignment' as const,
    step: index * 2,
    line: index + 1,
    scope: 'main',
    name: 'i',
    vars: [variable('i', `${index}`)],
  }));
}

function installHistory(count: number): void {
  const snapshot = emptyWatch({ status: 'ok', detail: 'test' });
  useAppStore.setState({
    watch: { ...snapshot, history: history(count), historyLength: count },
    watchMode: 'timeline',
    timelineIndex: 0,
    timelinePlaying: false,
  });
}

beforeEach(() => {
  installHistory(5);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAppStore.setState({ timelinePlaying: false, watchMode: 'cursor', timelineIndex: 0 });
});

describe('timeline transport', () => {
  it('steps forward and back', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Step forward' }));
    expect(useAppStore.getState().timelineIndex).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Step forward' }));
    expect(useAppStore.getState().timelineIndex).toBe(2);

    fireEvent.click(screen.getByRole('button', { name: 'Step back' }));
    expect(useAppStore.getState().timelineIndex).toBe(1);
  });

  it('jumps to the first and last moment', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Last moment' }));
    expect(useAppStore.getState().timelineIndex).toBe(4);

    fireEvent.click(screen.getByRole('button', { name: 'First moment' }));
    expect(useAppStore.getState().timelineIndex).toBe(0);
  });

  it('shows where in the recording it is', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Step forward' }));
    expect(screen.getByText('2/5')).toBeTruthy();
  });

  it('plays through the recording on its own and stops at the end', () => {
    vi.useFakeTimers();
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Play timeline' }));
    expect(useAppStore.getState().timelinePlaying).toBe(true);

    // Four steps take it from moment 1 to moment 5.
    vi.advanceTimersByTime(PLAYBACK_INTERVAL_MS * 4);
    expect(useAppStore.getState().timelineIndex).toBe(4);

    // The next tick finds the end and turns playback off rather than wrapping.
    vi.advanceTimersByTime(PLAYBACK_INTERVAL_MS);
    expect(useAppStore.getState().timelinePlaying).toBe(false);
    expect(useAppStore.getState().timelineIndex).toBe(4);
  });

  it('pauses when asked', () => {
    vi.useFakeTimers();
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Play timeline' }));
    vi.advanceTimersByTime(PLAYBACK_INTERVAL_MS);
    const afterOneStep = useAppStore.getState().timelineIndex;

    fireEvent.click(screen.getByRole('button', { name: 'Pause playback' }));
    expect(useAppStore.getState().timelinePlaying).toBe(false);

    vi.advanceTimersByTime(PLAYBACK_INTERVAL_MS * 3);
    expect(useAppStore.getState().timelineIndex).toBe(afterOneStep);
  });

  it('disables the controls when nothing was recorded', () => {
    installHistory(0);
    render(<App />);

    for (const name of ['Step forward', 'Step back', 'Play timeline', 'First moment', 'Last moment']) {
      expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
    }
    expect(screen.getByText('no history')).toBeTruthy();
  });

  it('enters the timeline from the start when stepping forward from cursor mode', () => {
    // Nothing is rendered here: this is the store behaviour the keys rely on.
    useAppStore.setState({ watchMode: 'cursor', timelineIndex: 3 });

    useAppStore.getState().stepTimeline(1);

    expect(useAppStore.getState().watchMode).toBe('timeline');
    expect(useAppStore.getState().timelineIndex).toBe(1);
  });

  it('enters the timeline at the end when stepping back from cursor mode', () => {
    useAppStore.setState({ watchMode: 'cursor', timelineIndex: 0 });

    useAppStore.getState().stepTimeline(-1);

    expect(useAppStore.getState().watchMode).toBe('timeline');
    expect(useAppStore.getState().timelineIndex).toBe(3);
  });

  it('replays from the start when play is pressed at the end', () => {
    useAppStore.setState({ timelineIndex: 4, timelinePlaying: false });

    useAppStore.getState().toggleTimelinePlayback();

    expect(useAppStore.getState().timelinePlaying).toBe(true);
    expect(useAppStore.getState().timelineIndex).toBe(0);
  });
});
