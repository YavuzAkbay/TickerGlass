import { defineIndicator } from '../registry';
import { COLOR } from './common';

/**
 * Ultimate Oscillator: weighted (4:2:1) buying pressure / true range ratios
 * over the fast, middle and slow lengths. The first bar has no previous
 * close (NaN), so values start at bar `slow` (as TA-Lib ULTOSC).
 */
export const ULTIMATE_OSC = defineIndicator({
  id: 'ultimate-osc',
  name: 'Ultimate Oscillator',
  shortName: 'UO',
  category: 'momentum',
  keywords: ['uo', 'ultimate oscillator', 'williams', 'oscillator'],
  overlay: false,
  precision: 2,
  inputs: {
    fast: { kind: 'int', label: 'Fast Length', default: 7, min: 1, max: 5000 },
    middle: { kind: 'int', label: 'Middle Length', default: 14, min: 1, max: 5000 },
    slow: { kind: 'int', label: 'Slow Length', default: 28, min: 1, max: 5000 },
  },
  outputs: [{ type: 'plot', id: 'uo', title: 'UO', kind: 'line', color: COLOR.brightRed }],
  setup({ inputs, ta }) {
    const lengths = [inputs.fast, inputs.middle, inputs.slow];
    const bp = lengths.map((n) => ta.sum(n));
    const tr = lengths.map((n) => ta.sum(n));
    return (c) => {
      const i = c.i;
      const pc = i > 0 ? c.close[i - 1]! : NaN;
      const hi = Math.max(c.high[i]!, pc);
      const lo = Math.min(c.low[i]!, pc);
      const b = c.close[i]! - lo;
      const t = hi - lo;
      const avg = (k: number) => {
        const den = tr[k]!.update(t);
        const num = bp[k]!.update(b);
        return den === 0 ? NaN : num / den;
      };
      const [a1, a2, a3] = [avg(0), avg(1), avg(2)];
      c.set('uo', (100 * (4 * a1 + 2 * a2 + a3)) / 7);
    };
  },
});
