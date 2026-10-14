import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getQuoteStream } from './stream';
import { useQuoteStore } from './store';
import type { LiveQuote, StreamStatus } from './types';

/** Live quotes for `symbols` (subscribed while mounted); keys are upper-case. */
export function useLiveQuotes(
  symbols: string[],
  opts?: { ext?: boolean },
): Record<string, LiveQuote | undefined> {
  const key = symbols.join(',');
  const ext = !!opts?.ext;
  useEffect(() => {
    if (!key) return;
    return getQuoteStream().subscribe(key.split(','), { ext });
  }, [key, ext]);
  // Select only the subscribed quotes: re-renders only when one of them changes.
  const list = useQuoteStore(
    useShallow((s) => (key ? key.split(',') : []).map((sym) => s.quotes[sym.trim().toUpperCase()])),
  );
  return useMemo(() => {
    const out: Record<string, LiveQuote | undefined> = {};
    (key ? key.split(',') : []).forEach((s, i) => {
      out[s] = list[i];
    });
    return out;
  }, [list, key]);
}

export function useLiveQuote(symbol: string | null): LiveQuote | undefined {
  useEffect(() => {
    if (!symbol) return;
    return getQuoteStream().subscribe([symbol]);
  }, [symbol]);
  return useQuoteStore((s) => (symbol ? s.quotes[symbol.trim().toUpperCase()] : undefined));
}

/** True once a snapshot fetch completed without a quote for `symbol` (unknown symbol). */
export function useQuoteMissing(symbol: string | null): boolean {
  return useQuoteStore((s) => (symbol ? !!s.missing[symbol.trim().toUpperCase()] : false));
}

export function useStreamStatus(): StreamStatus {
  return useQuoteStore((s) => s.status);
}
