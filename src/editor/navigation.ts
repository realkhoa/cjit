import type * as Monaco from 'monaco-editor';

/**
 * Lets panels outside the editor (Problems list, breadcrumb, watch rows) move
 * the caret without threading an editor instance through React context.
 */

let activeEditor: Monaco.editor.IStandaloneCodeEditor | null = null;

export function bindEditor(editor: Monaco.editor.IStandaloneCodeEditor | null): void {
  activeEditor = editor;
}

export function hasEditor(): boolean {
  return activeEditor !== null;
}

/** Moves the caret to a 1-based position and focuses the editor. */
export function revealPosition(line: number, column = 1): boolean {
  if (!activeEditor) return false;
  const position = { lineNumber: Math.max(1, Math.trunc(line)), column: Math.max(1, Math.trunc(column)) };
  activeEditor.setPosition(position);
  activeEditor.revealPositionInCenterIfOutsideViewport(position);
  activeEditor.focus();
  return true;
}
