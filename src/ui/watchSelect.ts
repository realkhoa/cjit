import type { VarNode, WatchSnapshot } from '@/engine/types';

/**
 * Which values the watch pane should show, and which of them just changed.
 *
 * Three modes:
 *  - `cursor`   - the state at the line the caret is on (the default);
 *  - `timeline` - a scrubbable step from the run history;
 *  - `final`    - the state after the program finished.
 *
 * Everything here is pure so it can be unit tested without a DOM.
 */

export type WatchMode = 'cursor' | 'timeline' | 'final';

export interface WatchSelection {
  readonly mode: WatchMode;
  readonly cursorLine: number;
  /** Index into `watch.history`, used by `timeline` mode. */
  readonly historyIndex: number;
}

export interface WatchView {
  readonly vars: readonly VarNode[];
  /** Line the displayed values belong to, or null for a final/unknown state. */
  readonly line: number | null;
  /** True when `line` is exactly the requested line. */
  readonly exact: boolean;
  readonly label: string;
  /** How many variables appeared or changed value since the previous moment. */
  readonly changedCount: number;
}

/**
 * Flags variables whose value differs from the previous moment. A variable that
 * did not exist yet also counts as changed: it is what that step produced.
 */
export function markChanged(
  vars: readonly VarNode[],
  previous: readonly VarNode[] | undefined,
): { vars: readonly VarNode[]; changedCount: number } {
  if (!previous || previous.length === 0) {
    return { vars: vars.map((item) => ({ ...item, changed: false })), changedCount: 0 };
  }

  const before = new Map(previous.map((item) => [item.name, item.value]));
  let changedCount = 0;

  const marked = vars.map((item) => {
    const previousValue = before.get(item.name);
    const changed = previousValue === undefined || previousValue !== item.value;
    if (changed) changedCount += 1;
    return { ...item, changed };
  });

  return { vars: marked, changedCount };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(Math.trunc(index), length - 1));
}

function finalView(watch: WatchSnapshot): WatchView {
  const last = watch.history[watch.history.length - 1];
  const { vars, changedCount } = markChanged(watch.vars, last?.vars);
  return {
    vars,
    line: null,
    exact: false,
    changedCount,
    label: 'final state, after the program finished',
  };
}

function noDataView(watch: WatchSnapshot, label: string): WatchView {
  return {
    vars: markChanged(watch.vars, undefined).vars,
    line: null,
    exact: false,
    changedCount: 0,
    label,
  };
}

export function selectWatchView(watch: WatchSnapshot, selection: WatchSelection): WatchView {
  const { mode, cursorLine, historyIndex } = selection;

  if (mode === 'timeline') {
    const index = clampIndex(historyIndex, watch.history.length);
    const entry = index >= 0 ? watch.history[index] : undefined;
    if (!entry) return noDataView(watch, 'no timeline recorded for this run');

    const previous = index > 0 ? watch.history[index - 1]?.vars : undefined;
    const { vars, changedCount } = markChanged(entry.vars, previous);
    return {
      vars,
      line: entry.line,
      exact: true,
      changedCount,
      label: `step ${entry.step} · ${entry.name} on line ${entry.line}`,
    };
  }

  if (mode === 'final') return finalView(watch);

  // Cursor mode: the state of the line the caret is on.
  const states = watch.lineStates;
  if (states.length === 0) return noDataView(watch, 'no per-line state recorded yet');

  const exactIndex = states.findIndex((state) => state.line === cursorLine);
  let chosenIndex = exactIndex;
  let label: string;

  if (exactIndex >= 0) {
    label = `values after line ${cursorLine} ran`;
  } else {
    // The cursor sits on a line that never ran: fall back to the nearest earlier
    // line, or to the first recorded line if the cursor is before all of them.
    let nearest = -1;
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index];
      if (state && state.line < cursorLine) nearest = index;
      else break;
    }
    if (nearest >= 0) {
      chosenIndex = nearest;
      label = `line ${cursorLine} never ran · showing line ${states[nearest]?.line ?? 0}`;
    } else {
      chosenIndex = 0;
      label = `line ${cursorLine} has not run yet · showing line ${states[0]?.line ?? 0}`;
    }
  }

  const state = states[chosenIndex];
  if (!state) return noDataView(watch, 'no per-line state recorded yet');

  const previous = chosenIndex > 0 ? states[chosenIndex - 1]?.vars : undefined;
  const { vars, changedCount } = markChanged(state.vars, previous);

  return {
    vars,
    line: state.line,
    exact: exactIndex >= 0,
    changedCount,
    label,
  };
}
