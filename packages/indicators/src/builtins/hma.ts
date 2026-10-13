import { defineIndicator } from '../registry';
import { COLOR } from './common';

/**
 * Hull moving average (standard `ta.hma`):
 * wma(2 * wma(src, floor(len / 2)) - wma(src, len), floor(sqrt(len))).
 */
export const HMA = defineIndicator({
  id: 'hma',
  name: 'Hull Moving Average',
  shortName: 'HMA',
  category: 'movingAverage',
  keywords: ['ma', 'hull', 'average'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 9, min: 2, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    offset: { kind: 'int', label: 'Offset', default: 0, min: -500, max: 500, hideInTitle: true },
  },
  outputs: [
    {
      type: 'plot',
      id: 'hma',
      title: 'HMA',
      kind: 'line',
      color: COLOR.blue,
      offset: (inputs) => inputs.offset,
    },
  ],
  setup({ inputs, ta }) {
    const n = inputs.length;
    const half = ta.wma(Math.max(1, Math.floor(n / 2)));
    const full = ta.wma(n);
    const hull = ta.wma(Math.max(1, Math.floor(Math.sqrt(n))));
    return (c) => {
      const x = c.src.source[c.i]!;
      c.set('hma', hull.update(2 * half.update(x) - full.update(x)));
    };
  },
});
