import { describe, expect, it } from 'vitest';
import { computeLedger } from './ledger';
import { closedLotsForTx, rMultiple } from './r';
import { buy, mk, sell } from './testUtil';

const d = (day: number) => `2024-01-${String(day).padStart(2, '0')}T12:00:00Z`;

describe('rMultiple', () => {
  const open = buy(d(1), 'A', 10, 100);
  const ledger = computeLedger([open, sell(d(5), 'A', 6, 110), sell(d(6), 'A', 4, 90)], {
    costMethod: 'average',
  });
  const lots = closedLotsForTx(ledger, open.id);

  it('collects the closed lots of the opening transaction', () => {
    expect(lots).toHaveLength(2);
    expect(closedLotsForTx(ledger, 'other')).toEqual([]);
  });

  it('uses the override when set (including 0)', () => {
    expect(rMultiple(95, 2.5, lots)).toBe(2.5);
    expect(rMultiple(null, 0, [])).toBe(0);
  });

  it('computes pnl / (qty * |open - stop|)', () => {
    // pnl = 60 - 40 = 20; risk = 10 * 5 = 50
    expect(rMultiple(95, null, lots)).toBeCloseTo(0.4, 9);
  });

  it('is null without a stop, without lots, or with zero risk', () => {
    expect(rMultiple(null, null, lots)).toBeNull();
    expect(rMultiple(95, null, [])).toBeNull();
    expect(rMultiple(100, null, lots)).toBeNull();
    expect(rMultiple(Number.NaN, null, lots)).toBeNull();
  });
});

describe('rMultiple with splits', () => {
  it('compares the entry-time stop with the split-adjusted open price', () => {
    const open = buy(d(1), 'A', 10, 100);
    const ledger = computeLedger(
      [open, mk('split', d(2), { symbol: 'A', quantity: 4 }), sell(d(3), 'A', 40, 30)],
      {
        costMethod: 'fifo',
      },
    );
    const lots = closedLotsForTx(ledger, open.id);
    expect(lots[0]).toMatchObject({ openPrice: 25, quantity: 40, splitFactor: 4 });
    // pnl = (30 - 25) * 40; risk = 40 * (25 - 90 / 4) -> R = 5 / 2.5 = 2
    expect(rMultiple(90, null, lots)).toBeCloseTo(2, 9);
  });

  it('keeps splitFactor 1 without splits', () => {
    const open = buy(d(1), 'A', 1, 10);
    const ledger = computeLedger([open, sell(d(2), 'A', 1, 12)], { costMethod: 'fifo' });
    expect(closedLotsForTx(ledger, open.id)[0]?.splitFactor).toBe(1);
  });
});
