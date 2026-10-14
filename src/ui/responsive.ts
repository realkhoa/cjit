/**
 * Layout breakpoints.
 *
 * The predicate is separate from the hook so the rule itself is unit tested, and
 * so non-React code (the store) can ask the same question without importing React.
 */

/**
 * Below this width the three-column desktop layout stops being usable: the
 * editor, the watch pane and the console each end up too narrow to read.
 */
export const MOBILE_MAX_WIDTH = 880;

export type PaneId = 'files' | 'code' | 'watch' | 'console';

export const PANE_ORDER: readonly PaneId[] = ['files', 'code', 'watch', 'console'];

export const PANE_LABELS: Readonly<Record<PaneId, string>> = {
  files: 'Files',
  code: 'Code',
  watch: 'Watch',
  console: 'Output',
};

export function isMobileWidth(width: number): boolean {
  if (!Number.isFinite(width)) return false;
  return width <= MOBILE_MAX_WIDTH;
}

/**
 * Current viewport question, safe outside a browser (tests, SSR). It reads the
 * width directly - the `useIsMobile` hook is what subscribes to changes.
 */
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return isMobileWidth(window.innerWidth);
  } catch {
    return false;
  }
}

export function mobileQuery(): string {
  return `(max-width: ${MOBILE_MAX_WIDTH}px)`;
}
