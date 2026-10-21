import { defineIndicator } from '../registry';
import { COLOR, change } from './common';

/**
 * Relative Volatility Index: RSI-like ratio of the EMA of the source stdev on
 * up bars to the EMA of it on all bars (usual form).
 */
export const RVOL_INDEX = defineIndicator({
  id: 'rvol-index',
  name: 'Relative Volatility Index',
  shortName: 'RVI',
  category: 'volatility',
  keywords: ['rvi', 'relative volatility', 'volatility', 'stdev', 'oscillator'],
  overlay: false,
  precision: 2,
  scaleRange: { min: 0, max: 100 },
  inputs: {
    length: { kind: 'int', label: 'StdDev Length', default: 10, min: 1, max: 5000 },
    smoothing: { kind: 'int', label: 'Smoothing Length', default: 14, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
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
      color: COLOR.purpleFill,
    },
    { type: 'plot', id: 'rvi', title: 'RVI', kind: 'line', color: COLOR.purple },
  ],
  setup({ inputs, ta }) {
    const sd = ta.stdev(inputs.length);
    const up = ta.ema(inputs.smoothing);
    const down = ta.ema(inputs.smoothing);
    return (c) => {
      const src = c.src.source;
      const s = sd.update(src[c.i]!);
      const ch = change(src, c.i);
      // Usual form: `chg <= 0 ? 0 : s` and `chg > 0 ? 0 : s`, so a NaN
      // change (first bar) feeds s to both. Both EMAs start once s is valid.
      const valid = !Number.isNaN(s);
      const u = up.update(!valid ? NaN : ch <= 0 ? 0 : s);
      const d = down.update(!valid ? NaN : ch > 0 ? 0 : s);
      const total = u + d;
      c.set('rvi', total === 0 ? NaN : (100 * u) / total);
    };
  },
});
