import { describe, expect, it } from 'vitest';
import { buildTable, csvField, dataFilename, makeTimeFormatter, numberCell, toCsv } from './exportData';

const input = () => ({
  time: Float64Array.from([1_705_208_400, 1_705_208_700, 1_705_209_000]), // 2024-01-14 05:00 UTC
  open: Float64Array.from([1, 2, 3]),
  high: Float64Array.from([2, 3, 4]),
  low: Float64Array.from([0, 1, 2]),
  close: Float64Array.from([1.5, 2.5, 3.5]),
  volume: Float64Array.from([10, 20, 30]),
  studies: [] as {
    title: string;
    plots: { id: string; title: string; offset: number }[];
    values: Record<string, Float64Array>;
    length: number;
  }[],
});

describe('buildTable', () => {
  it('lays out OHLCV columns and study plot columns', () => {
    const table = buildTable({
      ...input(),
      studies: [
        {
          title: 'RSI 14 close',
          plots: [{ id: 'rsi', title: 'RSI', offset: 0 }],
          values: { rsi: Float64Array.from([NaN, 51, 49]) },
          length: 3,
        },
        {
          title: 'MACD 12 26 9',
          plots: [
            { id: 'macd', title: 'MACD', offset: 0 },
            { id: 'signal', title: 'Signal', offset: 0 },
          ],
          values: { macd: Float64Array.from([1, 2, 3]), signal: Float64Array.from([0, 1, 2]) },
          length: 3,
        },
      ],
    });
    expect(table.n).toBe(3);
    expect(table.columns.map((c) => c.header)).toEqual([
      'open',
      'high',
      'low',
      'close',
      'volume',
      'RSI 14 close',
      'MACD 12 26 9 MACD',
      'MACD 12 26 9 Signal',
    ]);
  });

  it('deduplicates identical headers', () => {
    const study = () => ({
      title: 'RSI 14 close',
      plots: [{ id: 'rsi', title: 'RSI', offset: 0 }],
      values: { rsi: Float64Array.from([1, 2, 3]) },
      length: 3,
    });
    const table = buildTable({ ...input(), studies: [study(), study()] });
    expect(table.columns.map((c) => c.header)).toEqual([
      'open',
      'high',
      'low',
      'close',
      'volume',
      'RSI 14 close',
      'RSI 14 close (2)',
    ]);
  });
});

describe('toCsv', () => {
  it('writes the header and one row per bar', () => {
    const table = buildTable(input());
    const csv = toCsv(table, () => '2024-01-14 05:00');
    const lines = csv.split('\n');
    expect(lines[0]).toBe('time,open,high,low,close,volume');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('2024-01-14 05:00,1,2,0,1.5,10');
  });

  it('writes an empty field for NaN and missing values', () => {
    const table = buildTable({
      ...input(),
      studies: [
        {
          title: 'RSI 14 close',
          plots: [{ id: 'rsi', title: 'RSI', offset: 0 }],
          values: { rsi: Float64Array.from([NaN, 51, NaN]) },
          length: 3,
        },
      ],
    });
    const lines = toCsv(table, () => 't').split('\n');
    expect(lines[1]).toBe('t,1,2,0,1.5,10,');
    expect(lines[2]).toBe('t,2,3,1,2.5,20,51');
    expect(lines[3]).toBe('t,3,4,2,3.5,30,');
  });

  it('applies the plot offset (value[i - offset])', () => {
    const table = buildTable({
      ...input(),
      studies: [
        {
          title: 'sig',
          plots: [{ id: 's', title: 'S', offset: 1 }],
          values: { s: Float64Array.from([100, 200, 300]) },
          length: 3,
        },
      ],
    });
    const lines = toCsv(table, () => 't').split('\n');
    expect(lines[1]).toBe('t,1,2,0,1.5,10,'); // value 100 draws at bar 1
    expect(lines[2]).toBe('t,2,3,1,2.5,20,100');
    expect(lines[3]).toBe('t,3,4,2,3.5,30,200');
  });

  it('escapes fields with commas, quotes and newlines', () => {
    const table = buildTable({
      ...input(),
      studies: [
        {
          title: 'a,b"c\nd',
          plots: [{ id: 'p', title: 'P', offset: 0 }],
          values: { p: Float64Array.from([1, 2, 3]) },
          length: 3,
        },
      ],
    });
    // The quoted field spans the embedded newline, so it shifts the data rows.
    const lines = toCsv(table, () => 't').split('\n');
    expect(lines[0]).toBe('time,open,high,low,close,volume,"a,b""c');
    expect(lines[1]).toBe('d"');
    expect(lines[2]).toBe('t,1,2,0,1.5,10,1');
  });
});

describe('numberCell', () => {
  it('formats finite numbers and empty for NaN/Infinity', () => {
    expect(numberCell(1.5)).toBe('1.5');
    expect(numberCell(-0.000001)).toBe('-0.000001');
    expect(numberCell(NaN)).toBe('');
    expect(numberCell(Infinity)).toBe('');
  });
});

describe('csvField', () => {
  it('leaves plain text unquoted and quotes special text', () => {
    expect(csvField('AAPL')).toBe('AAPL');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('a"b')).toBe('"a""b"');
  });
});

describe('makeTimeFormatter', () => {
  it('formats UTC intraday bars', () => {
    const fmt = makeTimeFormatter('UTC', true);
    expect(fmt(1_705_208_400)).toBe('2024-01-14 05:00');
  });

  it('formats date-only for day/week/month bars', () => {
    const fmt = makeTimeFormatter('UTC', false);
    expect(fmt(1_705_209_000)).toBe('2024-01-14');
  });

  it('resolves an IANA zone including DST', () => {
    const fmt = makeTimeFormatter('America/New_York', true);
    // 13:30 UTC = 09:30 EDT (UTC-4) in July; 05:00 UTC = 00:00 EST (UTC-5) in January.
    expect(fmt(1_721_050_200)).toBe('2024-07-15 09:30');
    expect(fmt(1_705_208_400)).toBe('2024-01-14 00:00');
  });

  it("supports 'local' (browser zone) without throwing", () => {
    expect(makeTimeFormatter('local', true)(1_705_209_000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('dataFilename', () => {
  it('follows the screenshot filename pattern', () => {
    const date = new Date(Date.UTC(2026, 9, 23, 14, 5));
    expect(dataFilename('AAPL', '1D', 'csv', date)).toBe('AAPL_1D_2026-10-23_14-05.csv');
    expect(dataFilename('BRK/B', '4h', 'xlsx', date)).toBe('BRK_B_4h_2026-10-23_14-05.xlsx');
  });
});
