import { describe, expect, it } from 'vitest';
import { serverScreenerCsv } from './screenerCsv';
import type { ScanRow } from './server/types';

const row = (symbol: string, values: ScanRow['values'], over: Partial<ScanRow> = {}): ScanRow => ({
  symbol,
  name: `${symbol} Inc`,
  cls: 'stocks',
  group: 'Tech',
  exchange: 'NASDAQ',
  stale: false,
  values,
  ...over,
});

describe('serverScreenerCsv', () => {
  it('writes the visible columns in table order, symbol first', () => {
    const csv = serverScreenerCsv(
      [
        row('AAA', {
          last: 10.5,
          chg1d: -1.25,
          rsi14: 28.4,
          mcap: 2e10,
          nextEarnings: 1_790_000_000,
          sector: 'Technology',
        }),
        row('BBB', { last: null }, { name: '=cmd()' }),
      ],
      [
        'name',
        'last',
        'trend',
        'changePercent',
        'rsi14',
        'mcap',
        'nextEarnings',
        'sector',
        'dayRange',
      ],
    );
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      'Symbol,Name,Last,Change %,RSI (14),Market Cap (USD),Next Earnings,Sector',
    );
    expect(lines[1]).toBe('AAA,AAA Inc,10.5,-1.25,28.4,20000000000,2026-09-21,Technology');
    // Formula injection guard on text, empty cells for missing values.
    expect(lines[2]).toBe("BBB,'=cmd(),,,,,,");
  });
});
