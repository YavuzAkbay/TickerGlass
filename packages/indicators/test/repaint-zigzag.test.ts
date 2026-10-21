import { describe, expect, it } from 'vitest';
import '../src/builtins';
import { IndicatorRuntime, type Change } from '../src/runtime';
import { randomBars } from '../src/test-utils';
import type { BarInput, InputValueMap } from '../src/types';
import { barAt, feedTicks, sliceBars, snapshot, swingTicks, toColumns } from './helpers';

/** Flat bars (open = high = low = close) at the given prices, one minute apart. */
function flat(prices: number[]): BarInput[] {
  return prices.map((p, i) => ({ time: i * 60, open: p, high: p, low: p, close: p, volume: 1 }));
}

const at = (time: number, p: number): BarInput => ({
  time,
  open: p,
  high: p,
  low: p,
  close: p,
  volume: 1,
});

function withSma(inputs: InputValueMap): IndicatorRuntime {
  const rt = new IndicatorRuntime();
  rt.add({ id: 'z', type: 'zigzag', inputs });
  rt.add({
    id: 'ma',
    type: 'sma',
    inputs: { length: 2, source: { instanceId: 'z', outputId: 'zz' } },
  });
  return rt;
}

const fromOf = (cs: Change[], id: string) => cs.find((c) => c.id === id)?.from;

describe('zigzag repaints', () => {
  it.each([
    { deviation: 1, depth: 4 },
    { deviation: 3, depth: 10 },
    { deviation: 0.5, depth: 5, extendToLastBar: false },
    { deviation: 2, depth: 6, showPrice: false },
  ])('live ticks and appends equal a full computation (%o)', (inputs) => {
    const bars = randomBars(400, 5, 1_700_000_000, 900);
    const full = withSma(inputs);
    full.setBars(bars);
    const live = withSma(inputs);
    const changes = feedTicks(live, bars, 60, swingTicks);
    expect(full.status('z')).toEqual({ state: 'ok' });
    expect(snapshot(live.result('z')!)).toEqual(snapshot(full.result('z')!));
    expect(snapshot(live.result('ma')!)).toEqual(snapshot(full.result('ma')!));
    // Some ticks repainted the past (pivots appear d >= 2 bars back).
    expect(changes.some((cs) => cs.some((c) => c.id === 'z' && c.from < live.length - 2))).toBe(
      true,
    );
  });

  it('creates, cancels and moves pivots with the right Change.from', () => {
    // depth 4 -> pivots over 2 bars each side, confirmed 2 bars late; deviation 5 %.
    const prices = [100, 101, 102, 110, 107, 106, 108, 109, 115, 112];
    const inputs = { deviation: 5, depth: 4 };
    const rt = withSma(inputs);
    rt.setBars(toColumns(flat(prices.slice(0, 5))));
    const zz = () => rt.result('z')!.values.zz!;
    const hi = () => rt.result('z')!.values.hiLbl!;
    expect(Array.from(zz().subarray(0, 5)).every(Number.isNaN)).toBe(true);

    // Bar 5 confirms the high at bar 3 (first pivot) and extends to the close.
    let cs = rt.updateBar(5, at(300, 106));
    expect(fromOf(cs, 'z')).toBe(3);
    expect(fromOf(cs, 'ma')).toBe(0); // dependents recompute fully from a past change
    expect(zz()[3]).toBe(110);
    expect(hi()[3]).toBe(110);
    expect(zz()[5]).toBe(106);

    // A tick above 110 cancels it (no pivot, so no extension either).
    cs = rt.updateBar(5, at(300, 111));
    expect(fromOf(cs, 'z')).toBe(3);
    expect(zz()[3]).toBeNaN();
    expect(hi()[3]).toBeNaN();
    expect(zz()[5]).toBeNaN();

    // And back: the pivot returns.
    cs = rt.updateBar(5, at(300, 106));
    expect(fromOf(cs, 'z')).toBe(3);
    expect(zz()[3]).toBe(110);

    // Appends: the low at 5 (106, 3.6 % below 110) is below the deviation, the
    // extension point moves to the new last bar.
    for (let i = 6; i < prices.length; i++) {
      cs = rt.updateBar(i, at(i * 60, prices[i]!));
      expect(fromOf(cs, 'z')).toBe(i - 1);
      expect(zz()[i - 1]).toBeNaN();
      expect(zz()[i]).toBe(prices[i]);
    }

    // Bar 10 confirms the higher high at 8: the pivot moves from 3 to 8.
    cs = rt.updateBar(10, at(600, 111));
    expect(fromOf(cs, 'z')).toBe(3);
    expect(fromOf(cs, 'ma')).toBe(0);
    expect(zz()[3]).toBeNaN();
    expect(hi()[3]).toBeNaN();
    expect(zz()[8]).toBe(115);
    expect(hi()[8]).toBe(115);
    expect(zz()[9]).toBeNaN();
    expect(zz()[10]).toBe(111);

    // A tick above 115 cancels the move (undo): back at 3.
    cs = rt.updateBar(10, at(600, 116));
    expect(fromOf(cs, 'z')).toBe(3);
    expect(zz()[3]).toBe(110);
    expect(zz()[8]).toBeNaN();
    expect(zz()[10]).toBe(116);

    // A tick that moves nothing in the past: only the last bar changed.
    cs = rt.updateBar(10, at(600, 117));
    expect(fromOf(cs, 'z')).toBe(10);
    expect(fromOf(cs, 'ma')).toBe(10);

    // Move again, then a reversal 13 % down adds a low pivot at bar 12.
    rt.updateBar(10, at(600, 111));
    for (const [i, p] of [
      [11, 104],
      [12, 100],
      [13, 101],
    ] as const)
      expect(fromOf(rt.updateBar(i, at(i * 60, p)), 'z')).toBe(i - 1);
    cs = rt.updateBar(14, at(840, 103));
    expect(fromOf(cs, 'z')).toBe(12);
    expect(zz()[12]).toBe(100);
    expect(rt.result('z')!.values.loLbl![12]).toBe(100);
    expect(zz()[13]).toBeNaN();
    expect(zz()[14]).toBe(103);

    // Same arrays as computing everything at once.
    const all = flat([...prices, 111, 104, 100, 101, 103]);
    const full = withSma(inputs);
    full.setBars(toColumns(all));
    expect(snapshot(rt.result('z')!)).toEqual(snapshot(full.result('z')!));
    expect(snapshot(rt.result('ma')!)).toEqual(snapshot(full.result('ma')!));
  });

  it('registers a high and a low pivot on one bar (allowZigZagOnOneBar)', () => {
    // Bar 3 has the highest high and the lowest low of bars 1..5 (depth 4).
    const rows = [
      [100, 100],
      [101, 99],
      [101, 99],
      [120, 80],
      [101, 99],
      [101, 99],
      [101, 99],
      [101, 70],
      [101, 99],
      [101, 99],
    ];
    const bars = toColumns(
      rows.map(([h, l], i) => ({
        time: i * 60,
        open: 100,
        high: h!,
        low: l!,
        close: 100,
        volume: 1,
      })),
    );
    const inputs = { deviation: 5, depth: 4, extendToLastBar: false };
    const rt = withSma(inputs);
    rt.setBars(sliceBars(bars, 0, 7));
    const r = () => rt.result('z')!.values;
    // The high is tried first (first pivot), then the low reverses 33 % on the same bar.
    expect(r().zz![3]).toBe(80);
    expect(r().hiLbl![3]).toBe(120);
    expect(r().loLbl![3]).toBe(80);

    // The lower low at bar 7 (confirmed at 9) moves the low pivot away: bar 3's high shows again.
    for (let i = 7; i < rows.length; i++) rt.updateBar(i, barAt(bars, i));
    expect(r().zz![3]).toBe(120);
    expect(r().hiLbl![3]).toBe(120);
    expect(r().loLbl![3]).toBeNaN();
    expect(r().zz![7]).toBe(70);
    expect(r().loLbl![7]).toBe(70);

    const full = withSma(inputs);
    full.setBars(bars);
    expect(snapshot(rt.result('z')!)).toEqual(snapshot(full.result('z')!));
  });

  it('takes the oldest of equal highs/lows as the pivot', () => {
    // depth 4 (2 bars each side): equal highs at bars 2 and 3, equal lows at 6 and 7.
    const prices = [100, 104, 110, 110, 104, 100, 90, 90, 95, 100, 101];
    const rt = withSma({ deviation: 5, depth: 4, extendToLastBar: false });
    rt.setBars(toColumns(flat(prices)));
    const r = rt.result('z')!.values;
    expect(r.hiLbl![2]).toBe(110);
    expect(r.hiLbl![3]).toBeNaN();
    expect(r.loLbl![6]).toBe(90);
    expect(r.loLbl![7]).toBeNaN();
  });
});
