/** `/events/{symbol}` (dividends, splits, earnings) with a per-symbol cache shared by the chart and Details. */
import { cachedJson } from '../api/client';

export const EVENTS_TTL_MS = 10 * 60 * 1000;

export interface DividendEvent {
  t: number;
  amount: number | null;
}

export interface SplitEvent {
  t: number;
  /** New shares per old share (4 for 4:1, 0.5 for 1:2). */
  ratio: number | null;
}

export interface EarningsEvent {
  t: number;
  epsEstimate?: number | null;
  epsActual?: number | null;
  surprisePercent?: number | null;
}

/** Times are unix seconds. */
export interface EventsResponse {
  dividends?: DividendEvent[];
  splits?: SplitEvent[];
  earnings?: EarningsEvent[];
}

export const eventsPath = (symbol: string): string => `/events/${encodeURIComponent(symbol)}`;

/** Cached for 10 minutes; concurrent callers share one request, failures are not cached. */
export function fetchEvents(symbol: string): Promise<EventsResponse> {
  return cachedJson<EventsResponse>(eventsPath(symbol), EVENTS_TTL_MS);
}
