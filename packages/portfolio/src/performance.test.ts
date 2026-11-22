import { describe, expect, it } from 'vitest';
import { performance } from './performance';
import { buy, mk, sell } from './testUtil';
import type { DailyClose } from './types';

/** Unix seconds at 00:00 UTC of 2024-01-<day>. */
const ts = (day: number) => Date.UTC(2024, 0, day) / 1000;
const iso = (day: number) => `2024-01-${String(day).padStart(2, '0')}T15:00:00Z`;
const series = (first: number, closes: number[]): DailyClose[] =>
  closes.map((c, i) => ({ t: ts(first + i), c }));

describe('performance: TWR', () => {
  // Jan 2..5 closes 100, 110, 121, 133.1: +10% each day.
  const closes = { AAA: series(2, [100, 110, 121, 133.1]) };

  it('cash mode: a mid-period deposit is a flow, not return', () => {
    const txs = [
      mk('cashIn', iso(2), { amount: 1000 }),
      buy(iso(2), 'AAA', 10, 100),
      mk('cashIn', iso(4), { amount: 1210 }),
      buy(iso(4), 'AAA', 10, 121),
    ];
    const r = performance(txs, { closes, fx: {}, base: 'USD' });
    expect(r.cashMode).toBe(true);
    expect(r.points.map((p) => p.t)).toEqual([ts(2), ts(3), ts(4), ts(5)]);
    expect(r.points.map((p) => p.value)).toEqual(
      [1000, 1100, 2420, 2662].map((v) => expect.closeTo(v, 6)),
    );
    expect(r.points.map((p) => p.netFlow)).toEqual([1000, 0, 1210, 0]);
    // Flows count as invested from the start of their day: Jan 4 is 2420 / (1100 + 1210).
    expect(r.stats.twr).toBeCloseTo((1.1 * (2420 / 2310) * 1.1 - 1) * 100, 6);
    expect(r.points[0]?.twr).toBeCloseTo(0, 9);
    expect(r.points[1]?.twr).toBeCloseTo(10, 6);
    expect(r.points[2]?.twr).toBeCloseTo((1.1 * (2420 / 2310) - 1) * 100, 6);
    expect(r.stats.benchmarkReturn).toBeUndefined();
    expect(r.points[0]).not.toHaveProperty('benchmark');
  });

  it('without cash transactions the flows are net trade cash', () => {
    const txs = [buy(iso(2), 'AAA', 10, 100), buy(iso(4), 'AAA', 10, 121)];
    const r = performance(txs, { closes, fx: {}, base: 'USD' });
    expect(r.cashMode).toBe(false);
    expect(r.points.map((p) => p.netFlow)).toEqual([1000, 0, 1210, 0]);
    expect(r.stats.twr).toBeCloseTo((1.1 * (2420 / 2310) * 1.1 - 1) * 100, 6);
  });

  it('sell proceeds are an outflow; dividends count as return', () => {
    const txs = [
      buy(iso(2), 'AAA', 10, 100),
      sell(iso(4), 'AAA', 5, 121),
      mk('dividend', iso(5), { symbol: 'AAA', amount: 12.5 }),
    ];
    const r = performance(txs, { closes, fx: {}, base: 'USD' });
    expect(r.points.map((p) => p.netFlow)).toEqual([1000, 0, -605, 0]);
    // Jan 2 buys at 100, closes 100: 0%. Jan 3: +10%. Jan 4: (605 + 605) / 1100 = +10%.
    // Jan 5: 5 * 133.1 + 12.5 = 678 vs 605.
    const jan5 = 1.1 * 1.1 * ((5 * 133.1 + 12.5) / 605);
    expect(r.stats.twr).toBeCloseTo((jan5 - 1) * 100, 6);
  });

  it('starts at the first transaction day and ignores earlier bars', () => {
    const r = performance([buy(iso(4), 'AAA', 1, 121)], { closes, fx: {}, base: 'USD' });
    expect(r.points.map((p) => p.t)).toEqual([ts(4), ts(5)]);
    expect(r.points[0]?.twr).toBeCloseTo(0, 9);
  });

  it('a weekend transaction lands on the next grid day', () => {
    const bars = {
      AAA: [
        { t: ts(5), c: 10 },
        { t: ts(8), c: 11 },
      ],
    }; // Fri Jan 5, Mon Jan 8
    const r = performance([buy(iso(6), 'AAA', 10, 10)], { closes: bars, fx: {}, base: 'USD' });
    expect(r.points.map((p) => p.t)).toEqual([ts(8)]);
    expect(r.points[0]?.value).toBe(110);
  });

  it('no transactions or no bars give an empty result', () => {
    expect(performance([], { closes, fx: {}, base: 'USD' }).points).toEqual([]);
    expect(
      performance([buy(iso(2), 'AAA', 1, 1)], { closes: {}, fx: {}, base: 'USD' }).points,
    ).toEqual([]);
  });
});

describe('performance: split-adjusted closes', () => {
  it('expresses earlier holdings in post-split shares', () => {
    const txs = [buy(iso(2), 'AAA', 10, 100), mk('split', iso(4), { symbol: 'AAA', quantity: 2 })];
    // Adjusted closes: the raw 100 / 110 before the 2-for-1 become 50 / 55.
    const closes = { AAA: series(2, [50, 55, 60, 65]) };
    const r = performance(txs, { closes, fx: {}, base: 'USD' });
    expect(r.points.map((p) => p.value)).toEqual([1000, 1100, 1200, 1300]);
    expect(r.stats.twr).toBeCloseTo(30, 6);
  });

  it('buying after a later split uses the adjusted trade price as fallback', () => {
    // No bars before the buy day; the trade price (post-split terms) must not jump the value.
    const txs = [buy(iso(2), 'AAA', 10, 100), mk('split', iso(4), { symbol: 'AAA', quantity: 4 })];
    const r = performance(txs, { closes: { AAA: series(4, [25, 26]) }, fx: {}, base: 'USD' });
    expect(r.points[0]?.value).toBe(1000); // 40 sh * 25
    expect(r.points[1]?.value).toBe(1040);
  });
});

describe('performance: FX, gaps, benchmark, drawdown', () => {
  it('converts holdings with the daily FX close', () => {
    const txs = [buy(iso(2), 'UK', 10, 100, 0, { currency: 'GBP' })];
    const r = performance(txs, {
      closes: { UK: series(2, [100, 100]) },
      fx: { GBP: series(2, [1.2, 1.5]) },
      base: 'USD',
    });
    expect(r.points.map((p) => p.value)).toEqual([1200, 1500]);
    expect(r.stats.twr).toBeCloseTo(25, 6);
    expect(r.missing.fx).toEqual([]);
  });

  it('reports a currency without FX data and skips its value', () => {
    const txs = [buy(iso(2), 'UK', 10, 100, 0, { currency: 'GBP' })];
    const r = performance(txs, { closes: { UK: series(2, [100, 100]) }, fx: {}, base: 'USD' });
    expect(r.missing.fx).toEqual(['GBP']);
    expect(r.points.map((p) => p.value)).toEqual([0, 0]);
  });

  it('carries the last close forward across a symbol gap', () => {
    const txs = [buy(iso(2), 'A', 1, 10), buy(iso(2), 'B', 1, 100)];
    const closes = {
      A: [
        { t: ts(2), c: 10 },
        { t: ts(4), c: 12 },
      ],
      B: series(2, [100, 101, 102]),
    };
    const r = performance(txs, { closes, fx: {}, base: 'USD' });
    expect(r.points.map((p) => p.value)).toEqual([110, 111, 114]);
  });

  it('normalizes the benchmark to the first point and carries it forward', () => {
    const txs = [buy(iso(2), 'A', 1, 100)];
    const r = performance(txs, {
      closes: { A: series(2, [100, 100, 100]) },
      fx: {},
      base: 'USD',
      benchmark: [
        { t: ts(1), c: 380 },
        { t: ts(2), c: 400 },
        { t: ts(4), c: 420 },
      ],
    });
    expect(r.points[0]?.benchmark).toBe(0);
    expect(r.points[1]?.benchmark).toBe(0);
    expect(r.points[2]?.benchmark).toBeCloseTo(5, 9);
    expect(r.stats.benchmarkReturn).toBeCloseTo(5, 9);
  });

  it('max drawdown is measured on the TWR index', () => {
    const txs = [buy(iso(2), 'A', 1, 100)];
    const r = performance(txs, {
      closes: { A: series(2, [100, 120, 90, 110]) },
      fx: {},
      base: 'USD',
    });
    expect(r.stats.maxDrawdownPct).toBeCloseTo(25, 9);
    expect(r.stats.twr).toBeCloseTo(10, 9);
  });

  it('a later deposit does not mask an earlier drawdown', () => {
    const txs = [
      mk('cashIn', iso(2), { amount: 100 }),
      buy(iso(2), 'A', 1, 100),
      mk('cashIn', iso(5), { amount: 1000 }),
      buy(iso(5), 'A', 10, 90),
    ];
    const r = performance(txs, {
      closes: { A: series(2, [100, 120, 90, 90]) },
      fx: {},
      base: 'USD',
    });
    expect(r.stats.maxDrawdownPct).toBeCloseTo(25, 6);
    expect(r.points[3]?.value).toBeCloseTo(1090, 6); // 11 sh * 90 + 100 cash
  });
});

describe('performance: first day, residual value, flows', () => {
  it('buy at 100, closes 110 / 121 / 110: the first day counts (+10 %)', () => {
    const r = performance([mk('buy', iso(2), { symbol: 'X', quantity: 10, price: 100 })], {
      closes: { X: series(2, [110, 121, 110]) },
      fx: {},
      base: 'USD',
    });
    expect(r.points.map((p) => p.twr)).toEqual([10, 21, 10].map((v) => expect.closeTo(v, 9)));
    expect(r.stats.twr).toBeCloseTo(10, 9);
  });

  it('buy-and-hold equals the price return exactly', () => {
    const closes = [105, 99, 120, 80, 130];
    const r = performance([buy(iso(2), 'X', 7, 100)], {
      closes: { X: series(2, closes) },
      fx: {},
      base: 'USD',
    });
    r.points.forEach((p, i) =>
      expect(p.twr).toBeCloseTo(((closes[i] as number) / 100 - 1) * 100, 9),
    );
  });

  it('a buy fee is part of the cost, so it lowers the return', () => {
    const r = performance([buy(iso(2), 'X', 10, 100, 10)], {
      closes: { X: series(2, [100]) },
      fx: {},
      base: 'USD',
    });
    expect(r.stats.twr).toBeCloseTo((1000 / 1010 - 1) * 100, 9);
  });

  it('dividend residual, full sell, then a big rebuy gives about 1 %, not 2010 %', () => {
    const txs = [
      buy(iso(2), 'X', 10, 100),
      mk('dividend', iso(3), { symbol: 'X', amount: 5 }),
      sell(iso(4), 'X', 10, 100),
      buy(iso(5), 'X', 100, 100),
    ];
    const r = performance(txs, {
      closes: { X: series(2, [100, 100, 100, 101, 101]) },
      fx: {},
      base: 'USD',
    });
    expect(r.cashMode).toBe(false);
    // Jan 3: +0.5 % (the dividend). Jan 4: sold at the close, 0 %.
    // Jan 5: (100 sh * 101 + 5 residual) / (5 + 10000) = +1.0 %.
    expect(r.points[1]?.twr).toBeCloseTo(0.5, 9);
    expect(r.points[2]?.twr).toBeCloseTo(0.5, 9);
    expect(r.points[3]?.twr).toBeCloseTo((1.005 * (10105 / 10005) - 1) * 100, 6);
    expect(r.stats.twr).toBeLessThan(2);
  });

  it('a full-sell day at the close price is 0 %', () => {
    const r = performance([buy(iso(2), 'X', 10, 100), sell(iso(3), 'X', 10, 100)], {
      closes: { X: series(2, [100, 100, 100]) },
      fx: {},
      base: 'USD',
    });
    expect(r.points.map((p) => p.twr)).toEqual([0, 0, 0].map((v) => expect.closeTo(v, 9)));
    expect(r.points[1]?.value).toBe(0);
  });

  it('rotating X into Y on one day nets the flows', () => {
    const txs = [buy(iso(2), 'X', 10, 100), sell(iso(3), 'X', 10, 100), buy(iso(3), 'Y', 10, 100)];
    const r = performance(txs, {
      closes: { X: series(2, [100, 100, 100]), Y: series(2, [100, 100, 110]) },
      fx: {},
      base: 'USD',
    });
    expect(r.points[1]?.twr).toBeCloseTo(0, 9);
    expect(r.points[2]?.twr).toBeCloseTo(10, 9);
  });

  it('skips a day whose denominator is not positive', () => {
    const r = performance([buy(iso(2), 'X', 1, 100), sell(iso(3), 'X', 1, 100)], {
      closes: { X: series(2, [100, 100, 100, 100]) },
      fx: {},
      base: 'USD',
    });
    expect(r.points.map((p) => p.twr)).toEqual([0, 0, 0, 0].map((v) => expect.closeTo(v, 9)));
  });
});

describe('performance: oversell', () => {
  it('non-cash: a sell of shares never held is no flow', () => {
    const r = performance([buy(iso(2), 'X', 10, 100), sell(iso(3), 'Y', 10, 100)], {
      closes: { X: series(2, [100, 100]), Y: series(2, [100, 100]) },
      fx: {},
      base: 'USD',
    });
    expect(r.points.map((p) => p.netFlow)).toEqual([1000, 0]);
    expect(r.stats.twr).toBeCloseTo(0, 9);
  });

  it('non-cash: only the held part is an outflow, fee pro-rated', () => {
    const r = performance([buy(iso(2), 'X', 10, 100), sell(iso(3), 'X', 20, 100, 4)], {
      closes: { X: series(2, [100, 100]) },
      fx: {},
      base: 'USD',
    });
    // 10 of 20 sold shares were held: 10 * 100 - 4 * 10 / 20 = 998.
    expect(r.points[1]?.netFlow).toBeCloseTo(-998, 9);
    expect(r.points[1]?.value).toBe(0);
  });

  it('cash mode: the unheld part of the proceeds is an external inflow', () => {
    const txs = [
      mk('cashIn', iso(2), { amount: 1000 }),
      buy(iso(2), 'X', 10, 100),
      sell(iso(3), 'X', 20, 100),
    ];
    const r = performance(txs, {
      closes: { X: series(2, [100, 100]) },
      fx: {},
      base: 'USD',
    });
    expect(r.cashMode).toBe(true);
    expect(r.cashFallback).toBe(false);
    expect(r.points[1]?.value).toBe(2000);
    expect(r.points[1]?.netFlow).toBe(1000);
    expect(r.stats.twr).toBeCloseTo(0, 9);
  });
});

describe('performance: ordering and cash fallback', () => {
  it('breaks equal-time ties by input index (buy before sell works, sell before buy does not)', () => {
    const time = iso(2);
    const closes = { X: series(2, [100, 100]) };
    const ok = performance([buy(time, 'X', 1, 100), sell(time, 'X', 1, 100)], {
      closes,
      fx: {},
      base: 'USD',
    });
    expect(ok.points[0]?.value).toBe(0);
    const swapped = performance([sell(time, 'X', 1, 100), buy(time, 'X', 1, 100)], {
      closes,
      fx: {},
      base: 'USD',
    });
    expect(swapped.points[0]?.value).toBe(100);
  });

  it('falls back to non-cash mode when cash goes materially negative', () => {
    // Trades before the deposit was recorded: cash is -1000 against a 1000 holding.
    const txs = [buy(iso(2), 'X', 10, 100), mk('cashIn', iso(4), { amount: 100 })];
    const r = performance(txs, {
      closes: { X: series(2, [100, 105, 110]) },
      fx: {},
      base: 'USD',
    });
    expect(r.cashFallback).toBe(true);
    expect(r.cashMode).toBe(false);
    expect(r.stats.twr).toBeCloseTo(10, 9);
  });

  it('keeps cash mode when cash stays non-negative', () => {
    const txs = [mk('cashIn', iso(2), { amount: 1000 }), buy(iso(2), 'X', 10, 100)];
    const r = performance(txs, { closes: { X: series(2, [100, 110]) }, fx: {}, base: 'USD' });
    expect(r.cashMode).toBe(true);
    expect(r.cashFallback).toBe(false);
  });
});
