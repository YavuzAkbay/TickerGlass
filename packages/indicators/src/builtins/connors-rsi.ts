import { defineIndicator } from '../registry';
import { COLOR, change, rsiOf } from './common';

/**
 * Connors RSI: mean of RSI(src), RSI of the up/down streak length and the
 * percent rank of the one-bar ROC.
 */
export const CONNORS_RSI = defineIndicator({
  id: 'connors-rsi',
  name: 'Connors RSI',
  shortName: 'CRSI',
  category: 'momentum',
  keywords: ['crsi', 'connors', 'rsi', 'streak', 'percent rank', 'oscillator'],
  overlay: false,
  precision: 2,
  scaleRange: { min: 0, max: 100 },
  inputs: {
    rsiLength: { kind: 'int', label: 'RSI Length', default: 3, min: 1, max: 5000 },
    upDownLength: { kind: 'int', label: 'UpDown Length', default: 2, min: 1, max: 5000 },
    rocLength: { kind: 'int', label: 'ROC Length', default: 100, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    upperLevel: {
      kind: 'float',
      label: 'Upper Band',
      default: 70,
      group: 'Levels',
      hideInTitle: true,
    },
    lowerLevel: {
      kind: 'float',
      label: 'Lower Band',
      default: 30,
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
      color: COLOR.blueFill,
    },
    { type: 'plot', id: 'crsi', title: 'CRSI', kind: 'line', color: COLOR.blue },
  ],
  setup({ inputs, ta }) {
    const rsi = rsiOf(ta, inputs.rsiLength);
    const udRsi = rsiOf(ta, inputs.upDownLength);
    const rank = ta.percentrank(inputs.rocLength);
    // Streak length (standard `ud`): +k after k rising bars, -k after k falling.
    const s = ta.vars({ ud: NaN });
    return (c) => {
      const src = c.src.source;
      const x = src[c.i]!;
      const prev = c.i > 0 ? src[c.i - 1]! : NaN;
      const p = Number.isNaN(s.ud) ? 0 : s.ud;
      // standard comparisons with NaN are false: the first bar counts as falling.
      const ud = x === prev ? 0 : x > prev ? (p <= 0 ? 1 : p + 1) : p >= 0 ? -1 : p - 1;
      const udChange = ud - s.ud;
      s.ud = ud;
      const r1 = rsi.update(change(src, c.i));
      const r2 = udRsi.update(udChange);
      const r3 = rank.update((100 * (x - prev)) / prev);
      c.set('crsi', (r1 + r2 + r3) / 3);
    };
  },
});
