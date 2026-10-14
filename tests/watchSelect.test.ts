import { describe, expect, it } from 'vitest';
import { emptyWatch } from '@/engine/types';
import type { VarNode, WatchSnapshot } from '@/engine/types';
import { selectWatchView } from '@/ui/watchSelect';

function variable(name: string, value: string): VarNode {
  return { name, type: 'int', value, scope: 'main', changed: false };
}

function snapshot(lineStates: WatchSnapshot['lineStates']): WatchSnapshot {
  return emptyWatch({
    status: 'ok',
    vars: [variable('final', '99')],
    lineStates,
  });
}

describe('selectWatchView', () => {
  it('shows the state of the line the cursor is on', () => {
    const watch = snapshot([
      { line: 3, vars: [variable('i', '1')] },
      { line: 5, vars: [variable('i', '2')] },
    ]);

    const view = selectWatchView(watch, 5, 'cursor');
    expect(view.exact).toBe(true);
    expect(view.line).toBe(5);
    expect(view.vars.map((item) => item.value)).toEqual(['2']);
    expect(view.label).toContain('line 5');
  });

  it('falls back to the nearest earlier line when the cursor line never ran', () => {
    const watch = snapshot([
      { line: 3, vars: [variable('i', '1')] },
      { line: 5, vars: [variable('i', '2')] },
    ]);

    const view = selectWatchView(watch, 4, 'cursor');
    expect(view.exact).toBe(false);
    expect(view.line).toBe(3);
    expect(view.label).toContain('line 4 never ran');
  });

  it('falls back to the first recorded line when the cursor is before all of them', () => {
    const watch = snapshot([{ line: 8, vars: [variable('i', '1')] }]);

    const view = selectWatchView(watch, 2, 'cursor');
    expect(view.line).toBe(8);
    expect(view.label).toContain('has not run yet');
  });

  it('shows the final state in final mode', () => {
    const watch = snapshot([{ line: 3, vars: [variable('i', '1')] }]);

    const view = selectWatchView(watch, 3, 'final');
    expect(view.line).toBeNull();
    expect(view.vars.map((item) => item.name)).toEqual(['final']);
    expect(view.label).toContain('final state');
  });

  it('degrades to the final values when the engine recorded no line states', () => {
    const watch = snapshot([]);

    const view = selectWatchView(watch, 4, 'cursor');
    expect(view.line).toBeNull();
    expect(view.vars.map((item) => item.name)).toEqual(['final']);
  });
});
