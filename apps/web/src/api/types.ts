/** Response shapes of the REST API (see api/src/investopen_api/routes/). */

export interface Quote {
  symbol: string;
  last: number | null;
  prevClose: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  currency: string | null;
}

export interface SymbolMeta {
  symbol: string;
  name: string;
  exchange: string | null;
  exchangeName: string | null;
  type: string | null;
  currency: string | null;
  timezone: string | null;
  minTick: number;
  priceHint: number;
}

export interface FundamentalsInfo {
  marketCap?: number | null;
  trailingPE?: number | null;
  forwardPE?: number | null;
  trailingEps?: number | null;
  /** Already a percentage (0.32 means 0.32%). */
  dividendYield?: number | null;
  beta?: number | null;
  fiftyTwoWeekHigh?: number | null;
  fiftyTwoWeekLow?: number | null;
  sector?: string | null;
  industry?: string | null;
  website?: string | null;
  fullTimeEmployees?: number | null;
  longBusinessSummary?: string | null;
  longName?: string | null;
  currency?: string | null;
}

export interface Fundamentals {
  info: FundamentalsInfo;
  financials: unknown;
}

export interface NewsItem {
  id: string;
  title: string;
  publisher: string | null;
  url: string;
  /** Unix seconds. */
  time: number | null;
  thumbnail: string | null;
}
