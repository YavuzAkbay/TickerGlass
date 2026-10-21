import { defineIndicator } from '../registry';
import { COLOR } from './common';

/**
 * Kaufman adaptive moving average. Efficiency ratio
 * er = |src - src[L]| / sum(|chg(src)|, L) (0 when the path is flat) scales
 * alpha = (er * (fast - slow) + slow)^2 between the fast and slow EMA alphas;
 * kama = alpha * src + (1 - alpha) * kama[1], starting at src on bar L.
 */
export const KAMA = defineIndicator({
  id: 'kama',
  name: 'Kaufman Adaptive Moving Average',
  shortName: 'KAMA',
  category: 'movingAverage',
  keywords: ['ma', 'kaufman', 'adaptive', 'efficiency ratio', 'average', 'kama'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 10, min: 1, max: 5000 },
    fast: { kind: 'int', label: 'Fast Length', default: 2, min: 1, max: 5000 },
    slow: { kind: 'int', label: 'Slow Length', default: 30, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'kama', title: 'KAMA', kind: 'line', color: COLOR.blue }],
  setup({ inputs, ta }) {
    const n = inputs.length;
    const fa = 2 / (inputs.fast + 1);
    const sa = 2 / (inputs.slow + 1);
    const mom = ta.change(n);
    const chg = ta.change();
    const vol = ta.sum(n);
    const s = ta.vars({ kama: NaN });
    return (c) => {
      const x = c.src.source[c.i]!;
      const m = Math.abs(mom.update(x));
      const v = vol.update(Math.abs(chg.update(x)));
      if (Number.isNaN(m) || Number.isNaN(v)) {
        c.set('kama', NaN);
        return;
      }
      const er = v !== 0 ? m / v : 0;
      const alpha = (er * (fa - sa) + sa) ** 2;
      const prev = Number.isNaN(s.kama) ? x : s.kama;
      s.kama = alpha * x + (1 - alpha) * prev;
      c.set('kama', s.kama);
    };
  },
});
