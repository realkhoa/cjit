import { describe, expect, it } from 'vitest';
import { emptyWatch } from '@/engine/types';
import type { VarNode, WatchHistoryEntry, WatchSnapshot } from '@/engine/types';
import { markChanged, selectWatchView } from '@/ui/watchSelect';

function variable(name: string, value: string): VarNode {
  return { name, type: 'int', value, scope: 'main', changed: false };
}

function historyEntry(step: number, line: number, vars: VarNode[]): WatchHistoryEntry {
  return { kind: 'assignment', step, line, scope: 'main', name: 'x', vars };
}

function snapshot(patch: Partial<WatchSnapshot> = {}): WatchSnapshot {
  return emptyWatch({ status: 'ok', vars: [variable('final', '99')], ...patch });
}

describe('markChanged', () => {
  it('flags variables that changed value', () => {
    const result = markChanged([variable('a', '2'), variable('b', '1')], [
      variable('a', '1'),
      variable('b', '1'),
    ]);

    expect(result.changedCount).toBe(1);
    expect(result.vars.find((item) => item.name === 'a')?.changed).toBe(true);
    expect(result.vars.find((item) => item.name === 'b')?.changed).toBe(false);
  });

  it('counts a variable that did not exist before as changed', () => {
    const result = markChanged([variable('fresh', '5')], [variable('older', '1')]);
    expect(result.changedCount).toBe(1);
    expect(result.vars[0]?.changed).toBe(true);
  });

  it('marks nothing when there is no previous moment', () => {
    const result = markChanged([variable('a', '1')], undefined);
    expect(result.changedCount).toBe(0);
    expect(result.vars[0]?.changed).toBe(false);
  });
});

describe('selectWatchView: cursor mode', () => {
  it('shows the state of the line the cursor is on', () => {
    const watch = snapshot({
      lineStates: [
        { line: 3, vars: [variable('i', '1')] },
        { line: 5, vars: [variable('i', '2')] },
      ],
    });

    const view = selectWatchView(watch, { mode: 'cursor', cursorLine: 5, historyIndex: 0 });
    expect(view.exact).toBe(true);
    expect(view.line).toBe(5);
    expect(view.vars.map((item) => item.value)).toEqual(['2']);
    // i went 1 -> 2 between the two lines.
    expect(view.changedCount).toBe(1);
  });

  it('falls back to the nearest earlier line when the cursor line never ran', () => {
    const watch = snapshot({
      lineStates: [
        { line: 3, vars: [variable('i', '1')] },
        { line: 5, vars: [variable('i', '2')] },
      ],
    });

    const view = selectWatchView(watch, { mode: 'cursor', cursorLine: 4, historyIndex: 0 });
    expect(view.exact).toBe(false);
    expect(view.line).toBe(3);
    expect(view.label).toContain('line 4 never ran');
  });

  it('falls back to the first recorded line when the cursor is before all of them', () => {
    const watch = snapshot({ lineStates: [{ line: 8, vars: [variable('i', '1')] }] });

    const view = selectWatchView(watch, { mode: 'cursor', cursorLine: 2, historyIndex: 0 });
    expect(view.line).toBe(8);
    expect(view.label).toContain('has not run yet');
  });

  it('degrades to the final values when no line states were recorded', () => {
    const watch = snapshot();

    const view = selectWatchView(watch, { mode: 'cursor', cursorLine: 4, historyIndex: 0 });
    expect(view.line).toBeNull();
    expect(view.vars.map((item) => item.name)).toEqual(['final']);
  });
});

describe('selectWatchView: timeline mode', () => {
  const watch = snapshot({
    history: [
      historyEntry(10, 2, [variable('a', '1')]),
      historyEntry(20, 3, [variable('a', '2')]),
      historyEntry(30, 4, [variable('a', '5')]),
    ],
  });

  it('shows the state at the scrubbed step', () => {
    const view = selectWatchView(watch, { mode: 'timeline', cursorLine: 1, historyIndex: 1 });

    expect(view.line).toBe(3);
    expect(view.vars.map((item) => item.value)).toEqual(['2']);
    expect(view.label).toContain('step 20');
    expect(view.changedCount).toBe(1); // 1 -> 2
  });

  it('reports the first step without a previous moment', () => {
    const view = selectWatchView(watch, { mode: 'timeline', cursorLine: 1, historyIndex: 0 });
    expect(view.vars.map((item) => item.value)).toEqual(['1']);
    expect(view.changedCount).toBe(0);
  });

  it('clamps an out-of-range index instead of crashing', () => {
    const view = selectWatchView(watch, { mode: 'timeline', cursorLine: 1, historyIndex: 99 });
    expect(view.line).toBe(4);
    expect(view.vars.map((item) => item.value)).toEqual(['5']);
  });

  it('falls back when the engine recorded no history', () => {
    const view = selectWatchView(snapshot(), { mode: 'timeline', cursorLine: 1, historyIndex: 3 });
    expect(view.line).toBeNull();
    expect(view.label).toContain('no timeline');
  });

  it('labels a loop iteration by its loop and iteration number', () => {
    const watch = snapshot({
      history: [
        {
          kind: 'loop-iteration',
          step: 20,
          line: 3,
          scope: 'main',
          name: '',
          iteration: 2,
          depth: 1,
          lines: [3, 4],
          vars: [variable('i', '1')],
        },
      ],
    });

    const view = selectWatchView(watch, { mode: 'timeline', cursorLine: 1, historyIndex: 0 });
    expect(view.label).toContain('iteration 2');
    expect(view.label).toContain('line 3');
    expect(view.vars.map((item) => item.value)).toEqual(['1']);
  });
});

describe('selectWatchView: final mode', () => {
  it('shows the final state and what changed since the last recorded step', () => {
    const watch = snapshot({ history: [historyEntry(10, 2, [variable('final', '1')])] });

    const view = selectWatchView(watch, { mode: 'final', cursorLine: 3, historyIndex: 0 });
    expect(view.line).toBeNull();
    expect(view.vars.map((item) => item.name)).toEqual(['final']);
    expect(view.changedCount).toBe(1);
    expect(view.label).toContain('final state');
  });
});
