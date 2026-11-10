import { useEffect, useReducer, useState } from 'react';

export interface StableOrderOptions {
  /** Minimum time between order commits (default 1500 ms). */
  intervalMs?: number;
  /** While true no new order is committed (e.g. the pointer is over the list). */
  frozen?: boolean;
}

export const DEFAULT_ORDER_INTERVAL_MS = 1500;
/** The commit clock; the order is deliberately time-dependent (a timer re-renders it). */
const clock = (): number => Date.now();

/**
 * `items` arranged by a previously committed key `order`: keys still present keep their
 * committed position, removed keys drop, keys not in `order` are inserted at their index in
 * `items` (clamped to the end).
 */
export function applyOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  order: readonly string[],
): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) {
    const k = keyOf(item);
    if (!byKey.has(k)) byKey.set(k, item);
  }
  const known = new Set(order);
  const out: T[] = [];
  const seen = new Set<string>();
  for (const k of order) {
    const item = byKey.get(k);
    if (item !== undefined && !seen.has(k)) {
      out.push(item);
      seen.add(k);
    }
  }
  items.forEach((item, i) => {
    const k = keyOf(item);
    if (known.has(k) || seen.has(k)) return;
    seen.add(k);
    out.splice(Math.min(i, out.length), 0, item);
  });
  return out;
}

export interface StableOrderResult<T> {
  items: T[];
  /** Ms until a pending, different order commits; null when nothing is pending or frozen. */
  pendingInMs: number | null;
}

/** The framework-free core of `useStableOrder` (time is injected for tests). */
export class StableOrder<T> {
  private order: string[] | null = null;
  private lastCommit = -Infinity;
  private wasFrozen = false;
  private out: T[] | null = null;

  update(
    items: readonly T[],
    keyOf: (item: T) => string,
    intervalMs: number,
    frozen: boolean,
    now: number,
  ): StableOrderResult<T> {
    const fresh = items.map(keyOf);
    const unfroze = this.wasFrozen && !frozen;
    this.wasFrozen = frozen;
    let shown = this.order === null ? null : applyOrder(items, keyOf, this.order);
    const same = shown !== null && sameKeys(shown, fresh, keyOf);
    let pendingInMs: number | null = null;
    if (!same) {
      const due = this.order === null || unfroze || now - this.lastCommit >= intervalMs;
      if (!frozen && due) {
        this.order = fresh;
        this.lastCommit = now;
        shown = applyOrder(items, keyOf, fresh);
      } else if (!frozen) {
        pendingInMs = Math.max(0, intervalMs - (now - this.lastCommit));
      }
    }
    const next = shown ?? [...items];
    const prev = this.out;
    if (prev && prev.length === next.length && prev.every((x, i) => x === next[i])) {
      return { items: prev, pendingInMs };
    }
    this.out = next;
    return { items: next, pendingInMs };
  }
}

function sameKeys<T>(shown: readonly T[], keys: readonly string[], keyOf: (t: T) => string) {
  return shown.length === keys.length && shown.every((x, i) => keyOf(x) === keys[i]);
}

/**
 * `items` in the last committed order, so a live-sorted list does not jump on every tick.
 * A new order commits at most once per `intervalMs` and never while `frozen`; a pending order
 * is committed by a timer once the interval has elapsed or `frozen` turns false.
 */
export function useStableOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  opts: StableOrderOptions = {},
): T[] {
  const { intervalMs = DEFAULT_ORDER_INTERVAL_MS, frozen = false } = opts;
  const [core] = useState(() => new StableOrder<T>());
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const res = core.update(items, keyOf, intervalMs, frozen, clock());
  const { pendingInMs } = res;
  useEffect(() => {
    if (pendingInMs === null) return;
    const id = setTimeout(bump, pendingInMs);
    return () => clearTimeout(id);
  }, [pendingInMs, res.items]);
  return res.items;
}
