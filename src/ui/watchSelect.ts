import type { VarNode, WatchSnapshot } from '@/engine/types';

/**
 * Which values the watch pane should show.
 *
 * The pane is normally pinned to the line the caret is on ("what do these
 * variables hold here?"), and can be switched to the final state after the
 * program finished. The selection is a pure function so it can be unit tested
 * without a DOM.
 */

export type WatchMode = 'cursor' | 'final';

export interface WatchView {
  readonly vars: readonly VarNode[];
  /** Line the displayed values belong to, or null for the final state. */
  readonly line: number | null;
  /** True when `line` is exactly the cursor's line. */
  readonly exact: boolean;
  readonly label: string;
}

export function selectWatchView(
  watch: WatchSnapshot,
  cursorLine: number,
  mode: WatchMode,
): WatchView {
  if (mode === 'final') {
    return {
      vars: watch.vars,
      line: null,
      exact: false,
      label: 'final state, after the program finished',
    };
  }

  const states = watch.lineStates;
  if (states.length === 0) {
    return {
      vars: watch.vars,
      line: null,
      exact: false,
      label: 'no per-line state recorded yet',
    };
  }

  const exact = states.find((state) => state.line === cursorLine);
  if (exact) {
    return {
      vars: exact.vars,
      line: exact.line,
      exact: true,
      label: `values after line ${exact.line} ran`,
    };
  }

  // The cursor sits on a line that never ran (a comment, a declaration that came
  // later, or the closing brace): fall back to the nearest line before it.
  let nearest: { line: number; vars: readonly VarNode[] } | undefined;
  for (const state of states) {
    if (state.line < cursorLine) nearest = state;
    else break;
  }

  if (nearest) {
    return {
      vars: nearest.vars,
      line: nearest.line,
      exact: false,
      label: `line ${cursorLine} never ran · showing line ${nearest.line}`,
    };
  }

  const first = states[0];
  if (!first) {
    return { vars: watch.vars, line: null, exact: false, label: 'no per-line state recorded yet' };
  }

  return {
    vars: first.vars,
    line: first.line,
    exact: false,
    label: `line ${cursorLine} has not run yet · showing line ${first.line}`,
  };
}
