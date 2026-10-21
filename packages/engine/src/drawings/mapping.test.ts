import { describe, expect, it } from 'vitest';
import type { Interval } from '../types';
import { buildTradingCalendar } from './calendar';
import {
  logicalToTime,
  stepTime,
  stepsBetween,
  timeToLogical,
  type AnchorTimeline,
} from './mapping';

const H = 3600;
const D = 86_400;
const MON = 1_700_438_400; // Monday 2023-11-20 00:00 UTC

function timeline(times: number[], interval: Interval, bricks = false, endTime?: number) {
  const tl: AnchorTimeline = {
    time: Float64Array.from(times),
    length: times.length,
    interval,
    bricks,
    endTime: endTime ?? times[times.length - 1]!,
  };
  return tl;
}

/** Weekdays only, starting Monday. */
function dailyBars(n: number): number[] {
  const out: number[] = [];
  for (let t = MON; out.length < n; t += D) {
    const wd = new Date(t * 1000).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(t);
  }
  return out;
}

/** 7 hourly bars per weekday session 14:30..20:30 UTC. */
function hourlyBars(days: number): number[] {
  const out: number[] = [];
  for (const d of dailyBars(days)) for (let k = 0; k < 7; k++) out.push(d + 14.5 * H + k * H);
  return out;
}

const DAY: Interval = { unit: 'day', count: 1 };
const HOUR: Interval = { unit: 'hour', count: 1 };

describe('anchor mapping', () => {
  it('maps bar times exactly and round-trips every index', () => {
    const tl = timeline(dailyBars(20), DAY);
    for (let i = -5; i < 30; i++) {
      const t = logicalToTime(tl, i)!;
      expect(timeToLogical(tl, t)).toBeCloseTo(i, 9);
    }
  });

  it('maps times inside a bar to that bar and gaps to the next bar', () => {
    const tl = timeline(dailyBars(10), DAY);
    expect(timeToLogical(tl, { time: MON + 12 * H })).toBe(0); // inside Monday
    // Saturday falls in the weekend gap: next bar is Monday (index 5).
    expect(timeToLogical(tl, { time: MON + 5 * D + 10 * H })).toBe(5);
  });

  it('extrapolates past the last bar and before the first by the interval', () => {
    const bars = dailyBars(10);
    const tl = timeline(bars, DAY);
    const last = bars[9]!;
    expect(timeToLogical(tl, { time: last + 3 * D })).toBe(12);
    expect(logicalToTime(tl, 12)).toEqual({ time: last + 3 * D });
    expect(timeToLogical(tl, { time: last + 6 * H })).toBe(9); // inside the last bar
    expect(timeToLogical(tl, { time: MON - 2 * D })).toBe(-2);
    expect(logicalToTime(tl, -2)).toEqual({ time: MON - 2 * D });
  });

  it('uses calendar months for M intervals', () => {
    const jan = Date.UTC(2024, 0, 1) / 1000;
    const iv: Interval = { unit: 'month', count: 1 };
    expect(stepTime(jan, 2, iv)).toBe(Date.UTC(2024, 2, 1) / 1000);
    expect(stepsBetween(jan, Date.UTC(2025, 0, 1) / 1000, iv)).toBe(12);
    const tl = timeline([jan, Date.UTC(2024, 1, 1) / 1000], iv);
    expect(timeToLogical(tl, { time: Date.UTC(2024, 4, 1) / 1000 })).toBe(4);
    // Day 31 of a 31-day month is still inside that month's bar.
    expect(timeToLogical(tl, { time: Date.UTC(2024, 0, 31) / 1000 })).toBe(0);
  });

  it('survives interval changes (anchors are times, mapping is per timeline)', () => {
    const hourly = timeline(hourlyBars(10), HOUR);
    const daily = timeline(dailyBars(10), DAY);
    // Anchor made on the 1h chart at Wednesday 16:30.
    const anchor = logicalToTime(hourly, 2 * 7 + 2)!;
    expect(anchor.time).toBe(MON + 2 * D + 16.5 * H);
    // On 1D it sits on Wednesday's bar...
    expect(timeToLogical(daily, anchor)).toBe(2);
    // ...and back on 1h it is exactly where it was made.
    expect(timeToLogical(hourly, anchor)).toBe(16);
    // A daily anchor (midnight) on 1h maps to that day's first bar (gap rule).
    expect(timeToLogical(hourly, logicalToTime(daily, 3)!)).toBe(21);
    // A future anchor on 1h keeps its time on 1D (inside the last day -> last bar).
    const future = logicalToTime(hourly, hourly.length + 1)!;
    expect(timeToLogical(daily, future)).toBe(daily.length - 1);
  });

  it('resolves bricks sharing a time with the brick offset', () => {
    const t = [MON, MON, MON + D, MON + D, MON + D, MON + 3 * D];
    const tl = timeline(t, DAY, true, MON + 4 * D);
    for (let i = 0; i < t.length; i++) {
      const p = logicalToTime(tl, i)!;
      expect(timeToLogical(tl, p)).toBe(i);
    }
    expect(logicalToTime(tl, 3)).toEqual({ time: MON + D, brick: 1 });
    // A time between bricks maps to the run at or before it.
    expect(timeToLogical(tl, { time: MON + 2 * D })).toBe(2);
    // Up to the newest raw bar it is the last brick; later times extrapolate from it.
    expect(timeToLogical(tl, { time: MON + 4 * D })).toBe(5);
    expect(timeToLogical(tl, { time: MON + 6 * D })).toBe(7);
    expect(logicalToTime(tl, 7)).toEqual({ time: MON + 6 * D });
  });

  it('returns NaN / null without bars', () => {
    const tl = timeline([], DAY, false, NaN);
    expect(timeToLogical(tl, { time: MON })).toBeNaN();
    expect(logicalToTime(tl, 0)).toBeNull();
  });
});

describe('session-aware extrapolation past the last bar', () => {
  const withCalendar = (times: number[], iv: Interval, tz = 'UTC') => {
    const tl = timeline(times, iv);
    return { ...tl, calendar: buildTradingCalendar(tl.time, tl.length, iv, tz) };
  };

  it('skips weekends on daily charts', () => {
    const days = dailyBars(10); // Mon..Fri, Mon..Fri; last = Friday
    const tl = withCalendar(days, DAY);
    const fri = days[9]!;
    expect(logicalToTime(tl, 10)).toEqual({ time: fri + 3 * D }); // Monday
    expect(logicalToTime(tl, 14)).toEqual({ time: fri + 7 * D }); // next Friday
    expect(logicalToTime(tl, 15)).toEqual({ time: fri + 10 * D }); // Monday after
    for (let i = 10; i < 30; i++)
      expect(timeToLogical(tl, logicalToTime(tl, i)!)).toBeCloseTo(i, 9);
    // A Saturday anchor maps to the next trading day (gap rule, like inside the data).
    expect(timeToLogical(tl, { time: fri + D + 5 * H })).toBe(10);
  });

  it('skips non-trading hours and weekends on intraday charts', () => {
    const bars = hourlyBars(5); // Mon..Fri 14:30..20:30 UTC
    const tl = withCalendar(bars, HOUR);
    const last = bars.at(-1)!; // Friday 20:30
    const monday = last - 6 * H + 3 * D; // Monday 14:30
    expect(logicalToTime(tl, bars.length)).toEqual({ time: monday });
    expect(logicalToTime(tl, bars.length + 7)).toEqual({ time: monday + D });
    for (let i = bars.length; i < bars.length + 40; i++)
      expect(timeToLogical(tl, logicalToTime(tl, i)!)).toBeCloseTo(i, 9);
    // Overnight (Monday 03:00) maps to Monday's first slot; inside a slot is fractional.
    expect(timeToLogical(tl, { time: monday - 11.5 * H })).toBe(bars.length);
    expect(timeToLogical(tl, { time: monday + 30 * 60 })).toBeCloseTo(bars.length + 0.5, 9);
  });

  it('uses the exchange timezone for the trading day', () => {
    // 09:30..15:30 New York (EST, UTC-5) = 14:30..20:30 UTC in November.
    const bars = hourlyBars(5);
    const tl = withCalendar(bars, HOUR, 'America/New_York');
    expect(logicalToTime(tl, bars.length)).toEqual({ time: bars.at(-1)! - 6 * H + 3 * D });
  });

  /** 5m bars 14:30..20:55 UTC on the first `days` weekdays. */
  const fiveMin = (days: number) =>
    dailyBars(days).flatMap((d) => Array.from({ length: 78 }, (_, k) => d + 14.5 * H + k * 300));
  const M5: Interval = { unit: 'minute', count: 5 };

  it('learns the modal trading day: odd prints and partial days do not change it', () => {
    const bars = fiveMin(4);
    const odd = [...bars.slice(0, 78), bars[77]! + 2 * H, ...bars.slice(78)]; // 22:55 print on day 1
    const partial = [...bars.slice(0, 3 * 78 + 10)]; // day 4 still in progress
    const ref = withCalendar(bars, M5).calendar!;
    for (const times of [odd, partial]) {
      const cal = withCalendar(times, M5).calendar!;
      const end = times.at(-1)!;
      for (let k = 1; k < 200; k += 7) expect(cal.step(end, k)).toBe(ref.step(end, k));
    }
    // Under two full days there is no shape to learn (plain stepping), unless the session is known.
    const oneDay = Float64Array.from(bars.slice(0, 78 + 20));
    expect(buildTradingCalendar(oneDay, oneDay.length, M5, 'UTC')).toBeNull();
    const cal = buildTradingCalendar(oneDay, oneDay.length, M5, 'UTC', '1430-2100')!;
    expect(cal.step(bars[77]!, 1)).toBe(bars[78]); // next day's open
  });

  it('prefers the regular session over the data', () => {
    // The data has an extra 21:00 bar every day; the session ends at 21:00.
    const bars = dailyBars(3).flatMap((d) =>
      Array.from({ length: 79 }, (_, k) => d + 14.5 * H + k * 300),
    );
    const cal = buildTradingCalendar(Float64Array.from(bars), bars.length, M5, 'UTC', '1430-2100')!;
    const fri = bars.at(-1)! - 78 * 300; // Wednesday 14:30
    expect(cal.step(fri, 78)).toBe(fri + D); // 78 slots per day, not 79
  });

  it('keeps future anchors on the bars they will land on as bars arrive', () => {
    // 3 full days, then day 4 arrives bar by bar with an odd after-hours print at its end.
    const all = fiveMin(5);
    const day4 = all.slice(3 * 78, 4 * 78);
    const odd = 4 * 78;
    const final = [...all.slice(0, odd), day4.at(-1)! + 2 * H, ...all.slice(odd)];
    const loaded = final.slice(0, 3 * 78);
    // Built once at load (as the chart does); anchors are bars of days 4 and 5.
    const cal = withCalendar(loaded, M5).calendar!;
    const targets = [3 * 78 + 5, 3 * 78 + 77, 4 * 78 + 1, 4 * 78 + 30];
    for (let n = loaded.length; n <= final.length; n++) {
      // Same result whether the calendar is kept from load or relearned now.
      for (const tl of [
        { ...timeline(final.slice(0, n), M5), calendar: cal },
        withCalendar(final.slice(0, n), M5),
      ]) {
        for (const i of targets) {
          // Day 5 indices count the odd print once it is there (it cannot be foreseen).
          if (i < n || (i > odd && n <= odd)) continue;
          expect(timeToLogical(tl, { time: final[i]! })).toBe(i);
          expect(logicalToTime(tl, i)).toEqual({ time: final[i] });
        }
      }
    }
  });

  it('projects on the bar grid for intervals that do not divide a day (7m)', () => {
    // Round the clock on weekdays (24/5): the 7m grid restarts at each local midnight.
    const M7: Interval = { unit: 'minute', count: 7 };
    const per = Math.ceil(D / 420); // 206 slots, the last one short
    const bars = dailyBars(3).flatMap((d) => Array.from({ length: per }, (_, k) => d + k * 420));
    const tl = withCalendar(bars, M7);
    for (let i = bars.length; i < bars.length + 3 * per; i += 5) {
      const t = logicalToTime(tl, i)!.time;
      expect((t % D) % 420).toBe(0);
      expect(timeToLogical(tl, { time: t })).toBeCloseTo(i, 9);
    }
    // The first projected bar after Wednesday 23:55 is Thursday 00:00.
    expect(logicalToTime(tl, bars.length)).toEqual({ time: bars.at(-1)! - 1435 * 60 + D });
  });

  describe('learned holidays', () => {
    const utcDay = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;
    /** Day number of the nth (1-based; -1 = last) weekday `wd` of a month. */
    const nthWeekday = (y: number, m: number, wd: number, nth: number) => {
      if (nth > 0) {
        const first = new Date(utcDay(y, m, 1) * 1000).getUTCDay();
        return utcDay(y, m, 1 + ((wd - first + 7) % 7) + 7 * (nth - 1));
      }
      const last = new Date(utcDay(y, m + 1, 0) * 1000);
      return utcDay(y, m + 1, 0) - ((last.getUTCDay() - wd + 7) % 7) * D;
    };
    /** Easter Sunday (Gregorian), unix s. */
    const easter = (y: number) => {
      const a = y % 19;
      const b = Math.floor(y / 100);
      const c = y % 100;
      const h =
        (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) %
        30;
      const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
      const m = Math.floor((a + 11 * h + 22 * l) / 451);
      const n = h + l - 7 * m + 114;
      return utcDay(y, Math.floor(n / 31), (n % 31) + 1);
    };
    /** A US-style exchange schedule (fixed dates with weekend observance, nth weekdays, Good Friday). */
    const holidays = (y: number): Set<number> => {
      const out = new Set<number>();
      const observed = (t: number, satToFri: boolean) => {
        const wd = new Date(t * 1000).getUTCDay();
        if (wd === 6) {
          if (satToFri) out.add(t - D);
        } else if (wd === 0) out.add(t + D);
        else out.add(t);
      };
      observed(utcDay(y, 1, 1), false); // New Year: no Friday before
      observed(utcDay(y, 7, 4), true);
      observed(utcDay(y, 12, 25), true);
      out.add(nthWeekday(y, 1, 1, 3)); // third Monday of January
      out.add(nthWeekday(y, 5, 1, -1)); // last Monday of May
      out.add(nthWeekday(y, 9, 1, 1)); // first Monday of September
      out.add(nthWeekday(y, 11, 4, 4)); // fourth Thursday of November
      out.add(easter(y) - 2 * D); // Good Friday
      return out;
    };
    /** Weekday UTC midnights in [from, to) that are not holidays. */
    const sessions = (from: number, to: number) => {
      const out: number[] = [];
      const off = new Map<number, Set<number>>();
      for (let t = from; t < to; t += D) {
        const d = new Date(t * 1000);
        const wd = d.getUTCDay();
        if (wd === 0 || wd === 6) continue;
        const y = d.getUTCFullYear();
        if (!off.has(y)) off.set(y, holidays(y));
        if (!off.get(y)!.has(t)) out.push(t);
      }
      return out;
    };

    const history = sessions(utcDay(2018, 1, 1), utcDay(2024, 12, 21)); // last: Fri 2024-12-20
    const future = sessions(utcDay(2024, 12, 21), utcDay(2028, 1, 1));

    it('skips recurring holidays learned from missing weekdays in daily data', () => {
      const tl = withCalendar(history, DAY);
      const n = history.length;
      // Every projected slot through 2027 is a session of the schedule.
      for (let k = 1; k <= future.length; k++) {
        expect(logicalToTime(tl, n - 1 + k)).toEqual({ time: future[k - 1] });
        expect(timeToLogical(tl, { time: future[k - 1]! })).toBe(n - 1 + k);
      }
      // Spot checks: Christmas, Good Friday 2025, Jul 4 2026 (Sat) observed Fri Jul 3.
      expect(future).not.toContain(utcDay(2024, 12, 25));
      expect(future).not.toContain(utcDay(2025, 4, 18));
      expect(future).not.toContain(utcDay(2026, 7, 3));
      expect(future).toContain(utcDay(2027, 12, 31)); // Jan 1 2028 is a Saturday: no Friday off
      // A holiday anchor maps to the next session (gap rule).
      const after = future.indexOf(utcDay(2024, 12, 26));
      expect(timeToLogical(tl, { time: utcDay(2024, 12, 25) + 12 * H })).toBe(n + after);
    });

    it('skips learned holidays on intraday charts', () => {
      const bars = history.flatMap((d) =>
        Array.from({ length: 7 }, (_, k) => d + 14.5 * H + k * H),
      );
      const cal = buildTradingCalendar(Float64Array.from(bars), bars.length, HOUR, 'UTC')!;
      const last = bars.at(-1)!;
      for (let j = 0; j < 30; j++) expect(cal.step(last, 1 + 7 * j)).toBe(future[j]! + 14.5 * H);
    });

    /** The `count`-th plain weekday (no holidays) after UTC midnight `t`. */
    const plusWeekdays = (t: number, count: number) => {
      let d = t;
      for (let left = count; left > 0;) {
        d += D;
        const wd = new Date(d * 1000).getUTCDay();
        if (wd !== 0 && wd !== 6) left--;
      }
      return d;
    };

    it.each([2, 3])('learns no holidays from %iD bars (missing weekdays are not closures)', (n) => {
      // Every n-th session of the schedule, as a resampled multi-day chart has.
      const bars = history.filter((_, i) => (history.length - 1 - i) % n === 0);
      const iv: Interval = { unit: 'day', count: n };
      const tl = withCalendar(bars, iv);
      const last = bars.at(-1)!;
      for (let k = 1; k <= 400; k++)
        expect(logicalToTime(tl, bars.length - 1 + k)).toEqual({
          time: plusWeekdays(last, n * k),
        });
    });

    it('learns no holidays from sparse intraday bars', () => {
      // Thin trading: a quarter of the sessions have no hourly bar at all.
      const thin = history.filter((_, i) => (i * 7919) % 4 !== 0);
      const bars = thin.flatMap((d) => Array.from({ length: 7 }, (_, k) => d + 14.5 * H + k * H));
      const cal = buildTradingCalendar(Float64Array.from(bars), bars.length, HOUR, 'UTC')!;
      const last = bars.at(-1)!;
      const lastDay = Math.floor(last / D) * D;
      for (let j = 0; j < 300; j++)
        expect(cal.step(last, 1 + 7 * j)).toBe(plusWeekdays(lastDay, j + 1) + 14.5 * H);
    });

    it('learns nothing from complete data or less than a year of it', () => {
      const plain = dailyBars(600); // every weekday for over two years
      const tl = withCalendar(plain, DAY);
      for (let i = 1; i <= 40; i++) {
        const t = logicalToTime(tl, plain.length - 1 + i)!.time;
        const wd = new Date(t * 1000).getUTCDay();
        expect(wd === 0 || wd === 6).toBe(false);
        expect(timeToLogical(tl, { time: t })).toBe(plain.length - 1 + i);
      }
      expect(logicalToTime(tl, plain.length - 1 + 5)!.time).toBe(plain.at(-1)! + 7 * D);
      // Under a year of the schedule: Christmas 2024 is not known to be a holiday.
      const short = withCalendar(
        history.filter((t) => t >= utcDay(2024, 3, 1)),
        DAY,
      );
      expect(logicalToTime(short, short.length - 1 + 3)).toEqual({ time: utcDay(2024, 12, 25) });
    });
  });

  it('keeps plain stepping for round-the-clock data and weekly bars', () => {
    const all = Array.from({ length: 200 }, (_, i) => MON + i * H);
    expect(buildTradingCalendar(Float64Array.from(all), all.length, HOUR, 'UTC')).toBeNull();
    const weeks = Array.from({ length: 10 }, (_, i) => MON + i * 7 * D);
    expect(
      buildTradingCalendar(Float64Array.from(weeks), 10, { unit: 'week', count: 1 }, 'UTC'),
    ).toBeNull();
  });
});
