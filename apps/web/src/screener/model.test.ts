import { describe, expect, it } from 'vitest';
import { emptyQuote } from '../quotes/merge';
import type { LiveQuote } from '../quotes/types';
import type { UniverseSymbol } from './universe/types';
import { buildUniverse } from './universe/types';
import {
  applyFilters,
  applyLiveFilters,
  applyStaticFilters,
  clampPage,
  effectiveCap,
  hasQuoteFilters,
  invalidRanges,
  liveCapBillions,
  relVolume,
  sanitizeFilters,
  scanPlan,
  week52Pos,
  countFilters,
  dayRangePct,
  effectiveUniverseSize,
  EMPTY_FILTERS,
  pageCount,
  pageResults,
  scanSlice,
  sortResults,
  turnover,
  type ScreenerSort,
} from './model';

const sym = (symbol: string, group = 'Tech', exchange?: string, cap?: number): UniverseSymbol => ({
  symbol,
  name: `Name of ${symbol}`,
  group,
  ...(exchange ? { exchange } : {}),
  ...(cap ? { cap } : {}),
  rank: 0,
});

const universe = [
  sym('AAA', 'Tech', 'NASDAQ', 900),
  sym('BBB', 'Tech', 'NYSE', 100),
  sym('CCC', 'Health', 'NASDAQ'),
  sym('DDD', 'Energy', 'NYSE', 20),
].map((s, i) => ({ ...s, rank: i + 1 }));

const quote = (symbol: string, patch: Partial<LiveQuote>): LiveQuote => ({
  ...emptyQuote(symbol),
  ...patch,
});

const quotes = {
  AAA: quote('AAA', { last: 250, changePercent: 2.5, volume: 1_000_000 }),
  BBB: quote('BBB', { last: 50, changePercent: -1, volume: 500 }),
  CCC: quote('CCC', { last: 5, changePercent: 0, volume: 0 }),
  DDD: quote('DDD', { last: 5.5, changePercent: 10, volume: 2_000_000 }),
};

describe('applyFilters', () => {
  it('matches search on symbol or name, case-insensitively', () => {
    const f = { ...EMPTY_FILTERS, search: 'bbb' };
    expect(applyFilters(universe, quotes, f).map((s) => s.symbol)).toEqual(['BBB']);
    const name = { ...EMPTY_FILTERS, search: 'NAME OF C' };
    expect(applyFilters(universe, quotes, name).map((s) => s.symbol)).toEqual(['CCC']);
  });

  it('filters by group, exchange and static cap', () => {
    const group = { ...EMPTY_FILTERS, group: 'Tech' };
    expect(applyFilters(universe, quotes, group).map((s) => s.symbol)).toEqual(['AAA', 'BBB']);
    const exchange = { ...EMPTY_FILTERS, exchange: 'NYSE' };
    expect(applyFilters(universe, quotes, exchange).map((s) => s.symbol)).toEqual(['BBB', 'DDD']);
    const cap = { ...EMPTY_FILTERS, capMin: 50 };
    expect(applyFilters(universe, quotes, cap).map((s) => s.symbol)).toEqual(['AAA', 'BBB']);
  });

  it('price bounds need a quote; missing quotes drop out', () => {
    const f = { ...EMPTY_FILTERS, priceMin: 10 };
    expect(applyFilters(universe, quotes, f).map((s) => s.symbol)).toEqual(['AAA', 'BBB']);
    const max = { ...EMPTY_FILTERS, priceMax: 10 };
    expect(applyFilters(universe, quotes, max).map((s) => s.symbol)).toEqual(['CCC', 'DDD']);
  });

  it('change % and volume bounds compare numerically', () => {
    expect(
      applyFilters(universe, quotes, { ...EMPTY_FILTERS, chgMin: 2 }).map((s) => s.symbol),
    ).toEqual(['AAA', 'DDD']);
    expect(
      applyFilters(universe, quotes, { ...EMPTY_FILTERS, volMin: 1000 }).map((s) => s.symbol),
    ).toEqual(['AAA', 'DDD']);
  });

  it('upper bounds keep the row range two-sided', () => {
    expect(
      applyFilters(universe, quotes, { ...EMPTY_FILTERS, chgMax: 5 }).map((s) => s.symbol),
    ).toEqual(['AAA', 'BBB', 'CCC']);
    expect(
      applyFilters(universe, quotes, { ...EMPTY_FILTERS, volMax: 1500 }).map((s) => s.symbol),
    ).toEqual(['BBB', 'CCC']);
    // Both sides at once.
    expect(
      applyFilters(universe, quotes, { ...EMPTY_FILTERS, chgMin: -2, chgMax: 3 }).map(
        (s) => s.symbol,
      ),
    ).toEqual(['AAA', 'BBB', 'CCC']);
  });

  it('counts set filters', () => {
    expect(countFilters(EMPTY_FILTERS)).toBe(0);
    expect(countFilters({ ...EMPTY_FILTERS, search: 'a', chgMin: 0, group: null })).toBe(2);
    expect(countFilters({ ...EMPTY_FILTERS, chgMax: 1, volMax: 5 })).toBe(2);
  });
});

describe('sortResults', () => {
  it('null sort keeps rank order', () => {
    expect(sortResults(universe, null, quotes).map((s) => s.symbol)).toEqual([
      'AAA',
      'BBB',
      'CCC',
      'DDD',
    ]);
  });

  it('sorts static fields with collation and nulls last', () => {
    const byName: ScreenerSort = { key: 'name', dir: 'asc' };
    expect(sortResults(universe, byName, quotes).map((s) => s.symbol)).toEqual([
      'AAA',
      'BBB',
      'CCC',
      'DDD',
    ]);
    const byCap: ScreenerSort = { key: 'cap', dir: 'desc' };
    expect(sortResults(universe, byCap, quotes).map((s) => s.symbol)).toEqual([
      'AAA',
      'BBB',
      'DDD',
      'CCC', // no cap → last even in desc
    ]);
  });

  it('sorts quote fields via the shared column sort values', () => {
    const desc: ScreenerSort = { key: 'changePercent', dir: 'desc' };
    expect(sortResults(universe, desc, quotes).map((s) => s.symbol)).toEqual([
      'DDD',
      'AAA',
      'CCC',
      'BBB',
    ]);
    const byVolume: ScreenerSort = { key: 'volume', dir: 'asc' };
    expect(sortResults(universe, byVolume, quotes).map((s) => s.symbol)).toEqual([
      'CCC',
      'BBB',
      'AAA',
      'DDD',
    ]);
  });

  it('does not mutate the input', () => {
    const rows = [...universe];
    sortResults(rows, { key: 'symbol', dir: 'desc' }, quotes);
    expect(rows.map((s) => s.symbol)).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
  });

  it('computed keys: turnover, |change %| and day range', () => {
    // AAA: 250 × 1M = 250M; DDD: 5.5 × 2M = 11M; BBB: 50 × 500 = 25k.
    const byTurnover: ScreenerSort = { key: 'turnover', dir: 'desc' };
    expect(sortResults(universe, byTurnover, quotes).map((s) => s.symbol)).toEqual([
      'AAA',
      'DDD',
      'BBB',
      'CCC', // volume 0 → turnover 0 (a number, so not sorted last)
    ]);
    const movers: ScreenerSort = { key: 'absChangePercent', dir: 'desc' };
    expect(sortResults(universe, movers, quotes).map((s) => s.symbol)).toEqual([
      'DDD',
      'AAA',
      'BBB',
      'CCC',
    ]);
  });

  it('dayRangePct and turnover derive from the quote', () => {
    const ranged = quote('EEE', { last: 100, dayLow: 95, dayHigh: 105, volume: 2 });
    expect(dayRangePct(ranged)).toBeCloseTo(10);
    expect(turnover(ranged)).toBe(200);
    expect(dayRangePct(undefined)).toBeNull();
    expect(turnover(quote('EEE', { last: 100 }))).toBeNull();
  });
});

describe('paging', () => {
  const rows = [1, 2, 3, 4, 5] as never[];
  it('pageCount and clampPage', () => {
    expect(pageCount(45, 20)).toBe(3);
    expect(pageCount(0, 20)).toBe(1);
    expect(pageCount(45, null)).toBe(1);
    expect(clampPage(9, 45, 20)).toBe(2);
    expect(clampPage(-2, 45, 20)).toBe(0);
  });
  it('pageResults slices; null pageSize = everything', () => {
    expect(pageResults(rows, 0, 2)).toEqual([1, 2]);
    expect(pageResults(rows, 2, 2)).toEqual([5]);
    expect(pageResults(rows, 9, 2)).toEqual([]);
    expect(pageResults(rows, 1, null)).toEqual(rows);
  });
});

describe('slices', () => {
  it('scanSlice takes the top N (null = all)', () => {
    expect(scanSlice([1, 2, 3] as never[], 2)).toEqual([1, 2]);
    expect(scanSlice([1, 2, 3] as never[], null)).toHaveLength(3);
  });

  it('effectiveUniverseSize auto-expands to cover the page size', () => {
    expect(effectiveUniverseSize(20, 100)).toBe(100);
    expect(effectiveUniverseSize(100, 100)).toBe(100);
    expect(effectiveUniverseSize(100, 50)).toBe(100);
    expect(effectiveUniverseSize(250, 100)).toBe(250);
    expect(effectiveUniverseSize(null, 50)).toBeNull();
    expect(effectiveUniverseSize(20, null)).toBeNull();
    expect(effectiveUniverseSize(400, 100)).toBeNull(); // only "all" covers it
  });
});

/** A class of 300 symbols: even ranks are Tech, the rest Energy. */
const big = Array.from({ length: 300 }, (_, i) => ({
  ...sym(`S${i + 1}`, i % 2 === 0 ? 'Tech' : 'Energy', i % 3 === 0 ? 'NYSE' : 'NASDAQ', 300 - i),
  rank: i + 1,
}));

describe('scanPlan (static filters see the whole universe)', () => {
  it('finds a static match far outside the top-N slice', () => {
    // S250 is far past a "top 100" slice; the old slice-then-filter pipeline lost it.
    const plan = scanPlan(big, { ...EMPTY_FILTERS, search: 's250' }, 100);
    expect(plan.candidates.map((s) => s.symbol)).toEqual(['S250']);
    expect(plan.scanned.map((s) => s.symbol)).toEqual(['S250']);
  });

  it('applies the subscription limit to the filtered set, by rank', () => {
    const plan = scanPlan(big, { ...EMPTY_FILTERS, group: 'Energy' }, 100);
    expect(plan.candidates).toHaveLength(150);
    expect(plan.scanned).toHaveLength(100);
    // Energy symbols are the odd positions: ranks 2, 4, 6…
    expect(plan.scanned.slice(0, 3).map((s) => s.rank)).toEqual([2, 4, 6]);
    expect(plan.scanned.at(-1)!.rank).toBe(200);
  });

  it('combines group, exchange and search before slicing', () => {
    const plan = scanPlan(big, { ...EMPTY_FILTERS, group: 'Tech', exchange: 'NYSE' }, 10);
    expect(plan.candidates.every((s) => s.group === 'Tech' && s.exchange === 'NYSE')).toBe(true);
    expect(plan.scanned).toHaveLength(10);
  });

  it('size null scans every candidate; no filters keep the rank prefix', () => {
    expect(scanPlan(big, EMPTY_FILTERS, null).scanned).toHaveLength(300);
    expect(scanPlan(big, EMPTY_FILTERS, 100).scanned.map((s) => s.rank)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
  });

  it('quote-bound filters never shrink the subscription set', () => {
    const plan = scanPlan(big, { ...EMPTY_FILTERS, priceMin: 10, chgMin: 1, volMin: 5 }, 100);
    expect(plan.candidates).toHaveLength(300);
    expect(plan.scanned).toHaveLength(100);
  });
});

describe('static vs live filter stages', () => {
  it('applyStaticFilters ignores quote bounds; applyLiveFilters ignores static fields', () => {
    const f = { ...EMPTY_FILTERS, group: 'Tech', priceMin: 100 };
    expect(applyStaticFilters(universe, f).map((s) => s.symbol)).toEqual(['AAA', 'BBB']);
    expect(applyLiveFilters(universe, quotes, f).map((s) => s.symbol)).toEqual(['AAA']);
    expect(applyLiveFilters(universe, quotes, { ...EMPTY_FILTERS, group: 'Health' })).toHaveLength(
      4,
    );
  });

  it('quote-bound filters drop symbols without a quote', () => {
    const f = { ...EMPTY_FILTERS, chgMin: 0 };
    expect(applyLiveFilters(universe, {}, f)).toEqual([]);
    expect(hasQuoteFilters(f)).toBe(true);
    expect(hasQuoteFilters({ ...EMPTY_FILTERS, group: 'Tech', capMin: 5 })).toBe(false);
  });

  it('the static cap pre-filter is loose (stale snapshot), the exact check is live', () => {
    // 40 is below 50 but above the 50 % slack: it must survive the static stage…
    const row = { ...sym('LIVE', 'Tech', 'NYSE', 40), rank: 1 };
    const f = { ...EMPTY_FILTERS, capMin: 50 };
    expect(applyStaticFilters([row], f)).toHaveLength(1);
    // …and the exact check uses the live market cap (in dollars) when there is one.
    const live = { LIVE: quote('LIVE', { ...({ marketCap: 80e9 } as object) }) };
    expect(applyLiveFilters([row], live, f, 'mcap')).toHaveLength(1);
    // without a live cap the static value decides: 40 < 50
    expect(applyLiveFilters([row], {}, f, 'mcap')).toHaveLength(0);
    // AUM classes never take a quote's market cap
    expect(applyLiveFilters([row], live, f, 'aum')).toHaveLength(0);
  });
});

describe('live cap, 52-week range and relative volume', () => {
  const row = { ...sym('CAP', 'Tech', 'NYSE', 100), rank: 1 };
  it('effectiveCap prefers the live market cap for market-cap classes', () => {
    const q = quote('CAP', { ...({ marketCap: 250e9 } as object) });
    expect(liveCapBillions(q)).toBe(250);
    expect(effectiveCap(row, q, 'mcap')).toBe(250);
    expect(effectiveCap(row, q, 'aum')).toBe(100);
    expect(effectiveCap(row, undefined, 'mcap')).toBe(100);
    expect(effectiveCap({}, undefined, 'mcap')).toBeNull();
  });

  it('sorts by live cap, and by static cap separately', () => {
    const a = { ...sym('A', 'Tech', 'NYSE', 10), rank: 1 };
    const b = { ...sym('B', 'Tech', 'NYSE', 20), rank: 2 };
    const qs = { A: quote('A', { ...({ marketCap: 50e9 } as object) }) };
    const byLive = sortResults([a, b], { key: 'liveCap', dir: 'desc' }, qs, 'mcap');
    expect(byLive.map((s) => s.symbol)).toEqual(['A', 'B']);
    const byStatic = sortResults([a, b], { key: 'cap', dir: 'desc' }, qs, 'mcap');
    expect(byStatic.map((s) => s.symbol)).toEqual(['B', 'A']);
  });

  it('week52Pos and relVolume read optional fields defensively', () => {
    const q = quote('X', {
      last: 150,
      volume: 3000,
      ...({ fiftyTwoWeekLow: 100, fiftyTwoWeekHigh: 200, averageVolume: 1000 } as object),
    });
    expect(week52Pos(q)).toBe(0.5);
    expect(relVolume(q)).toBe(3);
    expect(
      week52Pos(
        quote('X', { last: 500, ...({ fiftyTwoWeekLow: 1, fiftyTwoWeekHigh: 2 } as object) }),
      ),
    ).toBe(1);
    expect(week52Pos(quote('X', { last: 5 }))).toBeNull();
    expect(week52Pos(undefined)).toBeNull();
    expect(relVolume(quote('X', { volume: 5 }))).toBeNull();
    expect(relVolume(quote('X', { volume: 5, ...({ averageVolume: 0 } as object) }))).toBeNull();
  });

  it('dayRangePct falls back to open, then prevClose, without day high/low', () => {
    expect(dayRangePct(quote('X', { last: 100, prevClose: 90 }))).toBeCloseTo(10);
    expect(
      dayRangePct(quote('X', { last: 100, prevClose: 90, ...({ open: 96 } as object) })),
    ).toBeCloseTo(4);
    // real bounds win over the fallback
    expect(
      dayRangePct(quote('X', { last: 100, prevClose: 90, dayLow: 99, dayHigh: 101 })),
    ).toBeCloseTo(2);
    expect(dayRangePct(quote('X', { last: 100 }))).toBeNull();
    const volatile: ScreenerSort = { key: 'dayRangePct', dir: 'desc' };
    const rows = [sym('P'), sym('Q')].map((s, i) => ({ ...s, rank: i + 1 }));
    const qs = {
      P: quote('P', { last: 100, prevClose: 99 }),
      Q: quote('Q', { last: 100, prevClose: 90 }),
    };
    expect(sortResults(rows, volatile, qs).map((s) => s.symbol)).toEqual(['Q', 'P']);
  });
});

describe('invalidRanges and sanitizeFilters', () => {
  it('flags bound pairs whose minimum exceeds the maximum', () => {
    expect(invalidRanges(EMPTY_FILTERS)).toEqual([]);
    expect(invalidRanges({ ...EMPTY_FILTERS, priceMin: 10, priceMax: 5 })).toEqual(['price']);
    expect(
      invalidRanges({ ...EMPTY_FILTERS, chgMin: 3, chgMax: -3, volMin: 10, volMax: 10 }),
    ).toEqual(['chg']);
    expect(invalidRanges({ ...EMPTY_FILTERS, priceMin: 5 })).toEqual([]);
  });

  it('drops a saved group or exchange the universe no longer has', () => {
    const u = buildUniverse('stocks', 'sector', 'mcap', [['A', 'Alpha', 'Tech', 'NYSE', 5]]);
    const stale = { ...EMPTY_FILTERS, group: 'Gone', exchange: 'LSE', chgMin: 1 };
    expect(sanitizeFilters(stale, u)).toEqual({ ...EMPTY_FILTERS, chgMin: 1 });
    const ok = { ...EMPTY_FILTERS, group: 'Tech', exchange: 'NYSE' };
    expect(sanitizeFilters(ok, u)).toBe(ok); // unchanged identity: no needless state writes
  });
});
