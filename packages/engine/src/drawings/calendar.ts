import { intervalSeconds } from '../feed/intervals';
import { createTzConverter, type TzConverter } from '../scale/timezone';
import type { Interval } from '../types';

const DAY = 86_400;
/** Raw bars inspected to learn the trading week and day. */
const SAMPLE = 2000;
/** Day iterations before falling back to a plain calendar estimate. */
const MAX_DAYS = 40_000;

/**
 * Trading calendar for anchors past the last bar (docs/drawings.md §3): bar
 * slots skip weekends (unless the data has weekend bars) and, intraday, the
 * hours outside the trading day seen in the data (so overnight gaps and
 * weekends are not counted as slots). Exchange holidays are not known.
 */
export interface TradingCalendar {
  /** Time of slot `k` (whole, >= 0) after the slot opening at `from` (k = 0 is `from`). */
  step(from: number, k: number): number;
  /** Fractional slots from `from` to `t` (t >= from); a time in a non-trading gap maps to the next slot. */
  slots(from: number, t: number): number;
}

interface Shape {
  tz: TzConverter;
  iv: number;
  /** Data has bars on Saturday/Sunday (crypto): every day trades. */
  weekends: boolean;
  /** Intraday: first slot of the trading day, local seconds of day. */
  dayStart: number;
  /** Intraday: slots per trading day (0 = round the clock, only weekend skipping). */
  perDay: number;
}

const weekday = (localDay: number) => (localDay + 4) % 7; // 1970-01-01 was a Thursday (4)
const tradingDay = (s: Shape, localDay: number) => {
  if (s.weekends) return true;
  const wd = weekday(localDay);
  return wd !== 0 && wd !== 6;
};

/** UTC time of local seconds `l` (handles DST up to the transition hour). */
function fromLocal(tz: TzConverter, l: number): number {
  const guess = l - tz.offsetSeconds(l);
  return l - tz.offsetSeconds(guess);
}

/**
 * Learn the calendar from the newest raw bars (times in unix s) of an
 * intraday or daily `interval` in exchange timezone `tz`. Null for weekly and
 * monthly intervals or too little data (callers then step plain intervals).
 */
export function buildTradingCalendar(
  time: ArrayLike<number>,
  length: number,
  interval: Interval,
  tz: string,
): TradingCalendar | null {
  const iv = intervalSeconds(interval);
  if (length < 2 || !(iv > 0) || interval.unit === 'week' || interval.unit === 'month') return null;
  const conv = createTzConverter(tz);
  const from = Math.max(0, length - SAMPLE);
  let weekends = false;
  let minTod = DAY;
  let maxTod = -1;
  for (let i = from; i < length; i++) {
    const l = conv.toLocal(time[i]!);
    const day = Math.floor(l / DAY);
    const wd = weekday(day);
    if (wd === 0 || wd === 6) weekends = true;
    const tod = l - day * DAY;
    if (tod < minTod) minTod = tod;
    if (tod > maxTod) maxTod = tod;
  }
  const intraday = iv < DAY;
  let perDay = 0;
  if (intraday) {
    const span = maxTod - minTod + iv;
    // Round-the-clock data (or sessions wrapping midnight): only weekends are skipped.
    perDay = span >= DAY - iv ? 0 : Math.max(1, Math.round(span / iv));
  }
  if (weekends && perDay === 0 && intraday) return null; // 24/7: plain stepping
  const s: Shape = { tz: conv, iv, weekends, dayStart: minTod, perDay };
  return intraday ? intradayCalendar(s) : dailyCalendar(s, Math.max(1, Math.round(iv / DAY)));
}

/** Advance `n` trading days from local day `day` (n >= 0). */
function addTradingDays(s: Shape, day: number, n: number): number {
  let d = day;
  for (let left = n, guard = 0; left > 0 && guard < MAX_DAYS; guard++) {
    d++;
    if (tradingDay(s, d)) left--;
  }
  return d;
}

/** Trading days in (a, b] (b >= a). */
function tradingDaysBetween(s: Shape, a: number, b: number): number {
  if (b - a > MAX_DAYS) return Math.round(((b - a) * (s.weekends ? 7 : 5)) / 7);
  let n = 0;
  for (let d = a + 1; d <= b; d++) if (tradingDay(s, d)) n++;
  return n;
}

/** First trading day >= day. */
function nextTradingDay(s: Shape, day: number): number {
  let d = day;
  for (let guard = 0; !tradingDay(s, d) && guard < 7; guard++) d++;
  return d;
}

function dailyCalendar(s: Shape, count: number): TradingCalendar {
  return {
    step(from, k) {
      const l = s.tz.toLocal(from);
      const day = Math.floor(l / DAY);
      const tod = l - day * DAY;
      return fromLocal(s.tz, addTradingDays(s, day, k * count) * DAY + tod);
    },
    slots(from, t) {
      const l0 = s.tz.toLocal(from);
      const d0 = Math.floor(l0 / DAY);
      const tod0 = l0 - d0 * DAY;
      const l = s.tz.toLocal(t);
      let d = Math.floor(l / DAY);
      let frac = (l - d * DAY - tod0) / DAY;
      if (frac < 0) {
        // Before the bar's time of day: still inside the previous day's slot.
        d--;
        frac += 1;
      }
      if (!tradingDay(s, d)) {
        d = nextTradingDay(s, d);
        frac = 0;
      }
      return (tradingDaysBetween(s, d0, d) + Math.min(Math.max(frac, 0), 1)) / count;
    },
  };
}

function intradayCalendar(s: Shape): TradingCalendar {
  const { iv, dayStart } = s;
  const perDay = s.perDay;
  /** Trading day and slot number of a local time (slot may be fractional). */
  const position = (t: number): { day: number; slot: number } => {
    const l = s.tz.toLocal(t);
    let day = Math.floor(l / DAY);
    if (perDay === 0) {
      // Round the clock on weekdays.
      if (!tradingDay(s, day)) return { day: nextTradingDay(s, day), slot: 0 };
      return { day, slot: (l - day * DAY) / iv };
    }
    const rel = l - day * DAY - dayStart;
    if (rel < 0 || !tradingDay(s, day)) {
      if (rel >= 0 || !tradingDay(s, day)) day = nextTradingDay(s, rel >= 0 ? day + 1 : day);
      return { day, slot: 0 };
    }
    const slot = rel / iv;
    if (slot >= perDay) return { day: nextTradingDay(s, day + 1), slot: 0 };
    return { day, slot };
  };
  const slotsPerDay = perDay === 0 ? DAY / iv : perDay;
  return {
    step(from, k) {
      const p = position(from);
      const total = Math.round(p.slot) + k;
      const days = Math.floor(total / slotsPerDay);
      const slot = total - days * slotsPerDay;
      const day = addTradingDays(s, p.day, days);
      const base = perDay === 0 ? 0 : dayStart;
      return fromLocal(s.tz, day * DAY + base + slot * iv);
    },
    slots(from, t) {
      const a = position(from);
      const b = position(t);
      return tradingDaysBetween(s, a.day, b.day) * slotsPerDay + b.slot - Math.round(a.slot);
    },
  };
}
