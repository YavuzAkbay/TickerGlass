import { calendarPeriod, type CalendarUnit } from '../calendar';
import { defineIndicator } from '../registry';
import { COLOR } from './common';
import { BAND_OUTPUTS, VWAP_SUMS, bandInputs, setBands, vwapUpdate } from './vwap-bands';

/** Anchors that need only bar times (Earnings/Dividends/Splits need event data). */
export const VWAP_ANCHORS = [
  'Session',
  'Week',
  'Month',
  'Quarter',
  'Year',
  'Decade',
  'Century',
] as const;
export type VwapAnchor = (typeof VWAP_ANCHORS)[number];

const UNIT: Record<VwapAnchor, CalendarUnit> = {
  Session: 'session',
  Week: 'week',
  Month: 'month',
  Quarter: 'quarter',
  Year: 'year',
  Decade: 'decade',
  Century: 'century',
};

const DAY = 86_400;

/**
 * Period number of a bar time for an anchor in the exchange timezone `tz`
 * (default UTC): calendar days (or the overnight `session`'s trading day),
 * ISO weeks (Monday), months, quarters, years, decades, centuries.
 */
export function anchorPeriod(
  time: number,
  anchor: VwapAnchor,
  tz = 'UTC',
  session: string | null = null,
): number {
  return calendarPeriod(time, UNIT[anchor], tz, session);
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
    hideOnDWM: {
      kind: 'bool',
      label: 'Hide VWAP on 1D or Above',
      default: false,
      hideInTitle: true,
    },
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
  setup({ inputs, ta, env }) {
    const st = ta.vars({ ...VWAP_SUMS, period: NaN });
    // Daily, weekly and monthly charts.
    const hidden = inputs.hideOnDWM && env.intervalSeconds >= DAY;
    return (c) => {
      if (hidden) return;
      const period = anchorPeriod(c.time[c.i]!, inputs.anchor, env.timezone, env.session);
      const isNew = period !== st.period;
      st.period = period;
      const vwap = vwapUpdate(st, isNew, c.src.source[c.i]!, c.volume[c.i]!);
      c.set('vwap', vwap);
      setBands(c, inputs, vwap, st.sd);
    };
  },
});
