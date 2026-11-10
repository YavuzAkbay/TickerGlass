import { useEffect, useState } from 'react';
import { errorMessage, isUnsupported } from '../api/client';
import type { TtlCache } from './cache';

/** Pause before a changed symbol is fetched: arrowing through rows must not fire a request per row. */
export const SYMBOL_DEBOUNCE_MS = 250;

/** `value`, `ms` after it stopped changing (the first value is passed through at once). */
export function useDebouncedValue<T>(value: T, ms = SYMBOL_DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(settled, value)) return;
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, settled, ms]);
  return settled;
}

export interface SymbolFetch<T> {
  data: T | undefined;
  /** Message of the failure; null while fine. */
  error: string | null;
  /** The provider does not offer this (HTTP 501). */
  unsupported: boolean;
  /** Asked for and not answered yet. */
  loading: boolean;
  retry: () => void;
}

interface Settled<T> {
  id: string;
  data?: T;
  error?: unknown;
}

/**
 * `cache.get(key)` for the current key, only while `enabled`. An answer that arrives after the
 * key changed (or the component left) is ignored; the cache still keeps it for next time.
 */
export function useCachedFetch<T>(
  cache: TtlCache<T>,
  key: string | null,
  enabled = true,
): SymbolFetch<T> {
  const [nonce, setNonce] = useState(0);
  const [res, setRes] = useState<Settled<T> | null>(null);
  const id = enabled && key ? `${key}#${nonce}` : null;

  useEffect(() => {
    if (!id || !key) return;
    let alive = true;
    cache.get(key).then(
      (data) => {
        if (alive) setRes({ id, data });
      },
      (error: unknown) => {
        if (alive) setRes({ id, error });
      },
    );
    return () => {
      alive = false;
    };
  }, [cache, id, key]);

  const cached = enabled && key ? cache.peek(key) : undefined;
  const current = res && res.id === id ? res : null;
  const error = current?.error;
  return {
    data: cached ?? current?.data,
    error: error === undefined ? null : errorMessage(error),
    unsupported: error !== undefined && isUnsupported(error),
    loading: id !== null && cached === undefined && !current,
    retry: () => setNonce((n) => n + 1),
  };
}
