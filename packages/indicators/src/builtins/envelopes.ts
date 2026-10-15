import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Envelopes: SMA (or EMA) basis with bands percent above and below it. */
export const ENVELOPES = defineIndicator({
  id: 'envelopes',
  name: 'Envelopes',
  shortName: 'Env',
  category: 'bands',
  keywords: ['envelope', 'envelopes', 'bands', 'percent', 'channel'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 20, min: 1, max: 5000 },
    percent: { kind: 'float', label: 'Percent', default: 10, min: 0, max: 100, step: 0.5 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    exponential: { kind: 'bool', label: 'Exponential', default: false, hideInTitle: true },
  },
  outputs: [
    { type: 'plot', id: 'basis', title: 'Basis', kind: 'line', color: COLOR.orange },
    { type: 'plot', id: 'upper', title: 'Upper', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'lower', title: 'Lower', kind: 'line', color: COLOR.blue },
    {
      type: 'fill',
      id: 'background',
      title: 'Background',
      between: ['upper', 'lower'],
      color: COLOR.blueFill,
    },
  ],
  setup({ inputs, ta }) {
    const ma = inputs.exponential ? ta.ema(inputs.length) : ta.sma(inputs.length);
    const k = inputs.percent / 100;
    return (c) => {
      const basis = ma.update(c.src.source[c.i]!);
      c.set('basis', basis);
      c.set('upper', basis * (1 + k));
      c.set('lower', basis * (1 - k));
    };
  },
});
