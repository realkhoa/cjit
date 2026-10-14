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
  /**
   * `changed` - this line produced the values; `scope` - the line changed
   * nothing, so it shows what was in scope (like a debugger's inline values).
   */
  readonly kind: 'changed' | 'scope';
}

/** Overlays are capped so a 2000-line run cannot flood the editor. */
const MAX_OVERLAYS = 300;
const MAX_NAMES = 3;
const MAX_VALUE_LENGTH = 28;

/**
 * Monaco injects this text into a single line, so any newline or tab in a value
 * would corrupt the rendering. They are made visible instead of dropped.
 */
function singleLine(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '\\n').replace(/\t/g, '\\t');
}

function shorten(value: string): string {
  const flattened = singleLine(value);
  return flattened.length > MAX_VALUE_LENGTH
    ? `${flattened.slice(0, MAX_VALUE_LENGTH - 1)}…`
    : flattened;
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

    // The first recorded line has nothing to compare against, so it is treated as
    // "in scope" rather than claiming the line produced every variable.
    const previousState = index > 0 ? states[index - 1]?.vars : undefined;
    const changed = previousState === undefined ? [] : changesBetween(state.vars, previousState);

    // Prefer what the line produced. If it changed nothing (a call, a print, a
    // branch), fall back to what was in scope there - otherwise the reader gets
    // no values at all on most lines.
    const kind: InlineValue['kind'] = changed.length > 0 ? 'changed' : 'scope';
    const chosen = kind === 'changed' ? changed : state.vars.filter((item) => item.scope !== 'global');
    if (chosen.length === 0) continue;

    const shown = chosen.slice(0, MAX_NAMES);
    overlays.push({
      line: state.line,
      text: shown.map((item) => `${item.name} = ${shorten(item.value)}`).join(', '),
      names: shown.map((item) => item.name),
      hiddenCount: chosen.length - shown.length,
      kind,
    });
  }

  return overlays;
}

/** Full text for one overlay, including the comment marker and the "+k" tail. */
export function overlayText(overlay: InlineValue): string {
  const tail = overlay.hiddenCount > 0 ? ` (+${overlay.hiddenCount})` : '';
  return `// ${overlay.text}${tail}`;
}

/**
 * One injected-text decoration per overlay.
 *
 * The range must span the WHOLE line: Monaco renders `after` content at the end
 * position of the decoration, so a collapsed range at column 1 would put the
 * comment at the start of the line - or render nothing at all.
 */
export interface InlineDecorationSpec {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly content: string;
  /** CSS class, so produced values can look different from in-scope ones. */
  readonly className: string;
}

/**
 * Column where the inline comment starts when the code is short, and the minimum
 * gap after the code when it is not. A single fixed column is what makes a column
 * of overlays scannable instead of a ragged edge glued to the code.
 */
const COMMENT_COLUMN = 60;
const MIN_GAP = 4;

/**
 * Non-breaking spaces, not ordinary ones.
 *
 * Injected text ends up in a DOM span, and HTML collapses runs of ordinary
 * spaces depending on the container's `white-space`. That is not worth relying
 * on for alignment, and U+00A0 is never collapsed.
 */
const PAD = '\u00A0';

export function inlineDecorationSpecs(
  watch: WatchSnapshot,
  lineLength: (line: number) => number,
): InlineDecorationSpec[] {
  return inlineValuesFor(watch).map((overlay) => {
    const endColumn = Math.max(lineLength(overlay.line), 0) + 1;
    const commentColumn = Math.max(endColumn + MIN_GAP, COMMENT_COLUMN);
    const padding = PAD.repeat(Math.max(commentColumn - endColumn, 1));

    return {
      line: overlay.line,
      startColumn: 1,
      endColumn,
      content: `${padding}${overlayText(overlay)}`,
      className:
        overlay.kind === 'changed'
          ? 'cjit-inline-value'
          : 'cjit-inline-value cjit-inline-value--scope',
    };
  });
}

/** The most recent state for a line, used by the hover/tooltip path. */
export function lineStateAt(watch: WatchSnapshot, line: number): readonly VarNode[] | undefined {
  return watch.lineStates.find((state) => state.line === line)?.vars;
}
