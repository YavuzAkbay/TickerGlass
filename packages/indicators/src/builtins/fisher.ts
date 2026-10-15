import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** standard `round_`: keep the smoothed position inside (-1, 1). */
function clampValue(v: number): number {
  return v > 0.99 ? 0.999 : v < -0.99 ? -0.999 : v;
}

/** Value of x, or 0 when NaN (standard `nz`). */
function nz(x: number): number {
  return Number.isNaN(x) ? 0 : x;
}

/**
 * Fisher Transform of hl2's position in its `length`-bar range (reference port).
 * An empty range gives NaN for that bar; the next bar restarts from 0 (nz).
 */
export const FISHER = defineIndicator({
  id: 'fisher',
  name: 'Fisher Transform',
  shortName: 'Fisher',
  category: 'momentum',
  keywords: ['fisher', 'transform', 'ehlers', 'oscillator'],
  overlay: false,
  precision: 2,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 9, min: 1, max: 5000 },
  },
  outputs: [
    { type: 'hline', id: 'level1', title: '1.5', value: 1.5, color: '#e91e63' },
    { type: 'hline', id: 'level2', title: '0.75', value: 0.75, color: COLOR.level },
    { type: 'hline', id: 'level3', title: '0', value: 0, color: '#e91e63' },
    { type: 'hline', id: 'level4', title: '-0.75', value: -0.75, color: COLOR.level },
    { type: 'hline', id: 'level5', title: '-1.5', value: -1.5, color: '#e91e63' },
    { type: 'plot', id: 'fisher', title: 'Fisher', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'trigger', title: 'Trigger', kind: 'line', color: COLOR.orange },
  ],
  setup({ inputs, ta }) {
    const hi = ta.highest(inputs.length);
    const lo = ta.lowest(inputs.length);
    const value = ta.series();
    return (c) => {
      const i = c.i;
      const hl2 = (c.high[i]! + c.low[i]!) / 2;
      const hh = hi.update(hl2);
      const ll = lo.update(hl2);
      const pos = hh === ll ? NaN : (hl2 - ll) / (hh - ll);
      const v = clampValue(0.66 * (pos - 0.5) + 0.67 * nz(value.get(i - 1)));
      value.set(i, v);
      const prev = c.get('fisher', i - 1);
      c.set('fisher', 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * nz(prev));
      c.set('trigger', prev);
    };
  },
});
