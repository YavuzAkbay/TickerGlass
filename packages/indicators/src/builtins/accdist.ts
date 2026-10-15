import type { StepContext } from '../types';
import { defineIndicator } from '../registry';
import { COLOR } from './common';

type Hlcv = Pick<StepContext, 'i' | 'high' | 'low' | 'close' | 'volume'>;

/**
 * Money flow volume of bar `c.i`: close location value
 * ((close - low) - (high - close)) / (high - low) times volume, 0 for a bar
 * without range (standard `ta.accdist` term; shared by CMF and Chaikin Oscillator).
 */
export function moneyFlowVolume(c: Hlcv): number {
  const h = c.high[c.i]!;
  const l = c.low[c.i]!;
  const cl = c.close[c.i]!;
  const mfm = h === l || (cl === h && cl === l) ? 0 : (2 * cl - l - h) / (h - l);
  return mfm * c.volume[c.i]!;
}

/** Accumulation/Distribution: cumulative money flow volume from the first bar (TA-Lib AD). */
export const ACCDIST = defineIndicator({
  id: 'accdist',
  name: 'Accumulation/Distribution',
  shortName: 'Accum/Dist',
  category: 'volume',
  keywords: ['accdist', 'a/d', 'ad', 'accumulation', 'distribution', 'volume', 'money flow'],
  overlay: false,
  format: 'volume',
  warmup: { kind: 'cumulative' },
  inputs: {},
  outputs: [
    { type: 'plot', id: 'ad', title: 'Accumulation/Distribution', kind: 'line', color: COLOR.blue },
  ],
  setup({ ta }) {
    const ad = ta.cum();
    return (c) => {
      c.set('ad', ad.update(moneyFlowVolume(c)));
    };
  },
});
