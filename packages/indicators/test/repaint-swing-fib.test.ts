import { describe, expect, it } from 'vitest';
import '../src/builtins';
import { IndicatorRuntime, type Change } from '../src/runtime';
import { randomBars } from '../src/test-utils';
import type { BarArrays, BarInput, InputValueMap } from '../src/types';
import { barAt, sliceBars, snapshot } from './helpers';

/** Ticks that push the high/low far out and back (pivots created, cancelled, moved). */
function wildTicks(b: BarInput): BarInput[] {
  const o = b.open;
  return [
    { ...b, high: o, low: o, close: o },
    { ...b, high: b.high * 1.04, close: b.high * 1.04 },
    { ...b, low: b.low * 0.96, close: b.low * 0.96 },
    { ...b, high: b.high * 1.08, low: b.low * 0.92 },
    b,
  ];
}

function withSma(inputs: InputValueMap): IndicatorRuntime {
  const rt = new IndicatorRuntime();
  rt.add({ id: 'f', type: 'swing-fib', inputs });
  rt.add({
    id: 'ma',
    type: 'sma',
    inputs: { length: 2, source: { instanceId: 'f', outputId: 'l500' } },
  });
  return rt;
}

function feed(rt: IndicatorRuntime, cols: BarArrays, from: number): Change[][] {
  rt.setBars(sliceBars(cols, 0, from));
  const all: Change[][] = [];
  for (let i = from; i < cols.time.length; i++)
    for (const t of wildTicks(barAt(cols, i))) all.push(rt.updateBar(i, t));
  return all;
}

describe('swing-fib repaints', () => {
  it.each([
    { deviation: 1, depth: 4 },
    { deviation: 3, depth: 10 },
    { deviation: 0.5, depth: 6, reverse: true, show1618: true, show236: false },
  ])('live ticks and appends equal a full computation (%o)', (inputs) => {
    const bars = randomBars(400, 13, 1_700_000_000, 900);
    const full = withSma(inputs);
    full.setBars(bars);
    const live = withSma(inputs);
    const changes = feed(live, bars, 40);
    expect(full.status('f')).toEqual({ state: 'ok' });
    expect(snapshot(live.result('f')!)).toEqual(snapshot(full.result('f')!));
    expect(snapshot(live.result('ma')!)).toEqual(snapshot(full.result('ma')!));
    // The leg (and with it the drawn range) moved during live ticks.
    expect(changes.some((cs) => cs.some((c) => c.id === 'f' && c.from < live.length - 2))).toBe(
      true,
    );
    // Dependents recompute from the start after a past change.
    expect(
      changes.some(
        (cs) =>
          cs.some((c) => c.id === 'f' && c.from < live.length - 1) &&
          cs.find((c) => c.id === 'ma')?.from === 0,
      ),
    ).toBe(true);
  });

  it('draws one contiguous range ending at the last bar, levels between the leg prices', () => {
    const bars = randomBars(400, 13, 1_700_000_000, 900);
    const rt = withSma({});
    rt.setBars(bars);
    const v = rt.result('f')!.values;
    const n = rt.result('f')!.length;
    const l0 = Array.from(v.l0!.subarray(0, n));
    const start = l0.findIndex((x) => !Number.isNaN(x));
    expect(start).toBeGreaterThan(0);
    expect(l0.slice(start).every((x) => x === l0[n - 1])).toBe(true);
    // Level 0 is the leg's end pivot, 1 its start; 0.5 halfway; 1.618 is off by default.
    const end = l0[n - 1]!;
    const begin = v.l1000![n - 1]!;
    expect(v.l500![n - 1]).toBeCloseTo((end + begin) / 2, 10);
    expect(Array.from(v.l1618!.subarray(0, n)).every(Number.isNaN)).toBe(true);
    // The leg starts at a pivot: its price is that bar's high or low.
    expect([bars.high[start], bars.low[start]]).toContain(begin);
  });
});
