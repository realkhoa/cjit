import { describe, expect, it } from 'vitest';
import type { VarNode, WatchHistoryEntry } from '@/engine/types';
import { buildIterationTable, hasIterations } from '@/ui/iterationTable';

function variable(name: string, value: string): VarNode {
  return { name, type: 'int', value, scope: 'main', changed: false };
}

function assignment(line: number, step: number, name: string, vars: VarNode[]): WatchHistoryEntry {
  return { kind: 'assignment', step, line, scope: 'main', name, vars };
}

function iteration(
  loopLine: number,
  iterationNumber: number,
  step: number,
  vars: VarNode[],
  extra: Partial<WatchHistoryEntry> = {},
): WatchHistoryEntry {
  return {
    kind: 'loop-iteration',
    step,
    line: loopLine,
    scope: 'main',
    name: '',
    iteration: iterationNumber,
    depth: 1,
    lines: [loopLine, loopLine + 1],
    vars,
    ...extra,
  };
}

describe('buildIterationTable: one row per loop pass', () => {
  it('lists every iteration of the loop that owns the caret line', () => {
    const history = [
      assignment(2, 5, 'total', [variable('total', '0')]),
      iteration(3, 1, 10, [variable('total', '0'), variable('i', '0')]),
      iteration(3, 2, 20, [variable('total', '0'), variable('i', '1')]),
      iteration(3, 3, 30, [variable('total', '1'), variable('i', '2')]),
    ];

    // Caret on the loop body line, not the header.
    const table = buildIterationTable(history, 4);

    expect(table.loopLine).toBe(3);
    expect(table.depth).toBe(1);
    expect(table.columns).toEqual(['total', 'i']);
    expect(table.rows.map((row) => row.iteration)).toEqual([1, 2, 3]);
    expect(table.rows.map((row) => row.globalIteration)).toEqual([1, 2, 3]);
    expect(table.globalTotal).toBe(3);
    expect(hasIterations(table)).toBe(true);
  });

  it('finds the loop when the caret is on the header line too', () => {
    const history = [iteration(3, 1, 10, [variable('i', '0')])];
    expect(buildIterationTable(history, 3).loopLine).toBe(3);
  });

  it('ignores assignment entries: the dialog is about loop passes', () => {
    const history = [
      assignment(4, 5, 'total', [variable('total', '9')]),
      assignment(4, 6, 'total', [variable('total', '10')]),
    ];

    const table = buildIterationTable(history, 4);
    expect(table.rows).toEqual([]);
    expect(table.loopLine).toBeNull();
    expect(hasIterations(table)).toBe(false);
  });

  it('picks the innermost loop when loops are nested', () => {
    const history = [
      iteration(3, 1, 10, [variable('i', '0')], { depth: 1, lines: [3, 4, 5] }),
      iteration(5, 1, 20, [variable('i', '0'), variable('j', '0')], { depth: 2, lines: [5, 6] }),
      iteration(5, 2, 30, [variable('i', '0'), variable('j', '1')], { depth: 2, lines: [5, 6] }),
      iteration(3, 2, 40, [variable('i', '1')], { depth: 1, lines: [3, 4, 5] }),
    ];

    // Line 6 is inside the inner loop only.
    const inner = buildIterationTable(history, 6);
    expect(inner.loopLine).toBe(5);
    expect(inner.depth).toBe(2);
    expect(inner.rows.map((row) => row.iteration)).toEqual([1, 2]);
  });

  it('keeps the position of each pass in the whole run', () => {
    const history = [
      iteration(3, 1, 10, [variable('a', '1')]),
      iteration(3, 2, 20, [variable('a', '2')]),
      iteration(9, 1, 30, [variable('b', '1')]),
      iteration(9, 2, 40, [variable('b', '2')]),
      iteration(3, 3, 50, [variable('a', '3')]),
    ];

    const table = buildIterationTable(history, 4);
    expect(table.globalTotal).toBe(5);
    // The third pass of this loop is the fifth loop pass of the run.
    expect(table.rows.map((row) => row.globalIteration)).toEqual([1, 2, 5]);
  });

  it('flags values that changed between iterations and pads new variables', () => {
    const history = [
      iteration(3, 1, 10, [variable('a', '1')]),
      iteration(3, 2, 20, [variable('a', '1'), variable('b', '2')]),
    ];

    const table = buildIterationTable(history, 4);
    expect(table.columns).toEqual(['a', 'b']);
    expect(table.rows[0]?.cells.map((cell) => cell.value)).toEqual(['1', '']);
    expect(table.rows[1]?.cells[1]?.changed).toBe(true);
    expect(table.rows[0]?.cells[0]?.changed).toBe(true); // nothing before it
  });

  it('keeps the history index so a row can jump into the timeline', () => {
    const history = [
      assignment(1, 1, 'x', [variable('x', '0')]),
      iteration(3, 1, 10, [variable('a', '1')]),
      iteration(3, 2, 20, [variable('a', '2')]),
    ];

    expect(buildIterationTable(history, 4).rows.map((row) => row.historyIndex)).toEqual([1, 2]);
  });

  it('reports an empty table when the line is not in a loop that ran', () => {
    const table = buildIterationTable([iteration(3, 1, 10, [variable('a', '1')])], 42);
    expect(table.rows).toEqual([]);
    expect(table.columns).toEqual([]);
    expect(hasIterations(table)).toBe(false);
  });

  it('caps the columns and flags the truncation', () => {
    const many = Array.from({ length: 12 }, (_, index) => variable(`v${index}`, `${index}`));
    const table = buildIterationTable([iteration(3, 1, 5, many)], 4);

    expect(table.columns).toHaveLength(8);
    expect(table.truncated).toBe(true);
  });
});
