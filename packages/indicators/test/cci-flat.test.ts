import { expect, it } from 'vitest';
import { IndicatorRuntime } from '../src/runtime';
import { randomBars } from '../src/test-utils';
import '../src/builtins';
import { sliceBars } from './helpers';

it('CCI of a flat stretch is 0 (not Infinity) and its smoothing line stays finite', () => {
  const bars = sliceBars(randomBars(120, 5, 1_700_000_000, 900), 0, 120);
  // Flat stretch at a value whose window mean is not exactly representable.
  for (let i = 40; i < 90; i++) {
    bars.open[i] = bars.high[i] = bars.low[i] = bars.close[i] = 0.1 + 1e-3 * 7;
  }
  const rt = new IndicatorRuntime();
  rt.add({ id: 'x', type: 'cci', inputs: {} });
  rt.setBars(bars);
  const r = rt.result('x')!;
  const cci = Array.from(r.values.cci!.subarray(0, r.length));
  const ma = Array.from(r.values.ma!.subarray(0, r.length));
  // Windows fully inside the flat stretch.
  for (let i = 40 + 19; i < 90; i++) expect(cci[i]).toBe(0);
  expect(cci.every((v) => Number.isNaN(v) || Number.isFinite(v))).toBe(true);
  expect(ma.every((v) => Number.isNaN(v) || Number.isFinite(v))).toBe(true);
  expect(Number.isFinite(ma[r.length - 1]!)).toBe(true);
});
