import type { WatchHistoryEntry } from '@/engine/types';

/**
 * Rows for the "every iteration of this line" dialog.
 *
 * A loop body records one history entry per iteration, so the entries for a line
 * are exactly the iterations of that line. Rendering them as a table - one row
 * per iteration, one column per variable - is what makes the data readable
 * instead of a wall of text.
 */

export interface IterationCell {
  readonly name: string;
  readonly value: string;
  /** True when the value differs from the previous iteration. */
  readonly changed: boolean;
}

export interface IterationRow {
  /** 1-based iteration number for the line. */
  readonly iteration: number;
  readonly step: number;
  /** Index into the snapshot history, so a click can jump there. */
  readonly historyIndex: number;
  readonly cells: readonly IterationCell[];
}

export interface IterationTable {
  readonly line: number;
  readonly columns: readonly string[];
  readonly rows: readonly IterationRow[];
  /** True when more variables existed than the column cap allows. */
  readonly truncated: boolean;
}

const MAX_COLUMNS = 8;

export function buildIterationTable(
  history: readonly WatchHistoryEntry[],
  line: number,
): IterationTable {
  // Pass 1: which entries belong to this line, and which columns exist at all.
  // Columns must be known before any row is built, otherwise an early row would
  // be one cell short once a variable appears in a later iteration.
  const matching: Array<{ entry: WatchHistoryEntry; historyIndex: number }> = [];
  const columns: string[] = [];
  const seen = new Set<string>();
  let truncated = false;

  history.forEach((entry, historyIndex) => {
    if (entry.line !== line) return;
    matching.push({ entry, historyIndex });

    for (const variable of entry.vars) {
      if (seen.has(variable.name)) continue;
      if (columns.length >= MAX_COLUMNS) {
        truncated = true;
        continue;
      }
      seen.add(variable.name);
      columns.push(variable.name);
    }
  });

  // Pass 2: one row per iteration, padded to the full column set.
  const rows: IterationRow[] = [];
  for (const { entry, historyIndex } of matching) {
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

    rows.push({ iteration: rows.length + 1, step: entry.step, historyIndex, cells });
  }

  return { line, columns, rows, truncated };
}

/** True when a line holds more than one recorded iteration (i.e. it is in a loop). */
export function isLoopLine(table: IterationTable): boolean {
  return table.rows.length > 1;
}
