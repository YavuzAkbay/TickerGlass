import { defineIndicator } from '../registry';

/** Smoothed moving average: Wilder's RMA (alpha = 1/length), seeded with the SMA. */
export const SMMA = defineIndicator({
  id: 'smma',
  name: 'Smoothed Moving Average',
  shortName: 'SMMA',
  category: 'movingAverage',
  keywords: ['ma', 'smoothed', 'rma', 'wilder', 'average', 'smma'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 7, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'smma', title: 'SMMA', kind: 'line', color: '#8e5cf6' }],
  setup({ inputs, ta }) {
    const rma = ta.rma(inputs.length);
    return (c) => c.set('smma', rma.update(c.src.source[c.i]!));
  },
});
