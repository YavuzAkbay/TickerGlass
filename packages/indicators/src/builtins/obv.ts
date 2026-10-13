import { defineIndicator } from '../registry';
import { COLOR, change } from './common';

/**
 * On Balance Volume: cumulative sign(change(src)) * volume. Starts at 0 on the
 * first bar (standard `ta.cum` of na); TA-Lib starts at the first bar's volume.
 */
export const OBV = defineIndicator({
  id: 'obv',
  name: 'On Balance Volume',
  shortName: 'OBV',
  category: 'volume',
  keywords: ['obv', 'on balance volume', 'volume', 'accumulation'],
  overlay: false,
  format: 'volume',
  inputs: {
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'obv', title: 'OnBalanceVolume', kind: 'line', color: COLOR.blue }],
  setup({ ta }) {
    const st = ta.vars({ total: 0 });
    return (c) => {
      const ch = change(c.src.source, c.i);
      const v = Math.sign(ch) * c.volume[c.i]!;
      if (!Number.isNaN(v)) st.total += v;
      c.set('obv', st.total);
    };
  },
});
