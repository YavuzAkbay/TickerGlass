import { describe, expect, it } from 'vitest';
import { BarStore } from '../bars';
import { IndicatorInstance } from '../instance';
import { randomBars } from '../test-utils';
import { EMA } from './ema';
import { SMA } from './sma';

function closes(values: number[]): BarStore {
  const store = new BarStore();
  const f = Float64Array.from(values);
  store.setAll({ time: f.map((_, i) => i), open: f, high: f, low: f, close: f, volume: f });
  return store;
}

describe('SMA', () => {
  it('averages a sliding window and pads the warm-up with NaN', () => {
    const inst = new IndicatorInstance(SMA, { length: 3 });
    inst.computeAll(closes([1, 2, 3, 4, 5]));
    const out = Array.from(inst.result().values.ma!.subarray(0, 5));
    expect(out.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(out.slice(2)).toEqual([2, 3, 4]);
  });

  it('matches a naive window mean', () => {
    const bars = new BarStore();
    bars.setAll(randomBars(200));
    const inst = new IndicatorInstance(SMA, { length: 14, source: 'hlc3' });
    inst.computeAll(bars);
    const ma = inst.result().values.ma!;
    for (let i = 13; i < 200; i++) {
      let sum = 0;
      for (let k = i - 13; k <= i; k++) sum += bars.hlc3[k]!;
      expect(ma[i]).toBeCloseTo(sum / 14, 10);
    }
  });
});

describe('EMA', () => {
  it('seeds with the SMA of the first length values, then smooths', () => {
    const inst = new IndicatorInstance(EMA, { length: 3 });
    inst.computeAll(closes([1, 2, 3, 4, 5]));
    const out = Array.from(inst.result().values.ema!.subarray(0, 5));
    expect(out.slice(0, 2).every(Number.isNaN)).toBe(true);
    // seed 2, alpha 0.5: 0.5*4 + 0.5*2 = 3, 0.5*5 + 0.5*3 = 4
    expect(out.slice(2)).toEqual([2, 3, 4]);
  });
});
