import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyQuote } from '../../quotes/merge';
import type { LiveQuote } from '../../quotes/types';
import type { SnapshotRow } from '../../screener/server/snapshot';
import { setFormatLocale } from '../../sidebar/format';
import { buildRows } from '../model';
import type { ColumnId, Row } from '../types';
import {
  COLUMN_DEFS,
  COLUMN_LIST,
  PAGE_COLUMN_IDS,
  SIDEBAR_COLUMNS,
  SNAPSHOT_COLUMNS,
  canonicalColumns,
  gapPercent,
  isSnapshotColumn,
  isUnavailable,
  moveColumn,
  normalizeColumns,
  pctFrom52High,
  relativeVolume,
  sortableFor,
  toggleInOrder,
  unavailableColumns,
  week52Position,
} from './registry';

const q = (o: Partial<LiveQuote>): LiveQuote => ({ ...emptyQuote('X'), ...o });
const cell = (id: ColumnId, quote: LiveQuote | undefined, surface: 'sidebar' | 'page' = 'page') =>
  COLUMN_DEFS[id].cell({ q: quote, meta: undefined, surface });

afterEach(() => setFormatLocale());

describe('registry shape', () => {
  it('defines every column once', () => {
    const ids = COLUMN_LIST.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of COLUMN_LIST) expect(COLUMN_DEFS[d.id]).toBe(d);
  });

  it('keeps the original sidebar and page sets and orders', () => {
    expect(SIDEBAR_COLUMNS.slice(0, 6)).toEqual([
      'last',
      'change',
      'changePercent',
      'volume',
      'extPrice',
      'extChangePercent',
    ]);
    expect(SIDEBAR_COLUMNS).not.toContain('name');
    expect(SIDEBAR_COLUMNS).not.toContain('dayRange');
    expect(SIDEBAR_COLUMNS.at(-1)).toBe('trend');
    expect(PAGE_COLUMN_IDS[0]).toBe('name');
    expect(PAGE_COLUMN_IDS).toContain('dayRange');
  });

  it('sorts by symbol plus the data columns, never the drawn ones', () => {
    expect(sortableFor('page')).not.toContain('dayRange');
    expect(sortableFor('page')).not.toContain('trend');
    expect(sortableFor('sidebar')).not.toContain('name');
    expect(sortableFor('page')).toEqual(
      expect.arrayContaining(['name', 'gapPercent', 'week52Range']),
    );
  });

  it('every column has a header text, widths and csv headers matching its values', () => {
    for (const d of COLUMN_LIST) {
      expect(d.short).not.toBe('');
      expect(d.width.page).not.toBe('');
      expect(d.csv.values(q({}), undefined)).toHaveLength(d.csv.headers.length);
    }
  });
});

describe('derived values', () => {
  it('gap % is open vs previous close', () => {
    expect(gapPercent(q({ open: 102, prevClose: 100 }))).toBeCloseTo(2);
    expect(gapPercent(q({ open: 98, prevClose: 100 }))).toBeCloseTo(-2);
    expect(gapPercent(q({ open: 98, prevClose: 0 }))).toBeNull();
    expect(gapPercent(q({ open: null, prevClose: 100 }))).toBeNull();
  });

  it('relative volume needs a positive average', () => {
    expect(relativeVolume(q({ volume: 300, averageVolume: 100 }))).toBe(3);
    expect(relativeVolume(q({ volume: 300, averageVolume: 0 }))).toBeNull();
    expect(relativeVolume(q({ volume: 300, averageVolume: null }))).toBeNull();
  });

  it('52-week position is clamped and needs a real range', () => {
    expect(week52Position(q({ last: 100, fiftyTwoWeekLow: 80, fiftyTwoWeekHigh: 120 }))).toBe(0.5);
    expect(week52Position(q({ last: 130, fiftyTwoWeekLow: 80, fiftyTwoWeekHigh: 120 }))).toBe(1);
    expect(
      week52Position(q({ last: 100, fiftyTwoWeekLow: 120, fiftyTwoWeekHigh: 120 })),
    ).toBeNull();
    expect(week52Position(q({ last: 100 }))).toBeNull();
  });

  it('percent from the 52-week high', () => {
    expect(pctFrom52High(q({ last: 90, fiftyTwoWeekHigh: 100 }))).toBeCloseTo(-10);
    expect(pctFrom52High(q({ last: 90, fiftyTwoWeekHigh: 0 }))).toBeNull();
  });
});

describe('cells', () => {
  it('formats the existing columns as before', () => {
    expect(cell('last', q({ last: 232.5 })).text).toBe('232.50');
    expect(cell('last', undefined).text).toBe('—');
    expect(cell('changePercent', q({ changePercent: 1.234 }))).toMatchObject({
      text: '+1.23%',
      className: 'up',
    });
    expect(cell('change', q({ change: -0.5 }))).toMatchObject({ text: '−0.50', className: 'down' });
    expect(cell('change', undefined).text).toBe('');
    expect(cell('volume', q({ volume: 4_500_000 })).text).toBe('4.50M');
    expect(cell('extPrice', q({})).text).toBe('');
  });

  it('shows the currency mark on page price cells of non-USD quotes only', () => {
    setFormatLocale('en-US');
    const eur = q({ last: 10, open: 9, currency: 'EUR' });
    expect(cell('last', eur, 'page').text).toBe('€10.00');
    expect(cell('open', eur, 'page').text).toBe('€9.00');
    expect(cell('last', eur, 'sidebar').text).toBe('10.00');
    expect(cell('last', q({ last: 10, currency: 'USD' }), 'page').text).toBe('10.00');
    expect(cell('last', q({ last: 10, currency: null }), 'page').text).toBe('10.00');
    expect(cell('last', q({ last: 10, currency: 'GBp' }), 'page').text).toBe('p10.00');
    // Changes are not prices.
    expect(cell('change', q({ change: 1, currency: 'EUR' }), 'page').text).toBe('+1.00');
  });

  it('formats market cap compactly', () => {
    expect(cell('marketCap', q({ marketCap: 1.2e12 })).text).toBe('$1.2T');
    expect(cell('marketCap', q({ marketCap: 3.5e11 })).text).toBe('$350B');
    expect(cell('marketCap', q({ marketCap: 4.25e7 })).text).toBe('$42.5M');
    expect(cell('marketCap', q({ marketCap: null })).text).toBe('—');
  });

  it('highlights relative volume at 2x and above', () => {
    expect(cell('relVolume', q({ volume: 250, averageVolume: 100 }))).toMatchObject({
      text: '2.50x',
      className: 'hot',
    });
    expect(cell('relVolume', q({ volume: 199, averageVolume: 100 })).className).toBeUndefined();
    expect(cell('relVolume', q({ volume: 100, averageVolume: null })).text).toBe('—');
  });

  it('gap % and % from high carry direction', () => {
    expect(cell('gapPercent', q({ open: 103, prevClose: 100 }))).toMatchObject({
      text: '+3.00%',
      className: 'up',
    });
    expect(cell('pctFrom52High', q({ last: 90, fiftyTwoWeekHigh: 100 })).text).toBe('−10.00%');
  });

  it('range cells carry the marker position and the low-high tooltip', () => {
    const quote = q({
      last: 110,
      changePercent: 1,
      dayLow: 100,
      dayHigh: 120,
      fiftyTwoWeekLow: 50,
      fiftyTwoWeekHigh: 150,
    });
    expect(cell('dayRange', quote)).toMatchObject({
      bar: { pos: 0.5, tone: 'up' },
      title: '100.00 – 120.00',
    });
    expect(cell('week52Range', quote)).toMatchObject({
      bar: { pos: 0.6, tone: 'up' },
      title: '52W 50.00 – 150.00',
    });
    expect(cell('week52Range', q({ last: 1 })).bar).toEqual({ pos: null, tone: '' });
  });

  it('uses the browser locale for numbers', () => {
    setFormatLocale('de-DE');
    expect(cell('last', q({ last: 1234.5 })).text).toBe('1.234,50');
  });
});

describe('sort accessors', () => {
  it('return null for missing data and the numeric value otherwise', () => {
    expect(COLUMN_DEFS.marketCap.accessor(q({ marketCap: 5 }), undefined)).toBe(5);
    expect(COLUMN_DEFS.marketCap.accessor(q({}), undefined)).toBeNull();
    expect(
      COLUMN_DEFS.name.accessor(undefined, { name: 'Apple', exchange: null, type: null }),
    ).toBe('Apple');
    expect(COLUMN_DEFS.name.accessor(undefined, undefined)).toBeNull();
  });

  it('buildRows sorts by a registry column with missing values last in both directions', () => {
    const items = ['A', 'B', 'C', 'D'].map((symbol) => ({ type: 'symbol' as const, symbol }));
    const quotes = {
      A: q({ symbol: 'A', volume: 300, averageVolume: 100 }),
      B: q({ symbol: 'B' }),
      C: q({ symbol: 'C', volume: 100, averageVolume: 100 }),
      D: q({ symbol: 'D', volume: 200, averageVolume: 100 }),
    };
    const order = (rows: Row[]) => rows.map((r) => (r.kind === 'symbol' ? r.symbol : '#'));
    expect(order(buildRows(items, { key: 'relVolume', dir: 'desc' }, quotes))).toEqual([
      'A',
      'D',
      'C',
      'B',
    ]);
    expect(order(buildRows(items, { key: 'relVolume', dir: 'asc' }, quotes))).toEqual([
      'C',
      'D',
      'A',
      'B',
    ]);
  });
});

describe('column list helpers', () => {
  it('normalizeColumns keeps order, drops unknown/foreign/repeated ids', () => {
    expect(normalizeColumns(['trend', 'name', 'x', 'name', 'last'], 'page')).toEqual([
      'trend',
      'name',
      'last',
    ]);
    expect(normalizeColumns(['name', 'dayRange', 'last'], 'sidebar')).toEqual(['last']);
    expect(normalizeColumns('nope', 'page')).toEqual([]);
  });

  it('canonicalColumns sorts into the surface order', () => {
    expect(canonicalColumns(['trend', 'volume', 'last'], 'sidebar')).toEqual([
      'last',
      'volume',
      'trend',
    ]);
  });

  it('toggleInOrder inserts after the canonical predecessor and removes in place', () => {
    expect(toggleInOrder(['last', 'trend'], 'volume', 'sidebar')).toEqual([
      'last',
      'volume',
      'trend',
    ]);
    expect(toggleInOrder(['last', 'volume', 'trend'], 'volume', 'sidebar')).toEqual([
      'last',
      'trend',
    ]);
    expect(toggleInOrder([], 'trend', 'sidebar')).toEqual(['trend']);
    expect(toggleInOrder(['last'], 'name', 'sidebar')).toEqual(['last']);
  });

  it('moveColumn moves within bounds and ignores unknown ids', () => {
    const cols: ColumnId[] = ['name', 'last', 'volume'];
    expect(moveColumn(cols, 'volume', 0)).toEqual(['volume', 'name', 'last']);
    expect(moveColumn(cols, 'name', 99)).toEqual(['last', 'volume', 'name']);
    expect(moveColumn(cols, 'trend', 0)).toEqual(cols);
  });
});

describe('availability', () => {
  const loaded = (o: Partial<LiveQuote>) => q({ prevClose: 100, ...o });

  it('is unavailable when every snapshot-backed quote has null for a required field', () => {
    const quotes = [
      loaded({ averageVolume: null }),
      loaded({ averageVolume: null }),
      loaded({ averageVolume: null }),
    ];
    expect(isUnavailable(COLUMN_DEFS.avgVolume, quotes)).toBe(true);
    expect(unavailableColumns(['last', 'avgVolume', 'relVolume'], quotes)).toEqual([
      'avgVolume',
      'relVolume',
    ]);
  });

  it('needs at least three snapshot-backed quotes: one or two bare symbols prove nothing', () => {
    const none = loaded({ averageVolume: null });
    expect(isUnavailable(COLUMN_DEFS.avgVolume, [none])).toBe(false);
    expect(isUnavailable(COLUMN_DEFS.avgVolume, [none, none])).toBe(false);
    expect(isUnavailable(COLUMN_DEFS.avgVolume, [none, none, none, undefined, q({})])).toBe(true);
  });

  it('treats an absent (undefined) field like null', () => {
    const missing = () => {
      const x = loaded({});
      delete (x as Partial<LiveQuote>).averageVolume;
      return x;
    };
    expect(isUnavailable(COLUMN_DEFS.avgVolume, [missing(), missing(), missing()])).toBe(true);
    expect(
      isUnavailable(COLUMN_DEFS.avgVolume, [missing(), missing(), loaded({ averageVolume: 3 })]),
    ).toBe(false);
  });

  it('is available as soon as one row has the data', () => {
    expect(
      isUnavailable(COLUMN_DEFS.avgVolume, [
        loaded({ averageVolume: null }),
        loaded({ averageVolume: 5 }),
      ]),
    ).toBe(false);
  });

  it('stays pending before any snapshot arrived (tick-only quotes, no quotes)', () => {
    expect(isUnavailable(COLUMN_DEFS.avgVolume, [q({ last: 1 })])).toBe(false);
    expect(isUnavailable(COLUMN_DEFS.avgVolume, [undefined])).toBe(false);
    expect(isUnavailable(COLUMN_DEFS.avgVolume, [])).toBe(false);
  });

  it('columns with no requirements are never unavailable', () => {
    expect(isUnavailable(COLUMN_DEFS.last, [loaded({})])).toBe(false);
  });
});

describe('snapshot columns', () => {
  const SNAP_IDS = ['perf1m', 'perfYtd', 'perf1y', 'rsi14', 'pctVsSma200', 'nextEarnings'] as const;
  const day = 86_400;
  const NOW = Date.UTC(2026, 0, 20, 15, 0, 0);
  const at = (days: number) => Math.floor(NOW / 1000 / day) * day + days * day + 14 * 3600;
  const snapCell = (id: ColumnId, snap?: SnapshotRow) =>
    COLUMN_DEFS[id].cell({ q: undefined, meta: undefined, snap, surface: 'page' });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('are opt-in on both surfaces, flagged as snapshot-backed, and sort', () => {
    expect([...SNAPSHOT_COLUMNS]).toEqual([...SNAP_IDS]);
    for (const id of SNAP_IDS) {
      expect(COLUMN_DEFS[id].snapshot).toBe(true);
      expect(SIDEBAR_COLUMNS).toContain(id);
      expect(PAGE_COLUMN_IDS).toContain(id);
      expect(sortableFor('sidebar')).toContain(id);
      expect(isSnapshotColumn(id)).toBe(true);
    }
    expect(isSnapshotColumn('last')).toBe(false);
    expect(SIDEBAR_COLUMNS.at(-1)).toBe('trend');
  });

  it('accessors read the snapshot row and put missing values last', () => {
    const snap: SnapshotRow = { perf1m: 5.5, perfYtd: null, rsi14: 28.4, nextEarnings: at(3) };
    expect(COLUMN_DEFS.perf1m.accessor(undefined, undefined, snap)).toBe(5.5);
    expect(COLUMN_DEFS.perfYtd.accessor(undefined, undefined, snap)).toBeNull();
    expect(COLUMN_DEFS.perf1y.accessor(undefined, undefined, snap)).toBeNull();
    expect(COLUMN_DEFS.rsi14.accessor(undefined, undefined, undefined)).toBeNull();
    expect(COLUMN_DEFS.nextEarnings.accessor(undefined, undefined, snap)).toBe(at(3));
    const rows = (dir: 'asc' | 'desc') =>
      buildRows(
        ['A', 'B', 'C'].map((symbol) => ({ type: 'symbol' as const, symbol })),
        { key: 'rsi14', dir },
        {},
        true,
        undefined,
        {},
        { A: { rsi14: 60 }, C: { rsi14: 20 } },
      ).map((r: Row) => (r.kind === 'symbol' ? r.symbol : ''));
    expect(rows('asc')).toEqual(['C', 'A', 'B']);
    expect(rows('desc')).toEqual(['A', 'C', 'B']);
  });

  it('formats performance and distance as signed percents', () => {
    expect(snapCell('perf1m', { perf1m: 5.5 }).text).toBe('+5.50%');
    expect(snapCell('perf1m', { perf1m: 5.5 }).className).toBe('up');
    expect(snapCell('perfYtd', { perfYtd: -12.345 }).className).toBe('down');
    expect(snapCell('pctVsSma200', { pctVsSma200: -3 }).text).toBe('−3.00%');
    expect(snapCell('perf1y', undefined).text).toBe('—');
    expect(snapCell('perf1y', { perf1y: null }).text).toBe('—');
  });

  it('marks RSI extremes with an arrow, not only a colour', () => {
    expect(snapCell('rsi14', { rsi14: 28.44 })).toMatchObject({
      text: '↓ 28.4',
      className: 'down',
    });
    expect(snapCell('rsi14', { rsi14: 71 })).toMatchObject({ text: '↑ 71.0', className: 'up' });
    const mid = snapCell('rsi14', { rsi14: 50 });
    expect(mid.text).toBe('50.0');
    expect(mid.className).toBeUndefined();
    expect(snapCell('rsi14', { rsi14: 30 }).text).toBe('30.0');
    expect(snapCell('rsi14', {}).text).toBe('—');
  });

  it('shows the earnings date with a days tooltip and highlights the coming week', () => {
    const soon = snapCell('nextEarnings', { nextEarnings: at(3) });
    expect(soon).toMatchObject({ text: 'Jan 23', title: 'in 3 days', className: 'hot' });
    expect(snapCell('nextEarnings', { nextEarnings: at(7) }).className).toBe('hot');
    const later = snapCell('nextEarnings', { nextEarnings: at(8) });
    expect(later).toMatchObject({ text: 'Jan 28', title: 'in 8 days' });
    expect(later.className).toBeUndefined();
    expect(snapCell('nextEarnings', { nextEarnings: at(0) }).title).toBe('today');
    expect(snapCell('nextEarnings', { nextEarnings: at(-2) }).className).toBeUndefined();
    expect(snapCell('nextEarnings', {}).text).toBe('—');
  });

  it('exports numbers and an ISO earnings date, empty when missing', () => {
    const snap: SnapshotRow = { perf1m: 1.23456789, rsi14: 41.5, nextEarnings: at(3) };
    expect(COLUMN_DEFS.perf1m.csv.values(undefined, undefined, snap)).toEqual([1.234568]);
    expect(COLUMN_DEFS.rsi14.csv.values(undefined, undefined, snap)).toEqual([41.5]);
    expect(COLUMN_DEFS.nextEarnings.csv.values(undefined, undefined, snap)).toEqual(['2026-01-23']);
    expect(COLUMN_DEFS.nextEarnings.csv.values(undefined, undefined, undefined)).toEqual([null]);
    expect(COLUMN_DEFS.perfYtd.csv.values(undefined, undefined, undefined)).toEqual([null]);
  });
});
