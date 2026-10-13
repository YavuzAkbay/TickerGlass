import { intervalSeconds } from '../feed/intervals';
import { createTzConverter, type TzConverter } from '../scale/timezone';
import type { Interval } from '../types';

const DAY = 86_400;
/** Raw bars inspected to learn the trading week and day. */
const SAMPLE = 2000;
/** Day iterations before falling back to a plain calendar estimate. */
const MAX_DAYS = 40_000;

/** Full trading days (modal first and last bar) needed to learn an intraday day shape. */
const MIN_FULL_DAYS = 2;

/**
 * Trading calendar for anchors past the last bar (docs/drawings.md §3): bar
 * slots skip weekends (unless the data has weekend bars) and, intraday, the
 * hours outside the trading day (the regular session when given, else the
 * typical day seen in the data), so overnight gaps and weekends are not
 * counted as slots. Slot times lie on the bar grid from the day's first slot.
 * Exchange holidays are not known.
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
  /** Intraday: slots per trading day (0 = round the clock from local midnight, only weekend skipping). */
  perDay: number;
}

const SESSION_RE = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/;

/** Regular session "HHMM-HHMM" as [start, end) local seconds of day; null when absent or invalid. */
function parseSession(session: string | null): [number, number] | null {
  const m = SESSION_RE.exec(session?.trim() ?? '');
  if (!m) return null;
  const [sh, sm, eh, em] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (sh > 23 || sm > 59 || eh > 24 || em > 59) return null;
  const start = sh * 3600 + sm * 60;
  const end = (eh === 23 && em === 59) || eh === 24 ? DAY : eh * 3600 + em * 60;
  return [start, end];
}

/** Most frequent value (ties: the first one reaching the top count). */
function mode(values: number[]): number {
  const counts = new Map<number, number>();
  let best = values[0]!;
  let top = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > top) {
      top = c;
      best = v;
    }
  }
  return best;
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
 * Calendar for the newest raw bars (times in unix s) of an intraday or daily
 * `interval` in exchange timezone `tz`. Null for weekly and monthly intervals
 * or too little data (callers then step plain intervals).
 *
 * The intraday day shape is the regular `session` ("HHMM-HHMM", exchange
 * time) when given; pass null when the data includes extended hours. Without
 * it, the shape is the modal first and last bar time of day, and at least two
 * full days must match it (so an odd after-hours print or a partial day does
 * not change the shape). Build it once per load / symbol / interval, not per
 * bar: a shape that changes with new bars moves anchors past the last bar.
 */
export function buildTradingCalendar(
  time: ArrayLike<number>,
  length: number,
  interval: Interval,
  tz: string,
  session: string | null = null,
): TradingCalendar | null {
  const iv = intervalSeconds(interval);
  if (length < 2 || !(iv > 0) || interval.unit === 'week' || interval.unit === 'month') return null;
  const conv = createTzConverter(tz);
  const from = Math.max(0, length - SAMPLE);
  let weekends = false;
  const firsts: number[] = [];
  const lasts: number[] = [];
  let curDay = NaN;
  for (let i = from; i < length; i++) {
    const l = conv.toLocal(time[i]!);
    const day = Math.floor(l / DAY);
    const wd = weekday(day);
    if (wd === 0 || wd === 6) weekends = true;
    const tod = l - day * DAY;
    if (day !== curDay) {
      curDay = day;
      firsts.push(tod);
      lasts.push(tod);
    } else lasts[lasts.length - 1] = tod;
  }
  if (iv >= DAY) {
    const s: Shape = { tz: conv, iv, weekends, dayStart: 0, perDay: 0 };
    return dailyCalendar(s, Math.max(1, Math.round(iv / DAY)));
  }
  let dayStart: number;
  let span: number;
  const sess = parseSession(session);
  if (sess) {
    const [start, end] = sess;
    // Sessions wrapping midnight (futures, FX) trade round the clock on weekdays.
    span = start < end ? end - start : DAY;
    dayStart = start < end ? start : 0;
  } else {
    const first = mode(firsts);
    const last = mode(lasts);
    let full = 0;
    for (let d = 0; d < firsts.length; d++) if (firsts[d] === first && lasts[d] === last) full++;
    if (last < first || full < MIN_FULL_DAYS) return null;
    dayStart = first;
    span = last - first + iv;
  }
  // Round-the-clock data (or sessions wrapping midnight): only weekends are skipped.
  const perDay = span >= DAY - iv ? 0 : Math.max(1, Math.ceil(span / iv));
  if (weekends && perDay === 0) return null; // 24/7: plain stepping
  return intradayCalendar({
    tz: conv,
    iv,
    weekends,
    dayStart: perDay === 0 ? 0 : dayStart,
    perDay,
  });
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
  // Whole slots: with an interval not dividing a day (7m) the grid restarts at
  // each day's first slot, so the last slot of a day may be short.
  const slotsPerDay = perDay === 0 ? Math.ceil(DAY / iv) : perDay;
  /**
   * Trading day and slot number of a local time (slot may be fractional). A
   * time outside the trading hours (`gap`) maps to the next day's slot 0.
   */
  const position = (t: number): { day: number; slot: number; gap: boolean } => {
    const l = s.tz.toLocal(t);
    let day = Math.floor(l / DAY);
    if (perDay === 0) {
      // Round the clock on weekdays.
      if (!tradingDay(s, day)) return { day: nextTradingDay(s, day), slot: 0, gap: true };
      return { day, slot: (l - day * DAY) / iv, gap: false };
    }
    const rel = l - day * DAY - dayStart;
    if (rel < 0 || !tradingDay(s, day)) {
      if (rel >= 0 || !tradingDay(s, day)) day = nextTradingDay(s, rel >= 0 ? day + 1 : day);
      return { day, slot: 0, gap: true };
    }
    const slot = rel / iv;
    if (slot >= perDay) return { day: nextTradingDay(s, day + 1), slot: 0, gap: true };
    return { day, slot, gap: false };
  };
  /** Whole slot of a bar opening at `from`; a bar in a gap (an odd after-hours
   * print) sits just before the next day's first slot, which stays free. */
  const origin = (from: number): { day: number; slot: number } => {
    const p = position(from);
    return { day: p.day, slot: p.gap ? -1 : Math.round(p.slot) };
  };
  return {
    step(from, k) {
      const p = origin(from);
      const total = p.slot + k;
      const days = Math.floor(total / slotsPerDay);
      const slot = total - days * slotsPerDay;
      const day = addTradingDays(s, p.day, days);
      const base = perDay === 0 ? 0 : dayStart;
      return fromLocal(s.tz, day * DAY + base + slot * iv);
    },
    slots(from, t) {
      const a = origin(from);
      const b = position(t);
      return tradingDaysBetween(s, a.day, b.day) * slotsPerDay + b.slot - a.slot;
    },
  };
}
