/** Live quote model shared by the watchlist and the details panel. */

/** `tick` frame of `/ws`. */
export interface TickFrame {
  type: 'tick';
  symbol: string;
  price: number;
  change: number | null;
  changePercent: number | null;
  dayVolume: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  /** Unix ms. */
  time: number;
  marketHours: number | null;
  source?: 'poll';
}

/** One item of `GET /api/quotes/extended`. */
export interface ExtendedQuote {
  symbol: string;
  marketState: string | null;
  regularMarketPrice: number | null;
  regularMarketTime: number | null;
  preMarketPrice: number | null;
  preMarketTime: number | null;
  preMarketChange: number | null;
  preMarketChangePercent: number | null;
  postMarketPrice: number | null;
  postMarketTime: number | null;
  postMarketChange: number | null;
  postMarketChangePercent: number | null;
}

export type ExtSession = 'pre' | 'post';
export interface ExtQuote {
  session: ExtSession;
  price: number;
  change: number | null;
  changePercent: number | null;
  timeMs: number;
  /** `tick` = from the stream (protected from snapshots), `snapshot` = from `/quotes/extended`. */
  source: 'tick' | 'snapshot';
}

export interface LiveQuote {
  symbol: string;
  /** Regular-session price. */
  last: number | null;
  prevClose: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  currency: string | null;
  marketState: string | null;
  ext: ExtQuote | null;
  /** Last stream/poll tick that set `last` (ms). */
  lastTickMs: number | null;
  /** `seq` increments on every price change from a tick. */
  flash: { dir: 1 | -1; seq: number; target: 'last' | 'ext' } | null;
}

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'upstream-polling' | 'fallback-polling';
