import { calendarPeriod } from '../calendar';
import type { SeriesVar } from '../types';
import { defineIndicator } from '../registry';
import { COLOR } from './common';

const DAY = 86_400;

/** Exchange-calendar date of a bar as YYYYMMDD (overnight sessions count as the next day). */
function dateKey(time: number, tz: string, session: string | null): number {
  const d = new Date(calendarPeriod(time, 'session', tz, session) * DAY * 1000);
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** Last index in [0, hi] whose key is <= target (keys never decrease), or -1. */
function lastAtOrBefore(keys: SeriesVar, hi: number, target: number): number {
  let lo = 0;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys.get(mid) <= target) {
      res = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return res;
}

/**
 * Seasonality: year-to-date return of the current bar (`cur`, % vs the last
 * close of the previous calendar year) and the mean YTD return at the same
 * month/day over the previous `years` years (`avg`; the close of the last bar
 * on or before that date, vs that year's previous year-end close; years
 * without a previous year-end in the data are skipped). Exchange calendar
 * dates. Daily and longer bars only: NaN on intraday bars.
 */
export const SEASONALITY = defineIndicator({
  id: 'seasonality',
  name: 'Seasonality',
  shortName: 'Seasonality',
  category: 'other',
  keywords: ['seasonality', 'seasonal', 'ytd', 'year to date', 'annual', 'calendar'],
  overlay: false,
  format: 'percent',
  inputs: {
    years: { kind: 'int', label: 'Years', default: 5, min: 1, max: 50 },
  },
  outputs: [
    { type: 'plot', id: 'cur', title: 'Current Year', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'avg', title: 'Average', kind: 'line', color: COLOR.orange },
  ],
  setup({ inputs, ta, env }) {
    const intraday = env.intervalSeconds > 0 && env.intervalSeconds < DAY;
    const keys = ta.series();
    /** YTD return (%) at the last bar on or before date `target` (YYYYMMDD), bars [0, hi]. */
    const ytd = (close: Float64Array, hi: number, target: number): number => {
      const year = Math.floor(target / 10_000);
      const ref = lastAtOrBefore(keys, hi, (year - 1) * 10_000 + 1231);
      if (ref < 0) return NaN;
      const at = lastAtOrBefore(keys, hi, target);
      return 100 * (close[at]! / close[ref]! - 1);
    };
    return (c) => {
      if (intraday) return;
      const i = c.i;
      const key = dateKey(c.time[i]!, c.env.timezone, c.env.session);
      keys.set(i, key);
      c.set('cur', ytd(c.close, i, key));
      const year = Math.floor(key / 10_000);
      const md = key % 10_000;
      let sum = 0;
      let count = 0;
      for (let k = 1; k <= inputs.years; k++) {
        const r = ytd(c.close, i, (year - k) * 10_000 + md);
        if (Number.isNaN(r)) continue;
        sum += r;
        count++;
      }
      c.set('avg', count ? sum / count : NaN);
    };
  },
});
