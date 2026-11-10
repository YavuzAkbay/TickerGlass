import { useCallback, useEffect, useRef, useState } from 'react';
import { getFields, getLists, getPresets, getStatus, scan, scanKey } from './api';
import { pollInterval } from './mode';
import type {
  FieldDef,
  ListInfo,
  Preset,
  ScanRequest,
  ScanResponse,
  StatusResponse,
} from './types';

export interface StatusState {
  /** Last status the server sent; null until the first answer (or when it never came). */
  status: StatusResponse | null;
  /** The first status request settled (answered or failed). */
  loaded: boolean;
  refresh: () => void;
}

/** `/screener/status`, polled every 10 s while a run is going and every minute otherwise. */
export function useScreenerStatus(): StatusState {
  const [state, setState] = useState<{ status: StatusResponse | null; loaded: boolean }>({
    status: null,
    loaded: false,
  });
  const kick = useRef<(() => void) | null>(null);

  useEffect(() => {
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl: AbortController | null = null;
    const tick = async () => {
      clearTimeout(timer);
      ctrl?.abort();
      ctrl = new AbortController();
      let next = pollInterval(null);
      try {
        const status = await getStatus({ signal: ctrl.signal });
        if (dead) return;
        setState({ status, loaded: true });
        next = pollInterval(status);
      } catch (e) {
        if (dead || (e instanceof DOMException && e.name === 'AbortError')) return;
        // Unreachable or 5xx: keep what we know (null = client mode) and retry slowly.
        setState((s) => ({ status: s.status, loaded: true }));
      }
      if (!dead) timer = setTimeout(() => void tick(), next);
    };
    kick.current = () => void tick();
    void tick();
    return () => {
      dead = true;
      clearTimeout(timer);
      ctrl?.abort();
      kick.current = null;
    };
  }, []);

  const refresh = useCallback(() => kick.current?.(), []);
  return { ...state, refresh };
}

/** One-shot fetch into state; a failure sets `failed` and leaves `value` null. */
function useFetched<T>(enabled: boolean, load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ value: T | null; failed: boolean }>({
    value: null,
    failed: false,
  });
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    loadRef.current(ctrl.signal).then(
      (value) => setState({ value, failed: false }),
      (e) => {
        if (!(e instanceof DOMException && e.name === 'AbortError'))
          setState({ value: null, failed: true });
      },
    );
    return () => ctrl.abort();
  }, [enabled]);
  return state;
}

/** The field catalog (server mode only); `failed` when it could not be loaded. */
export function useFields(enabled: boolean): { fields: FieldDef[] | null; failed: boolean } {
  const { value, failed } = useFetched(enabled, () => getFields());
  return { fields: value?.fields ?? null, failed };
}

export function usePresets(enabled: boolean): Preset[] {
  return useFetched(enabled, (signal) => getPresets({ signal })).value ?? [];
}

export function useLists(enabled: boolean): ListInfo[] {
  return useFetched(enabled, (signal) => getLists({ signal })).value ?? [];
}

export interface ScanState {
  data: ScanResponse | null;
  /** Send the current request again (after an error). */
  retry: () => void;
  /** A request for the current inputs is pending or in flight (`data` may be the previous answer). */
  loading: boolean;
  error: unknown;
}

/** Edits wait this long before a scan is sent. */
export const SCAN_DEBOUNCE_MS = 300;

/**
 * Debounced scan of `req` (null = idle). The previous answer stays in `data` while the next
 * one loads; a request superseded by a newer one is aborted.
 */
export function useScan(req: ScanRequest | null, debounceMs = SCAN_DEBOUNCE_MS): ScanState {
  const key = req ? scanKey(req) : null;
  const [state, setState] = useState<{
    data: ScanResponse | null;
    key: string | null;
    error: unknown;
    errorKey: string | null;
  }>({ data: null, key: null, error: null, errorKey: null });
  const [nonce, setNonce] = useState(0);
  const hasData = useRef(false);
  useEffect(() => {
    hasData.current = state.data !== null;
  });

  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    const send = async () => {
      try {
        const data = await scan(JSON.parse(key) as ScanRequest, { signal: ctrl.signal });
        setState({ data, key, error: null, errorKey: null });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setState((s) => ({ ...s, error: e, errorKey: key }));
      }
    };
    // The first answer is not worth waiting for; only edits are debounced.
    const timer = setTimeout(() => void send(), hasData.current ? debounceMs : 0);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [key, debounceMs, nonce]);

  const retry = useCallback(() => {
    setState((s) => ({ ...s, errorKey: null }));
    setNonce((n) => n + 1);
  }, []);

  return {
    data: state.data,
    retry,
    loading: key !== null && state.key !== key && state.errorKey !== key,
    error: key !== null && state.errorKey === key ? state.error : null,
  };
}
