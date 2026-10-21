import { defineIndicator } from '../registry';
import { COLOR, change } from './common';

/** Chande Momentum Oscillator: 100 * (sum of gains - sum of losses) / (their total). */
export const CMO = defineIndicator({
  id: 'cmo',
  name: 'Chande Momentum Oscillator',
  shortName: 'ChandeMO',
  category: 'momentum',
  keywords: ['cmo', 'chande', 'momentum', 'oscillator'],
  overlay: false,
  precision: 2,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 9, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero Line', value: 0, color: COLOR.level },
    { type: 'plot', id: 'cmo', title: 'ChandeMO', kind: 'line', color: COLOR.blue },
  ],
  setup({ inputs, ta }) {
    const gains = ta.sum(inputs.length);
    const losses = ta.sum(inputs.length);
    return (c) => {
      const m = change(c.src.source, c.i);
      // Math.max keeps NaN, so both sums start at the first change.
      const s1 = gains.update(Math.max(m, 0));
      const s2 = losses.update(Math.max(-m, 0));
      const total = s1 + s2;
      c.set('cmo', total === 0 ? NaN : (100 * (s1 - s2)) / total);
    };
  },
});
