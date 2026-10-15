import { defineIndicator } from '../registry';
import { COLOR } from './common';

/**
 * Klinger Oscillator (reference form): signed volume sv = change(hlc3) >= 0 ? volume
 * : -volume (the first bar, without change, counts as -volume as in standard);
 * kvo = ema(sv, fast) - ema(sv, slow), signal = ema(kvo, signal).
 */
export const KLINGER = defineIndicator({
  id: 'klinger',
  name: 'Klinger Oscillator',
  shortName: 'KVO',
  category: 'volume',
  keywords: ['klinger', 'kvo', 'oscillator', 'volume'],
  overlay: false,
  format: 'volume',
  inputs: {
    fast: { kind: 'int', label: 'Fast Length', default: 34, min: 1, max: 2000 },
    slow: { kind: 'int', label: 'Slow Length', default: 55, min: 1, max: 2000 },
    signal: { kind: 'int', label: 'Signal Length', default: 13, min: 1, max: 2000 },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero', value: 0, color: COLOR.level },
    { type: 'plot', id: 'kvo', title: 'Klinger Oscillator', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'signal', title: 'Signal', kind: 'line', color: COLOR.green },
  ],
  setup({ inputs, ta }) {
    const fast = ta.ema(inputs.fast);
    const slow = ta.ema(inputs.slow);
    const signal = ta.ema(inputs.signal);
    return (c) => {
      const i = c.i;
      const v = c.volume[i]!;
      const hlc3 = (k: number) => (c.high[k]! + c.low[k]! + c.close[k]!) / 3;
      // NaN >= 0 is false: the first bar is -volume (standard).
      const sv = i > 0 && hlc3(i) - hlc3(i - 1) >= 0 ? v : -v;
      const kvo = fast.update(sv) - slow.update(sv);
      c.set('kvo', kvo);
      c.set('signal', signal.update(kvo));
    };
  },
});
