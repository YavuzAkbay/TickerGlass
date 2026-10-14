import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** A callback with a stable identity that always runs the latest `fn` (for memoized children). */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/** A single cancellable pending timeout (cleared on unmount). */
export function useDebounce(): {
  schedule: (fn: () => void, ms: number) => void;
  cancel: () => void;
} {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => clearTimeout(timer.current), []);
  const schedule = useCallback((fn: () => void, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  }, []);
  useEffect(() => cancel, [cancel]);
  return { schedule, cancel };
}
