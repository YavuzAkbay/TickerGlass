import { useEffect, useState } from 'react';
import type { Chart, ChartEvents } from '@tickerglass/engine';
import { cachedJson, errorMessage } from '../api/client';

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
