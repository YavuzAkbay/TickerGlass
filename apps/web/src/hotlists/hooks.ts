import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { getLists } from '../screener/server/api';
import type { ListInfo } from '../screener/server/types';
import { getHotlist } from './api';
import type { HotlistKind, HotlistResponse } from './kinds';

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** The server's lists once settled (`ready`); a failed request leaves only the classes. */
export function useListInfos(): { lists: ListInfo[]; ready: boolean } {
  const [state, setState] = useState<{ lists: ListInfo[]; ready: boolean }>({
    lists: [],
    ready: false,
  });
  useEffect(() => {
    const ctrl = new AbortController();
    getLists({ signal: ctrl.signal }).then(
      (lists) => setState({ lists, ready: true }),
      (e: unknown) => {
        if (!isAbort(e)) setState({ lists: [], ready: true });
      },
    );
    return () => ctrl.abort();
  }, []);
  return state;
}

export interface HotlistState {
  data: HotlistResponse | null;
  error: string | null;
  loading: boolean;
  retry: () => void;
}

/**
 * The ranking of `kind` over `universe`. Pass `universe: null` to wait. Refetches when the
 * screener's snapshot date (`asOf`, from the status poll) changes.
 */
export function useHotlist(
  kind: HotlistKind,
  universe: string | null,
  asOf: string | null,
): HotlistState {
  const [nonce, setNonce] = useState(0);
  const [res, setRes] = useState<{ key: string; data?: HotlistResponse; error?: string } | null>(
    null,
  );
  const [last, setLast] = useState<HotlistResponse | null>(null);
  const key = universe === null ? null : `${kind}|${universe}|${asOf ?? ''}|${nonce}`;

  useEffect(() => {
    if (universe === null || key === null) return;
    const ctrl = new AbortController();
    getHotlist(kind, universe, { signal: ctrl.signal }).then(
      (data) => {
        setRes({ key, data });
        setLast(data);
      },
      (e: unknown) => {
        if (!isAbort(e)) setRes({ key, error: errorMessage(e) });
      },
    );
    return () => ctrl.abort();
  }, [kind, universe, key]);

  const current = res && res.key === key ? res : null;
  // A refetch of the same ranking (new snapshot date) keeps the old rows until the new arrive.
  const keep = last && last.kind === kind && last.universe === universe ? last : null;
  const data = current?.data ?? (current?.error ? null : keep);
  return {
    data,
    error: current?.error ?? null,
    loading: key !== null && !current,
    retry: useCallback(() => setNonce((n) => n + 1), []),
  };
}
