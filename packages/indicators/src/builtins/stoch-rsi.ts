import { defineIndicator } from '../registry';
import { COLOR, change, rsiOf, stochValue } from './common';

/** Stochastic RSI: stochastic of the RSI, smoothed into %K and %D. */
export const STOCH_RSI = defineIndicator({
  id: 'stoch-rsi',
  name: 'Stochastic RSI',
  shortName: 'Stoch RSI',
  category: 'momentum',
  keywords: ['stochastic', 'rsi', 'stochrsi', 'oscillator'],
  overlay: false,
  precision: 2,
  scaleRange: { min: 0, max: 100 },
  inputs: {
    smoothK: { kind: 'int', label: 'K', default: 3, min: 1, max: 5000 },
    smoothD: { kind: 'int', label: 'D', default: 3, min: 1, max: 5000 },
    rsiLength: { kind: 'int', label: 'RSI Length', default: 14, min: 1, max: 5000 },
    stochLength: { kind: 'int', label: 'Stochastic Length', default: 14, min: 1, max: 5000 },
    source: { kind: 'source', label: 'RSI Source', default: 'close' },
    upperLevel: {
      kind: 'float',
      label: 'Upper Band',
      default: 80,
      group: 'Levels',
      hideInTitle: true,
    },
    lowerLevel: {
      kind: 'float',
      label: 'Lower Band',
      default: 20,
      group: 'Levels',
      hideInTitle: true,
    },
  },
  outputs: [
    {
      type: 'hline',
      id: 'upperBand',
      title: 'Upper Band',
      value: (inputs) => inputs.upperLevel,
      color: COLOR.level,
    },
    { type: 'hline', id: 'middleBand', title: 'Middle Band', value: 50, color: COLOR.levelMiddle },
    {
      type: 'hline',
      id: 'lowerBand',
      title: 'Lower Band',
      value: (inputs) => inputs.lowerLevel,
      color: COLOR.level,
    },
    {
      type: 'fill',
      id: 'background',
      title: 'Background',
      between: ['upperBand', 'lowerBand'],
      color: COLOR.blueFill,
    },
    { type: 'plot', id: 'k', title: 'K', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'd', title: 'D', kind: 'line', color: COLOR.orange },
  ],
  setup({ inputs, ta }) {
    const rsi = rsiOf(ta, inputs.rsiLength);
    const hi = ta.highest(inputs.stochLength);
    const lo = ta.lowest(inputs.stochLength);
    const smoothK = ta.sma(inputs.smoothK);
    const smoothD = ta.sma(inputs.smoothD);
    return (c) => {
      const r = rsi.update(change(c.src.source, c.i));
      const k = smoothK.update(stochValue(r, hi.update(r), lo.update(r)));
      c.set('k', k);
      c.set('d', smoothD.update(k));
    };
  },
});
