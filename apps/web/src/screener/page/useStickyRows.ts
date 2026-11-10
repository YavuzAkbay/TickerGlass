import { useEffect, useState } from 'react';

/** How long a row that stopped matching stays before it is dropped (ms). */
export const STICKY_MS = 1500;

export interface StickyState<T> {
  /** The last `rows` input (identity check for the derive-in-render step). */
  src: readonly T[];
  resetKey: string;
  frozen: boolean;
  /** Rows displayed by the last step, by key. */
  shown: ReadonlyMap<string, T>;
  /** Rows kept although they no longer match, by key. */
  held: ReadonlyMap<string, T>;
  /** Displayed rows (matching ∪ held) in input order, held ones last. */
  out: T[];
}

export function initSticky<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  resetKey: string,
  frozen: boolean,
): StickyState<T> {
  return {
    src: rows,
    resetKey,
    frozen,
    shown: new Map(rows.map((r) => [keyOf(r), r])),
    held: new Map(),
    out: [...rows],
  };
}

/**
 * One step of the stickiness. Rows that matched before but no longer do are
 * `held` (until the caller expires them); while `frozen`, rows that start
 * matching are deferred instead of popping in. A changed `resetKey` (the user
 * edited filters, sort or class) applies the new matches immediately.
 */
export function stickyStep<T>(
  prev: StickyState<T>,
  rows: readonly T[],
  keyOf: (row: T) => string,
  resetKey: string,
  frozen: boolean,
): StickyState<T> {
  if (prev.resetKey !== resetKey) return initSticky(rows, keyOf, resetKey, frozen);
  const keys = new Set(rows.map(keyOf));
  const held = new Map<string, T>();
  // Previously held rows stay until expiry unless they match again.
  for (const [k, r] of prev.held) if (!keys.has(k)) held.set(k, r);
  // Rows displayed last step that dropped out of the matches are newly held.
  for (const [k, r] of prev.shown) if (!keys.has(k) && !held.has(k)) held.set(k, r);
  const matching = frozen ? rows.filter((r) => prev.shown.has(keyOf(r))) : [...rows];
  const out = [...matching, ...held.values()];
  const shown = new Map(out.map((r) => [keyOf(r), r]));
  return { src: rows, resetKey, frozen, shown, held, out };
}

/** Drop the held rows (their time is up). */
export function expireSticky<T>(prev: StickyState<T>, keyOf: (row: T) => string): StickyState<T> {
  if (!prev.held.size) return prev;
  const out = prev.out.filter((r) => !prev.held.has(keyOf(r)));
  return { ...prev, held: new Map(), shown: new Map(out.map((r) => [keyOf(r), r])), out };
}

/**
 * Calms threshold filters on a live list: a row whose quote just crossed the
 * bound stays visible for `ms`, and while `frozen` (the user is reading or
 * pointing) nothing new pops in either. `resetKey` changes apply at once.
 * `keyOf` must be a stable function (the expiry timer depends on it).
 */
export function useStickyRows<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  opts: { resetKey: string; frozen: boolean; ms?: number },
): T[] {
  const { resetKey, frozen, ms = STICKY_MS } = opts;
  const [state, setState] = useState(() => initSticky(rows, keyOf, resetKey, frozen));
  let cur = state;
  // Derive during render (React's sanctioned alternative to an effect-driven copy).
  if (state.src !== rows || state.resetKey !== resetKey || state.frozen !== frozen) {
    cur = stickyStep(state, rows, keyOf, resetKey, frozen);
    setState(cur);
  }
  const holding = cur.held.size > 0;
  useEffect(() => {
    if (!holding || frozen) return;
    const id = setTimeout(() => setState((s) => expireSticky(s, keyOf)), ms);
    return () => clearTimeout(id);
  }, [holding, frozen, ms, keyOf]);
  return cur.out;
}
