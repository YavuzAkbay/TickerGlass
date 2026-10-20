import { defineIndicator } from '../registry';
import { COLOR, change } from './common';

/**
 * Price Volume Trend: cumulative change(src) / src[1] * volume. The first bar
 * has no change and is NaN; the total starts on the second bar.
 */
export const PVT = defineIndicator({
  id: 'pvt',
  name: 'Price Volume Trend',
  shortName: 'PVT',
  category: 'volume',
  keywords: ['pvt', 'price volume trend', 'volume', 'cumulative'],
  overlay: false,
  format: 'volume',
  warmup: { kind: 'cumulative' },
  inputs: {
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'pvt', title: 'PVT', kind: 'line', color: COLOR.blue }],
  setup({ ta }) {
    const total = ta.cum();
    return (c) => {
      const i = c.i;
      const prev = i > 0 ? c.src.source[i - 1]! : NaN;
      // A zero previous source has no defined return (missing value): NaN, total unchanged.
      const ret = prev === 0 ? NaN : change(c.src.source, i) / prev;
      c.set('pvt', total.update(ret * c.volume[i]!));
    };
  },
});
