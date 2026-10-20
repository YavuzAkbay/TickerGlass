// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildTradingCalendar } from '../drawings/calendar';
import type { AnchorTimeline } from '../drawings/mapping';
import type { Interval } from '../types';
import { mapSyncTime, type SyncTimeRef } from './time-map';

const M = 60;
const H = 3600;
const D = 86_400;
const JAN1 = 1_704_067_200; // Monday 2024-01-01 00:00 UTC
const day = (n: number) => JAN1 + n * D; // n = days after Jan 1 (5 = Saturday Jan 6)

const MIN5: Interval = { unit: 'minute', count: 5 };
const HOUR: Interval = { unit: 'hour', count: 1 };
const DAILY: Interval = { unit: 'day', count: 1 };
const WEEKLY: Interval = { unit: 'week', count: 1 };

function timeline(
  times: number[],
  interval: Interval,
  opts: { bricks?: boolean; tz?: string; calendar?: boolean } = {},
): AnchorTimeline {
  const time = Float64Array.from(times);
  return {
    time,
    length: times.length,
    interval,
    bricks: opts.bricks ?? false,
    endTime: times[times.length - 1]!,
    calendar: opts.calendar
      ? buildTradingCalendar(time, times.length, interval, opts.tz ?? 'UTC')
      : null,
  };
}

/** Day offsets of the weekdays in the first `weeks` weeks from Jan 1. */
function weekdays(weeks: number): number[] {
  const out: number[] = [];
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 5; d++) out.push(w * 7 + d);
  return out;
}

/** Intraday bars every `step` seconds from `from` to `to` (inclusive, seconds of the UTC day). */
function intraday(days: number[], from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (const d of days) for (let s = from; s <= to; s += step) out.push(day(d) + s);
  return out;
}

const ref = (time: number, interval: Interval, timezone: string | null = null): SyncTimeRef => ({
  time,
  interval,
  timezone,
});

describe('mapSyncTime: intraday <-> daily', () => {
  // Daily bars at UTC midnight, weekdays Jan 1-5 and 8-12: index 0..9.
  const daily = timeline(weekdays(2).map(day), DAILY, { calendar: true });
  // 5m bars 14:30..20:55 UTC, weekdays Jan 1-5: 78 per day (6.5 h * 12), index day*78 + k.
  const m5 = timeline(intraday(weekdays(1), 14.5 * H, 20 * H + 55 * M, 5 * M), MIN5, {
    calendar: true,
  });

  it('5m -> 1D: the daily bar containing the time', () => {
    // Wed Jan 3 14:35 lies in the Jan 3 bar [Jan 3, Jan 4): index 2.
    expect(mapSyncTime(ref(day(2) + 14 * H + 35 * M, MIN5), daily, 'UTC')).toBe(2);
    // Saturday 10:00 falls in the weekend gap: the last bar at or before it is Friday (4).
    expect(mapSyncTime(ref(day(5) + 10 * H, MIN5), daily, 'UTC')).toBe(4);
  });

  it('1D -> 5m: the first 5m bar of the day', () => {
    // Jan 3 00:00: first 5m bar at/after it is Jan 3 14:30 = 2 * 78 = 156, before Jan 4.
    expect(mapSyncTime(ref(day(2), DAILY), m5, 'UTC')).toBe(156);
  });

  it('1D -> 5m on a weekend past the data: the bar containing it (rule 2)', () => {
    // Sat Jan 6: the next 5m slot (calendar) is Mon Jan 8 14:30, after the daily bar ends
    // (Jan 7 00:00), so the bar at/before Saturday wins: Friday 20:55 = 5 * 78 - 1 = 389.
    expect(mapSyncTime(ref(day(5), DAILY), m5, 'UTC')).toBe(389);
  });

  it('1D -> 5m future: calendar slots skip the weekend and the night', () => {
    // Mon Jan 8 00:00 is in the overnight gap; the calendar maps it to Monday's first
    // slot: 1 trading day * 78 slots - Friday's last slot number 77 = 1 slot past
    // index 389 -> 390, which opens (14:30) before the daily bar ends.
    expect(mapSyncTime(ref(day(7), DAILY), m5, 'UTC')).toBe(390);
  });

  it('1D -> 5m past: plain 5-minute steps back from the first bar', () => {
    // Fri Dec 29 00:00 is 3 days 14.5 h before Jan 1 14:30:
    // (3 * 86400 + 52200) / 300 = 1038 steps -> index -1038.
    expect(mapSyncTime(ref(day(-3), DAILY), m5, 'UTC')).toBe(-1038);
  });
});

describe('mapSyncTime: hourly <-> weekly', () => {
  // Weekly bars on Mondays Jan 1, 8, 15, 22: index 0..3.
  const weekly = timeline([0, 7, 14, 21].map(day), WEEKLY);
  // 1h bars 14:00..20:00 UTC (7 per day), weekdays Jan 1-5 and 8-12: index weekday * 7 + (h - 14).
  const hourly = timeline(intraday(weekdays(2), 14 * H, 20 * H, H), HOUR, { calendar: true });

  it('1h -> 1W: the week containing the hour', () => {
    // Wed Jan 10 13:00 is in the week opening Mon Jan 8: index 1.
    expect(mapSyncTime(ref(day(9) + 13 * H, HOUR), weekly, null)).toBe(1);
    // Sun Jan 28 is still inside the newest week [Jan 22, Jan 29): index 3, no extrapolation.
    expect(mapSyncTime(ref(day(27), HOUR), weekly, null)).toBe(3);
  });

  it('1W -> 1h: the first hour of the week', () => {
    // Week of Mon Jan 8: first hourly bar Jan 8 14:00 = weekday 5 * 7 = 35.
    expect(mapSyncTime(ref(day(7), WEEKLY), hourly, null)).toBe(35);
  });

  it('1W -> 1h future: first calendar slot of the next week', () => {
    // Week of Jan 15 (after the data ending Fri Jan 12 20:00 = index 69): Mon 00:00 maps to
    // Monday's slot 0, 1 trading day * 7 slots - Friday's slot 6 = 1 -> index 70 (Mon 14:00).
    expect(mapSyncTime(ref(day(14), WEEKLY), hourly, null)).toBe(70);
  });
});

describe('mapSyncTime: daily charts in different timezones', () => {
  // New York daily bars stamped 00:00 local (EST, UTC-5 in January) = 05:00 UTC.
  const ny = (d: number) => day(d) + 5 * H;
  // Tokyo daily bars stamped 00:00 local (JST, UTC+9) = 15:00 UTC the day before.
  const tokyo = (d: number) => day(d) - 9 * H;
  const nyDaily = timeline(weekdays(2).map(ny), DAILY, {
    tz: 'America/New_York',
    calendar: true,
  });
  const tokyoDaily = timeline(weekdays(1).map(tokyo), DAILY, { tz: 'Asia/Tokyo', calendar: true });

  it('matches the calendar date, not the instant', () => {
    // Tokyo Wed Jan 3 opens at Jan 2 10:00 New York time; by instant it would land on the
    // NY Jan 2 bar (1). Matched by date in each exchange zone it is the NY Jan 3 bar (2).
    expect(mapSyncTime(ref(tokyo(2), DAILY, 'Asia/Tokyo'), nyDaily, 'America/New_York')).toBe(2);
    expect(mapSyncTime(ref(ny(2), DAILY, 'America/New_York'), tokyoDaily, 'Asia/Tokyo')).toBe(2);
  });

  it('a weekend date maps to the Friday bar', () => {
    // A 24/7 daily chart stamped at UTC midnight (dated in UTC): Sat Jan 6 and Sun Jan 7
    // fall in the NY weekend gap -> Friday Jan 5 (4); Mon Jan 8 -> 5.
    expect(mapSyncTime(ref(day(5), DAILY, 'UTC'), nyDaily, 'America/New_York')).toBe(4);
    expect(mapSyncTime(ref(day(6), DAILY, 'UTC'), nyDaily, 'America/New_York')).toBe(4);
    expect(mapSyncTime(ref(day(7), DAILY, 'UTC'), nyDaily, 'America/New_York')).toBe(5);
  });

  it('extrapolates past and future dates', () => {
    // Past: Fri Dec 29 is 3 plain daily steps before the first NY bar (Mon Jan 1): -3.
    expect(mapSyncTime(ref(day(-3), DAILY, 'UTC'), nyDaily, 'America/New_York')).toBe(-3);
    // Future: Tokyo Tue Jan 16. NY data ends Fri Jan 12 (index 9); the calendar counts
    // trading days Mon 15 (10), Tue 16 (11). (Holidays are not known.)
    expect(mapSyncTime(ref(tokyo(15), DAILY, 'Asia/Tokyo'), nyDaily, 'America/New_York')).toBe(11);
    // Future Saturday Jan 13: the next slot is Monday (10), after the date -> Friday (9).
    expect(mapSyncTime(ref(day(12), DAILY, 'UTC'), nyDaily, 'America/New_York')).toBe(9);
  });
});

describe('mapSyncTime: brick charts and degenerate input', () => {
  // Bricks share their source bar's time: two on Jan 1, three on Jan 2, one on Jan 4.
  const bricks = timeline([0, 0, 1, 1, 1, 3].map(day), DAILY, { bricks: true });

  it('maps to the first brick of the run at or before the time', () => {
    // Jan 3 has no brick; the last brick time <= Jan 3 is Jan 2, whose run starts at 2.
    expect(mapSyncTime(ref(day(2), DAILY), bricks, null)).toBe(2);
    expect(mapSyncTime(ref(day(1) + 13 * H, HOUR), bricks, null)).toBe(2);
    // Past the end: last index 5 + 2 plain daily steps from Jan 4 to Jan 6 = 7.
    expect(mapSyncTime(ref(day(5), DAILY), bricks, null)).toBe(7);
  });

  it('returns NaN without bars or without a finite time', () => {
    expect(mapSyncTime(ref(day(0), DAILY), timeline([], DAILY), null)).toBeNaN();
    expect(mapSyncTime(ref(NaN, DAILY), bricks, null)).toBeNaN();
  });
});
