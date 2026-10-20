import { defineIndicator } from '../registry';
import type { Streaming, Ta } from '../types';
import { COLOR, change } from './common';

/**
 * TSI (unscaled, -1..1): ema(ema(chg, long),
 * short) / ema(ema(|chg|, long), short). Feed `change(close)`. Call in `setup`.
 */
export function ergodicOf(ta: Ta, long: number, short: number): Streaming {
  const pcLong = ta.ema(long);
  const pcShort = ta.ema(short);
  const absLong = ta.ema(long);
  const absShort = ta.ema(short);
  return {
    update(pc: number): number {
      const num = pcShort.update(pcLong.update(pc));
      const den = absShort.update(absLong.update(Math.abs(pc)));
      return den === 0 ? NaN : num / den;
    },
  };
}

/** SMI Ergodic Indicator: unscaled TSI and its EMA signal. */
export const SMI_ERGODIC = defineIndicator({
  id: 'smi-ergodic',
  name: 'SMI Ergodic Indicator',
  shortName: 'SMII',
  category: 'momentum',
  keywords: ['smi', 'ergodic', 'tsi', 'blau', 'oscillator'],
  overlay: false,
  precision: 4,
  inputs: {
    long: { kind: 'int', label: 'Long Length', default: 20, min: 1, max: 4999 },
    short: { kind: 'int', label: 'Short Length', default: 5, min: 1, max: 4999 },
    signal: { kind: 'int', label: 'Signal Line Length', default: 5, min: 1, max: 4999 },
  },
  outputs: [
    { type: 'plot', id: 'smi', title: 'SMI', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'signal', title: 'Signal', kind: 'line', color: COLOR.orange },
  ],
  setup({ inputs, ta }) {
    const erg = ergodicOf(ta, inputs.long, inputs.short);
    const signal = ta.ema(inputs.signal);
    return (c) => {
      const e = erg.update(change(c.close, c.i));
      c.set('smi', e);
      c.set('signal', signal.update(e));
    };
  },
});
