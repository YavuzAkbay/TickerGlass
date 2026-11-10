import { describe, expect, it } from 'vitest';
import type { LiveQuote } from '../../quotes/types';
import { emptyQuote } from '../../quotes/merge';
import type { ColumnId } from '../types';
import { csvFilename, exportOrder, watchlistCsv } from './pageCsv';

const ALL: ColumnId[] = [
  'name',
  'last',
  'change',
  'changePercent',
  'volume',
  'dayRange',
  'extPrice',
  'extChangePercent',
];

const q = (symbol: string, o: Partial<LiveQuote>): LiveQuote => ({ ...emptyQuote(symbol), ...o });

describe('watchlistCsv', () => {
  it('writes snapshot columns from the snapshot rows, empty without one', () => {
    const csv = watchlistCsv(['AAPL', 'ZZZ'], {}, {}, ['perf1m', 'rsi14', 'nextEarnings'], {
      AAPL: { perf1m: 5.5, rsi14: 28.4, nextEarnings: Date.UTC(2026, 0, 30, 14) / 1000 },
    });
    expect(csv.split('\n')).toEqual([
      'Symbol,1M Performance %,RSI 14,Next Earnings',
      'AAPL,5.5,28.4,2026-01-30',
      'ZZZ,,,',
    ]);
  });

  it('writes headers and one row per symbol with raw numbers', () => {
    const csv = watchlistCsv(
      ['AAPL'],
      { AAPL: q('AAPL', { last: 232.5, change: 2.75, changePercent: 1.2, volume: 42_000_000 }) },
      { AAPL: { name: 'Apple', exchange: 'NASDAQ', type: 'equity' } },
      ALL,
    );
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      'Symbol,Name,Last,Change,Change %,Volume,Day Low,Day High,Ext Price,Ext Change %',
    );
    expect(lines[1]).toContain('AAPL,Apple,232.5,2.75,1.2,42000000');
  });

  it('leaves missing values empty', () => {
    const csv = watchlistCsv(['AAPL'], { AAPL: undefined }, {}, ALL);
    // Symbol + 9 empty columns (10 fields, 9 separators).
    expect(csv.split('\n')[1]).toBe('AAPL' + ','.repeat(9));
  });

  it('guards formula-injecting names (symbols starting with a letter stay untouched)', () => {
    const csv = watchlistCsv(
      ['EUR=X'],
      {},
      { 'EUR=X': { name: '=SUM(A1)', exchange: null, type: 'currency' } },
      ALL,
    );
    expect(csv.split('\n')[1]).toBe(`EUR=X,'=SUM(A1)` + ','.repeat(8));
  });
});

describe('watchlistCsv columns', () => {
  const quote = q('AAPL', {
    last: 110,
    prevClose: 100,
    open: 102,
    volume: 3_000_000,
    averageVolume: 1_000_000,
    fiftyTwoWeekLow: 80,
    fiftyTwoWeekHigh: 120,
    marketCap: 3.1e12,
  });

  it('follows the visible column order, one header per registry header', () => {
    const csv = watchlistCsv(['AAPL'], { AAPL: quote }, {}, ['changePercent', 'last']);
    expect(csv.split('\n')).toEqual(['Symbol,Change %,Last', 'AAPL,,110']);
  });

  it('writes the new columns and skips the sparkline', () => {
    const cols: ColumnId[] = [
      'trend',
      'open',
      'gapPercent',
      'relVolume',
      'avgVolume',
      'marketCap',
      'week52Range',
      'pctFrom52High',
    ];
    const lines = watchlistCsv(['AAPL'], { AAPL: quote }, {}, cols).split('\n');
    expect(lines[0]).toBe(
      'Symbol,Open,Gap %,Relative Volume,Avg Volume,Market Cap,52W Low,52W High,% From 52W High',
    );
    expect(lines[1]).toBe('AAPL,102,2,3,1000000,3100000000000,80,120,-8.333333');
  });

  it('leaves columns the source lacks empty', () => {
    const lines = watchlistCsv(['AAPL'], { AAPL: q('AAPL', { last: 1 }) }, {}, [
      'relVolume',
      'marketCap',
    ]).split('\n');
    expect(lines[1]).toBe('AAPL,,');
  });
});

describe('csvFilename', () => {
  it('sanitizes the list name and appends the UTC date', () => {
    expect(csvFilename('My List/2026', new Date('2026-01-05T00:00:00Z'))).toBe(
      'My List_2026_2026-01-05.csv',
    );
    expect(csvFilename('  ', new Date('2026-01-05T00:00:00Z'))).toBe('watchlist_2026-01-05.csv');
  });
});

describe('exportOrder', () => {
  it('follows the displayed order, then appends rows the table hides', () => {
    expect(exportOrder(['C', 'A'], ['A', 'B', 'C', 'D'])).toEqual(['C', 'A', 'B', 'D']);
  });
  it('drops stale or duplicate shown entries', () => {
    expect(exportOrder(['X', 'B', 'B', 'A'], ['A', 'B'])).toEqual(['B', 'A']);
  });
  it('falls back to the view when nothing is displayed', () => {
    expect(exportOrder([], ['A', 'B'])).toEqual(['A', 'B']);
  });
});
