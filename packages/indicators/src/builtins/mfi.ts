import { defineIndicator } from '../registry';
import { COLOR, change } from './common';

/**
 * Money Flow Index: 100 - 100 / (1 + positive flow / negative flow) over
 * `length` bars, flow = src * volume signed by change(src). The first bar has
 * no change and is skipped (first value at index `length`, as TA-Lib).
 */
export const MFI = defineIndicator({
  id: 'mfi',
  name: 'Money Flow Index',
  shortName: 'MFI',
  category: 'volume',
  keywords: ['mfi', 'money flow', 'volume', 'oscillator'],
  overlay: false,
  precision: 2,
  scaleRange: { min: 0, max: 100 },
  inputs: {
    length: { kind: 'int', label: 'Length', default: 14, min: 1, max: 2000 },
    source: { kind: 'source', label: 'Source', default: 'hlc3' },
    upperLevel: {
      kind: 'float',
      label: 'Overbought',
      default: 80,
      group: 'Levels',
      hideInTitle: true,
    },
    lowerLevel: {
      kind: 'float',
      label: 'Oversold',
      default: 20,
      group: 'Levels',
      hideInTitle: true,
    },
  },
  outputs: [
    {
      type: 'hline',
      id: 'overbought',
      title: 'Overbought',
      value: (inputs) => inputs.upperLevel,
      color: COLOR.level,
    },
    { type: 'hline', id: 'middleBand', title: 'Middle Band', value: 50, color: COLOR.levelMiddle },
    {
      type: 'hline',
      id: 'oversold',
      title: 'Oversold',
      value: (inputs) => inputs.lowerLevel,
      color: COLOR.level,
    },
    {
      type: 'fill',
      id: 'background',
      title: 'Background',
      between: ['overbought', 'oversold'],
      color: COLOR.purpleFill,
    },
    { type: 'plot', id: 'mf', title: 'MF', kind: 'line', color: COLOR.purple },
  ],
  setup({ inputs, ta }) {
    const pos = ta.sum(inputs.length);
    const neg = ta.sum(inputs.length);
    return (c) => {
      const x = c.src.source[c.i]!;
      const ch = change(c.src.source, c.i);
      const flow = x * c.volume[c.i]!;
      // NaN change (first bar) is skipped by both sums.
      const upper = pos.update(ch > 0 ? flow : Number.isNaN(ch) ? NaN : 0);
      const lower = neg.update(ch < 0 ? flow : Number.isNaN(ch) ? NaN : 0);
      c.set('mf', 100 - 100 / (1 + upper / lower));
    };
  },
});
