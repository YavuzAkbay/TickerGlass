import { defineIndicator } from '../registry';
import { COLOR, stochValue } from './common';

/** Stochastic oscillator: %K = sma(stoch(close, high, low, n), smoothK), %D = sma(%K). */
export const STOCHASTIC = defineIndicator({
  id: 'stochastic',
  name: 'Stochastic',
  shortName: 'Stoch',
  category: 'momentum',
  keywords: ['stochastic', 'stoch', '%k', '%d', 'oscillator'],
  overlay: false,
  precision: 2,
  scaleRange: { min: 0, max: 100 },
  inputs: {
    periodK: { kind: 'int', label: '%K Length', default: 14, min: 1, max: 5000 },
    smoothK: { kind: 'int', label: '%K Smoothing', default: 1, min: 1, max: 5000 },
    periodD: { kind: 'int', label: '%D Smoothing', default: 3, min: 1, max: 5000 },
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
    { type: 'plot', id: 'k', title: '%K', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'd', title: '%D', kind: 'line', color: COLOR.orange },
  ],
  setup({ inputs, ta }) {
    const hi = ta.highest(inputs.periodK);
    const lo = ta.lowest(inputs.periodK);
    const smoothK = ta.sma(inputs.smoothK);
    const smoothD = ta.sma(inputs.periodD);
    return (c) => {
      const raw = stochValue(c.close[c.i]!, hi.update(c.high[c.i]!), lo.update(c.low[c.i]!));
      const k = smoothK.update(raw);
      c.set('k', k);
      c.set('d', smoothD.update(k));
    };
  },
});
