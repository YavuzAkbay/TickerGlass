import { defineIndicator } from '../registry';

/** Double exponential moving average: 2 * ema(src) - ema(ema(src)). */
export const DEMA = defineIndicator({
  id: 'dema',
  name: 'Double EMA',
  shortName: 'DEMA',
  category: 'movingAverage',
  keywords: ['ma', 'double', 'exponential', 'average', 'dema'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 9, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'dema', title: 'DEMA', kind: 'line', color: '#43a047' }],
  setup({ inputs, ta }) {
    const e1 = ta.ema(inputs.length);
    const e2 = ta.ema(inputs.length);
    return (c) => {
      const a = e1.update(c.src.source[c.i]!);
      c.set('dema', 2 * a - e2.update(a));
    };
  },
});
