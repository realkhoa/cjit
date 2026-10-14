import { useEffect, useState } from 'react';
import { isMobileViewport, mobileQuery } from '@/ui/responsive';

/**
 * Tracks whether the narrow, one-pane-at-a-time layout should be used.
 *
 * Starts from the current viewport so the first paint is already correct, then
 * follows the media query.
 */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState<boolean>(() => isMobileViewport());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const query = window.matchMedia(mobileQuery());
    const update = (): void => setMobile(query.matches);
    update();

    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return mobile;
}
