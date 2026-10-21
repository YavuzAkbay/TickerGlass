import { defineIndicator } from '../registry';
import { COLOR } from './common';

/**
 * McGinley Dynamic: starts at the SMA of the first `length` values (the usual EMA
 * seed, same value), then mg += (src - mg) / (length * (src / mg)^4).
 */
export const MCGINLEY = defineIndicator({
  id: 'mcginley',
  name: 'McGinley Dynamic',
  shortName: 'McGinley Dynamic',
  category: 'movingAverage',
  keywords: ['ma', 'mcginley', 'dynamic', 'average'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 14, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'mg', title: 'McGinley Dynamic', kind: 'line', color: COLOR.blue }],
  setup({ inputs, ta }) {
    const n = inputs.length;
    const seed = ta.sma(n);
    const s = ta.vars({ mg: NaN });
    return (c) => {
      const x = c.src.source[c.i]!;
      const avg = seed.update(x);
      if (Number.isNaN(x)) {
        c.set('mg', NaN);
        return;
      }
      s.mg = Number.isNaN(s.mg) ? avg : s.mg + (x - s.mg) / (n * (x / s.mg) ** 4);
      c.set('mg', s.mg);
    };
  },
});
