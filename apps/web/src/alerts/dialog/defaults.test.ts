import { describe, expect, it } from 'vitest';
import { defaultForm, initialForm } from './defaults';
import { formToAlert } from './form';
import type { AlertContext, DrawingSummary } from './sources';

const drawings: DrawingSummary[] = [
  { id: 'tl', type: 'trend-line', paneId: 'main', pointCount: 2, scope: 'symbol', symbol: 'AAPL' },
  {
    id: 'ch',
    type: 'parallel-channel',
    paneId: 'main',
    pointCount: 3,
    scope: 'symbol',
    symbol: 'AAPL',
  },
  {
    id: 'rsiLine',
    type: 'horizontal-line',
    paneId: 'pane_rsi',
    pointCount: 1,
    scope: 'symbol',
    symbol: 'AAPL',
  },
];

const ctx = (o: Partial<AlertContext> = {}): AlertContext => ({
  symbol: 'AAPL',
  interval: '5m',
  prepost: true,
  chartType: 'candles',
  decimals: 2,
  indicators: [
    { id: 'rsi1', type: 'rsi' },
    { id: 'bb', type: 'bollinger' },
  ],
  paneOf: (id) => (id === 'rsi1' ? 'pane_rsi' : 'main'),
  indicatorValue: (id, out) => (id === 'rsi1' && out === 'rsi' ? 61.23456 : undefined),
  drawings,
  scaleOf: (pane) => (pane === 'main' ? 'log' : 'linear'),
  lastPrice: (s) => (s === 'AAPL' ? 190.126 : s === 'MSFT' ? 410.5 : undefined),
  lastBar: null,
  ...o,
});

describe('defaultForm per entry point', () => {
  it('toolbar / panel "+": close crossing the last price, chart symbol and interval', () => {
    const f = defaultForm({}, ctx());
    expect(f).toMatchObject({
      symbol: 'AAPL',
      interval: '5m',
      prepost: true,
      left: { kind: 'price', field: 'close' },
      op: 'crossing',
      right: { kind: 'value', text: '190.13' },
      trigger: 'once',
      status: 'active',
    });
    const r = formToAlert(f);
    expect(r.ok).toBe(true);
  });

  it('price-scale "+" and menus: close crossing the price', () => {
    const f = defaultForm({ price: 185.5, paneId: 'main' }, ctx());
    expect(f.left).toEqual({ kind: 'price', field: 'close' });
    expect(f.right).toEqual({ kind: 'value', text: '185.5' });
  });

  it('on an indicator pane: the pane first indicator output crossing the price', () => {
    const f = defaultForm({ price: 70, paneId: 'pane_rsi' }, ctx());
    expect(f.left).toMatchObject({
      kind: 'indicator',
      ref: { instanceId: 'rsi1', outputId: 'rsi' },
    });
    expect(f.right).toEqual({ kind: 'value', text: '70' });
  });

  it('falls back to close when the indicator pane has no indicator', () => {
    const f = defaultForm({ price: 70, paneId: 'gone' }, ctx());
    expect(f.left).toEqual({ kind: 'price', field: 'close' });
  });

  it('line drawing: close crossing the line, scale from the pane', () => {
    const f = defaultForm({ drawingId: 'tl' }, ctx());
    expect(f.op).toBe('crossing');
    expect(f.left).toEqual({ kind: 'price', field: 'close' });
    expect(f.right).toEqual({
      kind: 'source',
      operand: { kind: 'drawing', drawingId: 'tl', part: 'line', scale: 'log' },
    });
    expect(
      formToAlert(f, {
        drawing: (id) => {
          const d = drawings.find((x) => x.id === id);
          return d ? { ...d, points: new Array<unknown>(d.pointCount) } : null;
        },
      }).ok,
    ).toBe(true);
  });

  it('channel drawing: close entering the channel', () => {
    const f = defaultForm({ drawingId: 'ch' }, ctx());
    expect(f.op).toBe('enteringChannel');
    expect(f.channel).toEqual({ kind: 'drawing', drawingId: 'ch', scale: 'log' });
  });

  it('drawing on an indicator pane uses that pane indicator', () => {
    const f = defaultForm({ drawingId: 'rsiLine' }, ctx());
    expect(f.left).toMatchObject({ kind: 'indicator', ref: { instanceId: 'rsi1' } });
    expect(f.right).toMatchObject({
      kind: 'source',
      operand: { kind: 'drawing', scale: 'linear' },
    });
  });

  it('indicator: first output crossing its last value', () => {
    const f = defaultForm({ indicatorId: 'rsi1' }, ctx());
    expect(f.left).toMatchObject({ kind: 'indicator', ref: { title: 'RSI 14 close RSI' } });
    expect(f.right).toEqual({ kind: 'value', text: '61.2346' });
  });

  it('watchlist row: that symbol at its quote, price source only', () => {
    const f = defaultForm({ symbol: 'MSFT', indicatorId: 'rsi1' }, ctx());
    expect(f.symbol).toBe('MSFT');
    expect(f.left).toEqual({ kind: 'price', field: 'close' });
    expect(f.right).toEqual({ kind: 'value', text: '410.5' });
  });

  it('unknown quote leaves the value empty', () => {
    expect(defaultForm({ symbol: 'ZZZ' }, ctx()).right).toEqual({ kind: 'value', text: '' });
  });
});

describe('initialForm', () => {
  it('returns null for a missing edit or clone', () => {
    expect(initialForm({ editId: 'x' }, ctx(), () => undefined)).toBeNull();
    expect(initialForm({ cloneOf: 'x' }, ctx(), () => undefined)).toBeNull();
  });
});
