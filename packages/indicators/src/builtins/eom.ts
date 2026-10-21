import { defineIndicator } from '../registry';
import { COLOR } from './common';

/**
 * Ease of Movement: sma(divisor * change(hl2) * (high - low) / volume, length).
 * The first bar has no change (first value at index `length`); a zero-volume
 * bar has no term (NaN, the average keeps its state).
 */
export const EOM = defineIndicator({
  id: 'eom',
  name: 'Ease of Movement',
  shortName: 'EOM',
  category: 'volume',
  keywords: ['eom', 'ease of movement', 'emv', 'volume'],
  overlay: false,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 14, min: 1, max: 2000 },
    divisor: { kind: 'int', label: 'Divisor', default: 10000, min: 1, max: 1_000_000_000 },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero', value: 0, color: COLOR.level },
    { type: 'plot', id: 'eom', title: 'EOM', kind: 'line', color: COLOR.green },
  ],
  setup({ inputs, ta }) {
    const ma = ta.sma(inputs.length);
    return (c) => {
      const i = c.i;
      const h = c.high[i]!;
      const l = c.low[i]!;
      const v = c.volume[i]!;
      const hl2Change = i > 0 ? (h + l - c.high[i - 1]! - c.low[i - 1]!) / 2 : NaN;
      const term = v === 0 ? NaN : (inputs.divisor * hl2Change * (h - l)) / v;
      c.set('eom', ma.update(term));
    };
  },
});
