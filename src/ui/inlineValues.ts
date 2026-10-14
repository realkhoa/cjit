import type { VarNode, WatchSnapshot } from '@/engine/types';

/**
 * Inline value overlays: the "// x = 5" text rendered after a line of code.
 *
 * Values come from the interpreter's per-line states, so an overlay only ever
 * appears on a line that actually ran. The text shows what that line *produced*
 * (the variables it changed or introduced), which is far more useful than
 * repeating every variable in scope, and it keeps the line readable.
 */

export interface InlineValue {
  readonly line: number;
  /** Text without the comment marker, e.g. `total = 6`. */
  readonly text: string;
  /** Names shown in this overlay, in order. */
  readonly names: readonly string[];
  /** How many changed variables did not fit in the overlay. */
  readonly hiddenCount: number;
}

/** Overlays are capped so a 2000-line run cannot flood the editor. */
const MAX_OVERLAYS = 300;
const MAX_NAMES = 3;
const MAX_VALUE_LENGTH = 28;

function shorten(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH - 1)}…` : value;
}

function changesBetween(
  current: readonly VarNode[],
  previous: readonly VarNode[] | undefined,
): VarNode[] {
  if (!previous) return [...current];
  const before = new Map(previous.map((item) => [item.name, item.value]));
  return current.filter((item) => {
    const earlier = before.get(item.name);
    return earlier === undefined || earlier !== item.value;
  });
}

export function inlineValuesFor(watch: WatchSnapshot): InlineValue[] {
  const overlays: InlineValue[] = [];
  const states = watch.lineStates;

  for (let index = 0; index < states.length; index += 1) {
    if (overlays.length >= MAX_OVERLAYS) break;

    const state = states[index];
    if (!state) continue;

    const changed = changesBetween(state.vars, states[index - 1]?.vars);
    if (changed.length === 0) continue;

    const shown = changed.slice(0, MAX_NAMES);
    overlays.push({
      line: state.line,
      text: shown.map((item) => `${item.name} = ${shorten(item.value)}`).join(', '),
      names: shown.map((item) => item.name),
      hiddenCount: changed.length - shown.length,
    });
  }

  return overlays;
}

/** Full text for one overlay, including the comment marker and the "+k" tail. */
export function overlayText(overlay: InlineValue): string {
  const tail = overlay.hiddenCount > 0 ? ` (+${overlay.hiddenCount})` : '';
  return `// ${overlay.text}${tail}`;
}

/** The most recent state for a line, used by the hover/tooltip path. */
export function lineStateAt(watch: WatchSnapshot, line: number): readonly VarNode[] | undefined {
  return watch.lineStates.find((state) => state.line === line)?.vars;
}
