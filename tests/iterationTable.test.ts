import { describe, expect, it } from 'vitest';
import type { VarNode, WatchHistoryEntry } from '@/engine/types';
import { buildIterationTable, isLoopLine } from '@/ui/iterationTable';

function variable(name: string, value: string): VarNode {
  return { name, type: 'int', value, scope: 'main', changed: false };
}

function entry(line: number, step: number, vars: VarNode[]): WatchHistoryEntry {
  return { step, line, scope: 'main', name: 'total', vars };
}

describe('buildIterationTable', () => {
  it('turns the recorded states of a loop body into one row per iteration', () => {
    const history = [
      entry(2, 10, [variable('total', '0')]),
      entry(4, 20, [variable('total', '0'), variable('i', '1')]),
      entry(4, 30, [variable('total', '1'), variable('i', '2')]),
      entry(4, 40, [variable('total', '3'), variable('i', '3')]),
    ];

    const table = buildIterationTable(history, 4);

    expect(table.line).toBe(4);
    expect(table.columns).toEqual(['total', 'i']);
    expect(table.rows.map((row) => row.iteration)).toEqual([1, 2, 3]);
    expect(table.rows.map((row) => row.step)).toEqual([20, 30, 40]);
    expect(table.rows[1]?.cells.map((cell) => cell.value)).toEqual(['1', '2']);
    // The first cell of the second row changed from 0 to 1.
    expect(table.rows[1]?.cells[0]?.changed).toBe(true);
    expect(isLoopLine(table)).toBe(true);
  });

  it('ignores states from other lines', () => {
    const history = [entry(2, 10, [variable('a', '1')]), entry(9, 20, [variable('a', '2')])];

    const table = buildIterationTable(history, 2);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.historyIndex).toBe(0);
    expect(isLoopLine(table)).toBe(false);
  });

  it('keeps the history index so a row can be selected in the timeline', () => {
    const history = [
      entry(1, 1, [variable('a', '0')]),
      entry(5, 2, [variable('a', '1')]),
      entry(5, 3, [variable('a', '2')]),
    ];

    const table = buildIterationTable(history, 5);
    expect(table.rows.map((row) => row.historyIndex)).toEqual([1, 2]);
  });

  it('reports an empty table for a line that never ran', () => {
    const table = buildIterationTable([entry(2, 10, [variable('a', '1')])], 42);
    expect(table.rows).toEqual([]);
    expect(table.columns).toEqual([]);
    expect(isLoopLine(table)).toBe(false);
  });

  it('caps the columns and flags the truncation', () => {
    const many = Array.from({ length: 12 }, (_, index) => variable(`v${index}`, `${index}`));
    const table = buildIterationTable([entry(3, 5, many)], 3);

    expect(table.columns).toHaveLength(8);
    expect(table.truncated).toBe(true);
  });

  it('leaves a cell empty when the variable does not exist in that iteration', () => {
    const history = [
      entry(4, 10, [variable('a', '1')]),
      entry(4, 20, [variable('a', '1'), variable('b', '2')]),
    ];

    const table = buildIterationTable(history, 4);
    expect(table.columns).toEqual(['a', 'b']);
    expect(table.rows[0]?.cells.map((cell) => cell.value)).toEqual(['1', '']);
  });
});
