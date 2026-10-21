import { calendarPeriod, type CalendarUnit } from '../calendar';
import { defineIndicator } from '../registry';
import type { BarsEvents } from '../types';
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

/** Anchors that reset at the symbol's events (`env.events`). */
export const VWAP_EVENT_ANCHORS = ['Earnings', 'Dividends', 'Splits'] as const;
export type VwapEventAnchor = (typeof VWAP_EVENT_ANCHORS)[number];

const EVENT_KIND: Record<VwapEventAnchor, keyof BarsEvents> = {
  Earnings: 'earnings',
  Dividends: 'dividends',
  Splits: 'splits',
};

const isEventAnchor = (a: string): a is VwapEventAnchor => a in EVENT_KIND;

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

const NO_EVENTS: readonly number[] = [];

/**
 * Volume-weighted average price, reset every anchor period, with optional bands.
 *
 * Event anchors (Earnings, Dividends, Splits) reset at the first bar whose time
 * is at or after each event time: an event inside a gap (weekend, halt) resets
 * at the next bar, several events up to one bar reset it once, and events
 * before the first bar or after the last are ignored. Bars before the first
 * event accumulate from the series start; without event data (none loaded, or
 * a host that has none) the VWAP accumulates over the whole series.
 */
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
    anchor: {
      kind: 'enum',
      label: 'Anchor Period',
      options: [...VWAP_ANCHORS, ...VWAP_EVENT_ANCHORS],
      default: 'Session',
    },
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
  usesEvents: (inputs) => isEventAnchor(inputs.anchor),
  setup({ inputs, ta, env }) {
    // `next`: index of the first event time not yet reached (event anchors).
    const st = ta.vars({ ...VWAP_SUMS, period: NaN, next: 0 });
    // Daily, weekly and monthly charts.
    const hidden = inputs.hideOnDWM && env.intervalSeconds >= DAY;
    const anchor = inputs.anchor;
    const calendar = isEventAnchor(anchor) ? null : anchor;
    const events = isEventAnchor(anchor)
      ? (env.events?.[EVENT_KIND[anchor]] ?? NO_EVENTS)
      : NO_EVENTS;
    return (c) => {
      if (hidden) return;
      const t = c.time[c.i]!;
      let isNew: boolean;
      if (calendar === null) {
        // Reset once at the first bar at or after one or more new event times.
        isNew = false;
        while (st.next < events.length && events[st.next]! <= t) {
          st.next++;
          isNew = true;
        }
      } else {
        const period = anchorPeriod(t, calendar, env.timezone, env.session);
        isNew = period !== st.period;
        st.period = period;
      }
      const vwap = vwapUpdate(st, isNew, c.src.source[c.i]!, c.volume[c.i]!);
      c.set('vwap', vwap);
      setBands(c, inputs, vwap, st.sd);
    };
  },
});
