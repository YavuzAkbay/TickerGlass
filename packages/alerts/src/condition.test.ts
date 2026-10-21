import { describe, expect, it } from 'vitest';
import {
  conditionKind,
  evaluateCondition,
  isPriceAlert,
  orderBounds,
  priceValue,
  seriesKey,
} from './condition';
import type { ChannelOp, Condition, SampleValues } from './types';

const s = (x: number, extra: Partial<SampleValues> = {}): SampleValues => ({
  x,
  open: x,
  high: x,
  low: x,
  close: x,
  volume: 0,
  ...extra,
});

/** Channel sample with bounds computed from the operand values the way the service does. */
const ch = (x: number, u: number, l: number): SampleValues => s(x, orderBounds(u, l));

const channel = (op: ChannelOp): Condition => ({
  op,
  channel: {
    kind: 'bounds',
    upper: { kind: 'value', value: 11 },
    lower: { kind: 'value', value: 9 },
  },
});

describe('orderBounds', () => {
  it('orders and propagates invalid values', () => {
    expect(orderBounds(11, 9)).toEqual({ upper: 11, lower: 9 });
    expect(orderBounds(9, 11)).toEqual({ upper: 11, lower: 9 });
    expect(orderBounds(NaN, 9)).toEqual({ upper: NaN, lower: NaN });
    expect(orderBounds(11, Infinity)).toEqual({ upper: NaN, lower: NaN });
  });

  it.each([
    ['enteringChannel', [8, 9], [false, true]],
    ['exitingChannel', [11, 12], [false, true]],
    ['insideChannel', [9, 12], [true, false]],
    ['outsideChannel', [9, 12], [false, true]],
  ] as const)('%s gives the same results with bounds swapped (11, 9)', (op, xs, want) => {
    for (const [u, l] of [
      [11, 9],
      [9, 11],
    ] as const) {
      const got = xs.map((x, i) =>
        evaluateCondition(channel(op), i ? ch(xs[i - 1]!, u, l) : null, ch(x, u, l)),
      );
      expect(got).toEqual(want);
    }
  });
});

describe('evaluateCondition', () => {
  const cross = (op: 'crossingUp' | 'crossingDown' | 'crossing'): Condition => ({
    op,
    right: { kind: 'value', value: 10 },
  });
  const y = (x: number) => s(x, { y: 10 });

  it('requires a previous sample for edges', () => {
    expect(evaluateCondition(cross('crossingUp'), null, y(11))).toBe(false);
    expect(evaluateCondition(cross('crossing'), null, y(11))).toBe(false);
    expect(evaluateCondition(channel('enteringChannel'), null, ch(10, 11, 9))).toBe(false);
  });

  it('pins the boundary cases with no epsilon', () => {
    expect(evaluateCondition(cross('crossingUp'), y(10), y(10 + 1e-12))).toBe(true);
    expect(evaluateCondition(cross('crossingDown'), y(10), y(10 - 1e-12))).toBe(true);
    expect(evaluateCondition(cross('crossingDown'), y(10), y(10))).toBe(false);
    const gt: Condition = { op: 'greater', right: { kind: 'value', value: 10 } };
    expect(evaluateCondition(gt, null, y(10))).toBe(false);
    expect(evaluateCondition(gt, null, y(10.000001))).toBe(true);
    expect(evaluateCondition(gt, null, y(Infinity))).toBe(false);
  });

  it('moving uses ref and amount', () => {
    const up: Condition = { op: 'movingUpPercent', amount: 5, bars: 2 };
    expect(evaluateCondition(up, null, s(105, { ref: 100 }))).toBe(true);
    expect(evaluateCondition(up, null, s(104.99, { ref: 100 }))).toBe(false);
    expect(evaluateCondition(up, null, s(105, { ref: 0 }))).toBe(false);
    expect(evaluateCondition(up, null, s(105))).toBe(false);
  });
});

describe('helpers', () => {
  it('priceValue', () => {
    const bar = { open: 1, high: 4, low: 2, close: 3 };
    expect(priceValue('close', bar)).toBe(3);
    expect(priceValue('open', bar)).toBe(1);
    expect(priceValue('high', bar)).toBe(4);
    expect(priceValue('low', bar)).toBe(2);
    expect(priceValue('hl2', bar)).toBe(3);
    expect(priceValue('hlc3', bar)).toBe(3);
    expect(priceValue('ohlc4', bar)).toBe(2.5);
  });

  it('conditionKind', () => {
    expect(conditionKind({ op: 'crossing' })).toBe('edge');
    expect(conditionKind({ op: 'exitingChannel' })).toBe('edge');
    expect(conditionKind({ op: 'greater' })).toBe('state');
    expect(conditionKind({ op: 'outsideChannel' })).toBe('state');
    expect(conditionKind({ op: 'movingDown' })).toBe('state');
  });

  it('isPriceAlert', () => {
    const left = { kind: 'price', field: 'close' } as const;
    const value = { kind: 'value', value: 1 } as const;
    expect(isPriceAlert({ left, condition: { op: 'crossing', right: value } })).toBe(true);
    expect(isPriceAlert({ left, condition: { op: 'less', right: value } })).toBe(true);
    expect(
      isPriceAlert({ left, condition: { op: 'less', right: { kind: 'price', field: 'open' } } }),
    ).toBe(false);
    expect(isPriceAlert({ left, condition: { op: 'movingUp', amount: 1, bars: 1 } })).toBe(false);
  });

  it('seriesKey', () => {
    expect(seriesKey('AAPL', '5m', false)).toBe('AAPL|5m|rth');
    expect(seriesKey('AAPL/MSFT', '1D', true)).toBe('AAPL/MSFT|1D|prepost');
  });
});
