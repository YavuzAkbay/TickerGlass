import { describe, expect, it } from 'vitest';
import { cashEffect, computeLedger } from './ledger';
import { buy, mk, sell } from './testUtil';

const d = (day: number) => `2024-01-${String(day).padStart(2, '0')}T12:00:00Z`;
const pos = (l: ReturnType<typeof computeLedger>, s: string) => {
  const p = l.positions.find((x) => x.symbol === s);
  if (!p) throw new Error(`no position ${s}`);
  return p;
};

describe('cost methods', () => {
  const txs = () => [
    buy(d(1), 'A', 10, 100, 10),
    buy(d(2), 'A', 10, 120, 0),
    sell(d(3), 'A', 15, 130, 15),
  ];

  it('fifo realizes per lot with fees', () => {
    const l = computeLedger(txs(), { costMethod: 'fifo' });
    // lot1: (130-100)*10 - 10 buy fee - 10 sell fee share = 280; lot2: 50 - 5 = 45
    expect(pos(l, 'A').realized).toBeCloseTo(325, 9);
    expect(pos(l, 'A').quantity).toBe(5);
    expect(pos(l, 'A').costBasis).toBeCloseTo(600, 9);
    expect(pos(l, 'A').avgCost).toBeCloseTo(120, 9);
    expect(l.totals.USD?.realized).toBeCloseTo(325, 9);
    expect(l.issues).toEqual([]);
  });

  it('average pools the lots (buy fees in the basis, sell fees off realized)', () => {
    const l = computeLedger(txs(), { costMethod: 'average' });
    // pooled cost 2210 / 20 = 110.5; (130-110.5)*15 - 15 = 277.5
    expect(pos(l, 'A').realized).toBeCloseTo(277.5, 9);
    expect(pos(l, 'A').quantity).toBe(5);
    expect(pos(l, 'A').costBasis).toBeCloseTo(552.5, 9);
    expect(pos(l, 'A').avgCost).toBeCloseTo(110.5, 9);
    expect(pos(l, 'A').openLots).toHaveLength(1);
  });

  it('closedLots are FIFO in both modes and sum to the fifo realized', () => {
    const shared = txs();
    const f = computeLedger(shared, { costMethod: 'fifo' });
    const a = computeLedger(shared, { costMethod: 'average' });
    expect(a.closedLots).toEqual(f.closedLots);
    expect(f.closedLots).toHaveLength(2);
    expect(f.closedLots.reduce((n, c) => n + c.pnl, 0)).toBeCloseTo(325, 9);
    expect(f.closedLots[0]).toMatchObject({ quantity: 10, openPrice: 100, closePrice: 130 });
  });

  it('cash follows the design table', () => {
    const l = computeLedger(txs(), { costMethod: 'fifo' });
    expect(l.cash.USD).toBeCloseTo(-1010 - 1200 + 1935, 9);
    expect(l.totals.USD?.commissions).toBe(25);
  });
});

describe('partial sells and closing out', () => {
  it('keeps closed positions with quantity 0', () => {
    const l = computeLedger(
      [buy(d(1), 'A', 10, 10), sell(d(2), 'A', 4, 12), sell(d(3), 'A', 6, 9)],
      { costMethod: 'fifo' },
    );
    const p = pos(l, 'A');
    expect(p.quantity).toBe(0);
    expect(p.openLots).toEqual([]);
    expect(p.costBasis).toBe(0);
    expect(p.realized).toBeCloseTo(4 * 2 + 6 * -1, 9);
  });

  it('sorts by time then original order regardless of input order', () => {
    const l = computeLedger([sell(d(2), 'A', 5, 12), buy(d(1), 'A', 5, 10)], {
      costMethod: 'fifo',
    });
    expect(l.issues).toEqual([]);
    expect(pos(l, 'A').realized).toBe(10);
  });
});

describe('oversell and issues', () => {
  it('clamps an oversell, scales the sell fee, records an issue', () => {
    const sellTx = sell(d(2), 'A', 8, 10, 8);
    const l = computeLedger([buy(d(1), 'A', 5, 8), sellTx], { costMethod: 'fifo' });
    expect(l.issues).toHaveLength(1);
    expect(l.issues[0]).toMatchObject({ txId: sellTx.id, code: 'oversell' });
    expect(pos(l, 'A').quantity).toBe(0);
    // (10-8)*5 - 8*5/8
    expect(pos(l, 'A').realized).toBeCloseTo(5, 9);
    // cash is real money: 8*10-8 in, 40 out
    expect(l.cash.USD).toBeCloseTo(32, 9);
  });

  it('flags a sell with no position', () => {
    const s = sell(d(1), 'ZZ', 1, 5);
    const l = computeLedger([s], { costMethod: 'average' });
    expect(l.issues).toMatchObject([{ txId: s.id, code: 'noPosition' }]);
  });

  it('flags a split without position and a bad ratio', () => {
    const s1 = mk('split', d(1), { symbol: 'Q', quantity: 2 });
    const b = buy(d(1), 'A', 1, 1);
    const s2 = mk('split', d(2), { symbol: 'A', quantity: 0 });
    const l = computeLedger([s1, b, s2], { costMethod: 'fifo' });
    expect(l.issues.map((i) => i.code).sort()).toEqual(['badSplit', 'noPosition']);
  });

  it('flags a currency mismatch and keeps the position untouched', () => {
    const eur = buy(d(2), 'A', 5, 10, 0, { currency: 'EUR' });
    const l = computeLedger([buy(d(1), 'A', 5, 10), eur], { costMethod: 'fifo' });
    expect(l.issues).toMatchObject([{ txId: eur.id, code: 'currencyMismatch' }]);
    expect(pos(l, 'A').quantity).toBe(5);
    expect(l.cash.EUR).toBeUndefined(); // a skipped transaction has no cash effect
  });

  it('reports unparseable times and malformed rows without throwing', () => {
    const l = computeLedger(
      [
        mk('buy', 'not a date', { symbol: 'A', quantity: 1, price: 1 }),
        mk('buy', d(1), { symbol: 'A' }),
      ],
      { costMethod: 'fifo' },
    );
    expect(l.issues.map((i) => i.code)).toEqual(['invalid', 'invalid']);
    expect(l.positions).toEqual([]);
  });
});

describe('splits', () => {
  it.each(['fifo', 'average'] as const)('forward split mid-position (%s)', (m) => {
    const l = computeLedger(
      [
        buy(d(1), 'A', 10, 100),
        mk('split', d(2), { symbol: 'A', quantity: 4 }),
        sell(d(3), 'A', 20, 30),
      ],
      { costMethod: m },
    );
    const p = pos(l, 'A');
    expect(p.quantity).toBe(20);
    expect(p.costBasis).toBeCloseTo(500, 9);
    expect(p.realized).toBeCloseTo(100, 9); // (30 - 25) * 20
    expect(l.closedLots[0]).toMatchObject({ quantity: 20, openPrice: 25 });
  });

  it('reverse split keeps the basis', () => {
    const l = computeLedger(
      [buy(d(1), 'A', 100, 10, 5), mk('split', d(2), { symbol: 'A', quantity: 0.1 })],
      { costMethod: 'fifo' },
    );
    const p = pos(l, 'A');
    expect(p.quantity).toBeCloseTo(10, 9);
    expect(p.costBasis).toBeCloseTo(1005, 9);
    expect(p.openLots[0]?.price).toBeCloseTo(100, 9);
  });
});

describe('income, fees and cash', () => {
  it('dividends net of withholding, per symbol and per currency', () => {
    const l = computeLedger(
      [buy(d(1), 'A', 1, 10), mk('dividend', d(2), { symbol: 'A', amount: 100, fee: 15 })],
      { costMethod: 'fifo' },
    );
    expect(pos(l, 'A').dividends).toBe(85);
    expect(pos(l, 'A').withholding).toBe(15);
    expect(l.totals.USD).toMatchObject({ dividends: 85, withholding: 15 });
    expect(l.cash.USD).toBe(-10 + 85);
  });

  it('tracks cash per currency across all kinds', () => {
    const l = computeLedger(
      [
        mk('cashIn', d(1), { amount: 1000 }),
        mk('cashIn', d(1), { amount: 500, currency: 'EUR' }),
        buy(d(2), 'SAP', 1, 100, 1, { currency: 'EUR' }),
        mk('interest', d(3), { amount: 5, fee: 1 }),
        mk('fee', d(3), { amount: 2 }),
        mk('cashOut', d(4), { amount: 100 }),
      ],
      { costMethod: 'fifo' },
    );
    expect(l.cash.USD).toBe(1000 + 4 - 2 - 100);
    expect(l.cash.EUR).toBe(500 - 101);
    expect(l.totals.USD).toMatchObject({ deposits: 1000, withdrawals: 100, interest: 4, fees: 2 });
  });

  it('cashEffect handles null amounts', () => {
    expect(cashEffect(mk('cashIn', d(1)))).toBe(0);
    expect(cashEffect(mk('split', d(1), { symbol: 'A', quantity: 2 }))).toBe(0);
  });
});

describe('dividends and currencies', () => {
  const div = (day: number, symbol: string, amount: number, currency: string, fee = 0) =>
    mk('dividend', d(day), { symbol, amount, currency, fee });

  it('a dividend before the first buy neither opens the position nor fixes its currency', () => {
    // Trading 212: dividends are booked in the account currency (GBP), the stock trades in USD.
    const l = computeLedger([div(1, 'AAPL', 5, 'GBP', 1), buy(d(2), 'AAPL', 2, 100)], {
      costMethod: 'fifo',
    });
    expect(l.issues).toEqual([]);
    expect(pos(l, 'AAPL')).toMatchObject({ currency: 'USD', quantity: 2, dividends: 0 });
    expect(l.totals.GBP).toMatchObject({ dividends: 4, withholding: 1 });
    expect(l.cash.GBP).toBe(4);
    expect(l.cash.USD).toBe(-200);
  });

  it('a dividend in the position currency is attributed to it', () => {
    const l = computeLedger([buy(d(1), 'A', 1, 10), div(2, 'A', 3, 'USD', 0.5)], {
      costMethod: 'fifo',
    });
    expect(pos(l, 'A')).toMatchObject({ dividends: 2.5, withholding: 0.5 });
    expect(l.totals.USD?.dividends).toBe(2.5);
  });

  it('a dividend in another currency than the open position is attributed, not flagged', () => {
    const l = computeLedger(
      [buy(d(1), 'A', 1, 10), div(2, 'A', 3, 'EUR', 1), div(3, 'A', 2, 'EUR'), div(4, 'A', 1, 'USD')],
      { costMethod: 'fifo' },
    );
    expect(l.issues).toEqual([]);
    expect(pos(l, 'A')).toMatchObject({ dividends: 1, withholding: 0 });
    expect(pos(l, 'A').foreignDividends).toEqual({ EUR: { net: 4, withholding: 1 } });
    expect(l.totals.EUR).toMatchObject({ dividends: 4, withholding: 1 });
    expect(l.cash.EUR).toBe(4);
  });

  it('a rejected sell (currency clash) has no cash effect', () => {
    const l = computeLedger(
      [buy(d(1), 'A', 5, 10), sell(d(2), 'A', 5, 10, 0, { currency: 'EUR' })],
      { costMethod: 'fifo' },
    );
    expect(l.issues.map((i) => i.code)).toEqual(['currencyMismatch']);
    expect(l.cash.EUR).toBeUndefined();
    expect(pos(l, 'A').quantity).toBe(5);
  });

  it('a split applies to the symbol whatever currency the row carries', () => {
    const l = computeLedger(
      [buy(d(1), 'A', 10, 100), mk('split', d(2), { symbol: 'A', quantity: 4, currency: 'EUR' })],
      { costMethod: 'fifo' },
    );
    expect(l.issues).toEqual([]);
    expect(pos(l, 'A')).toMatchObject({ currency: 'USD', quantity: 40 });
  });
});

describe('oversell cash and ordering', () => {
  it('oversell keeps the full proceeds in cash but clamps the position and flags it', () => {
    const l = computeLedger([buy(d(1), 'X', 10, 100), sell(d(2), 'X', 20, 100, 2)], {
      costMethod: 'fifo',
    });
    expect(l.issues.map((i) => i.code)).toEqual(['oversell']);
    expect(l.cash.USD).toBeCloseTo(-1000 + 2000 - 2, 9);
    expect(pos(l, 'X').quantity).toBe(0);
  });

  it('sorts stably by (time, input index), never by id', () => {
    const b = buy(d(1), 'X', 1, 10);
    const s = sell(d(1), 'X', 1, 11);
    // Ids are t<n> in creation order; reversing the ids must not change the outcome.
    const ok = computeLedger(
      [
        { ...b, id: 'z' },
        { ...s, id: 'a' },
      ],
      { costMethod: 'fifo' },
    );
    expect(ok.issues).toEqual([]);
    expect(ok.positions[0]?.realized).toBe(1);
    const bad = computeLedger(
      [
        { ...s, id: 'a' },
        { ...b, id: 'z' },
      ],
      { costMethod: 'fifo' },
    );
    expect(bad.issues.map((i) => i.code)).toEqual(['noPosition']);
  });
});
