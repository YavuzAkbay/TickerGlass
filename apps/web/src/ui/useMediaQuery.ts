import { useSyncExternalStore } from 'react';

/** Phone-sized layout breakpoint; keep in sync with the `max-width: 768px` media queries in CSS. */
export const MOBILE_QUERY = '(max-width: 768px)';
/** Touch-first device (no precise hover pointer). */
export const COARSE_QUERY = '(pointer: coarse)';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const useIsMobile = (): boolean => useMediaQuery(MOBILE_QUERY);
export const useIsCoarsePointer = (): boolean => useMediaQuery(COARSE_QUERY);
