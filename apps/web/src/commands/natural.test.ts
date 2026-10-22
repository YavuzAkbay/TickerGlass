import { describe, expect, it } from 'vitest';
import { parseIntents, type ChartTypeInfo, type IndicatorInfo } from './natural';

const indicators: IndicatorInfo[] = [
  {
    id: 'rsi',
    name: 'Relative Strength Index',
    shortName: 'RSI',
    numeric: [{ key: 'length', label: 'Length', kind: 'int', min: 1, max: 500 }],
  },
  {
    id: 'bb',
    name: 'Bollinger Bands',
    shortName: 'BB',
    numeric: [
      { key: 'length', label: 'Length', kind: 'int', min: 1 },
      { key: 'mult', label: 'StdDev', kind: 'float' },
    ],
  },
  { id: 'vwap', name: 'VWAP', shortName: 'VWAP', numeric: [] },
];
const chartTypes: ChartTypeInfo[] = [
  { id: 'line', label: 'Line' },
  { id: 'heikinAshi', label: 'Heikin Ashi' },
];
const parse = (q: string) => parseIntents(q, { indicators, chartTypes });

describe('parseIntents', () => {
  it('reads intervals in several spellings', () => {
    expect(parse('4h')).toContainEqual({ kind: 'interval', interval: '4h' });
    expect(parse('15 min')).toContainEqual({ kind: 'interval', interval: '15m' });
    expect(parse('1D')).toContainEqual({ kind: 'interval', interval: '1D' });
    expect(parse('1M')).toContainEqual({ kind: 'interval', interval: '1M' });
    expect(parse('1m')).toContainEqual({ kind: 'interval', interval: '1m' });
    expect(parse('weekly')).toContainEqual({ kind: 'interval', interval: '1W' });
    expect(parse('5 lightyears')).toEqual([]);
  });

  it('adds indicators with typed inputs', () => {
    expect(parse('rsi 14')[0]).toEqual({
      kind: 'indicator',
      type: 'rsi',
      name: 'RSI',
      inputs: { length: 14 },
    });
    expect(parse('bollinger 20 2.5')[0]).toMatchObject({
      type: 'bb',
      inputs: { length: 20, mult: 2.5 },
    });
    expect(parse('RSI')[0]).toMatchObject({ type: 'rsi', inputs: {} });
  });

  it('clamps inputs and rejects ones that cannot fit', () => {
    expect(parse('rsi 9000')[0]).toMatchObject({ inputs: { length: 500 } });
    expect(parse('rsi 14.5')).toEqual([]);
    expect(parse('vwap 3')).toEqual([]);
  });

  it('compares symbols', () => {
    expect(parse('compare msft')).toEqual([{ kind: 'compare', symbol: 'MSFT' }]);
    expect(parse('vs BTC-USD')).toEqual([{ kind: 'compare', symbol: 'BTC-USD' }]);
    expect(parse('compare')).toEqual([]);
  });

  it('creates alerts with a direction', () => {
    expect(parse('alert above 200')).toEqual([{ kind: 'alert', price: 200, op: 'crossingUp' }]);
    expect(parse('alert < 99.5')).toEqual([{ kind: 'alert', price: 99.5, op: 'crossingDown' }]);
    expect(parse('alert 150')).toEqual([{ kind: 'alert', price: 150, op: 'crossing' }]);
    expect(parse('alert sideways 1')).toEqual([]);
  });

  it('switches chart types', () => {
    expect(parse('line chart')).toContainEqual({
      kind: 'chartType',
      chartType: 'line',
      label: 'Line',
    });
    expect(parse('heikin ashi')).toContainEqual(
      expect.objectContaining({ chartType: 'heikinAshi' }),
    );
  });
});
