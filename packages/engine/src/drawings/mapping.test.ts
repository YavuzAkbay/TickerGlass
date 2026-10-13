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

  it('keeps plain stepping for round-the-clock data and weekly bars', () => {
    const all = Array.from({ length: 200 }, (_, i) => MON + i * H);
    expect(buildTradingCalendar(Float64Array.from(all), all.length, HOUR, 'UTC')).toBeNull();
    const weeks = Array.from({ length: 10 }, (_, i) => MON + i * 7 * D);
    expect(
      buildTradingCalendar(Float64Array.from(weeks), 10, { unit: 'week', count: 1 }, 'UTC'),
    ).toBeNull();
  });
});
