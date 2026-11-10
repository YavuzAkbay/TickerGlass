import { describe, expect, it } from 'vitest';
import { emptyQuote } from '../quotes/merge';
import type { Universe } from './universe/types';
import { buildUniverse } from './universe/types';
import { screenerCsv, screenerCsvFilename } from './screenerCsv';
import { SCREENER_ALL_COLUMNS } from './screenerPrefs';

const universe: Universe = buildUniverse('stocks', 'sector', 'mcap', [
  ['AAA', 'Alpha, Inc.', 'Tech', 'NASDAQ', 900],
  ['BBB', '-Weird', 'Tech', 'NYSE'],
]);

describe('screenerCsv', () => {
  const all = [...SCREENER_ALL_COLUMNS];

  it('writes headers, raw numbers and guarded text for every column', () => {
    const csv = screenerCsv(
      universe,
      universe.symbols,
      {
        AAA: {
          ...emptyQuote('AAA'),
          last: 250,
          change: 5,
          changePercent: 2,
          volume: 1000,
          dayLow: 245,
          dayHigh: 252,
          ...({ fiftyTwoWeekLow: 100, fiftyTwoWeekHigh: 300, averageVolume: 500 } as object),
        },
      },
      all,
    );
    const [head, a, b] = csv.split('\n');
    expect(head).toBe(
      'Symbol,Name,Last,Change,Change %,Prev Close,Volume,Rel Volume,Turnover,Day Low,Day High,52W Low,52W High,Pre/Post Change %,Market Cap (approx $B),Market Cap (live $B),Sector,Exchange',
    );
    expect(a).toBe('AAA,"Alpha, Inc.",250,5,2,,1000,2,250000,245,252,100,300,,900,900,Tech,NASDAQ');
    expect(b).toBe("BBB,'-Weird,,,,,,,,,,,,,,,Tech,NYSE"); // formula-guarded name, empty quote cells
  });

  it('writes only the visible columns, in the given column order', () => {
    const csv = screenerCsv(
      universe,
      universe.symbols,
      { AAA: { ...emptyQuote('AAA'), last: 250, changePercent: 2 } },
      ['changePercent', 'name', 'trend', 'last'],
    );
    const [head, a] = csv.split('\n');
    expect(head).toBe('Symbol,Change %,Name,Last'); // `trend` has no tabular value
    expect(a).toBe('AAA,2,"Alpha, Inc.",250');
  });

  it('keeps the given (displayed, sorted) row order', () => {
    const [, ...lines] = screenerCsv(universe, [...universe.symbols].reverse(), {}, ['name']).split(
      '\n',
    );
    expect(lines.map((l) => l.split(',')[0])).toEqual(['BBB', 'AAA']);
  });

  it('prefers the live market cap in the live column, static otherwise', () => {
    const csv = screenerCsv(
      universe,
      universe.symbols,
      { AAA: { ...emptyQuote('AAA'), ...({ marketCap: 1.5e12 } as object) } },
      ['cap', 'liveCap'],
    );
    expect(csv.split('\n')[1]).toBe('AAA,900,1500');
  });

  it('omits the cap columns when the class has none', () => {
    const none = buildUniverse('commodities', 'group', null, [
      ['GC=F', 'Gold', 'Precious Metals', 'COMEX'],
    ]);
    const csv = screenerCsv(none, none.symbols, {}, ['name', 'cap', 'liveCap', 'group']);
    expect(csv.split('\n')[0]).toBe('Symbol,Name,Group');
  });

  it('builds a dated, class-labelled filename', () => {
    expect(screenerCsvFilename('stocks', new Date('2026-01-15T10:00:00Z'))).toBe(
      'Screener-stocks_2026-01-15.csv',
    );
  });
});
