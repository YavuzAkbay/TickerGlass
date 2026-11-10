/**
 * The screener's static symbol universe: curated, bundled datasets per asset
 * class, ordered by rank (≈ market cap / AUM / importance when written) so a
 * "top N" scan slice is meaningful. Names, groups and approximate caps are a
 * static snapshot (`UNIVERSE_AS_OF`); prices and volumes always come live
 * from the quotes API. Swapping in a server-side scan later only replaces
 * `getUniverse` — the filter/sort engine is provider-agnostic.
 */

export type ScreenerClass = 'stocks' | 'etfs' | 'commodities' | 'crypto';

/** Tab order of the screener page. */
export const SCREENER_CLASSES: readonly ScreenerClass[] = [
  'stocks',
  'etfs',
  'commodities',
  'crypto',
];

/** Static metadata of one screener symbol. */
export interface UniverseSymbol {
  symbol: string;
  name: string;
  /** 1-based position in the class; the scan slice takes the first N. */
  rank: number;
  /** Sector (stocks), category (ETFs) or group (commodities, crypto). */
  group: string;
  /** Listing exchange / futures venue (NASDAQ, NYSE, COMEX…), when known. */
  exchange?: string;
  /** Approximate market cap or AUM in USD billions (static snapshot). */
  cap?: number;
}

/** What the static `cap` column means for a class. */
export type CapKind = 'mcap' | 'aum';

export interface Universe {
  cls: ScreenerClass;
  /** Label key of the `group` filter for this class. */
  groupLabel: 'sector' | 'category' | 'group';
  /** Whether `cap` holds a market cap or fund AUM (null: cap is always empty). */
  capKind: CapKind | null;
  symbols: UniverseSymbol[];
  /** Distinct group values in display order. */
  groups: string[];
  /** Distinct exchanges in display order. */
  exchanges: string[];
}

/** Snapshot date of the bundled datasets (shown in the UI as a caveat). */
export const UNIVERSE_AS_OF = '2026-01';

/** `[symbol, name, group, exchange?, cap?]` rows of a dataset file. Explicit
 *  `undefined` placeholders (e.g. crypto's missing exchange) are allowed. */
export type UniverseRow = [
  symbol: string,
  name: string,
  group: string,
  exchange?: string | undefined,
  cap?: number | undefined,
];

/**
 * Expand the compact rows of a dataset file. Ranks follow row order (1-based);
 * group and exchange lists keep first-seen order.
 */
export function buildUniverse(
  cls: ScreenerClass,
  groupLabel: Universe['groupLabel'],
  capKind: Universe['capKind'],
  rows: UniverseRow[],
): Universe {
  const symbols: UniverseSymbol[] = rows.map(([symbol, name, group, exchange, cap], i) => ({
    symbol,
    name,
    group,
    ...(exchange ? { exchange } : {}),
    ...(typeof cap === 'number' && cap > 0 ? { cap } : {}),
    rank: i + 1,
  }));
  const groups: string[] = [];
  const exchanges: string[] = [];
  for (const s of symbols) {
    if (!groups.includes(s.group)) groups.push(s.group);
    if (s.exchange && !exchanges.includes(s.exchange)) exchanges.push(s.exchange);
  }
  return { cls, groupLabel, capKind, symbols, groups, exchanges };
}
