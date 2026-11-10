/**
 * Data of the symbol detail sections. Each endpoint has an in-memory cache per symbol:
 * `/fundamentals` and `/events` cost several upstream credits, so they are kept for hours
 * and asked for at `background` priority (they yield to the chart's own requests).
 */
import { requestJson } from '../api/client';
import type { Fundamentals, FundamentalsInfo, NewsItem, Performance } from '../api/types';
import type { EventsResponse } from '../events/api';
import { createTtlCache, type TtlCache } from './cache';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const FUNDAMENTALS_TTL_MS = 6 * HOUR;
export const EVENTS_TTL_MS = 6 * HOUR;
export const NEWS_TTL_MS = 5 * MINUTE;
export const PERFORMANCE_TTL_MS = 5 * MINUTE;
const MAX_SYMBOLS = 200;

export const BACKGROUND = { 'X-TickerGlass-Priority': 'background' } as const;

/** Upper-case cache key / path segment source of a symbol. */
export const symbolKey = (symbol: string): string => symbol.trim().toUpperCase();

const path = (kind: string, key: string): string => `/${kind}/${encodeURIComponent(key)}`;

/** `/fundamentals` info plus the fields the detail pane reads from it. */
export type SymbolInfoStats = FundamentalsInfo & { averageVolume?: number | null };

export const performanceCache: TtlCache<Performance> = createTtlCache({
  ttlMs: PERFORMANCE_TTL_MS,
  max: MAX_SYMBOLS,
  load: (key) => requestJson<Performance>('GET', path('performance', key)),
});

export const eventsCache: TtlCache<EventsResponse> = createTtlCache({
  ttlMs: EVENTS_TTL_MS,
  max: MAX_SYMBOLS,
  load: (key) =>
    requestJson<EventsResponse>('GET', path('events', key), undefined, { headers: BACKGROUND }),
});

/** Only the `info` block is kept: the statements are large and unused here. */
export const fundamentalsCache: TtlCache<SymbolInfoStats> = createTtlCache({
  ttlMs: FUNDAMENTALS_TTL_MS,
  max: MAX_SYMBOLS,
  load: async (key) => {
    const f = await requestJson<Fundamentals>('GET', path('fundamentals', key), undefined, {
      headers: BACKGROUND,
    });
    return f.info ?? {};
  },
});

export const NEWS_LIMIT = 8;

export const newsCache: TtlCache<NewsItem[]> = createTtlCache({
  ttlMs: NEWS_TTL_MS,
  max: MAX_SYMBOLS,
  load: async (key) => {
    const items = await requestJson<NewsItem[]>('GET', path('news', key), undefined, {
      headers: BACKGROUND,
      query: { limit: NEWS_LIMIT },
    });
    return Array.isArray(items) ? items : [];
  },
});

/** Test hook: forget everything cached. */
export function clearSymbolInfoCaches(): void {
  for (const c of [performanceCache, eventsCache, fundamentalsCache, newsCache]) c.clear();
}
