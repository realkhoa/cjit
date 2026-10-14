/**
 * Editor settings: small, clamped, and persisted with the rest of the workspace.
 * Pure so the clamping rules are unit tested rather than discovered by dragging
 * a slider to its end.
 */

export interface EditorSettings {
  readonly fontSize: number;
  readonly debounceMs: number;
  readonly minimap: boolean;
  readonly inlineValues: boolean;
}

export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 24;
export const MIN_DEBOUNCE_MS = 200;
export const MAX_DEBOUNCE_MS = 3000;

export function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return 13;
  return Math.min(Math.max(Math.round(value), MIN_FONT_SIZE), MAX_FONT_SIZE);
}

export function clampDebounce(value: number): number {
  if (!Number.isFinite(value)) return 1000;
  return Math.min(Math.max(Math.round(value), MIN_DEBOUNCE_MS), MAX_DEBOUNCE_MS);
}

export function defaultSettings(): EditorSettings {
  return { fontSize: 13, debounceMs: 1000, minimap: true, inlineValues: true };
}

/** Reads settings from a persisted payload, filling in anything missing. */
export function settingsFrom(persisted: {
  readonly fontSize?: unknown;
  readonly debounceMs?: unknown;
  readonly minimap?: unknown;
  readonly inlineValues?: unknown;
}): EditorSettings {
  const base = defaultSettings();
  return {
    fontSize: typeof persisted.fontSize === 'number' ? clampFontSize(persisted.fontSize) : base.fontSize,
    debounceMs:
      typeof persisted.debounceMs === 'number' ? clampDebounce(persisted.debounceMs) : base.debounceMs,
    minimap: typeof persisted.minimap === 'boolean' ? persisted.minimap : base.minimap,
    inlineValues:
      typeof persisted.inlineValues === 'boolean' ? persisted.inlineValues : base.inlineValues,
  };
}
