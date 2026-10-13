import { useEffect, useState } from 'react';
import type { Chart, ChartEvents } from '@investopen/engine';
import { cachedJson, errorMessage, getJson } from '../api/client';
import type { Quote } from '../api/types';

export interface ApiState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  retry: () => void;
}

/** Fetch `path` (cached for `ttlMs`). Pass null to skip. */
export function useApi<T>(path: string | null, ttlMs: number): ApiState<T> {
  const [nonce, setNonce] = useState(0);
  const [res, setRes] = useState<{ key: string; data?: T; error?: string } | null>(null);
  const key = path ? `${path}#${nonce}` : null;

  useEffect(() => {
    if (!path || !key) return;
    let alive = true;
    cachedJson<T>(path, ttlMs).then(
      (data) => alive && setRes({ key, data }),
      (e: unknown) => alive && setRes({ key, error: errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
  }, [path, key, ttlMs]);

  const current = res && res.key === key ? res : null;
  return {
    data: current?.data,
    error: current?.error ?? null,
    loading: !!key && !current,
    retry: () => setNonce((n) => n + 1),
  };
}

export interface QuotesState {
  quotes: Record<string, Quote>;
  error: string | null;
  /** True until the first response for the current symbol set. */
  loading: boolean;
}

/** Quotes for `symbols`, refreshed every `pollMs` while mounted and the tab is visible. */
export function useQuotes(symbols: string[], pollMs = 15000): QuotesState {
  const key = symbols.join(',');
  const [state, setState] = useState<{
    key: string;
    quotes: Record<string, Quote>;
    error: string | null;
  }>({
    key: '',
    quotes: {},
    error: null,
  });

  useEffect(() => {
    if (!key) return;
    let alive = true;
    const ctrl = new AbortController();
    const load = () => {
      if (document.hidden) return;
      getJson<Quote[]>(`/quotes?symbols=${encodeURIComponent(key)}`, { signal: ctrl.signal }).then(
        (list) => {
          if (!alive) return;
          setState((s) => {
            const quotes = { ...s.quotes };
            for (const q of list) quotes[q.symbol] = q;
            return { key, quotes, error: null };
          });
        },
        (e: unknown) => {
          if (!alive || ctrl.signal.aborted) return;
          setState((s) => ({ ...s, key, error: errorMessage(e) }));
        },
      );
    };
    load();
    const timer = setInterval(load, pollMs);
    return () => {
      alive = false;
      ctrl.abort();
      clearInterval(timer);
    };
  }, [key, pollMs]);

  return { quotes: state.quotes, error: state.error, loading: !!key && state.key !== key };
}

/** Re-render counter bumped whenever one of the chart's events fires. */
export function useChartTick(chart: Chart | null, events: (keyof ChartEvents)[]): number {
  const [tick, setTick] = useState(0);
  const sig = events.join(',');
  useEffect(() => {
    if (!chart) return;
    const offs = sig
      .split(',')
      .map((ev) => chart.on(ev as keyof ChartEvents, () => setTick((t) => t + 1)));
    return () => offs.forEach((off) => off());
  }, [chart, sig]);
  return tick;
}

/** Current time, refreshed every `ms`. */
export function useNow(ms = 60000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
