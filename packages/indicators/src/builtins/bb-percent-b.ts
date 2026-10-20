import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Bollinger Bands %B: position of the source between the bands (SMA basis, population stdev). */
export const BB_PERCENT_B = defineIndicator({
  id: 'bb-percent-b',
  name: 'Bollinger Bands %B',
  shortName: 'Bollinger Bands %B',
  category: 'volatility',
  keywords: ['bb', 'bollinger', '%b', 'percent b', 'bands'],
  overlay: false,
  precision: 4,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 20, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    mult: { kind: 'float', label: 'StdDev', default: 2, min: 0.001, max: 50, step: 0.1 },
  },
  outputs: [
    { type: 'hline', id: 'upperBand', title: 'Overbought', value: 1, color: COLOR.level },
    { type: 'hline', id: 'middleBand', title: 'Middle Band', value: 0.5, color: COLOR.levelMiddle },
    { type: 'hline', id: 'lowerBand', title: 'Oversold', value: 0, color: COLOR.level },
    {
      type: 'fill',
      id: 'background',
      title: 'Background',
      between: ['upperBand', 'lowerBand'],
      color: 'rgba(24, 163, 131, 0.19)',
    },
    { type: 'plot', id: 'pb', title: 'Bollinger Bands %B', kind: 'line', color: '#18a383' },
  ],
  setup({ inputs, ta }) {
    const ma = ta.sma(inputs.length);
    const sd = ta.stdev(inputs.length);
    return (c) => {
      const x = c.src.source[c.i]!;
      const basis = ma.update(x);
      const dev = inputs.mult * sd.update(x);
      const upper = basis + dev;
      const lower = basis - dev;
      // A flat window has no band (zero denominator -> NaN).
      c.set('pb', upper === lower ? NaN : (x - lower) / (upper - lower));
    };
  },
});
