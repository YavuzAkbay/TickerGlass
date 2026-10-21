import { describe, expect, it } from 'vitest';
import {
  applyToPosition,
  closeOrder,
  emptyPaper,
  fill,
  totalPnl,
  unrealized,
  type PaperState,
} from './paper';

const trade = (side: 'buy' | 'sell', qty: number, price: number, symbol = 'AAPL') => ({
  symbol,
  side,
  qty,
  price,
  time: 0,
});
const run = (...orders: ReturnType<typeof trade>[]): PaperState =>
  orders.reduce((s, o) => fill(s, o), emptyPaper());

describe('applyToPosition', () => {
  it('opens a position at the fill price', () => {
    expect(applyToPosition({ qty: 0, avg: 0 }, 'buy', 2, 100)).toEqual({
      position: { qty: 2, avg: 100 },
      realized: 0,
    });
    expect(applyToPosition({ qty: 0, avg: 0 }, 'sell', 3, 50).position).toEqual({
      qty: -3,
      avg: 50,
    });
  });

  it('adding in the same direction averages the cost', () => {
    const r = applyToPosition({ qty: 2, avg: 100 }, 'buy', 2, 110);
    expect(r.position).toEqual({ qty: 4, avg: 105 });
    expect(r.realized).toBe(0);
    const s = applyToPosition({ qty: -2, avg: 100 }, 'sell', 2, 90);
    expect(s.position).toEqual({ qty: -4, avg: 95 });
  });

  it('reducing a long realizes on the closed part and keeps the average', () => {
    const r = applyToPosition({ qty: 4, avg: 105 }, 'sell', 1, 115);
    expect(r.position).toEqual({ qty: 3, avg: 105 });
    expect(r.realized).toBeCloseTo(10);
  });

  it('reducing a short realizes with the opposite sign', () => {
    const r = applyToPosition({ qty: -4, avg: 100 }, 'buy', 1, 90);
    expect(r.position).toEqual({ qty: -3, avg: 100 });
    expect(r.realized).toBe(10);
    expect(applyToPosition({ qty: -4, avg: 100 }, 'buy', 1, 110).realized).toBe(-10);
  });

  it('closing exactly goes flat', () => {
    const r = applyToPosition({ qty: 3, avg: 100 }, 'sell', 3, 120);
    expect(r.position).toEqual({ qty: 0, avg: 0 });
    expect(r.realized).toBe(60);
  });

  it('flips: realizes on the closed quantity, the rest opens at the fill price', () => {
    const long = applyToPosition({ qty: 2, avg: 100 }, 'sell', 5, 110);
    expect(long.realized).toBe(20);
    expect(long.position).toEqual({ qty: -3, avg: 110 });
    const short = applyToPosition({ qty: -2, avg: 100 }, 'buy', 5, 90);
    expect(short.realized).toBe(20);
    expect(short.position).toEqual({ qty: 3, avg: 90 });
  });
});

describe('fill', () => {
  it('records trades with ids and accumulates realized P&L', () => {
    const s = run(trade('buy', 2, 100), trade('buy', 2, 110), trade('sell', 4, 120));
    expect(s.trades.map((t) => [t.id, t.side, t.qty, t.price])).toEqual([
      [1, 'buy', 2, 100],
      [2, 'buy', 2, 110],
      [3, 'sell', 4, 120],
    ]);
    expect(s.realized).toBeCloseTo(60); // avg 105 -> (120 - 105) * 4
    expect(s.positions).toEqual({});
  });

  it('keeps one position per symbol', () => {
    const s = run(trade('buy', 1, 10), trade('sell', 2, 5, 'MSFT'));
    expect(s.positions).toEqual({ AAPL: { qty: 1, avg: 10 }, MSFT: { qty: -2, avg: 5 } });
  });

  it('rejects invalid orders without changing the state', () => {
    const s = emptyPaper();
    expect(() => fill(s, trade('buy', 0, 10))).toThrow();
    expect(() => fill(s, trade('buy', -1, 10))).toThrow();
    expect(() => fill(s, trade('buy', Infinity, 10))).toThrow();
    expect(() => fill(s, trade('buy', 1, NaN))).toThrow();
  });

  it('does not mutate the previous state', () => {
    const a = run(trade('buy', 1, 10));
    const b = fill(a, trade('sell', 1, 12));
    expect(a.trades).toHaveLength(1);
    expect(a.positions.AAPL).toEqual({ qty: 1, avg: 10 });
    expect(b.realized).toBe(2);
  });
});

describe('closeOrder and unrealized', () => {
  it('flattens in the opposite direction', () => {
    expect(closeOrder(run(trade('buy', 3, 10)), 'AAPL')).toEqual({ side: 'sell', qty: 3 });
    expect(closeOrder(run(trade('sell', 2, 10)), 'AAPL')).toEqual({ side: 'buy', qty: 2 });
    expect(closeOrder(emptyPaper(), 'AAPL')).toBeNull();
  });

  it('marks open positions to the last price, long and short', () => {
    const long = run(trade('buy', 2, 100));
    expect(unrealized(long, { AAPL: 105 })).toBe(10);
    const short = run(trade('sell', 2, 100));
    expect(unrealized(short, { AAPL: 105 })).toBe(-10);
    expect(unrealized(long, {})).toBe(0);
  });

  it('total is realized plus unrealized', () => {
    const s = run(trade('buy', 2, 100), trade('sell', 1, 110)); // realized 10, 1 long @ 100
    expect(s.realized).toBe(10);
    expect(totalPnl(s, { AAPL: 104 })).toBe(14);
  });
});
