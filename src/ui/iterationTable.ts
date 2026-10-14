import type { WatchHistoryEntry } from '@/engine/types';

/**
 * Rows for the "every iteration of this loop" dialog.
 *
 * The interpreter records one entry per *loop pass*, not per line, so a row here
 * is a whole iteration of a `for`/`while`/range-for loop - with the state that
 * pass left behind - while `globalIteration` keeps the position of that pass in
 * the run as a whole.
 *
 * When loops nest, the keyboard caret belongs to the innermost loop that touched
 * its line: that is what `depth` is for.
 */

export interface IterationCell {
  readonly name: string;
  readonly value: string;
  /** True when the value differs from the previous iteration. */
  readonly changed: boolean;
}

export interface IterationRow {
  /** 1-based iteration number of its own loop. */
  readonly iteration: number;
  /** 1-based ordinal among every loop iteration recorded in the run. */
  readonly globalIteration: number;
  readonly step: number;
  /** Index into the snapshot history, so a click can jump there. */
  readonly historyIndex: number;
  readonly cells: readonly IterationCell[];
}

export interface IterationTable {
  /** Line of the loop header, or null when the caret is not inside a loop. */
  readonly loopLine: number | null;
  /** Nesting depth of that loop (1 = outermost). */
  readonly depth: number;
  readonly columns: readonly string[];
  readonly rows: readonly IterationRow[];
  readonly truncated: boolean;
  /** Total loop iterations recorded in the whole run. */
  readonly globalTotal: number;
}

const MAX_COLUMNS = 8;

export function buildIterationTable(
  history: readonly WatchHistoryEntry[],
  cursorLine: number,
): IterationTable {
  // Global ordinals are assigned over *every* loop iteration, so the dialog can
  // show where this pass sits in the whole execution.
  const globalOrdinal = new Map<number, number>();
  let globalTotal = 0;
  history.forEach((entry, index) => {
    if (entry.kind !== 'loop-iteration') return;
    globalTotal += 1;
    globalOrdinal.set(index, globalTotal);
  });

  // Which loop iterations touched the caret's line?
  const touching: Array<{ entry: WatchHistoryEntry; index: number }> = [];
  history.forEach((entry, index) => {
    if (entry.kind !== 'loop-iteration') return;
    const touches =
      entry.line === cursorLine || (entry.lines?.includes(cursorLine) ?? false);
    if (touches) touching.push({ entry, index });
  });

  if (touching.length === 0) {
    return {
      loopLine: null,
      depth: 0,
      columns: [],
      rows: [],
      truncated: false,
      globalTotal,
    };
  }

  // Innermost loop wins: a line inside a nested loop belongs to both loops.
  const maxDepth = Math.max(...touching.map((item) => item.entry.depth ?? 1));
  const innermost = touching.filter((item) => (item.entry.depth ?? 1) === maxDepth);
  const loopLine = innermost[0]?.entry.line ?? cursorLine;
  const selected = innermost.filter((item) => item.entry.line === loopLine);

  // Columns first, then rows: an early iteration must not end up short when a
  // variable only appears in a later one.
  const columns: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const { entry } of selected) {
    for (const variable of entry.vars) {
      if (seen.has(variable.name)) continue;
      if (columns.length >= MAX_COLUMNS) {
        truncated = true;
        continue;
      }
      seen.add(variable.name);
      columns.push(variable.name);
    }
  }

  const rows: IterationRow[] = [];
  for (const { entry, index } of selected) {
    const previous = rows[rows.length - 1];
    const previousValues = new Map(previous?.cells.map((cell) => [cell.name, cell.value]) ?? []);

    const cells: IterationCell[] = columns.map((name) => {
      const variable = entry.vars.find((item) => item.name === name);
      const value = variable?.value ?? '';
      const earlier = previousValues.get(name);
      return {
        name,
        value,
        changed: variable !== undefined && (earlier === undefined || earlier !== value),
      };
    });

    rows.push({
      iteration: entry.iteration ?? rows.length + 1,
      globalIteration: globalOrdinal.get(index) ?? 0,
      step: entry.step,
      historyIndex: index,
      cells,
    });
  }

  return { loopLine, depth: maxDepth, columns, rows, truncated, globalTotal };
}

/** True when the caret line belongs to a loop that ran at least once. */
export function hasIterations(table: IterationTable): boolean {
  return table.rows.length > 0;
}
