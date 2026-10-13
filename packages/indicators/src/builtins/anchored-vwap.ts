import { defineIndicator } from '../registry';
import { COLOR } from './common';
import { BAND_OUTPUTS, VWAP_SUMS, bandInputs, setBands, vwapUpdate } from './vwap-bands';

/**
 * VWAP accumulated from the first bar at or after the anchor time (0 = from
 * the first bar). Bars before the anchor are NaN.
 */
export const ANCHORED_VWAP = defineIndicator({
  id: 'anchored-vwap',
  name: 'Anchored VWAP',
  shortName: 'Anchored VWAP',
  category: 'volume',
  keywords: ['vwap', 'anchored', 'avwap', 'volume', 'weighted', 'average', 'price'],
  overlay: true,
  inputs: {
    anchor: { kind: 'time', label: 'Anchor Time', default: 0, hideInTitle: true },
    source: { kind: 'source', label: 'Source', default: 'hlc3' },
    ...bandInputs(false),
  },
  outputs: [
    { type: 'plot', id: 'vwap', title: 'VWAP', kind: 'line', color: COLOR.blue },
    ...BAND_OUTPUTS,
  ],
  setup({ inputs, ta }) {
    const st = ta.vars({ ...VWAP_SUMS, started: 0 });
    return (c) => {
      if (c.time[c.i]! < inputs.anchor) return;
      const isNew = st.started === 0;
      st.started = 1;
      const vwap = vwapUpdate(st, isNew, c.src.source[c.i]!, c.volume[c.i]!);
      c.set('vwap', vwap);
      setBands(c, inputs, vwap, st.sd);
    };
  },
});
