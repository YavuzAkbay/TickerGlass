import type { LiveQuote } from '../quotes/types';
import { COLUMNS } from '../sidebar/watchlist/columns';
import type { CapKind, ScreenerClass, Universe, UniverseSymbol } from './universe/types';

/**
 * Pure screening engine: filter → sort → slice the static universe against
 * live quotes. No React, fully unit-tested; the page only wires inputs in.
 */

/** Active filters of one class. `null` means "no bound". */
export interface ScreenerFilters {
  /** Substring of the symbol or the static name. */
  search: string;
  /** Sector / category / group (exact match on a universe value). */
  group: string | null;
  /** Listing exchange / venue (exact match). */
  exchange: string | null;
  priceMin: number | null;
  priceMax: number | null;
  /** Change % bounds (two-sided, like Finviz's Change filter). */
  chgMin: number | null;
  chgMax: number | null;
  /** Volume bounds. */
  volMin: number | null;
  volMax: number | null;
  /** Static market cap / AUM lower bound (USD billions). */
  capMin: number | null;
}

export const EMPTY_FILTERS: ScreenerFilters = {
  search: '',
  group: null,
  exchange: null,
  priceMin: null,
  priceMax: null,
  chgMin: null,
  chgMax: null,
  volMin: null,
  volMax: null,
  capMin: null,
};

/** The day's low/high from the quote, or null when the provider sent neither. */
export function dayBounds(q: LiveQuote | undefined): { low: number; high: number } | null {
  const { dayLow, dayHigh } = q ?? {};
  if (!isFiniteNum(dayLow) || !isFiniteNum(dayHigh) || dayHigh < dayLow) return null;
  return { low: dayLow, high: dayHigh };
}

/**
 * Intraday volatility: day range as a fraction of the last price (0..∞), null
 * without a quote. Without day high/low it falls back to the span between the
 * session reference (`open`, else `prevClose`) and the last price: a lower
 * bound of the true range, good enough to rank the Volatile preset.
 */
export function dayRangePct(q: LiveQuote | undefined): number | null {
  const last = q?.last;
  if (!isFiniteNum(last) || last <= 0) return null;
  const bounds = dayBounds(q);
  if (bounds) return ((bounds.high - bounds.low) / last) * 100;
  const open = q?.open;
  const ref = isFiniteNum(open) ? open : isFiniteNum(q?.prevClose) ? q!.prevClose : null;
  if (ref === null) return null;
  return (Math.abs(last - ref) / last) * 100;
}

/** 52-week low/high, null unless both are present and ordered. */
export function week52Bounds(q: LiveQuote | undefined): { low: number; high: number } | null {
  const { fiftyTwoWeekLow: low, fiftyTwoWeekHigh: high } = q ?? {};
  if (!isFiniteNum(low) || !isFiniteNum(high) || high <= low) return null;
  return { low, high };
}

/** Position of the last price in the 52-week range (0 = at the low, 1 = at the high). */
export function week52Pos(q: LiveQuote | undefined): number | null {
  const b = week52Bounds(q);
  if (!b || !isFiniteNum(q?.last)) return null;
  return Math.max(0, Math.min(1, (q!.last! - b.low) / (b.high - b.low)));
}

/** Relative volume: today's volume over the average daily volume. */
export function relVolume(q: LiveQuote | undefined): number | null {
  const avg = q?.averageVolume;
  if (!isFiniteNum(avg) || avg <= 0 || !isFiniteNum(q?.volume)) return null;
  return q!.volume! / avg;
}

/** Live market cap in USD billions, null without one. */
export function liveCapBillions(q: LiveQuote | undefined): number | null {
  const cap = q?.marketCap;
  return isFiniteNum(cap) && cap > 0 ? cap / 1e9 : null;
}

/**
 * Cap used by the cap filter and the live-cap column: the live market cap when
 * the class holds market caps (stocks, crypto), else the static snapshot
 * (also the AUM of funds, which quotes do not carry).
 */
export function effectiveCap(
  s: Pick<UniverseSymbol, 'cap'>,
  q: LiveQuote | undefined,
  capKind: CapKind | null,
): number | null {
  if (capKind === 'mcap') {
    const live = liveCapBillions(q);
    if (live !== null) return live;
  }
  return s.cap ?? null;
}

/** Dollar volume (liquidity): shares traded × last price, null without both. */
export function turnover(q: LiveQuote | undefined): number | null {
  if (!isFiniteNum(q?.volume) || !isFiniteNum(q?.last)) return null;
  return q!.volume * q!.last;
}

/**
 * The static cap is a stale snapshot while a live cap may differ a lot, so
 * the whole-universe pre-filter only drops symbols clearly below the bound;
 * the exact check runs once quotes are known (`applyLiveFilters`).
 */
export const CAP_PREFILTER_SLACK = 0.5;

/**
 * Static-field filters (search, group, exchange, cap): they need no quote, so
 * they run on the WHOLE class universe before anything is subscribed.
 */
export function applyStaticFilters(rows: UniverseSymbol[], f: ScreenerFilters): UniverseSymbol[] {
  const needle = f.search.trim().toLowerCase();
  return rows.filter((s) => {
    if (
      needle &&
      !s.symbol.toLowerCase().includes(needle) &&
      !s.name.toLowerCase().includes(needle)
    )
      return false;
    if (f.group !== null && s.group !== f.group) return false;
    if (f.exchange !== null && s.exchange !== f.exchange) return false;
    if (f.capMin !== null && s.cap !== undefined && s.cap < f.capMin * CAP_PREFILTER_SLACK)
      return false;
    return true;
  });
}

/** True when a bound needs a live quote (price, change %, volume). */
export function hasQuoteFilters(f: ScreenerFilters): boolean {
  return (
    f.priceMin !== null ||
    f.priceMax !== null ||
    f.chgMin !== null ||
    f.chgMax !== null ||
    f.volMin !== null ||
    f.volMax !== null
  );
}

/**
 * Quote-driven bounds (price, change %, volume, exact cap): they only keep
 * rows that actually have a quote, so they can only judge subscribed symbols.
 */
export function applyLiveFilters(
  rows: UniverseSymbol[],
  quotes: Record<string, LiveQuote | undefined>,
  f: ScreenerFilters,
  capKind: CapKind | null = null,
): UniverseSymbol[] {
  return rows.filter((s) => {
    const q = quotes[s.symbol];
    if (f.capMin !== null && (effectiveCap(s, q, capKind) ?? 0) < f.capMin) return false;
    if (f.priceMin !== null || f.priceMax !== null) {
      if (!isFiniteNum(q?.last)) return false;
      if (f.priceMin !== null && q!.last! < f.priceMin) return false;
      if (f.priceMax !== null && q!.last! > f.priceMax) return false;
    }
    if (f.chgMin !== null || f.chgMax !== null) {
      if (!isFiniteNum(q?.changePercent)) return false;
      if (f.chgMin !== null && q!.changePercent! < f.chgMin) return false;
      if (f.chgMax !== null && q!.changePercent! > f.chgMax) return false;
    }
    if (f.volMin !== null || f.volMax !== null) {
      if (!isFiniteNum(q?.volume)) return false;
      if (f.volMin !== null && q!.volume! < f.volMin) return false;
      if (f.volMax !== null && q!.volume! > f.volMax) return false;
    }
    return true;
  });
}

/** Static filters, then live filters (everything at once; used by tests and small sets). */
export function applyFilters(
  rows: UniverseSymbol[],
  quotes: Record<string, LiveQuote | undefined>,
  f: ScreenerFilters,
  capKind: CapKind | null = null,
): UniverseSymbol[] {
  return applyLiveFilters(applyStaticFilters(rows, f), quotes, f, capKind);
}

/**
 * Two-stage scan: static filters over the whole universe give the
 * `candidates`; only the top `size` of those by rank (`scanned`) get live
 * quotes. A "Utilities" or "ZS" filter therefore finds matches deep in the
 * universe instead of only inside a global top-N slice.
 */
export function scanPlan(
  symbols: UniverseSymbol[],
  f: ScreenerFilters,
  size: number | null,
): { candidates: UniverseSymbol[]; scanned: UniverseSymbol[] } {
  const candidates = applyStaticFilters(symbols, f);
  return { candidates, scanned: scanSlice(candidates, size) };
}

export type RangeFilter = 'price' | 'chg' | 'vol';

/** Bound pairs whose minimum exceeds the maximum (always matches nothing). */
export function invalidRanges(f: ScreenerFilters): RangeFilter[] {
  const out: RangeFilter[] = [];
  if (f.priceMin !== null && f.priceMax !== null && f.priceMin > f.priceMax) out.push('price');
  if (f.chgMin !== null && f.chgMax !== null && f.chgMin > f.chgMax) out.push('chg');
  if (f.volMin !== null && f.volMax !== null && f.volMin > f.volMax) out.push('vol');
  return out;
}

/** Drop a saved group/exchange the (possibly updated) universe no longer has. */
export function sanitizeFilters(f: ScreenerFilters, universe: Universe): ScreenerFilters {
  const group = f.group !== null && !universe.groups.includes(f.group) ? null : f.group;
  const exchange =
    f.exchange !== null && !universe.exchanges.includes(f.exchange) ? null : f.exchange;
  return group === f.group && exchange === f.exchange ? f : { ...f, group, exchange };
}

/** Number of set filters (the FilterBar badge / chip row). */
export function countFilters(f: ScreenerFilters): number {
  return (
    (f.search.trim() ? 1 : 0) +
    (f.group !== null ? 1 : 0) +
    (f.exchange !== null ? 1 : 0) +
    (f.priceMin !== null ? 1 : 0) +
    (f.priceMax !== null ? 1 : 0) +
    (f.chgMin !== null ? 1 : 0) +
    (f.chgMax !== null ? 1 : 0) +
    (f.volMin !== null ? 1 : 0) +
    (f.volMax !== null ? 1 : 0) +
    (f.capMin !== null ? 1 : 0)
  );
}

const isFiniteNum = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/**
 * Sort keys of the results table: static universe fields + quote fields.
 * `extChangePercent` is the pre/post-market move, `turnover` dollar volume,
 * `dayRangePct` and `absChangePercent` back the Volatile / Biggest movers
 * presets, `liveCap` prefers the live market cap, `week52Pos` is the position
 * in the 52-week range and `relVolume` volume over average volume.
 */
export const SCREENER_SORT_KEYS = [
  'rank',
  'symbol',
  'name',
  'group',
  'exchange',
  'cap',
  'liveCap',
  'last',
  'change',
  'changePercent',
  'prevClose',
  'volume',
  'relVolume',
  'extChangePercent',
  'turnover',
  'dayRangePct',
  'week52Pos',
  'absChangePercent',
] as const;

export type ScreenerSortKey = (typeof SCREENER_SORT_KEYS)[number];

export interface ScreenerSort {
  key: ScreenerSortKey;
  dir: 'asc' | 'desc';
}

/** Quote sort keys delegate to the shared watchlist column definitions. */
const QUOTE_KEYS = ['last', 'change', 'changePercent', 'volume'] as const;
type QuoteSortKey = (typeof QUOTE_KEYS)[number];

const COLLATOR = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * Sort `rows` (returns a new array). `null` values (no quote or no static
 * value) always land at the end, whatever the direction. `null` sort = the
 * universe's own rank order.
 */
export function sortResults(
  rows: UniverseSymbol[],
  sort: ScreenerSort | null,
  quotes: Record<string, LiveQuote | undefined>,
  capKind: CapKind | null = null,
): UniverseSymbol[] {
  if (!sort || sort.key === 'rank') return rows; // already in rank order
  const key = sort.key;
  const value = QUOTE_KEYS.includes(key as QuoteSortKey)
    ? (s: UniverseSymbol): number | null => COLUMNS[key as QuoteSortKey].sortValue(quotes[s.symbol])
    : (s: UniverseSymbol): string | number | null => {
        switch (key) {
          case 'symbol':
            return s.symbol;
          case 'name':
            return s.name;
          case 'group':
            return s.group;
          case 'exchange':
            return s.exchange ?? null;
          case 'cap':
            return s.cap ?? null;
          case 'prevClose':
            return isFiniteNum(quotes[s.symbol]?.prevClose) ? quotes[s.symbol]!.prevClose! : null;
          case 'liveCap':
            return effectiveCap(s, quotes[s.symbol], capKind);
          case 'relVolume':
            return relVolume(quotes[s.symbol]);
          case 'week52Pos':
            return week52Pos(quotes[s.symbol]);
          case 'extChangePercent':
            return COLUMNS.extChangePercent.sortValue(quotes[s.symbol]);
          case 'turnover':
            return turnover(quotes[s.symbol]);
          case 'dayRangePct':
            return dayRangePct(quotes[s.symbol]);
          case 'absChangePercent': {
            const v = quotes[s.symbol]?.changePercent;
            return isFiniteNum(v) ? Math.abs(v) : null;
          }
          default:
            return null;
        }
      };
  const out = [...rows];
  out.sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return a.rank - b.rank;
    if (va === null) return 1;
    if (vb === null) return -1;
    const cmp =
      typeof va === 'string' || typeof vb === 'string'
        ? COLLATOR.compare(String(va), String(vb))
        : va - vb;
    return sort.dir === 'asc' ? cmp : -cmp;
  });
  return out;
}

/** Rows per page of the pager (`null` = all matches; Finviz-style, 20 default). */
export const PAGE_SIZES: readonly (number | null)[] = [20, 50, 100, null];

/** Universe-slice options (`null` = the whole bundled universe). */
export const UNIVERSE_SIZES: readonly (number | null)[] = [50, 100, 250, null];

/** 1-based page count for `total` matches at `pageSize` (`null` = one page). */
export function pageCount(total: number, pageSize: number | null): number {
  if (pageSize === null || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Clamp a 0-based page index into range. */
export function clampPage(page: number, total: number, pageSize: number | null): number {
  return Math.max(0, Math.min(page, pageCount(total, pageSize) - 1));
}

/**
 * The slice actually subscribed for quotes. Growing the page size past the
 * slice auto-expands it (the slices are prefixes of one another, so nothing
 * is refetched that the bigger slice would not include anyway).
 */
export function effectiveUniverseSize(
  pageSize: number | null,
  universeSize: number | null,
): number | null {
  if (pageSize === null || universeSize === null) return null;
  if (universeSize >= pageSize) return universeSize;
  return UNIVERSE_SIZES.find((n) => n !== null && n >= pageSize) ?? null;
}

/** The `top N` slice of a universe (already rank-ordered). */
export function scanSlice(symbols: UniverseSymbol[], size: number | null): UniverseSymbol[] {
  return size === null ? symbols : symbols.slice(0, size);
}

/** One page of the sorted matches (0-based `page`; `null` pageSize = everything). */
export function pageResults(
  rows: UniverseSymbol[],
  page: number,
  pageSize: number | null,
): UniverseSymbol[] {
  if (pageSize === null) return rows;
  const start = page * pageSize;
  return start >= rows.length ? [] : rows.slice(start, start + pageSize);
}

/** Class used for CSV filenames and toasts (`Screener-stocks_2026-01-15.csv`). */
export const CLASS_LABEL: Record<ScreenerClass, string> = {
  stocks: 'Stocks',
  etfs: 'ETFs',
  commodities: 'Commodities',
  crypto: 'Crypto',
};
