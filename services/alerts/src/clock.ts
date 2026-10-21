/** Injectable time source so tests can drive close detection and timers. */
export interface Clock {
  /** Wall clock, ms. */
  now(): number;
  /** Returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void;
  setInterval(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
  setInterval(fn, ms) {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
};

/** +-20 % jitter. */
export function jitter(ms: number, rnd: () => number = Math.random): number {
  return Math.round(ms * (0.8 + 0.4 * rnd()));
}

/** 1, 2, 4 ... capped, in ms. `attempt` starts at 0. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
}
