import { defineIndicator } from '../registry';
import { COLOR } from './common';
import { BAND_OUTPUTS, VWAP_SUMS, bandInputs, setBands, vwapUpdate } from './vwap-bands';

export const VWAP_ANCHORS = ['Session', 'Week', 'Month'] as const;
export type VwapAnchor = (typeof VWAP_ANCHORS)[number];

const DAY = 86_400;

/**
 * Period number of a bar time for an anchor. Boundaries are UTC calendar
 * days, ISO weeks (Monday) and months: the runtime has no exchange timezone.
 */
export function anchorPeriod(time: number, anchor: VwapAnchor): number {
  const day = Math.floor(time / DAY);
  if (anchor === 'Session') return day;
  // 1970-01-01 was a Thursday; +3 makes weeks start on Monday.
  if (anchor === 'Week') return Math.floor((day + 3) / 7);
  const d = new Date(time * 1000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/** Volume-weighted average price, reset every anchor period, with optional bands. */
export const VWAP = defineIndicator({
  id: 'vwap',
  name: 'Volume Weighted Average Price',
  shortName: 'VWAP',
  category: 'volume',
  keywords: ['vwap', 'volume', 'weighted', 'average', 'price', 'session'],
  overlay: true,
  inputs: {
    anchor: { kind: 'enum', label: 'Anchor Period', options: VWAP_ANCHORS, default: 'Session' },
    source: { kind: 'source', label: 'Source', default: 'hlc3' },
    offset: { kind: 'int', label: 'Offset', default: 0, min: -500, max: 500, hideInTitle: true },
    ...bandInputs(true),
  },
  outputs: [
    {
      type: 'plot',
      id: 'vwap',
      title: 'VWAP',
      kind: 'line',
      color: COLOR.blue,
      offset: (inputs) => inputs.offset,
    },
    ...BAND_OUTPUTS.map((o) =>
      o.type === 'plot' ? { ...o, offset: (inputs: { offset: number }) => inputs.offset } : o,
    ),
  ],
  setup({ inputs, ta }) {
    const st = ta.vars({ ...VWAP_SUMS, period: NaN });
    return (c) => {
      const period = anchorPeriod(c.time[c.i]!, inputs.anchor);
      const isNew = period !== st.period;
      st.period = period;
      const vwap = vwapUpdate(st, isNew, c.src.source[c.i]!, c.volume[c.i]!);
      c.set('vwap', vwap);
      setBands(c, inputs, vwap, st.sd);
    };
  },
});
