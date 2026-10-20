import { defineIndicator } from '../registry';
import { change } from './common';
import { ergodicOf } from './smi-ergodic';

/** SMI Ergodic Histogram: SMI Ergodic minus its signal, as a histogram. */
export const SMI_ERGODIC_OSC = defineIndicator({
  id: 'smi-ergodic-osc',
  name: 'SMI Ergodic Histogram',
  shortName: 'SMI Hist',
  category: 'momentum',
  keywords: ['smi', 'ergodic', 'tsi', 'blau', 'oscillator', 'histogram'],
  overlay: false,
  precision: 4,
  inputs: {
    long: { kind: 'int', label: 'Long Length', default: 20, min: 1, max: 4999 },
    short: { kind: 'int', label: 'Short Length', default: 5, min: 1, max: 4999 },
    signal: { kind: 'int', label: 'Signal Line Length', default: 5, min: 1, max: 4999 },
  },
  outputs: [
    {
      type: 'plot',
      id: 'osc',
      title: 'SMI Ergodic Histogram',
      kind: 'histogram',
      color: '#e5484d',
    },
  ],
  setup({ inputs, ta }) {
    const erg = ergodicOf(ta, inputs.long, inputs.short);
    const signal = ta.ema(inputs.signal);
    return (c) => {
      const e = erg.update(change(c.close, c.i));
      c.set('osc', e - signal.update(e));
    };
  },
});
