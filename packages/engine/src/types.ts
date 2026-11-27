/** Unix time in seconds (UTC). Bar times are bar *open* times. */
export type UTCTimestamp = number;

export interface Bar {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Columnar bars, ascending by time. All arrays have equal length. */
export interface BarColumns {
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
}

/**
 * Chart interval. `unit` + `count`, e.g. {unit:'minute',count:3} = "3m".
 * String form (see feed/intervals.ts): 1m 3m 1h 4h 1D 2D 1W 1M 3M 6M 12M.
 */
export type IntervalUnit = 'minute' | 'hour' | 'day' | 'week' | 'month';

export interface Interval {
  unit: IntervalUnit;
  count: number;
}

export interface SymbolInfo {
  symbol: string;
  name: string;
  exchange: string | null;
  exchangeName: string | null;
  type: string | null;
  currency: string | null;
  /** IANA timezone of the exchange, e.g. "America/New_York". */
  timezone: string | null;
  /** Regular session in exchange time, "HHMM-HHMM", e.g. "0930-1600". */
  session: string | null;
  priceHint: number;
  minTick: number;
}

export interface SymbolSearchResult {
  symbol: string;
  name: string;
  exchange: string | null;
  type: string | null;
  typeDisplay?: string | null;
}

export interface GetBarsRequest {
  symbol: string;
  interval: Interval;
  /** Exclusive upper bound (unix seconds). Omit for "up to now". */
  to?: UTCTimestamp;
  /** Max bars to return (most recent ones before `to`). */
  limit: number;
  /** Include pre/post-market bars (intraday only). */
  prepost?: boolean;
  /** Dividend-adjusted prices. */
  adjusted?: boolean;
  /** Skip short-lived caches (e.g. CoalescingFeed's): the caller knows its data is stale. */
  fresh?: boolean;
}

export interface GetBarsResult {
  bars: BarColumns;
  /** More (older) history exists before the first returned bar. */
  hasMore: boolean;
}

/** Called with the latest (possibly still forming) bar for a subscription. */
export type BarListener = (bar: Bar) => void;
/**
 * Called when a subscription may have missed bars (the live connection dropped and
 * came back): the owner should re-fetch the recent bars and re-subscribe.
 */
export type ResyncListener = () => void;
export type Unsubscribe = () => void;

export interface SubscribeRequest {
  symbol: string;
  interval: Interval;
  prepost?: boolean;
  /** Timezone used for day/week/month bucket boundaries of live bars. */
  timezone?: string | null;
  /** Session ("HHMM-HHMM") used to anchor intraday buckets, if known. */
  session?: string | null;
  /** Dividend-adjusted prices, as in the matching getBars request (used by replay). */
  adjusted?: boolean;
}

/**
 * Where the chart gets data. Wrappers (resampling, replay, compare, spread
 * expressions) implement this same interface around another DataFeed.
 */
export interface DataFeed {
  resolveSymbol(symbol: string): Promise<SymbolInfo>;
  searchSymbols(query: string, limit?: number): Promise<SymbolSearchResult[]>;
  getBars(req: GetBarsRequest): Promise<GetBarsResult>;
  /**
   * Live updates. `lastBar` is the newest bar the chart already has, so the
   * feed can continue it (same time = update, later time = new bar). `onResync`
   * (optional) fires after an interruption that may have lost ticks.
   */
  subscribe(
    req: SubscribeRequest,
    lastBar: Bar | null,
    onBar: BarListener,
    onResync?: ResyncListener,
  ): Unsubscribe;
}
