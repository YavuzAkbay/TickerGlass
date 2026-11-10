import { useSyncExternalStore } from 'react';

export const NOW_STEP_MS = 15_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let current = Date.now();

function tick(): void {
  current = Date.now();
  for (const fn of [...listeners]) fn();
}

/**
 * The shared clock value. While nobody listens the timer is stopped and `current` ages,
 * so a late reader refreshes it first (once per step, keeping the snapshot stable).
 */
export function readNow(): number {
  if (!timer && Date.now() - current >= NOW_STEP_MS) current = Date.now();
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!timer) {
    // The last subscriber may have left long ago: never serve that old value.
    current = Date.now();
    timer = setInterval(tick, NOW_STEP_MS);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Wall clock in ms, refreshed every 15 s and shared by every badge (one timer in total). */
export function useNow(): number {
  return useSyncExternalStore(subscribe, readNow, readNow);
}

/** Test seam: pretend the shared value was last refreshed at `ms`. */
export function __setNowForTest(ms: number): void {
  current = ms;
}
