import { describe, expect, it } from 'vitest';
import '../src/builtins';
import { IndicatorRuntime, type Change } from '../src/runtime';
import { randomBars } from '../src/test-utils';
import type { BarArrays, BarInput, InputValueMap } from '../src/types';
import { barAt, sliceBars, snapshot } from './helpers';

const OUTPUTS = ['mid', 'upper', 'lower', 'r'] as const;

/** Ticks moving the close (and the high/low with it) back and forth. */
function wildTicks(b: BarInput): BarInput[] {
  const at = (close: number): BarInput => ({
    ...b,
    high: Math.max(b.high, close),
    low: Math.min(b.low, close),
    close,
  });
  return [at(b.open), at(b.high + 2), at(b.low - 2), b];
}

/** Channel `c` (optionally on another instance's output), plus an SMA of its mid line. */
function runtime(inputs: InputValueMap, onSma = false): IndicatorRuntime {
  const rt = new IndicatorRuntime();
  if (onSma) rt.add({ id: 's', type: 'sma', inputs: { length: 10 } });
  rt.add({
    id: 'c',
    type: 'linreg-channel',
    inputs: onSma ? { ...inputs, source: { instanceId: 's', outputId: 'ma' } } : inputs,
  });
  rt.add({
    id: 'ma',
    type: 'sma',
    inputs: { length: 3, source: { instanceId: 'c', outputId: 'mid' } },
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

const fromOf = (cs: Change[], id: string) => cs.find((c) => c.id === id)?.from;

describe('linreg-channel repaints', () => {
  const bars = randomBars(200, 9, 1_700_000_000, 900);

  it.each([
    [{ length: 20 }, false],
    [{ length: 7, useUpperDev: false, useLowerDev: false }, false],
    [{ length: 12, upperDev: 1, useLowerDev: false }, true],
  ] as const)('live ticks and appends equal a full computation (%o, on SMA %s)', (inputs, onSma) => {
    const full = runtime(inputs, onSma);
    full.setBars(bars);
    const live = runtime(inputs, onSma);
    const changes = feed(live, bars, 5);
    expect(full.status('c')).toEqual({ state: 'ok' });
    expect(snapshot(live.result('c')!)).toEqual(snapshot(full.result('c')!));
    expect(snapshot(live.result('ma')!)).toEqual(snapshot(full.result('ma')!));
    expect(changes.some((cs) => cs.some((c) => c.id === 'c' && c.from < live.length - 1))).toBe(
      true,
    );
  });

  it('draws only the last window and shifts it on append', () => {
    const rt = runtime({ length: 5 });
    rt.setBars(sliceBars(bars, 0, 4));
    const vals = () => rt.result('c')!.values;
    // Fewer bars than the length: nothing.
    for (const id of OUTPUTS) expect(Array.from(vals()[id]!.subarray(0, 4)).every(Number.isNaN));

    // The fifth bar completes the first window [0, 4].
    let cs = rt.updateBar(4, barAt(bars, 4));
    expect(fromOf(cs, 'c')).toBe(0);
    expect(fromOf(cs, 'ma')).toBe(0);
    expect(Array.from(vals().mid!.subarray(0, 5)).some(Number.isNaN)).toBe(false);

    // Append: window [1, 5]; bar 0 is cleared.
    cs = rt.updateBar(5, barAt(bars, 5));
    expect(fromOf(cs, 'c')).toBe(0);
    for (const id of OUTPUTS) expect(vals()[id]![0]).toBeNaN();
    expect(Number.isNaN(vals().mid![1]!)).toBe(false);

    // Update: the whole window [1, 5] refits; bar 0 stays clear.
    cs = rt.updateBar(5, { ...barAt(bars, 5), close: barAt(bars, 5).close + 3 });
    expect(fromOf(cs, 'c')).toBe(1);
    expect(fromOf(cs, 'ma')).toBe(0);
    expect(vals().mid![0]).toBeNaN();

    // The same bar again: everything redrawn identically, only the last bar reported.
    cs = rt.updateBar(5, { ...barAt(bars, 5), close: barAt(bars, 5).close + 3 });
    expect(fromOf(cs, 'c')).toBe(5);

    // Back to the real close: same arrays as a full computation.
    rt.updateBar(5, barAt(bars, 5));
    const full = runtime({ length: 5 });
    full.setBars(sliceBars(bars, 0, 6));
    expect(snapshot(rt.result('c')!)).toEqual(snapshot(full.result('c')!));
    expect(snapshot(rt.result('ma')!)).toEqual(snapshot(full.result('ma')!));
  });

  it('fits the window: mid is the least-squares line, upper/lower at 2 sample deviations', () => {
    const rt = runtime({ length: 5 });
    rt.setBars(sliceBars(bars, 0, 30));
    const v = rt.result('c')!.values;
    const y = Array.from(bars.close).slice(25, 30) as number[];
    const xm = 2;
    const ym = y.reduce((a, b) => a + b, 0) / 5;
    let sxy = 0;
    let sxx = 0;
    y.forEach((yi, x) => {
      sxy += (x - xm) * (yi - ym);
      sxx += (x - xm) ** 2;
    });
    const b = sxy / sxx;
    const fit = y.map((_, x) => ym + b * (x - xm));
    const sd = Math.sqrt(y.reduce((a, yi, x) => a + (yi - fit[x]!) ** 2, 0) / 4);
    for (let x = 0; x < 5; x++) {
      expect(v.mid![25 + x]).toBeCloseTo(fit[x]!, 10);
      expect(v.upper![25 + x]).toBeCloseTo(fit[x]! + 2 * sd, 10);
      expect(v.lower![25 + x]).toBeCloseTo(fit[x]! - 2 * sd, 10);
    }
    expect(v.mid![24]).toBeNaN();
  });
});
